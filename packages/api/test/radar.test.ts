/**
 * wp-142 API tests — Scope Creep Radar surface (PRD §15.5).
 *
 * Covers: bearer auth on both routes, 404 on unknown
 * workspace/changeset/gate, the computed report shape, and the
 * acknowledge path clearing a `scope-budget` escalation (the durable
 * `gate_approved` row + `gate_cleared` SSE are the audit).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Conductor,
  type ConductorDeps,
  StubTransitionHandler,
} from '@sprint-runner/conductor';
import { resolveConfig } from '@sprint-runner/config';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApiServer, createServer } from '../src/index.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';

let dir: string;
let store: PostgresStore;

function makeConfig() {
  return resolveConfig(null, {
    config: { actor: 'test-bot', backend: 'mock' },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function makeServer(): ApiServer {
  const deps: ConductorDeps = {
    store,
    adapters: {},
    config: makeConfig(),
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir: join(dir, 'runs'),
    transitions: new StubTransitionHandler(),
  };
  return createServer({
    store,
    conductor: new Conductor(deps),
    config: makeConfig(),
    uiToken: TOKEN,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-radar-api-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
  await store.upsertProject({ workspace: WS, name: 'Team A' });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/v1/scope-radar', () => {
  it('requires auth', async () => {
    const app = makeServer();
    const res = await app.inject({ url: '/api/v1/scope-radar?workspace=ws' });
    expect(res.statusCode).toBe(401);
  });

  it('400s without a workspace; 404s on an unknown one', async () => {
    const app = makeServer();
    const noWs = await app.inject({
      url: '/api/v1/scope-radar',
      headers: AUTH,
    });
    expect(noWs.statusCode).toBe(404);
    const badWs = await app.inject({
      url: '/api/v1/scope-radar?workspace=nope',
      headers: AUTH,
    });
    expect(badWs.statusCode).toBe(404);
  });

  it('returns the computed report (subjects + releases + totals)', async () => {
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0001', doc: 'rs.md' },
      'v1',
      'test',
    );
    const app = makeServer();
    const res = await app.inject({
      url: '/api/v1/scope-radar?workspace=ws&subject=SR-0001',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspace).toBe(WS);
    expect(body.computed_at).toBeTruthy();
    expect(body.subjects[0].subject).toBe('SR-0001');
    expect(body.totals.changesets).toBe(0);
  });
});

describe('POST /api/v1/scope-radar/:ws/:changeset/acknowledge', () => {
  async function seedEscalatedChangeset() {
    await store.upsertChangeset({
      workspace: WS,
      changeset_id: 'CS-0001',
      request: 'add SSO',
      status: 'awaiting-decision',
    });
    await store.upsertGateItem({
      workspace: WS,
      subject: 'CS-0001',
      gate: 'scope-budget',
      kind: 'escalation',
      surfaced_at: new Date().toISOString(),
      cleared_at: null,
      blocked_agent: false,
    });
  }

  it('clears the scope-budget gate + writes the gate_approved event', async () => {
    await seedEscalatedChangeset();
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/scope-radar/ws/CS-0001/acknowledge',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().acknowledged).toBe(true);
    const item = await store.getGateItem({
      workspace: WS,
      subject: 'CS-0001',
      gate: 'scope-budget',
    });
    expect(item?.cleared_at).not.toBeNull();
    const events = await store.listEvents({
      workspace: WS,
      event: 'gate_approved',
    });
    expect(events).toHaveLength(1);
    // Second acknowledge is fail-closed — nothing open.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/scope-radar/ws/CS-0001/acknowledge',
      headers: AUTH,
      payload: {},
    });
    expect(again.statusCode).toBe(404);
  });

  it('404s on unknown changeset and on no open escalation', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/scope-radar/ws/CS-9999/acknowledge',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await store.upsertChangeset({
      workspace: WS,
      changeset_id: 'CS-0002',
      request: 'no breach',
      status: 'awaiting-decision',
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/scope-radar/ws/CS-0002/acknowledge',
      headers: AUTH,
      payload: {},
    });
    expect(res2.statusCode).toBe(404);
  });
});
