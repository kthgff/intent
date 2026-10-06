/**
 * wp-120 /telemetry/* + /incidents* route tests (D37 Phase C,
 * API.md `/telemetry/sources` `/incidents` rows, SCHEMAS §19).
 *
 * Covered: source registration (secret-ref enforcement → 400), the
 * sanitized ingest path (raw event bodies/secrets never returned or
 * persisted), signature dedupe, incident open + GET detail with a
 * fail-closed validated investigation, OCC decide (resolve requires
 * evidence → 400; stale `expected` → 409), and the draft-ticket gate
 * (proposal only until human approve).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Conductor,
  type ConductorDeps,
  StubTransitionHandler,
} from '@veto/conductor';
import { resolveConfig } from '@veto/config';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiServer,
  type ServerOptions,
  createServer,
} from '../src/index.js';

const TOKEN = 'b'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';

let dir: string;
let store: PostgresStore;

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      security: { scan_on_commit: false },
      repos: {},
      ...overrides,
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function makeServer(
  opts: Partial<ServerOptions> = {},
  configOverrides: Record<string, unknown> = {},
): ApiServer {
  const deps: ConductorDeps = {
    store,
    adapters: {},
    config: makeConfig(configOverrides),
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir: join(dir, 'runs'),
    transitions: new StubTransitionHandler(),
  };
  return createServer({
    store,
    conductor: new Conductor(deps),
    config: makeConfig(configOverrides),
    uiToken: TOKEN,
    ...opts,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-tel-'));
  store = await PostgresStore.connect('pglite:');
  await store.upsertProject({ workspace: WS });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const EVENT = {
  message: 'TimeoutError waiting for lock order=8842',
  exception_class: 'TimeoutError',
  error_code: 'DB-LOCK',
  stack: ['svc.wait(db.js:88)'],
  attributes: {
    service: 'orders',
    version: '2.1.0',
    trace_id: 'trace-1',
    request_body: '{"password":"hunter2"}',
    authorization: 'Bearer sk-live-secret-token',
  },
  timestamp: '2026-10-05T10:00:00Z',
};

async function seedSourceAndIngest(app: ApiServer) {
  await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/sources',
    headers: AUTH,
    payload: {
      workspace: WS,
      id: 'otel-prod',
      kind: 'otlp',
      config: { endpoint: 'https://o.example.com', token: 'env:OTEL_TOKEN' },
    },
  });
  const ing = await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/ingest',
    headers: AUTH,
    payload: { workspace: WS, source_id: 'otel-prod', events: [EVENT, EVENT] },
  });
  return ing;
}

describe('telemetry sources + ingest', () => {
  it('rejects raw secret config values (400) and unknown sources (404)', async () => {
    const app = makeServer();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/telemetry/sources',
      headers: AUTH,
      payload: {
        workspace: WS,
        id: 'x',
        kind: 'otlp',
        config: { api_token: 'literal-secret-value' },
      },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/telemetry/ingest',
      headers: AUTH,
      payload: { workspace: WS, source_id: 'ghost', events: [EVENT] },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('ingests → dedupes → opens incident; secrets never persisted', async () => {
    const app = makeServer();
    const ing = await seedSourceAndIngest(app);
    expect(ing.statusCode).toBe(200);
    const body = ing.json() as {
      signatures: { count: number }[];
      incidents_opened: { id: string }[];
    };
    expect(body.signatures).toHaveLength(1);
    expect(body.signatures.at(0).count).toBe(2);
    expect(body.incidents_opened).toHaveLength(1);

    // Nothing raw leaks into the signature row.
    const sigs = await app.inject({
      method: 'GET',
      url: `/api/v1/telemetry/signatures?workspace=${WS}`,
      headers: AUTH,
    });
    const sigBody = JSON.stringify(sigs.json());
    expect(sigBody).not.toContain('sk-live-secret-token');
    expect(sigBody).not.toContain('hunter2');
    expect(sigBody).toContain('orders');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/incidents?workspace=${WS}`,
      headers: AUTH,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { incidents: unknown[] }).incidents).toHaveLength(1);
    await app.close();
  });
});

describe('incident investigate + decide', () => {
  it('investigation persists a validated §19 artifact; resolve needs evidence', async () => {
    const app = makeServer();
    const ing = await seedSourceAndIngest(app);
    const inc = (
      ing.json() as { incidents_opened: { id: string }[] }
    ).incidents_opened.at(0);

    const inv = await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${inc.id}/investigate`,
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(inv.statusCode).toBe(200);
    const artifact = (inv.json() as { artifact: { schema: number } }).artifact;
    expect(artifact.schema).toBe(1);

    // Resolve without evidence → 400 (never AI assertion alone).
    const bare = await app.inject({
      method: 'POST',
      url: '/api/v1/incidents/decide',
      headers: AUTH,
      payload: {
        workspace: WS,
        id: inc.id,
        action: 'resolve',
        expected: 'open',
      },
    });
    expect(bare.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/incidents/decide',
      headers: AUTH,
      payload: {
        workspace: WS,
        id: inc.id,
        action: 'resolve',
        expected: 'open',
        evidence: { deployment_refs: ['dep_1'], resolution: 'rolled back' },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (ok.json() as { incident: { resolution_verified: number } }).incident
        .resolution_verified,
    ).toBe(1);

    // Stale OCC → 409.
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/incidents/decide',
      headers: AUTH,
      payload: {
        workspace: WS,
        id: inc.id,
        action: 'close',
        expected: 'open',
      },
    });
    expect(stale.statusCode).toBe(409);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${inc.id}?workspace=${WS}`,
      headers: AUTH,
    });
    const d = detail.json() as {
      incident: { status: string };
      investigation: { signature: string } | null;
      decisions: unknown[];
    };
    expect(d.incident.status).toBe('resolved');
    expect(d.investigation).not.toBeNull();
    expect(d.decisions.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe('draft-ticket gate', () => {
  it('proposal stays draft until a human approves; approve lands a tray item', async () => {
    const app = makeServer();
    const ing = await seedSourceAndIngest(app);
    const inc = (
      ing.json() as { incidents_opened: { id: string }[] }
    ).incidents_opened.at(0);

    const prop = await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${inc.id}/proposals`,
      headers: AUTH,
      payload: {
        workspace: WS,
        title: 'Fix lock timeout in orders',
        draft: { work_type: 'bug' },
      },
    });
    expect(prop.statusCode).toBe(201);
    const pid = (prop.json() as { id: string }).id;
    // No board item exists yet — proposals never enter scope.
    expect(await store.listBoardItems({ workspace: WS })).toHaveLength(0);

    const approve = await app.inject({
      method: 'POST',
      url: '/api/v1/incidents/proposals/decide',
      headers: AUTH,
      payload: { workspace: WS, id: pid, action: 'approve', expected: 'draft' },
    });
    expect(approve.statusCode).toBe(200);
    const res = approve.json() as { status: string; board_item_id: string };
    expect(res.status).toBe('approved');
    expect(res.board_item_id).toBeTruthy();
    const items = await store.listBoardItems({ workspace: WS });
    expect(items).toHaveLength(1);
    expect(items.at(0).board).toBeNull();

    // Malformed body → 400.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/incidents/proposals/decide',
      headers: AUTH,
      payload: { workspace: WS, id: pid, action: 'yolo' },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
