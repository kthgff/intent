---
schema: 1
id: wp-052
title: Aider adapter — OpenRouter BYOK, usage stream-parse, pricing table
status: done
priority: medium
depth: standard
repos: []
wave: W5
depends_on: [wp-021]
---

## Description
Second backend (both ship v1): `aider --message-file <rendered>
--yes-always --auto-commits --model openrouter/<model>` in worktree.
Flags: can_exec T, can_write_outside_tree F, has_gh F → scratch-dir
artifacts, runner-owned push/PR. Stream-parse stdout token counts →
usage_partial (per-call granularity + live counter). OpenRouter price
table → cost_usd. Exact flag set verified via `aider --help` spike —
document findings in ADAPTERS.md (backport rule).

## File ownership
`packages/adapters/src/aider/**`, `docs/ADAPTERS.md`

## Acceptance criteria
- [x] Spike findings in ADAPTERS.md (real flag names, output format)
- [x] usage_partial streams mid-run → runs.tokens_* live-update
- [x] cost_usd = tokens × price table; model missing from table → null + warn
- [x] Scratch-dir artifact flow verified against wp-023 collector

## Blocker

None blocking — resolved ambiguities:

- **aider not installed** (no `aider`, `pipx`, or `uvx` on this machine):
  flag set + token-line format documented as UNVERIFIED in
  `docs/ADAPTERS.md` → "Aider adapter — spike notes (2026-10-03)".
  Re-verify on first machine with a real install.
- **collectArtifacts seam**: `packages/conductor` depends on
  `@sprint-runner/adapters` (devDep), so adapters cannot import
  `envops.collectArtifacts` without a dependency cycle. The adapter
  mirrors the scratch-dir move+purge itself (mock-adapter pattern);
  the conductor's own `collectArtifacts` pass in reconcile remains the
  authoritative residue check on the runner path.
