/**
 * assistant/turn.ts — the `POST …/assistant/messages` router (TDD
 * "turn pipeline"). Order is contract:
 *
 *   1. pending asked question on an active run → submitAnswer
 *      (answer persists first — the orchestrator's ordering rule);
 *   2. `/skill` → runs.startRun / critique checks;
 *   3. freeform → converse() (provider seam, fail-closed);
 *   4. after ANY turn → draftProposals for the turn's statements;
 *   5. contradictions → in-thread decision message + decisions rows.
 */
import { randomUUID } from 'node:crypto';
import type {
  BoardItem,
  BoardProposalRow,
  InterviewMessageRow,
  NoteKind,
  ProposalOp,
  QuestionCandidateRow,
  StatementIntent,
  StatementRow,
} from '@veto/core';
import {
  getSlot,
  listSlots,
  openDecisionsForSlots,
  pendingQuestion,
  submitAnswer,
} from '../interview/index.js';
import { converse, llmCritiqueFindings } from './converse.js';
import { type CritiqueFinding, critiqueChecks } from './coverage.js';
import { draftProposals } from './proposals.js';
import { activeRunBranch, activeRunPending, endRun, startRun } from './runs.js';
import { parseSkillCommand } from './skills.js';
import { appendThreadMessage, ensureThread } from './thread.js';
import { servesTargetIds } from './types.js';
import type { AssistantCtx } from './types.js';

/** TDD step-4 map — statement intent → sticky taxonomy. */
export const INTENT_TO_NOTE_KIND: Record<StatementIntent, NoteKind> = {
  want: 'want',
  requires: 'constraint',
  constraint: 'constraint',
  prohibits: 'avoid',
  avoid: 'avoid',
  problem: 'problem',
  question: 'question',
  decision: 'decision',
  observation: 'idea',
  assumption: 'idea',
};

const truncate = (s: string, n = 80) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** `/interview end` verbs (wp-167) — the slash-arg forms that close an
 *  active run instead of opening another. */
const END_WORDS = new Set([
  'end',
  'stop',
  'done',
  'finish',
  'cancel',
  'exit',
  'quit',
]);

/** Natural-language equivalents (wp-167) — full-match only, and only
 *  honored while a run is active; the same words as an ordinary
 *  answer outside a run keep their plain meaning. */
const END_PHRASES = new Set([
  '/end',
  'end interview',
  'end the interview',
  'end run',
  'end the run',
  'stop interview',
  'stop the interview',
  'finish interview',
  'finish the interview',
  'end it',
  'end this',
  "i'm done",
  "we're done",
  "that's all",
  'done',
]);

/** Natural end phrases match on normalized whole-text. */
const normalizeEnd = (text: string) =>
  text
    .toLowerCase()
    .replace(/[.!?\s]+$/u, '')
    .trim();

export interface TurnResult {
  /** Transcript rows appended this turn (user + assistant/system). */
  messages: InterviewMessageRow[];
  /** Proposals drafted this turn. */
  proposals: BoardProposalRow[];
  /** The asked question awaiting an answer, when one is open. */
  pending: QuestionCandidateRow | null;
}

/**
 * Statements → proposal ops (TDD step 4). Each statement becomes a
 * `create-item` via the intent map; with a concrete goal (an existing
 * serves-target) + member anchors, `serve` ops wire members onto it.
 * A serve to a not-yet-accepted goal is never guessed — the create
 * lands first, a later turn wires it.
 */
export function statementsToOps(
  statements: StatementRow[],
  opts: { anchors?: string[]; goalItemId?: string | null } = {},
): ProposalOp[] {
  const ops: ProposalOp[] = [];
  for (const s of statements) {
    ops.push({
      op: 'create-item',
      kind: 'note',
      note_kind:
        (s.intent &&
          (INTENT_TO_NOTE_KIND as Record<string, NoteKind>)[s.intent]) ||
        'idea',
      title: truncate(s.text),
      body: s.text,
    });
  }
  if (opts.goalItemId && opts.anchors) {
    for (const id of opts.anchors) {
      if (id !== opts.goalItemId) {
        ops.push({ op: 'serve', id, goal_item_id: opts.goalItemId });
      }
    }
  }
  return ops;
}

/** Open-decision ids for the session's slots (pre/post-turn diff). */
async function openDecisionIds(
  ctx: AssistantCtx,
  sessionId: string,
): Promise<Set<string>> {
  const slots = await listSlots(ctx, sessionId);
  return new Set(await openDecisionsForSlots(ctx, slots));
}

