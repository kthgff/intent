---
schema: 1
id: wp-094
title: E2E re-green — fixtures as seed rows, full suite green on DB-only truth
status: done
priority: high
depth: standard
repos: []
wave: W10
depends_on: [wp-093]
---

## Description
Re-green the entire suite on the DB-only architecture (D29). Fixture
layout changes: the tickets-repo fixture is **deleted**; ticket/board/
initiative/feature fixtures become SQL/seed-row fixtures loaded
through the Store (or a seed helper against PGlite). The fixture
*code* repo stays a real git repo. Rerun the wp-040 vertical —
import→triage→…→commit with the mock adapter — proving the same
sentinel/artifact chain survives the storage migration. Kill every
remaining sqlite/events.jsonl/markdown-docs assumption in tests.
This is deliberately sequential: E2E debugging across multiple
contributors thrashes (EXEC-PLAN). Also run a real-Docker-Postgres
E2E pass per ARCHITECTURE §10 (not just PGlite) where the daemon is
available — record coverage in the PR; absent daemon skips cleanly.

## File ownership
`fixtures/**`, `packages/*/test/**`, `pnpm-workspace` scripts if a
seed command is added

## Acceptance criteria
- [ ] No test references the tickets-repo fixture or events.jsonl
- [ ] Mock-adapter vertical green end-to-end on Postgres/PGlite rows
- [ ] `pnpm typecheck && pnpm test && pnpm lint` all green — the D29 close-out gate
- [ ] TRACKER rows for wp-090–094 updated; any spec gaps hit during the re-green backported to docs per the backport rule
- [ ] Real-Postgres E2E result recorded (run or clean-skip)

## Contract change
None.
