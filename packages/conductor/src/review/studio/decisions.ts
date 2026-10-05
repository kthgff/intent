/**
 * review/studio/decisions.ts — commit-bound reviewer verdicts (PRD
 * §15.8, wp-148).
 *
 * `review_decisions` is append-only; each row binds the reviewable
 * head it was made against — the LATEST `review_revisions` pin at
 * record time (`head_sha` + spec baseline). A caller never supplies
 * the binding: approving "an old head" is exactly the bug the schema
 * exists to prevent — new commits → new revision → stale approval.
 *
 * Internal approvals NEVER pose as GitHub approvals — this engine
 * writes no `external_review_mappings` and performs no `gh` calls; a
 * mapping row is an explicit, separate record (GitHub stays
 * authoritative for PR state).
 *
 * The five actions (§15.8): approve / comment / request-fix /
 * request-changes / send-to-board. `send-to-board` also captures a
 * capture-tray `board_items` row (board NULL = tray, D27) — feedback
 * returns to the board.
 */
import type {
  BoardItem,
  ReviewAction,
  ReviewDecisionRow,
  ReviewSessionRow,
} from '@sprint-runner/core';
import { securityGate } from '../security.js';
import { requireSession, rollupSessionStatus } from './session.js';
import {
  type StudioCtx,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from './types.js';

export interface RecordDecisionResult {
  decision: ReviewDecisionRow;
  session: ReviewSessionRow;
  /** Capture-tray item created for `send-to-board` (else null). */
  board_item: BoardItem | null;
}

/**
 * Append a reviewer decision bound to the latest revision pin.
 * Idempotent on `decision_id` (ON CONFLICT DO NOTHING at the store —
 * a retry returns the existing row, never a double-verdict).
 */
export async function recordDecision(
  ctx: StudioCtx,
  args: {
    reviewId: string;
    decisionId: string;
    reviewer: string;
    action: ReviewAction;
    rationale?: string | null;
    /** Optional board slug for send-to-board (null/absent → tray). */
    board?: string | null;
  },
): Promise<RecordDecisionResult> {
  const session = await requireSession(ctx, args.reviewId);
  if (session.status === 'closed') {
    throw conflict(`review session '${args.reviewId}' is closed`);
  }
  const latest = await ctx.store.getReviewRevision({
    workspace: ctx.workspace,
    review_id: args.reviewId,
  });
  if (!latest) {
    throw conflict(
      `review session '${args.reviewId}' has no revision pin — record a reviewable head (head_sha + baseline) before deciding`,
    );
  }
  if (!args.decisionId || !args.reviewer) {
    throw badRequest('decision: {decision_id, reviewer} are required');
  }

  // Security is a first-class review dimension (PRD §15.8, wp-150): an
  // approval must not clear the merge gate while unresolved critical
  // security findings are uncovered by an owner+expiry exception.
  if (args.action === 'approve') {
    const gate = await securityGate(ctx, {
      reviewId: args.reviewId,
      phase: 'merge',
    });
    if (gate.blocked) {
      throw forbidden(
        `review ${args.reviewId}: security gate blocks approval — ${gate.reasons.join('; ')}`,
      );
    }
  }

  const ts = ctx.now().toISOString();
  const row: ReviewDecisionRow = {
    workspace: ctx.workspace,
    org: session.org ?? null,
    decision_id: args.decisionId,
    review_id: args.reviewId,
    revision: latest.revision,
    reviewer: args.reviewer,
    action: args.action,
    head_sha: latest.head_sha,
    baseline: latest.baseline ?? null,
    rationale: args.rationale ?? null,
    created_at: ts,
  };

  let board_item: BoardItem | null = null;
  if (args.action === 'send-to-board') {
    board_item = {
      id: `bi-${args.decisionId}`,
      workspace: ctx.workspace,
      org: session.org ?? null,
      board: args.board ?? null,
      kind: 'feedback',
      note_kind: null,
      topic: `review:${args.reviewId}`,
      importance: null,
      applies_to: [session.subject],
      note_status: null,
      rationale: args.rationale ?? null,
      provenance: 'stakeholder-verified',
      ref: `review:${args.reviewId}`,
      title: `Review feedback — ${session.subject}`,
      body: args.rationale ?? null,
      x: null,
      y: null,
      w: null,
      h: null,
      zone: null,
      serves: null,
      status: 'icebox',
      consumed_by: null,
      created_at: ts,
      updated_at: ts,
    };
  }

  await ctx.store.transaction(async (store) => {
    await store.appendReviewDecision(row);
    if (board_item) await store.upsertBoardItem(board_item);
    if (args.action === 'send-to-board') {
      await store.appendEvent({
        workspace: ctx.workspace,
        ticket_id: session.subject,
        ts,
        stage: null,
        actor_type: 'human',
        actor_id: args.reviewer,
        event: 'item_captured',
        run: null,
        refs: [`review:${args.reviewId}`],
        data: {
          board_item: board_item?.id,
          via: 'review send-to-board',
          review_id: args.reviewId,
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
  });

  // A retry that hit the PK no-op returns the durable row.
  const decisions = await ctx.store.listReviewDecisions({
    workspace: ctx.workspace,
    review_id: args.reviewId,
  });
  const decision = decisions.find((d) => d.decision_id === args.decisionId);
  if (!decision) {
    throw notFound(
      `decision '${args.decisionId}' failed to persist for ${args.reviewId}`,
    );
  }
  const status = await rollupSessionStatus(ctx, args.reviewId);
  return {
    decision,
    session: { ...session, status },
    board_item,
  };
}

/** All decisions for a session, append order. */
export async function listDecisions(
  ctx: StudioCtx,
  reviewId: string,
): Promise<ReviewDecisionRow[]> {
  await requireSession(ctx, reviewId);
  return ctx.store.listReviewDecisions({
    workspace: ctx.workspace,
    review_id: reviewId,
  });
}
