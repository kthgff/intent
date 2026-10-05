/**
 * wp-111 — intelligence integration (D37, INTELLIGENCE).
 *
 * Two surfaces under test:
 *
 * 1. Launch grounding (AC: "existing-product prd-draft obtains and
 *    validates a scoped evidence bundle before prompt rendering;
 *    greenfield/zero-result behavior is explicit" + "design/test/
 *    implement/review prompts receive task-bounded evidence"). Driven
 *    end-to-end through makeFixtureWorld: the validated
 *    `retrieval-evidence.json` run artifact exists before the agent
 *    ever sees a prompt, and the rendered prompt carries the bundle.
 *
 * 2. RS-quality ingest (AC: "the AI quality pass never auto-approves a
 *    PRD and does not replace or alter deterministic spec_score" + the
 *    twelve-dimension coverage contract). Driven directly against
 *    RealTransitionHandler — the same harness as transitions.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@sprint-runner/config';
import {
  type GateItem,
  RS_QUALITY_DIMENSIONS,
  REVIEW_PASSES,
  type RunResult,
  type RunRow,
  type Stage,
  type TicketRow,
} from '@sprint-runner/core';
import { indexRepo } from '@sprint-runner/kb';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApplyStatusOptions,
  type RunOutcome,
  type TransitionContext,
  type TransitionTools,
  applyTicketStatus,
} from '../src/contracts.js';
import { parseTicketMd } from '../src/import/parse.js';
import { RealTransitionHandler } from '../src/transitions/index.js';
import {
  type FixtureWorld,
  type MockScript,
  type ScriptedRunInfo,
  WS,
  makeFixtureWorld,
  rsDoc,
  rsQualityDoc,
  tddDoc,
  testReport,
  ticketMd,
  vsDoc,
} from './helpers/fixtures.js';

const NOW = '2026-10-05T00:00:00Z';

let world: FixtureWorld | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

// ---------------------------------------------------------------------------
// Launch grounding (AC1 + AC4) — e2e through the real launch path
// ---------------------------------------------------------------------------

/** wp-111 stage → retrieval task contract (SCHEMAS §17 `task`). */
const EVIDENCE_TASK: Record<string, string> = {
  prd: 'prd',
  design: 'impact',
  testplan: 'testplan',
  implement: 'implement',
  review: 'review',
};

/** Straight-through doc/spec script — every stage a wp-111 evidence
 *  stage runs against completes in one attempt. */
function wp111Script(r: ScriptedRunInfo): MockScript {
  const td = r.ticketDir as string;
  const id = r.ticketId ?? r.subject;
  switch (r.stage) {
    case 'prd':
      return {
        sentinel: 'PRD-WRITTEN',
        files: {
          [join(td, 'rs.md')]: rsDoc(id),
          [join(td, 'rs-quality.json')]: rsQualityDoc(id),
        },
      };
    case 'design':
      return {
        sentinel: 'TDD-WRITTEN',
        files: { [join(td, 'tdd.md')]: tddDoc(id) },
      };
    case 'testplan':
      return {
        sentinel: 'TESTPLAN-WRITTEN',
        files: { [join(td, 'vs.md')]: vsDoc(id) },
      };
    case 'implement':
      return { sentinel: 'DONE' };
    case 'verify':
      return {
        sentinel: 'DONE',
        artifacts: { 'test-report.json': testReport() },
      };
    case 'review': {
      const pass = REVIEW_PASSES[
        (r.attempt - 1) % REVIEW_PASSES.length
      ] as string;
      return {
        sentinel: `PASS-COMPLETE: ${pass}`,
        artifacts: { [`findings-${pass}.json`]: [] },
      };
    }
    default:
      return 'done';
  }
}

/** Minimal `repos: []` greenfield ticket (the fixture helper always
 *  writes `repos: [code-repo]`). */
