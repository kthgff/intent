# EXEC-PLAN — multi-agent build plan for sprint-runner

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
    store/              # Store iface + SQLite driver + migrations
    gitops/             # git shell-out: sync, worktrees, ref-CAS, next-id
    config/             # layered YAML config + .env + precedence
    prompts/            # renderer: token table, capability shaping
    adapters/           # backend iface + devin/aider/mock impls
    conductor/          # tick loop, reconcile, leases, state machine
    lints/              # spec-lint, coverage matrix, doc validators
    api/                # Fastify REST + SSE surface
    cli/                # `sprint-runner` entrypoint (init/daemon/tick)
    ui/                 # React+Vite web app (late wave)
  fixtures/             # synthetic tickets repo + code repo for tests
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
