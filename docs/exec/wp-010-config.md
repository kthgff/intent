---
schema: 1
id: wp-010
title: Config layer — layered YAML + .env + precedence
status: done
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
- [x] Precedence: frontmatter > tickets-repo > global > defaults (tests)
- [x] Unknown keys → error listing valid paths; secrets only via .env
- [x] Defaults match SETTINGS.md literally (timeouts, budgets, etc.)
- [x] `ui.remote_access: true` → warning surfaced in resolved config

## Blocker

None blocking; spec ambiguities resolved conservatively:

- **Frontmatter → config mapping**: SETTINGS only names `model:` →
  `main_model`. Implemented `model`→`main_model`, `backend`→`backend`,
  `depth`→`spec_depth`, plus pass-through of any other key matching a
  valid config path; ticket metadata keys (id/status/repos/…) ignored.
- **`timeouts`/`capabilities` defaults**: core `ConfigSchema` defaults
  these to `{}` while SETTINGS lists literal values. `resolveConfig`
  merges SETTINGS-literal `DEFAULT_TIMEOUTS` / `DEFAULT_CAPABILITIES`
  underneath user values so the effective config matches SETTINGS.
- **`schema: 1`**: required literal in `ConfigSchema`; injected at
  resolve time so layers/frontmatter needn't repeat it (still enforced
  as 1 when present).
- **Unknown keys**: treated as errors (fail-closed, per AGENTS.md),
  with messages listing valid dotted paths.
- **`ui.token_file` / importer `token_env` defaults**: filled from
  SETTINGS literals when unset.
