---
schema: 1
id: wp-031
title: State machine — sentinel→transition table, gate items, events.jsonl
status: todo
priority: high
depth: deep
repos: []
wave: W3
depends_on: [wp-030]
---

## Description
Encode CONDUCTOR.md's full sentinel→transition table as data (not
if-chains): every row — run type, sentinel, action. Actions mutate
ticket frontmatter (status commit), create gate_items, emit
events.jsonl entries (SCHEMAS §7 event names), regenerate LOG.md.
Auto-advance chains incl. the `in-progress` spend-checkpoint exception
and gate modes (full|plan-package|minimal compress which gates fire).
Split materialization, suggestions application, stale-spec check,
needs-info rounds cap (3).

## File ownership
`packages/conductor/src/{transitions,gates,events}/**`

## Acceptance criteria
- [ ] Table-driven: adding a sentinel row changes behavior, no code edit
- [ ] Every event in SCHEMAS §7 enum is emitted somewhere (coverage test)
- [ ] Gate modes produce correct gate_item subsets per config
- [ ] events.jsonl append + LOG.md regeneration are atomic per commit
