---
schema: 1
id: wp-090
title: Core contracts v2 — hierarchy, doc_versions, events, run_artifacts, config
status: todo
priority: high
depth: standard
repos: []
wave: W10
depends_on: []
---

## Description
D29 contract freeze for the DB-only migration — the same role wp-002
played for v1. Port the ratified D29 schema into `packages/core`
(zod): `projects` (workspace = internal key, `next_*_seq` counters),
`boards`, `board_items` (board NULL = capture tray, `serves` edges D33,
`snoozed_until` D20), `initiatives`, `features`, `doc_versions`
(immutable document history — all docs as text versions, no markdown
on disk), `events` (append-only, replaces events.jsonl/events_idx),
`run_artifacts` (structured stage output; `run_dir` = transcripts/logs
only). Ticket status enum gains `verifying`/`verify_failed`/
`released`/`discarded` (D27); `gate_items` kind gains `verify`.
Config schema: `storage_url` → postgres connection; **drop**
`tickets_repos` and `leases_via` (DB-only). Update `Store` interface
signature set in core to the v2 surface wp-091 will implement
(repositories for every new aggregate; remove tickets-repo projection
upsert, ref-CAS next-id). This is the contract freeze — downstream
wps must not invent types.

## File ownership
`packages/core/**` only

## Acceptance criteria
- [ ] All D29/D33/D20/D27 schemas + enums parse; fixtures for every new row type
- [ ] `Store` v2 interface compiles; v1-only methods (projection upsert, ref-CAS, leases_via) removed or marked for wp-091 deletion
- [ ] Config schema: `storage_url` required; `tickets_repos`/`leases_via` rejected with a migration hint in the error
- [ ] `pnpm typecheck` green; packages that break on the new surface are expected — that's wp-091/092's job, not this ticket's
- [ ] Backport: SCHEMAS.md/DB-SCHEMA.md/SETTINGS.md updated in the same PR where resolution differed from spec (backport rule)

## Contract change
This ticket **is** the contract change (like wp-002). Everything it
touches is flagged by definition.