function greenfieldMd(id: string, status: string): string {
  return [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: Greenfield ${id}`,
    `status: ${status}`,
    'priority: medium',
    'repos: []',
    '---',
    '',
    '## Description',
    'A brand-new surface with no existing code in scope.',
    '',
    '## Acceptance criteria',
    '- [ ] Something verifiable happens',
    '',
  ].join('\n');
}

async function evidenceArtifact(runId: string) {
  const a = await world?.store.getArtifact(runId, 'retrieval-evidence.json');
  if (!a) return null;
  return JSON.parse(a.content) as {
    schema: number;
    request: { task: string; repos: string[]; subject: string | null };
    index_heads: { repo: string; commit_sha: string }[];
    results: { repo: string; object_ref: string }[];
    zero_result_reason: string | null;
  };
}

describe('launch grounding — scoped evidence bundle before prompt render', () => {
  it(
    'existing-product: prd/design/testplan/implement/review get task-bounded bundles',
    { timeout: 240_000 },
    async () => {
      world = await makeFixtureWorld({
        configOverrides: { gates: 'minimal' },
        tickets: {
          'SR-0001': null,
          'SR-0002': null,
          'SR-0003': null,
          // Title carries an exact-identifier token (`main`) so the
          // retrieval bundle is provably non-empty.
          'SR-0100': ticketMd({
            id: 'SR-0100',
            status: 'ready',
            title: 'Exercise the main entrypoint',
          }),
        },
        script: wp111Script,
      });
      // Index the fixture repo so grounding has real heads to pin.
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: world.codeRepo,
      })
        .toString()
        .trim();
      await indexRepo(world.store, {
        workspace: WS,
        repo: 'code-repo',
        checkoutDir: world.codeRepo,
        commitSha: sha,
      });

      // Minimal mode flows through every stage with zero doc gates.
      await world.runToStatus('SR-0100', 'changes-requested');

      const runs = await world.runsFor('SR-0100');
      for (const [stage, task] of Object.entries(EVIDENCE_TASK)) {
        const stageRuns = runs.filter(
          (r) => r.stage === stage && r.status === 'done',
        );
        expect(stageRuns.length, `no done ${stage} run`).toBeGreaterThan(0);
        for (const run of stageRuns) {
          const bundle = await evidenceArtifact(run.id);
          expect(bundle, `${stage} run missing evidence artifact`).not
            .toBeNull();
          // Validated §17 bundle — task-bounded + subject-scoped.
          expect(bundle?.schema).toBe(1);
          expect(bundle?.request.task).toBe(task);
          expect(bundle?.request.subject).toBe('SR-0100');
          // ACL: the ticket's own repos only.
          expect(bundle?.request.repos).toEqual(['code-repo']);
          expect(bundle?.index_heads).toEqual([
            { repo: 'code-repo', commit_sha: sha },
          ]);
        }
        // The bundle was rendered into the prompt BEFORE the agent ran
        // — the token never reaches the model unexpanded.
        const seen = world.adapter.seen.filter(
          (s) => s.subject === 'SR-0100' && s.stage === stage,
        );
        for (const s of seen) {
          expect(s.prompt).toBeDefined();
          expect(s.prompt).not.toContain('{{EVIDENCE_BUNDLE}}');
          expect(s.prompt).toContain('Evidence bundle');
        }
      }

      // The prd bundle provably cited real code (exact-symbol `main`).
      const prdRun = runs.find((r) => r.stage === 'prd');
      const prdBundle = await evidenceArtifact(prdRun?.id ?? '');
      expect(prdBundle?.results.length).toBeGreaterThan(0);
      expect(
        prdBundle?.results.some((r) =>
          r.object_ref.startsWith('code:code-repo:'),
        ),
      ).toBe(true);
      const prdSeen = world.adapter.seen.find(
        (s) => s.subject === 'SR-0100' && s.stage === 'prd',
      );
      expect(prdSeen?.prompt).toContain('code-repo@');

      // `verify` is a runner task, not a prompt stage — no bundle.
      const verifyRun = runs.find((r) => r.stage === 'verify');
      expect(await evidenceArtifact(verifyRun?.id ?? '')).toBeNull();
    },
  );

  it(
    'greenfield (repos: []) renders an explicit no-evidence bundle, never silent',
    { timeout: 120_000 },
    async () => {
      world = await makeFixtureWorld({
        configOverrides: { gates: 'minimal' },
        tickets: {
          'SR-0001': null,
          'SR-0002': null,
          'SR-0003': null,
          'SR-0200': greenfieldMd('SR-0200', 'ready'),
        },
        script: wp111Script,
      });
      // prd → prd-review (auto) → tdd-draft means the prd run finished.
      await world.runToStatus('SR-0200', 'tdd-draft');
      const prdRun = (await world.runsFor('SR-0200')).find(
        (r) => r.stage === 'prd' && r.status === 'done',
      );
      expect(prdRun).toBeDefined();
      const bundle = await evidenceArtifact(prdRun?.id ?? '');
      expect(bundle).not.toBeNull();
      expect(bundle?.results).toHaveLength(0);
      expect(bundle?.index_heads).toHaveLength(0);
      expect(bundle?.zero_result_reason).toContain('greenfield');
      // …and the prompt carried the explicit marker, not a blank.
      const seen = world.adapter.seen.find(
        (s) => s.subject === 'SR-0200' && s.stage === 'prd',
      );
      expect(seen?.prompt).toContain('No relevant evidence');
      expect(seen?.prompt).toContain('greenfield');
    },
  );

  it(
    'intelligence.grounding: off — the disabled reason is explicit',
    { timeout: 120_000 },
    async () => {
      world = await makeFixtureWorld({
        configOverrides: {
          gates: 'minimal',
          intelligence: { grounding: false },
        },
        tickets: {
          'SR-0001': null,
          'SR-0002': null,
          'SR-0003': ticketMd({ id: 'SR-0003', status: 'ready' }),
        },
        script: wp111Script,
      });
      await world.runToStatus('SR-0003', 'tdd-draft');
      const prdRun = (await world.runsFor('SR-0003')).find(
        (r) => r.stage === 'prd' && r.status === 'done',
      );
      const bundle = await evidenceArtifact(prdRun?.id ?? '');
      expect(bundle?.zero_result_reason).toContain('disabled');
      const seen = world.adapter.seen.find(
        (s) => s.subject === 'SR-0003' && s.stage === 'prd',
      );
      expect(seen?.prompt).toContain('disabled');
    },
  );

  it(
    'zero relevant results is an explicit artifact — the run still proceeds',
    { timeout: 120_000 },
    async () => {
      world = await makeFixtureWorld({
        configOverrides: { gates: 'minimal' },
        tickets: {
          'SR-0001': null,
          'SR-0002': null,
          'SR-0003': ticketMd({
            id: 'SR-0003',
            status: 'ready',
            title: 'zzzqqq nothing matches this',
          }),
        },
        script: wp111Script,
      });
      // Index exists but nothing matches the query.
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: world.codeRepo,
      })
        .toString()
        .trim();
      await indexRepo(world.store, {
        workspace: WS,
        repo: 'code-repo',
        checkoutDir: world.codeRepo,
        commitSha: sha,
      });
      await world.runToStatus('SR-0003', 'tdd-draft');
      const prdRun = (await world.runsFor('SR-0003')).find(
        (r) => r.stage === 'prd' && r.status === 'done',
      );
      const bundle = await evidenceArtifact(prdRun?.id ?? '');
      expect(bundle?.results).toHaveLength(0);
      expect(bundle?.zero_result_reason).toBeTruthy();
    },
  );
});

// ---------------------------------------------------------------------------
// RS-quality ingest (AC2 + AC3) — direct RealTransitionHandler harness
// ---------------------------------------------------------------------------

let dir: string;
let store: PostgresStore;
let handler: RealTransitionHandler;
let requestedRuns: {
  subject: string;
  stage: string;
  ticketId?: string;
  tokens?: Record<string, string>;
}[];

function makeConfig(
  gates: 'full' | 'plan-package' | 'minimal' = 'full',
  intelligence: Record<string, unknown> = {},
) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      gates,
      repos: {},
      security: { scan_on_commit: false },
      intelligence,
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function ctx(): TransitionContext {
  return {
    workspace: WS,
    rootPath: dir,
    store,
    actor: 'test-bot',
    now: () => new Date(NOW),
  };
}

function tools(c = ctx()): TransitionTools {
  return {
    ...c,
    applyTicketStatus: (opts: ApplyStatusOptions) =>
      applyTicketStatus({ ctx: c, opts }),
    surfaceGateItem: async (item) => {
      const ts = c.now().toISOString();
      await store.upsertGateItem({
        workspace: WS,
        subject: item.subject,
        gate: item.gate,
        kind: item.kind,
        surfaced_at: ts,
        cleared_at: null,
        blocked_agent: item.blockedAgent ?? false,
        priority: item.priority ?? null,
      });
      await store.insertNotification({
        workspace: WS,
        subject: item.subject,
        kind: `gate:${item.kind}`,
        payload: JSON.stringify(item),
        created_at: ts,
        read_at: null,
      });
    },
    appendEvent: (e) =>
      store.appendEvent({
        workspace: WS,
        ticket_id: e.ticketId ?? null,
        ts: c.now().toISOString(),
        stage: e.stage ?? null,
        actor_type: e.actorType ?? 'runner',
        actor_id: c.actor,
        event: e.event,
        run: e.run ?? null,
        refs: e.refs ?? [],
        data: e.data ?? {},
        cost_usd: e.costUsd ?? null,
        tokens_in: e.tokensIn ?? null,
        tokens_out: e.tokensOut ?? null,
        tokens_cached: e.tokensCached ?? null,
        usage_source: e.usageSource ?? null,
        duration_s: e.durationS ?? null,
        human_minutes: e.humanMinutes ?? null,
      }),
    requestRun: async (req) => {
      requestedRuns.push(req);
      return `${WS}/${req.subject}/001-${req.stage}`;
    },
    getDocText: async (subject, doc) =>
      (await store.getDoc({ workspace: WS, subject, doc }))?.content ?? null,
    putDoc: async (subject, doc, content) =>
      (
        await store.appendDocVersion(
          { workspace: WS, subject, doc },
          content,
          c.actor,
        )
      ).version,
    getArtifactText: async (runId, name) =>
      (await store.getArtifact(runId, name))?.content ?? null,
    putArtifact: async (runId, name, content) => {
      await store.putArtifact({
        run_id: runId,
        name,
        content,
        created_at: c.now().toISOString(),
      });
    },
    getLatestArtifactText: async (name, filter) => {
      if (filter.runId && !filter.ticketId) {
        const a = await store.getArtifact(filter.runId, name);
        return a?.content ?? null;
      }
      const runs = (
        await store.listRuns(
          filter.ticketId
            ? { workspace: WS, ticket_id: filter.ticketId }
            : { workspace: WS },
        )
      ).sort((a, b) => b.id.localeCompare(a.id));
      for (const r of runs) {
        const a = await store.getArtifact(r.id, name);
        if (a) return a.content;
      }
      return null;
    },
    allocTicketId: () => store.allocTicketId(WS),
  };
}

async function seedTicket(
  id: string,
  status: TicketRow['status'],
): Promise<TicketRow> {
  const raw = [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${status}`,
    'priority: medium',
    'repos: [code-repo]',
    '---',
    '',
    '## Description',
    'A sufficiently long description for spec lint purposes.',
    '',
    '## Acceptance criteria',
    '- [ ] Something verifiable happens',
    '',
  ].join('\n');
  const parsed = parseTicketMd(raw, `${id}/ticket.md`);
  if (!parsed.ok) throw new Error(`seed ${id}: ${parsed.error.error}`);
  const fm = parsed.value.frontmatter;
  const ts = new Date().toISOString();
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature: fm.feature ?? null,
    title: fm.title,
    status: fm.status,
    priority: fm.priority,
    depth: fm.depth ?? null,
    backend: fm.backend ?? null,
    model: fm.model ?? null,
    repos: fm.repos,
    parent: fm.parent ?? null,
    depends_on: fm.depends_on,
    serves: null,
    source: fm.source ?? null,
    forced: fm.forced ?? false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: fm.blocked_reason ?? null,
    created_at: ts,
    updated_at: ts,
  };
  await store.upsertTicket(row);
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    raw,
    'test-seed',
  );
  return row;
}

