/**
 * design/drift.ts — post-merge implementation-vs-approved-design
 * comparison (PRD §15.4, wp-149).
 *
 * After merge, the implementation is compared against the APPROVED
 * mockup revision. Any divergence is recorded as a `design-drift`
 * review finding — ADVISORY only: a machine proposes the finding, a
 * human renders the verdict through the normal finding lifecycle
 * (wp-148). This module never resolves a drift finding itself.
 */
import type { ReviewFindingRow, ReviewFindingStatus } from '@sprint-runner/core';
import { DESIGN_DRIFT_CATEGORY } from '@sprint-runner/core';
import { upsertFinding } from '../review/studio/findings.js';
import { reviewIdFor } from '../review/studio/types.js';
import { type DesignCtx, driftFindingId } from './types.js';

export interface DesignDriftInput {
  subject: string;
  /** The approved mockup revision the implementation is compared to. */
  docVersion: number;
  /** The screen/component the drift is about. */
  screenId?: string | null;
  componentId?: string | null;
  /** What diverged (human-readable) + evidence refs. */
  body: string;
  evidence?: string | null;
  /** Severity is a hint only — the human verdict decides. */
  severity?: 'blocker' | 'major' | 'minor' | 'nit' | 'question' | null;
  file?: string | null;
  line?: number | null;
  repo?: string | null;
}

/**
 * Record a `design-drift` finding bound to the approved revision.
 * Idempotent on `drift-<subject>-r<version>` — re-running the comparison
 * refreshes content, never duplicates. Advisory: `blocking: false`.
 */
export async function recordDesignDrift(
  ctx: DesignCtx,
  input: DesignDriftInput,
): Promise<ReviewFindingRow> {
  const reviewId = reviewIdFor(input.subject);
  const { finding } = await upsertFinding(ctx, {
    workspace: ctx.workspace,
    org: null,
    finding_id: driftFindingId(input.subject, input.docVersion),
    review_id: reviewId,
    revision: input.docVersion,
    subject: input.subject,
    status: 'open',
    severity: (input.severity ?? 'minor') as ReviewFindingRow['severity'],
    category: DESIGN_DRIFT_CATEGORY as ReviewFindingRow['category'],
    kind: 'code-bug',
    thread_id: null,
    file: input.file ?? null,
    line: input.line ?? null,
    symbol: input.componentId ?? null,
    repo: input.repo ?? null,
    body: input.body,
    evidence: input.evidence ?? null,
    suggested_fix: null,
    confidence: null,
    blocking: false,
    security_category: null,
    affected_asset: null,
    exposure: null,
    policy_violated: null,
    author: ctx.actor,
    created_at: null,
    updated_at: null,
  });
  return finding;
}

/** Compare an approved mockup's AC coverage to an implementation's
 *  reported coverage (component ids the implementation touched). Returns
 *  the drift descriptions — advisory, never auto-resolved. */
export function describeDrift(args: {
  approvedComponents: string[];
  implementedComponents: string[];
  approvedStates: string[];
  implementedStates: string[];
}): string[] {
  const approved = new Set(args.approvedComponents);
  const implemented = new Set(args.implementedComponents);
  const missingComponents = [...approved].filter((c) => !implemented.has(c));
  const extraComponents = [...implemented].filter((c) => !approved.has(c));
  const approvedStates = new Set(args.approvedStates);
  const missingStates = args.implementedStates.length
    ? [...approvedStates].filter((s) => !new Set(args.implementedStates).has(s))
    : [];
  const out: string[] = [];
  if (missingComponents.length) {
    out.push(
      `approved components missing from implementation: ${missingComponents.join(', ')}`,
    );
  }
  if (extraComponents.length) {
    out.push(
      `implementation added components not in the approved mockup: ${extraComponents.join(', ')}`,
    );
  }
  if (missingStates.length) {
    out.push(
      `approved states not implemented: ${missingStates.join(', ')}`,
    );
  }
  return out;
}

/** Human verdicts allowed on a drift finding — the normal lifecycle
 *  terminal dispositions plus `resolved`. A machine never applies these. */
export const DRIFT_HUMAN_VERDICTS = [
  'resolved',
  'accepted-risk',
  'not-applicable',
  'duplicate',
  'deferred-with-approval',
] as const satisfies readonly ReviewFindingStatus[];
