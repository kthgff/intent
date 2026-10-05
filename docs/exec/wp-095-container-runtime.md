---
schema: 1
id: wp-095
title: Container runtime — docker client, per-subject container lifecycle, base image
status: todo
priority: high
depth: standard
repos: []
wave: W11
depends_on: [wp-091]
---

## Description
D30: stage runs for container-capable backends execute inside one
persistent Docker container per subject. This wp builds the runtime
substrate: a docker client (shell out to `docker` CLI — same rule as
git/gh, never a library binding), the `containers` table +
`runs.container_id` migration, and the lifecycle ops the conductor
calls: `ensure(subject)` (create-if-absent, start-if-stopped,
recreate-if-mount-set-changed), `sleep(subject)` (docker stop),
`wake`, `teardown` (rm + row → removed), `sweepOrphans()` at conductor
start (label `veto/managed=true` with no live row or terminal
subject → rm). Container named `veto-<workspace>-<subject-slug>`,
labels `veto/managed=true` +
`veto/subject=<ws>/<subject>`, bind-mounts every
`ticket_repos` worktree at its identical absolute path,
`--cpus`/`--memory` from `containers.cpu`/`containers.memory`.
Base image `containers.image` (git, gh, aider, node/python/go
runtimes) — Dockerfile in `packages/conductor/docker/` or a top-level
`docker/` dir; build/pull at conductor start, absent daemon or image
→ hard startup error for container backends (detect-at-startup rule,
same as gitleaks).

## File ownership
`packages/conductor/src/envops/containers.ts` (new), `docker/Dockerfile.agent` (new),
`packages/store` (migration: `containers` table, `runs.container_id`),
`packages/core` (`containers:` settings schema + `runtime` enum — flag in ticket)

## Acceptance criteria
- [ ] `containers` migration: table + `runs.container_id` per DB-SCHEMA
- [ ] ensure/sleep/wake/teardown/sweepOrphans against a real docker daemon (integration test, skipped cleanly when daemon absent)
- [ ] Recreate picks up a grown `ticket_repos` mount set
- [ ] Orphan sweep removes managed containers with terminal/missing subjects only — never unmanaged docker containers
- [ ] Startup detection: daemon absent → clean error naming the backend(s) that need it; `runtime: process` installs unaffected

## Contract change
`packages/core`: `containers` settings block (image/cpu/memory/runtime/stop_on_gate) + `runtime: 'container'|'process'` on backend capability config — per D30.
