/**
 * review/plan.ts — severity-gated round planning (wp-050; PRD §7.3,
 * SETTINGS `review.auto_fix_*`).
 *
 *   - Any `open`/`reopened` finding at an auto-fix severity AND the
 *     round cap not yet reached → 'fix-run'.
 *   - Only minor/nit/question (or nothing) left → 'gate' — minors go to
 *     the Issues tab for human triage; a clean review still requires
 *     the human approve stamp, never auto-approves.
 *
 * Active statuses are `open` and `reopened`: a reopened thread is a
 * regression — it re-enters the fix loop like any open finding. Fixed,
 * dismissed, and wontfix threads are settled and never gate the plan.
 *
 * Round-cap reading: `review.round` counts completed review rounds and
 * equals the number of fix rounds consumed so far; the cap allows a
 * fix run while `round <= auto_fix_rounds` (auto_fix_rounds: 2 → up to
 * two fix rounds, matching PRD "capped at ~2" and the wp-031 handler).
 */
import type { ReviewRoundConfig } from './types.js';

export type ReviewRoundPlan = 'fix-run' | 'gate';

const ACTIVE = new Set(['open', 'reopened']);

/** Findings still requiring action — open or reopened. Structural
 *  `unknown` fields: accepts both typed ReviewFinding rows and the
 *  loosely-typed review.json envelope the handler reads back. */
export function activeFindings<
  F extends { status?: unknown; severity?: unknown },
>(findings: F[]): F[] {
  return findings.filter((f) => ACTIVE.has(String(f.status)));
}

export function planReviewRound(
  review: {
    round: number;
    findings: { status?: unknown; severity?: unknown }[];
  },
  config: ReviewRoundConfig,
): ReviewRoundPlan {
  const active = activeFindings(review.findings);
  if (active.length === 0) return 'gate';
  const want = new Set(config.auto_fix_severities);
  const blocking = active.some((f) => want.has(String(f.severity)));
  return blocking && review.round <= config.auto_fix_rounds
    ? 'fix-run'
    : 'gate';
}
