---
schema: 1
id: wp-020
title: Prompt renderer — token table, ARTIFACT_TARGETS, capability shaping
status: todo
priority: high
depth: standard
repos: []
wave: W2
depends_on: [wp-010]
---

## Description
Render shipped templates with the ADAPTERS.md token table:
`renderPrompt(stage, ctx) -> string`. Every `{{TOKEN}}` resolves or
errors loudly (no silent empties). ARTIFACT_TARGETS renders absolute
`runs/<id>/` when `can_write_outside_tree`, else `.sprint-runner/<id>/`
scratch. CAPABILITY_NOTES injected per flags. DOSSIER renders
"dossier pending" when unsurveyed (depth-gated: light/standard proceed,
deep parks — expose the check as a helper for the conductor).

## File ownership
`packages/prompts/**`

## Acceptance criteria
- [ ] Every prompt in packages/core renders against a full ctx fixture
- [ ] Missing required token → error naming the token + stage
- [ ] Capability matrix test: aider flags → scratch-dir paths in output
- [ ] Render is pure/deterministic — same ctx, same bytes
