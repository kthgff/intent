---
schema: 1
id: wp-021
title: Adapter interface impl — mock backend (scripted sentinels)
status: donepriority: high
depth: standard
repos: []
wave: W2
depends_on: [wp-020]
---

## Description
Implement the `Adapter` contract as a **mock backend** for tests/E2E:
`run()` spawns a real detached child process (a node script) that
writes scripted artifacts to ARTIFACT_TARGETS, optionally emits
usage_partial lines, sleeps a configurable delay (heartbeat coverage),
and prints the scripted sentinel as its last line. Scenario scripting
via env/args: `DONE`, `BLOCKED:`, `NEEDS-INFO:`, garbage-sentinel,
timeout-never-exits, artifact-lint-fail. This is the harness the whole
conductor test-suite runs against — real process semantics, no real LLM.

## File ownership
`packages/adapters/src/{interface-impl,mock}/**` (iface may already
exist in core — this wp is the first concrete impl)

## Acceptance criteria
- [x] RunHandle gives real pid + log_path; control(kill|pause|resume) works
- [x] collect() parses last-non-empty-line sentinel + usage correctly
- [x] Scenario: truncated log mid-run → missing sentinel detected
- [x] Conductor devs can drive the full pipeline with zero API spend

## Implementation notes (2026-10-03)

- `packages/adapters/src/mock/`: `mock.ts` (MockAdapter), `agent.mjs`
  (standalone child script, pure node), `README.md` (scenario DSL +
  usage line format `USAGE {json}` / `USAGE_TOTAL {json}`).
- Scenarios: `done`, `blocked:<r>`, `needs-info:<n>`, `garbage-sentinel`,
  `no-sentinel`, `hang`, `fail-lint`, `usage`, `artifacts:<json>`.
- `MOCK_IGNORE_TERM=1` makes the child ignore SIGTERM (exercises the
  SIGKILL-after-grace path); `MOCK_TIMEOUT_S` self-exits 124.
- Sentinel parse: last non-empty line, `NAME[: payload]` against the
  SENTINELS enum — unknown/malformed → `sentinel: null` (run_failed).
- Scratch-dir semantics honored: `can_write_outside_tree:false` →
  `.sprint-runner/<run-id>/` collected into `ctx.run_dir` + purged.
- Usage absent → `source: estimated` (labeled, never fails the run).

## Blocker

- `Backend` union in `packages/core/src/enums.ts` is `'devin'|'aider'`
  — no `'mock'`. Out of wp scope (core ownership); MockAdapter casts
  `name = 'mock' as Backend`. Logged as TRACKER D14 — core should add
  `'mock'` to `BACKENDS` (and SETTINGS `capabilities:`) when the
  conductor wiring lands.
- Pre-existing lint failure in `packages/cli/src/bin.ts` (committed
  163054e, outside wp-021 ownership): repo-wide `pnpm lint` reports
  6 errors there; `packages/adapters` is clean.
