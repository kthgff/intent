/**
 * assistant/runs.ts — `/interview` + `/expand` run lifecycle (TDD
 * "Skills"). Runs are `interview_branches` on the board's shared
 * thread — `run-N`, `role: 'interview'|'expand'`, `active → merged`.
 * The user controls when a run ends; `endRun` merges the branch and
 * posts the readiness summary (a `run_synthesis` action rides along
 * when `draft_ready`).
 */
import type {
  InterviewBranchRow,
  InterviewMessageRow,
  InterviewSessionRow,
  QuestionCandidateRow,
} from '@veto/core';
import {
  askQuestion,
  createBranch,
  evaluateReadiness,
  listBranches,
  mergeBranch,
  pendingQuestion,
  planNextQuestion,
} from '../interview/index.js';
import type { MergeResult, ReadinessReport } from '../interview/index.js';
import { conflict } from '../interview/index.js';
import { boardCoverage } from './coverage.js';
import {
  appendThreadMessage,
  ensureThread,
  threadSessionId,
} from './thread.js';
import type { AssistantCtx } from './types.js';

/** `/expand` targets content items — zones are containers, not
 *  subjects (wp-167 polish: a zone-only selection explains rather
 *  than running an empty interview). */
const EXPANDABLE_KINDS = new Set(['note', 'text', 'link']);

export interface RunStarted {
  session: InterviewSessionRow;
  /** The opened branch — null when the scope resolved to nothing
   *  expandable (the explanation was posted in-thread instead). */
  branch: InterviewBranchRow | null;
  /** The first asked question (plan → ask), or null when the wizard
   *  has nothing left to ask. */
  asked: {
    candidate: QuestionCandidateRow;
    message: InterviewMessageRow;
  } | null;
  /** An in-thread explanation posted INSTEAD of branching (e.g. a
   *  zone-only /expand scope) — callers include it in the turn's
   *  message list when present. */
  note?: InterviewMessageRow;
}

/**
 * Open a run branch and ask its first question. `scope` is the
 * `/expand` selection (item ids) or an `/interview` subject hint —
 * recorded as a system marker (branches carry no metadata column).
 * `seed` re-runs coverage seeding (wp-163's `seedBoardSlots`) each run
 * start.
 */
export async function startRun(
  ctx: AssistantCtx,
  args: {
    board: string;
    skill: 'interview' | 'expand';
    scope?: string | null;
    seed?: (ctx: AssistantCtx, sessionId: string) => Promise<void>;
  },
): Promise<RunStarted> {
  const session = await ensureThread(ctx, args.board, {
    ...(args.seed ? { seed: args.seed } : {}),
  });
  const branches = await listBranches(ctx, session.session_id);
  const active = branches.find(
    (b) =>
      b.status === 'active' && (b.role === 'interview' || b.role === 'expand'),
  );
  if (active) {
    throw conflict(
      `run '${active.branch}' is already active — end it before starting another`,
    );
  }

  // `/expand` scope resolves against real items: zones and unknown ids
  // drop out (wp-167); an explicit scope that keeps nothing explains
  // in-thread instead of opening an empty branch.
  let scope = args.scope ?? null;
  if (args.skill === 'expand' && scope) {
    const items = await ctx.store.listBoardItems({
      workspace: ctx.workspace,
      board: args.board,
    });
    const expandable = new Set(
      (items ?? [])
        .filter((i) => i.status !== 'discarded' && EXPANDABLE_KINDS.has(i.kind))
        .map((i) => i.id),
    );
    const kept = scope.split(/[\s,]+/).filter((id) => id && expandable.has(id));
    if (kept.length === 0) {
      const note = await appendThreadMessage(ctx, {
        sessionId: session.session_id,
        role: 'assistant',
        content:
          '/expand needs expandable cards — zones are containers, not subjects. Select notes/text/links and rerun it.',
      });
      return { session, branch: null, asked: null, note };
    }
    scope = kept.join(',');
  }

  const runs = branches.filter(
    (b) => b.role === 'interview' || b.role === 'expand',
  ).length;
  const branch = await createBranch(ctx, {
    sessionId: session.session_id,
    branch: `run-${runs + 1}`,
    role: args.skill,
  });
  if (scope) {
    await appendThreadMessage(ctx, {
      sessionId: session.session_id,
      role: 'system',
      content: `[run scope] ${args.skill} scoped to ${scope}`,
      branch: branch.branch,
    });
  }
  const candidate = await planNextQuestion(ctx, {
    sessionId: session.session_id,
    ...(ctx.propose ? { propose: ctx.propose } : {}),
  });
  const asked = candidate
    ? await askQuestion(ctx, {
        sessionId: session.session_id,
        questionId: candidate.question_id,
        branch: branch.branch,
        createdBy: 'assistant',
      })
    : null;
  return { session, branch, asked };
}

export interface RunEnded {
  merged: MergeResult;
  readiness: ReadinessReport;
  /** The in-thread summary message. */
  message: InterviewMessageRow;
  /** `run_synthesis` when draft-ready — the one-click chip's action. */
  action: 'run_synthesis' | null;
}

/** Merge the run branch, then post the readiness + coverage summary. */
export async function endRun(
  ctx: AssistantCtx,
  args: { board: string; branch: string },
): Promise<RunEnded> {
  const board = await ctx.store.getBoard(ctx.workspace, args.board);
  if (!board) throw conflict(`no board '${args.board}'`);
  const sessionId = threadSessionId(board);
  const merged = await mergeBranch(ctx, { sessionId, branch: args.branch });
  const readiness = await evaluateReadiness(ctx, sessionId);
  const items = await ctx.store.listBoardItems({
    workspace: ctx.workspace,
    board: args.board,
  });
  const cov = boardCoverage(items ?? []);
  const lines = [
    `Run ${args.branch} merged — ${merged.merged_statements.length} statement(s) folded in${
      merged.conflicts.length > 0
        ? `, ${merged.conflicts.length} disagreement(s) routed to decisions`
        : ''
    }.`,
    `Coverage: ${cov.typed}/${cov.total} typed · ${cov.goals} goal(s) · ${cov.open_questions} open question(s) · ${cov.orphans} orphan(s).`,
    readiness.draft_ready
      ? 'The board looks synthesis-ready — run synthesis when you are.'
      : `Not yet synthesis-ready: ${
          readiness.draft_blockers.map((b) => b.slot).join(', ') ||
          'open items remain'
        }.`,
  ];
  const action = readiness.draft_ready ? 'run_synthesis' : null;
  const message = await appendThreadMessage(ctx, {
    sessionId,
    role: 'assistant',
    content: lines.join('\n'),
  });
  return { merged, readiness, message, action };
}

/** The currently-active interview/expand branch row, if any. */
export async function activeRunBranch(
  ctx: AssistantCtx,
  sessionId: string,
): Promise<InterviewBranchRow | null> {
  const branches = await listBranches(ctx, sessionId);
  return (
    branches.find(
      (b) =>
        b.status === 'active' &&
        (b.role === 'interview' || b.role === 'expand'),
    ) ?? null
  );
}

/** Pending asked question for the active run branch, if any. */
export async function activeRunPending(
  ctx: AssistantCtx,
  sessionId: string,
): Promise<{ branch: string; question: QuestionCandidateRow } | null> {
  const active = await activeRunBranch(ctx, sessionId);
  if (!active) return null;
  const q = await pendingQuestion(ctx, sessionId, active.branch);
  return q ? { branch: active.branch, question: q } : null;
}
