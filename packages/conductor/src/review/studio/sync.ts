/**
 * review/studio/sync.ts — conductor integration for the Review
 * Studio (PRD §15.8, wp-148).
 *
 * The wp-050 review pipeline keeps its own truth in `review.json`
 * (run_artifacts). `syncReviewStudio` projects that truth into the
 * studio tables so the human review surface has durable entities:
 *
 *   1. `ensureSession` — one `rv-<subject>` session per ticket;
 *   2. head pin — `git rev-parse HEAD` per `ticket_repos` worktree
 *      (multi-repo → `repo@sha` joined — a single binding token that
 *      still diffs per-repo); absent worktrees → no revision;
 *   3. baseline pin — `RunBaseline` from `doc_versions` heads (rs/prd,
 *      tdd, ticket.md, ac set parsed from the spec text);
 *   4. `recordRevision` — new head OR moved baseline → new revision →
 *      stale-approval detection + `status_changed` ledger row;
 *   5. findings projection — review.json threads → `review_findings`
 *      rows, mapping thread status onto the lifecycle WITHOUT
 *      regressing human triage:
 *        open/reopened → 'open' (new) / 'in-remediation' (reopen)
 *        fixed         → 'ready-for-verification'
 *        dismissed/wontfix → untouched (terminal dispositions need a
 *          permissioned rationale — the verdict route performs them)
 *      Each actual move appends a `finding_resolutions` audit row.
 *
 * `syncReviewHead` is the lightweight variant for post-approval push
 * transitions (ci-fix/comment-fix/rebase): revision pin only — new
 * commits landing after approval stale the bound approvals (§15.8).
 */
import type {
  ReviewFindingRow,
  ReviewFindingStatus,
  RunBaseline,
} from '@veto/core';
import { git } from '@veto/gitops';
import type { TransitionContext } from '../../contracts.js';
import { readReviewJson } from '../../transitions/actions.js';
import { transitionFinding, upsertFinding } from './findings.js';
import { ensureSession, recordRevision } from './session.js';
import { type StudioCtx, findingIdFor } from './types.js';

/** Thread statuses the sync understands (SCHEMAS §6 review.json). */
type ThreadStatus =
  | 'open'
  | 'reopened'
  | 'fixed'
  | 'dismissed'
  | 'wontfix'
  | string;

export interface StudioSyncReport {
  review_id: string;
  revision: number | null;
  revision_created: boolean;
  stale_approvals: string[];
  findings_created: number;
  findings_transitioned: number;
}

/** `git rev-parse HEAD` per ticket_repos worktree → the bound head
 *  token. Single-repo → the bare sha; multi-repo → sorted
 *  `<repo>@<sha>` joined with ',' (still one opaque binding; the
 *  delta view can re-split it). */
export async function headShaForTicket(
  ctx: StudioCtx & Pick<TransitionContext, 'rootPath'>,
  ticketId: string,
  opts: {
    headFor?: (worktree: string, repo: string) => Promise<string | null>;
  } = {},
): Promise<{ head_sha: string | null; repos: Record<string, string> }> {
  const rows = await ctx.store.listTicketRepos({
    workspace: ctx.workspace,
    ticket_id: ticketId,
  });
  const repos: Record<string, string> = {};
  for (const tr of rows) {
    if (!tr.worktree) continue;
    const sha = opts.headFor
      ? await opts.headFor(tr.worktree, tr.repo)
      : await gitHead(tr.worktree);
    if (sha) repos[tr.repo] = sha;
  }
  const names = Object.keys(repos).sort();
  if (names.length === 0) return { head_sha: null, repos };
  const head_sha =
    names.length === 1
      ? (repos[names[0] as string] ?? null)
      : names.map((n) => `${n}@${repos[n]}`).join(',');
  return { head_sha, repos };
}

async function gitHead(worktree: string): Promise<string | null> {
  try {
    const out = await git(['rev-parse', 'HEAD'], { cwd: worktree });
    return out.stdout.trim() || null;
  } catch {
    return null;
  }
}

/** AC tokens the baseline pins (`AC-1`, `ac:login-2` spellings) —
 *  best-effort extraction from the spec doc text. */
const AC_TOKEN_RE = /\b(?:AC-[\w.]+|ac:[\w.-]+)\b/g;

/** Build the RunBaseline pin from the subject's `doc_versions` heads. */
export async function studioBaseline(
  ctx: StudioCtx,
  subject: string,
): Promise<RunBaseline> {
  const version = async (doc: string) =>
    (await ctx.store.getDoc({ workspace: ctx.workspace, subject, doc }))
      ?.version ?? null;
  const rsVersion = (await version('rs.md')) ?? (await version('prd.md'));
  const ticketRev = await version('ticket.md');
  const designRev = await version('tdd.md');
  const acIds = new Set<string>();
  for (const doc of ['rs.md', 'prd.md', 'ac.md', 'ticket.md']) {
    const v = await ctx.store.getDoc({
      workspace: ctx.workspace,
      subject,
      doc,
    });
    for (const m of v?.content.matchAll(AC_TOKEN_RE) ?? []) {
      acIds.add(m[0]);
    }
  }
  return {
    rs_version: rsVersion,
    ticket_rev: ticketRev,
    design_rev: designRev,
    ac_ids: [...acIds].sort(),
    base_sha: null,
    contract_ver: null,
  };
}

