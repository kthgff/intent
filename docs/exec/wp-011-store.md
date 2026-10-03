---
schema: 1
id: wp-011
title: Store — Store interface + SQLite impl + migrations
status: todo
priority: high
depth: standard
repos: []
wave: W1
depends_on: [wp-002]
---

## Description
Implement the `Store` interface from wp-002 against DB-SCHEMA.md using
better-sqlite3: migrations (`0001_init.sql` upward, sequential),
leases with TTL + fencing tokens, claims, runs registry, tickets/
ticket_repos projections (upsert-from-projection API), events_idx
append + replay helper, gate_items, notifications, presence, dossiers/
entities/relations/embeddings tables (embeddings columns present even
if feature off). WAL mode, single-writer discipline documented.

## File ownership
`packages/store/**`, `packages/store/migrations/**`

## Acceptance criteria
- [ ] All DB-SCHEMA tables exist; `schema_meta` tracks version
- [ ] Lease acquire is atomic (INSERT OR fail), expiry sweep works
- [ ] events_idx replay: drop + rebuild from an events.jsonl fixture
- [ ] Concurrency test: two Store instances, contested lease → one winner
- [ ] Postgres-shaped API (no sqlite-isms in the interface surface)
