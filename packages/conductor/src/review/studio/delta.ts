/**
 * review/studio/delta.ts — "Changes Since Your Review" (PRD §15.8,
 * wp-148).
 *
 * When a reviewer last acted, their decision bound `head_sha` + spec
 * baseline (review_decisions is append-only). This view computes the
 * delta from THAT pinned revision to the current head:
 *
 *   - which revision + head + baseline fields moved;
 *   - which findings were filed against later revisions, and which
 *     lifecycle transitions landed after the bound revision's pin time;
 *   - the code diff itself — injected: the engine is store-only, so a
 *     `diffFn` performs the real `git diff <from> <to>` per repo (the
 *     API wires worktree paths; tests wire fakes).
 *
 * The server computes the delta — the UI renders it; a client never
 * diffs from its own idea of "last reviewed".
 */
import type {
  FindingResolutionRow,
  ReviewFindingRow,
  ReviewRevisionRow,
  RunBaseline,
} from '@veto/core';
import { requireSession } from './session.js';
import { type StudioCtx, badRequest, baselineKey, notFound } from './types.js';

/** One repo slice of the server-side diff. */
export interface RepoDiff {
  repo: string;
  /** `git diff --stat`-style text (or unified diff per caller). */
  diff: string;
}

export interface ChangesDelta {
  review_id: string;
  from_revision: number;
  to_revision: number;
  reviewer: string | null;
  head: { from_sha: string; to_sha: string };
  baseline_changed: boolean;
  /** Field-level baseline diff (only fields whose values moved). */
  baseline_changes: Record<string, { from: unknown; to: unknown }>;
  /** Findings first seen on revisions after `from_revision`. */
  findings_added: ReviewFindingRow[];
  /** Lifecycle audit rows landed after the bound revision's pin time. */
  finding_transitions: FindingResolutionRow[];
  /** Per-repo diffs (absent when no diffFn was supplied). */
  diff: RepoDiff[] | null;
}

/** Field-level diff between two RunBaseline pins (only moved keys). */
export function baselineChanges(
  from: RunBaseline | null | undefined,
  to: RunBaseline | null | undefined,
): Record<string, { from: unknown; to: unknown }> {
  const a = (from ?? {}) as Record<string, unknown>;
  const b = (to ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (baselineKey(a[k]) !== baselineKey(b[k])) {
      out[k] = { from: a[k] ?? null, to: b[k] ?? null };
    }
  }
  return out;
}

/**
 * The delta view. `reviewer` resolves the revision their LATEST
 * decision bound (the common case — "since YOUR review");
 * `fromRevision` pins explicitly. A revision that predates the first
 * pin, or a reviewer who never decided, is a 400/404 — never a guess.
 */
export async function changesSince(
  ctx: StudioCtx,
  args: {
    reviewId: string;
    reviewer?: string;
    fromRevision?: number;
    diffFn?: (fromSha: string, toSha: string) => Promise<RepoDiff[]>;
  },
): Promise<ChangesDelta> {
  await requireSession(ctx, args.reviewId);
  const revisions = await ctx.store.listReviewRevisions({
    workspace: ctx.workspace,
    review_id: args.reviewId,
  });
  const latest = revisions[revisions.length - 1];
  if (!latest) {
    throw notFound(`review '${args.reviewId}' has no revisions to diff`);
  }

  let from: ReviewRevisionRow | undefined;
  let reviewer: string | null = null;
  if (args.fromRevision !== undefined) {
    from = revisions.find((r) => r.revision === args.fromRevision);
    if (!from) {
      throw badRequest(
        `review '${args.reviewId}' has no revision ${args.fromRevision}`,
      );
    }
  } else {
    if (!args.reviewer) {
      throw badRequest('changes-since: {reviewer} or {from} is required');
    }
    reviewer = args.reviewer;
    const decisions = await ctx.store.listReviewDecisions({
      workspace: ctx.workspace,
      review_id: args.reviewId,
    });
    const mine = decisions.filter((d) => d.reviewer === args.reviewer);
    const last = mine[mine.length - 1];
    if (!last || last.revision == null) {
      throw notFound(
        `reviewer '${args.reviewer}' has no decision bound to a revision`,
      );
    }
    from = revisions.find((r) => r.revision === last.revision);
  }
  if (!from) {
    throw notFound(`bound revision for review '${args.reviewId}' is missing`);
  }

  const findings = await ctx.store.listReviewFindings({
    workspace: ctx.workspace,
    review_id: args.reviewId,
  });
  const findings_added = findings.filter(
    (f) => (f.revision ?? 0) > from.revision,
  );

  const pinTime = Date.parse(from.created_at ?? '') || 0;
  const finding_transitions: FindingResolutionRow[] = [];
  for (const f of findings) {
    const rows = await ctx.store.listFindingResolutions({
      workspace: ctx.workspace,
      finding_id: f.finding_id,
    });
    for (const r of rows) {
      if ((Date.parse(r.created_at ?? '') || 0) > pinTime) {
        finding_transitions.push(r);
      }
    }
  }

  const diff =
    args.diffFn && from.head_sha !== latest.head_sha
      ? await args.diffFn(from.head_sha, latest.head_sha)
      : null;

  return {
    review_id: args.reviewId,
    from_revision: from.revision,
    to_revision: latest.revision,
    reviewer,
    head: { from_sha: from.head_sha, to_sha: latest.head_sha },
    baseline_changed:
      baselineKey(from.baseline ?? null) !==
      baselineKey(latest.baseline ?? null),
    baseline_changes: baselineChanges(from.baseline, latest.baseline),
    findings_added,
    finding_transitions,
    diff,
  };
}
