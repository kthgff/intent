/**
 * wp-158 — Discovery E2E (PRD §15.3/§15.9): the discovery-side vertical.
 *
 *   seed board with typed notes → mock-agent `extract` run emits
 *   statements.json → ingest persists proposed/source-backed statements
 *   with verbatim provenance → interview session fills knowledge slots
 *   (draft_ready ≠ approval_ready) → Solution Brief → RS draft with every
 *   element source-linked → spec_score on the generated specs → human
 *   approve → ChangeSet diff → tickets generated with contracts.
 *
 * Every agent stage is driven by MockAdapter spawning a real detached
 * child (test/helpers/mock-agent.mjs, `script:` scenario payloads). All
 * state lives in a PGlite PostgresStore — nothing below the adapter seam
 * is stubbed.
 *
 * Fail-closed coverage:
 *   - a binding requirement whose source_text isn't verbatim evidence is
 *     rejected (the batch aborts atomically — nothing lands);
 *   - contradicting statements stay disputed + open a decision item and
 *     the bound interview slot goes `conflicted` — never a silent merge;
 *   - an `unanswerable` question defers its slot and is never re-asked;
 *   - a deferred board resurfaces only as an approval-required proposal,
 *     accepted by a human.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { MockAdapter } from '@sprint-runner/adapters';
import type {
  EventName,
  RenderedPrompt,
  RunResult,
  StatementRow,
} from '@sprint-runner/core';
import { specLint } from '@sprint-runner/lints';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChangesCtx,
  addChangesetItem,
  analyzeChangeset,
  applyChangeset,
  decideChangeset,
  verifyChangeset,
} from '../../src/changes/index.js';
import {
  type InterviewCtx,
  askQuestion,
  bindStatementsToSlots,
  computeEligibility,
  confirmSlot,
  evaluateReadiness,
  getSlot,
  listQuestions,
  markSlot,
  planNextQuestion,
  refreshReadiness,
  resolveQuestion,
  seedMvpWizards,
  startSession,
  submitAnswer,
  transcript,
} from '../../src/interview/index.js';
import {
  BoardError,
  type StatementActor,
  acceptResurface,
  boardSources,
  changeRequestForApprovedItem,
  confirmStatement,
  createBoard,
  createTypedNote,
  decideStatementDecision,
  deferBoard,
  ingestStatementsArtifact,
  linkStatementArtifact,
  proposeResurface,
  rejectStatement,
  setBoardStatus,
  statementsForItem,
} from '../../src/semantics/index.js';
import { E2E_AGENT, type MockScriptSpec } from '../helpers/fixtures.js';

const WS = 'ws';
const HUMAN: StatementActor = { id: 'keith', type: 'human' };
const AGENT: StatementActor = { id: 'e2e-bot', type: 'agent' };
const T0 = Date.parse('2026-10-05T00:00:00Z');

let dir: string;
let runsDir: string;
let store: PostgresStore;
let clock: number;
let runSeq: number;
let adapter: MockAdapter;

const now = () => new Date(clock);
const iso = () => now().toISOString();
const tick = (ms = 60_000) => {
  clock += ms;
};

function ictx(): InterviewCtx {
  return { store, workspace: WS, actor: 'keith', now };
}
function cctx(): ChangesCtx {
  return { store, workspace: WS, actor: 'keith', now };
}

/** Append an event row the way the engines do (non-ticket subjects carry
 *  ticket_id=null + the subject in refs/data). */
