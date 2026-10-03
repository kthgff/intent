---
schema: 1
id: wp-030
title: Conductor core — tick loop, reconcile, claim, launch, heartbeats
status: todo
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
- [ ] Full tick drives a fixture ticket through one transition end-to-end
- [ ] Killed/detached-dead run detected within 2 ticks → stalled → killed
- [ ] Lease contention across two conductor instances → one claimer
- [ ] Spend cap hit mid-run → kill + blocked reason (dual caps)
- [ ] Heartbeat never written by the detached process (conductor-observed)
