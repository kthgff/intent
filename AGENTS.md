# sprint-runner — agent guide

Governance layer for agent-authored code. Specs live in `docs/` —
**PRD.md is the product contract; CONDUCTOR.md, SCHEMAS.md, SETTINGS.md,
ADAPTERS.md, API.md, DB-SCHEMA.md are binding.** Code must implement the
specs, not reinterpret them.

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
  deps as `@sprint-runner/<pkg>` (pnpm workspaces).
- `packages/core` is the contract layer — schemas, enums, prompt
  templates, interfaces. Changes here ripple everywhere; a work package
  may only touch core if its ticket says so.
- Shell out to real `git` — never isomorphic-git.
- Fail-closed everywhere: malformed structured output blocks the
  pipeline rather than guessing.
- Secrets never enter code/config — `.env` only, never logged.
- Spec gaps: resolve, implement, AND backport the decision into the
  relevant `docs/*.md` in the same change (see TRACKER.md decision log).

## Work packages

`docs/exec/wp-*.md` — v1-schema tickets. `docs/TRACKER.md` is the live
status board; update your own row when done.
