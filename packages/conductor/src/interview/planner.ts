/**
 * interview/planner.ts — the adaptive question planner (PRD §15.9).
 *
 * Deterministic eligibility first: only *required* slots that are
 * `missing` (a fresh gap) or `inferred` (a confirmation for approval)
 * are eligible — `known`/`not-applicable`/`deferred`/`conflicted` are
 * terminal for planning (a conflict routes to a decision item, never a
 * question). Then the LLM proposes the single best question, scored on
 * impact × uncertainty × relevance + answerability + effort — the
 * runner owns the composite and picks the slot.
 *
 * "User can't answer" is a first-class outcome: resolving a question
 * `unanswerable` defers the slot and the planner NEVER re-asks it.
 * A question is only emitted once the previous answer is durably
 * persisted (`assertAnswerOrder`).
 */
import type {
  InterviewMessageRow,
  QuestionCandidateRow,
} from '@sprint-runner/core';
import {
  type EligibleSlotForPrompt,
  buildQuestionPrompt,
  parseQuestionOutput,
} from './prompt.js';
import { appendMessage, requireSession, sessionWizard } from './session.js';
import { getSlot, listSlots, markSlot, requireSlotSpec } from './slots.js';
import {
  type InterviewCtx,
  InterviewError,
  type QuestionPurpose,
  type QuestionScores,
  type SlotState,
  asSlotState,
  conflict,
  invalid,
  notFound,
  questionIdFor,
} from './types.js';

/**
 * Deterministic composite of the component scores (§15.9). Materiality
 * (impact × uncertainty × relevance) gated by answerability and
 * discounted by effort — a zero answerability kills the candidate
 * (that is the `unanswerable` signal), high effort makes it less
 * attractive.
 */
export function scoreCandidate(s: Omit<QuestionScores, 'score'>): number {
  const materiality = s.impact * s.uncertainty * s.relevance;
  const score = materiality * s.answerability * (1 - s.effort);
  return Math.round(score * 1e6) / 1e6;
}

/** Read the component scores + purpose off a candidate row. */
export function scoresOf(
  c: QuestionCandidateRow,
): QuestionScores & { purpose?: string } {
  return (c.scores ?? {}) as unknown as QuestionScores & { purpose?: string };
}

export async function listQuestions(
  ctx: InterviewCtx,
  sessionId: string,
  status?: string,
): Promise<QuestionCandidateRow[]> {
  return ctx.store.listQuestionCandidates({
    workspace: ctx.workspace,
    session_id: sessionId,
    ...(status !== undefined ? { status } : {}),
  });
}

export async function getQuestion(
  ctx: InterviewCtx,
  sessionId: string,
  questionId: string,
): Promise<QuestionCandidateRow | null> {
  const rows = await listQuestions(ctx, sessionId);
  return rows.find((r) => r.question_id === questionId) ?? null;
}

// ---------------------------------------------------------------------------
// eligibility
// ---------------------------------------------------------------------------

interface Eligibility {
  eligible: EligibleSlotForPrompt[];
  /** All candidates for the session, grouped by slot. */
  bySlot: Map<string, QuestionCandidateRow[]>;
}

/** Slot states that are never re-asked once reached. */
const NON_REASKABLE: ReadonlySet<QuestionCandidateRow['status']> = new Set([
  'asked',
  'answered',
  'unanswerable',
  'skipped',
]);

/**
 * Deterministic eligibility: required slots with an open gap (`missing`),
 * minus anything already asked / unanswerable / skipped. `inferred`
 * slots are NOT re-asked — confirmation is an explicit human action
 * (`confirmSlot`), not another question (that keeps the
 * unnecessary-question rate at zero). Pure read — no writes.
 */
