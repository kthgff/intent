# Veto — agent guide

Governance layer for agent-authored code. Specs live in `docs/` —
**PRD.md is the product contract; ARCHITECTURE.md, CONDUCTOR.md, SCHEMAS.md,
SETTINGS.md, ADAPTERS.md, API.md, DB-SCHEMA.md are binding.** Code must
implement the specs, not reinterpret them.

## Build / verify

```bash
pnpm install        # requires Node >=22, pnpm 10 (corepack)
pnpm typecheck      # tsc -b across all packages
pnpm test           # vitest, per package
pnpm lint           # biome check
```

All four must be green before opening a PR.

## Conventions

- ESM, TypeScript strict, NodeNext module resolution. Import workspace
  deps as `@veto/<pkg>` (pnpm workspaces).
- `packages/core` is the contract layer — schemas, enums, prompt
  templates, interfaces. Changes here ripple everywhere; a work package
  may only touch core if its ticket says so.
- Shell out to real `git` — never isomorphic-git.
- Fail-closed everywhere: malformed structured output blocks the
  pipeline rather than guessing.
- Secrets never enter code/config — `.env` only, never logged.
- Spec gaps: resolve, implement, AND backport the decision into the
  relevant `docs/*.md` in the same change (see TRACKER.md decision log).

## External dependencies (PATH)

Required at runtime: `git`, `gitleaks` (fail-closed sanitizer — absent =
hard error), `gh` (PR/shepherd ops), `docker` (D30 container runtime —
absent daemon = hard error for `runtime: container` backends).
Backend CLIs `devin` and `aider`
are per-config — detect at startup, error cleanly if the configured
backend is missing. Detected state on this machine (2026-10-03): git ✓,
gh ✓; gitleaks ✗, aider ✗, docker ✓ (20.10.22, 2026-10-04), devin via
Devin.app bundle only
(`/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`).

## Work packages

`docs/exec/wp-*.md` — v1-schema tickets. `docs/TRACKER.md` is the live
status board; update your own row when done.
