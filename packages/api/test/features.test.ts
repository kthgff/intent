/**
 * wp-152 Feature Workspace routes — Fastify inject over PGlite.
 *
 * Covers: workspace-scoped list + detail rollup (tickets grouped,
 * requirements primary, health findings — evidence-linked, no score),
 * versioned docs, the acceptance package, and the explicit human
 * acceptance gate (expected_status fencing + done/discarded
 * conflicts).
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
import type { FeatureRow, GateItem, TicketRow } from '@veto/core';
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
const F = 'F-0001';

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

const featureRow = (over: Partial<FeatureRow> = {}): FeatureRow => ({
  workspace: WS,
  feature: F,
  title: 'Feature one',
  status: 'active',
  ...over,
});

const ticketRow = (over: Partial<TicketRow> = {}): TicketRow => ({
  workspace: WS,
  ticket_id: 'SR-0001',
  feature: F,
  title: 't',
  status: 'in-progress',
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

const gateItem = (over: Partial<GateItem> = {}): GateItem => ({
  workspace: WS,
  subject: F,
  gate: 'feature-review',
  kind: 'review',
  surfaced_at: '2026-10-03T00:00:00Z',
  cleared_at: null,
  blocked_agent: false,
  priority: 'medium',
  ...over,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-api-features-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('feature routes — auth + scoping', () => {
  it('requires the bearer token on every feature route', async () => {
    const app = makeServer();
    for (const [method, url] of [
      ['GET', '/api/v1/features'],
      ['GET', `/api/v1/features/${WS}/${F}`],
      ['GET', `/api/v1/features/${WS}/${F}/docs/feature`],
      ['GET', `/api/v1/features/${WS}/${F}/acceptance`],
      ['GET', `/api/v1/features/${WS}/${F}/acs`],
      ['POST', `/api/v1/features/${WS}/${F}/accept`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await app.close();
  });

  it('404s on an unknown workspace / feature', async () => {
    const app = makeServer();
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/features/nope/F-0001',
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(404);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/features/${WS}/F-9999`,
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('feature detail rollup', () => {
  it('lists features filtered by workspace/status', async () => {
    await store.upsertFeature(featureRow());
    await store.upsertFeature(
      featureRow({ feature: 'F-0002', status: 'done' }),
    );
    const app = makeServer();
    const all = await app.inject({
      method: 'GET',
      url: `/api/v1/features?workspace=${WS}`,
      headers: AUTH,
    });
    expect(all.statusCode).toBe(200);
    expect((all.json().features as FeatureRow[]).length).toBe(2);
    const done = await app.inject({
      method: 'GET',
      url: `/api/v1/features?workspace=${WS}&status=done`,
      headers: AUTH,
    });
    expect((done.json().features as FeatureRow[]).length).toBe(1);
    await app.close();
  });

  it('rolls up member tickets, requirement links, and health findings', async () => {
    await store.upsertFeature(featureRow());
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0001', status: 'blocked', work_type: 'bug' }),
    );
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0002', status: 'merged', work_type: 'story' }),
    );
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0003', feature: null, status: 'ready' }),
    );
    await store.appendDocVersion(
      { workspace: WS, subject: F, doc: 'ac.md' },
      '# ACs\n\n| ac_id | criterion |\n| --- | --- |\n| AC-1 | when x, then y |\n',
      'test',
    );
    await store.upsertRelation({
      subject: F,
      predicate: 'documents',
      object: 'SR-0009:rs.md',
      verification: 'verified',
    });
    await store.upsertGateItem(gateItem());

    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/features/${WS}/${F}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tickets: TicketRow[];
      tickets_by_type: Record<string, Record<string, number>>;
      requirements: { primary: { object: string } | null };
      health: { kind: string; severity: string; refs: string[] }[];
      acceptance: { accepted: boolean };
    };
    // Only member tickets roll up — the orphan never leaks in.
    expect(body.tickets.map((t) => t.ticket_id).sort()).toEqual([
      'SR-0001',
      'SR-0002',
    ]);
    expect(body.tickets_by_type.bug?.blocked).toBe(1);
    expect(body.tickets_by_type.story?.merged).toBe(1);
    expect(body.requirements.primary?.object).toBe('SR-0009:rs.md');
    const kinds = body.health.map((h) => h.kind);
    expect(kinds).toContain('blocked_ticket');
    expect(kinds).toContain('open_gate');
    expect(kinds).toContain('unverified_ac');
    expect(kinds).toContain('not_accepted');
    // Findings carry evidence refs — never an opaque score.
    const blocked = body.health.find((h) => h.kind === 'blocked_ticket');
    expect(blocked?.refs).toContain('SR-0001');
    expect(body.acceptance.accepted).toBe(false);
    await app.close();
  });
});

describe('feature docs + acs', () => {
  it('serves versioned feature docs with diffs, rejects bad names', async () => {
    await store.upsertFeature(featureRow());
    await store.appendDocVersion(
      { workspace: WS, subject: F, doc: 'feature.md' },
      '# Feature\n\nv1\n',
      'test',
    );
    await store.appendDocVersion(
      { workspace: WS, subject: F, doc: 'feature.md' },
      '# Feature\n\nv2\n',
      'test',
    );
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/features/${WS}/${F}/docs/feature`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      version: number;
      versions: { version: number }[];
      diffs: { from: string; to: string }[];
    };
    expect(body.version).toBe(2);
    expect(body.versions.length).toBe(2);
    expect(body.diffs.length).toBe(1);

    const bad = await app.inject({
      method: 'GET',
      url: `/api/v1/features/${WS}/${F}/docs/ticket`,
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/features/${WS}/${F}/docs/notes`,
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('acceptance gate (PRD §15.7)', () => {
  it('assembles the acceptance package from live rows', async () => {
    await store.upsertFeature(featureRow());
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0001', status: 'merged' }),
    );
    await store.appendDocVersion(
      { workspace: WS, subject: F, doc: 'feature.md' },
      '# Feature\n',
      'test',
    );
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/features/${WS}/${F}/acceptance`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const pkg = res.json() as {
      scope: { doc: { version: number } | null };
      tickets: { ticket_id: string; delivered: boolean }[];
      accepted: null | { by: string };
      findings: unknown[];
    };
    expect(pkg.scope.doc?.version).toBe(1);
    expect(pkg.tickets[0]?.delivered).toBe(true);
    expect(pkg.accepted).toBeNull();
    expect(Array.isArray(pkg.findings)).toBe(true);
    await app.close();
  });

  it('accepts explicitly → done + durable event; stale writes conflict', async () => {
    await store.upsertFeature(featureRow());
    const app = makeServer();

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/features/${WS}/${F}/accept`,
      headers: AUTH,
      payload: { expected_status: 'draft' },
    });
    expect(stale.statusCode).toBe(409);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/features/${WS}/${F}/accept`,
      headers: AUTH,
      payload: { expected_status: 'active', exclusions: ['AC-9 deferred'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feature.status).toBe('done');

    const events = await store.listEvents({
      workspace: WS,
      ticket_id: F,
      event: 'doc_approved',
    });
    expect(events.length).toBe(1);
    expect(events[0]?.data?.doc).toBe('acceptance-package');
    expect(events[0]?.data?.exclusions).toEqual(['AC-9 deferred']);

    // A second accept never double-commits.
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/features/${WS}/${F}/accept`,
      headers: AUTH,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });
});
