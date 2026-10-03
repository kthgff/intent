/**
 * review/ — the wp-050 review pipeline: 4-pass merge with runner-side
 * fingerprints/thread_ids, severity-gated round planning, re-review
 * thread lifecycle, fix dismissal cap, discuss replies.
 */
export {
  discussReply,
  type DiscussArgs,
  type DiscussOutcome,
} from './discuss.js';
export {
  type FixApplyResult,
  type FixReport,
  applyFixResults,
  dismissalClaimsFromDeviations,
  parseFixesPayload,
} from './fix.js';
export {
  SEVERITY_RANK,
  createFinding,
  findingInput,
  freshThreadId,
  mergeOne,
  mergePasses,
  orderedPasses,
} from './merge.js';
export {
  type ReviewRoundPlan,
  activeFindings,
  planReviewRound,
} from './plan.js';
export { type ReReviewResult, reReview } from './rereview.js';
export type {
  FindingsByPass,
  ReviewDocument,
  ReviewFinding,
  ReviewRoundConfig,
  StoredFingerprint,
} from './types.js';
