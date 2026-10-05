---
schema: 1
id: wp-130
title: Finish conductor test-layer migration — W16 base regreen
status: todo
priority: high
depth: standard
repos: []
wave: W16
depends_on: []
---

## Description
Folds the remainder of wp-094 into this wave: migrate the stale
conductor E2E/unit suite (~4.1k lines) off ticket-repo fixtures onto
Store-seeded rows, `doc_versions`, and `run_artifacts`. Finish
`packages/conductor/test/helpers/fixtures.ts` (DB-only fixture world),
update all call-sites referencing `ticketsRepo`/`remoteDir`/`ticketDir`/
`ledgerFor`/`diskStatus`/sync disposal, and rewrite artifact helpers
(`clearGate` updates the latest matching `run_artifacts` row — bare or
`<subject>/<name>` path). `docStatus` reads ticket docs from the Store.
Rerun the wp-040 vertical on PGlite; real-Docker pass where the daemon
is available. Deliberately sequential — E2E thrashes across contributors.

## File ownership
`packages/conductor/test/**`, `fixtures/**`, shared seed helpers

## Acceptance criteria
- [ ] No test references a tickets-repo fixture or events.jsonl
- [ ] Mock-adapter vertical green end-to-end on PGlite rows
- [ ] `pnpm typecheck && pnpm test && pnpm lint` all green
- [ ] Real-Postgres E2E result recorded (run or clean-skip)
- [ ] TRACKER wp-094 row reflects the completed scope

## Contract change
None.
