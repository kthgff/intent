/**
 * review/studio/comments.ts — semantic review comments (PRD §15.8,
 * wp-148).
 *
 * Comment semantics: `type × disposition` — the AI proposes a
 * classification (`ai_classification` records the proposal before
 * human confirmation); the human's `type`/`disposition` fields are
 * authoritative once set.
 *
 * A comment is an instruction, NOT unlimited authorization: an
 * `out-of-scope` request must not turn into code changes in this
 * review — it routes to change control. Routing = create a `changesets`
 * row (status `draft`, `request` = the verbatim ask, `baseline` pinned
 * to the subject's spec doc head) and link it back via
 * `changeset_id`. wp-140 owns the ChangeSet lifecycle from `draft`
 * onward; this engine only performs the handoff (+ a
 * `changeset_created` event so the lifecycle can pick it up).
 */
import type { ReviewCommentRow, ReviewCommentType } from '@veto/core';
import { requireSession } from './session.js';
import {
  type StudioCtx,
  badRequest,
  changesetIdFor,
  notFound,
} from './types.js';

/** Docs an out-of-scope baseline pin may target, in probe order —
 *  `rs.md` is the adopted vocabulary (wp-132), `prd.md` is the
 *  pre-rename kind that live subjects carry today. */
const SPEC_DOC_CANDIDATES = ['rs.md', 'prd.md'] as const;

export interface AddCommentResult {
  comment: ReviewCommentRow;
  /** The ChangeSet an out-of-scope comment routed to (else null). */
  changeset_id: string | null;
}

/**
 * Record a semantic comment. When the effective type (explicit `type`
 * or the AI-proposed classification's) is `out-of-scope`, the comment
 * is routed to a ChangeSet in the same transaction — the comment row
 * carries `changeset_id` from birth.
 */
export async function addComment(
  ctx: StudioCtx,
  args: {
    reviewId: string;
    commentId: string;
    body: string;
    author?: string | null;
    type?: ReviewCommentType | null;
    disposition?: ReviewCommentRow['disposition'];
    file?: string | null;
    line?: number | null;
    revision?: number | null;
    subject?: string | null;
    aiClassification?: Record<string, unknown> | null;
  },
): Promise<AddCommentResult> {
  const session = await requireSession(ctx, args.reviewId);
  if (!args.body || args.body.trim().length === 0) {
    throw badRequest('comment body is required');
  }
  // AI proposes; human sets. Effective type decides routing.
  const proposed = args.aiClassification?.type;
  const effectiveType =
    args.type ??
    (typeof proposed === 'string' ? (proposed as ReviewCommentType) : null);

  const ts = ctx.now().toISOString();
  const comment: ReviewCommentRow = {
    workspace: ctx.workspace,
    org: session.org ?? null,
    comment_id: args.commentId,
    review_id: args.reviewId,
    revision: args.revision ?? null,
    subject: args.subject ?? session.subject,
    file: args.file ?? null,
    line: args.line ?? null,
    type: effectiveType,
    disposition: args.disposition ?? null,
    ai_classification: args.aiClassification ?? null,
    body: args.body,
    author: args.author ?? ctx.actor,
    changeset_id: null,
    created_at: ts,
  };

  if (effectiveType !== 'out-of-scope') {
    await ctx.store.upsertReviewComment(comment);
    return { comment, changeset_id: null };
  }

  // ---- out-of-scope → change control (§15.8) ----
  const changesetId = changesetIdFor(args.commentId);
  const baseline = await specBaselineRef(ctx, session.subject);
  await ctx.store.transaction(async (store) => {
    await store.upsertChangeset({
      workspace: ctx.workspace,
      org: session.org ?? null,
      changeset_id: changesetId,
      title: `Out-of-scope request — ${session.subject}`,
      request: args.body,
      baseline,
      classification: null,
      status: 'draft',
      analysis: null,
      decision: null,
      decision_rationale: null,
      decided_by: null,
      decided_at: null,
      expires_on: null,
      emergency: false,
      retro_ref: null,
      reconciliation: null,
      created_by: args.author ?? ctx.actor,
      created_at: ts,
      updated_at: ts,
    });
    comment.changeset_id = changesetId;
    await store.upsertReviewComment(comment);
    await store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: session.subject,
      ts,
      stage: null,
      actor_type: 'human',
      actor_id: args.author ?? ctx.actor,
      event: 'changeset_created',
      run: null,
      refs: [`review:${args.reviewId}`, `comment:${args.commentId}`],
      data: {
        changeset_id: changesetId,
        via: 'review out-of-scope comment',
        review_id: args.reviewId,
        comment_id: args.commentId,
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
  });
  return { comment, changeset_id: changesetId };
}

/**
 * Re-classify a comment (AI proposal landed, or the human corrected
 * it). Re-classifying TO `out-of-scope` performs the routing lazily —
 * the comment gains `changeset_id`. Re-classifying AWAY does not
 * delete the ChangeSet (wp-140 owns its lifecycle — a drafted set the
 * human abandons is `abandoned`, not erased).
 */
export async function reclassifyComment(
  ctx: StudioCtx,
  args: {
    reviewId: string;
    commentId: string;
    type: ReviewCommentType;
    disposition?: ReviewCommentRow['disposition'];
    actor?: string;
  },
): Promise<AddCommentResult> {
  const list = await ctx.store.listReviewComments({
    workspace: ctx.workspace,
    review_id: args.reviewId,
  });
  const existing = list.find((c) => c.comment_id === args.commentId);
  if (!existing) {
    throw notFound(`no review comment '${args.commentId}' on ${args.reviewId}`);
  }
  if (args.type === 'out-of-scope' && !existing.changeset_id) {
    // Route now — same write path as addComment's out-of-scope branch.
    return addComment(ctx, {
      reviewId: args.reviewId,
      commentId: args.commentId,
      body: existing.body,
      author: existing.author ?? null,
      type: 'out-of-scope',
      disposition: args.disposition ?? existing.disposition ?? null,
      file: existing.file ?? null,
      line: existing.line ?? null,
      revision: existing.revision ?? null,
      subject: existing.subject ?? null,
      aiClassification: existing.ai_classification ?? null,
    });
  }
  const next: ReviewCommentRow = {
    ...existing,
    type: args.type,
    disposition: args.disposition ?? existing.disposition,
  };
  await ctx.store.upsertReviewComment(next);
  return { comment: next, changeset_id: next.changeset_id ?? null };
}

/** All comments on a session (or one sub-subject), chrono order. */
export async function listComments(
  ctx: StudioCtx,
  args: { reviewId: string; subject?: string },
): Promise<ReviewCommentRow[]> {
  await requireSession(ctx, args.reviewId);
  return ctx.store.listReviewComments({
    workspace: ctx.workspace,
    review_id: args.reviewId,
    ...(args.subject ? { subject: args.subject } : {}),
  });
}

/** Pin the changeset's baseline ref to the subject's spec doc head —
 *  `rs.md` when the subject uses the renamed kind, else `prd.md`. */
async function specBaselineRef(
  ctx: StudioCtx,
  subject: string,
): Promise<{ subject: string; doc: string; version: number | null }> {
  for (const doc of SPEC_DOC_CANDIDATES) {
    const v = await ctx.store.getDoc({
      workspace: ctx.workspace,
      subject,
      doc,
    });
    if (v) return { subject, doc, version: v.version };
  }
  // No spec doc versioned yet — pin the subject anyway; wp-140's
  // analysis tolerates a version-less baseline (applies to head).
  return { subject, doc: 'rs.md', version: null };
}