export async function computeEligibility(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<Eligibility> {
  const session = await requireSession(ctx, sessionId);
  const cfg = await sessionWizard(ctx, session);
  const rows = await listSlots(ctx, sessionId);
  const candidates = await listQuestions(ctx, sessionId);
  const bySlot = new Map<string, QuestionCandidateRow[]>();
  for (const c of candidates) {
    if (!c.slot) continue;
    const list = bySlot.get(c.slot) ?? [];
    list.push(c);
    bySlot.set(c.slot, list);
  }

  const eligible: EligibleSlotForPrompt[] = [];
  for (const spec of cfg.slots) {
    if (spec.required !== true) continue;
    const row = rows.find((r) => r.slot === spec.slot);
    if (!row) continue;
    const cands = bySlot.get(spec.slot) ?? [];
    if (cands.some((c) => NON_REASKABLE.has(c.status))) continue;

    if (row.state === 'missing') {
      eligible.push({
        slot: spec.slot,
        purpose: 'fill',
        state: row.state,
        ...(spec.label ? { label: spec.label } : {}),
        ...(spec.question ? { suggested: spec.question } : {}),
      });
    }
  }
  return { eligible, bySlot };
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

export interface PlanNextQuestionArgs {
  sessionId: string;
  /** Injected LLM surface — receives the planner prompt, returns raw
   *  text. Omit for the deterministic (no-LLM) proposal. */
  propose?: (prompt: string) => Promise<string>;
}

interface Proposal {
  slot: string;
  purpose: QuestionPurpose;
  question: string;
  scores: Omit<QuestionScores, 'score'>;
}

/** Deterministic proposal for one eligible slot (no LLM). */
function deterministicProposal(
  e: EligibleSlotForPrompt,
  impact: number,
): Proposal {
  const scores: Omit<QuestionScores, 'score'> = {
    impact,
    uncertainty: e.purpose === 'fill' ? 1 : 0.4,
    relevance: 1,
    answerability: 1,
    effort: e.purpose === 'fill' ? 0.3 : 0.2,
  };
  const question =
    e.suggested ??
    (e.purpose === 'confirm'
      ? `Earlier you said: "${e.value ?? 'your answer'}". Can we treat that as confirmed?`
      : `What should we know about "${e.label ?? e.slot}"?`);
  return { slot: e.slot, purpose: e.purpose, question, scores };
}

/**
 * Plan the next question. Persists scored `proposed` candidates (the
 * full eligible set, or the single LLM proposal when a `propose` seam
 * is injected) and returns the highest-scoring one — or `null` when
 * nothing materially changes the outcome (the wizard realizes it
 * doesn't need to ask).
 */
export async function planNextQuestion(
  ctx: InterviewCtx,
  args: PlanNextQuestionArgs,
): Promise<QuestionCandidateRow | null> {
  const session = await requireSession(ctx, args.sessionId);
  const cfg = await sessionWizard(ctx, session);
  const { eligible, bySlot } = await computeEligibility(ctx, args.sessionId);
  if (eligible.length === 0) return null;

  let proposals: Proposal[];
  if (args.propose) {
    const asked = (await listQuestions(ctx, args.sessionId)).map((c) => ({
      slot: c.slot ?? null,
      question: c.question,
      status: c.status,
    }));
    const prompt = buildQuestionPrompt({
      wizardId: cfg.wizard_id,
      subject: session.subject,
      ...(cfg.prompts?.planner ? { override: cfg.prompts.planner } : {}),
      eligible,
      asked,
    });
    const raw = await args.propose(prompt);
    const out = parseQuestionOutput(raw);
    const match = eligible.find((e) => e.slot === out.slot);
    if (!match) {
      throw invalid(
        `planner proposed slot '${out.slot}' which is not eligible (${eligible
          .map((e) => e.slot)
          .join(', ')})`,
      );
    }
    proposals = [
      {
        slot: out.slot,
        purpose: match.purpose,
        question: out.question,
        scores: out.scores,
      },
    ];
  } else {
    proposals = eligible.map((e) =>
      deterministicProposal(e, requireSlotSpec(cfg, e.slot).impact ?? 0.8),
    );
  }

  const ts = ctx.now().toISOString();
  const persisted: QuestionCandidateRow[] = [];
  for (const p of proposals) {
    const qid = questionIdFor(args.sessionId, p.slot, p.purpose);
    const existing = bySlot.get(p.slot)?.find((c) => c.question_id === qid);
    if (existing && existing.status !== 'proposed') continue;
    const score = scoreCandidate(p.scores);
    const row: QuestionCandidateRow = {
      workspace: ctx.workspace,
      org: null,
      session_id: args.sessionId,
      question_id: qid,
      slot: p.slot,
      question: p.question,
      scores: { ...p.scores, purpose: p.purpose, score },
      status: 'proposed',
      created_at: existing?.created_at ?? ts,
      resolved_at: null,
    };
    await ctx.store.upsertQuestionCandidate(row);
    persisted.push(row);
  }
  if (persisted.length === 0) return null;
  persisted.sort((a, b) => (scoresOf(b).score ?? 0) - (scoresOf(a).score ?? 0));
  return persisted[0] ?? null;
}

// ---------------------------------------------------------------------------
// ask / resolve
// ---------------------------------------------------------------------------

/**
 * Refuse to emit a next question before the previous answer is durably
 * persisted (§15.9). The transcript's last message for the branch must
 * not be an unanswered assistant question.
 */
export async function assertAnswerOrder(
  ctx: InterviewCtx,
  sessionId: string,
  branch?: string | null,
): Promise<void> {
  const messages = await ctx.store.listInterviewMessages({
    workspace: ctx.workspace,
    session_id: sessionId,
  });
  const scoped = messages.filter(
    (m) => (m.branch ?? null) === (branch ?? null),
  );
  const last = scoped[scoped.length - 1];
  if (last && last.role === 'assistant') {
    throw new InterviewError(
      'answer-order',
      `refusing to emit a new question on ${sessionId}: the previous question (seq ${last.seq}) has no durably-persisted answer yet`,
    );
  }
}

/**
 * Emit a proposed candidate as a question: mark it `asked` and append
 * the assistant turn. Fails closed (answer-order) when the prior
 * answer isn't persisted yet.
 */
export async function askQuestion(
  ctx: InterviewCtx,
  args: { sessionId: string; questionId?: string; branch?: string | null },
): Promise<{ candidate: QuestionCandidateRow; message: InterviewMessageRow }> {
  await requireSession(ctx, args.sessionId);
  await assertAnswerOrder(ctx, args.sessionId, args.branch ?? null);
  const candidate = args.questionId
    ? await getQuestion(ctx, args.sessionId, args.questionId)
    : ((await listQuestions(ctx, args.sessionId, 'proposed'))[0] ?? null);
  if (!candidate) {
    throw notFound(
      `no proposed question to ask on ${args.sessionId}${args.questionId ? ` (${args.questionId})` : ''}`,
    );
  }
  if (candidate.status !== 'proposed') {
    throw conflict(
      `question ${candidate.question_id} is ${candidate.status} — only a proposed candidate can be asked`,
    );
  }
  const asked: QuestionCandidateRow = {
    ...candidate,
    status: 'asked',
    resolved_at: null,
  };
  await ctx.store.upsertQuestionCandidate(asked);
  const message = await appendMessage(ctx, {
    sessionId: args.sessionId,
    role: 'assistant',
    content: candidate.question,
    branch: args.branch ?? null,
  });
  return { candidate: asked, message };
}

export type ResolveQuestionStatus = 'answered' | 'skipped' | 'unanswerable';

/**
 * Resolve a question. `answered` is normally driven by `submitAnswer`
 * (which persists the answer first); `skipped`/`unanswerable` defer
 * the slot — an `unanswerable` question is NEVER re-asked (§15.9).
 */
export async function resolveQuestion(
  ctx: InterviewCtx,
  args: {
    sessionId: string;
    questionId: string;
    status: ResolveQuestionStatus;
    reason?: string | null;
  },
): Promise<QuestionCandidateRow> {
  await requireSession(ctx, args.sessionId);
  const candidate = await getQuestion(ctx, args.sessionId, args.questionId);
  if (!candidate) {
    throw notFound(`no question ${args.questionId} on ${args.sessionId}`);
  }
  const ts = ctx.now().toISOString();
  const next: QuestionCandidateRow = {
    ...candidate,
    status: args.status,
    resolved_at: ts,
  };
  await ctx.store.upsertQuestionCandidate(next);

  if (args.status === 'unanswerable' || args.status === 'skipped') {
    if (candidate.slot) {
      const slot = await getSlot(ctx, args.sessionId, candidate.slot);
      if (slot && slot.state !== 'known' && slot.state !== 'not-applicable') {
        await markSlot(ctx, {
          sessionId: args.sessionId,
          slot: candidate.slot,
          state: 'deferred',
          value: args.reason ?? slot.value ?? null,
        });
      }
    }
    await appendMessage(ctx, {
      sessionId: args.sessionId,
      role: 'system',
      content: `[unresolved] ${args.status}: ${candidate.question}${
        args.reason ? ` — ${args.reason}` : ''
      }`,
    });
  }
  return next;
}

/** Convenience: the top proposed candidate for a session, if any. */
export async function topProposal(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<QuestionCandidateRow | null> {
  const proposed = await listQuestions(ctx, sessionId, 'proposed');
  proposed.sort((a, b) => (scoresOf(b).score ?? 0) - (scoresOf(a).score ?? 0));
  return proposed[0] ?? null;
}

/** Convenience: the pending (asked) candidate for a session/branch. */
export async function pendingQuestion(
  ctx: InterviewCtx,
  sessionId: string,
  branch?: string | null,
): Promise<QuestionCandidateRow | null> {
  const asked = await listQuestions(ctx, sessionId, 'asked');
  if (asked.length === 0) return null;
  if (branch === undefined) return asked[0] ?? null;
  const messages = await ctx.store.listInterviewMessages({
    workspace: ctx.workspace,
    session_id: sessionId,
  });
  const branchSeqs = new Set(
    messages
      .filter((m) => (m.branch ?? null) === (branch ?? null))
      .map((m) => m.content),
  );
  return asked.find((c) => branchSeqs.has(c.question)) ?? asked[0] ?? null;
}

/** Slot state summary helper for callers (read-only). */
export async function slotStates(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<Record<string, SlotState>> {
  const rows = await listSlots(ctx, sessionId);
  return Object.fromEntries(rows.map((r) => [r.slot, asSlotState(r.state)]));
}
