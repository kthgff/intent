---
schema: 1
id: wp-051
title: Shepherd — gh poll loop, ci-fix/comment-fix/rebase, merge gate
status: todo
priority: medium
depth: standard
repos: []
wave: W5
depends_on: [wp-050]
---

## Description
Post-PR loop: poll `gh pr checks` + review comments per open PR every
`shepherd.poll_interval_s`; failure → ci-fix run (CI_FAILURE_LOGS,
cycle counter); new comments → comment-fix run; green+quiet → merge
button enabled (never auto-merge); DoD `cmd:` rows execute as verify
tasks before merge enable; shepherd_max_cycles cap → escalate; merged
only when ALL ticket_repos merged → `merged`; revert run path.

## File ownership
`packages/conductor/src/shepherd/**`

## Acceptance criteria
- [ ] gh responses stubbed (fixture JSON) → correct run types queued
- [ ] Cycle cap → escalation, no unbounded loops
- [ ] Multi-repo ticket: mixed pr states → merged iff all merged
- [ ] Merge enable requires: green checks + DoD cmd rows verified + quiet
