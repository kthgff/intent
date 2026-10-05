# ARCHITECTURE — Veto implementation contract

Status: target architecture, ratified 2026-10-04 (D38). This document turns
the PRD/TDD decisions into a concrete technology, runtime, package, and design
contract. It is binding alongside the contracts named in `AGENTS.md`; feature
behavior still belongs to `PRD.md` and the subject-specific TDDs.

## 1. Decisions at a glance

| Concern | Decision |
| --- | --- |
| Product shape | Local-first modular monolith; one daemon process by default |
| Desktop | Tauri 2, macOS + Windows first; minimal Rust shell |
| Daemon | Node.js 22+, strict ESM TypeScript, bundled as a Tauri sidecar runtime |
| Web/API | Fastify, JSON REST + one authenticated SSE stream |
| UI | React 18 + Vite 5 + React Router 6 + TanStack Query 5 |
| Canvas | React Flow 12 (`@xyflow/react`) with Veto custom nodes/edges |
| Database | App-managed local Docker Postgres 17 + pgvector; named volume |
| SQL access | Postgres.js, explicit numbered SQL migrations, repository interfaces; no ORM |
| Validation | Zod schemas in `@veto/core`; parse at every external boundary |
| Long work | Child processes or per-subject Docker workers; never block the daemon tick |
| Agent adapters | Built-in/compile-time only in v1: Devin + Aider/OpenRouter + mock for tests |
| Git | Real `git`/`gh` child processes; no JS git implementation |
| Secrets | `.env`/process environment for v1; never returned, logged, or stored in DB/config |
| Offline | Daemon-connected product; local unsent-draft recovery, no offline sync engine |
| Telemetry | OpenTelemetry/OTLP first in D37 Phase C |
| Tests | Vitest + Testing Library + Fastify injection + PGlite + real-Postgres/Docker E2E + Playwright |
| Platforms | macOS (arm64/x64 as build support permits) and Windows x64/arm64; Linux deferred |

### Canvas choice correction

Earlier drafts recommended tldraw. That choice is superseded. The tldraw SDK
requires a production license key; Veto instead uses MIT-licensed React Flow.
React Flow also fits Veto's typed application nodes and canonical DB edges
better than a general drawing scene. Excalidraw remains rejected: its
whiteboard/scene model is excellent for freehand drawing but is a poorer fit
for typed goals, board items, provenance, validation, and delivery cards.

## 2. Runtime topology

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Veto desktop — Tauri 2 (macOS / Windows)                            │
│ window · tray · notifications · launch-on-login · sidecar lifecycle │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ starts/monitors
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ veto daemon — one Node.js modular-monolith process                   │
│ Fastify API/static UI · auth · application services · conductor     │
│ scheduler · SSE · worker registry · Docker/Postgres lifecycle        │
└──────────────┬──────────────────────┬─────────────────────┬──────────┘
               │ SQL                 │ child/docker work   │ REST/SSE
               ▼                     ▼                     ▼
┌─────────────────────────┐  ┌──────────────────────┐  ┌─────────────┐
│ managed Docker Postgres │  │ isolated workers     │  │ React/Vite  │
│ Postgres 17 + pgvector  │  │ agents · indexers    │  │ UI          │
│ named durable volume    │  │ verify · telemetry   │  │ browser too │
└─────────────────────────┘  └──────────────────────┘  └─────────────┘
```

The daemon is a **modular monolith**, not a distributed system. Fastify,
application services, and the conductor run in one process. Long or risky work
runs out of process and is represented durably in Postgres before launch.
Redis, message brokers, Kubernetes, and service-to-service RPC are out of
scope. Postgres leases/events/runs are the durable queue and coordination
substrate.

### 2.1 Desktop shell and sidecar

Tauri owns only operating-system integration:

- create/show the window pointed at the daemon's authenticated loopback URL;
- start, monitor, and stop the daemon sidecar;
- launch on login, tray/menu, dock/taskbar badge, native notifications;
- open files/URLs only through narrowly scoped Tauri capabilities;
- surface startup/doctor failures and a safe restart action.

No domain rules, SQL, orchestration, or API implementation lives in Rust.
Tauri bundles a platform-specific Node 22 runtime plus the built daemon bundle
and static UI assets, so users do not install Node. The shell launches that
runtime as an external binary/sidecar. v1 does not depend on Node SEA because
the Node 22 SEA mechanism remains active-development and complicates ESM/native
assets. The headless `veto daemon` entry point uses the same JavaScript bundle.

The desktop waits for `/health/ready`, then navigates to the loopback surface.
Unexpected daemon exit is restarted with bounded exponential backoff; repeated
failure opens diagnostics rather than a restart loop.

### 2.2 Managed Postgres

On startup the daemon ensures one local container and durable volume:

```text
container: veto-postgres
volume:    veto-postgres-data
image:     pgvector/pgvector:<pinned-pg17-version-and-digest>
network:   loopback-published dynamic port only
database:  veto
```

- The image tag and digest are release-pinned, never `latest`.
- A random database password is generated during onboarding and written to the
  user's `.env` with owner-only permissions/ACLs.
- The resolved connection URL is process state; secrets do not enter YAML or
  Postgres rows.
- Startup waits on container health/`pg_isready`, then takes a Postgres advisory
  migration lock and applies numbered forward migrations transactionally.
- A pre-migration `pg_dump` is required for migrations marked destructive.
- Normal app shutdown may stop the container but never removes its volume.
  Reset/uninstall data deletion is a separate explicit destructive action.
- A missing/unhealthy Docker daemon is a named hard startup failure with doctor
  instructions. It cannot silently fall back to PGlite.

PGlite is test-only. It exercises repository semantics quickly but does not
change the production Postgres contract. Full E2E uses the pinned Docker image.

## 3. Source tree and dependency rules

Keep the workspace split by technical responsibility; organize the large
packages internally by product domain. This hybrid preserves enforceable
dependency boundaries without producing a package for every screen.

```text
apps/
  desktop/                 Tauri 2 Rust shell + bundle config
