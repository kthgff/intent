---
schema: 1
id: wp-030
title: Conductor core — tick loop, reconcile, claim, launch, heartbeats
status: done
status: in-progress
priority: high
depth: deep
repos: []
wave: W3
depends_on: [wp-011, wp-021, wp-023]
---

## Description
The babysitter loop (CONDUCTOR.md): ~10s tick + run-exit trigger.
RECONCILE: pull tickets repo (via gitops), refresh projections, sweep
live runs (pid liveness + log mtime → heartbeat; dead → stalled; timeout
→ kill + run_killed), collect exited runs (artifacts → sanitizer →
sentinel → usage → commit → release lease), notifications on
gate/failure events. CLAIM: runnable unit per rules (non-gate
transition, lease free, depends_on merged, spend/token caps unmet,
repo-card verified for repo-exec stages else queue probe run). LAUNCH:
worktrees per ticket_repos, render prompt, spawn detached, register run
row. Run control: kill/pause/resume via signals. Retry ladder (1 same
→ 1 escalation_model → failed). Fencing: lease-or-gitref CAS.

## File ownership
`packages/conductor/src/{loop,reconcile,claim,launch,control}/**`

## Acceptance criteria
- [x] Full tick drives a fixture ticket through one transition end-to-end
- [x] Killed/detached-dead run detected within 2 ticks → stalled → killed
- [x] Lease contention across two conductor instances → one claimer
- [x] Spend cap hit mid-run → kill + blocked reason (dual caps)
- [x] Heartbeat never written by the detached process (conductor-observed)

## Implementation notes (2026-10-03)

- `contracts.ts` is the wp-031 seam: `TransitionHandler.nextStage()`
  (CLAIM query) + `TransitionHandler.onRunComplete()` (RECONCILE
  handoff), plus the `TransitionTools` write surface
  (`applyTicketStatus` — line-preserving frontmatter status write +
  `commitAll` + projection + `status_changed` event;
  `surfaceGateItem` + notification; `appendEvent`; `requestRun` →
  dedup'd `pending` run row). `StubTransitionHandler` is a status→stage
  map until wp-031 lands the real table.
- Spec decisions (TRACKER D15): cumulative per-ticket spend/token
  counters are computed by summing `runs` rows — DB-SCHEMA `tickets`
  has no cost columns; the counters would be pure projection of
  coordination data anyway. Cardless/doc stages launch with the
  tickets-repo checkout as cwd (worktrees are only for
  REPO_EXECUTING_STAGES). `stalled` detection uses log/artifact mtime
  only — `runs.heartbeat_at` is written BY the sweep each tick, so
  including it would mask silence. Run-handle persistence via
  `runs/<id>/handle.json` so a restarted conductor can still signal/
  collect runs it didn't spawn.
- ADAPTERS failure mapping implemented in collect: exit 124 →
  `killed` + `run_killed` (no sentinel handoff); missing/garbage
  sentinel → `failed` + `run_failed` → `retryDecision()` ladder →
  `pending` re-queue or ticket `failed`.
- Fixed upstream dep bug: `adapters/mock/agent.mjs` `hang` scenario
  awaited a ~365-day setTimeout (Node clamps >24.8d to ~1ms) and fell
  through to `exit 2`; now awaits a never-resolving promise.
