/**
 * interview/answer.ts — the answer turn (PRD §15.9).
 *
 * The ordering rule is absolute: **the answer is durably persisted
 * before any next question is generated**. `submitAnswer` therefore:
 *
 *   1. append the user turn to `interview_messages` (store-assigned
 *      seq) — durable;
 *   2. resolve the pending question as `answered`;
 *   3. interpret the answer into statements via wp-143 (`runExtraction`
 *      with an injected LLM seam, or a verbatim one-statement fallback
 *      when no model is available) and bind them to the target slots;
 *   4. refresh readiness;
 *   5. only THEN plan + ask the next question (`askQuestion` re-checks
 *      the order guard).
 *
 * One answer may satisfy many slots (§15.9) — pass `slots`.
 */
import type {
  InterviewMessageRow,
  KnowledgeSlotRow,
  QuestionCandidateRow,
  StatementRow,
} from '@veto/core';
import {
  ingestExtraction,
  runExtraction,
  sourceFromInterviewMessage,
} from '../semantics/index.js';
import {
  askQuestion,
  getQuestion,
  planNextQuestion,
  resolveQuestion,
} from './planner.js';
import {
  appendMessage,
  refreshReadiness,
  requireSession,
  sessionWizard,
} from './session.js';
import { bindStatementsToSlots, requireSlotSpec } from './slots.js';
import { type InterviewCtx, type ReadinessReport, invalid } from './types.js';

export interface SubmitAnswerArgs {
  sessionId: string;
  /** The user's answer text — preserved verbatim as evidence. */
  answer: string;
  /** The question being answered (its slot is the default target). */
  questionId?: string;
  /** Explicit target slot (conversation mode without a question). */
  slot?: string;
  /** Multiple target slots — one answer may satisfy many (§15.9). */
  slots?: string[];
  branch?: string | null;
  /** LLM extraction seam (wp-143). Omit for the verbatim fallback. */
  extract?: (prompt: string) => Promise<string>;
  /** Plan + ask the next question after persisting (default true). */
  plan?: boolean;
}

export interface SubmitAnswerResult {
  /** The durable user turn (seq is store-assigned). */
  message: InterviewMessageRow;
  statements: StatementRow[];
  slots: KnowledgeSlotRow[];
  /** The next asked question, or null when nothing else is needed. */
  next: {
    candidate: QuestionCandidateRow;
    message: InterviewMessageRow;
  } | null;
  readiness: ReadinessReport;
}

/** Verbatim one-statement payload — the no-LLM fallback. */
function verbatimPayload(answer: string) {
  return {
    schema: 1 as const,
    statements: [
      {
        key: 'answer',
        text: answer,
        source: 0,
        source_text: answer,
        intent: 'observation' as const,
      },
    ],
  };
}

/**
 * Record an answer. Returns the durable message, the statements it
 * produced, the updated slots, readiness, and the next question (only
 * generated after the answer is persisted).
 */
export async function submitAnswer(
  ctx: InterviewCtx,
  args: SubmitAnswerArgs,
): Promise<SubmitAnswerResult> {
  const session = await requireSession(ctx, args.sessionId);
  const cfg = await sessionWizard(ctx, session);
  const answer = args.answer.trim();
  if (answer.length === 0) {
    throw invalid('submitAnswer: answer is empty');
  }

  // Resolve target slots from the question and/or explicit args.
  const question = args.questionId
    ? await getQuestion(ctx, args.sessionId, args.questionId)
    : null;
  if (args.questionId && !question) {
    throw invalid(
      `submitAnswer: no question ${args.questionId} on ${args.sessionId}`,
    );
  }
  const targets = new Set<string>();
  for (const s of args.slots ?? []) targets.add(s);
  if (args.slot) targets.add(args.slot);
  if (question?.slot) targets.add(question.slot);
  for (const s of targets) requireSlotSpec(cfg, s);

  // 1. Persist the answer FIRST (ordering rule).
  const message = await appendMessage(ctx, {
    sessionId: args.sessionId,
    role: 'user',
    content: answer,
    branch: args.branch ?? null,
  });

  // 2. Resolve the pending question.
  if (question) {
    await resolveQuestion(ctx, {
      sessionId: args.sessionId,
      questionId: question.question_id,
      status: 'answered',
    });
  }

  // 3. Interpret the answer → statements (wp-143).
  const source = sourceFromInterviewMessage(message);
  const subject = `session:${args.sessionId}`;
  const ingestArgs = {
    workspace: ctx.workspace,
    org: null,
    subject,
    sources: [source],
    actor: ctx.actor,
    now: ctx.now,
  };
  const result = args.extract
    ? await runExtraction(ctx.store, { ...ingestArgs, extract: args.extract })
    : await ingestExtraction(ctx.store, {
        ...ingestArgs,
        output: verbatimPayload(answer),
      });
  const statements = result.statements;

  // 4. Bind + refresh readiness.
  const slots =
    targets.size > 0
      ? await bindStatementsToSlots(
          ctx,
          args.sessionId,
          [...targets],
          statements,
        )
      : [];
  const readiness = await refreshReadiness(ctx, args.sessionId);

  // 5. Only now may the next question be generated.
  let next: SubmitAnswerResult['next'] = null;
  if (args.plan !== false) {
    const candidate = await planNextQuestion(ctx, {
      sessionId: args.sessionId,
    });
    if (candidate) {
      const asked = await askQuestion(ctx, {
        sessionId: args.sessionId,
        questionId: candidate.question_id,
        branch: args.branch ?? null,
      });
      next = { candidate: asked.candidate, message: asked.message };
    }
  }

  return { message, statements, slots, next, readiness };
}

/**
 * Answer the currently-pending question (the common turn): resolves the
 * asked candidate, persists the answer, and returns the next question.
 */
export async function submitPendingAnswer(
  ctx: InterviewCtx,
  args: Omit<SubmitAnswerArgs, 'questionId' | 'slot' | 'slots'> & {
    questionId: string;
  },
): Promise<SubmitAnswerResult> {
  return submitAnswer(ctx, args);
}
