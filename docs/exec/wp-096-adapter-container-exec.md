---
schema: 1
id: wp-096
title: Aider-in-container — docker exec run/control, usage streaming, secrets injection
status: todo
priority: high
depth: standard
repos: []
wave: W11
depends_on: [wp-095, wp-092]
---

## Description
D30: the aider adapter gets `runtime: container` as its default. `run()`
becomes `docker exec -w <worktree> -e <secret-env>` inside the subject's
container (prepared by wp-095 `ensure`); stdout/stderr stream to
`run_dir` logs exactly like a spawned process — sentinel parse, usage
stream-parse, and artifact collect are runtime-agnostic and must NOT be
duplicated. `control()` maps kill → `docker kill --signal=TERM` grace →
`docker kill`, pause → `docker pause`, resume → `docker unpause`.
Secrets (`OPENROUTER_API_KEY`) injected via exec env — names only in
argv, never values; no gh/git credentials inside the container
(`has_gh: false` stands — push/PR stays runner-owned on the host).
`runtime: process` remains selectable for aider; `devin` adapter
unchanged (host process + `--sandbox`).

## File ownership
`packages/adapters/src/aider/**`, `packages/core` (`runtime` on adapter iface
if not landed in wp-095), `docs/ADAPTERS.md` (spike/verification notes)

## Acceptance criteria
- [ ] `run()` issues `docker exec` when runtime=container; identical rendered prompt, log capture, sentinel contract
- [ ] usage_partial streams from exec stdout → `runs.tokens_*` live-update (same parser as process path — no fork)
- [ ] kill/pause/resume → docker semantics; `paused` run status + events unchanged
- [ ] Secret env injection: `-e NAME` passthrough, value never in argv/logs
- [ ] `runtime: process` still works end-to-end for aider

## Blocker
None expected — aider must exist INSIDE `containers.image` (wp-095).
Real-flag verification caveat from wp-052 still applies on first live run.
