/**
 * review/rereview.ts — re-review round merge (wp-050; SCHEMAS §6
 * thread lifecycle open → fixed → reopened).
 *
 * After a fix round, ALL specialist passes re-run over the accumulated
 * change (PRD §7.4). New fragments are matched against the prior
 * document's threads via `matchThread` — the same rule as in-round
 * dedupe — so:
 *
 *   - a re-flagged thread keeps its `thread_id`; `rounds_seen` grows;
 *   - a thread the previous round marked `fixed` that reappears becomes
 *     `reopened` (regression detection — same file+category, shifted
 *     lines still match via identical text_hash or ±5 line proximity);
 *   - `dismissed`/`wontfix` threads are human-settled and NEVER reopen
 *     on their own (a re-flagged dismissed thread records the round in
 *     `rounds_seen` + pass provenance but keeps its status — the human
 *     sees the recurrence on the Issues tab without the agent
 *     overruling the triage);
 *   - unmatched new reports create fresh threads;
 *   - threads still `open` that NO pass reported this round → `fixed`
 *     (the fix worked). Choice documented: this "missing → fixed" rule
 *     only applies once every REVIEW_PASSES pass has reported for the
 *     round — a partial round (failed pass) cannot conclude absence,
 *     so those findings stay `open`.
 */
import { REVIEW_PASSES } from '@sprint-runner/core';
import { matchThread } from '@sprint-runner/lints';
import { createFinding, findingInput, orderedPasses } from './merge.js';
import type { FindingsByPass, ReviewDocument, ReviewFinding } from './types.js';

export interface ReReviewResult {
  review: ReviewDocument;
  created: number;
  matched: number;
  reopened: number;
  fixed: number;
}

export function reReview(
  findingsByPass: FindingsByPass,
  prior: ReviewDocument,
  opts: { round: number },
): ReReviewResult {
  const review: ReviewDocument = structuredClone(prior);
  review.round = Math.max(review.round, opts.round);
  const passes = orderedPasses(findingsByPass);
  for (const p of passes) {
    if (!review.passes.includes(p)) review.passes.push(p);
  }

  const seenThreads = new Set<string>();
  let created = 0;
  let matched = 0;
  let reopened = 0;

  for (const pass of passes) {
    for (const f of findingsByPass[pass] ?? []) {
      const input = findingInput(f);
      const hit = matchThread(
        input,
        review.findings.map((e) => ({
          thread_id: e.thread_id,
          fingerprint: e.fingerprint,
        })),
      );
      if (hit !== null) {
        const existing = review.findings.find((e) => e.thread_id === hit) as
          | ReviewFinding
          | undefined;
        if (!existing) continue;
        seenThreads.add(hit);
        matched += 1;
        const seen = existing.rounds_seen ?? [];
        if (!seen.includes(opts.round)) seen.push(opts.round);
        existing.rounds_seen = seen;
        if (!existing.passes.includes(pass)) existing.passes.push(pass);
        if (existing.status === 'fixed') {
          existing.status = 'reopened';
          reopened += 1;
        }
        if (existing.status === 'open' || existing.status === 'reopened') {
          // Fresh evidence/severity for live threads only.
          if (f.evidence) {
            existing.evidence = existing.evidence
              ? `${existing.evidence}\n[${pass} r${opts.round}] ${f.evidence}`
              : `[${pass} r${opts.round}] ${f.evidence}`;
          }
        }
        continue;
      }
      review.findings.push(createFinding(pass, f, opts.round, review.findings));
      created += 1;
    }
  }

  // Missing-in-new-scan → fixed, but only once every spec pass has
  // reported for this round (a partial round can't conclude absence).
  let fixed = 0;
  // Only passes reported THIS round count — a failed pass in a partial
  // round must not let prior-round provenance conclude absence.
  const allReported = REVIEW_PASSES.every((p) => passes.includes(p));
  if (allReported) {
    for (const f of review.findings) {
      if (f.status === 'open' && !seenThreads.has(f.thread_id)) {
        f.status = 'fixed';
        fixed += 1;
      }
    }
  }

  return { review, created, matched, reopened, fixed };
}
