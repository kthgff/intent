---
schema: 1
id: wp-001
title: Scaffold pnpm workspace, toolchain, CI
status: done
priority: high
depth: light
repos: []
wave: W0
---

## Description
Bootstrap the monorepo per EXEC-PLAN.md layout: pnpm workspace with
`packages/*` dirs, root tsconfig (ESM, strict), vitest, eslint/prettier
(or biome — pick one, document in package.json), GitHub Actions CI
(typecheck + test + lint on PR). Node ≥22. Empty package stubs for all
planned packages so later agents have targets.

## File ownership
`package.json`, `pnpm-workspace.yaml`, `tsconfig*`, `.github/`,
`packages/*/package.json` (stubs only), `.gitignore`, `AGENTS.md`

## Acceptance criteria
- [ ] `pnpm install && pnpm typecheck && pnpm test && pnpm lint` green
- [ ] CI workflow file valid and passing
- [ ] AGENTS.md documents build/test commands for future agents
- [ ] No business logic — stubs only
