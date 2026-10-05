/**
 * wp-145 tests — Interview Orchestrator (PRD §15.9).
 *
 * Real PostgresStore on PGlite; the engine functions run directly (the
 * API layer is a thin shell over the same calls). Covers:
 *   - versioned wizard defs (register/append-only/parse fail-closed)
 *     and the three MVP wizards;
 *   - the slot state machine (missing → inferred → known, deferred,
 *     conflicted) backed by wp-143 statements;
 *   - the adaptive planner: deterministic eligibility + scored AI
 *     proposal, `unanswerable` never re-asked, no repeat questions;
 *   - the answer-before-question persistence ordering;
 *   - the two thresholds (draft_ready ≠ approval_ready);
 *   - snapshots + the resume change briefing;
 *   - multi-stakeholder branches merging with attribution and
 *     disagreement → decision item;
 *   - the wizard golden set (extraction precision, no repeats, no
 *     unsupported binding statements).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  InterviewError,
  askQuestion,
  computeEligibility,
  confirmSlot,
  createBranch,
  evaluateReadiness,
  getSlot,
  listQuestions,
  loadWizardConfig,
  mergeBranch,
  parseQuestionOutput,
  parseWizardConfig,
  planNextQuestion,
  registerWizard,
  resolveQuestion,
  resume,
  scoreCandidate,
  seedMvpWizards,
  setMode,
  snapshot,
  startSession,
  submitAnswer,
  transcript,
} from '../src/interview/index.js';
import type { InterviewCtx } from '../src/interview/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let dir: string;
let store: PostgresStore;
let clock: number;

function ctx(): InterviewCtx {
  return {
    store,
    workspace: WS,
    actor: 'keith',
    now: () => new Date(clock),
  };
}

const tick = (ms = 60_000) => {
  clock += ms;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-interview-'));
  store = await PostgresStore.connect('pglite:');
  clock = T0;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A deterministic extraction seam: parses the answer out of the
 * wp-143 prompt and returns the caller's statements for it. Keeps
 * `source_text` verbatim (the ingest pipeline span-checks it).
 */
function makeExtractor(
  build: (answer: string) => Record<string, unknown>[],
) {
  return async (prompt: string): Promise<string> => {
    const m = /```\n([\s\S]*?)\n```/.exec(prompt);
    const answer = m?.[1] ?? '';
    return JSON.stringify({ schema: 1, statements: build(answer) });
  };
}

/** Drive a wizard to completion, returning the slots asked, in order. */
async function drive(
  c: InterviewCtx,
  sessionId: string,
  extract?: (prompt: string) => Promise<string>,
): Promise<string[]> {
  const trace: string[] = [];
  let candidate = await planNextQuestion(c, { sessionId });
  while (candidate) {
    await askQuestion(c, { sessionId, questionId: candidate.question_id });
    trace.push(candidate.slot as string);
    await submitAnswer(c, {
      sessionId,
      questionId: candidate.question_id,
      answer: `answer about ${candidate.slot}`,
      plan: false,
      ...(extract ? { extract } : {}),
    });
    candidate = await planNextQuestion(c, { sessionId });
  }
  return trace;
}

// ---------------------------------------------------------------------------
// wizard definitions
// ---------------------------------------------------------------------------

