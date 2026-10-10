/**
 * assistant/thread.ts — the board's durable assistant thread
 * (BOARD-CHAT-PRD R1/R9; TDD contract amendment 1).
 *
 * One shared `interview_sessions` row per board — `mode:
 * 'conversation'`, wizard `board-<board_type>` (or `board-generic`),
 * deterministic session id so every member lands on the same thread.
 * Per-turn actor attribution rides `interview_messages.created_by`
 * (wp-161); the existing `appendMessage` helper can't carry it, so the
 * thread appends through the store directly.
 */
import type {
  AssistantSkillInfo,
  BoardProposalRow,
  BoardRow,
  InterviewMessageRow,
  InterviewSessionRow,
  QuestionCandidateRow,
} from '@veto/core';
import {
  getSession,
  listBranches,
  pendingQuestion,
  sessionIdFor,
  startSession,
  transcript,
} from '../interview/index.js';
import type { InterviewError } from '../interview/index.js';
import { notFound } from '../interview/index.js';
import { listSlots, openDecisionsForSlots } from '../interview/index.js';
import type { AssistantChip } from './skills.js';
import { ASSISTANT_SKILLS_INFO, suggestChips } from './skills.js';
import type { AssistantCtx } from './types.js';

/** `board-<type>` per BOARD_TYPES; `board-generic` for NULL. */
export function boardWizardId(board: BoardRow): string {
  return board.board_type ? `board-${board.board_type}` : 'board-generic';
}

/** One deterministic session per board — the shared thread. */
export function threadSessionId(board: BoardRow): string {
  return sessionIdFor(boardWizardId(board), `board:${board.board}`);
}

/**
 * Get-or-create the board's thread. `seed` is the coverage hook — the
 * API layer wires wp-163's `seedBoardSlots` through it (GET paths stay
 * read-only by leaving it unset).
 */
export async function ensureThread(
  ctx: AssistantCtx,
  boardSlug: string,
  opts?: {
    seed?: (ctx: AssistantCtx, sessionId: string) => Promise<void>;
  },
): Promise<InterviewSessionRow> {
  const board = await ctx.store.getBoard(ctx.workspace, boardSlug);
  if (!board) {
    throw notFound(`no board '${boardSlug}' in ${ctx.workspace}`);
  }
  const session = await startSession(ctx, {
    wizardId: boardWizardId(board),
    subject: `board:${boardSlug}`,
    sessionId: threadSessionId(board),
    mode: 'conversation',
  });
  if (opts?.seed) await opts.seed(ctx, session.session_id);
  return session;
}

/**
 * Append a turn with `created_by` attribution. `actor` is the human
 * speaker on user turns and `'assistant'` on assistant turns; system
 * rows record the engine (`'assistant'`).
 */
export async function appendThreadMessage(
  ctx: AssistantCtx,
  args: {
    sessionId: string;
    role: InterviewMessageRow['role'];
    content: string;
    branch?: string | null;
    actor?: string | null;
  },
): Promise<InterviewMessageRow> {
  const ts = ctx.now().toISOString();
  const seq = await ctx.store.appendInterviewMessage({
    workspace: ctx.workspace,
    org: null,
    session_id: args.sessionId,
    branch: args.branch ?? null,
    role: args.role,
    content: args.content,
    created_by: args.actor ?? (args.role === 'user' ? ctx.actor : 'assistant'),
    created_at: ts,
  });
  if (args.role === 'assistant') {
    // Audit row for the durable transcript turn (EVENT_NAMES — the SSE
    // hint rides `interview_updated`/`board_proposal`, not this).
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: null,
      ts,
      stage: 'board-assistant',
      actor_type: 'agent',
      actor_id: 'assistant',
      event: 'assistant_message',
      run: null,
      refs: [`interview:${args.sessionId}`],
      data: { seq, branch: args.branch ?? null },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
  }
  return {
    workspace: ctx.workspace,
    org: null,
    session_id: args.sessionId,
    seq,
    branch: args.branch ?? null,
    role: args.role,
    content: args.content,
    created_by: args.actor ?? (args.role === 'user' ? ctx.actor : 'assistant'),
    created_at: ts,
  };
}

/** The one-load panel payload (TDD REST table, GET …/assistant).
 *  `session` is null until the first mutation creates the thread —
 *  GET stays read-only (no writes on read paths). */
export interface AssistantPanelState {
  session: InterviewSessionRow | null;
  messages: InterviewMessageRow[];
  proposals: BoardProposalRow[];
  skills: AssistantSkillInfo[];
  chips: AssistantChip[];
  pending_question: QuestionCandidateRow | null;
  /** 'configured' | 'absent' — the degradation banner's source. */
  model: 'configured' | 'absent';
  /** The currently-active run branch, when one is open. */
  active_run: string | null;
}

export async function panelState(
  ctx: AssistantCtx,
  boardSlug: string,
): Promise<AssistantPanelState> {
  const board = await ctx.store.getBoard(ctx.workspace, boardSlug);
  if (!board) {
    throw notFound(`no board '${boardSlug}' in ${ctx.workspace}`);
  }
  const session = await getSession(ctx, threadSessionId(board));
  const [proposals, items] = await Promise.all([
    ctx.store.listBoardProposals({
      workspace: ctx.workspace,
      board: boardSlug,
    }),
    ctx.store.listBoardItems({ workspace: ctx.workspace, board: boardSlug }),
  ]);
  if (!session) {
    return {
      session: null,
      messages: [],
      proposals,
      skills: ASSISTANT_SKILLS_INFO,
      chips: suggestChips({
        items: items ?? [],
        openDecisions: [],
        draftReady: false,
      }),
      pending_question: null,
      model: ctx.provider ? 'configured' : 'absent',
      active_run: null,
    };
  }
  const [messages, branches, slots] = await Promise.all([
    transcript(ctx, session.session_id),
    listBranches(ctx, session.session_id),
    listSlots(ctx, session.session_id),
  ]);
  const openDecisions = await openDecisionsForSlots(ctx, slots);
  const active = branches.find(
    (b) =>
      b.status === 'active' && (b.role === 'interview' || b.role === 'expand'),
  );
  const pending = await pendingQuestion(
    ctx,
    session.session_id,
    active?.branch ?? null,
  );
  return {
    session,
    messages,
    proposals,
    skills: ASSISTANT_SKILLS_INFO,
    chips: suggestChips({
      items: items ?? [],
      openDecisions,
      draftReady: session.draft_ready === true,
    }),
    pending_question: pending,
    model: ctx.provider ? 'configured' : 'absent',
    active_run: active?.branch ?? null,
  };
}
