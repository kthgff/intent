---
schema: 1
id: wp-141
title: Run baseline pinning + mid-run reconciliation (running-agent change policy)
status: done
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
- [x] Every run row carries a complete pinned baseline
- [x] ChangeSet→affected-run fan-out implements the 3-way policy
- [x] No code path resolves "latest" doc version inside a running agent
- [x] Tests: continue/pause-reconcile/stop-replan branches covered

## Implementation
`packages/conductor/src/launch/baseline.ts` pins the baseline: doc heads
(`rs.md`/`prd.md`, `tdd.md`/`mockup.json`, `contract.json`, `ticket.md`)
are resolved to concrete `doc_versions` at pin time (never "latest"),
plus the AC set (parsed from the spec text) and the worktree base SHA.
`queuePendingRun` pins at queue time; `launch` reuses a pending row's
pin verbatim (no retro-edit) and only stamps `base_sha`, else resolves
fresh for ticket-driven claims. Persisted on `runs.request.baseline`
(RunBaselineSchema, wp-131).

`packages/conductor/src/reconcile/baseline.ts` detects mid-run drift
(pinned vs current heads; `ticket.md` frontmatter status churn is not
spec drift) and applies the 3-way policy — `continue` (no drift),
`pause-reconcile` (design/ticket revision), `stop-replan` (RS or
contract moved). Drift surfaces a `baseline-drift` gate item +
`baseline_reconciled` event (old → new versions); the pinned set is
kept, never silently re-baselined. The reconcile sweep runs it for
live runs; `applyChangeset` fans out to affected live runs
(`reconcileAffectedRuns`).

Tests: `packages/conductor/test/baseline.test.ts` (13) — pin-at-launch,
no-retro-edit, drift → gate, `baseline_reconciled` event, all three
policy branches, ChangeSet fan-out.

## Contract change
`runs.request.baseline` shape — landed in wp-131 schema.