let runSeq = 0;
async function makeRun(
  subject: string,
  stage: Stage,
  sentinel: string | null,
  ticketId?: string,
): Promise<RunRow> {
  const attempt = ++runSeq;
  const row: RunRow = {
    id: `${WS}/${subject}/${String(attempt).padStart(3, '0')}-${stage}`,
    workspace: WS,
    subject,
    ticket_id: ticketId ?? null,
    stage,
    attempt,
    backend: 'mock',
    model: null,
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: null,
    status: 'done',
    started_at: NOW,
    heartbeat_at: null,
    exited_at: NOW,
    sentinel,
    sentinel_raw: sentinel,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: null,
  };
  await store.createRun(row);
  return row;
}

function outcome(run: RunRow, sentinelRaw: string): RunOutcome {
  const result: RunResult = {
    sentinel: sentinelRaw.split(':')[0] ?? sentinelRaw,
    sentinel_raw: sentinelRaw,
    artifacts: [],
    usage: null,
    exit_code: 0,
  };
  return { run, result };
}

async function putRunArtifact(
  runId: string,
  name: string,
  content: string,
): Promise<void> {
  await store.putArtifact({ run_id: runId, name, content, created_at: NOW });
}

const gates = (): Promise<GateItem[]> => store.listGateItems({ workspace: WS });
const gate = (g: string) => store.getGateItem({ workspace: WS, subject: 'SR-0001', gate: g });
const evs = () => store.listEvents({ workspace: WS, ticket_id: 'SR-0001' });

