/**
 * review/studio/types.ts — shared shapes for the Review Studio engine
 * (PRD §15.8, wp-148).
 *
 * The engine is a thin semantic layer over the wp-131 store contract:
 * it owns the RULES (lifecycle legality, commit-bound approvals,
 * permissioned dispositions, out-of-scope routing) while `Store` owns
 * the rows. `StudioCtx` is deliberately minimal — both the
 * `TransitionContext` (conductor paths) and the API's transitionCtx
 * satisfy it structurally.
 */
import type { Store } from '@veto/core';

/** Everything the studio engine needs — a subset of TransitionContext. */
export interface StudioCtx {
  store: Store;
  workspace: string;
  /** `actor:` identity stamped on rows/events the engine writes. */
  actor: string;
  now: () => Date;
}

/**
 * Fail-closed studio error. `code` maps to an HTTP status in the API
 * layer — engine callers get a typed reason, never a silent no-op.
 */
export class ReviewStudioError extends Error {
  readonly code:
    | 'not-found'
    | 'invalid-transition'
    | 'forbidden'
    | 'conflict'
    | 'bad-request';
  readonly statusCode: number;

  constructor(
    code: ReviewStudioError['code'],
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode =
      statusCode ??
      {
        'not-found': 404,
        'invalid-transition': 400,
        forbidden: 403,
        conflict: 409,
        'bad-request': 400,
      }[code];
  }
}

export const notFound = (m: string) => new ReviewStudioError('not-found', m);
export const invalid = (m: string) =>
  new ReviewStudioError('invalid-transition', m);
export const forbidden = (m: string) => new ReviewStudioError('forbidden', m);
export const conflict = (m: string) => new ReviewStudioError('conflict', m);
export const badRequest = (m: string) =>
  new ReviewStudioError('bad-request', m);

/** Deterministic session id — one review session per subject. */
export function reviewIdFor(subject: string): string {
  return `rv-${subject}`;
}

/** Deterministic finding id for a synced review.json thread. */
export function findingIdFor(reviewId: string, threadId: string): string {
  return `${reviewId}:${threadId}`;
}

/** Deterministic changeset id for an out-of-scope comment — creating
 *  the row is idempotent (upsert), so repeat routing collapses. */
export function changesetIdFor(commentId: string): string {
  return `cs-${commentId}`;
}

/** Stable comparison key for a RunBaseline — JSON with sorted keys so
 *  {a:1,b:2} equals {b:2,a:1} (baseline equality drives stale-approval). */
export function baselineKey(baseline: unknown): string {
  if (baseline === null || baseline === undefined) return 'null';
  if (typeof baseline !== 'object') return JSON.stringify(baseline);
  if (Array.isArray(baseline)) {
    return `[${baseline.map((v) => baselineKey(v)).join(',')}]`;
  }
  const entries = Object.entries(baseline as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${baselineKey(v)}`);
  return `{${entries.join(',')}}`;
}
