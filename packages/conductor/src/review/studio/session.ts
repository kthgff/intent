/**
 * review/studio/session.ts — review sessions + append-only reviewable
 * heads (PRD §15.8, wp-148).
 *
 * A review session groups findings/comments/decisions for one subject.
 * `review_revisions` pins the reviewable head — `head_sha` + spec
 * baseline — append-only: new commits (or a moved spec baseline)
 * append a new revision and every `approve` decision bound to an older
 * head/baseline goes STALE (never deleted — staleness is computed from
 * the binding, not stamped on the row).
 *
 * Session `status` is the materialized rollup:
 *   open | approved | changes-requested | closed
 * …with verdict history living in `review_decisions` (append-only).
 */
import type {
  ReviewDecisionRow,
  ReviewRevisionRow,
  ReviewSessionRow,
  ReviewSessionStatus,
  RunBaseline,
} from '@sprint-runner/core';
import {
  type StudioCtx,
  baselineKey,
  conflict,
  notFound,
  reviewIdFor,
} from './types.js';

/** Get-or-create the review session for a subject (deterministic id —
 *  `rv-<subject>`; idempotent). */
export async function ensureSession(
  ctx: StudioCtx,
  args: { subject: string; reviewId?: string },
): Promise<ReviewSessionRow> {
  const reviewId = args.reviewId ?? reviewIdFor(args.subject);
  const existing = await ctx.store.getReviewSession({
    workspace: ctx.workspace,
    review_id: reviewId,
  });
  if (existing) return existing;
  const row: ReviewSessionRow = {
    workspace: ctx.workspace,
    org: null,
    review_id: reviewId,
    subject: args.subject,
    status: 'open',
    created_by: ctx.actor,
    created_at: ctx.now().toISOString(),
    closed_at: null,
  };
  await ctx.store.upsertReviewSession(row);
  return row;
}

/** 404 when absent — every other engine call requires the session. */
export async function requireSession(
  ctx: StudioCtx,
  reviewId: string,
): Promise<ReviewSessionRow> {
  const s = await ctx.store.getReviewSession({
    workspace: ctx.workspace,
    review_id: reviewId,
  });
  if (!s) {
    throw notFound(`no review session '${reviewId}' in ${ctx.workspace}`);
  }
  return s;
}

export interface RecordRevisionResult {
  revision: ReviewRevisionRow;
  /** True when a new revision row was appended (vs reusing the
   *  identical latest pin — this call is idempotent). */
  created: boolean;
  /** Approvals the new head/baseline just staled (empty on reuse). */
  stale_approvals: ReviewDecisionRow[];
}

/**
 * Pin a new reviewable head. Idempotent: a latest revision carrying
 * the SAME `head_sha` AND the same spec baseline is reused — a moved
 * head OR a moved baseline appends `revision = max+1` and stales every
 * approval bound to the older pin. When the session rollup was
 * `approved` and any approval goes stale, the rollup falls back to
 * `open` (re-approval required — §15.8).
 */
