---
schema: 1
id: wp-138
title: Delivery E2E — merge → release → deployment → retro vertical on mock adapter
status: done
priority: high
depth: standard
repos: []
wave: W17
depends_on: [wp-133, wp-134, wp-135, wp-136]
---

## Description
Close-out E2E for W17: fixture repo + mock `gh` responses drive a
ticket through review → merge (checklist green, `gh pr merge` stub,
SHA confirm) → release creation → manifest freeze → approval →
manual deployment evidence → exposure → retro run → proposal on the
board. Cover the fail-closed paths: unapproved manifest release,
deployment without evidence, exposure without deployment, partial
release without `approved_by`, material correction ticket blocking.
Single-agent package (E2E thrashes across contributors).

## File ownership
`packages/conductor/test/**`, `packages/api/test/**`, `fixtures/**`

## Acceptance criteria
- [x] Full merge→released vertical green on PGlite
- [x] Every §4 invariant has a failing-path test
- [x] `pnpm typecheck && pnpm test && pnpm lint` green

## Contract change
None.
