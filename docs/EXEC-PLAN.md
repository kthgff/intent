# EXEC-PLAN — multi-agent build plan for Veto

Draft 2026-10-03 · companion to `TRACKER.md`.
Goal: maximize parallel agent throughput without interface drift —
the failure mode of multi-agent builds is N agents each inventing the
types the others consume. The plan therefore front-loads a **contract
freeze**, then fans out along a file-ownership map.

## Repository layout (what we're building)

```
intent/
  docs/                 # specs (done) + exec tickets + TRACKER.md
  packages/
    core/               # schemas, types, prompt templates, tokens —
                        # THE CONTRACT. Everything imports from here.
    store/              # Store iface + Postgres driver (PGlite tests, D29) + migrations
    gitops/             # git shell-out: worktrees, branches, code-repo ops (D29 dropped tickets-repo sync/ref-CAS/next-id)
    config/             # layered YAML config + .env + precedence
    prompts/            # renderer: token table, capability shaping
    adapters/           # backend iface + devin/aider/mock impls
    conductor/          # tick loop, reconcile, leases, state machine
    lints/              # spec-lint, coverage matrix, doc validators
    api/                # Fastify REST + SSE surface
    cli/                # `veto` entrypoint (init/daemon/tick)
    ui/                 # React+Vite web app (late wave)
  fixtures/             # fixture code repo + DB seed rows (D29 — no tickets repo)
```

## Wave plan

```
W0 scaffold ──► W0 contracts ──► W1 foundations (3 parallel)
                                     │
        ┌──────────────┬─────────────┼───────────────┐
        ▼              ▼             ▼               ▼
   W2 renderer   W2 adapters    W2 env-ops      (W1 finishes)
        └──────────────┴─────┬─────┘
                             ▼
                    W3 conductor core
                    (state machine + lints in parallel behind it)
                             ▼
                    W4 E2E vertical (mock adapter, fixtures)
                             │
        ┌────────────────┬───┴──────┬────────────┐
        ▼                ▼          ▼            ▼
   W5 review/shepherd  W5 aider  W6 API+import  W7 KB/embeddings
                             │
                             ▼
                    W8 UI (14 screens)

W10 (DB-only migration, D29: wp-090–094) ──► W11 (container runtime,
D30: wp-095–098 — per-subject Docker containers, docker-exec runs,
gate-sleep/teardown, e2e) + W12 (launch/rename)
  ──► W13 (D37 code evidence foundation + product integration)
  ──► W14 (continuous alignment) ──► W15 (telemetry/incident intelligence)
```

Concurrency math: the critical path is W0→W1→W3→W4. Once W1 lands,
**4 agents** can run W2; once the conductor core lands, **4 more** run
W5–W7. Max useful parallelism ≈ 4 sustained; beyond that agents queue
behind `packages/conductor` integration work.

## Multi-agent mechanics

- **Work units** = `docs/exec/wp-*.md`, v1 ticket schema (dogfooding).
  Each wp has: scope, file-ownership map, acceptance criteria, test
  plan, and the interface it codes against.
- **Branches**: `wp/<id>` → PR → `main`. Agents rebase on main before
  opening; `packages/core` changes outside wp-002 require a flagged
  `## Contract change` section in the wp.
- **Serialization points** (one agent at a time): `packages/core`,
  DB migrations file, TRACKER.md rows (own row only).
- **Verification per wp**: `pnpm test` + `pnpm typecheck` + the wp's
  own test plan; E2E fixtures must not regress.
- **Mock adapter (wp-021) is load-bearing**: it emits scripted
  sentinels/artifacts so conductor + E2E tests never need a real agent
  run. It lands before the devin adapter deliberately.

## Agent dispatch order

| Slot | Picks up | Why |
| --- | --- | --- |
| Agent-1 | wp-001 → wp-002 | scaffold + contract freeze — everything waits |
| Agent-2 | wp-010 → wp-020 → wp-021/052 | config → prompts → adapters (same dep chain) |
| Agent-3 | wp-011 → wp-013 → wp-060 | store → projection → API (all DB-shaped) |
| Agent-4 | wp-012 → wp-023 → wp-030/031 | gitops → env-ops → conductor (the spine) |

Then whoever frees first takes W4 (integration) — it must be a single
agent or a pairing, since E2E debugging across 4 contributors thrashes.

### Forward dispatch — W10 onward (2026-10-04)

W10 is a **sequential spine**: wp-090 freezes the v2 contract, and every
downstream wp consumes it. Parallelism resumes only after wp-091 lands.