describe('wizard definitions', () => {
  it('seeds the three MVP wizards (idempotent)', async () => {
    const c = ctx();
    const first = await seedMvpWizards(c);
    expect(first.map((r) => r.version.wizard_id).sort()).toEqual([
      'requirements-discovery',
      'solution-discovery',
      'tdd-discovery',
    ]);
    const again = await seedMvpWizards(c);
    expect(again.every((r) => r.created === false)).toBe(true);
    const cfg = await loadWizardConfig(c, 'solution-discovery');
    expect(cfg.version).toBe(1);
    expect(cfg.slots.some((s) => s.required === true)).toBe(true);
  });

  it('is append-only — a new version, never an in-place edit', async () => {
    const c = ctx();
    await registerWizard(c, {
      wizard_id: 'w',
      version: 1,
      slots: [{ slot: 'a', required: true }],
    });
    // Same version, different definition → refused.
    await expect(
      registerWizard(c, {
        wizard_id: 'w',
        version: 1,
        slots: [{ slot: 'b', required: true }],
      }),
    ).rejects.toThrow(/append-only/);
    // A new version is fine and moves current_version.
    await registerWizard(c, {
      wizard_id: 'w',
      version: 2,
      slots: [{ slot: 'a', required: true }, { slot: 'b', required: true }],
    });
    const def = await store.getWizardDefinition({
      workspace: WS,
      wizard_id: 'w',
    });
    expect(def?.current_version).toBe(2);
    expect(await store.listWizardVersions({ workspace: WS, wizard_id: 'w' }))
      .toHaveLength(2);
  });

  it('fails closed on a malformed config', () => {
    expect(() =>
      parseWizardConfig({
        wizard_id: 'x',
        version: 1,
        slots: [{ slot: 'a', required: true }, { slot: 'a' }],
      }),
    ).toThrow(/duplicate slot/);
    expect(() =>
      parseWizardConfig({
        wizard_id: 'x',
        version: 1,
        slots: [{ slot: 'a' }],
      }),
    ).toThrow(/at least one required/);
    expect(() =>
      parseWizardConfig({
        wizard_id: 'x',
        version: 1,
        slots: [{ slot: 'a', required: true }],
        thresholds: { draft: ['known'], approval: ['inferred'] },
      }),
    ).toThrow(/stricter than draft/);
    expect(() => parseWizardConfig({ wizard_id: 'x' })).toThrow(/schema/);
  });
});

// ---------------------------------------------------------------------------
// sessions + slots
// ---------------------------------------------------------------------------

describe('sessions + slots', () => {
  it('seeds required slots missing and optional slots not-applicable', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const session = await startSession(c, { wizardId: 'solution-discovery' });
    const rows = await store.listKnowledgeSlots({
      workspace: WS,
      session_id: session.session_id,
    });
    const problem = rows.find((r) => r.slot === 'problem');
    const nonGoals = rows.find((r) => r.slot === 'non-goals');
    expect(problem?.state).toBe('missing');
    expect(nonGoals?.state).toBe('not-applicable');
  });

  it('switches input mode without loss', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'tdd-discovery' });
    const switched = await setMode(c, {
      sessionId: s.session_id,
      mode: 'bulk',
    });
    expect(switched.mode).toBe('bulk');
    const msgs = await transcript(c, s.session_id);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('starts neither ready (required slots are missing)', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'tdd-discovery' });
    const report = await evaluateReadiness(c, s.session_id);
    expect(report.draft_ready).toBe(false);
    expect(report.approval_ready).toBe(false);
    expect(report.draft_blockers.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// slot state machine (statement-backed)
// ---------------------------------------------------------------------------

describe('slot state machine', () => {
  it('missing → inferred on an AI answer; known only after human confirm', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'solution-discovery' });
    const extract = makeExtractor((answer) => [
      {
        key: 'k',
        text: 'Password resets are slow',
        source_text: answer,
        intent: 'problem',
      },
    ]);
    const q = await planNextQuestion(c, { sessionId: s.session_id });
    await askQuestion(c, { sessionId: s.session_id, questionId: q?.question_id });
    await submitAnswer(c, {
      sessionId: s.session_id,
      questionId: q?.question_id,
      answer: 'Password resets take 3 days',
      extract,
      plan: false,
    });
    const slot = await getSlot(c, s.session_id, 'problem');
    expect(slot?.state).toBe('inferred');
    expect(slot?.statement_refs?.length).toBe(1);

    // A human confirmation upgrades the slot to known (stakeholder).
    const confirmed = await confirmSlot(c, {
      sessionId: s.session_id,
      slot: 'problem',
    });
    expect(confirmed.state).toBe('known');
    const stmt = await store.getStatement({
      workspace: WS,
      statement_id: (slot?.statement_refs ?? [])[0] as string,
    });
    expect(stmt?.status).toBe('confirmed');
    expect(stmt?.provenance).toBe('stakeholder-verified');
  });

  it('an unanswerable question defers the slot and is never re-asked', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'solution-discovery' });
    const q = await planNextQuestion(c, { sessionId: s.session_id });
    expect(q?.slot).toBe('problem');
    await askQuestion(c, { sessionId: s.session_id, questionId: q?.question_id });
    await resolveQuestion(c, {
      sessionId: s.session_id,
      questionId: q?.question_id as string,
      status: 'unanswerable',
      reason: 'only the CFO knows',
    });

    const slot = await getSlot(c, s.session_id, 'problem');
    expect(slot?.state).toBe('deferred');

    // Re-planning skips the unanswerable slot entirely.
    const { eligible } = await computeEligibility(c, s.session_id);
    expect(eligible.map((e) => e.slot)).not.toContain('problem');
    const next = await planNextQuestion(c, { sessionId: s.session_id });
    expect(next?.slot).not.toBe('problem');
    const forProblem = await listQuestions(c, s.session_id);
    expect(
      forProblem.filter((x) => x.slot === 'problem' && x.status === 'proposed'),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// planner
// ---------------------------------------------------------------------------

describe('question planner', () => {
  it('scores candidates on materiality gated by answerability/effort', () => {
    expect(
      scoreCandidate({
        impact: 1,
        uncertainty: 1,
        relevance: 1,
        answerability: 1,
        effort: 0,
      }),
    ).toBe(1);
    // Zero answerability → the candidate is worthless (the
    // `unanswerable` signal).
    expect(
      scoreCandidate({
        impact: 1,
        uncertainty: 1,
        relevance: 1,
        answerability: 0,
        effort: 0,
      }),
    ).toBe(0);
    // Max effort → worthless.
    expect(
      scoreCandidate({
        impact: 1,
        uncertainty: 1,
        relevance: 1,
        answerability: 1,
        effort: 1,
      }),
    ).toBe(0);
  });

  it('uses an injected AI proposal and fails closed on malformed output', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'solution-discovery' });

    const ok = await planNextQuestion(c, {
      sessionId: s.session_id,
      propose: async () =>
        JSON.stringify({
          schema: 1,
          slot: 'problem',
          question: 'What breaks today?',
          scores: {
            impact: 1,
            uncertainty: 1,
            relevance: 1,
            answerability: 1,
            effort: 0,
          },
        }),
    });
    expect(ok?.question).toBe('What breaks today?');
    expect(ok?.slot).toBe('problem');

    await expect(
      planNextQuestion(c, {
        sessionId: s.session_id,
        propose: async () => 'not json',
      }),
    ).rejects.toThrow(InterviewError);

    await expect(
      planNextQuestion(c, {
        sessionId: s.session_id,
        propose: async () =>
          JSON.stringify({
            schema: 1,
            slot: 'not-a-slot',
            question: 'x',
            scores: {
              impact: 1,
              uncertainty: 1,
              relevance: 1,
              answerability: 1,
              effort: 0,
            },
          }),
      }),
    ).rejects.toThrow(/not eligible/);

    expect(() => parseQuestionOutput('nope')).toThrow(InterviewError);
  });
});

