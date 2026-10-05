---
schema: 1
id: wp-148
title: Review Studio semantics — findings lifecycle, semantic comments, commit-bound approval
status: done
priority: high
depth: deep
repos: []
wave: W20
depends_on: [wp-131]
---

## Description
PRD §15.8. `review_sessions`/`review_revisions`/`review_findings`/
`review_comments`/`review_decisions`/`finding_resolutions`/
`review_evidence_links`/`external_review_mappings` (wp-131). Findings
are entities, not threads: lifecycle `open → triaged → in-remediation
→ ready-for-verification → resolved` (+ `accepted-risk`,
`not-applicable`, `duplicate`, `deferred-with-approval` — permissioned,
rationale required). Semantic comment types (`defect|requirement-gap|
security|architecture|improvement|question|preference|out-of-scope|
praise`) × disposition (`must-fix|suggestion|question|informational`) —
AI proposes the classification; comments are instructions, not
unlimited authorization: `out-of-scope` content routes to a ChangeSet
(wp-140). Approvals bind to head SHA + spec baseline; new commits →
stale-approval + "Changes Since Your Review" delta (server-side diff
from reviewed SHA). AI proposes resolution, never self-resolves a
blocking human finding. Requirement-first review mode: AC →
implementing code + test evidence (uses relations + run_artifacts).
GitHub remains authoritative — internal approvals never pose as GH
approvals; finding↔thread mappings idempotent.

## File ownership
`packages/conductor/src/review/**` (new), `packages/store/src/pg.ts`,
`packages/api` review routes, `packages/core` review schemas

## Acceptance criteria
- [ ] Finding lifecycle + terminal dispositions with rationale/permissions
- [ ] Stale-approval on new commits + delta view
- [ ] Out-of-scope comments produce ChangeSets, not code changes
- [ ] Requirement-first view resolves AC→code→evidence
- [ ] `pnpm test` green

## Contract change
None beyond wp-131.
