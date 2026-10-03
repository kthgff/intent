---
schema: 1
id: wp-010
title: Config layer — layered YAML + .env + precedence
status: in-progress
priority: high
depth: standard
repos: []
wave: W1
depends_on: [wp-002]
---

## Description
Implement SETTINGS.md: load global `~/.config/sprint-runner/config.yaml`,
merge per-tickets-repo `.sprint-runner/config.yaml`, apply frontmatter
overrides at ticket level, load `.env` files (never expose values in
logs). Full zod validation with helpful errors. `actor` required.
Expose `resolveConfig(ticket?) -> EffectiveConfig`.

## File ownership
`packages/config/**`, `packages/config/README.md`

## Acceptance criteria
- [ ] Precedence: frontmatter > tickets-repo > global > defaults (tests)
- [ ] Unknown keys → error listing valid paths; secrets only via .env
- [ ] Defaults match SETTINGS.md literally (timeouts, budgets, etc.)
- [ ] `ui.remote_access: true` → warning surfaced in resolved config
