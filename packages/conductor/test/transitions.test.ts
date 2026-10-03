/**
 * wp-031 tests — the sentinel→transition table behind the seam.
 *
 * Drives `RealTransitionHandler` directly against a SqliteStore
 * (:memory:) and real tmp git tickets repos: no adapter needed — the
 * handler only sees RunOutcome + TransitionTools, both built here.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '@sprint-runner/config';
import {
  EVENT_NAMES,
  type EventName,
  type RunResult,
  type RunRow,
  type Stage,
  type TicketRow,
} from '@sprint-runner/core';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApplyStatusOptions,
  type RunOutcome,
  type TransitionContext,
  type TransitionTools,
  applyTicketStatus,
} from '../src/contracts.js';
import {
  NEEDS_INFO_CAP,
  RealTransitionHandler,
  TRANSITION_TABLE,
} from '../src/transitions/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TICKETS_FIXTURE = join(HERE, '../../../fixtures/tickets-repo');
const WS = 'ws';

let dir: string;
let ticketsRepo: string;
let store: SqliteStore;
let handler: RealTransitionHandler;
let requestedRuns: {
  subject: string;
  stage: string;
  ticketId?: string;
  tokens?: Record<string, string>;
}[];

function gitInit(repo: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
}

function makeConfig(gates: 'full' | 'plan-package' | 'minimal' = 'full') {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      gates,
      repos: {},
      security: { scan_on_commit: false },
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function ctx(): TransitionContext {
  return {
    workspace: WS,
    ticketsRepoPath: ticketsRepo,
    store,
    actor: 'test-bot',
    now: () => new Date('2026-10-05T00:00:00Z'),
  };
}

function tools(c = ctx()): TransitionTools {
  return {
    ...c,
    applyTicketStatus: (opts: ApplyStatusOptions) =>
      applyTicketStatus({
        ctx: c,
        opts,
        actor: { name: c.actor, email: `${c.actor}@sprint-runner.local` },
      }),
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
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        human_minutes: null,
      }),
    requestRun: async (req) => {
      requestedRuns.push(req);
      return `${WS}/${req.subject}/001-${req.stage}`;
    },
  };
}

async function seedTicket(
  id: string,
  status: TicketRow['status'],
  extraFm = '',
): Promise<TicketRow> {
  const dirPath = join(ticketsRepo, 'tickets', id);
  mkdirSync(dirPath, { recursive: true });
  const fm = [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${status}`,
    'priority: medium',
    'repos: [code-repo]',
    extraFm,
    '---',
    '',
    '## Description',
    'A sufficiently long description for spec lint purposes, detailing the work.',
    '',
    '## Acceptance criteria',
    '- [ ] Something verifiable happens',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  writeFileSync(join(dirPath, 'ticket.md'), fm);
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    title: `${id} title`,
    status,
    priority: 'medium',
    depth: 'standard',
    backend: null,
    model: null,
    repos: ['code-repo'],
    parent: null,
    depends_on: [],
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    updated_at: new Date().toISOString(),
  };
  await store.upsertTicket(row);
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
    status: 'done',
    started_at: '2026-10-05T00:00:00Z',
    heartbeat_at: null,
    exited_at: '2026-10-05T00:01:00Z',
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

function outcome(
  run: RunRow,
  sentinelRaw: string,
  artifacts: string[] = [],
): RunOutcome {
  const result: RunResult = {
    sentinel: sentinelRaw.split(':')[0] ?? sentinelRaw,
    sentinel_raw: sentinelRaw,
    artifacts,
    usage: null,
    exit_code: 0,
  };
  return { run, result, usagePath: null };
}

function ticketMd(id: string): string {
  return readFileSync(join(ticketsRepo, 'tickets', id, 'ticket.md'), 'utf8');
}

const events = (ticketId?: string) =>
  store.listEvents({
    workspace: WS,
    ...(ticketId ? { ticket_id: ticketId } : {}),
  });

const gates = () => store.listGateItems({ workspace: WS });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-wp031-'));
  ticketsRepo = join(dir, 'tickets-repo');
  cpSync(TICKETS_FIXTURE, ticketsRepo, { recursive: true });
  gitInit(ticketsRepo);
  store = new SqliteStore(':memory:');
  requestedRuns = [];
  handler = new RealTransitionHandler(makeConfig());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('table coverage', () => {
  it("every (stage, sentinel) row in CONDUCTOR's table has a handler", () => {
    // Every CONDUCTOR.md sentinel→transition row, as (stage, sentinel,
    // payload-fork) — this list is the spec contract under test.
    const specRows: [string, string, string?][] = [
      ['interview', 'INTERVIEW-QA'],
      ['interview', 'TICKET-AUTHORED'],
      ['interview', 'WONT-DRAFT'],
      ['import', 'IMPORTED'],
      ['import', 'IMPORT-FAILED'],
      ['probe', 'CARD-WRITTEN'],
      ['probe', 'PROBE-FAILED'],
      ['triage', 'READY'],
      ['triage', 'NEEDS-INFO'],
      ['triage', 'ESCALATE', 'needs split'],
      ['triage', 'ESCALATE', 'anything else'],
      ['split', 'SPLIT-PROPOSED'],
      ['split', 'UNSPLITTABLE'],
      ['prd', 'PRD-WRITTEN'],
      ['design', 'DESIGN-QA'],
      ['design', 'TDD-WRITTEN'],
      ['testplan', 'TESTPLAN-WRITTEN'],
      ['prd', 'ESCALATE'],
      ['design', 'ESCALATE'],
      ['testplan', 'ESCALATE'],
      ['implement', 'DONE'],
      ['review', 'PASS-COMPLETE'],
      ['review', 'PASS-FAILED'],
      ['fix', 'FIXES-COMPLETE'],
      ['discuss', 'REPLIED'],
      ['discuss', 'NEEDS-FIX-RUN'],
      ['ci-fix', 'CI-FIXED'],
      ['comment-fix', 'COMMENTS-PROCESSED'],
      ['rebase', 'REBASED'],
      ['revert', 'REVERT-READY'],
      ['doc-repair', 'REPAIRED'],
      ['doc-repair', 'REPAIR-FAILED'],
      ['escalate', 'ESCALATION-WRITTEN'],
      ['survey', 'SURVEY-COMPLETE'],
      ['survey', 'SURVEY-FAILED'],
      ['*', 'BLOCKED'],
    ];
    const implemented = new Set(handler.implementedActions);
    for (const [stage, sentinel, payload] of specRows) {
      const row = TRANSITION_TABLE.find(
        (r) =>
          (r.stage === stage || r.stage === '*') &&
          r.sentinel === sentinel &&
          (r.when === undefined || r.when(payload ?? '')),
      );
      expect(row, `missing table row (${stage}, ${sentinel})`).toBeDefined();
      expect(
        implemented.has((row as { action: string }).action),
        `no action impl for ${row?.action}`,
      ).toBe(true);
    }
    // And no dead rows: every table row dispatches to a real action.
    for (const row of TRANSITION_TABLE) {
      expect(implemented.has(row.action), `dead row ${row.action}`).toBe(true);
    }
  });
});

describe('auto-advance chain', () => {
  it('imported → triage → needs-info → answers → ready → prd-draft', async () => {
    const ticket = await seedTicket('SR-0001', 'imported');

    // imported → inline spec-lint + triage run.
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    const next1 = await handler.nextStage(t ?? ticket, ctx());
    expect(next1?.stage).toBe('triage');
    expect(ticketMd('SR-0001')).toMatch(/^status: triage$/m);
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'spec_scored',
    );

    // triage NEEDS-INFO → needs-info + question gate.
    const run1 = await makeRun('SR-0001', 'triage', 'NEEDS-INFO', 'SR-0001');
    await handler.onRunComplete(outcome(run1, 'NEEDS-INFO: 2'), tools());
    expect(ticketMd('SR-0001')).toMatch(/^status: needs-info$/m);
    const qGate = (await gates()).find((g) => g.gate === 'needs-info');
    expect(qGate?.kind).toBe('question');
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'question_asked',
    );

    // Open gate → nothing to claim.
    const t2 = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(await handler.nextStage(t2 as TicketRow, ctx())).toBeNull();

    // Answers committed → gate cleared → re-triage.
    await store.clearGateItem(
      { workspace: WS, subject: 'SR-0001', gate: 'needs-info' },
      new Date().toISOString(),
    );
    const t3 = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    const next3 = await handler.nextStage(t3 as TicketRow, ctx());
    expect(next3?.stage).toBe('triage');
    expect(ticketMd('SR-0001')).toMatch(/^status: triage$/m);
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'question_answered',
    );
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'gate_approved',
    );

    // triage READY (with suggestions) → ready → auto prd-draft.
    writeFileSync(
      join(ticketsRepo, 'tickets', 'SR-0001', 'triage.json'),
      JSON.stringify({
        schema: 1,
        ticket: 'SR-0001',
        round: 2,
        suggestions: {
          backend: 'aider',
          model: 'openrouter/x',
          priority: 'low',
          depth: 'deep',
        },
      }),
    );
    const run2 = await makeRun('SR-0001', 'triage', 'READY', 'SR-0001');
    await handler.onRunComplete(outcome(run2, 'READY'), tools());
    expect(ticketMd('SR-0001')).toMatch(/^status: ready$/m);

    const t4 = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    const next4 = await handler.nextStage(t4 as TicketRow, ctx());
    expect(next4?.stage).toBe('prd');
    expect(ticketMd('SR-0001')).toMatch(/^status: prd-draft$/m);
  });

  it('READY applies suggestions but human-set fields win', async () => {
    await seedTicket('SR-0001', 'triage', 'backend: devin\npriority: high');
    writeFileSync(
      join(ticketsRepo, 'tickets', 'SR-0001', 'triage.json'),
      JSON.stringify({
        suggestions: {
          backend: 'aider',
          model: 'openrouter/x',
          priority: 'low',
          depth: 'deep',
        },
      }),
    );
    const run = await makeRun('SR-0001', 'triage', 'READY', 'SR-0001');
    await handler.onRunComplete(outcome(run, 'READY'), tools());
    const fm = ticketMd('SR-0001');
    // Human-set backend+priority preserved; absent model/depth applied.
    expect(fm).toMatch(/^backend: devin$/m);
    expect(fm).toMatch(/^priority: high$/m);
    expect(fm).toMatch(/^model: openrouter\/x$/m);
    expect(fm).toMatch(/^depth: deep$/m);
    expect(fm).toMatch(/^suggested_model: openrouter\/x$/m);
    expect(fm).toMatch(/^status: ready$/m);
  });

  it('needs-info rounds cap 3 → escalated', async () => {
    await seedTicket('SR-0001', 'triage');
    for (let i = 0; i < NEEDS_INFO_CAP; i++) {
      await makeRun('SR-0001', 'triage', 'NEEDS-INFO', 'SR-0001');
    }
    const run = await makeRun('SR-0001', 'triage', 'NEEDS-INFO', 'SR-0001');
    await handler.onRunComplete(outcome(run, 'NEEDS-INFO: 4'), tools());
    expect(ticketMd('SR-0001')).toMatch(/^status: escalated$/m);
    const g = (await gates()).find((x) => x.gate === 'escalated');
    expect(g?.kind).toBe('escalation');
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'escalated',
    );
  });
});

describe('split', () => {
  it('ESCALATE: needs split → split run → split-plan gate → materialize', async () => {
    const ticket = await seedTicket('SR-0001', 'triage');

    // triage ESCALATE: needs split → queues a split run.
    const tRun = await makeRun('SR-0001', 'triage', 'ESCALATE', 'SR-0001');
    await handler.onRunComplete(
      outcome(tRun, 'ESCALATE: needs split'),
      tools(),
    );
    expect(requestedRuns).toContainEqual(
      expect.objectContaining({ subject: 'SR-0001', stage: 'split' }),
    );

    // The split run writes split-plan.md + children/ drafts cardless.
    const ticketDir = join(ticketsRepo, 'tickets', 'SR-0001');
    writeFileSync(
      join(ticketDir, 'split-plan.md'),
      [
        '# Split plan — SR-0001',
        '## Children',
        '| child | title | repos | depends_on | covers |',
        '| --- | --- | --- | --- | --- |',
        '| c1 | part one | code-repo | | ac1 |',
        '| c2 | part two | code-repo | c1 | ac2 |',
        '## Rationale',
        'split by layer',
        '',
      ].join('\n'),
    );
    mkdirSync(join(ticketDir, 'children'), { recursive: true });
    for (const label of ['c1', 'c2']) {
      writeFileSync(
        join(ticketDir, 'children', `${label}.md`),
        [
          '---',
          'schema: 1',
          `id: SR-0001-${label}`,
          `title: part ${label}`,
          'status: imported',
          'priority: medium',
          'repos: [code-repo]',
          'parent: SR-0001',
          'depends_on: []',
          '---',
          '',
          '## Description',
          'child draft',
          '',
        ].join('\n'),
      );
    }
    const sRun = await makeRun('SR-0001', 'split', 'SPLIT-PROPOSED', 'SR-0001');
    await handler.onRunComplete(outcome(sRun, 'SPLIT-PROPOSED: 2'), tools());
    const sp = (await gates()).find((g) => g.gate === 'split-plan');
    expect(sp?.kind).toBe('split-plan');
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'split_proposed',
    );

    // Open gate parks the ticket.
    expect(await handler.nextStage(ticket, ctx())).toBeNull();

    // Approve → materialize.
    await store.clearGateItem(
      { workspace: WS, subject: 'SR-0001', gate: 'split-plan' },
      new Date().toISOString(),
    );
    expect(await handler.nextStage(ticket, ctx())).toBeNull();
    expect(ticketMd('SR-0001')).toMatch(/^status: split$/m);
    const names = (await events('SR-0001')).map((e) => e.event);
    expect(names).toContain('split_approved');
    expect(names).toContain('split_materialized');
    // Children materialized as real tickets with sibling depends_on;
    // ids came from .sprint-runner/next-id (fixture decides numbering).
    const ticketDirs = execFileSync('ls', [join(ticketsRepo, 'tickets')], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(
        (d) =>
          d.startsWith('SR-') &&
          d !== 'SR-0001' &&
          d !== 'SR-0002' &&
          d !== 'SR-0003',
      );
    expect(ticketDirs.length).toBe(2);
    const childA = ticketMd(ticketDirs[0] as string);
    const childB = ticketMd(ticketDirs[1] as string);
    expect(childA).toMatch(/^parent: SR-0001$/m);
    expect(childB).toMatch(/^parent: SR-0001$/m);
    // c2 depends on c1's real id.
    const c1Id = /^id: (SR-\d+)$/m.exec(childA)?.[1];
    expect(childB).toContain(`depends_on: [${c1Id}]`);
  });
});

describe('gate modes', () => {
  it('minimal suppresses doc-review gates (prd-review auto-advances)', async () => {
    handler = new RealTransitionHandler(makeConfig('minimal'));
    await seedTicket('SR-0001', 'prd-draft');
    writeFileSync(join(ticketsRepo, 'tickets', 'SR-0001', 'prd.md'), '# PRD\n');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    expect(ticketMd('SR-0001')).toMatch(/^status: prd-review$/m);
    expect((await gates()).filter((g) => g.gate === 'prd-review')).toHaveLength(
      0,
    );
    // Auto-advance straight through to the design stage.
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    const next = await handler.nextStage(t as TicketRow, ctx());
    expect(next?.stage).toBe('design');
    expect(ticketMd('SR-0001')).toMatch(/^status: tdd-draft$/m);
  });

  it('full mode surfaces the prd-review gate', async () => {
    await seedTicket('SR-0001', 'prd-draft');
    writeFileSync(join(ticketsRepo, 'tickets', 'SR-0001', 'prd.md'), '# PRD\n');
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    const g = (await gates()).find((x) => x.gate === 'prd-review');
    expect(g?.kind).toBe('review');
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(await handler.nextStage(t as TicketRow, ctx())).toBeNull();
    // Cleared → prd-approved → auto design.
    await store.clearGateItem(
      { workspace: WS, subject: 'SR-0001', gate: 'prd-review' },
      new Date().toISOString(),
    );
    const next = await handler.nextStage(t as TicketRow, ctx());
    expect(next?.stage).toBe('design');
    expect(ticketMd('SR-0001')).toMatch(/^status: tdd-draft$/m);
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'doc_approved',
    );
  });
});

describe('events + LOG.md', () => {
  it('every SCHEMAS §7 event name is emitted somewhere in conductor src', async () => {
    const { readdirSync } = await import('node:fs');
    const { join: j } = await import('node:path');
    const srcDir = join(HERE, '../src');
    const collect = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? collect(j(d, e.name))
          : e.name.endsWith('.ts')
            ? [j(d, e.name)]
            : [],
      );
    const corpus = collect(srcDir)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const missing = EVENT_NAMES.filter(
      (n: EventName) =>
        !corpus.includes(`'${n}'`) && !corpus.includes(`"${n}"`),
    );
    expect(missing).toEqual([]);
  });

  it('applyTicketStatus commits frontmatter + updates projection + emits status_changed', async () => {
    await seedTicket('SR-0001', 'triage');
    const res = await tools().applyTicketStatus({
      ticketId: 'SR-0001',
      status: 'blocked',
      blockedReason: 'env',
    });
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ticketMd('SR-0001')).toMatch(/^status: blocked$/m);
    expect(ticketMd('SR-0001')).toMatch(/^blocked_reason: env$/m);
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(t?.status).toBe('blocked');
    expect(t?.blocked_reason).toBe('env');
    const ev = (await events('SR-0001')).find(
      (e) => e.event === 'status_changed',
    );
    expect(ev?.data).toMatchObject({ to: 'blocked' });
  });

  it('BLOCKED from any stage → blocked + blocked_reason', async () => {
    await seedTicket('SR-0001', 'triage');
    const run = await makeRun('SR-0001', 'triage', 'BLOCKED', 'SR-0001');
    await handler.onRunComplete(outcome(run, 'BLOCKED: env'), tools());
    expect(ticketMd('SR-0001')).toMatch(/^status: blocked$/m);
    expect(ticketMd('SR-0001')).toMatch(/^blocked_reason: env$/m);
    expect((await events('SR-0001')).map((e) => e.event)).toContain('blocked');
    expect(existsSync(join(ticketsRepo, 'tickets', 'SR-0001', 'LOG.md'))).toBe(
      true,
    );
  });
});
