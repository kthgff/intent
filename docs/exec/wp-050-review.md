---
schema: 1
id: wp-050
title: Review pipeline — 4-pass merge, fingerprints, fix rounds, discuss
status: in-progress
priority: medium
depth: deep
repos: []
wave: W5
depends_on: [wp-031]
---

## Description
Post-implement review machinery: 4 review passes (correctness,
security, spec-compliance, test-gap) run per review-base+passes
prompts → merge findings-*.json into review.json (runner computes
fingerprints + thread_ids); severity-gated fix loop ≤auto_fix_rounds
(blocker/major auto-fix; minor/nit/question → changes-requested gate);
finding lifecycle open→fixed→reopened→dismissed→wontfix across rounds;
fix dismissal cap → escalate all; discuss runs on human notes.

## File ownership
`packages/conductor/src/review/**`

## Acceptance criteria
- [ ] Pass merge: dedupes via fingerprint, assigns stable thread_ids
- [ ] Rounds: blocker/major → fix run; clean-or-minor → gate; cap honored
- [ ] reopened findings on re-review share thread_id with original
- [ ] Dismissal cap breach escalates the whole batch
