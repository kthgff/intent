---
schema: 1
id: wp-098
title: Container E2E — fixture repo, in-container stage chain, kill/pause/sweep coverage
status: todo
priority: high
depth: standard
repos: []
wave: W11
depends_on: [wp-097]
---

## Description
D30: prove the containerized run path end-to-end. Fixture code repo +
a container-capable backend (mock adapter running inside the container
if aider's image/flags are still unverified — the runtime is what's
under test, not the model) executes a real stage chain: worktree create
→ container ensure → exec run → sentinel → artifact collect →
transition → gate-sleep → wake → teardown. Coverage: kill mid-run
(container stops, worktree preserved, status stays for retry), pause/
resume (work frozen, timeout ticking), orphan sweep after simulated
conductor crash, multi-repo ticket (two worktree mounts, one
container), repo-set growth recreate. macOS Docker Desktop caveat
noted: bind-mount performance on large repos — document observed
timings; named-volume fallback stays a follow-up if painful.

## File ownership
`fixtures/**`, `packages/conductor` (e2e test files only)

## Acceptance criteria
- [ ] Full chain runs in-container on the fixture repo; `pnpm test` + `pnpm typecheck` green
- [ ] Kill/pause/teardown/sweep/multi-mount cases covered by tests
- [ ] No container, volume, or worktree residue after suite teardown
- [ ] Bind-mount timing notes + volume-fallback decision recorded in TRACKER follow-ups if needed

## Blocker
None expected — gated on wp-097. If the real aider image can't run on
the test machine (no license/network), mock-in-container is the
documented substitute; aider real-run verification remains the wp-052
open item.
