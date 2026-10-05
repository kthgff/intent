---
schema: 1
id: wp-133
title: Merge Center — readiness checklist + Veto-executed merge + post-merge bookkeeping
status: todo
priority: high
depth: deep
repos: []
wave: W17
depends_on: [wp-131]
---

## Description
Implement DELIVERY.md §2. Shepherd's `ci-watch` tail becomes Merge
Center: a deterministic readiness evaluator per `ticket_repos` row
(commit-bound approval freshness, unresolved deviations, AC evidence,
checks, security findings, `depends_on` satisfied by
`merged|verifying|released`, `git merge-tree` conflict probe, branch
protection via `gh pr view`), then **execution**: `gh pr merge
--<merge_strategy>` (`--auto` when the repo runs a merge queue — enqueue
counts as executed; confirmation arrives on the next shepherd poll).
Confirm merged SHA → `ticket_repos.merged_sha`, `merged` status + event
with `{sha, pr_url}`. FIFO ordering by readiness; `depends_on`
re-evaluated on each merge event; conflicts → `merge_conflict` gate +
`rebase` run (never force-push). Post-merge: implementation-note
doc_version append, feature-evidence recalc, `merge_ready`/
`merge_attempted`/`merge_conflict`/`merged` events + SSE. New
`RunnerTask {kind:'merge'}` in the existing runner-task lane.

## File ownership
`packages/conductor/src/shepherd/**`, `packages/conductor/src/launch/**`
(runner task), `packages/conductor/src/merge/**` (new), `packages/core`
merge enums only if not landed in wp-131

## Acceptance criteria
- [ ] Merge executes via `gh` only when checklist + protections green
- [ ] Merge-queue repos enqueue (`--auto`) and confirm on poll
- [ ] Conflict → gate item + rebase run; no auto force-push
- [ ] merged_sha + pr_url + implementation-note append recorded atomically
- [ ] Mock-`gh` tests cover green/conflict/queue/approval-stale paths

## Contract change
None beyond wp-131 types.