// ---------------------------------------------------------------------------
// answer-before-question ordering
// ---------------------------------------------------------------------------

describe('answer-before-question ordering', () => {
  it('refuses to emit a next question before the answer is persisted', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'solution-discovery' });
    const q1 = await planNextQuestion(c, { sessionId: s.session_id });
    await askQuestion(c, {
      sessionId: s.session_id,
      questionId: q1?.question_id,
    });
    // A second question before answering the first is refused.
    const proposed = await listQuestions(c, s.session_id, 'proposed');
    expect(proposed.length).toBeGreaterThan(0);
    await expect(
      askQuestion(c, {
        sessionId: s.session_id,
        questionId: proposed[0]?.question_id,
      }),
    ).rejects.toThrow(/persisted/);

    // Once the answer is durable, the next question may be emitted.
    await submitAnswer(c, {
      sessionId: s.session_id,
      questionId: q1?.question_id,
      answer: 'resets are slow',
    });
    const asked = await listQuestions(c, s.session_id, 'asked');
    expect(asked.length).toBe(1);
  });

  it('persists the answer with a store-assigned seq before planning', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'solution-discovery' });
    const q1 = await planNextQuestion(c, { sessionId: s.session_id });
    await askQuestion(c, {
      sessionId: s.session_id,
      questionId: q1?.question_id,
    });
    const res = await submitAnswer(c, {
      sessionId: s.session_id,
      questionId: q1?.question_id,
      answer: 'users cannot reset passwords',
    });
    expect(res.message.role).toBe('user');
    expect(res.message.seq).toBeGreaterThan(0);
    const msgs = await transcript(c, s.session_id);
    // user turn landed before the next assistant question
    const userIdx = msgs.findIndex((m) => m.seq === res.message.seq);
    const nextAssistant = msgs.findIndex(
      (m, i) => i > userIdx && m.role === 'assistant',
    );
    expect(nextAssistant).toBeGreaterThan(userIdx);
  });
});

