---
schema: 1
id: wp-159
title: Wave close-out — docs reconciliation + full suite green + TRACKER update
status: todo
priority: high
depth: standard
repos: []
wave: W23
depends_on: [wp-138, wp-142, wp-147, wp-150, wp-152, wp-153, wp-154, wp-156, wp-157, wp-158]
---

## Description
Final gate for the addendum wave: reconcile every touched spec
(DB-SCHEMA, SCHEMAS, API, CONDUCTOR, SETTINGS, UI-INVENTORY,
INTELLIGENCE, DELIVERY, PRD §15 dispositions → mark landed items),
verify no §15.11-deferred scope leaked in (no billing/RBAC/cloud-
sandbox code paths), run the complete suite (`pnpm typecheck &&
pnpm test && pnpm lint`) on PGlite + real-Postgres where available,
and update all TRACKER rows. Any spec gap hit during the wave must
already be backported — this wp verifies rather than discovers.

## File ownership
`docs/**`, `packages/*/test/**`

## Acceptance criteria
- [ ] All specs consistent with landed code (spot-audit per domain)
- [ ] No deferred-scope implementation present
- [ ] Full suite green; real-Postgres pass recorded
- [ ] TRACKER: every wave row `done` or explicitly `cut` w/ reason

## Contract change
None.
