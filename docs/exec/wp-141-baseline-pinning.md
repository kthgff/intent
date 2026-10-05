---
schema: 1
id: wp-141
title: Run baseline pinning + mid-run reconciliation (running-agent change policy)
status: todo
priority: high
depth: deep
repos: []
wave: W18
depends_on: [wp-131, wp-140]
---

## Description
PRD §15.5 baseline pinning: every run records
`runs.request.baseline = {rs_version, ticket_rev, design_rev, ac_ids[],
base_sha}` at launch (extends the existing `runs.request` persistence,
D40). On ChangeSet approval touching a run's subject: unaffected runs
continue; small affected changes → pause at next checkpoint
(`docker pause` for container runs), reconcile prompt context +
ACs/tests, resume with a `baseline_reconciled` event; substantial →
preserve branch/worktree, stop further work, spawn a revised plan
(replan flow, D27). Agents NEVER silently adopt the newer spec —
the launch path always resolves the pinned baseline, not "latest".
Multi-ticket ChangeSets reconcile as one coordinated set (single
decision, per-run effects).

## File ownership
`packages/conductor/src/launch/**`, `packages/conductor/src/changes/**`,
`packages/conductor/src/reconcile/**`, `packages/core` baseline schema

## Acceptance criteria
- [ ] Every run row carries a complete pinned baseline
- [ ] ChangeSet→affected-run fan-out implements the 3-way policy
- [ ] No code path resolves "latest" doc version inside a running agent
- [ ] Tests: continue/pause-reconcile/stop-replan branches covered

## Contract change
`runs.request.baseline` shape — landed in wp-131 schema.