/** Recover an `/expand` run's selection from its scope marker. */
async function expandAnchors(
  ctx: AssistantCtx,
  sessionId: string,
  branch: string | null,
): Promise<string[] | undefined> {
  if (!branch) return undefined;
  const msgs = await ctx.store.listInterviewMessages({
    workspace: ctx.workspace,
    session_id: sessionId,
  });
  const scope = msgs
    .filter((m) => (m.branch ?? null) === branch && m.role === 'system')
    .map((m) => /^\[run scope\] expand scoped to (.+)$/.exec(m.content)?.[1])
    .find((s): s is string => !!s);
  return scope
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Route one user message. Returns everything the turn appended so the
 * route can answer `{messages, proposals, pending}`.
 */
export async function postMessage(
  ctx: AssistantCtx,
  args: {
    board: string;
    text: string;
    /** The human speaker — `created_by` on the user turn. */
    actor?: string;
    /** Coverage seed hook (wp-163 `seedBoardSlots` via the API). */
    seed?: (ctx: AssistantCtx, sessionId: string) => Promise<void>;
  },
): Promise<TurnResult> {
  const session = await ensureThread(ctx, args.board, {
    ...(args.seed ? { seed: args.seed } : {}),
  });
  const sessionId = session.session_id;
  const text = args.text.trim();
  const messages: InterviewMessageRow[] = [];
  let proposals: BoardProposalRow[] = [];
  let pending: QuestionCandidateRow | null = null;
  const actor = args.actor ?? ctx.actor;

  // ---- 2. skill commands -------------------------------------------------
  const cmd = parseSkillCommand(text);
  if (cmd) {
    messages.push(
      await appendThreadMessage(ctx, {
        sessionId,
        role: 'user',
        content: text,
        actor,
      }),
    );
    // `/interview end` (and synonyms, plus bare `/end`) close the
    // active run — wp-167 skills polish.
    if (
      ((cmd.skill === 'interview' || cmd.skill === 'expand') &&
        END_WORDS.has(cmd.arg.toLowerCase())) ||
      cmd.skill === 'end'
    ) {
      const active = await activeRunBranch(ctx, sessionId);
      if (!active) {
        messages.push(
          await appendThreadMessage(ctx, {
            sessionId,
            role: 'assistant',
            content: 'No interview is running — /interview opens one.',
          }),
        );
      } else {
        const ended = await endRun(ctx, {
          board: args.board,
          branch: active.branch,
        });
        messages.push(ended.message);
      }
      return { messages, proposals, pending };
    }
    if (cmd.skill === 'interview' || cmd.skill === 'expand') {
      if (cmd.skill === 'expand' && !cmd.arg) {
        messages.push(
          await appendThreadMessage(ctx, {
            sessionId,
            role: 'assistant',
            content:
              '/expand needs a selection — pick the cards to deepen and rerun it.',
          }),
        );
      } else {
        const run = await startRun(ctx, {
          board: args.board,
          skill: cmd.skill,
          scope: cmd.arg || null,
          ...(args.seed ? { seed: args.seed } : {}),
        });
        if (run.note) {
          messages.push(run.note); // zone-only /expand — explained, no branch
        } else if (run.asked) {
          messages.push(run.asked.message);
          pending = run.asked.candidate;
        } else {
          messages.push(
            await appendThreadMessage(ctx, {
              sessionId,
              role: 'assistant',
              content: `${cmd.skill} opened as ${run.branch?.branch ?? 'a run'} — nothing left to ask.`,
              ...(run.branch ? { branch: run.branch.branch } : {}),
            }),
          );
        }
      }
    } else if (cmd.skill === 'critique') {
      const [items, connectors] = await Promise.all([
        ctx.store.listBoardItems({
          workspace: ctx.workspace,
          board: args.board,
        }),
        ctx.store.listBoardConnectors({
          workspace: ctx.workspace,
          board: args.board,
        }),
      ]);
      const decisions = await openDecisionIds(ctx, sessionId);
      const findings = critiqueChecks({
        items,
        connectors,
        openDecisions: [...decisions],
      });
      // LLM augmentation (wp-167): model findings merge deduped against
      // the deterministic floor — never a write, never a repeat.
      const extra = await llmCritiqueFindings(ctx, {
        items: items ?? [],
        connectors: connectors ?? [],
        openDecisions: [...decisions],
        existing: findings,
      });
      const all: (CritiqueFinding & { model?: true })[] = [
        ...findings,
        ...extra.map((f) => ({ ...f, model: true as const })),
      ];
      const body =
        all.length === 0
          ? 'Critique: no findings — coverage, typing, and wiring all check out.'
          : `Critique — ${all.length} finding(s):\n${all
              .map(
                (f) =>
                  `- **${f.kind}**${f.item_id ? ` (${f.item_id})` : ''}: ${f.detail}${f.model ? ' ·model' : ''}`,
              )
              .join('\n')}`;
      messages.push(
        await appendThreadMessage(ctx, {
          sessionId,
          role: 'assistant',
          content: body,
        }),
      );
    } else {
      messages.push(
        await appendThreadMessage(ctx, {
          sessionId,
          role: 'assistant',
          content: `Unknown command \`/${cmd.skill}\` — I know /interview, /expand, /critique.`,
        }),
      );
    }
    return { messages, proposals, pending };
  }

  // ---- 1b. natural run end (wp-167) — honored only while a run is
  // active, and BEFORE the pending-question route: "end the interview"
  // is an instruction, not an answer.
  if (END_PHRASES.has(normalizeEnd(text))) {
    const active = await activeRunBranch(ctx, sessionId);
    if (active) {
      messages.push(
        await appendThreadMessage(ctx, {
          sessionId,
          role: 'user',
          content: text,
          actor,
        }),
      );
      const ended = await endRun(ctx, {
        board: args.board,
        branch: active.branch,
      });
      messages.push(ended.message);
      return { messages, proposals, pending };
    }
  }

  // ---- 1. pending question on an active run ------------------------------
  const run = await activeRunPending(ctx, sessionId);
  const unbranched = run ? null : await pendingQuestion(ctx, sessionId, null);
  const pendingQ = run?.question ?? unbranched;
  const branch = run?.branch ?? null;
  const before = await openDecisionIds(ctx, sessionId);

  if (pendingQ) {
    const res = await submitAnswer(ctx, {
      sessionId,
      questionId: pendingQ.question_id,
      answer: text,
      branch,
      createdBy: actor,
      ...(ctx.extract ? { extract: ctx.extract } : {}),
      plan: true,
    });
    messages.push(res.message);
    if (res.next) {
      messages.push(res.next.message);
      pending = res.next.candidate;
    }
    // 4. extracted statements → proposal ops. `serve` wiring needs a
    // concrete goal: an `/expand` selection contributes anchors, and a
    // serves-target among them is the goal (the goal sticky itself is
    // never rewired).
    if (res.statements.length > 0) {
      const goalSlot = await getSlot(ctx, sessionId, 'goals').catch(() => null);
      const goalsBound = res.statements.some((s) =>
        goalSlot?.statement_refs?.includes(s.statement_id),
      );
      const anchors = await expandAnchors(ctx, sessionId, branch);
      const items = await ctx.store.listBoardItems({
        workspace: ctx.workspace,
        board: args.board,
      });
      const goals = servesTargetIds(items);
      const goalItemId = goalsBound
        ? (anchors?.find((id) => goals.has(id)) ?? null)
        : null;
      const drafted = await draftProposals(ctx, {
        board: args.board,
        sessionId,
        ops: statementsToOps(res.statements, {
          ...(goalsBound && anchors ? { anchors } : {}),
          goalItemId,
        }),
        seq: res.message.seq,
        provenance: {
          statement_ids: res.statements.map((s) => s.statement_id),
          branch,
        },
        actor: 'assistant',
      });
      proposals = drafted.proposals;
      if (drafted.dropped.length > 0) {
        messages.push(
          await appendThreadMessage(ctx, {
            sessionId,
            role: 'system',
            content: `[dropped ${drafted.dropped.length} malformed op(s)] — nothing was guessed`,
            branch,
          }),
        );
      }
    }
    // 5. contradictions surfaced in-thread.
    const after = await openDecisionIds(ctx, sessionId);
    const fresh = [...after].filter((d) => !before.has(d));
    if (fresh.length > 0) {
      messages.push(
        await appendThreadMessage(ctx, {
          sessionId,
          role: 'assistant',
          content: `That conflicts with something on the board — ${fresh
            .map((d) => `\`${d}\``)
            .join(
              ', ',
            )}. Which stands? (the ruling rides statement_decisions; the losing side gets a supersede proposal.)`,
          branch,
        }),
      );
    }
    return { messages, proposals, pending };
  }

  // ---- 3. freeform → converse ---------------------------------------------
  const userTurn = await appendThreadMessage(ctx, {
    sessionId,
    role: 'user',
    content: text,
    actor,
  });
  messages.push(userTurn);
  const decisions = await openDecisionIds(ctx, sessionId);
  const out = await converse(ctx, {
    board: args.board,
    sessionId,
    text,
    openDecisions: [...decisions],
  });
  messages.push(
    await appendThreadMessage(ctx, {
      sessionId,
      role: 'assistant',
      content: out.reply,
    }),
  );
  if (out.ops.length > 0) {
    // One turn = one checkpoint batch: multi-op replies (frame +
    // contents + connectors) decide together via accept-all, and the
    // shared batch_id is the temp_id alias scope (D69).
    const drafted = await draftProposals(ctx, {
      board: args.board,
      sessionId,
      ops: out.ops,
      seq: userTurn.seq,
      batchId: `batch-${randomUUID().slice(0, 12)}`,
      actor: 'assistant',
    });
    proposals = drafted.proposals;
    if (drafted.dropped.length > 0) {
      messages.push(
        await appendThreadMessage(ctx, {
          sessionId,
          role: 'system',
          content: `[dropped ${drafted.dropped.length} malformed op(s)] — nothing was guessed`,
        }),
      );
    }
  }
  return { messages, proposals, pending };
}

/** Narrow-screen list actions also go through here — same legality. */
export type { BoardItem };