function rsQuality(subject: string, findings: unknown[] = []): unknown {
  return {
    schema: 1,
    subject,
    doc_version: 1,
    evidence_ref: 'retrieval-evidence.json',
    dimensions_checked: [...RS_QUALITY_DIMENSIONS],
    findings,
    generated_at: NOW,
  };
}

const CRITICAL = {
  id: 'q1',
  dimension: 'abuse-security',
  severity: 'critical',
  claim: 'No abuse-case requirement covers credential stuffing on /login.',
  citations: ['rs.md#requirements', 'code:code-repo:deadbeef0:src/app.ts:main'],
  ref: 'ac:AC-1',
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-wp111-'));
  store = await PostgresStore.connect('pglite:');
  requestedRuns = [];
  handler = new RealTransitionHandler(makeConfig());
});

describe('rs-quality ingest — advisory, cited, never self-approving', () => {
  it('clean pass: findings evented, prd-review surfaces, spec_score untouched', async () => {
    const t = await seedTicket('SR-0001', 'prd-draft');
    await store.upsertTicket({ ...t, spec_score: 71 });
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await putRunArtifact(
      run.id,
      'rs-quality.json',
      `${JSON.stringify(rsQuality('SR-0001'))}\n`,
    );
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());

    // The doc gate proceeds normally — a clean pass holds nothing.
    expect((await gate('prd-review'))?.kind).toBe('review');
    expect(await gate('rs-quality')).toBeNull();
    // The pass is ledgered (never silent), with its dimension coverage.
    const fc = (await evs()).find((e) => e.event === 'finding_created');
    expect(fc).toBeDefined();
    expect(
      (fc?.data as { dimensions_checked?: string[] }).dimensions_checked,
    ).toHaveLength(12);
    // spec_score is deterministic spec-lint territory — the AI pass
    // never replaces or alters it.
    const after = await store.getTicket({
      workspace: WS,
      ticket_id: 'SR-0001',
    });
    expect(after?.spec_score).toBe(71);
    expect((await evs()).some((e) => e.event === 'spec_scored')).toBe(false);
  });

  it('critical findings surface an rs-quality gate with cited payload — never auto-approve', async () => {
    await seedTicket('SR-0001', 'prd-draft');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await putRunArtifact(
      run.id,
      'rs-quality.json',
      `${JSON.stringify(rsQuality('SR-0001', [CRITICAL]))}\n`,
    );
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());

    const g = await gate('rs-quality');
    expect(g?.kind).toBe('review');
    // The cited criticals ride the gate's notification payload
    // (DB-SCHEMA: notifications are generated on gate_items insert).
    // The cited criticals ride the gate's notification payload
    // (DB-SCHEMA: notifications are generated on gate_items insert —
    // the full payload lands on the surfaceGateItem notification).
    const notif = (await store.listNotifications({ workspace: WS }))
      .map(
        (n) =>
          JSON.parse(n.payload ?? '{}') as {
            gate?: string;
            payload?: unknown;
          },
      )
      .find((p) => p.gate === 'rs-quality' && p.payload !== undefined);
    const payload = notif?.payload as {
      criticals?: { id: string; citations: string[] }[];
    };
    expect(payload?.criticals?.[0]?.id).toBe('q1');
    expect(payload?.criticals?.[0]?.citations.length).toBeGreaterThan(0);

    // The ticket sits at prd-review, and even with the doc gate cleared
    // the open rs-quality item holds it — criticals never auto-approve.
    await store.clearGateItem(
      { workspace: WS, subject: 'SR-0001', gate: 'prd-review' },
      NOW,
    );
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(await handler.nextStage(t as TicketRow, ctx())).toBeNull();

    // Human waives the critical → the doc advances and the waiver is
    // evented exactly once (no re-stamp on later ticks).
    await store.clearGateItem(
      { workspace: WS, subject: 'SR-0001', gate: 'rs-quality' },
      NOW,
    );
    const next = await handler.nextStage(t as TicketRow, ctx());
    expect(next?.stage).toBe('design');
    const rqEvents = (await evs()).filter(
      (e) =>
        (e.event === 'gate_approved' || e.event === 'gate_overridden') &&
        (e.data as { gate?: string }).gate === 'rs-quality',
    );
    expect(rqEvents).toHaveLength(1);
    await handler.nextStage(t as TicketRow, ctx());
    const rqEvents2 = (await evs()).filter(
      (e) =>
        (e.event === 'gate_approved' || e.event === 'gate_overridden') &&
        (e.data as { gate?: string }).gate === 'rs-quality',
    );
    expect(rqEvents2).toHaveLength(1);
  });

  it('criticals still hold under minimal mode — mode suppression never auto-approves', async () => {
    handler = new RealTransitionHandler(makeConfig('minimal'));
    await seedTicket('SR-0001', 'prd-draft');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await putRunArtifact(
      run.id,
      'rs-quality.json',
      `${JSON.stringify(rsQuality('SR-0001', [CRITICAL]))}\n`,
    );
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    // prd-review auto-suppressed in minimal — the ticket lands
    // prd-review but cannot advance while the critical is unresolved.
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(t?.status).toBe('prd-review');
    expect(await handler.nextStage(t, ctx())).toBeNull();
    await store.clearGateItem(
      { workspace: WS, subject: 'SR-0001', gate: 'rs-quality' },
      NOW,
    );
    const next = await handler.nextStage(t, ctx());
    expect(next?.stage).toBe('design');
  });

  it('advisory mode: criticals are ledgered but no gate item surfaces', async () => {
    handler = new RealTransitionHandler(
      makeConfig('full', { critical_prd_findings: 'advisory' }),
    );
    await seedTicket('SR-0001', 'prd-draft');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await putRunArtifact(
      run.id,
      'rs-quality.json',
      `${JSON.stringify(rsQuality('SR-0001', [CRITICAL]))}\n`,
    );
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    expect(await gate('rs-quality')).toBeNull();
    expect((await gate('prd-review'))?.kind).toBe('review');
    const fc = (await evs()).find((e) => e.event === 'finding_created');
    expect((fc?.data as { critical?: number }).critical).toBe(1);
  });

  it('prd_quality: off skips the contract entirely (legacy path)', async () => {
    handler = new RealTransitionHandler(
      makeConfig('full', { prd_quality: false }),
    );
    await seedTicket('SR-0001', 'prd-draft');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    // No rs-quality.json at all — the switch is off, so no artifact is
    // required and no doc-repair is queued.
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    expect((await gate('prd-review'))?.kind).toBe('review');
    expect(requestedRuns.find((r) => r.stage === 'doc-repair')).toBeUndefined();
  });
});

