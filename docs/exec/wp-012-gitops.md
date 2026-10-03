---
schema: 1
id: wp-012
title: Git ops — tickets-repo sync, worktrees, ref-CAS, next-id
status: todo
priority: high
depth: standard
repos: []
wave: W1
depends_on: [wp-002]
---

## Description
Shell-out git layer (no isomorphic-git): clone/pull `--rebase` with
pull-rebase-retry; commit+push helpers with actor identity; worktree
create/remove under `<repo>.worktrees/<id>`; `refs/locks/<subject>-<stage>`
and `refs/locks/claims/<subject>-<gate>` CAS push with JSON
{holder,acquired_at,expires_at} + expiry sweep on each pull (CONDUCTOR
special paths); `next-id` reservation (`.sprint-runner/next-id` commit
CAS); `.sprint-runner/` gitignore injection on worktree create
(ADAPTERS).

## File ownership
`packages/gitops/**`

## Acceptance criteria
- [ ] pullRebase() retries on non-fast-forward push rejection (test w/ local remotes)
- [ ] ref CAS: two contenders → exactly one wins (test)
- [ ] next-id: concurrent reservations get distinct SR-NNNN (test)
- [ ] worktree lifecycle: create → exists → remove cleans branch+dir
- [ ] All ops run against real git binaries in tmp dirs — no mocks
