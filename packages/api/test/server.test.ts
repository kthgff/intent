/**
 * wp-060 API tests — fastify inject only, no real port.
 *
 * Covers: bearer auth on every route (401 matrix), loopback-only
 * token bootstrap cookie, inbox ranking (blocking → priority → age),
 * expected_status gate-write idempotency → 409, claim/release,
 * actions → conductor stub calls, SSE gate_surfaced delivery, and
 * settings secrets write-only.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Conductor,
  type ConductorDeps,
  StubTransitionHandler,
  makeTransitionTools,
} from '@sprint-runner/conductor';
import { resolveConfig } from '@sprint-runner/config';
import type { GateItem, TicketRow } from '@sprint-runner/core';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiServer,
  type ServerOptions,
  createServer,
  loadOrCreateToken,
} from '../src/index.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';

let dir: string;
let ticketsRepo: string;
let store: SqliteStore;

function gitInit(repo: string): void {
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# tickets\n');
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
}

function writeTicketMd(id: string, status: string): void {
  const d = join(ticketsRepo, 'tickets', id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'ticket.md'),
    `---\nschema: 1\nid: ${id}\ntitle: t\nstatus: ${status}\npriority: high\nrepos: []\ndepth: standard\ndepends_on: []\n---\n\n# ${id}\n`,
  );
  execFileSync('git', ['add', '-A'], { cwd: ticketsRepo });
  execFileSync('git', ['commit', '-qm', `ticket ${id}`], { cwd: ticketsRepo });
}

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
    workspaces: [{ name: WS, ticketsRepoPath: ticketsRepo }],
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

const ticketRow = (over: Partial<TicketRow> = {}): TicketRow => ({
  workspace: WS,
  ticket_id: 'SR-0001',
  title: 't',
  status: 'prd-review',
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-api-'));
  ticketsRepo = join(dir, 'tickets-repo');
  gitInit(ticketsRepo);
  store = new SqliteStore(`sqlite://${join(dir, 'state.db')}`);
  await store.getSchemaVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('auth', () => {
  const ROUTES: [string, string][] = [
    ['GET', '/api/v1/inbox'],
    ['GET', '/api/v1/tickets'],
    ['GET', '/api/v1/tickets/ws/SR-0001'],
    ['GET', '/api/v1/tickets/ws/SR-0001/events'],
    ['POST', '/api/v1/tickets/ws/SR-0001/answers'],
    ['POST', '/api/v1/tickets/ws/SR-0001/actions'],
    ['GET', '/api/v1/runs'],
    ['GET', '/api/v1/runs/a%2Fb%2F001-x'],
    ['POST', '/api/v1/runs/a%2Fb%2F001-x/kill'],
    ['GET', '/api/v1/workspaces'],
    ['POST', '/api/v1/workspaces'],
    ['POST', '/api/v1/interview'],
    ['POST', '/api/v1/import'],
    ['GET', '/api/v1/settings'],
    ['PUT', '/api/v1/settings'],
    ['GET', '/api/v1/kb/repo'],
    ['PUT', '/api/v1/kb/repo'],
    ['POST', '/api/v1/kb/repo/sync'],
    ['GET', '/api/v1/metrics'],
    ['POST', '/api/v1/gate-items/ws/SR-0001/g/claim'],
    ['DELETE', '/api/v1/gate-items/ws/SR-0001/g/claim'],
    ['GET', '/api/v1/stream'],
    ['GET', '/'],
  ];

  it('returns 401 with no token on every route', async () => {
    const app = makeServer();
    for (const [method, url] of ROUTES) {
      const res = await app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error).toBe('unauthorized');
    }
    await app.close();
  });

  it('returns 401 on a wrong token', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/inbox',
      headers: { authorization: `Bearer ${'b'.repeat(64)}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('token bootstrap', () => {
  it('GET /?token= sets a session cookie on loopback', async () => {
    const app = makeServer();
    const res = await app.inject({ method: 'GET', url: `/?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const cookie = res.headers['set-cookie'] as string;
    expect(cookie).toContain('sr_session=');
    // cookie works on subsequent requests
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/inbox',
      headers: { cookie: cookie.split(';')[0] as string },
    });
    expect(res2.statusCode).toBe(200);
    await app.close();
  });

  it('refuses the ?token= bootstrap on a non-loopback bind', async () => {
    const app = makeServer({ bind: '0.0.0.0' });
    const res = await app.inject({ method: 'GET', url: `/?token=${TOKEN}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('loadOrCreateToken writes a 32-byte hex token mode 0600', () => {
    const path = join(dir, 'ui-token');
    const t1 = loadOrCreateToken(path);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(path)).toBe(t1); // stable across calls
    // malformed existing file → fail-closed
    writeFileSync(path, 'garbage');
    chmodSync(path, 0o600);
    expect(() => loadOrCreateToken(path)).toThrow(/malformed/);
  });
});

describe('inbox ranking', () => {
  it('orders blocking-first → priority → age', async () => {
    const items = [
      gateItem({
        subject: 'low-blocked',
        gate: 'g1',
        blocked_agent: true,
        priority: 'low',
        surfaced_at: '2026-01-03T00:00:00Z',
      }),
      gateItem({
        subject: 'old-med',
        gate: 'g2',
        surfaced_at: '2026-01-01T00:00:00Z',
      }),
      gateItem({
        subject: 'new-high',
        gate: 'g3',
        priority: 'high',
        surfaced_at: '2026-01-04T00:00:00Z',
      }),
      gateItem({
        subject: 'high-blocked',
        gate: 'g4',
        blocked_agent: true,
        priority: 'high',
        surfaced_at: '2026-01-02T00:00:00Z',
      }),
      gateItem({
        subject: 'old-high',
        gate: 'g5',
        priority: 'high',
        surfaced_at: '2026-01-01T12:00:00Z',
      }),
    ];
    for (const i of items) await store.upsertGateItem(i);
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/inbox',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const order = res
      .json()
      .items.map((i: GateItem) => `${i.subject}/${i.gate}`);
    expect(order).toEqual([
      'high-blocked/g4', // blocked, high
      'low-blocked/g1', // blocked, low
      'old-high/g5', // unblocked high, older
      'new-high/g3', // unblocked high, newer
      'old-med/g2', // medium
    ]);
    await app.close();
  });
});

describe('gate writes — expected_status idempotency', () => {
  beforeEach(async () => {
    writeTicketMd('SR-0001', 'prd-review');
    await store.upsertTicket(ticketRow());
    await store.upsertGateItem(gateItem());
  });

  it('409s on a stale expected_status', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets/ws/SR-0001/docs/prd/approve',
      headers: AUTH,
      payload: { expected_status: 'test-review' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
    await app.close();
  });

  it('approves once, then 409s a repeated (stale) write', async () => {
    const app = makeServer();
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets/ws/SR-0001/docs/prd/approve',
      headers: AUTH,
      payload: { expected_status: 'prd-review' },
    });
    expect(ok.statusCode).toBe(200);
    const item = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'prd-review',
    });
    expect(item?.cleared_at).toBeTruthy();
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets/ws/SR-0001/docs/prd/approve',
      headers: AUTH,
      payload: { expected_status: 'prd-review' },
    });
    expect(stale.statusCode).toBe(409);
    await app.close();
  });
});

describe('claim / release', () => {
  beforeEach(async () => {
    await store.upsertGateItem(gateItem());
  });

  it('claims once, 409s a second claim, releases, reclaims', async () => {
    const app = makeServer();
    const url = '/api/v1/gate-items/ws/SR-0001/prd-review/claim';
    const c1 = await app.inject({ method: 'POST', url, headers: AUTH });
    expect(c1.statusCode).toBe(201);
    expect(c1.json().claim.claimed_by).toBe('test-bot');

    const c2 = await app.inject({ method: 'POST', url, headers: AUTH });
    expect(c2.statusCode).toBe(409);

    const rel = await app.inject({ method: 'DELETE', url, headers: AUTH });
    expect(rel.statusCode).toBe(200);

    const c3 = await app.inject({ method: 'POST', url, headers: AUTH });
    expect(c3.statusCode).toBe(201);
    await app.close();
  });
});

describe('actions → conductor calls', () => {
  it('run control routes call the conductor stub', async () => {
    const conductor = makeConductor();
    const kill = vi.spyOn(conductor, 'killRun').mockResolvedValue();
    const pause = vi.spyOn(conductor, 'pauseRun').mockResolvedValue();
    const resume = vi.spyOn(conductor, 'resumeRun').mockResolvedValue();
    const app = createServer({
      store,
      conductor,
      config: makeConfig(),
      uiToken: TOKEN,
    });
    await store.createRun({
      id: 'ws/SR-0001/001-implement',
      workspace: WS,
      subject: 'SR-0001',
      ticket_id: 'SR-0001',
      stage: 'implement',
      attempt: 1,
      backend: 'mock',
      model: null,
      depth: null,
      pid: 12345,
      worktree: null,
      status: 'running',
      started_at: null,
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
      run_dir: null,
    });
    for (const [op, spy] of [
      ['kill', kill],
      ['pause', pause],
      ['resume', resume],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/runs/${encodeURIComponent('ws/SR-0001/001-implement')}/${op}`,
        headers: AUTH,
      });
      expect(res.statusCode, op).toBe(202);
      expect(spy).toHaveBeenCalledWith('ws/SR-0001/001-implement');
    }
    await app.close();
  });

  it('wont_do writes the status through applyTicketStatus', async () => {
    writeTicketMd('SR-0002', 'ready');
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0002', status: 'ready' }),
    );
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets/ws/SR-0002/actions',
      headers: AUTH,
      payload: { action: 'wont_do', expected_status: 'ready' },
    });
    expect(res.statusCode).toBe(200);
    const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0002' });
    expect(t?.status).toBe('wont-do');
    await app.close();
  });

  it('unimplemented action → 501 with explicit error shape', async () => {
    writeTicketMd('SR-0003', 'ready');
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0003', status: 'ready' }),
    );
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets/ws/SR-0003/actions',
      headers: AUTH,
      payload: { action: 'teleport' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: 'not_implemented' });
    await app.close();
  });
});

describe('SSE /api/v1/stream', () => {
  it('delivers gate_surfaced when a gate item is surfaced', async () => {
    const app = makeServer();
    const stream = app.inject({
      method: 'GET',
      url: '/api/v1/stream',
      headers: AUTH,
    });
    // Give the inject a tick to register the client.
    await vi.waitFor(() => expect(app.streamCount()).toBe(1));

    // POST an interview seed (durable), then surface its question gate
    // through the REAL conductor surface path — surfaceGateItem writes
    // gate_items + notifications durably, then deps.notify streams it.
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/interview',
      headers: AUTH,
      payload: { workspace: WS, text: 'build a thing' },
    });
    expect(post.statusCode).toBe(202);
    const conductor = new Conductor({
      store,
      adapters: {},
      config: makeConfig(),
      workspaces: [{ name: WS, ticketsRepoPath: ticketsRepo }],
      runsDir: join(dir, 'runs'),
      transitions: new StubTransitionHandler(),
    });
    // Same notify sink the server's conductor got.
    conductor.deps.notify = (e) => app.notify(e);
    const tools = makeTransitionTools({
      deps: conductor.deps,
      ws: { name: WS, ticketsRepoPath: ticketsRepo },
      leases: conductor.leases,
      handles: conductor.handles,
      killedForCap: conductor.killedForCap,
    });
    await tools.surfaceGateItem({
      subject: 'interview:x',
      gate: 'interview-qa',
      kind: 'question',
    });
    // durable write is the source of truth
    expect(
      (
        await store.getGateItem({
          workspace: WS,
          subject: 'interview:x',
          gate: 'interview-qa',
        })
      )?.cleared_at,
    ).toBeNull();

    app.closeStreams();
    const res = await stream;
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: gate_surfaced');
    expect(res.body).toContain('interview-qa');
    expect(res.body).toContain('event: notification');
    await app.close();
  });
});

describe('settings', () => {
  it('secrets are write-only — never read back', async () => {
    const cfgPath = join(dir, 'cfg', 'config.yaml');
    const app = makeServer({ globalConfigPath: cfgPath });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: AUTH,
      payload: { secrets: { MY_API_KEY: 'supersecret-value' } },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: AUTH,
    });
    expect(get.statusCode).toBe(200);
    expect(JSON.stringify(get.json())).not.toContain('supersecret-value');
    expect(JSON.stringify(get.json())).not.toContain('MY_API_KEY');

    // …but the .env got it, mode 0600.
    const env = join(dir, 'cfg', '.env');
    expect(existsSync(env)).toBe(true);
    expect(readFileSync(env, 'utf8')).toContain('MY_API_KEY=supersecret-value');
    expect(statSync(env).mode & 0o777).toBe(0o600);
    await app.close();
  });
});
