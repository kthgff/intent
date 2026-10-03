---
schema: 1
id: wp-052
title: Aider adapter — OpenRouter BYOK, usage stream-parse, pricing table
status: todo
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
- [ ] Spike findings in ADAPTERS.md (real flag names, output format)
- [ ] usage_partial streams mid-run → runs.tokens_* live-update
- [ ] cost_usd = tokens × price table; model missing from table → null + warn
- [ ] Scratch-dir artifact flow verified against wp-023 collector
