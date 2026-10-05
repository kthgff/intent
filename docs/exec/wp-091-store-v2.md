---
schema: 1
id: wp-091
title: Store v2 — postgres.js implementation, PGlite test path, new migrations
status: todo
priority: high
depth: standard
repos: []
wave: W10
depends_on: [wp-090]
---

## Description
Replace the SQLite store with the Postgres implementation per
DB-SCHEMA + wp-090 contracts: `postgres.js` driver (the only
production SQL client), sequential `NNNN_*.sql` migrations covering
every v2 table (`projects`, `boards`, `board_items`, `initiatives`,
`features`, `doc_versions`, `events`, `run_artifacts`, plus reworked
`tickets`/`gate_items`/`runs`/`containers`-ready columns and the
`next_*_seq` counters), checksum-recorded in `schema_meta`.
Transactions explicit: a unit-of-work object passed to multi-repo
commands (ARCHITECTURE §5.2). Repositories return domain/read-model
types, never driver rows. **Delete `sqlite.ts`** and all better-sqlite3
deps — DB-only ratified, no dual backend. Tests run the *same* impl
against PGlite (test-only; never a production fallback — ARCHITECTURE
§2.2). Id allocation via `next_*_seq` UPDATE…RETURNING, atomic.
`leases` stay in Postgres (TTL + fencing) — `leases_via` is gone.

## File ownership
`packages/store/**`, `packages/store/migrations/**`, `package.json`
(drop better-sqlite3, add postgres + @electric-sql/pglite dev-dep)

## Acceptance criteria
- [ ] Every DB-SCHEMA v2 table exists via numbered migrations; `schema_meta` tracks version + checksum
- [ ] PGlite integration tests green for every repository (same impl, no sqlite-specific code path)
- [ ] `next_*_seq` allocation is atomic under concurrent inserts (contention test)
- [ ] Lease acquire atomic (INSERT ON CONFLICT / fail), expiry sweep works
- [ ] events append is insert-only; doc_versions is insert-only (immutability constraint or test-enforced)
- [ ] better-sqlite3 fully removed from deps and imports; `pnpm typecheck && pnpm test` green for store

## Contract change
None expected — implements wp-090. If the Store surface needs
adjustment, flag `## Contract change` and backport to DB-SCHEMA.md.