describe('rs-quality ingest — fail-closed malformed artifacts', () => {
  it('missing rs-quality.json → doc-repair, never a silent pass', async () => {
    await seedTicket('SR-0001', 'prd-draft');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    const repair = requestedRuns.find((r) => r.stage === 'doc-repair');
    expect(repair).toBeDefined();
    expect(repair?.tokens?.REPAIR_DOC).toBe('rs-quality.json');
    expect(String(repair?.tokens?.LINT_VIOLATIONS)).toContain(
      'rs-quality.missing',
    );
    expect(await gate('prd-review')).toBeNull();
  });

  it('malformed JSON → doc-repair', async () => {
    await seedTicket('SR-0001', 'prd-draft');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await putRunArtifact(run.id, 'rs-quality.json', '{nope\n');
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    const repair = requestedRuns.find((r) => r.stage === 'doc-repair');
    expect(repair).toBeDefined();
    expect(await gate('prd-review')).toBeNull();
  });

  it('a silent partial pass (missing dimensions) is malformed, not skipped', async () => {
    await seedTicket('SR-0001', 'prd-draft');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    const partial = {
      ...rsQuality('SR-0001'),
      dimensions_checked: ['ambiguity', 'rollback'],
    };
    await putRunArtifact(
      run.id,
      'rs-quality.json',
      `${JSON.stringify(partial)}\n`,
    );
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    const repair = requestedRuns.find((r) => r.stage === 'doc-repair');
    expect(repair).toBeDefined();
    expect(String(repair?.tokens?.LINT_VIOLATIONS)).toContain(
      'rs-quality.dimensions',
    );
  });

  it('doc-repair resume: a fixed artifact records findings and lands prd-review', async () => {
    await seedTicket('SR-0001', 'prd-draft');
    const repairRun = await makeRun(
      'SR-0001',
      'doc-repair',
      'REPAIRED',
      'SR-0001',
    );
    await putRunArtifact(
      repairRun.id,
      'rs-quality.json',
      `${JSON.stringify(rsQuality('SR-0001'))}\n`,
    );
    await handler.onRunComplete(outcome(repairRun, 'REPAIRED'), tools());
    expect((await evs()).some((e) => e.event === 'finding_created')).toBe(
      true,
    );
    expect((await gate('prd-review'))?.kind).toBe('review');
  });
});
