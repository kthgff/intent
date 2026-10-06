---
schema: 1
id: wp-142
title: Scope Creep Radar — scope metrics, budgets, escalation
status: done
priority: medium
depth: standard
repos: []
wave: W18
depends_on: [wp-140, wp-134]
---

## Description
PRD §15.5 radar: computed metrics surface (not a score) — scope added
vs removed per release/RS baseline, post-approval change count, rework
events (re-review rounds, `changes-requested` loops), affected running
executions, cumulative estimate drift vs baseline, release-commitment
impact (delivery_commitments when wp-153 lands). Scope budgets:
config `scope_budgets:` thresholds (cost/schedule/scope %) — crossing
escalates the ChangeSet to a higher-approval gate. Owner-scoped
notifications only. Radar feeds both the ChangeSet decision view and
the Release Center header.

## File ownership
`packages/conductor/src/changes/radar.ts`, `packages/api` radar route,
`packages/ui` radar widget on Release Center + ChangeSet views

## Acceptance criteria
- [x] All radar metrics computed from events/versions — explainable, no opaque score
- [x] Budget thresholds escalate correctly
- [x] Notifications reach only affected artifact owners
- [x] `pnpm test` green

## Contract change
None.
