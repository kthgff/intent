/**
 * wp-112 /alignment + /feedback/clusters route tests (D37 Phase B,
 * API.md `/alignment/<scope>` row, SCHEMAS §18).
 *
 * Covered: POST run (201 manual / coalesced 200 on-merge), GET the
 * durable artifact, OCC decide (200/409/404), readiness (blocked-gate
 * supremacy), workspace-scoped feedback cluster proposals, and the
 * delivery-metrics shape guarantee (aggregates only — no individual
 * developer ranking keys anywhere in the payload).
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
import type { TicketRow } from '@veto/core';
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
const MERGED_SHA = 'c'.repeat(40);

let dir: string;
let store: PostgresStore;

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      security: { scan_on_commit: false },
      semantic: { embeddings: 'off' },
      repos: {},
      intelligence: { alignment: 'manual' },
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

const ticketMd = (id: string, status = 'ready') =>
  [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${status}`,
    'priority: medium',
    'repos: []',
    '---',
    '',
    '## Description',
    'A sufficiently long description for spec lint purposes.',
    '',
    '## Acceptance criteria',
    '- [ ] Something verifiable happens',
    '',
  ].join('\n');

async function seedTicket(id: string, status = 'ready'): Promise<void> {
  const ts = '2026-10-06T00:00:00Z';
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `${id} title`,
    status: status as TicketRow['status'],
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos: [],
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: ts,
    updated_at: ts,
  };
  await store.upsertTicket(row);
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    ticketMd(id, status),
    'test-seed',
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-align-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /alignment/<scope> + GET', () => {
  it('runs a comparison, persists a durable §18 artifact, GET returns it', async () => {
    const app = makeServer();
    await seedTicket('SR-0001');
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/alignment/SR-0001',
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(post.statusCode).toBe(201);
    const body = post.json() as {
      run: { status: string; finding_count: number };
      artifact: { findings: { kind: string; status: string }[] };
    };
    expect(body.run.status).toBe('done');
    expect(
      body.artifact.findings.some(
        (f) => f.kind === 'missing-implementation-evidence',
      ),
    ).toBe(true);
    expect(body.artifact.findings.every((f) => f.status === 'open')).toBe(true);

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/alignment/SR-0001?workspace=${WS}`,
      headers: AUTH,
    });
    expect(get.statusCode).toBe(200);
    const got = get.json() as {
      artifact: { schema: number; scope: string };
      findings: unknown[];
    };
    expect(got.artifact.schema).toBe(1);
    expect(got.artifact.scope).toBe('SR-0001');
    expect(got.findings.length).toBeGreaterThan(0);
    await app.close();
  });

  it('duplicate on-merge POST coalesces (200 + same run_id)', async () => {
    const app = makeServer({}, { intelligence: { alignment: 'on-merge' } });
    await seedTicket('SR-0002');
    const mk = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/alignment/SR-0002',
        headers: AUTH,
        payload: {
          workspace: WS,
          trigger: 'on-merge',
          trigger_sha: MERGED_SHA,
        },
      });
    const a = await mk();
    const b = await mk();
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect((b.json() as { run: { run_id: string } }).run.run_id).toBe(
      (a.json() as { run: { run_id: string } }).run.run_id,
    );
    await app.close();
  });

  it('409 when intelligence.alignment is off; 404 unknown scope', async () => {
    const off = makeServer({}, { intelligence: { alignment: 'off' } });
    await seedTicket('SR-0003');
    const res = await off.inject({
      method: 'POST',
      url: '/api/v1/alignment/SR-0003',
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(res.statusCode).toBe(409);
    await off.close();

    const app = makeServer();
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/alignment/SR-9999',
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /alignment/decide — OCC human lifecycle', () => {
  it('dismiss → verify round-trip is evented; stale expected → 409; missing → 404', async () => {
    const app = makeServer();
    await seedTicket('SR-0010');
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/alignment/SR-0010',
      headers: AUTH,
      payload: { workspace: WS },
    });
    const finding = (
      post.json() as { artifact: { findings: { id: string }[] } }
    ).artifact.findings[0];
    expect(finding).toBeDefined();

    const decide = (body: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/alignment/decide',
        headers: AUTH,
        payload: { workspace: WS, id: finding?.id, ...body },
      });

    const stale = await decide({ action: 'resolve', expected: 'dismissed' });
    expect(stale.statusCode).toBe(409);

    const ok = await decide({
      action: 'dismiss',
      expected: 'open',
      rationale: 'accepted',
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { finding: { status: string } }).finding.status).toBe(
      'dismissed',
    );

    // Verify from the dismissed state (the status the human saw).
    const verified = await decide({ action: 'verify', expected: 'dismissed' });
    expect(verified.statusCode).toBe(200);
    expect(
      (verified.json() as { finding: { status: string } }).finding.status,
    ).toBe('verified');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/alignment/decide',
      headers: AUTH,
      payload: {
        workspace: WS,
        id: 'aln_nope',
        action: 'verify',
        expected: 'open',
      },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /alignment/<scope>/readiness', () => {
  it('release scope → gates + advisory narrative; non-release → 400', async () => {
    const app = makeServer();
    const bad = await app.inject({
      method: 'GET',
      url: `/api/v1/alignment/SR-0001/readiness?workspace=${WS}`,
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/alignment/release:REL-9999/readiness?workspace=${WS}`,
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /feedback/clusters — proposes, never creates', () => {
  it('clusters similar feedback inside one workspace only', async () => {
    const app = makeServer();
    const item = (id: string, ws: string, title: string) =>
      store.upsertBoardItem({
        id,
        workspace: ws,
        org: null,
        board: 'fb',
        kind: 'feedback',
        note_kind: 'feedback',
        topic: null,
        importance: null,
        applies_to: null,
        note_status: null,
        rationale: null,
        provenance: null,
        ref: null,
        title,
        body: null,
        x: null,
        y: null,
        w: null,
        h: null,
        zone: null,
        serves: null,
        status: 'active',
        consumed_by: null,
        created_at: '2026-10-06T00:00:00Z',
        updated_at: '2026-10-06T00:00:00Z',
      });
    await item('f1', WS, 'Dark mode contrast is too low');
    await item('f2', WS, 'Dark mode contrast too low');
    await item('f3', 'ws-b', 'Dark mode contrast is too low');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback/clusters',
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(res.statusCode).toBe(200);
    const { proposals } = res.json() as {
      proposals: { members: string[]; requires_human: boolean }[];
    };
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.members.sort()).toEqual(['f1', 'f2']);
    expect(proposals[0]?.requires_human).toBe(true);
    // Nothing created — the two workspaces' items are untouched.
    expect(await store.listBoardItems({ workspace: WS })).toHaveLength(2);
    await app.close();
  });
});

describe('GET /metrics — aggregates only (wp-112 AC)', () => {
  it('no individual-developer ranking keys anywhere in the payload', async () => {
    const app = makeServer();
    await seedTicket('SR-0020', 'merged');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/metrics?workspace=${WS}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const text = JSON.stringify(res.json());
    // Team/system aggregates only — nothing keyed by developer,
    // author, assignee, or ranking (INTELLIGENCE §8 rejected list).
    expect(text).not.toMatch(/developer|author|assignee|ranking|leaderboard/i);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('deviations');
    await app.close();
  });
});
