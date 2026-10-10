# PRD — Veto

**Status:** Draft v3 · **Author:** Keith + Devin · **Updated:** 2026-10-04
**Reference implementation:** `run-tickets.sh` — working v0 bash prototype,
verified end-to-end with a stubbed agent (priority ordering, repo resolution,
branch creation, prompt rendering, status transitions, blocked path).

---

## 1. Problem

**Code is cheap now; judgment isn't.** LLM agents write implementations
faster than humans can evaluate them — the bottleneck moved upstream, to
requirements, design, and verification. Yet the specs feeding agents are
thin: a ticket, a prompt, and hope. Engineers spend their scarce attention
fixing agent output downstream instead of shaping agent input upstream —
where a precise AC, a correct TDD, or a caught ambiguity is worth dozens of
downstream fixes. There is no tool that (a) helps humans produce specs
rigorous enough to *steer* agents, and (b) verifies the output against
those specs — which is the work that actually decides whether
agent-authored code ships well.

## 2. Product

**The bet: trust, not generation, is the bottleneck.** Veto moves
engineering attention upstream — AI-assisted requirements, design, and
test planning produce specs rigorous enough to *drive* implementation;
agents write the code; the machine proves the spec held. The spec pipeline
is the product; orchestration is what makes it executable.

Pitch: **"Agents propose. Humans veto."** *Your agents write the code;
Veto proves it — spec-gated implementation, independent-model review,
and a complete audit trail per ticket, ending in a PR a human actually
trusts.*

**Domain:** decision reopened 2026-10-04 — `.dev` reads "in
development," not shipped product. Final pick pending from the
candidates below; all verified available via authoritative registry
RDAP on 2026-10-04. The domain hosts the public product site only
(marketing, docs, downloads) — the engine stays local-first and never
cloud-hosted.

1. **`vetoed.app`** — keeps the chosen name on a real product TLD
   (Google registry, HTTPS-enforced, ~$14/yr).
2. **`vetoed.ai`** — same name, signals the AI-agent category;
   pricier (~$70/yr).
3. **`vetohub.com`** — `.com` credibility; "hub" matches the
   control-plane role. Matching `.app`/`.ai` also free — bundle play.
4. **`vetoforge.com`** — full `.com`/`.app`/`.ai` bundle free; "forge"
   reads build/manufacture quality.
5. **`vetoship.com`** — full bundle free; "ship" matches the
   gated-release story.

All exact-match `veto.*` TLDs (`.dev`, `.com`, `.io`, `.ai`, `.sh`,
`.app`, `.build`, `.run`, `.tools`, `.codes`) are registered, as are
the classic SaaS prefixes (`getveto`, `useveto`, `tryveto`) on `.com`.

### Current target model (2026-10-04)

The product now covers the full **idea → specification → implementation →
review → release → learning** loop. This section supersedes older references
in this document to a tickets repository as the source of truth, the merged
state as terminal, workspace/product as separate user-facing concepts, and a
14-screen UI.

- **Project** is the user-facing root: code repos, dossier, boards,
  initiatives, features, tickets, runs, and metrics. `workspace` remains a
  temporary internal/API key only.
- **Database-only truth:** Postgres is the sole backend (D29); embedded
  Postgres (PGlite) powers tests.
  Append-only `events` and immutable `doc_versions` preserve the audit
  guarantees previously assigned to the tickets repo. Code still lives in git;
  implementation still uses branches, worktrees, commits, and pull requests.
- **Hierarchy:** project → board → initiative → feature → ticket. Small tickets
  may remain project-scoped orphans.
- **Idea boards:** named freeform canvases with typed items, documents, media,
  zones, connectors, comments, a capture tray, and a shared delivery Kanban.
  Scoped synthesis turns selected ideas into an initiative PRD plus editable
  provenance, then decomposition produces features and tickets.
- **Goals (D33):** typed board stickies — many per board, free-text
  direction. `serves` edges link items/entities to goals; synthesis
  requires ≥1 goal in scope; `serves` propagates initiative→feature→
  ticket, `{{GOALS}}` texts inject into every stage prompt, and shipped
  work rolls back up per goal (progress badge on the sticky, per-goal
  metrics: cost, lead time, deviation rate).
- **Operational hubs:** ticket, feature, and initiative pages lead with the
  immediate Next action and a Status/What's-left rail. AI appears contextually
  while editing a document or review object, never as permanent page chrome.
- **Evidence-backed intelligence (D37, immediate post-launch):** one authorized
  evidence plane spans goals, requirements, code, tests, commits, releases, and
  later production signals. Retrieval is hybrid (exact/FTS + semantic +
  explicit/structural relations), commit-pinned, cited, and shared by PRD,
  design, test, implement, review, and release workflows. It is not a launch
  blocker; Phase A begins immediately after the first release.
  `INTELLIGENCE.md` is the technical design.
- **Release truth:** `merged → verifying → released`; an idea is `shipped` only
  after its descendants are released. Verification uses a configured command,
  an app smoke check, or a human confirmation gate.
- **Complete UI:** S-01 through S-20, plus shared command/search, create, and
  notification overlays. `UI-INVENTORY.md` is the page/functionality index.
  **Light + dark themes** ship together (D34 — token palette +
  `ui.theme: system|dark|light`; `docs/design/theming.md`).

A **local engine with a web-served UI**: the conductor (babysitter
process) serves the full app over HTTP on localhost, and the desktop
application is a thin **Tauri 2** shell wrapping that surface. The initial
desktop platforms are macOS and Windows; Electron and Linux packaging are
deferred. The engine
CANNOT be cloud-hosted — worktrees, per-ticket containers, agent CLIs,
and detached runs are
local-machine operations; "desktop app" is the delivery wrapper for
presence (dock icon, badge counts, notifications, launch-on-login), not
an architectural commitment. `veto daemon` headless serves the
identical UI in any browser; cloud multi-tenant SaaS is deferred — it
inverts the "everything stays on your metal" trust model. Shepherds
tickets from ingestion to merged PR:

```
[survey] on repo add: deep investigation → product dossier in the
         knowledge base (DB) — architecture, workflows, personas,
         docs digest, UI map, gap report — feeds every stage below
[capture] quick capture / idea board → scoped synthesis interview →
          initiative PRD + provenance → features → tickets
[author] in-app interview (AI interrogates a rough idea → well-formed
         ticket) — same wizard machinery as triage — OR
[ingest] Jira / GitHub Issues / Linear / manual MD → normalized ticket MDs
       → stored as immutable ticket document versions
  → imported
  → [spec-lint] mechanical spec-quality score — vague ACs, missing scope,
    unverifiable criteria flagged BEFORE tokens are spent
  → [triage] read-only agent run (+ prior-art recall from the ledger):
    clarifying questions + repo/backend/model/depth suggestions +
    files-likely-touched, appended to the ticket
  → needs-info ⇄ humans answer in the desktop UI; answers create a new
    ticket document version + event
  → [split] oversized tickets → agent-proposed sub-tickets + dependency
    edges → batch-processed as a family
  → ready → [implement] agent backend → branch + commits + pr-body.md
  → [review] deep LLM review → structured comments (review.json)
  → GitLab-style review UI; human notes feed back to the agent;
    re-review until human approves
  → [open] push + gh pr create
  → [shepherd] watch CI; feed failures + teammate PR comments to agent
  → merged → verify command / app smoke / human confirm → released
  → release notes + retro/feedback return learning to the board
```

**The application database is the source of truth.** Projects, boards, board
items, initiatives, features, tickets, gate items, immutable document versions,
and append-only events live in Postgres. Markdown
remains the document interchange format, but it is stored in `doc_versions`
rather than a tickets repository. Every prompt, answer, document revision,
run, review round, transition, merge, verification, and release writes an
event. `LOG.md` is generated on demand from those events.

Large run artifacts such as transcripts and raw usage files may remain on
local disk, indexed from the database by immutable refs. Code repositories
remain ordinary git repositories: implementation gets isolated worktrees,
logical commits, branches, pull requests, CI, merges, and reverts. The storage
pivot changes product records, not the code-delivery discipline.

Event fields include `cost_usd`, `tokens_in`/`tokens_out`/`tokens_cached`,
`duration_s`, `human_minutes`, actor, subject, and artifact refs — ROI metrics
are schema fields from day one.
(`human_minutes` is captured as **gate dwell** — gate-surfaced →
gate-cleared timestamps — reported with an honest idle-time caveat, not
fake precision.) This ledger is a first-class asset, not a by-product:
metrics substrate and a prior-art corpus for triage — it survives the
pipeline itself.

**Requirement — per-ticket token accounting.** Every run writes a
`usage.json` ledger (per-call where the harness exposes calls,
run-aggregate otherwise) and every ticket carries input/output/cached
totals across its full lifecycle — interview and survey through
shepherd. Rules: `tokens_in` always exact (we render the prompt);
`tokens_out`/cache reported where the backend exposes usage, estimated-
and-flagged where it doesn't; `cost_usd` computed only where pricing is
token-based (OpenRouter) — null for non-token billing (devin), never
synthesized. Tokens are the universal currency of account; dollars are
derived where honest. Live per-message usage streams to the run monitor
where the adapter can parse it. See SCHEMAS §13 + ADAPTERS usage
contract.

**Headline metric: deviation rate.** Per-ticket: `deviation_count` =
`DEVIATIONS.md` entries + committed TDD addendum rows at merge (spec-bug
findings excluded — they ride their own taxonomy). Project metric:
`deviation_rate = merged tickets with deviation_count ≥ 1 ÷ merged
tickets`, computed per window in `/metrics` alongside
`addenda_per_ticket` (Σ deviation_count ÷ merged tickets) — rate tells
you how often reality disagreed, addenda how badly. A zero-deviation
merge means the TDD was right. Spec quality is measurable from day one;
the ledger is also institutional memory (decision history compounds).
**Sanitizer**: a named scanner (gitleaks or trufflehog) runs
**fail-closed** — a scan error blocks the commit rather than warning —
and prompts instruct agents to never print env/secrets. Runner commits
under a bot identity.

### Agent layer is pluggable

| Backend | Provider/key | Status |
| --- | --- | --- |
| **Devin CLI** | Devin account | ✅ v0 built & verified |
| **BYOK → Aider via OpenRouter** | `OPENROUTER_API_KEY` | 🔲 v1 target — only BYOK provider for now |
| Other agent CLIs (claude, codex, goose, opencode, Gemini) | their own auth | 🔲 later, via same adapter |

**Adapter contract** (what the runner needs from any backend):
run a rendered prompt non-interactively in a repo directory → produce
commits on the ticket branch → report exit status. **The runner owns all
environment-touching steps**: push, `gh pr create`, test re-runs, and
collecting artifacts (`pr-body.md`, `DEVIATIONS.md`, …) into `runs/<id>/`
— so backends that can't write outside the repo still conform.
Each backend declares **capability flags** in config —
`can_exec`, `can_write_outside_tree`, `has_gh` — which reshape the
prompt (instruct artifacts to absolute `runs/` paths only when
`can_write_outside_tree`) and tell the runner what to collect vs.
synthesize from the worktree, plus a **runtime** (`container` |
`process`): `aider` runs inside persistent per-ticket Docker containers
(D30 — CONDUCTOR); `devin` keeps host processes + `--sandbox`.
Containers get no gh/git credentials — environment steps stay
runner-owned either way.

