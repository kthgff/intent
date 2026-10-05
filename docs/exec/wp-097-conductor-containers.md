---
schema: 1
id: wp-097
title: Conductor rewire — container-ensure in LAUNCH, gate-sleep, teardown, docker heartbeats
status: done
priority: high
depth: standard
repos: []
wave: W11
depends_on: [wp-096]
---

## Description
D30: wire the container lifecycle into the conductor loop. LAUNCH gains
a container-ensure step for repo-executing stages on container backends
(create/start/recreate per wp-095; runs record `container_id`). Gate
transitions call `sleep(subject)` (`containers.stop_on_gate`); terminal
statuses call `teardown`. Conductor startup calls `sweepOrphans` after
store init. RECONCILE heartbeats observe `docker inspect` state +
exec'd-process liveness for `runs.container_id` rows in place of pid
checks — dead container mid-run → `stalled`/kill path, container row →
stopped. Cardless doc stages before the first repo-executing stage keep
running host-side (lazy-create rule). Run-control API ops route to
docker verbs for container runs (wp-096) with identical events/status.

## File ownership
`packages/conductor/src/launch/**`, `packages/conductor/src/reconcile/**`,
`packages/conductor/src/control/**`, `packages/conductor/src/loop/**`

## Acceptance criteria
- [ ] Repo-executing launch on aider → container exists + `docker exec`'d run; `runs.container_id` set
- [ ] Ticket → gate status stops its container; next launch restarts it; terminal status removes it
- [ ] Heartbeat: killed/exited container surfaces as dead within ~2 ticks; same stalled/timeout semantics as process runs
- [ ] Cardless stage on a container-less subject stays a host process; container appears at first repo-executing launch
- [ ] Startup sweep removes orphaned managed containers; unmanaged containers untouched

## Blocker
None expected — sequencing: lands on wp-092 (DB-only conductor), not
before; building this on the pre-D29 conductor would rewrite the same
lines twice.