// ---------------------------------------------------------------------------
// two thresholds — draft_ready ≠ approval_ready
// ---------------------------------------------------------------------------

describe('readiness thresholds', () => {
  it('inferred required slots are draft-ready but not approval-ready', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'tdd-discovery' });
    const trace = await drive(c, s.session_id);
    expect(trace.length).toBeGreaterThan(0);

    const report = await evaluateReadiness(c, s.session_id);
    expect(report.draft_ready).toBe(true);
    expect(report.approval_ready).toBe(false);
    expect(
      report.approval_blockers.some((b) => b.state === 'inferred'),
    ).toBe(true);

    // Human confirmation of every required slot flips approval on.
    for (const slot of trace) {
      await confirmSlot(c, { sessionId: s.session_id, slot });
    }
    const after = await evaluateReadiness(c, s.session_id);
    expect(after.draft_ready).toBe(true);
    expect(after.approval_ready).toBe(true);
    expect(after.approval_blockers).toHaveLength(0);
  });

  it('the approval set is a strict subset of the draft set', () => {
    expect(DEFAULT_THRESHOLDS.draft).toContain('inferred');
    expect(DEFAULT_THRESHOLDS.approval).not.toContain('inferred');
    expect(DEFAULT_THRESHOLDS.draft).toContain('deferred');
    expect(DEFAULT_THRESHOLDS.approval).not.toContain('deferred');
  });
});

// ---------------------------------------------------------------------------
// snapshots + resume briefing
// ---------------------------------------------------------------------------

describe('snapshots + resume briefing', () => {
  it('resuming shows what changed since the snapshot', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'tdd-discovery' });
    await snapshot(c, { sessionId: s.session_id, reason: 'pause' });

    // Answer a couple of slots after the snapshot.
    const q1 = await planNextQuestion(c, { sessionId: s.session_id });
    await askQuestion(c, { sessionId: s.session_id, questionId: q1?.question_id });
    await submitAnswer(c, {
      sessionId: s.session_id,
      questionId: q1?.question_id,
      answer: 'the interfaces are X',
    });

    const briefing = await resume(c, { sessionId: s.session_id });
    expect(briefing.from_version).toBe(1);
    expect(briefing.changed_slots.length).toBeGreaterThan(0);
    expect(
      briefing.changed_slots.find((x) => x.slot === q1?.slot)?.to,
    ).toBe('inferred');
    expect(briefing.new_messages.length).toBeGreaterThan(0);
    expect(briefing.summary).toMatch(/slot\(s\) changed/);
    // The briefing is durable on the transcript.
    const msgs = await transcript(c, s.session_id);
    expect(msgs.some((m) => m.content.includes('[resume briefing]'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// multi-stakeholder branches
// ---------------------------------------------------------------------------

describe('multi-stakeholder branches', () => {
  it('merges with attribution and routes disagreement to a decision item', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'solution-discovery' });
    await createBranch(c, {
      sessionId: s.session_id,
      branch: 'product',
      role: 'product-owner',
    });
    await createBranch(c, {
      sessionId: s.session_id,
      branch: 'eng',
      role: 'engineer',
    });

    const affirm = makeExtractor((answer) => [
      {
        key: 'a',
        text: 'Users can reset passwords',
        source_text: answer,
        polarity: 'affirm',
        subject: 'password-reset',
      },
    ]);
    const negate = makeExtractor((answer) => [
      {
        key: 'b',
        text: 'Users cannot reset passwords',
        source_text: answer,
        polarity: 'negate',
        subject: 'password-reset',
      },
    ]);

    await submitAnswer(c, {
      sessionId: s.session_id,
      answer: 'yes they can reset',
      slot: 'problem',
      branch: 'product',
      extract: affirm,
      plan: false,
    });
    await submitAnswer(c, {
      sessionId: s.session_id,
      answer: 'no, reset is disabled',
      slot: 'problem',
      branch: 'eng',
      extract: negate,
      plan: false,
    });

    const merged = await mergeBranch(c, {
      sessionId: s.session_id,
      branch: 'eng',
    });
    expect(merged.role).toBe('engineer');
    expect(merged.attribution.length).toBe(1);
    expect(merged.attribution[0]?.branch).toBe('eng');
    expect(merged.conflicts.length).toBeGreaterThan(0);
    expect(merged.conflicts[0]?.slot).toBe('problem');

    // The slot is conflicted and a decision item is open.
    const slot = await getSlot(c, s.session_id, 'problem');
    expect(slot?.state).toBe('conflicted');
    const decisions = await store.listStatementDecisions({
      workspace: WS,
      status: 'open',
    });
    expect(decisions.length).toBeGreaterThan(0);

    // The branch is marked merged with a merge note on the transcript.
    const branches = await store.listInterviewBranches({
      workspace: WS,
      session_id: s.session_id,
    });
    expect(branches.find((b) => b.branch === 'eng')?.status).toBe('merged');
  });

  it('preserves attribution — statements keep their source message ref', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'solution-discovery' });
    await createBranch(c, {
      sessionId: s.session_id,
      branch: 'ops',
      role: 'sre',
    });
    const res = await submitAnswer(c, {
      sessionId: s.session_id,
      answer: 'downtime hurts trust',
      slot: 'problem',
      branch: 'ops',
      plan: false,
    });
    const stmt = res.statements[0];
    expect(stmt?.source_ref).toMatchObject({
      kind: 'interview-message',
      id: `${s.session_id}#${res.message.seq}`,
    });
    const merged = await mergeBranch(c, {
      sessionId: s.session_id,
      branch: 'ops',
    });
    expect(merged.merged_statements).toContain(stmt?.statement_id);
  });
});

