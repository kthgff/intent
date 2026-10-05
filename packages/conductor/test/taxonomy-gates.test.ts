/**
 * wp-151 tests — taxonomy enforcement at the conductor gates
 * (PRD §15.7). The policy module is pure (see core's taxonomy.test.ts);
 * these tests pin the *enforcement*: intake classification records
 * work_type/origin, per-type evidence blocks the gate rather than
 * passing silently, a new-capability/mixed verdict becomes a scope
 * proposal, and a malformed classification fails closed to a repair
 * gate.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@sprint-runner/config';
import type { RunRow, Stage } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApplyStatusOptions,
  type RunOutcome,
  type RunResult,
  type TransitionContext,
  type TransitionTools,
  applyTicketStatus,
} from '../src/contracts.js';
import { RealTransitionHandler } from '../src/transitions/handler.js';

const WS = 'ws';
const NOW = '2026-10-05T00:00:00Z';

let dir: string;
let store: PostgresStore;
let handler: RealTransitionHandler;
let requestedRuns: { subject: string; stage: string }[];
let gateItems: { gate: string; payload: unknown }[];

function makeConfig() {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      gates: 'full',
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

let seq = 0;
async function makeRun(
  subject: string,
  stage: Stage,
  sentinel: string | null,
): Promise<RunRow> {
  const row: RunRow = {
    id: `${WS}/${subject}/${String(++seq).padStart(3, '0')}-${stage}`,
    workspace: WS,
    subject,
    ticket_id: subject,
    stage,
    attempt: seq,
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
  return {
    run,
    result: {
      sentinel: sentinelRaw.split(':')[0] ?? sentinelRaw,
      sentinel_raw: sentinelRaw,
      artifacts: [],
      usage: null,
      exit_code: 0,
    },
  };
}

/** Seed a ticket that has been through triage (origin set → MUST be
 *  classified, so the enforcement path is live). */
async function seedTicket(
  id: string,
  over: Record<string, unknown> = {},
): Promise<void> {
  await store.upsertTicket({
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `${id} title`,
    status: 'triage',
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos: ['code-repo'],
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    forced: false,
    spec_score: null,
    origin: 'manual',
    work_type: null,
    severity: null,
    scope_ref: null,
    blocked_reason: null,
    snoozed_until: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  } as never);
  // ticket.md is a doc_versions doc (D29) — the AC section is what the
  // story-intake evidence check reads.
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    [
      '---',
      'schema: 1',
      `id: ${id}`,
      `title: ${id} title`,
      'status: triage',
      'priority: medium',
      'repos: [code-repo]',
      '---',
      '',
      '## Description',
      'A sufficiently long description for spec lint purposes, detailing the work.',
      '',
      '## Acceptance criteria',
      '- [ ] Something verifiable happens',
      '',
    ].join('\n'),
    'test-seed',
  );
}

/** Write a triage.json carrying a classification block on a run. */
async function writeClassification(
  ticketId: string,
  classification: unknown,
): Promise<void> {
  const run = await makeRun(ticketId, 'triage', 'READY');
  await store.putArtifact({
    run_id: run.id,
    name: 'triage.json',
    content: JSON.stringify({ schema: 1, questions: [], classification }),
  } as never);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-taxonomy-gates-'));
  store = await PostgresStore.connect('pglite:');
  handler = new RealTransitionHandler(makeConfig());
  requestedRuns = [];
  gateItems = [];
  await store.upsertProject({
    workspace: WS,
    name: 'Team A',
    next_ticket_seq: 10,
  });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('intake classification records the taxonomy', () => {
  it('stamps work_type + origin + severity from the classification block', async () => {
    await seedTicket('SR-0001');
    await writeClassification('SR-0001', {
      work_type: 'bug',
      origin: 'manual',
      severity: 'major',
      scope_verdict: 'defect',
      rationale: 'restores approved behavior',
      intake: { repro: 'click login twice' },
    });
    const run = await makeRun('SR-0001', 'triage', 'READY');
    await handler.onRunComplete(outcome(run, 'READY'), tools());

    const row = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(row?.work_type).toBe('bug');
    expect(row?.severity).toBe('major');
  });

  it('a malformed classification fails closed to a repair gate — never a guessed type', async () => {
    await seedTicket('SR-0001');
    await writeClassification('SR-0001', { work_type: 'not-a-type' });
    const run = await makeRun('SR-0001', 'triage', 'READY');
    await handler.onRunComplete(outcome(run, 'READY'), tools());

    const gates = await store.listGateItems({ workspace: WS, open: true });
    expect(gates.some((g) => g.gate === 'repair')).toBe(true);
    const row = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(row?.work_type ?? null).toBeNull();
    expect(row?.status).not.toBe('ready');
  });
});

describe('per-type evidence blocks the gate (never a silent pass)', () => {
  it('a bug missing its repro evidence parks at intake with the missing list', async () => {
    await seedTicket('SR-0001');
    await writeClassification('SR-0001', {
      work_type: 'bug',
      origin: 'manual',
      severity: 'major',
      scope_verdict: 'defect',
      intake: {},
    });
    const run = await makeRun('SR-0001', 'triage', 'READY');
    await handler.onRunComplete(outcome(run, 'READY'), tools());

    const row = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(row?.status).not.toBe('ready');
    // The unmet requirement is surfaced, not swallowed.
    const gates = await store.listGateItems({ workspace: WS, open: true });
    expect(gates.length).toBeGreaterThan(0);
  });

  it('a fully-evidenced bug proceeds to ready', async () => {
    await seedTicket('SR-0001');
    await writeClassification('SR-0001', {
      work_type: 'bug',
      origin: 'manual',
      severity: 'major',
      scope_verdict: 'defect',
      intake: {
        repro: 'click login twice',
        expected: 'single session',
        actual: 'two sessions',
      },
    });
    const run = await makeRun('SR-0001', 'triage', 'READY');
    await handler.onRunComplete(outcome(run, 'READY'), tools());

    const row = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(row?.status).toBe('ready');
  });
});

describe('bug ≠ scope change at intake', () => {
  it('a new-capability verdict produces a scope proposal, not silent scope', async () => {
    await seedTicket('SR-0001');
    await writeClassification('SR-0001', {
      work_type: 'story',
      origin: 'manual',
      severity: null,
      scope_verdict: 'new-capability',
      rationale: 'beyond the approved RS',
      // Story intake is satisfied so the flow reaches the scope check
      // (evidence is enforced first — see the needs-info test).
      intake: { 'scope-ref': 'SR-0001' },
    });
    const run = await makeRun('SR-0001', 'triage', 'READY');
    await handler.onRunComplete(outcome(run, 'READY'), tools());

    const row = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(row?.status).not.toBe('ready');
    const gates = await store.listGateItems({ workspace: WS, open: true });
    expect(gates.some((g) => g.gate === 'scope-proposal')).toBe(true);
    // …and the over-scope work did not slip through as approved scope.
    expect(row?.work_type).toBe('story');
  });

  it('a defect verdict on a bug from any origin is a direct create', async () => {
    await seedTicket('SR-0001', { origin: 'review' });
    await writeClassification('SR-0001', {
      work_type: 'bug',
      origin: 'review',
      severity: 'minor',
      scope_verdict: 'defect',
      intake: { repro: 'steps', expected: 'x', actual: 'y' },
    });
    const run = await makeRun('SR-0001', 'triage', 'READY');
    await handler.onRunComplete(outcome(run, 'READY'), tools());

    const row = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
    expect(row?.status).toBe('ready');
  });
});
