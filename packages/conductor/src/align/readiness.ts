/**
 * align/readiness.ts — evidence-backed release readiness (wp-112,
 * INTELLIGENCE §5 "deterministic gates are truth; AI adds an
 * evidence-backed risk narrative").
 *
 * The contract is structural, not advisory-by-convention: this module
 * returns `gate_verdict` computed ONLY from `evaluateRelease` checks —
 * the narrative object has no field that feeds back into it. An
 * optimistic narrative over a failed gate still reports `blocked`;
 * a high-risk narrative over green gates is shown alongside `ready`,
 * never silently suppressing either.
 */
import type { Store } from '@veto/core';
import { type ReleaseGateCheck, releaseGatesGreen } from '@veto/lints';
import { evaluateRelease } from '../release/gates.js';
import type { ReleaseCtx } from '../release/types.js';
import { ReleaseError } from '../release/types.js';

export type NarrativeRisk = 'low' | 'elevated' | 'high';

export interface ReleaseReadiness {
  release_id: string;
  /** Derived ONLY from the deterministic gate checks — the narrative
   *  cannot change it. */
  gate_verdict: 'ready' | 'blocked';
  gates: ReleaseGateCheck[];
  /** Evidence-backed risk narrative — advisory, subordinate to gates. */
  narrative: {
    risk: NarrativeRisk;
    summary: string;
    /** Open alignment findings for `release:<id>`, by severity. */
    open_findings: number;
    blockers: number;
    stale_evidence: number;
    /** The findings the narrative is based on — inspectable, never
     *  summarized away. */
    finding_refs: string[];
    /** Always true — makes the subordination explicit to consumers. */
    advisory_only: true;
  };
}

export async function releaseReadiness(
  ctx: ReleaseCtx & { store: Store },
  releaseId: string,
): Promise<ReleaseReadiness> {
  const release = await ctx.store.getRelease({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  if (!release) {
    throw new ReleaseError(
      'not-found',
      `no release '${releaseId}' in ${ctx.workspace}`,
    );
  }
  const { checks } = await evaluateRelease(ctx, release);
  const findings = (
    await ctx.store.listAlignmentFindings({
      workspace: ctx.workspace,
      scope: `release:${releaseId}`,
    })
  ).filter((f) => f.status === 'open' || f.status === 'verified');

  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  const majors = findings.filter((f) => f.severity === 'major').length;
  const stale = findings.filter((f) => f.freshness === 'stale').length;
  const risk: NarrativeRisk =
    blockers > 0 ? 'high' : majors > 0 || stale > 0 ? 'elevated' : 'low';

  const verdict: ReleaseReadiness['gate_verdict'] = releaseGatesGreen(checks)
    ? 'ready'
    : 'blocked';
  const failed = checks.filter((c) => c.verdict === 'fail');
  const summary =
    failed.length > 0
      ? `Deterministic gates FAIL (${failed.map((c) => c.gate).join(', ')}). The release stays blocked regardless of this narrative. ${findings.length} open alignment finding(s) add context only.`
      : findings.length > 0
        ? `All deterministic gates pass. ${findings.length} open alignment finding(s) (${blockers} blocker, ${majors} major, ${stale} stale evidence) are advisory risk context — a human decides, the narrative cannot gate.`
        : 'All deterministic gates pass and no open alignment findings — ' +
          'low residual risk by current evidence.';

  return {
    release_id: releaseId,
    gate_verdict: verdict,
    gates: checks,
    narrative: {
      risk,
      summary,
      open_findings: findings.length,
      blockers,
      stale_evidence: stale,
      finding_refs: findings.map((f) => `alignment:${f.id}`),
      advisory_only: true,
    },
  };
}
