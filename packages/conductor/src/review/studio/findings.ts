/**
 * review/studio/findings.ts — the review_findings lifecycle (PRD
 * §15.8, wp-148).
 *
 * Findings are entities, not discussion threads. The machine:
 *
 *   open → triaged → in-remediation → ready-for-verification → resolved
 *
 * plus permissioned terminal dispositions — `accepted-risk`,
 * `not-applicable`, `duplicate`, `deferred-with-approval` — reachable
 * from any non-terminal state but ONLY with a non-empty `rationale`
 * and `actorKind: 'human'` (a machine verdict never disposes).
 *
 * Rules pinned by the spec:
 *   - forward moves along the main path are always legal (a triage
 *     skip is a fast-forward, never a violation);
 *   - a human may re-open to `open` from any state with rationale;
 *   - AI may PROPOSE resolution (move to `ready-for-verification`) but
 *     never self-resolves a blocking human finding — `blocking: true`
 *     rows refuse `resolved`/terminal targets unless the actor is human;
 *   - every actual transition appends a `finding_resolutions` audit
 *     row (append-only) inside the same transaction.
 */
import type {
  FindingResolutionRow,
  ReviewFindingRow,
  ReviewFindingStatus,
} from '@sprint-runner/core';
import { type StudioCtx, forbidden, invalid, notFound } from './types.js';

/** Main lifecycle path, in order. */
export const FINDING_MAIN_PATH = [
  'open',
  'triaged',
  'in-remediation',
  'ready-for-verification',
  'resolved',
] as const satisfies readonly ReviewFindingStatus[];

/** Permissioned terminal dispositions (rationale + human required). */
export const FINDING_TERMINAL_DISPOSITIONS = [
  'accepted-risk',
  'not-applicable',
  'duplicate',
  'deferred-with-approval',
] as const satisfies readonly ReviewFindingStatus[];

const TERMINAL = new Set<string>(FINDING_TERMINAL_DISPOSITIONS);
const SETTLED = new Set<string>([...TERMINAL, 'resolved']);
const MAIN_INDEX = new Map<string, number>(
  FINDING_MAIN_PATH.map((s, i) => [s, i]),
);

export type FindingActorKind = 'human' | 'agent' | 'system';

export interface TransitionResult {
  finding: ReviewFindingRow;
  /** The audit row appended — null for a no-op (to === current). */
  resolution: FindingResolutionRow | null;
}

/**
 * Is `from → to` a legal transition for `actorKind` on `finding`?
 * Returns the reason string when illegal, null when allowed. Pure —
 * exposed for tests and for UI affordance checks.
 */
export function transitionBlocked(
  finding: Pick<ReviewFindingRow, 'status' | 'blocking'>,
  to: ReviewFindingStatus,
  actorKind: FindingActorKind,
): string | null {
  const from = finding.status;
  if (from === to) return null;
  const fromMain = MAIN_INDEX.get(from);
  const toMain = MAIN_INDEX.get(to);

  // Settled findings only leave via a human re-open.
  if (SETTLED.has(from) && to !== 'open') {
    return `${from} is terminal — only a human re-open to 'open' is allowed`;
  }
  if (to === 'open') {
    // Re-open: human-only, from anywhere non-open.
    return actorKind === 'human' ? null : 'only a human may re-open a finding';
  }
  if (TERMINAL.has(to)) {
    // Permissioned disposition — reachable from any non-terminal state.
    if (SETTLED.has(from)) {
      return `${from} is already settled — cannot dispose to ${to}`;
    }
    return null; // rationale/actorKind enforcement lives in transitionFinding
  }
  if (toMain === undefined) return `unknown target status '${to}'`;
  if (fromMain === undefined) {
    return `cannot transition from terminal '${from}' to '${to}'`;
  }
  if (toMain <= fromMain) {
    // The one real backward edge short of a re-open: verification
    // found the remediation incomplete — back to in-remediation.
    if (from === 'ready-for-verification' && to === 'in-remediation') {
      return null;
    }
    return `cannot regress ${from} → ${to} (re-open is the only other backward edge)`;
  }
  return null;
}

/**
 * Apply a lifecycle transition — validates legality + permissions,
 * then writes the finding row and the `finding_resolutions` audit row
 * in ONE transaction. No-op (`to === current`) is a read, never a write.
 */