## 3. Users

Potential product/OSS — not just a personal script. Implications: real
packaging/install path, layered config, pluggable backends, a review UI
that is the centerpiece rather than an afterthought.

## 4. Configuration (layered)

```
~/.config/veto/config.yaml                # global: projects, backends, models
~/.config/veto/.env                       # secrets — never committed
project settings in DB/config             # repos, dossier, boards, verify/app URL
subject backend:/model: override          # optional initiative/feature/ticket override
```

User configures *which backend* and *which key*; subjects may override.
Full field-level spec in `SETTINGS.md` — YAML + DB-backed project settings,
precedence subject override > project > global > defaults, secrets only via
`.env`. The `sprint` concept is dropped. Shared context lives at
`projects.<p>.context_file` (`{{CONTEXT_MD}}`).
Settings include: `main_model`/`review_model`, `gates`
(full|plan-package|minimal), merge strategy, per-stage timeouts,
worktree root, `storage_url`, backend capability flags, repo cards
(auto-probed + execute-verified), notifications.

## 5. Ticket format

```yaml
schema: 1
id: SR-0042                 # allocated from projects.next_ticket_seq
title: Short title
status: imported            # see state machine below
priority: high              # high | medium | low
feature: F-0007             # parent feature (D26); null = orphan
repos: [backend]            # LIST — cross-repo tickets are common;
                            # one branch+worktree+PR per repo
depth: standard             # light | standard | deep
backend: aider              # optional; default from config
model: openrouter/anthropic/claude-sonnet-4   # optional
source: jira:PROJ-123       # optional
depends_on: []              # ticket ids that must merge first
```

Fields are `tickets` row columns; the markdown body (Description /
Acceptance criteria / Notes) lives in immutable `doc_versions` rows —
SCHEMAS §1. The ticket document remains the logical agent interchange
contract. All structured
formats (docs, JSON artifacts, events) are specified in `SCHEMAS.md` — agents
emit exactly those shapes; the runner lints them fail-closed.

## 6. Status state machine

```
imported → triage → needs-info ⇄ (rounds, capped at 3)
                        ↘ escalated — returned to author w/ findings
                        ↘ wont-do — terminal, human-killed
           ready(forced) — human override, flagged in ticket
needs-info → prd-draft ⇄ prd-review → prd-approved
prd-approved → design-qa ⇄ (technical Q&A, same wizard) → tdd-draft
             ⇄ tdd-review → tdd-approved
             → test-draft ⇄ test-review → test-approved
           → in-progress → review → changes-requested ⇄ review
           → approved → pr-open → ci-watch → merged → verifying → released
                                                   ↘ verify_failed
           ↘ failed / blocked (env) — retryable, picked up on next run
           ↘ aborted (killed/timed out) · reverted (post-merge) — terminal
```

(The full sentinel → status transition table — what fires each arrow —
lives in CONDUCTOR.md.)

Every artifact is **stage-gated**: analyze → Q&A → draft → human
review/feedback → approve → next stage. The wizard machinery is reused
for each Q&A phase (requirements questions for PRD, technical questions
for TDD).

**Gate modes** (`gates` setting — the human-attention budget is tunable,
not fixed): `full` = every doc gated (default, up to ~7 touchpoints);
`plan-package` = PRD+TDD+test reviewed as ONE combined approval (~40%
fewer touchpoints); `minimal` = requirements Q&A + final code review
only.

**Spec-depth tiers** (`depth` — orthogonal to `gates`: depth controls
*investigation thoroughness*, gates control *approval ceremony*):
`deep` = exhaustive analysis (alternatives, risk register, edge cases,
cross-repo mapping) for architectural/high-risk tickets; `standard`
(default) = the pipeline as specified; `light` = same deliverables —
PRD/TDD/test.md still produced and gated — but shallower investigation
and slimmer docs, for small/low-risk tickets. Triage recommends a tier
from ticket size/risk; the human can override; `{{DEPTH}}` is injected
into stage prompts so agents calibrate effort.

### Document pipeline — the per-ticket artifact set

Each ticket owns the following logical, versioned artifact set:

| File | What it is | Author |
| --- | --- | --- |
| `tickets/<id>/ticket.md` | Intake: original ask + triage findings | importer/human + triage agent |
| `tickets/<id>/prd.md` | Product requirements: what + why, final ACs, scope boundary | agent, after requirements Q&A; human-approved |
| `tickets/<id>/tdd.md` | Technical design: architecture, ordered execution plan, **file-by-file change list with rationale**, risks/open items | agent, after technical Q&A; human-approved |
| `tickets/<id>/test.md` | Test plan: every AC/change/workflow → named test cases + machine-readable **coverage matrix**; no code, plan only | agent, post-TDD; human-approved (same gate) |

- **Requirements Q&A** (the needs-info wizard) must gather everything the
  PRD needs — the PRD is drafted only when its inputs are complete, then
  human-reviewed/approved before design starts.
- **Design stage** runs a second, *technical* Q&A (same wizard UX — "which
  worker pool?", "extend `JobBuilder` or new class?") before drafting the
  TDD; TDD also goes through human approval.
- **TDD is the implement spec** — the implement prompt injects the TDD and
  instructs faithful execution; the raw ticket becomes reference context.
- **TDD drift** = proceed + flag: the agent deviates minimally, documents
  every divergence in `pr-body.md` and a committed TDD addendum. Addenda
  are **first-class citizens** — the review page shows them as a
  dedicated section so "approved doc + agent amendments" is never
  mistaken for "the approved doc."
- **Test stage**: draft test plan → **mechanical completeness lint**
  (parse matrix; every PRD AC + TDD file-change must map to ≥1 case ID —
  an incomplete matrix never reaches human review. Honest scope: it
  proves a case *name* exists per item, not that the case is real — an
  optional reviewer-model **plausibility spot-check** can sample claimed
  coverage) → human approve → implement.
- **Test order**: cases written alongside code (no strict red-green); all
  planned cases must exist by end of implementation.
- **Test results**: the runner independently re-runs the repo-card test
  command and produces `runs/<id>/test-report.json` (per-case
  implemented?, pass/fail/skip, pass %, risk flags) — ground truth, not
  agent self-report. Rendered as a panel on the code-review page; the
  human picks **"send back to fix"** (failures → fix run) or **"approve"**
  (documented failures ride in pr-body). Done is the human's call; the
  report is the contract.

### Implementation stage

The implement prompt is **vendor-portable markdown** — same package feeds
devin, aider+OpenRouter, or future backends:

- **Layered spec package**: must = TDD file-plan + test-plan cases + repo
  card; should = PRD ACs + repo map; reference-on-demand = triage
  transcript, ticket body. Small/weak models get the tight version to
  protect context budget.
- **Ordered execution, per-step commits**: work the TDD plan in order;
  commit at each logical checkpoint (bisectable, resumable, story-readable
  diffs). Verify per step — narrowest relevant check after each change.
- **Deviation fence**: minimal deviations only when the TDD is impossible;
  every deviation logged in `DEVIATIONS.md` (`planned X → did Y, because
  Z`); never widen the diff beyond the TDD file list.
- **End-of-run ritual**: full suite + lint green → self-review diff vs
  TDD file list → cross-check every planned case exists → write
  `pr-body.md` (summary, AC→impl map, deviations, risks). All outputs are
  files with required formats.
- **Sentinel contract (all stages)**: the LAST non-empty line of output
  must be exactly `SENTINEL: <value>`; the runner parses only that final
  line — a `DONE` echoed mid-transcript or inside a code comment can't
  fake an outcome.
- **Resume-aware**: prompt starts with "check branch for existing commits,
  continue where the plan stopped" — a crashed run doesn't redo work.
- **Model as retry dimension**: a failed run on a cheap model retries once
  on a stronger model before `failed` (same escalation ladder as triage).
- **Code repos** = configured on the Project in settings (the repos.conf
  concept graduates to a settings panel: N code repos + backend config).
  Feature branch `ticket/<id>` per ticket.
- **Parallelism**: full parallel — tickets may be at any stage
  concurrently; same-repo implementations get isolated **git worktrees**
  (sibling dir convention `<repo>.worktrees/<id>`, cleaned up on
  merge/fail; merge ordering handled by git/CI at PR time, not the
  scheduler). **Isolation is per-ticket containers** (D30): each ticket
  executes its repo-touching stage runs inside its own persistent
  Docker container — own branch, own worktree mounts, own inference
  calls to OpenRouter — so 4 tickets in flight = 4 containers × 4
  branches × 4 inference streams. See CONDUCTOR "Container lifecycle".
- **Backend/model (MVP)**: one global config — Aider+OpenRouter **or**
  Devin + a model picker. Per-stage routing is a designed-in seam, deferred
  post-MVP.

Runner owns transitions via validated DB mutations plus append-only events.
`released` is the successful terminal state; terminal subjects are skipped on
re-runs unless an explicit recovery/re-plan action allows otherwise.

### Storage architecture — database truth, git delivery

| Store | Contents | Guarantees |
| --- | --- | --- |
| **Postgres** (PGlite in tests) | Projects, boards/items, initiatives, features, tickets, gates, document versions, events, runs, dossiers, search, metrics | Primary application truth; immutable versions and append-only event history |
| **Local artifact store** | Raw prompts, transcripts, usage exports, test/review artifacts too large or awkward for rows | Content-addressed/immutable refs recorded in the DB |
| **Code repositories** | Product code, implementation branches/commits, PRs, CI and merge history | Normal git delivery; not the product-record database |

- `doc_versions` is append-only; the current document is a pointer to one
  immutable version. Diffs work between any two versions.
- `events` is append-only and ordered by subject sequence. Human-readable logs
  and query projections are derived from it.
- **Leases** (`subject+stage+attempt`, TTL + heartbeat) fence runs and human
  gate claims across installs. Overlapping `run_started` events for the same
  subject/stage are an invariant violation.
- **Run registry**, heartbeats, presence, and transient notifications are
  coordination state; durable outcomes and artifact refs are events.
- Postgres is the only storage backend (D29). The desktop/daemon manages a
  dedicated local Docker Postgres 17 + pgvector container and durable named
  volume by default (D38); its resolved `storage_url` is process state. A
  developer override may supply a URL explicitly. PGlite is test-only.

### Authoring & ingestion

- **Interview mode** (an upstream entry point — direct tickets and manual
  initiatives/features use it): a human types a rough idea; the agent
  interrogates it
  authored in-app): a human types a rough idea; the agent interrogates it
  through the SAME wizard machinery as triage (structured questions,
  recommended options, accept-all, same anti-spin guards) and writes a
  well-formed immutable document version. Also runs as
  "deepen this ticket" on a thin imported one. The wizard's job in both
  modes: turn vague intent into implementable spec.
- **Idea-board mode** is the broader funnel: quick capture or a canvas gathers
  typed ideas and evidence; scoped synthesis creates an initiative PRD plus
  provenance; decomposition produces features and implementation tickets.

### Knowledge base — the product dossier (the intelligence layer)

