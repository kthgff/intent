---
schema: 1
id: wp-098
title: Container E2E — fixture repo, in-container stage chain, kill/pause/sweep coverage
status: done
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
- [x] Full chain runs in-container on the fixture repo; `pnpm test` + `pnpm typecheck` green
- [x] Kill/pause/teardown/sweep/multi-mount cases covered by tests
- [x] No container, volume, or worktree residue after suite teardown
- [x] Bind-mount timing notes + volume-fallback decision recorded in TRACKER follow-ups if needed

## Implementation notes (2026-10-06)

Backend under test: `ContainerScriptedAdapter` — a container-capable
mock (`runtime: 'container'`) that `docker cp`s the wp-040 scripted
agent (`test/helpers/mock-agent.mjs`) into the subject container once,
then runs each stage via `docker exec -w <worktree>`. The agent gained
a `waitFor` script key (poll a path before emitting the sentinel) so
pause/resume is test-driven, not raced.

Suite: `test/container-conductor.test.ts` — 10 tests, all real-daemon
(`veto/agent:latest` when built locally, else `node:22-alpine`):
launch ensure + `runs.container_id`, cardless host-side, reconcile
lifecycle (gate-sleep/teardown/liveness), bootstrap fail-closed +
sweep, full chain (worktree → exec → sentinel → collect → transition
→ gate-sleep → wake → teardown), kill-mid-run + same-container retry,
pause freeze + resume + absolute timeout clock, orphan sweep,
multi-repo single container, repo-set growth recreate.

Fixes the suite surfaced (D45): scratch-ancestor purge for slashed run
ids; explicit `control(kill)` joins the retry ladder; the orphan sweep
is workspace-scoped (shared-daemon isolation); MockAdapter's run.log
moved inside the scratch leaf.

Timing notes (Docker Desktop, macOS arm64, veto/agent image warm):
image boot ~0.6-4s, full chain to gate ~2-13s, whole file ~40-70s
unloaded. Bind mounts were never painful on the fixture — named-volume
fallback stays a follow-up only if real repos prove slow. The docker
daemon itself was the suite's biggest flake source (a wedged daemon
made `docker cp`/`rm` stall for tens of seconds); the tests now bound
every wait by time and unpause before forced removal in cleanup.

## Blocker
None expected — gated on wp-097. If the real aider image can't run on
the test machine (no license/network), mock-in-container is the
documented substitute; aider real-run verification remains the wp-052
open item.
