---
schema: 1
id: wp-092
title: Conductor rewire — events/doc_versions/run_artifacts to DB, seq id alloc
status: done
priority: high
depth: standard
repos: []
wave: W10
depends_on: [wp-091]
---

## Description
Rewire the conductor to the DB-only truth (D29): **events** — drop
events.jsonl append + LOG.md regeneration + events_idx replay; all
state transitions append `events` rows inside the same transaction as
the row change (ARCHITECTURE §4.4 transactional write rule).
**run_artifacts** — structured stage output (sentinels, review.json,
usage, fingerprints) goes to `run_artifacts` rows; `run_dir` keeps
only transcripts/logs as files. **doc_versions** — every persisted
doc change (ticket.md, prd.md, tdd.md, test.md, feature docs) writes
an immutable version row; nothing markdown-on-disk remains a source
of truth. **id allocation** — `next_*_seq` from `projects` replaces
ref-CAS/git next-id. Leases/claims/heartbeats stay but now sit on the
Postgres lease impl from wp-091. Reconcile + stalled detection keep
current semantics (log/artifact mtime — D15) reading the new stores.
Gate items: `verify` kind + `snoozed_until` handled through the state
machine.

## File ownership
`packages/conductor/**` (delete `events` jsonl writer, LOG.md regen,
doc-file writers; keep run_dir transcript writers)

## Acceptance criteria
- [ ] No `.jsonl` event append or LOG.md regen code path remains; `grep`-able proof
- [ ] Stage completion writes structured output to `run_artifacts` and the transition + event in one transaction
- [ ] Every doc mutation produces a `doc_versions` row; doc history readable via store query
- [ ] New ticket/board/initiative/feature ids allocated via `next_*_seq`; no ref-CAS calls
- [ ] Reconcile + stalled semantics preserved against new stores (existing tests migrated, not weakened)

## Contract change
None expected — consumes wp-090/091 surfaces.
