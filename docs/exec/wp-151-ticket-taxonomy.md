---
schema: 1
id: wp-151
title: Ticket taxonomy — work types, origins, per-type intake + Ticket Workbench fields
status: todo
priority: high
depth: standard
repos: []
wave: W21
depends_on: [wp-131]
---

## Description
PRD §15.7. `tickets.work_type` (`story|bug|technical|spike|security|
infrastructure|data|documentation|quality`) × `origin` (`rs|board|
review|incident|ai-finding|correction|manual`) — separate dimensions
(wp-131 cols). Per-type intake: interview question sets + required
completion evidence per type (bug = expected/actual/repro → repro test
+ verified fix; spike = question + timebox → findings doc). Policy-
driven workflows, not hardcoded per type. **Bug ≠ scope change**:
intake detects "restore approved behavior" (bug, direct create) vs
"new capability" (route to board/ChangeSet); mixed requests split with
a proposal. Direct creation allowed for bug/technical/spike/
operational; stories originate from approved RS/board proposals.
Priority ≠ severity (`severity` col on bugs/incidents). Ticket
Workbench: common fields + per-type tabs (repro/telemetry for bugs,
findings for spikes, migration checks for data, ACs+design for stories).

## File ownership
`packages/core` ticket schemas/enums, `packages/store/src/pg.ts`,
`packages/api` intake + classification routes, `packages/ui` workbench
tab variants, `packages/conductor` intake classification stage

## Acceptance criteria
- [ ] Work-type × origin captured on every ticket incl. imports
- [ ] Per-type intake + completion evidence enforced by policy
- [ ] Bug-vs-scope split produces a proposal, not silent scope
- [ ] Direct-create rules enforced (stories need approved scope)
- [ ] Workbench renders per-type tabs

## Contract change
None beyond wp-131.