async function emit(
  subject: string | null,
  event: EventName,
  data: Record<string, unknown> = {},
  refs: string[] = [],
  actorType: 'agent' | 'human' | 'runner' | 'system' = 'human',
) {
  await store.appendEvent({
    workspace: WS,
    ticket_id: subject,
    ts: iso(),
    stage: null,
    actor_type: actorType,
    actor_id: actorType === 'human' ? 'keith' : 'e2e-bot',
    event,
    run: null,
    refs,
    data,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-discovery-'));
  runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  store = await PostgresStore.connect('pglite:');
  clock = T0;
  runSeq = 0;
  adapter = new MockAdapter({
    agentScript: E2E_AGENT,
    delayMs: 10,
    heartbeatMs: 0,
  });
  await store.upsertProject({ workspace: WS, name: 'Discovery E2E' });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mock-adapter run helper — one agent stage end to end
// ---------------------------------------------------------------------------

/**
 * Register a run row, spawn the scripted mock child over the real
 * Adapter contract (run → collect), promote collected artifacts into
 * `run_artifacts`, and mark the run done/failed by its sentinel —
 * the same seam the conductor's reconcile uses.
 */
async function runAgentStage(args: {
  subject: string;
  stage: string;
  spec: MockScriptSpec;
}): Promise<{
  runId: string;
  result: RunResult;
  artifacts: Map<string, string>;
}> {
  const n = ++runSeq;
  const slug = `${String(n).padStart(3, '0')}-${args.stage}`;
  const safeSubject = args.subject.replace(/[^A-Za-z0-9.-]+/g, '-');
  const runId = `${WS}/${args.subject}/${slug}`;
  const runDir = join(runsDir, WS, safeSubject, slug);
  mkdirSync(runDir, { recursive: true });
  await store.createRun({
    id: runId,
    workspace: WS,
    subject: args.subject,
    ticket_id: /^[A-Z]+-\d+$/.test(args.subject) ? args.subject : null,
    stage: args.stage,
    attempt: n,
    backend: 'mock',
    model: 'mock',
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: null,
    status: 'running',
    started_at: iso(),
    heartbeat_at: null,
    exited_at: null,
    sentinel: null,
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: runDir,
  });

  // Stages with no shipped prompt template get a bare ARTIFACT_TARGETS
  // line — the same shape the conductor synthesizes for `verify`.
  const rendered: RenderedPrompt = {
    template: args.stage,
    text:
      `# ${args.stage} for ${args.subject}\n\n` +
      `Artifact paths: ${runDir}/ (absolute — write run outputs there).\n`,
    tokens: {},
  };
  const scenario = `script:${Buffer.from(JSON.stringify(args.spec), 'utf8').toString('base64url')}`;
  const handle = adapter.run(dir, rendered, 60, {
    scenario,
    artifactDir: runDir,
  });
  const result = await adapter.collect(handle, {
    workspace: WS,
    run_dir: runDir,
    run_id: runId,
  });

  // Reconcile move: collected files become durable run_artifacts rows.
  const artifacts = new Map<string, string>();
  for (const p of result.artifacts) {
    const name = relative(runDir, p);
    const content = readFileSync(p, 'utf8');
    await store.putArtifact({
      run_id: runId,
      name,
      content,
      created_at: iso(),
    });
    artifacts.set(name, content);
  }
  await store.updateRun(runId, {
    status: result.sentinel ? 'done' : 'failed',
    sentinel: result.sentinel,
    sentinel_raw: result.sentinel_raw,
    exited_at: iso(),
    cost_usd: result.usage?.totals.cost_usd ?? null,
    tokens_in: result.usage?.totals.tokens_in ?? null,
    tokens_out: result.usage?.totals.tokens_out ?? null,
    tokens_cached: result.usage?.totals.tokens_cached ?? null,
    usage_source: result.usage?.source ?? null,
    duration_s: result.usage?.totals.duration_s ?? null,
  });
  return { runId, result, artifacts };
}

/** An `extract`-seam backed by a real mock-agent run — the child writes
 *  statements.json into the run dir, collect promotes it, and the seam
 *  returns the artifact text for runExtraction to ingest. */
function mockExtraction(subject: string, output: unknown) {
  return async (_prompt: string): Promise<string> => {
    const run = await runAgentStage({
      subject,
      stage: 'extract',
      spec: {
        sentinel: 'DONE',
        artifacts: { 'statements.json': output },
      },
    });
    const artifact = run.artifacts.get('statements.json');
    if (artifact === undefined) {
      throw new Error('mock extract run produced no statements.json');
    }
    return artifact;
  };
}

async function listStatements() {
  return store.listStatements({ workspace: WS });
}
async function openDecisions() {
  return store.listStatementDecisions({ workspace: WS, status: 'open' });
}
async function getStmt(id: string) {
  const s = await store.getStatement({ workspace: WS, statement_id: id });
  if (!s) throw new Error(`no statement ${id}`);
  return s;
}

/** A lint-clean ticket.md draft (SCHEMAS §1 + §15). */
function ticketMdDraft(opts: { id: string; title: string; acs: string[] }) {
  return [
    '---',
    'schema: 1',
    `id: ${opts.id}`,
    `title: ${opts.title}`,
    'status: imported',
    'priority: high',
    'repos: [code-repo]',
    'depth: standard',
    '---',
    '',
    '## Description',
    `${opts.title} — generated from the approved I-0001 requirements spec. Implements the ratified scope only; anything else is a ChangeSet.`,
    '',
    '## Acceptance criteria',
    ...opts.acs.map((ac) => `- [ ] ${ac}`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// the vertical
// ---------------------------------------------------------------------------

describe('discovery vertical (wp-158)', () => {
  it(
    'board → extraction → interview → brief → source-linked RS → ' +
      'spec_score → approve → ChangeSet diff → contracted tickets',
    { timeout: 30_000 },
    async () => {
      // --- 1. seed the board with typed notes (the full taxonomy) ----
      await createBoard(store, {
        workspace: WS,
        board: 'ideas',
        board_type: 'new-project',
        status: 'discovery',
        actor: HUMAN,
        now,
      });
      const notes = {
        goal: await createTypedNote(store, {
          workspace: WS,
          board: 'ideas',
          note_kind: 'idea',
          title: 'Self-serve password resets',
          body: 'A magic-link reset flow users can run without IT.',
          actor: HUMAN,
          now,
        }),
        problem: await createTypedNote(store, {
          workspace: WS,
          board: 'ideas',
          note_kind: 'problem',
          title: 'Password resets take 3 days',
          body: 'Tickets pile up while users wait. We must cut that to under an hour.',
          actor: HUMAN,
          now,
        }),
        want: await createTypedNote(store, {
          workspace: WS,
          board: 'ideas',
          note_kind: 'want',
          title: 'Admins need an audit trail',
          body: 'Every reset action must be visible in an audit log.',
          actor: HUMAN,
          now,
        }),
        avoid: await createTypedNote(store, {
          workspace: WS,
          board: 'ideas',
          note_kind: 'avoid',
          title: 'No emailed plaintext passwords',
          body: 'Never send a plaintext password over email.',
          actor: HUMAN,
          now,
        }),
        constraint: await createTypedNote(store, {
          workspace: WS,
          board: 'ideas',
          note_kind: 'constraint',
          importance: 'must',
          title: 'Postgres only',
          body: 'All data must stay in Postgres.',
          actor: HUMAN,
          now,
        }),
        question: await createTypedNote(store, {
          workspace: WS,
          board: 'ideas',
          note_kind: 'question',
          title: 'Session expiry on reset?',
          body: 'Should a password reset expire all existing sessions?',
          actor: HUMAN,
          now,
        }),
        decision: await createTypedNote(store, {
          workspace: WS,
          board: 'ideas',
          note_kind: 'decision',
          title: 'Admins approve bulk resets',
          body: 'Bulk resets require an admin sign-off.',
          actor: HUMAN,
          now,
        }),
        feedback: await createTypedNote(store, {
          workspace: WS,
          board: 'ideas',
          note_kind: 'feedback',
          title: 'Reset flow confuses users',
          body: 'Three users described the current flow as confusing.',
          actor: HUMAN,
          now,
        }),
      };
      expect(Object.values(notes).every((n) => n.note_kind !== null)).toBe(
        true,
      );

      // --- 2. extraction: mock `extract` run → statements.json →
      //        fail-closed ingest ------------------------------------
      const { items, sources } = await boardSources(store, {
        workspace: WS,
        board: 'ideas',
      });
      const srcIdx = new Map(items.map((it, i) => [it.id, i] as const));
      const at = (it: { id: string }) => srcIdx.get(it.id) as number;

      const extractionOut = {
        schema: 1,
        statements: [
          {
            key: 'problem',
            text: 'Password resets take three days',
            source: at(notes.problem),
            source_text: 'Password resets take 3 days',
            intent: 'problem',
            subject: 'password-reset',
            polarity: 'affirm',
          },
          {
            key: 'sla',
            text: 'Password resets must complete in under an hour',
            source: at(notes.problem),
            source_text: 'We must cut that to under an hour.',
            intent: 'requires',
            strength: 'must',
            subject: 'password-reset',
            scope: 'solution',
            relations: [{ predicate: 'derived-from', target: 'problem' }],
          },
          {
            key: 'audit',
            text: 'Every reset action is recorded in an audit log',
            source: at(notes.want),
            source_text: 'Every reset action must be visible in an audit log.',
            intent: 'want',
            subject: 'audit-trail',
          },
          {
            key: 'no-plaintext',
            text: 'Plaintext passwords are never sent over email',
            source: at(notes.avoid),
            source_text: 'Never send a plaintext password over email.',
            intent: 'prohibits',
            strength: 'must',
            subject: 'credential-handling',
            polarity: 'negate',
          },
          {
            key: 'pg',
            text: 'All data stays in Postgres',
            source: at(notes.constraint),
            source_text: 'All data must stay in Postgres.',
            intent: 'constraint',
            strength: 'must',
            subject: 'data-store',
          },
          {
            key: 'sessions',
            text: 'A reset may expire existing sessions',
            source: at(notes.question),
            source_text:
              'Should a password reset expire all existing sessions?',
            intent: 'question',
            subject: 'session-expiry',
            clarification: 'All devices, or just the requesting one?',
          },
          {
            key: 'bulk-approval',
            text: 'Bulk resets require an admin sign-off',
            source: at(notes.decision),
            source_text: 'Bulk resets require an admin sign-off.',
            intent: 'decision',
            subject: 'bulk-reset',
          },
          {
            key: 'confusing',
            text: 'Users describe the current reset flow as confusing',
            source: at(notes.feedback),
            source_text: 'Three users described the current flow as confusing.',
            intent: 'observation',
            subject: 'ux',
          },
          {
            key: 'magic-link',
            text: 'A magic-link flow lets users reset without IT',
            source: at(notes.goal),
            source_text: 'A magic-link reset flow users can run without IT.',
            intent: 'want',
            subject: 'password-reset',
            relations: [{ predicate: 'supports', target: 'sla' }],
          },
        ],
      };
      const extractRun = await runAgentStage({
        subject: 'board:ideas',
        stage: 'extract',
        spec: {
          sentinel: 'DONE',
          artifacts: { 'statements.json': extractionOut },
        },
      });
      expect(extractRun.result.sentinel).toBe('DONE');
      expect(extractRun.artifacts.has('statements.json')).toBe(true);

      const ingest = await ingestStatementsArtifact(store, {
        workspace: WS,
        subject: 'board:ideas',
        sources,
        runId: extractRun.runId,
        run: extractRun.runId,
        model: 'mock',
        actor: 'e2e-bot',
        extractionRunId: 'xr-board-1',
        now,
      });

      // Statements persisted, verbatim-provenanced, never auto-confirmed.
      expect(ingest.statements).toHaveLength(9);
      for (const s of ingest.statements) {
        expect(s.status).toBe('proposed');
        expect(s.provenance).toBe('source-backed');
        expect(s.extraction_run).toBe('xr-board-1');
        const ref = s.source_ref as {
          kind: string;
          id: string;
          span: [number, number];
        };
        expect(ref.kind).toBe('board-item');
        const src = items.find((i) => i.id === ref.id);
        expect(src).toBeDefined();
        const srcText =
          src?.title && src?.body
            ? `${src.title}\n\n${src.body}`
            : ((src?.title ?? src?.body) as string);
        expect(srcText.slice(ref.span[0], ref.span[1])).toBe(s.source_text);
      }
      const byId = Object.fromEntries(
        ingest.statements.map((s) => [s.statement_id, s]),
      );
      const stId = (key: string) => ingest.ids[key] as string;
      expect(
        await statementsForItem(store, {
          workspace: WS,
          itemId: notes.problem.id,
        }),
      ).toHaveLength(2);
      const exRun = await store.getExtractionRun({
        workspace: WS,
        extraction_run_id: 'xr-board-1',
      });
      expect(exRun?.run).toBe(extractRun.runId);
      expect(exRun?.stats?.statements).toBe(9);

      // Consequential statements open confirmation decisions; the
      // extractor's ambiguity lands as a clarification, not a guess.
      const open = await openDecisions();
      const decisionIds = new Set(open.map((d) => d.decision_id));
      for (const key of ['sla', 'no-plaintext', 'pg', 'bulk-approval']) {
        expect(decisionIds.has(`sd-${stId(key)}-confirm`)).toBe(true);
      }
      const clarifications = await store.listStatementClarifications({
        workspace: WS,
      });
      expect(
        clarifications.some((c) => c.statement_id === stId('sessions')),
      ).toBe(true);

      // Humans confirm — decisions ruled, inert statements confirmed.
      for (const d of open) {
        await decideStatementDecision(store, {
          workspace: WS,
          decision_id: d.decision_id,
          decision: 'confirmed by stakeholder',
          apply: 'confirmed',
          actor: HUMAN,
          now,
        });
      }
      for (const key of ['problem', 'audit', 'magic-link']) {
        await confirmStatement(store, {
          workspace: WS,
          statement_id: stId(key),
          actor: HUMAN,
          now,
        });
      }
      expect(await openDecisions()).toHaveLength(0);

      // --- 3. interview: assemble board knowledge, fill the gap ------
      await seedMvpWizards(ictx());
      const session = await startSession(ictx(), {
        wizardId: 'solution-discovery',
        subject: 'board:ideas',
      });
      const sessionId = session.session_id;

      // Context-first: board-extracted statements bind to the slots
      // they already answer — confirmed statements make slots `known`.
      await bindStatementsToSlots(
        ictx(),
        sessionId,
        ['problem'],
        [byId[stId('problem')] as StatementRow],
      );
      await bindStatementsToSlots(
        ictx(),
        sessionId,
        ['value'],
        [byId[stId('sla')] as StatementRow],
      );
      await bindStatementsToSlots(
        ictx(),
        sessionId,
        ['audience'],
        [byId[stId('audit')] as StatementRow],
      );
      for (const slot of ['problem', 'value', 'audience']) {
        expect((await getSlot(ictx(), sessionId, slot))?.state).toBe('known');
      }

      // The planner asks only what materially changes — the one
      // remaining required slot is `success-metrics`.
      const plan = await planNextQuestion(ictx(), { sessionId });
      expect(plan?.slot).toBe('success-metrics');
      await askQuestion(ictx(), {
        sessionId,
        questionId: plan?.question_id,
      });
      const metricAnswer =
        'Median reset time drops below an hour and weekly reset tickets fall under five.';
      const metricOut = {
        schema: 1,
        statements: [
          {
            key: 'metric',
            text: 'Median reset time under an hour; weekly reset tickets under five',
            source: 0,
            source_text: metricAnswer,
            intent: 'requires',
            subject: 'password-reset',
          },
        ],
      };
      const answered = await submitAnswer(ictx(), {
        sessionId,
        questionId: plan?.question_id,
        answer: metricAnswer,
        extract: mockExtraction(`session:${sessionId}`, metricOut),
        plan: false,
      });
      expect(answered.statements).toHaveLength(1);
      expect(answered.statements[0]?.status).toBe('proposed');

      // Two thresholds: draft_ready ≠ approval_ready — and the answer's
      // `requires` statement is consequential, so its open confirmation
      // decision conflicts the slot (`conflicted` blocks BOTH
      // thresholds — a pending human ruling is never "ready").
      let readiness = await refreshReadiness(ictx(), sessionId);
      expect(readiness.draft_ready).toBe(false);
      expect(readiness.approval_ready).toBe(false);
      expect(
        readiness.draft_blockers.some(
          (b) => b.slot === 'success-metrics' && b.state === 'conflicted',
        ),
      ).toBe(true);
      expect(
        readiness.approval_blockers.some(
          (b) => b.slot === 'success-metrics' && b.state === 'conflicted',
        ),
      ).toBe(true);
      expect(readiness.open_decisions.length).toBeGreaterThan(0);
      let persisted = await store.getInterviewSession({
        workspace: WS,
        session_id: sessionId,
      });
      expect(persisted?.draft_ready).toBe(false);
      expect(persisted?.approval_ready).toBe(false);

      // Human rules the decision + confirms the slot → approval-ready.
      for (const d of await openDecisions()) {
        await decideStatementDecision(store, {
          workspace: WS,
          decision_id: d.decision_id,
          decision: 'confirmed',
          apply: 'confirmed',
          actor: HUMAN,
          now,
        });
      }
      const confirmedSlot = await confirmSlot(ictx(), {
        sessionId,
        slot: 'success-metrics',
      });
      expect(confirmedSlot.state).toBe('known');
      readiness = await refreshReadiness(ictx(), sessionId);
      expect(readiness.draft_ready).toBe(true);
      expect(readiness.approval_ready).toBe(true);
      persisted = await store.getInterviewSession({
        workspace: WS,
        session_id: sessionId,
      });
      expect(persisted?.draft_ready).toBe(true);
      expect(persisted?.approval_ready).toBe(true);

      // --- 4. Solution Brief (agent-drafted doc version) -------------
      const initId = await store.allocInitiativeId(WS);
      expect(initId).toBe('I-0001');
      await store.upsertInitiative({
        workspace: WS,
        initiative: initId,
        board: 'ideas',
        title: 'Self-serve password reset',
        status: 'planned',
        serves: [notes.goal.id],
        provenance: 'board:ideas',
        created_at: iso(),
        updated_at: iso(),
      });
      const briefMd = [
        '# Solution Brief — I-0001: Self-serve password reset',
        '',
        '## Problem',
        'Password resets take three days while users wait on IT.',
        '',
        '## Users',
        'End users (self-serve) and admins (audit trail).',
        '',
        '## Alternatives considered',
        'Keep the IT-mediated flow; force resets via SSO recovery.',
        '',
        '## Chosen direction',
        'Signed magic-link reset flow with an admin audit log.',
        '',
        '## Assumptions',
        'Account email delivery is reliable.',
        '',
        '## Boundaries',
        'All data stays in Postgres; no emailed plaintext passwords.',
        '',
        '## Open Questions',
        'None — approval-ready.',
        '',
      ].join('\n');
      const briefRun = await runAgentStage({
        subject: initId,
        stage: 'brief',
        spec: {
          sentinel: 'DONE',
          artifacts: { 'solution-brief.md': briefMd },
        },
      });
      await store.appendDocVersion(
        { workspace: WS, subject: initId, doc: 'solution-brief.md' },
        briefRun.artifacts.get('solution-brief.md') as string,
        'e2e-bot',
      );
      await setBoardStatus(store, {
        workspace: WS,
        board: 'ideas',
        status: 'proposal-ready',
        actor: HUMAN,
        now,
      });
      await emit(null, 'board_synthesized', { board: 'ideas' }, [
        'board:ideas',
      ]);
      await emit(null, 'initiative_planned', { initiative: initId }, [
        'board:ideas',
      ]);

      // --- 5. RS draft — every element source-linked -----------------
      const rsV1 = [
        '# RS — I-0001: Self-serve password reset',
        '',
        '## Problem',
        'Password resets take three days while users wait on IT.',
        '',
        '## Requirements',
        '| req_id | requirement |',
        '| --- | --- |',
        '| req:R-1 | A user resets their password via a signed magic link without IT involvement |',
        '| req:R-2 | Every reset action is recorded in an admin-visible audit log |',
        '| req:R-3 | Resets complete in under an hour |',
        '| req:R-4 | All reset data stays in Postgres |',
        '| req:R-5 | A plaintext password is never sent over email |',
        '',
        '## Acceptance criteria',
        '| ac_id | criterion | req |',
        '| --- | --- | --- |',
        '| ac:AC-1 | Requesting a reset delivers a signed link to the account email and resets on submit | req:R-1 |',
        '| ac:AC-2 | An admin sees each reset action in the audit log | req:R-2 |',
        '',
        '## Traceability',
        '| element | statement |',
        '| --- | --- |',
        `| req:R-1 | ${stId('magic-link')} |`,
        `| req:R-2 | ${stId('audit')} |`,
        `| req:R-3 | ${stId('sla')} |`,
        `| req:R-4 | ${stId('pg')} |`,
        `| req:R-5 | ${stId('no-plaintext')} |`,
        `| ac:AC-1 | ${stId('magic-link')} |`,
        `| ac:AC-2 | ${stId('audit')} |`,
        '',
      ].join('\n');
      const rsRun = await runAgentStage({
        subject: initId,
        stage: 'prd',
        spec: {
          sentinel: 'PRD-WRITTEN',
          artifacts: { 'rs.md': rsV1 },
        },
      });
      const rsDoc = await store.appendDocVersion(
        { workspace: WS, subject: initId, doc: 'rs.md' },
        rsRun.artifacts.get('rs.md') as string,
        'e2e-bot',
      );
      expect(rsDoc.version).toBe(1);

      const elementLinks: [string, string][] = [
        ['req:R-1', stId('magic-link')],
        ['req:R-2', stId('audit')],
        ['req:R-3', stId('sla')],
        ['req:R-4', stId('pg')],
        ['req:R-5', stId('no-plaintext')],
        ['ac:AC-1', stId('magic-link')],
        ['ac:AC-2', stId('audit')],
      ];
      for (const [element, sid] of elementLinks) {
        await linkStatementArtifact(store, {
          workspace: WS,
          statement_id: sid,
          artifact: `doc:${initId}:rs.md:v${rsDoc.version}`,
          element,
          actor: AGENT,
          now,
        });
      }
      const rsLinks = await store.listStatementArtifactLinks({
        workspace: WS,
        artifact: `doc:${initId}:rs.md:v1`,
      });
      // Every requirement/AC element named in the doc is source-linked.
      const elements = new Set(
        rsV1.match(/\b(?:req:R-\d+|ac:AC-\d+)\b/g) ?? [],
      );
      for (const el of elements) {
        const linked = rsLinks.filter((l) => l.element === el);
        expect(linked.length, `element ${el} source-linked`).toBeGreaterThan(0);
        for (const l of linked) {
          const s = await getStmt(l.statement_id);
          expect(s.status).toBe('confirmed');
        }
      }

      // --- 6. spec_score on the generated ticket drafts --------------
      // The decompose run drafts ticket.md + contract.json per child;
      // the mechanical spec lint scores each draft BEFORE approval
      // (SCHEMAS §15 — advisory, stamped onto tickets.spec_score).
      const t1 = await store.allocTicketId(WS);
      const t2 = await store.allocTicketId(WS);
      expect(t1).toBe('SR-0001');
      const contractOf = (id: string, acs: [string, string][]) => ({
        schema: 1,
        subject: id,
        kind: 'interface',
        rs: `doc:${initId}:rs.md:v1`,
        acceptance_criteria: acs.map(([ac_id, statement]) => ({
          ac_id,
          statement,
        })),
        provenance: {
          board: 'ideas',
          initiative: initId,
          feature: 'F-0001',
        },
      });
      const drafts: Record<
        string,
        {
          title: string;
          ticketMd: string;
          contract: ReturnType<typeof contractOf>;
        }
      > = {
        [t1]: {
          title: 'Magic-link self-serve reset',
          ticketMd: ticketMdDraft({
            id: t1,
            title: 'Magic-link self-serve reset',
            acs: [
              'Requesting a reset delivers a signed link to the account email and resets on submit',
            ],
          }),
          contract: contractOf(t1, [['ac:AC-1', stId('magic-link')]]),
        },
        [t2]: {
          title: 'Admin audit log for reset actions',
          ticketMd: ticketMdDraft({
            id: t2,
            title: 'Admin audit log for reset actions',
            acs: ['An admin sees each reset action in the audit log'],
          }),
          contract: contractOf(t2, [['ac:AC-2', stId('audit')]]),
        },
      };
      const decomposeRun = await runAgentStage({
        subject: initId,
        stage: 'decompose',
        spec: {
          sentinel: 'SPLIT-PROPOSED',
          artifacts: {
            'tickets/SR-0001/ticket.md': drafts[t1]?.ticketMd,
            'tickets/SR-0001/contract.json': drafts[t1]?.contract,
            'tickets/SR-0002/ticket.md': drafts[t2]?.ticketMd,
            'tickets/SR-0002/contract.json': drafts[t2]?.contract,
          },
        },
      });
      const specScores = new Map<string, number>();
      for (const id of [t1, t2]) {
        const md = decomposeRun.artifacts.get(`tickets/${id}/ticket.md`);
        expect(md, `${id} ticket.md draft`).toBeDefined();
        const lint = specLint(md as string);
        specScores.set(id, lint.score);
        await emit(id, 'spec_scored', {
          subject: initId,
          score: lint.score,
          flags: lint.flags,
        });
      }
      expect([...specScores.values()].every((s) => s === 100)).toBe(true);

      // --- 7. human approval (the RS gate) ---------------------------
      await store.upsertGateItem({
        workspace: WS,
        subject: initId,
        gate: 'prd-review',
        kind: 'review',
        surfaced_at: iso(),
        cleared_at: null,
        snoozed_until: null,
        blocked_agent: true,
        priority: 'high',
      });
      const openGate = await store.getGateItem({
        workspace: WS,
        subject: initId,
        gate: 'prd-review',
      });
      expect(openGate?.cleared_at).toBeNull();
      expect(openGate?.blocked_agent).toBe(true);

      await store.clearGateItem(
        { workspace: WS, subject: initId, gate: 'prd-review' },
        iso(),
      );
      await emit(null, 'gate_approved', {
        subject: initId,
        gate: 'prd-review',
      });
      await emit(null, 'doc_approved', {
        subject: initId,
        doc: 'rs.md',
        version: 1,
      });
      await store.upsertInitiative({
        workspace: WS,
        initiative: initId,
        board: 'ideas',
        title: 'Self-serve password reset',
        status: 'active',
        serves: [notes.goal.id],
        provenance: 'board:ideas',
        created_at: iso(),
        updated_at: iso(),
      });
      await setBoardStatus(store, {
        workspace: WS,
        board: 'ideas',
        status: 'approved',
        actor: HUMAN,
        now,
      });
      const featureId = await store.allocFeatureId(WS);
      expect(featureId).toBe('F-0001');
      await store.upsertFeature({
        workspace: WS,
        feature: featureId,
        initiative: initId,
        title: 'Self-serve reset',
        status: 'ready',
        serves: [notes.goal.id],
        created_at: iso(),
        updated_at: iso(),
      });

      // --- 8. ChangeSet diff — the only path to an approved doc ------
      const cs = await changeRequestForApprovedItem(store, {
        workspace: WS,
        board: 'ideas',
        subject: initId,
        doc: 'rs.md',
        request:
          'Add the deferred session-expiry requirement: a reset expires all existing sessions.',
        actor: HUMAN,
        now,
      });
      expect(cs.baseline).toEqual({
        subject: initId,
        doc: 'rs.md',
        version: 1,
      });
      expect(cs.status).toBe('draft');

      const rsV2 = rsV1.replace(
        '| req:R-5 | A plaintext password is never sent over email |',
        '| req:R-5 | A plaintext password is never sent over email |\n' +
          '| req:R-6 | A successful reset expires all existing sessions |',
      );
      const item = await addChangesetItem(cctx(), {
        changesetId: cs.changeset_id,
        input: {
          subject: initId,
          doc: 'rs.md',
          change: { content: rsV2 },
        },
      });
      expect(item.base_version).toBe(1);
      await analyzeChangeset(cctx(), { changesetId: cs.changeset_id });
      const csGate = await store.getGateItem({
        workspace: WS,
        subject: cs.changeset_id,
        gate: 'changeset-decision',
      });
      expect(csGate?.cleared_at).toBeNull();

      await decideChangeset(cctx(), {
        changesetId: cs.changeset_id,
        decision: 'add-now',
        decidedBy: 'keith',
      });
      const applied = await applyChangeset(cctx(), {
        changesetId: cs.changeset_id,
      });
      expect(applied.status).toBe('applying');
      const verified = await verifyChangeset(cctx(), {
        changesetId: cs.changeset_id,
      });
      expect(verified.status).toBe('verified');
      const head = await store.getDoc({
        workspace: WS,
        subject: initId,
        doc: 'rs.md',
      });
      expect(head?.version).toBe(2);
      expect(head?.content).toBe(rsV2); // the diff landed
      const versions = await store.listDocVersions({
        workspace: WS,
        subject: initId,
        doc: 'rs.md',
      });
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      const csItems = await store.listChangesetItems({
        workspace: WS,
        changeset_id: cs.changeset_id,
      });
      expect(csItems[0]?.status).toBe('applied');
      expect(csItems[0]?.proposed_version).toBe(2);
      // The v2 element stays source-linked (the question statement now
      // answered by the ratified change).
      await linkStatementArtifact(store, {
        workspace: WS,
        statement_id: stId('sessions'),
        artifact: `doc:${initId}:rs.md:v2`,
        element: 'req:R-6',
        actor: AGENT,
        now,
      });

      // --- 9. tickets generated with contracts -----------------------
      for (const id of [t1, t2]) {
        const draft = drafts[id];
        expect(draft).toBeDefined();
        const contractJson = JSON.stringify(draft?.contract, null, 2);
        const ticketMd = draft?.ticketMd as string;
        await store.upsertTicket({
          workspace: WS,
          ticket_id: id,
          feature: featureId,
          title: draft?.title as string,
          status: 'imported',
          priority: 'high',
          depth: 'standard',
          backend: 'mock',
          model: null,
          repos: ['code-repo'],
          parent: null,
          depends_on: id === t2 ? [t1] : [],
          serves: [notes.goal.id],
          source: 'synthesis',
          work_type: 'story',
          origin: 'rs',
          severity: null,
          execution_readiness: 'ready',
          parallel_safety: id === t2 ? 'caution' : 'safe',
          source_ref: null,
          test_env: null,
          forced: false,
          spec_score: specScores.get(id) ?? null,
          spec_hash: null,
          blocked_reason: null,
          created_at: iso(),
          updated_at: iso(),
        });
        await store.appendDocVersion(
          { workspace: WS, subject: id, doc: 'ticket.md' },
          ticketMd,
          'e2e-bot',
        );
        await store.appendDocVersion(
          { workspace: WS, subject: id, doc: 'contract.json' },
          `${contractJson}\n`,
          'e2e-bot',
        );
        // Contract ↔ source statements — tickets are born source-linked.
        for (const ac of draft?.contract.acceptance_criteria ?? []) {
          await linkStatementArtifact(store, {
            workspace: WS,
            statement_id: ac.statement,
            artifact: `doc:${id}:ticket.md:v1`,
            element: ac.ac_id,
            actor: AGENT,
            now,
          });
        }
        await emit(id, 'ticket_authored', {
          via: 'decompose',
          spec_score: specScores.get(id),
        });
      }

      const row1 = await store.getTicket({ workspace: WS, ticket_id: t1 });
      const row2 = await store.getTicket({ workspace: WS, ticket_id: t2 });
      expect(row1?.origin).toBe('rs');
      expect(row1?.work_type).toBe('story');
      expect(row1?.execution_readiness).toBe('ready');
      expect(row1?.serves).toEqual([notes.goal.id]);
      expect(row1?.spec_score).toBe(100);
      expect(row2?.depends_on).toEqual([t1]);
      expect(row2?.parallel_safety).toBe('caution');
      expect(
        (
          await store.getDoc({
            workspace: WS,
            subject: t1,
            doc: 'contract.json',
          })
        )?.content,
      ).toContain(`"rs": "doc:${initId}:rs.md:v1"`);

      // Statement links run end-to-end: board item → statement →
      // RS element → ticket AC.
      const t1Links = await store.listStatementArtifactLinks({
        workspace: WS,
        artifact: `doc:${t1}:ticket.md:v1`,
      });
      expect(t1Links.map((l) => l.element)).toEqual(['ac:AC-1']);
      const events = await store.listEvents({ workspace: WS });
      const names = events.map((e) => e.event);
      expect(names).toContain('spec_scored');
      expect(names).toContain('doc_approved');
      expect(names).toContain('changeset_verified');
      expect(names).toContain('ticket_authored');
      expect(names).toContain('board_synthesized');
    },
  );
});

// ---------------------------------------------------------------------------
// fail-closed paths
// ---------------------------------------------------------------------------

describe('fail-closed paths (wp-158)', () => {
  it('rejects a binding requirement without verbatim evidence', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      board_type: 'new-project',
      status: 'discovery',
      actor: HUMAN,
      now,
    });
    const note = await createTypedNote(store, {
      workspace: WS,
      board: 'ideas',
      note_kind: 'constraint',
      title: 'Postgres only',
      body: 'All data must stay in Postgres.',
      actor: HUMAN,
      now,
    });
    const { sources } = await boardSources(store, {
      workspace: WS,
      board: 'ideas',
    });
    const srcIdx = sources.findIndex(
      (s) => s.ref.kind === 'board-item' && s.ref.id === note.id,
    );

    // The run itself succeeded — the child wrote statements.json. The
    // ingest is the fail-closed gate: a paraphrased source_text on a
    // binding `prohibits` aborts the whole batch.
    const run = await runAgentStage({
      subject: 'board:ideas',
      stage: 'extract',
      spec: {
        sentinel: 'DONE',
        artifacts: {
          'statements.json': {
            schema: 1,
            statements: [
              {
                key: 'ok',
                text: 'All data stays in Postgres',
                source: srcIdx,
                source_text: 'All data must stay in Postgres.',
                intent: 'constraint',
              },
              {
                key: 'bad',
                text: 'Passwords must never be emailed',
                source: srcIdx,
                source_text: 'Passwords are never emailed', // paraphrase
                intent: 'prohibits',
                strength: 'must',
              },
            ],
          },
        },
      },
    });
    await expect(
      ingestStatementsArtifact(store, {
        workspace: WS,
        subject: 'board:ideas',
        sources,
        runId: run.runId,
        actor: 'e2e-bot',
        extractionRunId: 'xr-bad',
        now,
      }),
    ).rejects.toThrow(/verbatim|paraphras/i);
    // Nothing landed — not the good statement, not the run row.
    expect(await listStatements()).toHaveLength(0);
    expect(
      await store.getExtractionRun({
        workspace: WS,
        extraction_run_id: 'xr-bad',
      }),
    ).toBeNull();
    expect(await openDecisions()).toHaveLength(0);
    // The agent's artifact survives for audit — the pipeline blocked at
    // ingest, not at collect.
    expect(
      (await store.getArtifact(run.runId, 'statements.json'))?.content,
    ).toContain('prohibits');

    // Control: the same binding intent WITH verbatim evidence ingests —
    // rejection is about support, never about the intent itself.
    const okRun = await runAgentStage({
      subject: 'board:ideas',
      stage: 'extract',
      spec: {
        sentinel: 'DONE',
        artifacts: {
          'statements.json': {
            schema: 1,
            statements: [
              {
                key: 'ban',
                text: 'Plaintext passwords are never sent over email',
                source: srcIdx,
                source_text: 'All data must stay in Postgres.', // verbatim
                intent: 'prohibits',
                strength: 'must',
              },
            ],
          },
        },
      },
    });
    const ok = await ingestStatementsArtifact(store, {
      workspace: WS,
      subject: 'board:ideas',
      sources,
      runId: okRun.runId,
      actor: 'e2e-bot',
      extractionRunId: 'xr-ok',
      now,
    });
    expect(ok.statements[0]?.status).toBe('proposed');
    expect(ok.decisions).toHaveLength(1); // consequential → confirmation item
  });

  it('routes contradicting statements to a decision item, never a merge', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      board_type: 'new-project',
      status: 'discovery',
      actor: HUMAN,
      now,
    });
    const n1 = await createTypedNote(store, {
      workspace: WS,
      board: 'ideas',
      note_kind: 'want',
      title: 'Users can reset their own passwords',
      actor: HUMAN,
      now,
    });
    const n2 = await createTypedNote(store, {
      workspace: WS,
      board: 'ideas',
      note_kind: 'want',
      title: 'Users cannot reset their own passwords',
      body: 'Only IT performs resets.',
      actor: HUMAN,
      now,
    });

    // Batch 1: the affirming statement.
    const s1 = await ingestStatementsArtifact(store, {
      workspace: WS,
      subject: 'board:ideas',
      sources: [
        {
          ref: { kind: 'board-item', id: n1.id },
          text: n1.title as string,
        },
      ],
      runId: (
        await runAgentStage({
          subject: 'board:ideas',
          stage: 'extract',
          spec: {
            sentinel: 'DONE',
            artifacts: {
              'statements.json': {
                schema: 1,
                statements: [
                  {
                    key: 'can',
                    text: 'Users can reset their own passwords',
                    source: 0,
                    source_text: 'Users can reset their own passwords',
                    intent: 'want',
                    polarity: 'affirm',
                    subject: 'password-reset',
                  },
                ],
              },
            },
          },
        })
      ).runId,
      actor: 'e2e-bot',
      extractionRunId: 'xr-c1',
      now,
    });
    const s1Id = s1.statements[0]?.statement_id as string;
    expect((await getStmt(s1Id)).status).toBe('proposed');

    // Batch 2: a live statement contradicted by new evidence.
    const s2 = await ingestStatementsArtifact(store, {
      workspace: WS,
      subject: 'board:ideas',
      sources: [
        {
          ref: { kind: 'board-item', id: n2.id },
          text: `${n2.title}\n\n${n2.body}`,
        },
      ],
      runId: (
        await runAgentStage({
          subject: 'board:ideas',
          stage: 'extract',
          spec: {
            sentinel: 'DONE',
            artifacts: {
              'statements.json': {
                schema: 1,
                statements: [
                  {
                    key: 'cannot',
                    text: 'Users cannot reset their own passwords',
                    source: 0,
                    source_text: 'Users cannot reset their own passwords',
                    intent: 'want',
                    polarity: 'negate',
                    subject: 'password-reset',
                    relations: [{ predicate: 'contradicts', target: s1Id }],
                  },
                ],
              },
            },
          },
        })
      ).runId,
      actor: 'e2e-bot',
      extractionRunId: 'xr-c2',
      now,
    });
    const s2Id = s2.statements[0]?.statement_id as string;

    // Both live — the disputed statement stays disputed + a decision
    // item sits open; nothing merged.
    expect((await getStmt(s1Id)).status).toBe('disputed');
    expect((await getStmt(s2Id)).status).toBe('proposed');
    const disputes = (await openDecisions()).filter((d) =>
      d.decision_id.includes('-dispute-'),
    );
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.statement_id).toBe(s1Id);

    // The slot bound to both statements is `conflicted` — the
    // disagreement is a decision, and the planner never asks about it.
    await seedMvpWizards(ictx());
    const session = await startSession(ictx(), {
      wizardId: 'solution-discovery',
      subject: 'board:ideas',
    });
    await bindStatementsToSlots(
      ictx(),
      session.session_id,
      ['problem'],
      [await getStmt(s1Id), await getStmt(s2Id)],
    );
    expect((await getSlot(ictx(), session.session_id, 'problem'))?.state).toBe(
      'conflicted',
    );
    const readiness = await evaluateReadiness(ictx(), session.session_id);
    expect(readiness.draft_ready).toBe(false);
    expect(readiness.approval_ready).toBe(false);
    expect(readiness.open_decisions).toContain(disputes[0]?.decision_id);
    const { eligible } = await computeEligibility(ictx(), session.session_id);
    expect(eligible.map((e) => e.slot)).not.toContain('problem');
    const plan = await planNextQuestion(ictx(), {
      sessionId: session.session_id,
    });
    expect(plan?.slot).not.toBe('problem');

    // Human ruling: keep s1, reject s2 — the slot recovers to known.
    await decideStatementDecision(store, {
      workspace: WS,
      decision_id: disputes[0]?.decision_id as string,
      decision: 's1 stands — self-serve is in scope',
      apply: 'confirmed',
      actor: HUMAN,
      now,
    });
    await rejectStatement(store, {
      workspace: WS,
      statement_id: s2Id,
      actor: HUMAN,
      now,
    });
    await bindStatementsToSlots(ictx(), session.session_id, ['problem'], []);
    expect((await getSlot(ictx(), session.session_id, 'problem'))?.state).toBe(
      'known',
    );
  });

  it('defers an unanswerable question and never re-asks it', async () => {
    await seedMvpWizards(ictx());
    const session = await startSession(ictx(), {
      wizardId: 'solution-discovery',
      subject: 'board:ideas',
    });
    const sessionId = session.session_id;

    const q = await planNextQuestion(ictx(), { sessionId });
    expect(q?.slot).toBe('problem'); // highest-impact required slot
    await askQuestion(ictx(), { sessionId, questionId: q?.question_id });
    const resolved = await resolveQuestion(ictx(), {
      sessionId,
      questionId: q?.question_id as string,
      status: 'unanswerable',
      reason: 'only the CFO knows',
    });
    expect(resolved.status).toBe('unanswerable');
    expect(resolved.resolved_at).not.toBeNull();

    // The slot is deferred (a routed outcome, not lost) and the
    // transcript carries the unresolved note durably.
    expect((await getSlot(ictx(), sessionId, 'problem'))?.state).toBe(
      'deferred',
    );
    const msgs = await transcript(ictx(), sessionId);
    expect(
      msgs.some(
        (m) => m.role === 'system' && m.content.includes('[unresolved]'),
      ),
    ).toBe(true);

    // Re-planning never asks that slot again — proposed questions for
    // `problem` stay empty across repeated plans.
    const { eligible } = await computeEligibility(ictx(), sessionId);
    expect(eligible.map((e) => e.slot)).not.toContain('problem');
    await planNextQuestion(ictx(), { sessionId });
    await planNextQuestion(ictx(), { sessionId });
    const problemQuestions = (await listQuestions(ictx(), sessionId)).filter(
      (x) => x.slot === 'problem',
    );
    expect(problemQuestions.every((x) => x.status !== 'proposed')).toBe(true);

    // A deferred required slot still satisfies the draft gate but not
    // approval — until a human marks it not-applicable.
    const report = await evaluateReadiness(ictx(), sessionId);
    expect(
      report.approval_blockers.some(
        (b) => b.slot === 'problem' && b.state === 'deferred',
      ),
    ).toBe(true);
    await markSlot(ictx(), {
      sessionId,
      slot: 'problem',
      state: 'not-applicable',
      value: 'deferred pending CFO review',
    });
    expect((await getSlot(ictx(), sessionId, 'problem'))?.state).toBe(
      'not-applicable',
    );
  });

  it('resurfaces a deferred board only as an approval-required proposal', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      board_type: 'new-project',
      status: 'discovery',
      actor: HUMAN,
      now,
    });
    const note = await createTypedNote(store, {
      workspace: WS,
      board: 'ideas',
      note_kind: 'idea',
      title: 'Offline mode',
      body: 'The app works without a network connection.',
      actor: HUMAN,
      now,
    });
    await ingestStatementsArtifact(store, {
      workspace: WS,
      subject: 'board:ideas',
      sources: [
        {
          ref: { kind: 'board-item', id: note.id },
          text: `${note.title}\n\n${note.body}`,
        },
      ],
      runId: (
        await runAgentStage({
          subject: 'board:ideas',
          stage: 'extract',
          spec: {
            sentinel: 'DONE',
            artifacts: {
              'statements.json': {
                schema: 1,
                statements: [
                  {
                    key: 'offline',
                    text: 'The app works without a network connection',
                    source: 0,
                    source_text: 'The app works without a network connection.',
                    intent: 'want',
                    subject: 'offline',
                  },
                ],
              },
            },
          },
        })
      ).runId,
      actor: 'e2e-bot',
      extractionRunId: 'xr-defer',
      now,
    });

    await deferBoard(store, {
      workspace: WS,
      board: 'ideas',
      actor: HUMAN,
      now,
    });
    expect((await store.getBoard(WS, 'ideas'))?.status).toBe('deferred');

    // AI proposes; the proposal is read-only and approval-required.
    const proposal = await proposeResurface(store, {
      workspace: WS,
      board: 'ideas',
      reason: 'offline demand resurfaced in feedback',
      actor: AGENT,
    });
    expect(proposal.requires_approval).toBe(true);
    expect(proposal.proposed_by).toBe('agent');
    expect(proposal.retained_items).toBe(1);
    expect(proposal.open_statements).toBe(1);
    expect((await store.getBoard(WS, 'ideas'))?.status).toBe('deferred');

    // Only a human accepts.
    await expect(
      acceptResurface(store, {
        workspace: WS,
        board: 'ideas',
        actor: AGENT,
        now,
      }),
    ).rejects.toThrow(BoardError);
    const board = await acceptResurface(store, {
      workspace: WS,
      board: 'ideas',
      actor: HUMAN,
      now,
    });
    expect(board.status).toBe('discovery');
    // Evidence retained — the card and its statement survive the round trip.
    expect(
      await statementsForItem(store, {
        workspace: WS,
        itemId: note.id,
      }),
    ).toHaveLength(1);

    // A live board cannot be "resurfaced".
    await expect(
      proposeResurface(store, {
        workspace: WS,
        board: 'ideas',
        reason: 'again',
        actor: AGENT,
      }),
    ).rejects.toThrow(BoardError);
  });
});
