---
schema: 1
id: wp-023
title: Runner env-ops — gitleaks sanitizer, verify tasks, artifact collect
status: in-progress
priority: high
depth: standard
repos: []
wave: W2
depends_on: [wp-012]
---

## Description
Runner-owned environment steps (the trust boundary):
- **Sanitizer**: run `security.scanner` (gitleaks default) over staged
  artifacts before every tickets-repo commit — fail-closed: a scan
  error OR finding blocks commit + surfaces a repair gate item.
  Binary absent = error at startup check.
- **Verify tasks**: execute repo-card `test`/`lint`/`build` in a
  worktree as detached processes registered in `runs` (subject
  `verify:<ticket>:<repo>`), produce `test-report.json` (SCHEMAS §10)
  incl. `case:`-marker grep for `implemented` booleans.
- **Artifact collection**: gather per ARTIFACT_TARGETS — absolute
  runs dir, or worktree `.sprint-runner/<id>/` scratch → move to
  runs dir + purge scratch.

## File ownership
`packages/conductor/src/envops/**` or `packages/gitops/src/envops/**`

## Acceptance criteria
- [ ] gitleaks finding on fixture artifact → commit blocked + gate item
- [ ] verify task produces valid test-report.json; case: markers detected
- [ ] Scratch-dir collection leaves zero diff residue in worktree
- [ ] Timeouts enforced; killed verify task → runs row `killed`
