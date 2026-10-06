/**
 * release/types.ts — shared shapes for the Release Center (DELIVERY
 * §3–§4, wp-134).
 *
 * The Release Center is a deterministic lifecycle engine over the
 * wp-131 store family — no agent in the loop for state changes; the
 * only agent-adjacent surface is *proposal* (membership suggestions,
 * notes drafts), which can never approve (invariant 6).
 */
import type { TransitionContext } from '../contracts.js';

/** Everything a Release Center operation needs — the same shape the
 *  transition tools are built over (workspace + store + actor +
 *  clock), so API routes and conductor code share one entry point. */
export type ReleaseCtx = TransitionContext;

/** Machine-readable failure codes — API maps them to 4xx/409. */
export type ReleaseErrorCode =
  /** Release / item / parent row not found. */
  | 'not-found'
  /** Transition not allowed from the current status. */
  | 'bad-state'
  /** Item payload invalid (missing ref, empty partial_ac, …). */
  | 'bad-item'
  /** `freeze` on an empty scope. */
  | 'empty-manifest'
  /** `partial_ac` without `approved_by` (invariant 5). */
  | 'partial-unapproved'
  /** An agent tried to approve (invariant 6). */
  | 'ai-approval'
  /** `markReleased` with a failing release gate. */
  | 'gate-failed'
  /** Deployment evidence absent, non-manual, or missing a required
   *  field (DELIVERY invariant 4 — MVP is manual-only). */
  | 'invalid-evidence'
  /** `feature_exposure` state `available` without a linked, confirmed
   *  deployment carrying the feature (DELIVERY invariant 4). */
  | 'no-deployment'
  /** Publish/approve step attempted before its prerequisite — e.g.
   *  `published_at` without a human-approved doc version. */
  | 'not-approved';

/** Fail-closed lifecycle error — thrown, never logged-and-continued. */
export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;
  constructor(code: ReleaseErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ReleaseError';
    this.code = code;
  }
}