// ---------------------------------------------------------------------------
// golden set — the wizard contract end-to-end
// ---------------------------------------------------------------------------

describe('wizard golden set', () => {
  it('asks each required slot exactly once (no repeats, no unsupported binding)', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const cfg = await loadWizardConfig(c, 'requirements-discovery');
    const required = cfg.slots
      .filter((s) => s.required === true)
      .map((s) => s.slot)
      .sort();
    const s = await startSession(c, { wizardId: 'requirements-discovery' });

    const trace = await drive(c, s.session_id);
    // Every required slot asked exactly once — and nothing else.
    expect([...trace].sort()).toEqual(required);
    expect(new Set(trace).size).toBe(trace.length);

    const report = await evaluateReadiness(c, s.session_id);
    expect(report.draft_ready).toBe(true);
    expect(report.approval_ready).toBe(false);

    // No slot is `known` on AI evidence alone (no unsupported binding).
    for (const slot of required) {
      const row = await getSlot(c, s.session_id, slot);
      expect(row?.state).toBe('inferred');
    }

    // The planner has nothing left to ask — the wizard realizes it
    // doesn't need to (zero unnecessary questions).
    expect(await planNextQuestion(c, { sessionId: s.session_id })).toBeNull();
  });

  it('binds extraction precisely — statements land on the targeted slot only', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, { wizardId: 'solution-discovery' });
    const extract = makeExtractor((answer) => [
      {
        key: 'p1',
        text: 'Resets take 3 days',
        source_text: answer,
        intent: 'problem',
      },
      {
        key: 'p2',
        text: 'Users lose trust',
        source_text: answer,
        intent: 'problem',
      },
    ]);
    const q = await planNextQuestion(c, { sessionId: s.session_id });
    await askQuestion(c, { sessionId: s.session_id, questionId: q?.question_id });
    const res = await submitAnswer(c, {
      sessionId: s.session_id,
      questionId: q?.question_id,
      answer: 'Password resets take 3 days and users lose trust',
      extract,
    });

    expect(res.statements).toHaveLength(2);
    const problem = await getSlot(c, s.session_id, 'problem');
    expect(problem?.statement_refs?.length).toBe(2);
    // No other slot was touched.
    const audience = await getSlot(c, s.session_id, 'audience');
    expect(audience?.statement_refs ?? []).toHaveLength(0);
    expect(audience?.state).toBe('missing');
  });

  it('one answer satisfies many slots (bulk mode)', async () => {
    const c = ctx();
    await seedMvpWizards(c);
    const s = await startSession(c, {
      wizardId: 'solution-discovery',
      mode: 'bulk',
    });
    await submitAnswer(c, {
      sessionId: s.session_id,
      answer: 'problem, audience and value in one paste',
      slots: ['problem', 'audience', 'value'],
      plan: false,
    });
    for (const slot of ['problem', 'audience', 'value']) {
      const row = await getSlot(c, s.session_id, slot);
      expect(row?.state).toBe('inferred');
    }
  });
});
