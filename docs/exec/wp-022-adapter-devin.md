---
schema: 1
id: wp-022
title: Devin adapter — devin -p spawn, export parse, usage extraction
status: donepriority: medium
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
- [x] Spike findings committed to ADAPTERS.md before impl
- [x] collect() produces valid usage.json (SCHEMAS §13) — from a
  defensive export parser; REAL export schema unknown (devin auth
  absent on spike machine — see ADAPTERS.md findings). Re-verify with
  a live export when auth exists.
- [x] Sentinel from stdout tail, not export — per contract
- [x] Missing binary → clean error at adapter init, not mid-run

## Notes (contract-gap resolutions)
- `run()` has no run_dir param → resolved as: explicit 4th arg →
  run_dir stashed from the preceding prepare() → constructor
  `opts.runDir`. Conductor calls prepare→run per run, so the stash
  path is the normal flow.
- `RunResult.artifacts` = paths relative to run_dir (recursive).
- `usage.ticket` — CollectContext carries no ticket id; adapter takes
  `opts.ticket`, else ''. Conductor should pass it or post-fill.
- `exit_code` from the in-process child handle; unknown pid → null;
  watchdog timeout → 124 (failure-mapping table).
- Also fixed a pre-existing biome failure in packages/cli/src/bin.ts
  (switch fallthrough + line length) so `pnpm lint` is green.