/** review.json thread → lifecycle target. Terminal dispositions are
 *  NOT auto-applied — they need rationale + a human actor (§15.8);
 *  dismissed/wontfix threads wait for the verdict route. */
const THREAD_TO_LIFECYCLE: Record<string, ReviewFindingStatus | null> = {
  open: 'open',
  reopened: 'in-remediation',
  fixed: 'ready-for-verification',
  dismissed: null,
  wontfix: null,
};

/**
 * Project the ticket's review.json + current head/baseline into the
 * studio tables. Idempotent — safe to call after every pass merge and
 * every fix claims application.
 */
export async function syncReviewStudio(
  ctx: StudioCtx & Pick<TransitionContext, 'rootPath'>,
  args: {
    ticketId: string;
    runId?: string | null;
    headFor?: (worktree: string, repo: string) => Promise<string | null>;
  },
): Promise<StudioSyncReport> {
  const session = await ensureSession(ctx, { subject: args.ticketId });
  const reviewId = session.review_id;

  // ---- revision pin (head + baseline) ----
  const { head_sha } = await headShaForTicket(ctx, args.ticketId, {
    ...(args.headFor ? { headFor: args.headFor } : {}),
  });
  const baseline = await studioBaseline(ctx, args.ticketId);
  let revision: number | null = null;
  let revision_created = false;
  let stale_approvals: string[] = [];
  if (head_sha !== null) {
    const r = await recordRevision(ctx, {
      reviewId,
      headSha: head_sha,
      baseline,
    });
    revision = r.revision.revision;
    revision_created = r.created;
    stale_approvals = r.stale_approvals.map((d) => d.decision_id);
  }

  // ---- findings projection ----
  const review = await readReviewJson(ctx, args.ticketId);
  let findings_created = 0;
  let findings_transitioned = 0;
  for (const t of review?.findings ?? []) {
    const threadId = String(t.thread_id ?? '');
    if (!threadId) continue;
    const findingId = findingIdFor(reviewId, threadId);
    const status = String(t.status ?? 'open') as ThreadStatus;
    const { created } = await upsertFinding(ctx, {
      workspace: ctx.workspace,
      org: session.org ?? null,
      finding_id: findingId,
      review_id: reviewId,
      revision: revision,
      subject: null,
      status: 'open',
      severity: (t.severity as ReviewFindingRow['severity']) ?? null,
      category: (t.category as ReviewFindingRow['category']) ?? null,
      kind: (t.kind as ReviewFindingRow['kind']) ?? null,
      thread_id: threadId,
      file: (t.file as string | null) ?? null,
      line: typeof t.line === 'number' ? t.line : null,
      symbol: (t.symbol as string | null) ?? null,
      repo: (t.repo as string | null) ?? null,
      body: String(t.body ?? ''),
      evidence: (t.evidence as string | null) ?? null,
      suggested_fix: (t.suggested_fix as string | null) ?? null,
      confidence: typeof t.confidence === 'number' ? t.confidence : null,
      blocking: false,
      security_category: null,
      affected_asset: null,
      exposure: null,
      policy_violated: null,
      author: (t.author as string | null) ?? 'review',
      created_at: null,
      updated_at: null,
    });
    if (created) findings_created += 1;

    const target = THREAD_TO_LIFECYCLE[status];
    if (target && target !== 'open') {
      const cur = await ctx.store.getReviewFinding({
        workspace: ctx.workspace,
        finding_id: findingId,
      });
      if (cur && cur.status !== target) {
        // Never regress the lifecycle (ready-for-verification →
        // in-remediation on a reopened thread is a real move; a
        // settled finding stays settled).
        try {
          await transitionFinding(ctx, {
            findingId,
            to: target,
            actor: 'review-sync',
            actorKind: 'system',
            rationale: `thread ${status} (review round sync)`,
          });
          findings_transitioned += 1;
        } catch {
          // A transition the machine forbids (e.g. settled finding)
          // is skipped, never faked — the audit row stays the record.
        }
      }
    }
  }

  return {
    review_id: reviewId,
    revision,
    revision_created,
    stale_approvals,
    findings_created,
    findings_transitioned,
  };
}

/**
 * Head-only sync for post-review push transitions (ci-fix,
 * comment-fix, rebase): records a revision when the bound head moved
 * so post-approval commits stale the bound approvals. No-op when the
 * subject has no session (nothing reviewed → nothing to stale).
 */
export async function syncReviewHead(
  ctx: StudioCtx & Pick<TransitionContext, 'rootPath'>,
  args: {
    ticketId: string;
    headFor?: (worktree: string, repo: string) => Promise<string | null>;
  },
): Promise<{ revision_created: boolean; stale_approvals: string[] }> {
  const reviewId = `rv-${args.ticketId}`;
  const session = await ctx.store.getReviewSession({
    workspace: ctx.workspace,
    review_id: reviewId,
  });
  if (!session) return { revision_created: false, stale_approvals: [] };
  const { head_sha } = await headShaForTicket(ctx, args.ticketId, {
    ...(args.headFor ? { headFor: args.headFor } : {}),
  });
  if (head_sha === null) {
    return { revision_created: false, stale_approvals: [] };
  }
  const baseline = await studioBaseline(ctx, args.ticketId);
  const r = await recordRevision(ctx, {
    reviewId,
    headSha: head_sha,
    baseline,
  });
  return {
    revision_created: r.created,
    stale_approvals: r.stale_approvals.map((d) => d.decision_id),
  };
}
