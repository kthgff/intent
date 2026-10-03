---
schema: 1
id: wp-050
title: Review pipeline — 4-pass merge, fingerprints, fix rounds, discuss
status: done
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
- [x] Pass merge: dedupes via fingerprint, assigns stable thread_ids
- [x] Rounds: blocker/major → fix run; clean-or-minor → gate; cap honored
- [x] reopened findings on re-review share thread_id with original
- [x] Dismissal cap breach escalates the whole batch

## Implementation notes (2026-10-05)

- Delivered `packages/conductor/src/review/`: `mergePasses`,
  `planReviewRound`, `reReview`, `applyFixResults`, `discussReply`
  (+ `parseFixesPayload`, `dismissalClaimsFromDeviations` helpers).
- Provenance: deduped findings carry an additive `passes: []` list and
  merged evidence tagged `[pass]` (schema superset — zod strips the
  extra key on parse; SCHEMAS §6 left the field unlisted). The wp-031
  `mergeFindingsPass` was extended to record the same provenance.
- Round-cap reading: fix run allowed while `round <= auto_fix_rounds`
  (matches the wp-031 handler; `auto_fix_rounds: 2` → up to two fix
  rounds per PRD "capped at ~2").
- `reReview` missing-in-new-scan → `fixed`, but only when all four
  REVIEW_PASSES reported that round; partial rounds keep `open`.
  `dismissed`/`wontfix` never self-reopen (human-settled).
- Fix dismissal cap: claims parsed from DEVIATIONS.md
  `| finding f-xxxx | not fixed | not a real issue |` rows (fix.md
  template rule 2); first `fix_dismissal_cap` honored, over-cap claims
  stay `open` and a `fix-dismissal-breach` escalation gate item is
  surfaced while the verify→re-review round still proceeds.
- `f-xxxx` thread_id collisions resolve with `-2`/`-3` (SCHEMAS §6).
