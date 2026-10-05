/**
 * design/types.ts — shared shapes for the design-artifact engine
 * (PRD §15.4, wp-149).
 *
 * The engine is a thin semantic layer over the wp-131 store contract:
 * it owns the RULES (mockup tree validity, approval↔revision binding,
 * partial invalidation on material change, visual-AC edges, design-drift
 * advisories) while `Store` owns the rows. `DesignCtx` is deliberately
 * minimal and structurally compatible with `TransitionContext` and the
 * API's request context.
 */
import type { Store } from '@sprint-runner/core';

/** Everything the design engine needs — a subset of TransitionContext. */
export interface DesignCtx {
  store: Store;
  workspace: string;
  /** `actor:` identity stamped on rows/events the engine writes. */
  actor: string;
  now: () => Date;
}

/**
 * Fail-closed design error. `code` maps to an HTTP status in the API
 * layer — engine callers get a typed reason, never a silent no-op.
 */
export class DesignError extends Error {
  readonly code:
    | 'not-found'
    | 'invalid'
    | 'forbidden'
    | 'conflict'
    | 'bad-request';
  readonly statusCode: number;

  constructor(
    code: DesignError['code'],
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode =
      statusCode ??
      {
        'not-found': 404,
        invalid: 400,
        forbidden: 403,
        conflict: 409,
        'bad-request': 400,
      }[code];
  }
}

export const notFound = (m: string) => new DesignError('not-found', m);
export const invalid = (m: string) => new DesignError('invalid', m);
export const forbidden = (m: string) => new DesignError('forbidden', m);
export const conflict = (m: string) => new DesignError('conflict', m);
export const badRequest = (m: string) => new DesignError('bad-request', m);

/** Deterministic design-approval id for a (subject, doc_version, reviewer)
 *  triple — recording the same approval twice collapses (idempotent). */
export function designApprovalId(
  subject: string,
  doc: string,
  docVersion: number,
  reviewer: string,
): string {
  return `da-${subject}-${doc.replace(/[^a-z0-9]+/gi, '')}-v${docVersion}-${reviewer}`;
}

/** Deterministic design-drift finding id for a (subject, revision) pair. */
export function driftFindingId(subject: string, revision: number): string {
  return `drift-${subject}-r${revision}`;
}

/** Stable JSON with sorted keys — structural-diff equality that ignores
 *  object key order (a re-serialized tree must not read as a change). */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
  return `{${entries.join(',')}}`;
}
