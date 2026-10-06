/**
 * wp-160 API/store backlog sweep tests — fastify inject only.
 *
 * Covers the six backlog items:
 *   1. GET /tickets/<ref>/review — latest review.json run_artifact, 404 absent
 *   3. POST /workspaces — persists durably (projects row), not in-memory only
 *   4. /metrics — deviation_rate + human_minutes (gate dwell) per the PRD
 *   5. gate snooze — POST .../snooze sets snoozed_until; /inbox honors it
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Conductor,
  type ConductorDeps,
  StubTransitionHandler,
} from '@veto/conductor';
import { resolveConfig } from '@veto/config';
import type { GateItem, TicketRow } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiServer,
  type ServerOptions,
  createServer,
} from '../src/index.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';

let dir: string;
let store: PostgresStore;

function makeConfig() {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      security: { scan_on_commit: false },
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function makeConductor(overrides: Partial<ConductorDeps> = {}) {
  const deps: ConductorDeps = {
    store,
    adapters: {},
    config: makeConfig(),
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir: join(dir, 'runs'),
    transitions: new StubTransitionHandler(),
    ...overrides,
  };
  return new Conductor(deps);
}

function makeServer(opts: Partial<ServerOptions> = {}): ApiServer {
  return createServer({
    store,
    conductor: makeConductor(),
    config: makeConfig(),
    uiToken: TOKEN,
    ...opts,
  });
}

const ticketRow = (over: Partial<TicketRow> = {}): TicketRow => ({
  workspace: WS,
  ticket_id: 'SR-0001',
  title: 't',
  status: 'merged',
  priority: 'high',
  depth: 'standard',
  backend: 'mock',
  model: null,
  repos: [],
  parent: null,
  depends_on: [],
  spec_score: null,
  spec_hash: null,
  blocked_reason: null,
  updated_at: '2026-10-03T00:00:00Z',
  ...over,
});

const runRow = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    workspace: WS,
    subject: id.split('/')[1],
    ticket_id: id.split('/')[1],
    stage: 'review',
    attempt: 1,
    backend: 'mock',
    model: null,
    depth: null,
    pid: null,
    worktree: null,
    status: 'done',
    started_at: '2026-10-03T00:00:00Z',
    heartbeat_at: null,
    exited_at: '2026-10-03T00:01:00Z',
    sentinel: 'REVIEWED',
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: null,
    ...over,
  }) as Parameters<typeof store.createRun>[0];

const gateItem = (over: Partial<GateItem> = {}): GateItem => ({
  workspace: WS,
  subject: 'SR-0001',
  gate: 'prd-review',
  kind: 'review',
  surfaced_at: '2026-10-03T00:00:00Z',
  cleared_at: null,
  blocked_agent: false,
  priority: 'medium',
  ...over,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-api160-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('GET /tickets/<ref>/review (backlog 1)', () => {
  it('returns the latest review.json run artifact', async () => {
    await store.upsertTicket(ticketRow({ ticket_id: 'SR-0007' }));
    await store.createRun(runRow('ws/SR-0007/001-review'));
    await store.createRun(runRow('ws/SR-0007/002-review'));
    await store.putArtifact({
      run_id: 'ws/SR-0007/001-review',
      name: 'review.json',
      content: '{"schema":1,"verdict":"changes"}',
    });
    await store.putArtifact({
      run_id: 'ws/SR-0007/002-review',
      name: 'review.json',
      content: '{"schema":1,"verdict":"approve"}',
    });
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tickets/ws/SR-0007/review',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      run_id: string;
      name: string;
      review: { verdict: string };
    };
    expect(body.run_id).toBe('ws/SR-0007/002-review');
    expect(body.review.verdict).toBe('approve');
    await app.close();
  });

  it('404s when no review.json exists', async () => {
    await store.upsertTicket(ticketRow({ ticket_id: 'SR-0008' }));
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tickets/ws/SR-0008/review',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /workspaces (backlog 3)', () => {
  it('persists the workspace durably — a projects row, not just memory', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: AUTH,
      payload: { name: 'newws' },
    });
    expect(res.statusCode).toBe(201);
    // Durable: the projects row survives independently of the
    // conductor's in-memory workspace list.
    const row = await store.getProject('newws');
    expect(row?.name).toBe('newws');
    expect(row?.settings?.path).toContain('newws');
    await app.close();
  });
});

describe('/metrics — PRD formulas (backlog 4)', () => {
  it('deviation_rate = merged-with-deviations ÷ merged; human_minutes = gate dwell', async () => {
    // Two merged tickets; one has a deviations.md table artifact.
    await store.upsertTicket(ticketRow({ ticket_id: 'SR-0001' }));
    await store.upsertTicket(ticketRow({ ticket_id: 'SR-0002' }));
    await store.createRun(
      runRow('ws/SR-0001/001-implement', {
        stage: 'implement',
      }),
    );
    await store.putArtifact({
      run_id: 'ws/SR-0001/001-implement',
      name: 'DEVIATIONS.md',
      content:
        '# Deviations\n\n| deviation | reason |\n|---|---|\n| skipped flaky test | env |\n',
    });
    // Gate dwell: surfaced T0, cleared T0+30min → 30 human-minutes.
    await store.upsertGateItem(
      gateItem({
        surfaced_at: '2026-10-03T00:00:00Z',
        cleared_at: '2026-10-03T00:30:00Z',
      }),
    );
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics?workspace=ws',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deviations: { deviation_rate: number; merged_tickets: number };
      totals: { human_minutes: number };
    };
    expect(body.deviations.merged_tickets).toBe(2);
    expect(body.deviations.deviation_rate).toBeCloseTo(0.5, 5);
    expect(body.totals.human_minutes).toBeCloseTo(30, 1);
    await app.close();
  });
});

describe('PUT /settings → config.yaml write path (backlog 3 adjunct)', () => {
  it('persists the patch, preserves existing comments/order', async () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, '# global settings\nactor: human\n# keep me\n');
    const app = makeServer({ globalConfigPath: configPath });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: AUTH,
      payload: { config: { actor: 'test-bot', backend: 'mock' } },
    });
    expect(res.statusCode).toBe(200);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('actor: test-bot');
    expect(text).toContain('backend: mock');
    await app.close();
  });

  it('secrets write to .env, never echoed back', async () => {
    const configPath = join(dir, 'config.yaml');
    const app = makeServer({ globalConfigPath: configPath });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: AUTH,
      payload: { secrets: { GITHUB_TOKEN: 'ghp_test' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('ghp_test');
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toContain('GITHUB_TOKEN=ghp_test');
    // GET /settings must not leak it either.
    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: AUTH,
    });
    expect(get.body).not.toContain('ghp_test');
    await app.close();
  });
});

describe('gate snooze (backlog 5)', () => {
  it('snooze sets snoozed_until; /inbox hides it until include_snoozed', async () => {
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0003', status: 'triage' }),
    );
    await store.upsertGateItem(
      gateItem({ subject: 'SR-0003', gate: 'triage' }),
    );
    const app = makeServer();
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/inbox?workspace=ws',
      headers: AUTH,
    });
    expect(
      (before.json() as { items: { subject: string }[] }).items.length,
    ).toBeGreaterThan(0);

    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/gate-items/ws/SR-0003/triage/snooze',
      headers: AUTH,
      payload: { until },
    });
    expect(res.statusCode).toBe(200);

    const stored = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0003',
      gate: 'triage',
    });
    expect(stored?.snoozed_until).toBe(until);

    const hidden = await app.inject({
      method: 'GET',
      url: '/api/v1/inbox?workspace=ws',
      headers: AUTH,
    });
    expect(
      (hidden.json() as { items: { subject: string }[] }).items.find(
        (i) => i.subject === 'SR-0003',
      ),
    ).toBeUndefined();

    const shown = await app.inject({
      method: 'GET',
      url: '/api/v1/inbox?workspace=ws&include_snoozed=1',
      headers: AUTH,
    });
    expect(
      (shown.json() as { items: { subject: string }[] }).items.find(
        (i) => i.subject === 'SR-0003',
      ),
    ).toBeDefined();
    await app.close();
  });
});