export async function transitionFinding(
  ctx: StudioCtx,
  args: {
    findingId: string;
    to: ReviewFindingStatus;
    actor: string;
    actorKind?: FindingActorKind;
    rationale?: string | null;
  },
): Promise<TransitionResult> {
  const actorKind = args.actorKind ?? 'human';
  const rationale = args.rationale ?? null;
  const finding = await ctx.store.getReviewFinding({
    workspace: ctx.workspace,
    finding_id: args.findingId,
  });
  if (!finding) {
    throw notFound(`no review finding '${args.findingId}' in ${ctx.workspace}`);
  }
  const blocked = transitionBlocked(finding, args.to, actorKind);
  if (blocked) {
    throw invalid(`finding ${args.findingId}: ${blocked}`);
  }
  if (args.to === finding.status) {
    return { finding, resolution: null };
  }
  // Permissioned terminal dispositions (§15.8): human-only + rationale.
  if (TERMINAL.has(args.to)) {
    if (actorKind !== 'human') {
      throw forbidden(
        `finding ${args.findingId}: '${args.to}' is a permissioned terminal disposition — a human must settle it`,
      );
    }
    if (!rationale || rationale.trim().length === 0) {
      throw invalid(
        `finding ${args.findingId}: '${args.to}' requires a rationale`,
      );
    }
  }
  // AI may propose resolution, never self-resolves a blocking human
  // finding (§15.8) — `blocking` is the human-marked flag.
  if (
    actorKind !== 'human' &&
    finding.blocking === true &&
    (args.to === 'resolved' || TERMINAL.has(args.to))
  ) {
    throw forbidden(
      `finding ${args.findingId}: AI may propose resolution (ready-for-verification) but never self-resolves a blocking human finding`,
    );
  }

  return ctx.store.transaction(async (store) => {
    const ts = ctx.now().toISOString();
    const prior = await store.listFindingResolutions({
      workspace: ctx.workspace,
      finding_id: args.findingId,
    });
    const resolution: FindingResolutionRow = {
      workspace: ctx.workspace,
      org: finding.org ?? null,
      finding_id: args.findingId,
      seq: (prior[prior.length - 1]?.seq ?? -1) + 1,
      status: args.to,
      rationale,
      actor: args.actor,
      created_at: ts,
    };
    const next: ReviewFindingRow = {
      ...finding,
      status: args.to,
      updated_at: ts,
    };
    await store.upsertReviewFinding(next);
    await store.appendFindingResolution(resolution);
    return { finding: next, resolution };
  });
}

/**
 * Create or refresh a finding row. New findings start `open` with a
 * seq-0 audit row; existing rows are upserted EXCEPT `status`, which
 * only moves via {@link transitionFinding} (the lifecycle is the audit
 * trail — a content refresh must not silently regress a human triage).
 */
export async function upsertFinding(
  ctx: StudioCtx,
  row: ReviewFindingRow,
): Promise<{ finding: ReviewFindingRow; created: boolean }> {
  const existing = await ctx.store.getReviewFinding({
    workspace: ctx.workspace,
    finding_id: row.finding_id,
  });
  if (existing) {
    // Content refresh only — lifecycle status belongs to the audit path.
    const next: ReviewFindingRow = {
      ...row,
      status: existing.status,
      updated_at: ctx.now().toISOString(),
    };
    await ctx.store.upsertReviewFinding(next);
    return { finding: next, created: false };
  }
  const ts = ctx.now().toISOString();
  const finding: ReviewFindingRow = {
    ...row,
    status: 'open',
    created_at: row.created_at ?? ts,
    updated_at: ts,
  };
  await ctx.store.upsertReviewFinding(finding);
  await ctx.store.appendFindingResolution({
    workspace: ctx.workspace,
    org: finding.org ?? null,
    finding_id: finding.finding_id,
    seq: 0,
    status: 'open',
    rationale: null,
    actor: row.author ?? ctx.actor,
    created_at: ts,
  });
  return { finding, created: true };
}

/** Convenience: the finding's full audit trail, ascending. */
export async function findingHistory(
  ctx: StudioCtx,
  findingId: string,
): Promise<FindingResolutionRow[]> {
  return ctx.store.listFindingResolutions({
    workspace: ctx.workspace,
    finding_id: findingId,
  });
}
