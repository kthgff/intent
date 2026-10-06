/**
 * wp-157 tests — durable test-environment requests (PRD §15.10).
 *
 * Real PostgresStore on PGlite; the envops lifecycle functions are
 * exercised directly and through `RealTransitionHandler.nextStage`
 * (the gate integration). Covers:
 *   - spec resolution (ticket override / feature inheritance / none);
 *   - create: TE-NNNN allocation, durable row, event, gate surfaced,
 *     idempotency;
 *   - fulfil: evidence required, status + evidence, gate cleared;
 *   - waive: rationale required, status, gate cleared;
 *   - expire: past-expiry sweep;
 *   - the stage decision (no-spec / ready / waived / blocked) and the
 *     handler blocking implement until fulfilled/waived;
 *   - materialization planning (fixture refs validated under
 *     `fixtures/`, no production-data path) + execution;
 *   - `materializeTestEnvForRun` never fabricates an environment.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@veto/config';
import type { TestEnvSpec, TicketRow } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransitionContext } from '../src/contracts.js';
import {
  type TestEnvCtx,
  TestEnvError,
  type TestEnvExecutor,
  createTestEnvRequest,
  ensureTestEnvForStage,
  expireTestEnvRequests,
  fulfilTestEnvRequest,
  materializeTestEnv,
  materializeTestEnvForRun,
  planTestEnvMaterialization,
  resolveFixtureRef,
  resolveTestEnvSpec,
  waiveTestEnvRequest,
} from '../src/envops/index.js';
import { RealTransitionHandler } from '../src/transitions/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let root: string;
let store: PostgresStore;
let clock: number;

function envCtx(): TestEnvCtx {
  return {
    workspace: WS,
    store,
    actor: 'test-actor',
    now: () => new Date(clock),
  };
}

function transitionCtx(): TransitionContext {
  return {
    workspace: WS,
    rootPath: root,
    store,
    actor: 'test-actor',
    now: () => new Date(clock),
  };
}

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

const tick = (ms = 60_000) => {
  clock += ms;
};

const SPEC: TestEnvSpec = {
  kind: 'temp-db',
  services: [],
  db: { engine: 'postgres' },
  seed: ['node scripts/seed.js'],
  fixtures: ['fixtures/seed/users.json'],
  mocks: ['stripe'],
  provisioner: 'platform-team',
  expires_in_minutes: 120,
};

async function seedTicket(
  id: string,
  status: TicketRow['status'],
  over: Partial<TicketRow> = {},
): Promise<TicketRow> {
  const ts = new Date(clock).toISOString();
  const row: TicketRow = {
    workspace: WS,
    org: null,
    ticket_id: id,
    feature: null,
    title: `${id} title`,
    status,
    priority: 'medium',
    depth: 'standard',
    backend: 'mock',
    model: null,
    repos: ['code-repo'],
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    work_type: null,
    origin: null,
    severity: null,
    execution_readiness: null,
    parallel_safety: null,
    source_ref: null,
    test_env: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: ts,
    updated_at: ts,
    ...over,
  };
  await store.upsertTicket(row);
  return row;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'veto-testenv-'));
  store = await PostgresStore.connect('pglite:');
  clock = T0;
  await store.upsertProject({ workspace: WS, name: 'Team A' });
});

afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// spec resolution
// ---------------------------------------------------------------------------

describe('resolveTestEnvSpec', () => {
  it('prefers the ticket spec over the feature spec, and inherits otherwise', () => {
    const feature = { test_env: { kind: 'feature-env' } } as never;
    expect(resolveTestEnvSpec({ test_env: SPEC }, feature)).toEqual(SPEC);
    expect(resolveTestEnvSpec({ test_env: null }, feature)).toEqual({
      services: [],
      seed: [],
      fixtures: [],
      mocks: [],
      kind: 'feature-env',
    });
  });

  it('returns null when nothing is declared (no env step)', () => {
    expect(resolveTestEnvSpec({ test_env: null }, null)).toBeNull();
    expect(resolveTestEnvSpec(null, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// create / fulfil / waive / expire
// ---------------------------------------------------------------------------

describe('test-env request lifecycle', () => {
  it('create allocates TE-NNNN, records the request, emits + surfaces the gate', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved');
    const req = await createTestEnvRequest(envCtx(), {
      subject: ticket.ticket_id,
      ticketId: ticket.ticket_id,
      stage: 'implement',
      spec: SPEC,
    });
    expect(req.request_id).toBe('TE-0001');
    expect(req.status).toBe('pending');
    expect(req.provisioner).toBe('platform-team');
    expect(req.expires_at).toBe(new Date(T0 + 120 * 60_000).toISOString());

    const events = await store.listEvents({
      workspace: WS,
      ticket_id: 'SR-0001',
      event: 'test_env_requested',
    });
    expect(events).toHaveLength(1);

    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'test-env',
    });
    expect(gate?.blocked_agent).toBe(true);
    expect(gate?.cleared_at).toBeNull();
  });

  it('create is idempotent — an open request is reused', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved');
    const a = await createTestEnvRequest(envCtx(), {
      subject: ticket.ticket_id,
      stage: 'implement',
      spec: SPEC,
    });
    const b = await createTestEnvRequest(envCtx(), {
      subject: ticket.ticket_id,
      stage: 'implement',
      spec: SPEC,
    });
    expect(b.request_id).toBe(a.request_id);
    expect(
      await store.listTestEnvRequests({ workspace: WS, subject: 'SR-0001' }),
    ).toHaveLength(1);
  });

  it('fulfil requires evidence, records it, and clears the gate', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved');
    const req = await createTestEnvRequest(envCtx(), {
      subject: ticket.ticket_id,
      ticketId: ticket.ticket_id,
      stage: 'implement',
      spec: SPEC,
    });
    await expect(
      fulfilTestEnvRequest(envCtx(), {
        requestId: req.request_id,
        evidence: '  ',
      }),
    ).rejects.toThrow(TestEnvError);

    const done = await fulfilTestEnvRequest(envCtx(), {
      requestId: req.request_id,
      evidence: 'provisioned: env-42 (db + fixtures seeded)',
      by: 'keith',
    });
    expect(done.status).toBe('fulfilled');
    expect(done.fulfilled_by).toBe('keith');
    expect(done.evidence).toContain('env-42');
    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'test-env',
    });
    expect(gate?.cleared_at).not.toBeNull();
    expect(
      await store.listEvents({
        workspace: WS,
        ticket_id: 'SR-0001',
        event: 'test_env_fulfilled',
      }),
    ).toHaveLength(1);
  });

  it('waive requires a recorded rationale and clears the gate', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved');
    const req = await createTestEnvRequest(envCtx(), {
      subject: ticket.ticket_id,
      ticketId: ticket.ticket_id,
      stage: 'implement',
      spec: SPEC,
    });
    await expect(
      waiveTestEnvRequest(envCtx(), {
        requestId: req.request_id,
        rationale: '',
      }),
    ).rejects.toThrow(/rationale/);

    const waived = await waiveTestEnvRequest(envCtx(), {
      requestId: req.request_id,
      rationale: 'tests run against the shared staging env; no fixtures needed',
    });
    expect(waived.status).toBe('waived');
    expect(waived.waiver_rationale).toContain('shared staging');
    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'test-env',
    });
    expect(gate?.cleared_at).not.toBeNull();
  });

  it('expire sweeps past-expiry pending requests', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved');
    await createTestEnvRequest(envCtx(), {
      subject: ticket.ticket_id,
      stage: 'implement',
      spec: { ...SPEC, expires_in_minutes: 30 },
    });
    // Not yet expired.
    expect(await expireTestEnvRequests(envCtx())).toEqual([]);
    tick(31 * 60_000);
    const expired = await expireTestEnvRequests(envCtx());
    expect(expired).toEqual(['TE-0001']);
    const req = await store.getTestEnvRequest({
      workspace: WS,
      request_id: 'TE-0001',
    });
    expect(req?.status).toBe('expired');
    expect(
      await store.listEvents({
        workspace: WS,
        ticket_id: 'SR-0001',
        event: 'test_env_expired',
      }),
    ).toHaveLength(1);
  });

  it('fulfilling a non-pending request is a bad-state error', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved');
    const req = await createTestEnvRequest(envCtx(), {
      subject: ticket.ticket_id,
      stage: 'implement',
      spec: SPEC,
    });
    await fulfilTestEnvRequest(envCtx(), {
      requestId: req.request_id,
      evidence: 'x',
    });
    await expect(
      fulfilTestEnvRequest(envCtx(), {
        requestId: req.request_id,
        evidence: 'y',
      }),
    ).rejects.toThrow(/only a pending request/);
  });
});

// ---------------------------------------------------------------------------
// stage decision + gate integration
// ---------------------------------------------------------------------------

describe('ensureTestEnvForStage', () => {
  it('returns no-spec when nothing is declared (existing behavior)', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved');
    expect(
      await ensureTestEnvForStage(envCtx(), { ticket, stage: 'implement' }),
    ).toEqual({ status: 'no-spec' });
    // No request, no gate.
    expect(
      await store.listTestEnvRequests({ workspace: WS, subject: 'SR-0001' }),
    ).toHaveLength(0);
  });

  it('raises + blocks on the first check, then ready after fulfil', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved', {
      test_env: SPEC,
    });
    const first = await ensureTestEnvForStage(envCtx(), {
      ticket,
      stage: 'implement',
    });
    expect(first.status).toBe('blocked');
    expect(first.request?.request_id).toBe('TE-0001');
    if (!first.request) throw new Error('expected a test-env request');

    await fulfilTestEnvRequest(envCtx(), {
      requestId: first.request.request_id,
      evidence: 'env ready',
    });
    const after = await ensureTestEnvForStage(envCtx(), {
      ticket,
      stage: 'implement',
    });
    expect(after.status).toBe('ready');
  });

  it('inherits the feature spec', async () => {
    await store.upsertFeature({
      workspace: WS,
      feature: 'F-0001',
      title: 'Feature',
      status: 'active',
      test_env: SPEC,
    });
    const ticket = await seedTicket('SR-0001', 'test-approved', {
      feature: 'F-0001',
    });
    const decision = await ensureTestEnvForStage(envCtx(), {
      ticket,
      stage: 'implement',
    });
    expect(decision.status).toBe('blocked');
    expect(decision.request?.spec.db?.engine).toBe('postgres');
  });

  it('expired request → a fresh request is raised and blocks again', async () => {
    const ticket = await seedTicket('SR-0001', 'test-approved', {
      test_env: { ...SPEC, expires_in_minutes: 10 },
    });
    const first = await ensureTestEnvForStage(envCtx(), {
      ticket,
      stage: 'implement',
    });
    tick(11 * 60_000);
    await expireTestEnvRequests(envCtx());
    const second = await ensureTestEnvForStage(envCtx(), {
      ticket,
      stage: 'implement',
    });
    expect(second.status).toBe('blocked');
    expect(second.request?.request_id).toBe('TE-0002');
  });
});

describe('RealTransitionHandler — implement blocks on the test-env gate', () => {
  it('test-approved with a spec blocks implement; fulfil unblocks it', async () => {
    const handler = new RealTransitionHandler(makeConfig());
    const ticket = await seedTicket('SR-0001', 'test-approved', {
      test_env: SPEC,
    });
    // Pre-clear the spend-checkpoint gate so nextStage reaches the
    // implement decision.
    await store.upsertGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'test-approved',
      kind: 'approval',
      surfaced_at: new Date(clock).toISOString(),
      cleared_at: new Date(clock).toISOString(),
      blocked_agent: false,
      priority: null,
    });

    const blocked = await handler.nextStage(ticket, transitionCtx());
    expect(blocked).toBeNull();
    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'test-env',
    });
    expect(gate?.cleared_at).toBeNull();

    const req = (
      await store.listTestEnvRequests({ workspace: WS, subject: 'SR-0001' })
    )[0];
    if (!req) throw new Error('expected a test-env request');
    await fulfilTestEnvRequest(envCtx(), {
      requestId: req.request_id,
      evidence: 'env ready',
    });
    const next = await handler.nextStage(ticket, transitionCtx());
    expect(next).toEqual({ stage: 'implement' });
  });

  it('a waived request unblocks implement without materializing', async () => {
    const handler = new RealTransitionHandler(makeConfig());
    const ticket = await seedTicket('SR-0001', 'test-approved', {
      test_env: SPEC,
    });
    await store.upsertGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'test-approved',
      kind: 'approval',
      surfaced_at: new Date(clock).toISOString(),
      cleared_at: new Date(clock).toISOString(),
      blocked_agent: false,
      priority: null,
    });
    await handler.nextStage(ticket, transitionCtx());
    const req = (
      await store.listTestEnvRequests({ workspace: WS, subject: 'SR-0001' })
    )[0];
    if (!req) throw new Error('expected a test-env request');
    await waiveTestEnvRequest(envCtx(), {
      requestId: req.request_id,
      rationale: 'reuse staging',
    });
    const next = await handler.nextStage(ticket, transitionCtx());
    expect(next).toEqual({ stage: 'implement' });
  });
});

// ---------------------------------------------------------------------------
// materialization planning + execution
// ---------------------------------------------------------------------------

describe('planTestEnvMaterialization', () => {
  it('rejects fixture refs that escape fixtures/ (no production data)', () => {
    expect(() => resolveFixtureRef('/etc/passwd', root)).toThrow(/relative/);
    expect(() => resolveFixtureRef('../secrets.json', root)).toThrow(/escapes/);
    expect(() => resolveFixtureRef('src/data.json', root)).toThrow(
      /under fixtures/,
    );
  });

  it('resolves a valid fixture ref under fixtures/', () => {
    const { source, fixturesRoot } = resolveFixtureRef(
      'fixtures/seed/users.json',
      root,
    );
    expect(source).toBe(join(root, 'fixtures/seed/users.json'));
    expect(fixturesRoot).toBe(join(root, 'fixtures'));
  });

  it('plans db + seed + fixture + mock steps and env', () => {
    const plan = planTestEnvMaterialization(SPEC, { workspaceRoot: root });
    expect(plan.steps.map((s) => s.kind)).toEqual([
      'db',
      'seed',
      'fixture',
      'mock',
    ]);
    expect(plan.env.TEST_ENV).toBe('temp-db');
    expect(plan.env.TEST_ENV_DB).toBe('postgres');
  });

  it('falls back to the repo-card seed when the spec lists none', () => {
    const plan = planTestEnvMaterialization(
      { fixtures: [], mocks: [] },
      { workspaceRoot: root, cardSeed: 'make seed' },
    );
    expect(plan.steps).toEqual([
      { kind: 'seed', command: 'make seed', description: 'seed: make seed' },
    ]);
  });
});

describe('materializeTestEnv', () => {
  it('copies fixtures into the run dir and runs seed commands', async () => {
    mkdirSync(join(root, 'fixtures/seed'), { recursive: true });
    writeFileSync(join(root, 'fixtures/seed/users.json'), '[]');
    const commands: string[] = [];
    const executor: TestEnvExecutor = {
      async runCommand(command, opts) {
        commands.push(command);
        return { command, exitCode: 0, stdout: '', stderr: '' };
      },
      async copyFixture(source, destination) {
        mkdirSync(join(destination, '..'), { recursive: true });
        writeFileSync(destination, '[]');
      },
    };
    const runDir = join(root, 'runs/SR-0001/001-implement');
    mkdirSync(runDir, { recursive: true });
    const result = await materializeTestEnv({
      spec: SPEC,
      workspaceRoot: root,
      worktree: root,
      runDir,
      executor,
    });
    expect(result.ok).toBe(true);
    expect(commands).toEqual(['node scripts/seed.js']);
    expect(result.envDir).toBe(join(runDir, 'test-env'));
    expect(result.env.TEST_ENV_DIR).toBe(result.envDir);
  });

  it('fails closed when a fixture is missing', async () => {
    const result = await materializeTestEnv({
      spec: SPEC,
      workspaceRoot: root,
      worktree: root,
      runDir: join(root, 'runs/x'),
      executor: {
        async runCommand(command) {
          return { command, exitCode: 0, stdout: '', stderr: '' };
        },
        async copyFixture() {
          throw new Error('should not copy');
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fixture not found/);
  });

  it('reports a failed seed command', async () => {
    mkdirSync(join(root, 'fixtures/seed'), { recursive: true });
    writeFileSync(join(root, 'fixtures/seed/users.json'), '[]');
    const result = await materializeTestEnv({
      spec: { fixtures: [], mocks: [], seed: ['false'] },
      workspaceRoot: root,
      worktree: root,
      runDir: join(root, 'runs/x'),
      executor: {
        async runCommand(command) {
          return { command, exitCode: 1, stdout: '', stderr: 'boom' };
        },
        async copyFixture() {},
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/seed command failed/);
  });
});

describe('materializeTestEnvForRun', () => {
  it('is a no-op without a spec (existing behavior)', async () => {
    const ticket = await seedTicket('SR-0001', 'in-progress');
    expect(
      await materializeTestEnvForRun({
        ctx: envCtx(),
        ticket,
        stage: 'implement',
        runId: 'ws/SR-0001/001-implement',
        worktree: root,
        runDir: join(root, 'runs/x'),
        workspaceRoot: root,
      }),
    ).toBeNull();
  });

  it('never fabricates an environment while the request is pending', async () => {
    const ticket = await seedTicket('SR-0001', 'in-progress', {
      test_env: SPEC,
    });
    await createTestEnvRequest(envCtx(), {
      subject: 'SR-0001',
      ticketId: 'SR-0001',
      stage: 'implement',
      spec: SPEC,
    });
    expect(
      await materializeTestEnvForRun({
        ctx: envCtx(),
        ticket,
        stage: 'implement',
        runId: 'ws/SR-0001/001-implement',
        worktree: root,
        runDir: join(root, 'runs/x'),
        workspaceRoot: root,
      }),
    ).toBeNull();
  });

  it('materializes a fulfilled request and links the run to the evidence', async () => {
    const ticket = await seedTicket('SR-0001', 'in-progress', {
      test_env: { fixtures: [], mocks: [], seed: ['echo seed'] },
    });
    const req = await createTestEnvRequest(envCtx(), {
      subject: 'SR-0001',
      ticketId: 'SR-0001',
      stage: 'implement',
      spec: ticket.test_env ?? {},
    });
    await fulfilTestEnvRequest(envCtx(), {
      requestId: req.request_id,
      evidence: 'env-42',
    });
    const runDir = join(root, 'runs/SR-0001/001-implement');
    const result = await materializeTestEnvForRun({
      ctx: envCtx(),
      ticket,
      stage: 'implement',
      runId: 'ws/SR-0001/001-implement',
      worktree: root,
      runDir,
      workspaceRoot: root,
      executor: {
        async runCommand(command) {
          return { command, exitCode: 0, stdout: '', stderr: '' };
        },
        async copyFixture() {},
      },
    });
    expect(result?.ok).toBe(true);
    const stored = await store.getTestEnvRequest({
      workspace: WS,
      request_id: req.request_id,
    });
    expect(stored?.run_id).toBe('ws/SR-0001/001-implement');
  });
});