Repo cards know *how to run* a repo; nothing in a pipeline knows *what
the product is*. The survey fixes that: a deep investigation run type
that produces a durable **dossier** — the substrate every stage prompt
draws on. This is what turns questions from generic ("what should this
do?") into domain-aware ("does the badge poll respect the 30s SLA your
FAQ promises?").

**Dossier contents** (per SCHEMAS.md §11): architecture map (modules,
data flow, integrations) · domain model (entities, state machines,
business rules) · **user workflows** (happy paths + edge flows, mapped
to real screens) · **personas** (agent-inferred from roles/permissions/
docs → human-corrected) · docs digest (manuals, FAQs, wikis summarized
+ linked) · UI map (screens + navigation, from screenshots and
Playwright crawl) · glossary · landmines (fragile areas, forbidden
zones, "don't touch X without Y") · **gap report**.

**Sources** (pluggable, everything supported): code (inferred
architecture/workflows) · repo docs + provided files (manuals, FAQs,
ADRs, API specs — MD/PDF) · **screenshots** (vision-capable model maps
the real UI surface) · **Playwright crawl** of a running app (maps real
screens + nav firsthand) · support tickets / known-bug lists /
analytics (optional — richest user-pain signal).

**Granularity**: per-repo dossiers (architecture, conventions,
landmines) + a **product rollup** dossier (workflows, personas, docs)
spanning the repos of a `products:` config entry — users experience
products, not repos.

**Production**: `survey` run type — runs on repo add (with the
repo-card probe), on **manual sync** (admin screen button), and on a
**scheduled re-survey** (cron-ish, `survey_refresh: weekly` default —
cadence TBD). Incremental update-on-merge is designed-for, post-MVP.

**Consumption**: the runner injects scoped dossier sections into stage
prompts — `{{DOSSIER}}` in triage/interview (questions get domain-
aware), design (fits real architecture), testplan (cases derived from
*real user workflows*, not just file coverage), review (checks against
documented behavior). Scoped sections by touched area — never the whole
dossier (token budget). **Graceful degradation**: while a survey is
still running, `light`/`standard` tickets flow with `dossier: pending`
(flagged on the ticket); `deep`-tier tickets park until the dossier
exists — the tickets that need it most wait for it.

**Gap report** (report-only): undocumented workflows, FAQ-vs-code
contradictions, untested flows, doc rot, dead screens → a first-class
dossier section humans review in the KB screen. Gaps inform triage
questions; they do NOT auto-generate tickets.

**Human correction**: dossiers are agent-written but human-correctable
in the KB screen — edits are DB writes + ledger events. Same ethic:
agent proposes, human disposes.

**Semantic layer** (SCHEMAS §12): beneath the prose dossier sits a
typed-edge knowledge structure — entities (canonical names + aliases),
relations (`part-of`, `calls`, `transitions-to`, `documents`,
`contradicts`), and controlled taxonomies (deviation `reason_kind`,
question `gates`, finding/gap enums). Local embeddings (pgvector —
free, private, no API spend) power prior-art recall,
near-dup ticket/finding detection, dossier-section retrieval, and
conflict prediction. Effect: questions get domain-aware ("when you say
'job' — `IngestionJob` or `SyncTask`?"), deviation-rate decomposes into
WHICH kind of spec failure occurred, and the ledger becomes queryable
by meaning, not just strings. Deliberately ontology-LITE — typed-edge
tables, not RDF — and derived/regenerable like all DB data.

### Code intelligence and continuous alignment (D37)

The dossier is the human-readable rollup; the evidence plane beneath it also
indexes commit-pinned code units, symbols, exact text, structural relations,
and source coordinates. Vectors alone are insufficient: retrieval combines
exact identifier/path search, Postgres FTS, embeddings, verified workflow
links, and bounded structural traversal, then returns cited evidence with
freshness and ranking provenance. For an existing product, this investigation
runs before PRD drafting so requirements reflect current behavior and
constraints rather than generic assumptions.

Veto preserves explicit links across goal → requirement/AC → feature/ticket →
PR/commit → code/test → release. AI-suggested links carry provenance +
confidence. Suggestions at confidence ≥0.90 may become `auto-verified`, visibly
labeled with their automated source; lower-confidence suggestions require
human verification. Coding agents must still read current worktree files and
run real commands; retrieved chunks are planning evidence, never the complete
truth.

The same evidence supports three product capabilities:

- **PRD quality:** the mechanical spec lint remains cheap and deterministic;
  an AI pass adds cited findings for contradictions and missing accessibility,
  abuse/security, failure, data/privacy, performance, operability,
  observability, rollout, rollback, and success-measurement requirements.
  Critical findings block approval until resolved or explicitly waived;
  moderate/minor findings are advisory.
- **Impact/test/release intelligence:** design and test plans cite affected
  code and likely coverage; release readiness combines hard gates with an
  evidence-backed risk narrative. AI can explain risk but cannot turn a failed
  deterministic gate green.
- **Continuous alignment:** compare intended, implemented, and
  verified/observed evidence to surface reviewable drift or coverage findings.
  These are hypotheses, not claims of behavioral equivalence and never silent
  spec edits.

Production telemetry is Phase C, not a license to embed raw logs. Authorized
connectors redact, normalize, fingerprint, and deduplicate first; raw counts
and events stay in the observability backend while only sanitized patterns,
summaries, and validated incident resolutions enter semantic retrieval. Root
cause results are ranked hypotheses with disconfirming evidence and next
checks. Ticket creation, fixes, deployments, and production changes retain
human gates. Full design, evaluation measures, and rejected approaches:
`INTELLIGENCE.md`.

### Spec quality machinery (the upstream product)

- **Spec linter** (mechanical, zero tokens, runs pre-triage): flags
  vague verbs ("handle properly", "should work"), unverifiable ACs,
  missing scope boundary, oversized touched-files estimate → emits a
  `spec_score` + flags into `triage.json`; surfaced in the inbox so the
  worst specs are groomed first. Leading indicator where deviation rate
  is the lagging one.
- **Verifiable ACs**: criteria are written as checkable statements
  (Given/When/Then or "when X, then Y must happen") — structure where it
  pays, freeform prose everywhere else. The coverage matrix then maps a
  real contract, not a wish.
- **Definition of Done**: `test.md` gains a DoD section — rollout,
  observability ("how will we know this works in prod"), rollback/
  migration-reversibility criteria — checked before merge is enabled.
- **Spec-bug feedback loop**: review findings are tagged `spec-bug`
  (traced to spec ambiguity/missing requirement) vs `code-bug`;
  spec-bugs addend the spec doc AND feed the spec-quality metrics —
  closing the loop between what the code review finds and how the
  pipeline's specs improve.
- **Prior-art recall**: the runner injects `{{PRIOR_ART}}` into triage/
  design prompts — similar past tickets (matched by repo + touched-file
  overlap), their deviations, and which questions mattered. v1 = grep/
  file-overlap matching; embeddings later. The ledger learns.
- **Auto-split** (`split` run type): an oversized/escalated ticket →
  agent proposes child tickets with `parent:`/`depends_on:` fields
  → human approves the split plan → children enter `imported` and are
  processed topologically (parallel where independent, max
  `split_max_children`). Decomposition is a capability, not an
  escalation.

### Importing (external sources)

- **Importer adapters**: `jira` (`--jql`/sprint picker, AC extraction),
  `github` (`--repo --milestone`; fills `repo:` for free), `linear`/others
  later, `--csv` catch-all. Contract: tracker → `[]NormalizedTicket` →
  validated ticket + initial immutable document version.
- **`source:` field** (`jira:PROJ-123` / `github:org/repo#42`) —
  enables PR-body `Closes org/repo#42` auto-close freebie and future
  write-back.
- **Re-import = snapshot update**: refreshes description fields, never
  clobbers `status:`.
- **Triage stage**: read-only agent run appends `## Triage` (questions,
  suggestions, touched-files) to the ticket; humans answer in-app; answers
  create a new immutable version. Tickets are not implementable until
  `status: ready`.
- **Wizard Q&A loop**: structured question objects (`question`, `why`,
  `format`, `options[]`, `default`, `allow_other`) in
  `runs/<id>/triage.json`; rendered transcript appends to `## Triage` per
  round. Human answers → new version + event → re-triage → `ready` | smaller batch |
  `escalated`. Questions form a tree (answers unlock follow-ups).
- **Answer formats**: `yesno | single | multi | text` — opinionated
  defaults are MANDATORY (the agent proposes, the human disposes); options
  carry a `recommended` marker; "Other…" escape hatch always present;
  free-text only when genuinely open-ended. Skip = accept default;
  "Accept all recommendations" = one-click pass through the wizard.
- **Voice input**: mic button on text fields — **v1 = the shell's
  webview speech API** (Chromium under Electron, WKWebView under Tauri;
  prefer on-device recognition where the webview supports it). No paid
  STT, no bundled models — only revisit if stock support falls short.
  Raw transcript → LLM cleanup pass normalizes technical terms
  (`"app nav dot t-s-x"` → `AppNav.tsx`) into a structured answer.
- **Anti-spin guards**: ≤3 human rounds → `escalated` (returned to author
  with findings); ≤10 total questions (sprawl = broken ticket); convergence
  detection (no checklist items flipped green → escalate early); one
  stronger-model retry before escalating. Human bail-outs anytime:
  `ready (forced)` override or `wont-do`.
- **Triage self-answers factual questions** by reading the target repo —
  only genuine judgment/product calls escalate to `needs-info` for a human.
- **The `ready` contract**: verifiable ACs + stated scope boundary + repo
  card verified + human questions answered + pre-flight green.
- **Repo card** (per-repo config): test/lint/build commands, forbidden
  paths, key dirs — verified by triage once, injected into implement/review
  prompts. Optional **repo map** (tree-sitter signature dump) for cold-start
  grounding.
- **Pre-flight gate**: clean tree AND test suite green on base commit before
  `in-progress`; broken main → `blocked` + `blocked_reason: env`
  (env-failure distinct from
  agent-failure in the taxonomy).
- Ticket content changes create immutable versions with actor attribution;
  approval/rejection and status changes append events. The UI renders the same
  before/after review semantics without requiring a separate tickets-repo PR.

## 7. Review pipeline (the differentiator)

1. Agent finishes → commits on `ticket/<id>` + `pr-body.md` +
   `DEVIATIONS.md`.
2. **Deep review = multi-pass specialists** — separate focused runs
   (correctness, security, spec-compliance, test-gap) each emitting
   findings merged into one `runs/<id>/review.json` (schema in
   `SCHEMAS.md` §6 — fingerprints are computed by the **runner**, not
   the agent, for reliable cross-round dedupe). The spec-compliance
   pass is partly mechanical: the runner itself diffs the TDD file-plan
   against `git diff --name-only`; the LLM pass only judges whether
   logged deviations are justified and minimal. Reviewer model =
   separate `review_model` setting (recommend different family than
   implementer — no shared blind spots).
3. **Issues → severity-gated fixing**: `blocker`/`major` findings
   auto-queue a fix run; `minor`/`nit`/`question` findings batch to the
   Issues tab for human triage (accept/dismiss/wontfix). Rationale:
   auto-fixing false-positive nits churns working code — every fix is a
   chance to break something, and LLM nits carry a real FP rate.
   Auto-fix rounds capped at **~2**; surviving threads → human.
   **Dismissal cap**: a fix run may self-dismiss at most
   `fix_dismissal_cap` findings (default 2) as not-real — beyond that all
   remaining findings escalate to the human; an agent being corrected
   can't overrule the corrector wholesale.
4. **Full re-review every round** — all specialist passes on the whole
   accumulated change (cost dial = `review_model` tier).
5. **Clean review still requires human approve** → push + `gh pr create`.
   The final stamp is always human.

### Review page (GitLab-style, in the desktop app)

- **Header brief**: diffstat (files, +/−, source:test ratio, new deps) ·
  AC traceability (each PRD AC → verified + code/test links) · spec
  compliance (TDD file list vs actual diff, DEVIATIONS.md cross-check) ·
  test-report.json panel (ground-truth suite re-run) · risk register
  (migrations, API breaks, security surface, perf, data-loss, rollback) ·
  tech-debt delta (TODOs, duplication, hotspots) · highlights · commit
  story vs TDD order.
- **Changes tab**: file tree, side-by-side/unified diff, inline comment
  threads anchored to lines (open/resolved), human comments anywhere —
  human comments also feed fix runs.
- **Issues tab**: every finding = a thread card — severity badge,
  category, `file:line` anchor that jumps into the diff, evidence +
  suggested fix, confidence, status, reply thread (human↔agent discussion),
  batch "send to fix".
- **Test-results panel**: per-case implemented?/pass/fail, pass %, risks —
  with "send back to fix" / "approve" actions on the page.

## 8. Post-PR lifecycle (full shepherd)

- Poll PR checks + review comments every `shepherd.poll_interval_s`;
  check failures → `ci-fix` run, new comments → `comment-fix` run —
  same branch, both bounded by the cycle cap. Human can pause/inspect
  via the UI at any point. Per-PR state (pr/ci/merge) lives in
  `ticket_repos`; `merged` only when all repos' PRs merge.
- **Shepherd cycle cap**: teammate-comment → fix cycles are capped at
  `shepherd_max_cycles` (default 5) per PR — a chatty thread can't burn
  tokens forever; the human takes over past the cap.
- **Spend caps — dual**: `spend_cap_usd_per_ticket` AND
  `tokens_cap_per_ticket` (either fires the kill-switch) plus
  review-round caps bound the cost of LLM-reviewing-LLM — tokens bound
  the backends whose billing isn't dollar-visible (devin). The ledger
  records actual spend so budgets are evidence-based.
- **Rebase run type**: when an earlier same-repo merge conflicts with a
  pending ticket branch, the shepherd rebases onto main, re-runs the
  suite, and pushes — merge ordering is a run, not a punt to git/CI.
- **Abort/kill**: every in-flight run has a per-stage timeout and a kill
  switch — kill the process, preserve the worktree, mark the ticket,
  log the event.
- **Mid-flight change detection**: ticket document versions are hashed at each
  stage boundary; if the ticket changed upstream since the spec was built,
  flag stale-spec → optional re-triage instead of implementing stale
  requirements.
- **Notifications**: desktop notifications + badge counts for every gate
  awaiting human action — the pipeline is async and hours-long;
  attention must be routed, not polled.
- **Human handoff**: any ticket can be handed to a human mid-flight —
  worktree + branch preserved, handoff summary saved as a versioned document
  and event.
- **Merge is a button in the app** — `gh pr merge` (strategy from settings,
  default squash), enabled when checks are green and every `verified_by`
  DoD row has run (`cmd:` rows as verify tasks, `manual` rows as human
  attest). Merge → status `merged` + SHA/PR URL written to the event ledger →
  worktree cleanup. Never auto-merges in v1.
- **Post-merge revert**: `reverted` status + revert run type for merged
  PRs that break prod — the ledger records the whole arc.
- **Post-merge verification**: merged work enters `verifying`; use the project
  `verify_cmd`, an `app_url` Playwright smoke, or a `verify-confirm` human gate.
  Success → `released`; failure → `verify_failed` and the recovery queue.
- Terminal states: `released`, `reverted`, `wont-do`, `aborted`.

## 9. Functional requirements (v0 engine — built)

Serial, priority-ordered execution; `repos.conf` (name→path); clean-tree
preflight (else `blocked`); branch `ticket/<id>`; rendered prompt template
with sprint.md injected; `--dry-run/--ticket/--max/--force/--sprint`;
per-ticket `runs/<id>/` audit trail (prompt, log, export, sessions,
pr-url/blocked/failed).

## 10. Non-functional

- **Security**: **`permission_mode: smart` is the shipped default** —
  bypass is opt-in only. Smart-mode stalls on risky ops surface as
  timeouts → human attention, not silent damage. Clean-tree + branch
  isolation + transcripts; secrets only via env/.env, never in tickets
  or prompts;
  committed artifacts pass a **fail-closed** secrets scan (gitleaks) —
  scan failure blocks the commit; prompts instruct agents never to print
  env values.
- **Cost**: serial self-limits; `--dry-run`/`--max`; per-ticket `model:`
  for cheap-model routing; BYOK = user's own OpenRouter spend.
- **Auditability**: every run leaves prompt + transcript + review.json +
  outcome on disk.
- **Extensibility**: new backends = one adapter; new review UIs read the
  same runs/ data.

## 11. Milestones

- **M0 ✅** — bash reference runner + Devin adapter, E2E-verified
- **M1** — real sprint dry-run on actual tickets/repos; tune prompt template
- **M2** — adapter layer extracted; **aider+OpenRouter backend**; runner-owned
  push/PR step; config layer (global + project + .env)
- **M2.5** — ingestion: `github` importer (easiest), normalized DB ticket
  creation, triage run type + `## Triage` section, `needs-info ⇄ ready`
  loop (CLI-first)
- **M3** — review pipeline: reviewer-run adapter + review.json schema
- **M4** — the full UI: 20-screen web app served by the conductor +
  desktop shell (Tauri) + OS packaging (signing, notarization,
  auto-update — a real milestone line item, not an afterthought): inbox,
  wizard, doc review, code review, KB, monitor, settings — the product
  is the app; immutable DB document versions + events are the durable record.
  **Validation gate: the engine must prove value on real tickets
  before the full UI investment — the pilot informs but does not block.**
- **M5** — post-PR shepherd: CI watch, PR-comment loop, rebase run,
  merge detection
- **M6** — productization: installer, docs, second backend adapters,
  hardening

### Intelligence roadmap (D37)

- **Phase A — immediate post-launch:** commit-pinned code-unit index, FTS +
  semantic retrieval, citations, verified intent→code/test links, code-aware
  PRD/design/test/review, PRD quality findings, and a retrieval golden set.
- **Phase B — continuous alignment:** incremental reindex, richer structural
  change-impact traversal, intended/implemented/verified findings, release
  risk narrative, and feedback clustering.
- **Phase C — production learning:** sanitized telemetry connectors,
  fingerprint/deduplication, deployment correlation, incident investigation,
  validated resolution records, and human-approved bug-ticket proposals.

Postgres + pgvector remains the default. A dedicated vector or graph database
requires measured evidence that Postgres cannot serve the real queries.

## 12. Resolved design Q&A (2026-10-03 session)

This is a chronological decision record. Later numbered decisions supersede
earlier architecture, storage, naming, terminal-state, and screen-count text;
items 37–38 are the current target state.

1. BYOK = user's key into BYOK-capable agent harnesses (runner stays thin)
2. BYOK provider = **OpenRouter only** (v1); more later
3. OR harness = **aider**
4. Backend selection = **user configuration** (layered config + overrides)
5. Quality gate = **deep LLM review + GitLab-style review UI with notes**
6. Human notes **feed back to agent**, loop until approve → PR
7. Tickets = hand-written MDs *(superseded 2026-10-03: multi-source
   ingestion — Jira/GH Issues/Linear/manual — into a configured tickets
   repo, which becomes source of truth after import)*
8. Audience = **potential product/OSS**
9. Shell = ~~desktop app, JS/TS~~ **SUPERSEDED by item 34**
10. Boundary = **full lifecycle** (file → merge)
11. Artifact docs = **stage-gated**: PRD drafted after requirements Q&A →
    human-approved → technical Q&A → TDD drafted → human-approved →
    (test doc proposed) → implement
12. TDD drift = **proceed + flag** (deviation notes in pr-body + TDD
    addendum)
13. Parallelism = **full parallel w/ git worktrees** for same-repo impls
14. Backend/model (MVP) = **one global** (aider+OR or devin + model
    picker); per-stage routing deferred
15. Test doc = **confirmed**, same approval gate; coverage enforced by
    **mechanical matrix pre-check** pre-review
16. Test ordering = **alongside code** (no red-green ceremony)
17. Test done-contract = **human decides** — test-report on the code-review
    page, fix-or-approve; runner re-runs suite for ground truth
18. Deep review = **multi-pass specialists** merged into one review.json
19. Findings = ~~auto-fix all~~ **SUPERSEDED by item 23** →
    severity-gated fixing (§7.3)
20. `review_model` = **separate setting** (recommend different family)
21. Re-review = **full passes each round**
22. Clean review = **still human-approve**
23. Adversarial-review pass applied (2026-10-03): severity-gated fixes
    (not auto-fix-all); runner owns all env-touching steps + backend
    capability flags; LOG.md generated from events.jsonl; fail-closed
    gitleaks scan; gate modes (full/plan-package/minimal); CLI-first
    validation gate before Electron; added rebase/abort/timeout/
    change-detection/notifications/handoff/revert; cost+human_minutes
    in event schema
24. Schemas (2026-10-03): markdown tables w/ pinned columns; `repos:`
    list (cross-repo common → N worktrees, N linked PRs); fingerprint
    dedupe for review threads; medium-granularity events; fail-closed
    doc lint. All contracts in SCHEMAS.md
25. Settings (2026-10-03): YAML; secrets in .env; repo cards auto-probed
    + execute-verified; spec in SETTINGS.md
26. MVP (2026-10-03): CLI/engine-complete pipeline; review surface =
    tickets-repo PRs; BOTH backends v1; pilot informs tuning (no gate);
    Electron post-MVP; cutline in MVP.md
27. Prompts: locked/shipped, versioned with product; templates live in
    prompts/ (triage, design, testplan, implement, review-base+4 passes,
    fix, rebase)
28. Reframe (2026-10-03): product = **upstream attention** — specs
    rigorous enough to drive implementation; code is cheap, judgment
    isn't. Spec-depth tiers (light/standard/deep) = same deliverables,
    variable thoroughness, orthogonal to gates. Headline metric =
    **deviation rate**. External review fixes applied: missing stage
    prompts (prd/probe/import/ci-fix/escalate/discuss) written; case_id ↔
    test linkage convention; runner-computed fingerprints; untestable
    file-plan annotation; spend caps + shepherd cycle cap + dismissal
    cap; git-ref CAS extended to human-gate claims; sentinel =
    last-non-empty-line contract; fix dismissal rate limited; spec-
    compliance partly mechanical; human_minutes = gate-dwell.
29. Upstream expansion (2026-10-03): tickets mostly authored in-app →
    **interview mode** is the upstream entry point (same wizard as
    triage); splitting is constant → **auto-split run type** (children
    carry parent/depends_on, `split` terminal state for parents); spec
    format = structured where it pays (verifiable ACs); author ≈
    approver (gates = self-checkpoints, no role routing); roadmap adds
    spec linter + prior-art recall + DoD section + spec-bug feedback
    loop.
30. Knowledge base (2026-10-03): dossiers live in the **DB layer**
    (three-class split: approval/audit→git, coordination→DB,
    query/reference→DB — dossiers are regenerable, not audit docs);
    sources = everything (code/docs/screenshots/**Playwright crawl**/
    tickets/analytics); granularity = repo + product rollup; personas =
    agent-inferred→human-corrected; gaps = report-only; freshness =
    manual admin sync + scheduled re-survey (weekly default, cadence
    TBD); **full survey in MVP** incl. crawl; KB screen = S-14.
31. Semantic layer (2026-10-03): ontology-lite (entities + typed-edge
    relations, no RDF) + local embeddings (pgvector) +
    controlled taxonomies (deviation reason_kind, question gates) +
    entity linking (entities_referenced in triage.json). Survey
    extracts entities; triage links ticket terms → dossier. Local
    encoder default = free/private retrieval; remote providers later.
32. Engine hardening round (2026-10-03): **babysitter conductor**
    (persistent helper advances all non-gate transitions overnight —
    CONDUCTOR.md); auto-advance = everything EXCEPT implement (human
    "go" = spend checkpoint + cost estimate); DB schema written
    (DB-SCHEMA.md); adapter contract formalized incl. token table
    (ADAPTERS.md); dossier wait = depth-gated (light/standard flow
    degraded, deep parks); schema versioning = migrate-on-touch;
    doc-repair = agent docs auto-repair once then human, human docs
    straight to human; **sprint concept dropped** (context →
    products.<p>.context_file); **`permission_mode: smart` default**,
    bypass opt-in only.
33. **MVP = full product** (2026-10-03 correction; screen count updated
    2026-10-04): there is NO zero-UI mode — MVP ships all 20 screens +
    the babysitter conductor + the
    implement "go" checkpoint (UI button + cost estimate). github.com
    flows (doc-approval PRs, checklist Q&A) become secondary channels,
    not the product. Authored IDs = `SR-NNNN` workspace counter
    (`.veto/next-id`, CAS); collisions = warn-only; actor =
    explicit `actor:` config field.
34. Delivery architecture (2026-10-03): UI = **web app served by the
    conductor on localhost**; desktop = thin shell (Tauri preferred,
    Electron acceptable) for presence only — dock, notifications,
    badge, launch-on-login. Daemon serves the identical surface to any
    browser — no second frontend. The engine can never be cloud-only
    (local worktrees/processes); **cloud multi-tenant SaaS deferred** —
    different trust model. Security: bind `127.0.0.1` default, bearer-
    token always, wider bind requires explicit opt-in + auth.
35. Token accounting (2026-10-03): **formal requirement** — per-ticket
    in/out/cached tokens, `usage.json` per-call ledger artifact (SCHEMAS
    §13), `usage_calls` DB projection; input always exact (we render the
    prompt), output reported-or-estimated-and-flagged; `cost_usd` only
    where token-priced (null for devin — never synthesized); dual caps
    (`spend_cap_usd_per_ticket` + `tokens_cap_per_ticket`); live counter
    streamed where the adapter supports it.
36. TDD gap-closure round (2026-10-03 — cross-doc review vs PRD):
    **UI wire contract** written — API.md: REST + SSE, bearer token
    provisioned to `ui.token_file` (0600), `?token=` bootstrap
    loopback-only; **runner compute** split — inline mechanical checks
    vs detached `verify` tasks (a suite re-run never stalls the tick);
    **workspace column** on every ticket-keyed table + `subject`
    keying (survey/probe/import/interview runs have no ticket);
    `tickets` + `ticket_repos` projections — per-repo pr/ci state,
    `merged` = all repos merged; **sentinel→status transition table**
    in CONDUCTOR; new run types `doc-repair`/`revert`/`comment-fix`
    (prompts written); tail gating fixed — `approved` = open-PR gate,
    `ci-watch` = merge gate, never auto-merge; probe scheduling +
    card requirement scoped to repo-executing stages; interview
    `{{NEW_ID}}` reservation at run start; conductor-side split
    materialization (SCHEMAS §14); git-ref CAS lock expiry via
    `expires_at` ref content; `blocked_reason` frontmatter field;
    triage.json gains `entities_referenced`/`files_likely_touched`/
    `risk_summary`; `findings-<pass>.json` → runner-merged
    `review.json`; `usage_partial` = internal stream, never a ledger
    event; SETTINGS gains `actor`, `security:`, `escalation_model`,
    `shepherd.poll_interval_s`; timeouts completed for all run types;
    pause = SIGSTOP/SIGCONT (`docker pause`/`unpause` for container
    runs — superseded by item 39); heartbeats conductor-observed; DoD
    `verified_by` = `cmd:`|`manual`.
37. Idea-to-production expansion (2026-10-04, D26): database-only product
    truth; Project vocabulary; hierarchy project→board→initiative→feature→
    ticket; freeform idea boards + shared delivery view; scoped synthesis,
    provenance, decomposition, plan-package attention controls, and S-15–S-17.
38. Loop closure (2026-10-04, D27): `merged→verifying→released`, S-18
    Initiative detail, reversible synthesis, capture tray/quick capture,
    provenance amendments, re-plan/re-parent, release notes/retro, global
    search, S-19 Quick Capture, and S-20 Project Tray. `UI-INVENTORY.md` is the
    complete page and shared-surface index.
39. Containerized run runtime (2026-10-04, D30): stage runs execute via
    `docker exec` inside **one persistent Docker container per subject** —
    per-ticket isolation (own container, branch, worktree mounts,
    OpenRouter inference stream; N tickets = N containers). Lazy create
    on first repo-executing stage; `docker stop` at gates; `docker rm` on
    terminal + startup orphan sweep; control = docker kill/pause/unpause;
    CPU/memory caps; single shared agent image; aider-only in v1 (devin
    stays host-process + `--sandbox`); `runtime: process` fallback.
    Full spec: CONDUCTOR "Container lifecycle", ADAPTERS "Runtimes".
40. Evidence and delivery intelligence (2026-10-04, D37): one shared,
    permission-filtered evidence plane replaces separate code/log RAG silos;
    hybrid retrieval (exact/FTS + semantic + explicit/structural links),
    commit-pinned citations, pre-PRD code investigation for existing products,
    verified-vs-suggested traceability, PRD quality findings, test/impact/
    release intelligence, and continuous-alignment findings. Telemetry is a
    later sanitized/fingerprinted integration; raw logs stay in the
    observability backend. Findings and root causes remain hypotheses; no
    autonomous production changes or individual developer scoring. Full TDD:
    `INTELLIGENCE.md`. Clarified after the review: Phase A is an immediate
    post-launch workstream, not a first-release blocker; project connection
    starts indexing automatically, default-branch changes trigger incremental
    refresh, grounding is configurable/default-on, critical PRD findings block
    or require waiver, ≥0.90 link confidence permits visibly labeled
    auto-verification, OTLP is the first telemetry integration, and threshold
    incidents create draft proposals only until human approval.
41. Architecture baseline (2026-10-04, D38): Tauri 2 thin shell on macOS +
    Windows; one Node 22 TypeScript modular-monolith daemon; managed local
    Docker Postgres 17 + pgvector; Fastify REST/SSE; React/Vite/Router +
    TanStack Query; React Flow canvas; Postgres.js + explicit SQL/repositories;
    `.env` secrets; daemon-connected UI with draft recovery but no offline
    sync; built-in compile-time adapters only. Technical packages remain the
    top-level boundaries and use domain slices internally. Full contract:
    `ARCHITECTURE.md`.

## 13. Still-open research items

- Failure taxonomy: agent-failure vs env-failure vs unclear-ticket —
  `blocked_reason` exists; fold in aborted/killed/reverted states.
- Verify `devin -r <id> -p` composes non-interactively for resume/retry —
  otherwise rely on resume-aware fresh runs (branch state → continue plan).
- Escalated destination: v1 = a visible queue in the app any human can
  claim; tracker write-back later (the escalate prompt writes the
  hand-back into the ticket — the author isn't notified externally yet).
- Layered spec package (must/should/reference injection) is designed but
  not yet implemented in implement.md — add when weak-model runs show
  context starvation.
- Prompt-eval loop: no golden-ticket suite re-running shipped prompts
  against recorded sessions to catch regressions as models churn — the
  ledger is the substrate; the harness is future work.
- ~~Naming~~ — resolved: **Veto** (D35, 2026-10-04). Tagline: "Agents
  propose. Humans veto." wp-100 executes the mechanical rename.
- Importer adapter interface detail (auth, pagination, field-mapping,
  re-import idempotency) — contract is one line today; Jira field
  mapping especially needs a real spec.
- Transcript-bloat policy (compress/prune local artifact objects at
  scale); GitHub webhooks as a daemon-mode upgrade over v1's
  `shepherd.poll_interval_s` polling.
- ~~Naming~~ — resolved: **Veto** (D35, 2026-10-04). Domain reopened
  2026-10-04 — finalists listed above (D36, pick pending).
  Packaging/distribution channel still open.

## 14. Addendum — shared-chat capability catalog (2026-10-04)

Source: the "Codebase RAG Strategy" shared conversation — codebase RAG,
error-log RAG, and a 15-capability AI feature list for the
idea→production platform — reviewed as a product + architecture pass.
**D37 and `INTELLIGENCE.md` are the binding architecture** for
everything here; this addendum is the feature-level catalog — what
each capability does for the user, where it surfaces, its phase, and
its disposition against the existing contract. It adds no new contract
surface; where it and `INTELLIGENCE.md` disagree, the latter wins.
Delivery rides the existing intelligence waves (wp-110/111/112/120) —
no new work packages.

### 14.1 Capability catalog

Cross-cutting foundations:

| Capability | What it does | Surface | Phase | Status |
| --- | --- | --- | --- | --- |
| Code intelligence engine | Hybrid retrieval over commit-pinned code units — exact/FTS + semantic + symbol/structural — returning cited evidence | Shared evidence plane injected into stage prompts; KB screen | A | Ratified (D37); vectors-alone rejected |
| Telemetry/incident intelligence | Errors normalized → fingerprinted → deduplicated; similar-incident search + root-cause hypotheses | OTLP connector; incident findings + draft ticket proposals | C | Ratified (D37); sanitized ingest boundary; raw events stay in the observability backend |
| Unified traceability | Verified links goal → AC → ticket → PR/commit → code/test → release; suggested links carry provenance + confidence | AC traceability on review page; provenance editor; "why" answers | A→B | Ratified; ≥0.90 auto-verified stays labeled |
| Continuous alignment | Compares intended vs implemented vs verified → reviewable drift/coverage findings | `alignment-findings.json` → inbox/review | B | Ratified; hypotheses only, never silent spec edits |

Product discovery & planning:

| Capability | Disposition |
| --- | --- |
| 1. AI product discovery agent | **Existing** — scoped synthesis + interview/triage wizards; D37 adds current-product evidence before questions/drafting |
| 2. PRD quality evaluator | **Ratified (A)** — `spec_score` + cited AI findings; critical findings block or require waiver. Delta: findings→revise loop (§14.2) |
| 3. Feature dependency/impact analyzer | **Ratified (A/B)** — blast radius is a hypothesis until structural/current-file checks confirm |
| 4. Intelligent backlog prioritization | **Limited** — AI may present evidence and explain existing priority factors; no opaque scores, no silent reordering of committed work |

Engineering & implementation:

| Capability | Disposition |
| --- | --- |
| 5. AI software architect | **Existing** — design-QA → TDD stage; D37 grounds alternatives and file/API/data impact in cited evidence; may optionally emit an ADR document (doc_versioned) alongside the TDD |
| 6. Multi-agent development | **Existing, bounded** — stage/review specialists coordinated by the conductor; unrestricted agent swarms or self-granted tools rejected |
| 7. AI code review + security analysis | **Existing** — multi-pass specialists + deterministic tooling (sanitizer, tests, static checks); D37 improves citations/traceability |
| 8. AI test designer | **Existing, strengthened** — `test.md` + coverage matrix gain code-aware impact and uncovered-AC evidence |
| 9. AI UI/UX auditor | **Partly existing** — survey screenshots/Playwright crawl + design review today; visual-regression/accessibility auditing is Phase B evidence work. Delta: prototype generation (§14.2) |

Production intelligence & learning:

| Capability | Disposition |
| --- | --- |
| 10. AI root-cause investigator | **Ratified (C)** — ranked hypotheses + disconfirming evidence + next checks (`incident-investigation.json`, SCHEMAS §19) |
| 11. Intelligent release readiness | **Ratified (B)** — deterministic gates remain truth; AI contributes an evidence-backed risk narrative only |
| 12. Customer-feedback intelligence | **Ingress exists, analysis deferred (B)** — `feedback` board item type is live (D27); clustering + suggested links/work are Phase B |
| 13. Requirements-to-code drift detection | **Ratified (B)** — intended/implemented/verified alignment findings |
| 14. Engineering delivery intelligence | **Existing metrics, strengthened** — outcome/bottleneck analysis only; individual developer scoring explicitly rejected |
| 15. Organizational knowledge agent | **Existing dossier, strengthened** — verified PRD/ticket/PR/commit/ADR links answered before inferred relations |

Chat-listed but deferred: automated technical documentation (the
dossier/docs digest already cover the core need — P2), cross-project
architecture insights (permitted only within authorized project scope —
P2), proactive risk detection (Phase C threshold machinery — P2), and
regression/new-error↔deployment correlation (folds into Phase C
investigation).

### 14.2 Deltas the chat adds beyond D37

1. **Findings→revise remediation loop.** The PRD-quality surface pairs
   each finding with a select control and a "revise draft" action:
   selected findings seed a redraft run against the PRD, producing a new
   `doc_version` + event (same machinery as chat-to-edit/`interview`
   targeting the doc). Findings are evidence, not edits — the human picks
   which ones drive revision.
2. **Cross-layer "what-if" scenario queries.** Prospective,
   natural-language questions over the evidence plane ("what happens if
   we replace auth with Auth0?", "biggest risks to the next release?").
   Distinct from retrospective "why" queries: the answer is a cited
   hypothesis — affected services, dependent requirements, test scope,
   migration risks — never a claim. Phase B; entry point TBD (KB or
   assistant surface), contract rides `retrieval-evidence.json`.
3. **UI prototype generation.** The auditor capability may also emit
   pre-implementation UI prototypes as *generated artifacts for human
   review* — never authoritative designs; Phase B, alongside the
   auditing work.
4. **Discovery-stage KPI.** "% assumptions validated before development"
   joins the metrics set — the rest of the chat's stage KPIs already map
   to §7-of-INTELLIGENCE and the event schema (see 14.3).
5. **Orchestration components are already mapped — no second layer.**
   The chat's "AI orchestration engine" (agent registry, tool execution,
   context builder, model router, policy & approvals, evaluation/audit)
   resolves onto existing machinery: conductor + run types (registry/
   execution), scoped evidence bundles (context), `main_model`/
   `review_model` + the deferred per-stage routing seam (router), gates +
   gate modes (policy/approvals), and `events` + golden sets
   (evaluation/audit). Build no parallel orchestration layer.

### 14.3 Stage-KPI alignment

| Stage | Chat KPI | Where it lives now |
| --- | --- | --- |
| Discovery | % assumptions validated | **New** — §14.2.4 |
| PRD | Ambiguity/completeness defect rate | `spec_score` + spec-bug taxonomy + deviation rate |
| Planning | Rework from missed requirements | deviation rate (spec-bug `reason_kind`) |
| Development | Lead time, approved → merged | `events` durations; idea→merge lead time (D26) |
| Quality | Escaped defects per release | `verify_failed`/`reverted` + release events |
| Testing | ACs with verified test coverage | coverage matrix + `test-report.json` + verified links |
| Production | Change-failure/recovery | Phase C telemetry (MTTR/CFR-style measures) |
| Outcomes | Feature's target KPI improved | goals/`serves` rollup + retro (D33/D27) |

### 14.4 Phase mapping

| Chat phase | Veto phase | Delivery |
| --- | --- | --- |
| Foundation (index, hybrid search, code-aware PRD/tickets) | Phase A | wp-110, wp-111 |
| Execution intelligence (impact, test, review, traceability) | Phase A tail + B | wp-111, wp-112 |
| Continuous learning (logs, incidents, release risk, feedback) | Phase B/C | wp-112, wp-120 |

### 14.5 Non-adopted / corrected items

- Go service stack → **superseded** (D1: TypeScript/Node ratified).
- Dedicated vector/graph database → Postgres + pgvector until queries
  are *measured* insufficient (INTELLIGENCE §3).
- Embedding every log event → rejected; fingerprint + dedupe first, raw
  stays in the observability backend (§6.1).
- Multi-tenant framing → Veto is local-first; authorization is
  project/repo/source ACLs, not tenants.
- Incident → auto-created ticket → **draft proposal only**, human
  approves creation; deployments/production changes keep their gates.
- Vector-only RAG → hybrid retrieval is mandatory (principle 1).
- "Generate PRD, then consult the code" → inverted for existing
  products: investigation precedes drafting (D37 §1).
- Loki → example observability backend, not a commitment; OTLP is the
  first connector.
- Repository indexing credentials → no separate credential model;
  indexing uses the project's existing authorized local clones.
- AI priority numbers / silent reorder, behavioral-equivalence claims,
  and individual developer scoring → all rejected (INTELLIGENCE §8).

## 15. Addendum B — full-session review, same chat (464 msgs)

Source: the complete "Codebase RAG Strategy" conversation — the §14 share
was the first 34 messages; the full session continues into idea boards,
mockups, change control, merge/release, ticket taxonomy, naming, review
UX, wizard internals, and model selection. Reviewed as a product +
architecture pass. **§14 dispositions and D37/INTELLIGENCE.md remain
binding.** Everything below is cataloged; §15.11 lists the items that
**conflict with ratified decisions** and are recorded as *proposed,
not adopted* pending an explicit re-decision.

### 15.1 The product promise: "No Surprises at Delivery"

The session converges on one organizing promise, repeated across every
capability: **after the spec is approved, nothing about what ships
should surprise the approver.** This maps directly onto Veto's
"spec-gated implementation" pitch and is adopted as vocabulary.

Its enforcement mechanism is the four-way state separation:

**`approved ≠ merged ≠ deployed ≠ released`.** A ticket's Development
dimension completes at verified merge; a separate Delivery dimension
tracks release → deployment → actual user availability. The current
`merged → verifying → released` tail (D27) already embodies this; the
chat adds the full separation (incl. "deployed but flag-hidden = not
released") and releases as first-class entities (§15.5).

### 15.2 Naming — ADOPTED (ratified in the implementation planning session)

The chat vocabulary is adopted: `project → Solution` (UI/docs; `workspace`
stays the internal key), `PRD → Requirements Specification (RS)`,
`PRD Studio → Requirements Studio`; new artifacts **Solution Brief**
(between charter and RS) and **Verification Specification (VS)**. Doc
kinds migrate in the rename package (wp-132).

| Current (ratified) | Chat proposal | Note |
| --- | --- | --- |
| project | **Solution** (`Org → Solution → Initiative? → Feature → Ticket`) | Chat argued "project" implies end-dated work; Solution is the persistent workspace owning repo associations (many-to-many), docs, standards. Conflicts with D26/D29 vocabulary — needs a D-decision before any rename |
| prd.md / PRD | **Requirements Specification (RS)**, Requirements Studio; Specification=working doc, Baseline=approved immutable snapshot | Same contract, new name; PRD/FRD retained as import/export labels |
| (new layer) | **Solution Brief** between charter and RS — problem, users, alternatives, chosen direction, assumptions, boundaries | Roughly what scoped synthesis produces today; naming it separates "chose the direction" from "specified the behavior" |
| test.md | **Verification Specification (VS)** — AC→verification-method mapping; results are separate evidence | Existing `test.md` + coverage matrix ≈ this already |

Documentation framework: 3 levels — **Org** (standards/policies),
**Solution** (charter, architecture, runbooks), **Change/Feature**
(RS, TDD, mockups, VS, ADRs). ADRs become first-class versioned docs;
repo docs (README/architecture/API/data-model/dev-guide/runbook) are
agent-drafted, human-verified, and follow the code (drift detection).
**Documentation Impact Analysis**: a requirement change lists affected
mockups/TDD/API contracts/tickets/verification as proposed changes.

### 15.3 Idea boards v2 — semantic discovery

- **Typed sticky notes**: `idea | want | avoid | problem | constraint |
  question | decision | feedback` + optional `topic`, `importance`
  (must/should/nice/undecided), `applies_to`, `status`, `rationale`.
  (Current `board_items` types + `goal` type (D33) cover part of this.)
- **Statement Ledger**: sticky notes are presentation; meaning lives in
  versioned `semantic_statements` — atomic assertions with original
  source text preserved (one note → N statements), dimensions
  intent/polarity/subject/strength/scope/status, typed relations
  (`supports|contradicts|clarifies|duplicates|depends_on|supersedes|
  derived_from`), AI-proposed/human-confirmed for consequential ones.
  Rule: **vector similarity retrieves; the structured model decides
  authority** — an approved prohibition beats a brainstormed preference.
- **Discovery Completeness Engine**: flags ambiguity, contradictions,
  unanswered decisions, untestable statements → Discovery Readiness
  Report (explainable indicators, no opaque score).
- **Board types as config, not pipelines**: `NEW_PROJECT | IMPORT |
  ENHANCEMENT | MODERNIZATION | QUALITY | FEEDBACK | RELEASE_PLANNING |
  EXPLORATION` — one reusable board + per-type inputs/capabilities/
  outputs/approval policy. Boards may outlive their first purpose
  (import board → enhancement board) with history preserved.
- **Multiple boards per project + org-level boards** for unassigned
  ideas; an org board can spawn a new Solution and keeps provenance.
- **Board→spec pipeline**: board → discovery → Solution Brief → RS →
  features → tickets. A board can reference approved requirements
  without mutating them; changes arrive only as proposals.
- **Cross-board scope reconciliation**: detect overlapping proposals
  touching the same component before approval; consolidate/sequence.
- **Deferred ideas never die**: rejected/deferred boards keep evidence +
  interview + decision; AI may resurface them when circumstances change
  (e.g., an existing component makes them cheap).
- **Spatial canvas (s-16, D57)**: idea boards render as an infinite
  pan/zoom canvas (React Flow 12) with typed stickies, free text,
  zones/frames, drawn connectors, and links — direct manipulation with
  gesture-end OCC-fenced batch writes, session undo/redo, autosave +
  SSE refresh, and a right-side semantic inspector (taxonomy,
  provenance, statements, lifecycle). Placement is user-canonical;
  grouping only via explicit, previewable, undoable arrange commands.
  Drawn connectors are topology hints — `serves` stays the canonical
  edge. Async collaboration only (no live cursors/CRDT); under 900px
  the board is a read surface; image upload ships once a safe multipart
  plugin exists. Gated by `ui.idea_canvas_v2`.

### 15.4 Design artifacts & mockups

- **Visual Acceptance Criteria**: link ACs to approved screens/states;
  design approval checklist (desktop, mobile, flows, error/empty, a11y)
  records approver + revision; material design change → re-approval.
- **Three fidelity tiers**: wireframe → hi-fi mockup → interactive
  prototype; cheapest that answers the current question.
- **Structured component model as truth** — versioned JSON component
  trees with `requirement:` links per component; rendered previews and
  sandboxed React for complex interactions; PNGs are output, not source.
  Structural diffs, per-component edits, responsive variants.
- **Design-system ingestion agent**: mine the existing app's components/
  tokens so generated screens look native, not generic-AI.
- **Generators**: screenshot→mockup, sketch→screen, screen-state
  generator (loading/empty/success/error/permission/mobile), persona
  walkthrough (hypotheses for validation), visual comments pinned to
  components, implementation-vs-approved comparison post-merge.
- Tickets receive the relevant approved design revision as input.

### 15.5 Change control & scope intelligence

- **ChangeSet entity** + lifecycle `draft → analyzing → awaiting
  decision → approved/deferred/rejected → applying → verified`; carries
  original request, baseline ref, affected artifacts, analysis evidence,
  decisions, reconciliation results. Apply transactionally where
  possible; partial application is visible and recoverable. (Maps
  cleanly onto `doc_versions` + `events` + `gate_items`.)
- **Change categories**: clarification / defect correction / scope
  addition / scope modification / scope removal — handled differently;
  emergency changes get expedited route + mandatory retro documentation.
- **Decision options, not approve/reject**: add now / swap scope out /
  next release / decline — each with stated consequence.
- **Stage-aware handling**: the same request is a note edit on a board
  vs a ChangeSet on an approved baseline vs a new proposal post-merge.
- **Baseline pinning per run**: every execution records PRD/RS version,
  ticket revision, design rev, AC set, base commit. Mid-run baseline
  change → unaffected=continue; small=pause at checkpoint + reconcile;
  substantial=preserve branch, stop, re-plan. Running agents never
  silently adopt a newer spec. Multi-ticket changes reconcile as a set.
- **Scope Creep Radar**: scope added vs removed, post-approval changes,
  rework, affected executions, cumulative estimate drift vs baseline —
  visible before approval, not a postmortem. Computed metrics only —
  no opaque score; every number is explainable from rows/events
  (wp-142, `conductor/changes/radar.ts`):
  - scope added/removed per release = live `release_items` diffed
    against the frozen v1 manifest; manifest recuts count as churn;
    per baseline subject = changeset items by classification
    (`addition`/`removal` vs the rest);
  - post-approval changes = changesets created after a `doc_approved`
    event on the pinned baseline doc;
  - rework = `status_changed → changes-requested` + `fix_round_started`
    on affected tickets + approval invalidation/expiry notes on the
    subject's sets;
  - affected executions = live runs (the `listLiveRuns` status set)
    whose subject is in the blast radius;
  - estimate drift vs baseline = per-doc `head − baseline.version`
    (versioned-doc drift is the honest proxy until wp-153
    `delivery_commitments` carries real estimate deltas);
  - schedule = oldest pinned baseline age in days; cost = Σ
    `events.cost_usd` over the blast radius.
  Served at `GET /api/v1/scope-radar` (`?workspace&subject&release`).
- Safeguards: approval expiry (revalidate only what's invalidated),
  ChangeSet conflict detection, owner-scoped notifications, scope
  budgets (auto-escalate past cost/schedule thresholds — config
  `scope_budgets:` in SETTINGS; a breach surfaces the `scope-budget`
  escalation gate + `escalated` event + owner notifications;
  approving decisions and apply refuse while it is open —
  `POST /api/v1/scope-radar/:ws/:cs/acknowledge` clearing it IS the
  higher approval).

### 15.6 Delivery workspace — Merge Center + Release Center + Improvement

The session's largest coherent block; 10 decisions were ratified in-chat:

| # | Decision |
| --- | --- |
| 1 | Continuous merging to main; releases assembled separately |
| 2 | Hybrid releases — user-created, AI-recommended ticket/feature assignment, human approval |
| 3 | Release **tracking** only — deployments performed externally |
| 4 | Separate Development vs Delivery statuses; dev completes at merge |
| 5 | Feature-first release planning; partial releases require explicit approval |
| 6 | Auto-generated ticket implementation notes + evolving release-note drafts, human-approved before publish |
| 7 | Post-merge defects → linked CorrectionTicket, history preserved, affected ACs revalidated, material defects block release |
| 8 | Hybrid deployment tracking — automated external confirmation when available, manual evidence otherwise |
| 9 | Risk-based configurable release approvals — accountable owner, automated readiness gates, extra approvers by risk |
| 10 | Continuous improvement — release closure, AI retrospective, business-KPI evaluation, feedback/incident analysis, draft proposals back to boards |

- **Merge Center**: approval-bound-to-commit check, scope/AC/build/
  security/dependency/conflict/integration checklist, merge-queue
  integration (delegate enforcement to branch protection + CI),
  intelligent merge ordering, conflict-resolution proposals (semantic
  conflicts escalate), dependent-ticket reevaluation on each merge.
- **Release Center**: `Release`/`ReleaseRevision`/`ReleaseFeature`/
  `ReleaseTicket`/`ReleaseManifest`/`ReleaseArtifact`/`Deployment`/
  `FeatureExposure`/`ReleaseApproval`/`ReleaseNote`/`ReleaseGateResult`/
  `CorrectionTicket`/`ReleaseOutcome`/`Retrospective` entities; target
  vs actual release per ticket; immutable manifests (multi-service
  digests); invariant set incl. "merge only when source control
  confirms", "manifest can't change silently", "availability needs
  evidence", "AI suggestion never mutates approved scope".
- **Release notes**: three audiences (customer / stakeholder / technical)
  from one verified manifest; drafts only describe actually-available
  functionality; unpublished until human-approved.
- **Ticket completion notes**: structured fields (summary, files,
  verification, review history, deploy considerations, traceability) —
  evidence-sourced, human-correctable.
- **Improvement Center**: KPI-vs-goal measurement (baseline/target/
  observed), AI retrospectives distinguishing outcomes from hypotheses
  ("insufficient evidence" over invented scores), proposals routed back
  to idea boards; DORA-style delivery metrics.
- AI worker split (deterministic orchestration vs LLM): Merge Advisor,
  Conflict Investigator, Implementation Summarizer, Release Planner,
  Scope Auditor, Release Notes Writer, Release Risk Analyst,
  Retrospective Analyst — event-driven (`CodeMerged`, `ReleaseApproved`,
  `DeploymentEvidenceReceived`, …), idempotent consumers.
- Acceptance-criteria IDs sketched (MERGE-01..04, DOC-01, REL-01..05,
  DEL-01..03, POST-01/02) — port to SCHEMAS when scheduled.
- Backlog: Release Diff Explorer, Release Surprise Detector, Release
  Forecasting, Customer Acceptance Package, Delivery Audit Timeline.
- **Readiness ≠ risk**: deterministic Release Readiness (mandatory
  conditions) stays separate from evidence-based Delivery Risk; neither
  collapses into one score. Rollback/recovery plan required where risk
  warrants even though Veto tracks rather than performs deployments.
- **Delivery Commitment** entity — planned ≠ committed ≠ implemented ≠
  verified ≠ delivered; versioned commitment records scope, target,
  success criteria, exclusions, assumptions, accountable owner.

### 15.7 Ticket taxonomy & feature workspace

- **Work type × origin × relationships** are separate dimensions:
  types `story|bug|technical|spike|security|infrastructure|data|
  documentation|quality`; origins `rs|board|review|incident|ai-finding|
  manual`; relations implements/fixes/blocks/belongs-to/follows.
- Per-type intake flows + completion evidence (bug = expected/actual,
  repro, logs → repro test + verified fix; spike = question + timebox →
  findings). Policy-driven workflow, not hardcoded per type.
- **Bug ≠ scope change**: restoring approved behavior is a defect fix;
  new capability rides the board/ChangeSet path. Intake AI splits mixed
  requests.
- **Engineers create bugs/tech/spikes directly; stories originate from
  approved requirements or board proposals.** Priority ≠ severity.
- Universal **Ticket Workbench** — common fields + per-type tabs
  (repro/telemetry for bugs, findings for spikes, migration checks for
  data, ACs+design for stories).
- **Feature = epic** (confirmed): Feature Workspace, 6 tabs —
  Overview/Requirements (multi-RS links, one primary)/Design/Tickets/
  Quality(AC evidence)/Release; Feature Health (explainable findings,
  no opaque score), Feature Timeline, Feature Acceptance Package,
  "Ask About This Feature" scoped assistant. Ticket completion alone
  never completes a feature.
- Ticket AI: classification, dup/overlap detection, dependency
  discovery, splitting, context builder, readiness validation, scope
  monitoring, type-specific test plans, work assignment, change-impact
  reevaluation, implementation notes, release association.

### 15.8 Review Studio enhancements

- **Semantic review comments**: type (`defect|requirement-gap|security|
  architecture|improvement|question|preference|out-of-scope|praise`) ×
  disposition (`must-fix|suggestion|question|informational`); AI
  interprets against code/TDD/ADRs/standards. A comment is an
  instruction, not unlimited authorization — out-of-scope requests route
  to change control.
- **Findings ≠ discussion threads**: finding lifecycle Open → Triaged →
  In Remediation → Ready for Verification → Resolved (+ terminal
  dispositions: accepted-risk/not-applicable/duplicate/deferred-with-
  approval). AI may propose resolution; never self-resolves a blocking
  human finding.
- **Approvals bind to commit SHA + spec baseline**: post-approval code
  change → stale-approval policy, "Changes Since Your Review" delta
  view, re-approval when reviewed behavior changes.
- **Requirement-first review mode** alongside code-first: pick an AC →
  see implementing code + its test evidence.
- Reviewer ergonomics: risk-ordered files, delta-only re-review,
  generated-file collapsing, per-file progress tracking, one-click test
  evidence, five actions (Approve / Comment / Request AI Fix / Request
  Changes / **Send to Idea Board**).
- **Security is a review dimension**, not just a scanner verdict:
  categories (access control, injection, secrets, data exposure…),
  per-finding fields (category, severity, confidence, evidence, asset,
  exposure, policy violated, remediation, status, verification),
  risk-tiered enforcement (critical → block merge/release), and security
  review starts at design time (threat modeling in TDD), not only at PR.
- **GitHub remains authoritative** for PR state/checks/merge; internal
  approvals never masquerade as GitHub approvals; finding↔thread
  mappings are explicit and idempotent.

### 15.9 Discovery & Interview Engine (wizard internals)

One **Interview Orchestrator** powers all wizards (Solution creation,
idea discovery, Solution Brief, RS, UI/UX, TDD, feature planning, ticket
refinement, repo onboarding, release planning, + short contextual ones).

- **Context-first, questions second**: assemble existing knowledge →
  identify gaps → ask only what materially changes the outcome. "The
  best question is the one the wizard realizes it doesn't need."
- **Knowledge slots**: versioned wizard config declares required
  knowledge areas; slot states `known|inferred|missing|conflicted|
  not-applicable|deferred`; deterministic eligibility, AI proposes the
  question (impact × uncertainty × relevance + answerability + effort);
  the system may conclude "user can't answer" → route/record/mark
  unresolved instead of re-asking.
- **Atomic semantic extraction**: answers → statements with preserved
  original text, source span, scope, authority, relations — never paraphrased
  away. Negations/qualifiers must survive (eval-gated).
- **Understanding Panel**: live view of confirmed/inferred/unresolved/
  decision-required — corrections happen during discovery, not at the
  generated document.
- **Three input modes** (conversation / guided choices / bulk paste-
  upload), switchable without loss; one answer may satisfy many slots.
- **Multi-stakeholder branching**: one discovery workspace, specialist
  interview branches routed by role; merged statements keep who-said-
  what; disagreement → decision item, not silent merge.
- **Deterministic orchestration / LLM assist split**: permissions,
  session state, slot requirements, approvals, schema validation, stop
  conditions are application-owned; LLM interprets/proposes/drafts.
  Never generate a next question before the last answer is durably
  persisted.
- **Two thresholds**: draft-ready vs approval-ready are separate gates.
- **Resumption**: durable snapshots + knowledge-version diff briefing on
  resume ("what changed since you left").
- Evaluation: extraction precision/recall, negation preservation,
  repeat-question rate, unnecessary-question rate, unsupported-assertion
  rate in artifacts (**target zero unsupported binding requirements**),
  material-conflict detection, cost per accepted artifact.
- 11 in-chat decisions recorded: risk-based confirmation; scoped
  knowledge (org/solution/initiative/feature/repo) with controlled
  promotion; event-driven freshness + change-impact propagation;
  policy-aware conflict resolution; adaptive questioning over versioned
  knowledge requirements; atomic extraction; dependency-aware
  reconciliation; one workspace + specialist branches; versioned
  summaries + hybrid retrieval; evidence-backed generation; snapshot
  resumption.
- Five shared engines named: Semantic Understanding, Context
  Intelligence (= evidence plane), Interview Orchestrator, Artifact
  Composition, Delivery Assurance. Logical modules, not services.

### 15.10 Process machinery & other features

- **DoR/DoD engines**: configurable evidence checklists per ticket
  before `ready` / before merge — extends the existing `ready` contract
  and DoD section into first-class policy objects.
- **Assumption Register**: auto-captured when planning/implementation
  depends on unverified info — owner, affected artifacts, impact-if-
  false, evidence needed, status; high-impact assumptions gate or get
  explicitly risk-accepted.
- **Work Decomposition Engine**: splits consider contracts/ownership/
  dependencies/security/parallel-safety; tickets gain **Execution
  Readiness** + **Parallelization Safety** attributes.
- **Intervention tiers**: routine+authorized → auto; reversible-but-
  consequential → auto within policy + evidence; irreversible/risky/
  unauthorized → explicit approval. Intervention Inbox feeds the
  existing gate inbox (not a second queue).
- **Quality Debt Register**: accepted risk, deferred refactors, security
  exceptions w/ expiry, weak tests, doc gaps — owned, revisit-able,
  consolidatable into modernization initiatives.
- **Process Learning Engine**: org-specific pattern detection (e.g.
  "migration tickets repeatedly need unplanned fixtures") → policy/
  DoR suggestions; guarded by sample size, correlation≠causation,
  human-approved policy changes, no individual scoring.
- **Change Impact Simulator** = the what-if query surfaced at change
  time (overlaps §14.2.2 — keep one implementation).
- **Project/Feature Simulation**: pre-approval strategy comparison
  (speed/balanced/safe) from calibrated history — honest uncertainty
  ranges, no invented confidence.
- **Acceptance Criteria Stress Testing** ("requirement mutation
  testing"): AI varies AC parameters (timeout+1min, duplicate, out-of-
  order…) and checks whether spec/tests cover the variations.
- **Feature memory**: shipped feature → permanent knowledge package
  (problem, requirements, decisions, impl refs, tests, limitations,
  outcomes) for future agents.
- **"Don't build it" recommendation**: when existing capability/
  config already satisfies the request, propose that — aligns platform
  with outcomes, not token burn.
- **Knowledge expiry**: approved docs referencing substantially-changed
  services get flagged for review (ties into survey re-fresh, D27).
- **Competing solution branches**: N provisional designs w/ risks/cost
  before committing to an RS; plus AI stakeholder debate (product/eng/
  security/UX/ops perspectives surface questions humans should weigh).
- **Agent execution previews**: pre-launch file/test/dependency/budget
  estimate with human-set boundaries — extends the implement "go"
  checkpoint (item 33).
- **Test Environment & Data Studio**: declarative test envs — temp DBs,
  synthetic data, fixtures, mocked externals, preview envs — agents
  request environments instead of improvising them.
- **Human takeover**: any in-flight ticket → human mode with context
  package (already exists as handoff; chat adds guided resume).
- **Acceptance Lab / guided UAT**: ephemeral preview of the integrated
  feature, stakeholder clicks through approved journeys, feedback →
  board (not silent scope).
- 6-gate ladder proposed: Discovery → Experience Approval → Dev
  Readiness → Ticket Verification → Integrated Experience → Product
  Acceptance (mostly automated; humans on meaningful decisions) —
  reconcile with `gates` modes (full/plan-package/minimal) before
  adopting.
- Review→board action (§15.8) + post-release→board proposals close the
  "feedback returns to the board" loop.

### 15.11 Conflicts vs ratified decisions — proposed, not adopted

The session's second half pivots the product toward **multi-tenant
cloud SaaS**, which collides with Veto's ratified local-first posture.
These are logged as open strategic questions, not changes:

| Chat direction | Conflicts with | Status |
| --- | --- | --- |
| Go modular monolith | D1 (TS/Node ratified, mid-build) | **Rejected for this codebase** — cataloged for completeness |
| Platform-managed cloud containers/sandbox service | D29/D30/D38 (local engine, local Docker, "never cloud-hosted") | **Design-for-both (ratified)**: local-first runtime ships; schemas/APIs carry `workspace` + nullable `org` so the pivot needs no rewrite |
| Subscriptions + AI credits + org budgets/billing | D32 (design-agnostic, BYOK) | Design-for-both: entities keep org/owner columns; billing itself deferred |
| Teams of 3–50, orgs/roles/RBAC/SSO/SCIM, tenant isolation | D32 beachhead = solo senior IC | Design-for-both: `approver`/`owner`/`actor` fields recorded now; RBAC deferred |
| `Organization → Solution → …` naming | D26/D29 (`project` is the root) | **Adopted** (§15.2); workspace = internal partition key |
| Bidirectional GitHub/Jira sync w/ field ownership | Importers are one-way today | Proposed — note: external edits must arrive as **proposed changes**, never silent baseline mutation |
| Platform-managed model routing + marketplace | `main_model`/`review_model` settings + BYOK | Partially adopted — see 15.12; managed marketplace is SaaS-coupled |
| Customer-managed runners, connector marketplace, enterprise approval designers | — | Deferred outright |

**Merge/release decisions ratified at planning (2026-10-04)**:
Veto executes merges itself (`gh pr merge`/`--auto` once Merge Center's
checklist + GitHub protections are green — D38 never bypasses branch
protection). Deployment confirmation is **manual evidence only** for
MVP (`deployments.evidence.type` reserves webhook/probe). Design
contract: `docs/DELIVERY.md`.

Separately ratified in-chat but compatible: durable workflow
orchestration (Temporal-class) for multi-hour gated runs — evaluate
against the conductor's lease/heartbeat model before adopting;
sandbox-security threat model (untrusted repo code, prompt injection,
egress policy, scoped short-lived git creds) — adopt as requirements
for the container runtime (D30) either way.

### 15.12 Model routing & agent inventory (adopted as direction)

- **Versioned Model Routing Registry**: every AI interaction → primary +
  fallback model, schema requirement, context/token budget, provider
  allowlist, eval threshold. Task↔model assignments live in config, not
  code; pin model+policy per execution (no silent mid-run swap).
  Compatible with BYOK: the registry references configured providers.
- **Latency classes**: `instant` (no LLM on path) / `interactive`
  (TTFT ~1s, streamed, short) / `background` (quality-adjusted cost).
  Wizard UX trick: precompute candidate follow-up questions while the
  user reads; validate rather than regenerate on answer.
- **Cost metric**: `cost per accepted outcome = (inference + retries +
  execution + remediation) / verified accepted outcomes` — not per-call
  price. Chat's provisional OpenRouter lineup for reference only —
  **bake-off-gated**: GPT-5.4 Nano (interactive), GPT-OSS 120B
  (cheap routine), DeepSeek V3.2 (reasoning), MiniMax M2.5 (coding),
  Gemini Flash Lite (multimodal), GPT-5.4 Mini + Claude Haiku
  (escalation/independent review). Strict JSON-schema output +
  `require_parameters`, independent validation, bounded escalation,
  golden-set promotion gates. Embeddings/rerankers = separate bake-off.
- **12 logical agent roles** → ~5 shared components initially: planning,
  coding/testing, review/security, documentation, delivery assurance.
  Policy-driven depth: small change ≠ 12 agents. **Coder and reviewer
  stay different models/families** — self-verification isn't
  verification (already the `review_model` rule).
- Dependability has three axes — output, provider, workflow — measured
  separately per model+provider (p50/p95/p99, TTFT, schema-failure
  rate, cost).

### 15.13 Disposition vs existing contract

Most of §15 rides machinery the contract already owns:
`doc_versions`/`events`/`gate_items` (baselines, ChangeSets, approvals),
semantic layer + evidence plane (statements, retrieval), `serves`/goals
(scope intent), verify→released tail (delivery states), containers +
leases (executions, pinning), `spec_score` machinery (readiness
reports). **New entity families** needed when scheduled: releases + the
15.6 table set, semantic_statements ledger, knowledge_slots/session
snapshots, changesets (or reuse gate_items+doc_versions), assumptions,
quality_debt, delivery_commitments, model_registry config, design
artifacts (component trees). Phase suggestion: statements + ChangeSet +
merge-center hardening → Phase A tail; release entities + review
studio upgrades → Phase B; simulation/portfolio/multi-tenant anything →
Phase C+ or pending the SaaS re-decision in §15.11.