packages/
  core/                    schemas, enums, value types, events, ports
  config/                  YAML/.env load, precedence, validation
  store/                   Postgres repositories + migrations + tx helpers
  gitops/                  real git/gh commands and worktrees
  prompts/                 prompt renderer and token contracts
  adapters/                built-in agent adapters (devin/aider/mock)
  lints/                   pure deterministic document/code-plan checks
  kb/                      dossier, embeddings, retrieval/evidence indexes
  conductor/               application use cases + scheduler/runtime
  api/                     Fastify transport, auth, SSE, static UI
  cli/                     veto init/daemon/tick/status/doctor/add
  ui/                      React application
docker/
  agent/                   shared worker image
  postgres/                pinned image metadata/health/bootstrap only
```

The existing `packages/*` layout migrates to `@veto/*` in wp-100. Adding
`apps/desktop` does not move business code into Rust.

### 3.1 Dependency direction

```text
ui ──HTTP/SSE──> api → conductor/application → core ports
                       │       │       │
                       ▼       ▼       ▼
                     store   gitops  adapters/kb/lints/prompts

config → core      store/gitops/adapters/kb/lints/prompts → core
core → no workspace package
```

Rules:

- `core` has no filesystem, network, database, UI, Fastify, or Docker imports.
- Transport handlers do not query SQL or spawn processes directly; they parse
  input and call an application use case.
- Domain/application code depends on ports, not Postgres/Fastify/Tauri types.
- Store repositories own SQL. Other packages do not contain ad-hoc SQL.
- UI imports serializable contracts from `core`, never server implementations.
- Cross-package cycles fail CI (`dependency-cruiser` or an equivalent check).
- A package exports a deliberate public surface from `src/index.ts`; imports
  reaching into another package's internal path are forbidden.

### 3.2 Domain slices inside conductor

```text
packages/conductor/src/
  domains/
    projects/               onboarding, repos, settings, health
    ideas/                  boards, capture, synthesis, provenance
    specifications/         interview, PRD/TDD/test, gates, quality
    delivery/               implement, review, PR, CI, verify, release
    evidence/               dossier, traceability, index/retrieval requests
    incidents/              Phase C signatures/investigations/proposals
  runtime/
    scheduler/              tick, claims, leases, retries, caps
    workers/                launch/reconcile/control/artifacts
    containers/             per-subject worker lifecycle
  shared/                   small cross-domain policies only
```

Each domain exposes use cases and its public types. A use case performs one
business action and owns its transaction boundary. Cross-domain work happens
through explicit use-case calls or durable events—not by importing another
domain's internal repository. `shared/` is not a dumping ground; a second use
is not enough to move code there unless the semantics truly match.

## 4. Design patterns

### 4.1 Ports and adapters

`@veto/core` defines narrow ports for storage transactions, clocks/IDs,
agent execution, git/PR operations, evidence retrieval, notifications, and
worker control. Production adapters live in their owning packages; tests use
in-memory or mock adapters. Interfaces follow actual use cases rather than
mirroring vendor SDKs.

### 4.2 Command/query separation

- **Commands** are validated use cases that mutate state inside a transaction,
  append events, and return a result plus post-commit notifications.
- **Queries** use repository read models tailored to screens. They never mutate
  or launch work.
- This is pragmatic CQRS, not event sourcing: current rows are canonical and
  append-only events provide audit/history.

### 4.3 State machines and policies

Status transitions, gate rules, drop targets, retry ladders, caps, and
authorization are pure policy modules with table-driven tests. UI and API never
duplicate allowed-transition logic; they consume server-computed actions.

### 4.4 Transactional write rule

A successful command commits its canonical row changes, immutable document
versions, and audit event in one database transaction. After commit, the daemon
publishes SSE/desktop notifications. A crash after commit can lose a transient
notification but not truth; reconnecting clients refetch durable state.

### 4.5 Fail-closed boundaries

Every external value is `unknown` until parsed by Zod or a deterministic
parser: HTTP, YAML, agent JSON/Markdown, CLI output, GitHub responses,
telemetry, and DB JSON. Malformed structured output becomes a typed error or
repair gate. No `as` cast at an I/O boundary may stand in for parsing.

### 4.6 Idempotency and concurrency

- Mutating API calls carry `expected_status`/version and an idempotency key for
  actions that may be retried.
- DB constraints are the last line of defense; leases/claims use atomic SQL.
- Jobs are inserted/claimed durably before process/container launch.
- Reconciliation is restart-safe: observe external state, compare durable
  intent, and take the smallest idempotent action.

## 5. Backend implementation standards

### 5.1 TypeScript

- Node 22+, pnpm 10, ESM, NodeNext, target ES2022.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
  `verbatimModuleSyntax` stay enabled.
- Prefer pure functions and immutable inputs at policy boundaries.
- Use typed domain errors; map them to HTTP/CLI at the boundary.
- Inject clock, ID generation, process runner, and filesystem roots in tests.
- No module reads process environment at import time; bootstrap resolves config
  and passes dependencies explicitly.

### 5.2 SQL and repositories

- Postgres.js is the only production SQL client.
- Migrations are sequential `.sql` files, checksum-recorded in `schema_meta`.
- SQL uses positional/tagged parameters; never string concatenation.
- Repositories return domain/read-model types, not driver row objects.
- A unit of work/transaction object is passed explicitly to multi-repository
  commands.
- JSONB is reserved for genuinely variable payloads/artifacts; frequently
  filtered or constrained values receive typed columns/tables.
- Foreign keys, checks, unique constraints, and indexes express invariants in
  addition to Zod—not instead of it.
- No ORM or schema auto-sync tool is introduced.

### 5.3 Background work

The daemon scheduler is cooperative and quick. It claims and launches; it does
not perform long work inline. Agent runs use the D30 per-subject containers.
Indexing, verification, import, and telemetry may use bounded child-process or
worker-pool execution. Every job has timeout, cancellation, heartbeat,
concurrency class, retry policy, and durable artifact/error record.

## 6. Frontend architecture

```text
packages/ui/src/
  app/                      router, providers, shell, error boundaries
  features/
    home/ projects/ ideas/ subjects/ runs/ review/ knowledge/ settings/
  shared/
    api/                    generated/typed request functions + query keys
    components/             accessible reusable primitives
    hooks/                  cross-feature hooks only
    styles/                 tokens, reset, themes
```

- React Router owns URL/navigation state. Important filters, selected subjects,
  board, and review anchors are deep-linkable.
- TanStack Query owns server state, caching, mutations, retry, and invalidation.
  The single SSE client invalidates precise query keys; it does not maintain a
  second shadow store.
- React hooks/context own ephemeral client state. No Redux/Zustand in v1.
- Form state stays local; Zod validates submit payloads. Add a form library only
  when repeated complexity proves it useful.
- Unsent text/capture drafts are periodically saved to localStorage under
  versioned, non-secret keys and cleared after confirmed persistence. This is
  crash/reconnect protection, not offline sync.
- Semantic CSS tokens + vanilla CSS/CSS modules implement themes. No component
  framework dictates product appearance. Lucide remains the icon set.
- Accessibility: keyboard path, visible focus, semantic roles, reduced motion,
  and WCAG AA contrast are acceptance criteria, not a later polish pass.

### 6.1 React Flow board

The DB remains canonical. React Flow nodes/edges are a view projection:

- custom node types render goal/sticky/document/media/zone/delivery cards;
- custom edge types render `serves`, provenance, and user connectors;
- node `data` contains stable refs and display data, not hidden business truth;
- geometry changes are debounced and batch-written with board version/
  optimistic concurrency; semantic edits write immediately;
- unsupported freehand drawing is out of scope unless a later requirement
  justifies a dedicated drawing layer;
- accessibility list/outline view exposes the same items without requiring
  spatial interaction.

## 7. API and event surface

- Fastify route plugins group resources by domain.
- Route schemas derive from/reuse Zod contracts; request params/body/response
  are explicit. OpenAPI generation may document the API but is not the source
  of truth.
- Auth remains bearer/session-cookie on every route and SSE/static request.
- One SSE connection per UI instance. Events carry identity/version hints;
  clients refetch canonical resources rather than treating SSE as storage.
- Health endpoints are split: `/health/live` (process loop alive) and
  `/health/ready` (config, DB, migrations, Docker/runtime prerequisites ready).
- Errors use stable machine codes, safe user messages, correlation IDs, and
  optional refs. Secret values and raw agent/telemetry content are excluded.

## 8. Adapter and extension policy

v1 adapters are compile-time dependencies registered explicitly at bootstrap:

```text
AgentBackendRegistry: mock | devin | aider
ImporterRegistry: manual | github | csv
EvidenceSourceRegistry: repository/dossier (Phase A), otlp (Phase C)
```

There is no dynamic code loading, marketplace, npm-path plugin, or arbitrary
extension execution in v1. Interfaces remain stable enough to add built-in
adapters later. Any future third-party plugin system requires a separate trust,
signature, versioning, permissions, and isolation design.

## 9. Configuration and secrets

Configuration is parsed once at bootstrap into an immutable effective config;
project/ticket overrides are resolved by application services. `.env` remains
the v1 secret store by user decision:

- macOS permissions `0600`; Windows ACL limited to the current user;
- settings UI returns only `configured: true|false`, never values;
- writes use atomic temp-file + rename and preserve unrelated entries;
- secrets are injected only into the exact child/container that needs them;
- diagnostics redact by key name and known token patterns;
- migration to OS keychain remains a later security tier.

## 10. Testing and quality gates

| Layer | Tool and required scope |
| --- | --- |
| Pure policy/domain | Vitest table/property-style tests; no I/O |
| Store | PGlite integration for every repository/migration; real pinned Postgres contract suite in CI |
| API | Fastify `inject` tests for auth, validation, idempotency, errors, transactions |
| UI | Vitest + Testing Library; mock network at HTTP boundary; accessibility assertions |
| Browser | Playwright critical journeys against a real daemon |
| Workers | Mock adapter deterministic E2E; Docker lifecycle and kill/pause/restart tests |
| Desktop | Rust unit tests + packaged macOS/Windows smoke: start sidecar, ready, load UI, quit/restart |
| Contracts | Schema fixtures for every agent artifact and API payload; malformed cases must fail |

Every work package runs `pnpm typecheck`, `pnpm test`, `pnpm lint`, and its
targeted E2E. CI builds macOS and Windows artifacts on native runners. Release
artifacts are signed/notarized; unsigned local developer builds remain possible.

## 11. Observability and operations

The daemon emits structured JSON logs with timestamp, level, component,
correlation/run/subject refs, and safe error code. It never logs prompts,
secrets, `.env`, raw telemetry, or full model output by default. Metrics cover
queue depth, tick duration, worker health, DB/container readiness, API latency,
and SSE reconnects.

Phase C adopts OpenTelemetry/OTLP for managed-application telemetry ingestion
and may also instrument Veto itself. Product telemetry and Veto operational
logs remain separate sources with explicit authorization/redaction.

## 12. Startup, shutdown, and upgrades

Startup order:

1. resolve config paths and acquire a single-instance lock;
2. validate `.env` permissions and required non-secret settings;
3. verify Docker; ensure/health-check managed Postgres;
4. connect, take migration lock, backup if required, migrate;
5. validate required PATH tools/backends and reconcile orphan workers;
6. start conductor scheduler, API/SSE/static surface;
7. mark `/health/ready`; Tauri shows the UI.

Shutdown stops accepting mutations, ends SSE, pauses new scheduling, gives
workers a bounded drain period, persists status, then stops the daemon. Active
ticket containers and the Postgres volume are preserved for restart.

Upgrade is forward-only for code/schema. Destructive migrations require a
backup and explicit release-note warning. Downgrade is restore-from-backup, not
reverse migrations.

## 13. Deliberate non-choices

- No Electron, Next.js, server-side rendering, GraphQL, ORM, Redis, Kafka,
  microservices, Kubernetes, dynamic plugins, or offline synchronization.
- No business logic in Tauri/Rust, Fastify handlers, React components, or SQL
  migration scripts.
- No tldraw production dependency unless its licensing decision is revisited.
- No PGlite production fallback.
- No direct UI access to Docker, git, filesystem, database, or agent CLIs.

## 14. Authoritative external references

- Tauri 2 external sidecars: <https://v2.tauri.app/develop/sidecar/>
- Node.js single executable status: <https://nodejs.org/api/single-executable-applications.html>
- React Flow repository/license: <https://github.com/xyflow/xyflow>
- tldraw production license requirement: <https://tldraw.dev/sdk-features/license-key>
- TanStack Query: <https://tanstack.com/query/latest/docs/framework/react/overview>
- pgvector Docker image: <https://github.com/pgvector/pgvector#docker>
