/**
 * wp-031 tests — the sentinel→transition table behind the seam.
 *
 * Drives `RealTransitionHandler` directly against a PostgresStore
 * (PGlite): no adapter needed — the handler only sees RunOutcome +
 * TransitionTools, both built here. D29: tickets/docs/events are DB
 * rows — there is no tickets repo. ticket.md content lives in
 * `doc_versions`, structured stage output (triage.json, split-plan.md,
 * children drafts) in `run_artifacts`, and the `events` table is the
 * ledger (no events.jsonl, no LOG.md, no git commits).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import {
  NEEDS_INFO_CAP,
  RealTransitionHandler,
  TRANSITION_TABLE,
} from '../src/transitions/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = 'ws';
const NOW = '2026-10-05T00:00:00Z';

let dir: string;
let store: PostgresStore;
let handler: RealTransitionHandler;
let requestedRuns: {
  subject: string;
  stage: string;
  ticketId?: string;
  tokens?: Record<string, string>;
}[];

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
    rootPath: dir,
    store,
    actor: 'test-bot',
    now: () => new Date(NOW),
  };
}

/** A TransitionTools wired straight onto the store — mirrors the
 *  conductor's factory (loop/tools.ts) minus leases/launch, with
 *  requestRun recorded instead of queued. */
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

/** Seed one ticket: a `tickets` truth row + the `ticket.md` doc_version
 *  (D29). `extraFm` keys land in the frontmatter as `key: value` lines
 *  (`priority` overrides the default line — YAML forbids dup keys). */
