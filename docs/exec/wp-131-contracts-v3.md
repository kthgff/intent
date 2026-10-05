---
schema: 1
id: wp-131
title: Contracts v3 — enums, schemas, 0001 amendments, Store signatures for the addendum wave
status: done
priority: high
depth: deep
repos: []
wave: W16
depends_on: [wp-130]
---

## Description
Contract freeze for the whole addendum program — every downstream wp
codes against these. In `packages/core`: new enums (release statuses,
deployment/env, exposure states, changeset statuses/classifications,
statement intent/polarity/strength/status, knowledge-slot states,
review finding types/dispositions/lifecycle, ticket work types +
origins, assumption/debt/commitment statuses, routing latency classes),
zod schemas mirroring DB-SCHEMA additions, new doc kinds (`rs.md`,
`solution-brief.md`, `vs.md`, `retro.md`, `notes-*.md`, `mockup.json`,
`briefing.json`). In `migrations/pg/0001_init.sql` (pre-release — amend
in place): all new tables — releases set (§3 of DELIVERY.md),
`changesets`/`changeset_items`, `semantic_statements` family,
`interview_sessions`/`knowledge_slots`/`session_snapshots` family,
`review_sessions`/`review_findings`/`review_decisions`, `assumptions`,
`quality_debt`, `delivery_commitments`, `tickets.work_type`/`origin`/
`execution_readiness`/`parallel_safety` cols, `runs.request.baseline`
shape. `Store` iface: CRUD + query signatures for every new table.
All entities carry `workspace` + nullable `org` (design-for-both).

## File ownership
`packages/core/**`, `packages/store/migrations/pg/0001_init.sql`,
`packages/store/src/store.ts` (iface), `docs/DB-SCHEMA.md`,
`docs/SCHEMAS.md`, `docs/DELIVERY.md` (cross-check)

## Acceptance criteria
- [ ] Every addendum entity family has enum + zod schema + table + Store sig
- [ ] 0001_init.sql applies cleanly on fresh PGlite; checksum recorded
- [ ] DB-SCHEMA.md + SCHEMAS.md updated in the same change (backport rule)
- [ ] `pnpm typecheck` green; downstream packages unchanged compile

## Contract change
This IS the contract change — flagged per EXEC-PLAN rule 2.
