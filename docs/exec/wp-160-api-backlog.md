---
schema: 1
id: wp-160
title: API/store backlog sweep — first-PRD leftovers
status: todo
priority: medium
depth: standard
repos: []
wave: W23
depends_on: [wp-131]
---

## Description
Bundle of small follow-ups recorded in TRACKER that predate the
addendum wave. Each is self-contained; implement all:

1. `GET /tickets/<ref>/review` — return the latest `review.json`
   run_artifact for the ticket (404 when absent). Closes the S-08 gap
   recorded in D19.
2. `import/run.ts` `surfaceFailure` currently writes gate rows
   directly — route it through `deps.notify` like every other
   failure path.
3. `POST /workspaces` persists to `config.yaml` (config package
   write path), not just in-memory.
4. `/metrics`: compute `deviation_rate` + `human_minutes` (gate dwell)
   per PRD formulas — schema fields already exist.
5. `gate_items.snoozed_until` column + `/inbox` response field for
   S-01 snooze (D20). Amend `0001_init.sql` in place (still
   pre-release); snooze mutation endpoint per API.md conventions.
6. `run_output` SSE producer: conductor tails the active run's
   `run.log` and emits chunks on the existing SSE channel (bounded
   buffer, no unbounded memory).

## File ownership
`packages/api/src/**`, `packages/conductor/src/{loop,import}/**`,
`packages/store/migrations/pg/0001_init.sql`, `packages/store/src/**`,
`packages/config/src/**`, `docs/API.md`, `docs/DB-SCHEMA.md`

## Acceptance criteria
- [ ] All six items implemented; each has at least one test
- [ ] Follow-up rows removed from TRACKER backlog table
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
`gate_items.snoozed_until` column — flagged per EXEC-PLAN rule 2.
