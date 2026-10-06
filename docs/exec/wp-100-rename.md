---
schema: 1
id: wp-100
title: Rename — sprint-runner → veto across binary, config, packages, containers, docs
status: done
priority: medium
depth: light
repos: []
wave: W12
depends_on: [wp-095, wp-099]
---

## Description
D31/D35: product renamed to **veto** (display name **Veto**; tagline
"Agents propose. Humans veto."). Mechanical pass, no behavior change:

- Binary: `sprint-runner` → `veto` (package.json `bin`; `veto daemon`,
  `veto add` for capture — the ratified CLI verb).
- Config: `~/.config/sprint-runner/` → `~/.config/veto/` (config.yaml,
  .env, ui-token); one-time migrate-or-symlink note for existing installs
  (there are none in the wild — just document the path).
- Packages: `@sprint-runner/<pkg>` → `@veto/<pkg>` (workspace imports
  + pnpm-workspace rename).
- Containers (D30): names `sr-<ws>-<subject>` → `veto-<ws>-<subject>`;
  image `sprint-runner/agent` → `veto/agent`; labels
  `sprint-runner/managed` → `veto/managed`; SETTINGS comments.
- UI strings: `localStorage["intent.theme"]` → `veto.theme` (+ migrate
  the stored key); "Intent is working" → "Veto is working"; `Revise
  with Intent` → `Revise with Veto`.
- Docs sweep: `sprint-runner`/`sprint_runner` refs in docs/*.md,
  AGENTS.md, prompt templates, fixtures, `.sprint-runner/` scratch-dir
  convention → `.veto/` (ARTIFACT_TARGETS). Historical decision-log
  entries (D31 et al.) and dated review docs stay as the record.
- Keep: `run-tickets.sh` v0 prototype is historical; sprints/2026-10
  fixtures stay (v0 docs label them).

## File ownership
Everything mechanical: `package.json`, `pnpm-workspace.yaml`,
`packages/*/package.json`, `packages/**/src`, `docker/Dockerfile.agent`,
`docs/**`, `AGENTS.md`, `fixtures/**`, `.github/**`

## Acceptance criteria
- [x] `rg -i "sprint.?runner"` returns only v0-prototype/changelog-history hits
- [x] `veto daemon` boots + serves UI; `pnpm typecheck` + `pnpm test` green after rename
- [x] Container/image/label names updated in code AND docs (grep both)
- [x] TRACKER wave table + this row updated

## Blocker
None — ordered after wp-095 + wp-099 so container naming and the binary
name land once each, not twice.
