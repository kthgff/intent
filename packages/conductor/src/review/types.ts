/**
 * review/types.ts — shared shapes for the review pipeline (wp-050).
 *
 * The stored review.json document is the core `Review` envelope with two
 * runner-side relaxations the schema text in SCHEMAS §6 already implies:
 *
 *   - `fingerprint.line_range` may be `null` — line-less findings (file-
 *      or repo-level concerns) fingerprint fine via text_hash but have
 *      no range to match on. `matchThread` treats null ranges as
 *      "cannot range-match", which is the behavior we want.
 *   - `findings[].passes` — additive provenance: which specialist
 *      passes flagged the thread. The zod schema strips unknown keys on
 *      parse, so this never breaks validation; it rides the JSON for
 *      the Issues tab and for merge observability.
 */
import type {
  AgentFinding,
  Finding,
  Review,
  ReviewPass,
} from '@sprint-runner/core';
import type { Fingerprint } from '@sprint-runner/lints';

/** Fingerprint as stored — lints' nullable `line_range`, plus the
 *  optional `symbol` slot SCHEMAS §6 reserves (runner-derived; null
 *  when no repo map is available). */
export interface StoredFingerprint extends Fingerprint {
  symbol?: string | null;
}

/** A review.json finding: core Finding + pass provenance. */
export interface ReviewFinding extends Omit<Finding, 'fingerprint'> {
  fingerprint: StoredFingerprint;
  /** Specialist passes that have flagged this thread (dedupe
   *  provenance — merge evidence also tags the pass on later joins). */
  passes: string[];
}

/** review.json as the pipeline manipulates it. */
export interface ReviewDocument extends Omit<Review, 'findings'> {
  findings: ReviewFinding[];
}

/** `findings-<pass>.json` fragments keyed by pass name. Keys outside
 *  REVIEW_PASSES are tolerated (a custom/extra pass still merges). */
export type FindingsByPass = Partial<
  Record<ReviewPass | string, AgentFinding[]>
>;

/** Slice of settings the round planner reads (SETTINGS.md `review:`). */
export interface ReviewRoundConfig {
  auto_fix_severities: string[];
  auto_fix_rounds: number;
}
