---
schema: 1
id: wp-099
title: Launch — `veto` CLI wires conductor + serves built UI
status: todo
priority: high
depth: standard
repos: []
wave: W12
depends_on: [wp-092]
---

## Description
The product is currently unlaunchable: `packages/cli` commands print
"not yet implemented" and `GET /` returns a placeholder — the engine is
embeddable but nothing embeds it. Wire the real entrypoint:

- `veto` (no args) / `veto daemon` — boot config +
  store migrations → start conductor loop → serve the built UI dist +
  API on `ui.bind`:`ui.port` behind the token contract. One process,
  one surface (API.md).
- `veto init` — scaffold `~/.config/veto/` (config.yaml,
  .env, ui-token file), detect PATH deps (git, gitleaks, gh, docker,
  backend CLIs) and report, register a project + probe its repos.
- `veto tick` — single reconcile pass, stdout summary (debug
  surface; exits nonzero on reconcile errors).
- `veto status` — queue snapshot: open gate items by kind,
  live runs, containers (D30) — text + `--json`.
- `veto --version` / `doctor` — dep detection report (extends
  init's probe; the `docker` check respects `containers.runtime`).

UI serving: Vite build output bundled in the package (`packages/ui/dist`
→ served static by the API package); dev mode keeps `vite dev` as-is.
Desktop shell (Tauri) stays out — it points at the same surface later.

## File ownership
`packages/cli/**`, `packages/api` (static-serving mount only)

## Acceptance criteria
- [ ] `veto daemon` boots conductor + serves UI at `ui.bind:ui.port`; token enforced on every route incl. SSE + static
- [ ] `init` scaffolds config + detects deps with a readable report; missing required dep → nonzero exit + named remediation
- [ ] `tick`/`status`/`doctor` work against a seeded fixture project
- [ ] Fresh-clone e2e: `init` → `daemon` → UI loads → gate item visible
- [ ] `pnpm test`/`typecheck` green; binary entry declared in package.json `bin`

## Blocker
None — sequencing only: lands on the DB-only conductor (wp-092) so the
entrypoint embeds the final engine, not the about-to-be-rewritten one.
