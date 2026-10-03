---
schema: 1
id: wp-051
title: Shepherd — gh poll loop, ci-fix/comment-fix/rebase, merge gate
status: done
status: in-progress
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
- [x] gh responses stubbed (fixture JSON) → correct run types queued
- [x] Cycle cap → escalation, no unbounded loops
- [x] Multi-repo ticket: mixed pr states → merged iff all merged
- [x] Merge enable requires: green checks + DoD cmd rows verified + quiet

## Notes

Delivered `packages/conductor/src/shepherd/`:

- `gh.ts` — `GhClient` interface (prChecks / prView / reviewComments /
  prCreate / prUrlForHead) + `ShellGhClient` shelling `gh` (the
  required PATH dep, same approach as import/github.ts). Review
  comments = `gh api` pulls-comments + issue-comments endpoints merged.
- `poll.ts` — `pollOpenPrs(ctx)`: PR creation (push + `gh pr create`)
  for rows without `pr_url` (covers approved-gate PRs AND revert PRs —
  REVERT-READY lands ci-watch with no pr_url); pr-open → ci-watch when
  checks register; failing checks → `ci-fix` requestRun
  (CI_FAILURE_LOGS/CYCLE/MAX_CYCLES tokens, deduped on live runs AND a
  sha1 fingerprint of the failing-check set — new failures requeue,
  same fingerprint doesn't); new comments → `comment-fix`
  (PR_COMMENTS_JSON); green+quiet → DoD gate → `merge.json` flag;
  `gh pr view` MERGED → pr_state/merged_sha; ALL rows merged →
  `merged` (or `reverted` when a `revert` run finished); ci-watch gate
  cleared on rollup.
- `state.ts` — `tickets/<id>/shepherd.json`: per-repo cycles, failure
  fingerprint, seen comment ids, escalated flag, DoD cmd results
  (durable; DB has no columns for these and is a rebuildable
  projection — Decision D below).
- `dod.ts` — `## Definition of Done` table parser (cmd:/manual/unknown
  rows) + `dod-attestations.json` reader.

Additive edits to conductor internals (all additive, documented):

- `loop/deps.ts`: optional `gh?: GhClient` on `ConductorDeps` (tests
  stub; default `ShellGhClient`).
- `loop/conductor.ts`: `shepherdTick(ctx, {force})` method + per-ws
  poll throttled by `shepherd.poll_interval_s` (0 = every tick);
  `TickReport.shepherd: ShepherdReport[]` added.
- `index.ts`: `export * from './shepherd/index.js'`.

Decisions (spec was silent — resolved, NOT backported to docs/*.md
per ticket instruction):

1. Merge-enable flag lives in `tickets/<id>/merge.json` — DB-SCHEMA is
   binding and `ticket_repos` has no merge_enabled column; the gate
   item schema has no payload field. ci_state 'green' + merge.json
   `enabled: true` is the UI's contract; merge NEVER auto-fires.
2. Manual DoD attestation lives in
   `tickets/<id>/dod-attestations.json` `{attested: [{criterion,
   attested_by, at}]}` — same reasoning; wp-060's UI can write it.
3. DoD `cmd:` rows execute inline in the tick via envops
   `runVerifyTask` with a synthetic repo card ({test: <cmd>}) in the
   PR worktree, registered as `runs` rows (subject `dod:<ticket>`,
   stage `verify`, status done) — conductor-side compute, never
   routed through sentinel dispatch. Failed rows surface a
   `dod-failed` failure gate and are NOT auto-retried.
4. Cycle cap gate is `shepherd-cycle-cap` (kind escalation); the PR
   stops being polled (`escalated` flag in shepherd.json).
5. Cycle counter counts ci-fix runs dispatched per PR (persisted in
   shepherd.json so it survives restarts).