| Slot | Picks up | Why |
| --- | --- | --- |
| Agent-1 | wp-090 → wp-091 → wp-092 | contract freeze → store → conductor: the critical path, keep it in one head |
| Agent-2 | wp-095 (after wp-091) → wp-096 → wp-097 | container runtime only needs the new Store; parallel to wp-092 |
| Agent-3 | wp-099 (after wp-092) → wp-093 | CLI launch + gitops/importer — splits conductor-adjacent work off Agent-1 |
| Agent-4 | wp-081 (after wp-090) → wp-100 | board UI unblocks on v2 contracts; rename is a sweep, no dep risk |

Then: wp-098 and wp-094 are the two close-out E2Es — **single agent
each**, after their deps (098: wp-097; 094: wp-093). wp-110 waits for
wp-090/091/092 + wp-100; wp-111/112/120 stay sequential per below.

After the launch waves, D37 remains deliberately sequential at its contract
boundaries: wp-110 owns the evidence/index/retrieval contract; wp-111 consumes
it in product stages; wp-112 adds alignment semantics; wp-120 adds the external
telemetry trust boundary. UI/prompt work inside a package may parallelize only
after that package's core/schema changes land.

### Forward dispatch — W16+ addendum program (2026-10-04)

Scope = PRD §14+§15 (everything local-compatible; §15.11 SaaS items
deferred except tenancy-shaped schemas). Design contract for the lead
wave: `docs/DELIVERY.md`. Sequence:

```
wp-130 (regreen fold-in)
   └─► wp-131 (contracts v3 — THE freeze for the whole program)
         └─► wp-132 (vocabulary rename — sweeps docs/UI while engines build)
         ├─► W17 delivery: wp-133 merge → wp-134 releases → wp-135
         │   deploy/exposure/notes/retro → wp-136 API → wp-138 E2E
         ├─► W18 changes: wp-140 changesets → wp-141 baseline pinning
         │   → wp-142 scope radar
         ├─► W19 discovery: wp-143 statements → wp-144 boards +
         │   wp-145 orchestrator → wp-146 understanding → wp-139 import
         ├─► W20 review/design: wp-148 findings → wp-150 security;
         │   wp-149 mockups (parallel, different packages)
         ├─► W21 taxonomy/machinery: wp-151 types → wp-152 feature ws +
         │   wp-153 registers → wp-154 decomposition
         └─► W22 models: wp-155 routing → wp-156 eval; wp-157 test-env
W23 close-out: wp-158 discovery E2E → wp-159 docs reconcile + full green
```

wp-110/111/112/120 (D37) interleave with W19/W20 — wp-110 needs wp-131
contracts; its evidence tables already exist in 0001.

Agent slots (max useful parallelism ≈ 6 here — conductor package is the
chokepoint; serialize its file map as noted in each wp):

| Slot | Picks up | Why |
| --- | --- | --- |
| Agent-1 | wp-130 → wp-131 | spine: green base, then the contract freeze |
| Agent-2 | wp-133 → wp-134 → wp-135 → wp-136 | delivery engine — owns shepherd/merge/release |
| Agent-3 | wp-140 → wp-141 → wp-142 | change control — owns conductor/changes, launch baseline |
| Agent-4 | wp-143 → wp-144 → wp-145 → wp-146 → wp-139 | discovery — owns semantics + interview pkgs |
| Agent-5 | wp-148 → wp-150 → wp-151 → wp-152 → wp-153 → wp-154 | review/taxonomy/machinery |
| Agent-6 | wp-132 → wp-137 → wp-147 → wp-149-UI | UI + rename sweep — codes against API contracts |
| Agent-7 | wp-155 → wp-156 → wp-157 | models/eval — light footprint, late deps |
| Agent-8 | wp-138 → wp-158 → wp-159 | E2E close-outs, sequential by design |

Coordination rules for this program: `packages/conductor` is claimed by
exactly one lane at a time per subdir (file maps enforce); `packages/api`
routes land per-wp but `server.ts` edits serialize behind whichever lane
is in flight (rebase, don't stack); all UI lanes mock the API contract
rather than waiting on it.

## Backport rule

Every wp that encounters an underspecified contract (spec-lint rules,
fingerprint formula, devin export shape, aider flags) must write the
resolution into the relevant spec doc in the same PR — the docs and
code never diverge again. TRACKER.md decision log gets a row.

## What is deliberately NOT parallelized

- `packages/core` after wp-002 — edits go through PRs against landed
  types, not side-channel changes.
- The E2E vertical (wp-040) — sequential by design.
- Migration numbering — sequential `NNNN_*.sql`, assigned by whoever
  lands first; conflicts resolved by renumber, not merge.