export async function recordRevision(
  ctx: StudioCtx,
  args: {
    reviewId: string;
    headSha: string;
    baseSha?: string | null;
    baseline?: RunBaseline | null;
  },
): Promise<RecordRevisionResult> {
  const session = await requireSession(ctx, args.reviewId);
  if (!args.headSha || args.headSha.trim().length === 0) {
    throw conflict(`revision for ${args.reviewId}: head_sha is required`);
  }
  const latest = await ctx.store.getReviewRevision(
    { workspace: ctx.workspace, review_id: args.reviewId },
    undefined,
  );
  const sameHead = latest?.head_sha === args.headSha;
  const sameBaseline =
    baselineKey(latest?.baseline ?? null) ===
    baselineKey(args.baseline ?? null);
  if (latest && sameHead && sameBaseline) {
    return { revision: latest, created: false, stale_approvals: [] };
  }

  const revision: ReviewRevisionRow = {
    workspace: ctx.workspace,
    org: session.org ?? null,
    review_id: args.reviewId,
    revision: (latest?.revision ?? 0) + 1,
    head_sha: args.headSha,
    base_sha: args.baseSha ?? null,
    baseline: args.baseline ?? null,
    created_at: ctx.now().toISOString(),
  };
  await ctx.store.appendReviewRevision(revision);

  // Stale-approval detection: every approve decision bound to a head
  // OR baseline that no longer matches the new pin is stale.
  const decisions = await ctx.store.listReviewDecisions({
    workspace: ctx.workspace,
    review_id: args.reviewId,
  });
  const stale_approvals = decisions.filter(
    (d) =>
      d.action === 'approve' &&
      (d.head_sha !== revision.head_sha ||
        baselineKey(d.baseline ?? null) !== baselineKey(revision.baseline)),
  );
  if (stale_approvals.length > 0 && session.status === 'approved') {
    await ctx.store.upsertReviewSession({
      ...session,
      status: 'open',
      closed_at: null,
    });
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: session.subject,
      ts: ctx.now().toISOString(),
      stage: null,
      actor_type: 'system',
      actor_id: ctx.actor,
      event: 'status_changed',
      run: null,
      refs: [`review:${args.reviewId}`],
      data: {
        entity: 'review_session',
        review_id: args.reviewId,
        from: 'approved',
        to: 'open',
        reason: 'stale-approval',
        new_revision: revision.revision,
        head_sha: revision.head_sha,
        stale_approvals: stale_approvals.map((d) => d.decision_id),
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
  }
  return { revision, created: true, stale_approvals };
}

export type ApprovalCurrency = 'current' | 'stale' | 'superseded';

export interface ApprovalState {
  reviewer: string;
  /** The reviewer's latest decision — approvals bind head+baseline. */
  decision: ReviewDecisionRow;
  /** `current` = bound pin still matches the latest revision;
   *  `stale` = an approval whose pin moved; `superseded` = a
   *  non-approval verdict is the reviewer's latest word. */
  currency: ApprovalCurrency;
}

/**
 * Per-reviewer approval state vs the latest revision pin. Only the
 * reviewer's LATEST decision counts (an approve followed by
 * request-changes is changes-requested, not a stale approval).
 */
export async function approvalState(
  ctx: StudioCtx,
  reviewId: string,
): Promise<ApprovalState[]> {
  await requireSession(ctx, reviewId);
  const latest = await ctx.store.getReviewRevision({
    workspace: ctx.workspace,
    review_id: reviewId,
  });
  const decisions = await ctx.store.listReviewDecisions({
    workspace: ctx.workspace,
    review_id: reviewId,
  });
  const byReviewer = new Map<string, ReviewDecisionRow>();
  for (const d of decisions) byReviewer.set(d.reviewer, d);
  return [...byReviewer.values()].map((decision) => {
    let currency: ApprovalCurrency = 'superseded';
    if (decision.action === 'approve') {
      currency =
        latest &&
        decision.head_sha === latest.head_sha &&
        baselineKey(decision.baseline ?? null) === baselineKey(latest.baseline)
          ? 'current'
          : 'stale';
    }
    return { reviewer: decision.reviewer, decision, currency };
  });
}

/** Recompute + persist the session rollup status from decisions
 *  (called after recordDecision; recordRevision handles the stale
 *  flip itself). */
export async function rollupSessionStatus(
  ctx: StudioCtx,
  reviewId: string,
): Promise<ReviewSessionStatus> {
  const session = await requireSession(ctx, reviewId);
  if (session.status === 'closed') return 'closed';
  const states = await approvalState(ctx, reviewId);
  // Rollup precedence (conservative): an outstanding request for
  // changes beats approvals; a bound-and-current approval beats the
  // default open state.
  let next: ReviewSessionStatus = 'open';
  if (
    states.some(
      (s) =>
        s.decision.action === 'request-changes' ||
        s.decision.action === 'request-fix',
    )
  ) {
    next = 'changes-requested';
  } else if (states.some((s) => s.currency === 'current')) {
    next = 'approved';
  }
  if (next !== session.status) {
    await ctx.store.upsertReviewSession({ ...session, status: next });
  }
  return next;
}
