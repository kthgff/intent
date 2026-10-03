---
schema: 1
id: wp-022
title: Devin adapter — devin -p spawn, export parse, usage extraction
status: in-progress
priority: medium
depth: standard
repos: []
wave: W2
depends_on: [wp-021]
---

## Description
Implement the devin backend per ADAPTERS.md: `devin -p <rendered>
--permission-mode <mode> --export <run_dir>/export.json` in the
worktree. FIRST TASK IS A SPIKE: run `devin --help`, inspect a real
`--export` artifact, document actual schema + which usage fields exist
— write findings to ADAPTERS.md (backport rule). Then implement
collect() to parse export → usage.json (run-aggregate granularity,
cost_usd null) + sentinel from log tail. Flag detection:
`devin` on PATH or DEVIN_BIN fallback like run-tickets.sh.

## File ownership
`packages/adapters/src/devin/**`, `docs/ADAPTERS.md` (findings section)

## Acceptance criteria
- [ ] Spike findings committed to ADAPTERS.md before impl
- [ ] collect() produces valid usage.json (SCHEMAS §13) from real export
- [ ] Sentinel from stdout tail, not export — per contract
- [ ] Missing binary → clean error at adapter init, not mid-run