async function seedTicket(
  id: string,
  status: TicketRow['status'],
  extraFm: Record<string, string> = {},
): Promise<TicketRow> {
  const { priority = 'medium', ...rest } = extraFm;
  const raw = [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${status}`,
    `priority: ${priority}`,
    'repos: [code-repo]',
    ...Object.entries(rest).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '## Description',
    'A sufficiently long description for spec lint purposes, detailing the work.',
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

/** Stage output the run "wrote" — a run_artifacts row keyed by
 *  run-dir-relative name (D29 ingestion shape). */
async function putRunArtifact(
  runId: string,
  name: string,
  content: string,
): Promise<void> {
  await store.putArtifact({
    run_id: runId,
    name,
    content,
    created_at: NOW,
  });
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
  return { run, result };
}

/** Latest ticket.md doc_version content (was a tickets-repo file read). */
async function ticketMd(id: string): Promise<string> {
  const doc = await store.getDoc({
    workspace: WS,
    subject: id,
    doc: 'ticket.md',
  });
  return doc?.content ?? '';
}

const events = (ticketId?: string) =>
  store.listEvents({
    workspace: WS,
    ...(ticketId ? { ticket_id: ticketId } : {}),
  });

const gates = () => store.listGateItems({ workspace: WS });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-wp031-'));
  store = await PostgresStore.connect('pglite:');
  // projects.next_ticket_seq backs allocTicketId (split materialization).
  await store.upsertProject({
    workspace: WS,
    name: 'test',
    next_ticket_seq: 10,
    next_feature_seq: 1,
    next_initiative_seq: 1,
    settings: {},
    created_at: NOW,
  });
  requestedRuns = [];
  handler = new RealTransitionHandler(makeConfig());
});

afterEach(async () => {
  await store.close();
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
    expect(await ticketMd('SR-0001')).toMatch(/^status: triage$/m);
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'spec_scored',
    );

    // triage NEEDS-INFO → needs-info + question gate.
    const run1 = await makeRun('SR-0001', 'triage', 'NEEDS-INFO', 'SR-0001');
    await handler.onRunComplete(outcome(run1, 'NEEDS-INFO: 2'), tools());
    expect(await ticketMd('SR-0001')).toMatch(/^status: needs-info$/m);
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
    expect(await ticketMd('SR-0001')).toMatch(/^status: triage$/m);
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'question_answered',
    );
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'gate_approved',
    );

    // triage READY (with suggestions) → ready → auto prd-draft.
    // triage.json is a run_artifacts row on the READY run (D29).
    const run2 = await makeRun('SR-0001', 'triage', 'READY', 'SR-0001');
    await putRunArtifact(
      run2.id,
      'triage.json',
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
    await handler.onRunComplete(outcome(run2, 'READY'), tools());
    expect(await ticketMd('SR-0001')).toMatch(/^status: ready$/m);

    const t4 = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    const next4 = await handler.nextStage(t4 as TicketRow, ctx());
    expect(next4?.stage).toBe('prd');
    expect(await ticketMd('SR-0001')).toMatch(/^status: prd-draft$/m);
  });

  it('READY applies suggestions but human-set fields win', async () => {
    await seedTicket('SR-0001', 'triage', {
      backend: 'devin',
      priority: 'high',
    });
    const run = await makeRun('SR-0001', 'triage', 'READY', 'SR-0001');
    await putRunArtifact(
      run.id,
      'triage.json',
      JSON.stringify({
        suggestions: {
          backend: 'aider',
          model: 'openrouter/x',
          priority: 'low',
          depth: 'deep',
        },
      }),
    );
    await handler.onRunComplete(outcome(run, 'READY'), tools());
    const fm = await ticketMd('SR-0001');
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
    expect(await ticketMd('SR-0001')).toMatch(/^status: escalated$/m);
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

    // The split run's split-plan.md + children/ drafts are run_artifacts
    // rows on the split run (D29 — was tickets/<id>/ files).
    const sRun = await makeRun('SR-0001', 'split', 'SPLIT-PROPOSED', 'SR-0001');
    await putRunArtifact(
      sRun.id,
      'split-plan.md',
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
    for (const label of ['c1', 'c2']) {
      await putRunArtifact(
        sRun.id,
        `children/${label}.md`,
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
    expect(await ticketMd('SR-0001')).toMatch(/^status: split$/m);
    const names = (await events('SR-0001')).map((e) => e.event);
    expect(names).toContain('split_approved');
    expect(names).toContain('split_materialized');
    // Children materialized as real `tickets` rows + ticket.md
    // doc_versions; ids allocated from projects.next_ticket_seq (D29).
    const children = (await store.listTickets({ workspace: WS })).filter(
      (r) => r.parent === 'SR-0001',
    );
    expect(children).toHaveLength(2);
    const c1 = children.find((r) => r.depends_on.length === 0);
    const c2 = children.find((r) => r.depends_on.length === 1);
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    const childA = await ticketMd(c1?.ticket_id ?? '');
    const childB = await ticketMd(c2?.ticket_id ?? '');
    expect(childA).toMatch(/^parent: SR-0001$/m);
    expect(childA).toContain(`id: ${c1?.ticket_id}`);
    expect(childB).toMatch(/^parent: SR-0001$/m);
    // c2 depends on c1's real id.
    expect(childB).toContain(`depends_on: [${c1?.ticket_id}]`);
  });
});

describe('gate modes', () => {
  it('minimal suppresses doc-review gates (prd-review auto-advances)', async () => {
    handler = new RealTransitionHandler(makeConfig('minimal'));
    await seedTicket('SR-0001', 'prd-draft');
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0001', doc: 'rs.md' },
      '# RS\n',
      'test-seed',
    );
    const run = await makeRun('SR-0001', 'prd', 'PRD-WRITTEN', 'SR-0001');
    await handler.onRunComplete(outcome(run, 'PRD-WRITTEN'), tools());
    expect(await ticketMd('SR-0001')).toMatch(/^status: prd-review$/m);
    expect((await gates()).filter((g) => g.gate === 'prd-review')).toHaveLength(
      0,
    );
    // Auto-advance straight through to the design stage.
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    const next = await handler.nextStage(t as TicketRow, ctx());
    expect(next?.stage).toBe('design');
    expect(await ticketMd('SR-0001')).toMatch(/^status: tdd-draft$/m);
  });

  it('full mode surfaces the prd-review gate', async () => {
    await seedTicket('SR-0001', 'prd-draft');
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0001', doc: 'rs.md' },
      '# RS\n',
      'test-seed',
    );
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
    expect(await ticketMd('SR-0001')).toMatch(/^status: tdd-draft$/m);
    expect((await events('SR-0001')).map((e) => e.event)).toContain(
      'doc_approved',
    );
  });
});

describe('events table (D29 ledger — no events.jsonl, no LOG.md)', () => {
  it('every SCHEMAS §7 event name has an emitter in packages/*/src', async () => {
    // Post-D29 the `events` table is written by more than conductor —
    // e.g. api emits `item_captured` on POST /capture — so the corpus
    // is every package's src, not conductor/src alone. core/enums.ts
    // is excluded: it declares the literals, it doesn't emit them.
    const { existsSync, readdirSync } = await import('node:fs');
    const { join: j } = await import('node:path');
    const pkgsDir = join(HERE, '../..');
    const enumsDecl = j(pkgsDir, 'core', 'src', 'enums.ts');
    const collect = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? collect(j(d, e.name))
          : e.name.endsWith('.ts')
            ? [j(d, e.name)]
            : [],
      );
    const corpus = readdirSync(pkgsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        const src = j(pkgsDir, e.name, 'src');
        return existsSync(src) ? collect(src) : [];
      })
      .filter((f) => f !== enumsDecl)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    // Ratified (D27) but emitters not yet implemented — the wp-09x
    // wave lands them (S-18 provenance edits, scoped board synthesis,
    // initiative planning, re-plan/re-parent, verify stage, discard).
    // Remove a name when its emitter lands; this list should empty.
    const pending = new Set<EventName>([
      'provenance_amended',
      'board_synthesized',
      'initiative_planned',
      'replanned',
      'reparented',
      'verify_failed',
      'discarded',
    ]);
    const missing = EVENT_NAMES.filter(
      (n: EventName) =>
        !pending.has(n) &&
        !corpus.includes(`'${n}'`) &&
        !corpus.includes(`"${n}"`),
    );
    expect(missing).toEqual([]);
  });

  it('applyTicketStatus bumps the doc version + updates the row + emits status_changed', async () => {
    await seedTicket('SR-0001', 'triage');
    const res = await tools().applyTicketStatus({
      ticketId: 'SR-0001',
      status: 'blocked',
      blockedReason: 'env',
    });
    // D29: the write's identity is the new doc_versions row (v1 was the
    // seed; the status rewrite lands v2) — not a git commit sha.
    expect(res.docVersion).toBe(2);
    expect(await ticketMd('SR-0001')).toMatch(/^status: blocked$/m);
    expect(await ticketMd('SR-0001')).toMatch(/^blocked_reason: env$/m);
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
    expect(await ticketMd('SR-0001')).toMatch(/^status: blocked$/m);
    expect(await ticketMd('SR-0001')).toMatch(/^blocked_reason: env$/m);
    const names = (await events('SR-0001')).map((e) => e.event);
    expect(names).toContain('blocked');
    // D29: no LOG.md file — the events table is the ledger.
    expect(names).toContain('status_changed');
  });
});

// ---------------------------------------------------------------------------
// R1 regression — interview ticketAuthored + verify fail-closed.
// ---------------------------------------------------------------------------

describe('interview → ticketAuthored (R1-F2)', () => {
  const authoredMd = (id: string) =>
    [
      '---',
      'schema: 1',
      `id: ${id}`,
      `title: ${id} drafted`,
      'status: imported',
      'priority: medium',
      'repos: [code-repo]',
      '---',
      '',
      '## Description',
      'Interview-drafted ticket.',
      '',
      '## Acceptance criteria',
      '- [ ] Works',
      '',
    ].join('\n');

  it('creates the tickets row + ticket_repos + audit event transactionally', async () => {
    // The interview run wrote SR-0010/ticket.md in its run dir; reconcile
    // ingested it as a doc_versions row keyed under the NEW subject.
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0010', doc: 'ticket.md' },
      authoredMd('SR-0010'),
      'agent:interview',
    );
    const run = await makeRun(
      'interview:draft',
      'interview',
      'TICKET-AUTHORED',
    );
    await handler.onRunComplete(
      outcome(run, 'TICKET-AUTHORED: SR-0010'),
      tools(),
    );
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0010' });
    expect(t).not.toBeNull();
    expect(t?.status).toBe('imported');
    expect(t?.source).toBe('interview');
    const repos = await store.listTicketRepos({
      workspace: WS,
      ticket_id: 'SR-0010',
    });
    expect(repos.map((r) => r.repo)).toEqual(['code-repo']);
    const names = (await events('SR-0010')).map((e) => e.event);
    expect(names).toContain('ticket_authored');
  });

  it('fails closed — missing ticket.md → repair gate + run_failed, no row', async () => {
    const run = await makeRun('interview:bad', 'interview', 'TICKET-AUTHORED');
    await handler.onRunComplete(
      outcome(run, 'TICKET-AUTHORED: SR-0099'),
      tools(),
    );
    expect(
      await store.getTicket({ workspace: WS, ticket_id: 'SR-0099' }),
    ).toBeNull();
    const items = await gates();
    expect(items.some((g) => g.gate === 'repair')).toBe(true);
    const names = (await events()).map((e) => e.event);
    expect(names).toContain('run_failed');
  });
});

describe('verify → verifyDone (R1-F4, fail-closed)', () => {
  it('DONE with a passing report → ci_green + next review pass queued', async () => {
    await seedTicket('SR-0001', 'in-progress');
    const run = await makeRun('SR-0001', 'verify', 'DONE', 'SR-0001');
    await putRunArtifact(
      run.id,
      'test-report.json',
      JSON.stringify({
        schema: 1,
        ticket: 'SR-0001',
        ts: NOW,
        command: 'make test',
        cases: [{ file: 'src/app.ts', result: 'pass', implemented: true }],
        pass_pct: 100,
        planned: 1,
        implemented: 1,
        risks: [],
      }),
    );
    await handler.onRunComplete(outcome(run, 'DONE'), tools());
    const names = (await events('SR-0001')).map((e) => e.event);
    expect(names).toContain('ci_green');
    expect(names).not.toContain('ci_failed');
    expect(requestedRuns.some((r) => r.stage === 'review')).toBe(true);
  });

  it('DONE with NO report → ci_failed (never implicitly green)', async () => {
    await seedTicket('SR-0001', 'in-progress');
    const run = await makeRun('SR-0001', 'verify', 'DONE', 'SR-0001');
    await handler.onRunComplete(outcome(run, 'DONE'), tools());
    const evs = await events('SR-0001');
    const names = evs.map((e) => e.event);
    expect(names).toContain('ci_failed');
    expect(names).not.toContain('ci_green');
  });

  it('DONE with a failing report → ci_failed', async () => {
    await seedTicket('SR-0001', 'in-progress');
    const run = await makeRun('SR-0001', 'verify', 'DONE', 'SR-0001');
    await putRunArtifact(
      run.id,
      'test-report.json',
      JSON.stringify({
        schema: 1,
        ticket: 'SR-0001',
        ts: NOW,
        command: 'make test',
        cases: [{ file: 'src/app.ts', result: 'fail', implemented: true }],
        pass_pct: 0,
        planned: 1,
        implemented: 1,
        risks: [],
      }),
    );
    await handler.onRunComplete(outcome(run, 'DONE'), tools());
    const names = (await events('SR-0001')).map((e) => e.event);
    expect(names).toContain('ci_failed');
    expect(names).not.toContain('ci_green');
  });

  it('DONE with a malformed report → ci_failed (fail-closed)', async () => {
    await seedTicket('SR-0001', 'in-progress');
    const run = await makeRun('SR-0001', 'verify', 'DONE', 'SR-0001');
    await putRunArtifact(run.id, 'test-report.json', '{not json');
    await handler.onRunComplete(outcome(run, 'DONE'), tools());
    const names = (await events('SR-0001')).map((e) => e.event);
    expect(names).toContain('ci_failed');
  });
});
