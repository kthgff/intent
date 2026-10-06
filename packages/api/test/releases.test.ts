/**
 * wp-136 Delivery API route tests (DELIVERY §6).
 *
 * Every route gets a happy path plus at least one fail-closed path:
 * 400 malformed bodies (zod parseBody), 404 missing subjects, 409
 * stale/state conflicts (OCC expected_status, gate-failed releases,
 * bad-state transitions), 403 agent approvals (invariant 6), and the
 * invariant-4 evidence rules (manual deployment evidence; `available`
 * requires a linked confirmed deployment). The SSE test asserts the
 * durable DELIVERY §5 event names mirror onto /api/v1/stream.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Conductor,
  type ConductorDeps,
  StubTransitionHandler,
} from '@sprint-runner/conductor';
import { resolveConfig } from '@sprint-runner/config';
import type { TicketRow } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiServer,
  type ServerOptions,
  createServer,
} from '../src/index.js';

const TOKEN = 'b'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';
const SHA = 'a'.repeat(40);
const TS = '2026-10-05T00:00:00Z';

let dir: string;
let store: PostgresStore;

function makeConfig() {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      security: { scan_on_commit: false },
      semantic: { embeddings: 'off' },
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function makeServer(opts: Partial<ServerOptions> = {}): ApiServer {
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
    ...opts,
  });
}

/** A merged ticket with a confirmed merge SHA — release-eligible. */
async function seedMergedTicket(id: string, feature: string | null = null) {
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature,
    title: `${id} title`,
    status: 'merged',
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos: ['api'],
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    work_type: 'story',
    origin: 'rs',
    severity: null,
    source_ref: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: TS,
    updated_at: TS,
  };
  await store.upsertTicket(row);
  await store.upsertTicketRepo({
    workspace: WS,
    ticket_id: id,
    repo: 'api',
    branch: `feat/${id}`,
    worktree: null,
    pr_url: 'https://github.com/x/api/pull/1',
    pr_state: 'merged',
    ci_state: 'green',
    merged_sha: SHA,
  });
}

async function seedTicket(id: string, status: TicketRow['status']) {
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `${id} title`,
    status,
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos: [],
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    work_type: 'story',
    origin: 'rs',
    severity: null,
    source_ref: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: TS,
    updated_at: TS,
  };
  await store.upsertTicket(row);
}

async function seedFeature(id: string) {
  await store.upsertFeature({
    workspace: WS,
    feature: id,
    title: `${id} feature`,
    status: 'active',
  });
}

const post = (
  app: ApiServer,
  url: string,
  payload: unknown = {},
  method = 'POST',
) => app.inject({ method, url, headers: AUTH, payload });

async function createRelease(app: ApiServer, title = 'R1'): Promise<string> {
  const res = await post(app, `/api/v1/releases/${WS}`, { title });
  expect(res.statusCode).toBe(201);
  return (res.json() as { release: { release_id: string } }).release.release_id;
}

/** Drive a release through the full lifecycle to `released`. */
async function shipRelease(app: ApiServer): Promise<string> {
  await seedMergedTicket('SR-0001', 'F-0001');
  await seedFeature('F-0001');
  const rel = await createRelease(app);
  const add = await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
    item_kind: 'feature',
    item_id: 'F-0001',
  });
  expect(add.statusCode).toBe(200);
  expect(
    (await post(app, `/api/v1/releases/${WS}/${rel}/freeze`)).statusCode,
  ).toBe(200);
  const approve = await post(app, `/api/v1/releases/${WS}/${rel}/approve`, {
    decision: 'approved',
    rationale: 'looks good',
  });
  expect(approve.statusCode).toBe(200);
  const released = await post(app, `/api/v1/releases/${WS}/${rel}/release`);
  expect(released.statusCode).toBe(200);
  return rel;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-releases-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('POST /releases — create', () => {
  it('creates a draft REL-NNNN + release_created event', async () => {
    const app = makeServer();
    const rel = await createRelease(app, 'October cut');
    expect(rel).toMatch(/^REL-\d+$/);
    const release = await store.getRelease({
      workspace: WS,
      release_id: rel,
    });
    expect(release?.status).toBe('draft');
    const evs = await store.listEvents({ workspace: WS, ticket_id: rel });
    expect(evs.map((e) => e.event)).toContain('release_created');
    await app.close();
  });

  it('400 on a missing title — never a half-parsed write', async () => {
    const app = makeServer();
    const res = await post(app, `/api/v1/releases/${WS}`, {
      target: 'prod',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /releases — list + detail', () => {
  it('lists releases and returns detail with items/manifest/gates', async () => {
    const app = makeServer();
    const rel = await createRelease(app);
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/releases/${WS}`,
      headers: AUTH,
    });
    expect(list.statusCode).toBe(200);
    const { releases } = list.json() as {
      releases: { release_id: string }[];
    };
    expect(releases.map((r) => r.release_id)).toContain(rel);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/releases/${WS}/${rel}`,
      headers: AUTH,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      release: { release_id: string };
      items: unknown[];
      manifest: unknown;
      approvals: unknown[];
      gates: Record<string, unknown>;
    };
    expect(body.release.release_id).toBe(rel);
    expect(body.items).toEqual([]);
    expect(body.manifest).toBeNull();
    expect(body.approvals).toEqual([]);
    await app.close();
  });

  it('404 on an unknown release / unknown workspace', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/releases/${WS}/REL-9999`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    const wsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/releases/nowhere',
      headers: AUTH,
    });
    expect(wsRes.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST …/items — scope membership', () => {
  it('adds a ticket item; partial_ac requires approved_by', async () => {
    const app = makeServer();
    await seedMergedTicket('SR-0001');
    const rel = await createRelease(app);
    const ok = await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
    });
    expect(ok.statusCode).toBe(200);

    const bad = await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
      partial_ac: ['AC-1'],
    });
    expect(bad.statusCode).toBe(400);

    const partial = await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
      partial_ac: ['AC-1'],
      approved_by: 'human-op',
    });
    expect(partial.statusCode).toBe(200);
    await app.close();
  });

  it('400 malformed, 404 unknown ticket, 403 agent-approved partial', async () => {
    const app = makeServer();
    await seedMergedTicket('SR-0001');
    const rel = await createRelease(app);
    const malformed = await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'banana',
      item_id: 'SR-0001',
    });
    expect(malformed.statusCode).toBe(400);

    const missing = await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-XXXX',
    });
    expect(missing.statusCode).toBe(404);

    const agent = await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
      partial_ac: ['AC-1'],
      approved_by: 'agent-x',
      actor_kind: 'agent',
    });
    expect(agent.statusCode).toBe(403);
    await app.close();
  });

  it('DELETE soft-removes an item (release_items_changed, audit row stays)', async () => {
    const app = makeServer();
    await seedMergedTicket('SR-0001');
    const rel = await createRelease(app);
    await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/releases/${WS}/${rel}/items`,
      headers: AUTH,
      payload: { item_kind: 'ticket', item_id: 'SR-0001' },
    });
    expect(res.statusCode).toBe(200);
    // Live scope is empty; the removal is recorded on the event ledger.
    const items = await store.listReleaseItems({
      workspace: WS,
      release_id: rel,
    });
    expect(items).toHaveLength(0);
    const evs = await store.listEvents({ workspace: WS, ticket_id: rel });
    const removed = evs.filter(
      (e) => e.event === 'release_items_changed' && e.data.removed != null,
    );
    expect(removed).toHaveLength(1);
    await app.close();
  });
});

describe('freeze + approve — lifecycle writes with OCC', () => {
  it('freeze cuts a manifest (draft→ready); stale expected_status 409s', async () => {
    const app = makeServer();
    await seedMergedTicket('SR-0001');
    const rel = await createRelease(app);
    await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
    });
    const stale = await post(app, `/api/v1/releases/${WS}/${rel}/freeze`, {
      expected_status: 'approved',
    });
    expect(stale.statusCode).toBe(409);

    const ok = await post(app, `/api/v1/releases/${WS}/${rel}/freeze`, {
      expected_status: 'draft',
    });
    expect(ok.statusCode).toBe(200);
    const { manifest } = ok.json() as {
      manifest: { version: number; digest: string };
    };
    expect(manifest.version).toBe(1);
    const release = await store.getRelease({
      workspace: WS,
      release_id: rel,
    });
    expect(release?.status).toBe('ready');
    const evs = await store.listEvents({ workspace: WS, ticket_id: rel });
    expect(evs.map((e) => e.event)).toContain('manifest_cut');
    await app.close();
  });

  it('freeze on an empty release is 400 (empty-manifest)', async () => {
    const app = makeServer();
    const rel = await createRelease(app);
    const res = await post(app, `/api/v1/releases/${WS}/${rel}/freeze`);
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('approve binds to the manifest digest; agent approve → 403', async () => {
    const app = makeServer();
    await seedMergedTicket('SR-0001');
    const rel = await createRelease(app);
    // draft → approve is a bad-state 409 (freeze first).
    const early = await post(app, `/api/v1/releases/${WS}/${rel}/approve`, {
      decision: 'approved',
    });
    expect(early.statusCode).toBe(409);

    await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
    });
    await post(app, `/api/v1/releases/${WS}/${rel}/freeze`);

    const agent = await post(app, `/api/v1/releases/${WS}/${rel}/approve`, {
      decision: 'approved',
      actor_kind: 'agent',
    });
    expect(agent.statusCode).toBe(403);

    const ok = await post(app, `/api/v1/releases/${WS}/${rel}/approve`, {
      decision: 'approved',
      rationale: 'signed off',
    });
    expect(ok.statusCode).toBe(200);
    const release = await store.getRelease({
      workspace: WS,
      release_id: rel,
    });
    expect(release?.status).toBe('approved');
    const evs = await store.listEvents({ workspace: WS, ticket_id: rel });
    expect(evs.map((e) => e.event)).toContain('release_approved');
    await app.close();
  });
});

describe('POST …/release — the ship write (gate-guarded)', () => {
  it(
    'marks an approved release released + flips member tickets',
    { timeout: 60_000 },
    async () => {
      const app = makeServer();
      const rel = await shipRelease(app);
      const release = await store.getRelease({
        workspace: WS,
        release_id: rel,
      });
      expect(release?.status).toBe('released');
      const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
      expect(t?.status).toBe('released');
      const evs = await store.listEvents({ workspace: WS, ticket_id: rel });
      expect(evs.map((e) => e.event)).toContain('release_released');
      await app.close();
    },
  );

  it('gate-failed → 409 (unmerged member can never ship)', async () => {
    const app = makeServer();
    await seedMergedTicket('SR-0001');
    // A second repo row with no merged_sha poisons the merged gate.
    await store.upsertTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0001',
      repo: 'web',
      merged_sha: null,
    });
    const rel = await createRelease(app);
    await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
    });
    await post(app, `/api/v1/releases/${WS}/${rel}/freeze`);
    await post(app, `/api/v1/releases/${WS}/${rel}/approve`, {
      decision: 'approved',
    });
    const res = await post(app, `/api/v1/releases/${WS}/${rel}/release`);
    expect(res.statusCode).toBe(409);
    const release = await store.getRelease({
      workspace: WS,
      release_id: rel,
    });
    expect(release?.status).toBe('approved');
    // Failing attempt is durable audit (all five gate rows).
    const gates = await store.listReleaseGateResults({
      workspace: WS,
      release_id: rel,
    });
    expect(gates.map((g) => g.gate)).toContain('merged');
    expect(gates.find((g) => g.gate === 'merged')?.result).toBe('fail');
    await app.close();
  });
});

describe('POST …/deployments — manual evidence (invariant 4)', () => {
  it('records a confirmed deployment + deployment_confirmed event', async () => {
    const app = makeServer();
    const rel = await shipRelease(app);
    const res = await post(app, `/api/v1/releases/${WS}/${rel}/deployments`, {
      env: 'prod',
      sha: SHA,
      evidence: {
        type: 'manual',
        by: 'deploy-op',
        note: 'shipped via runbook 7',
        url: 'https://deploys.internal/123',
      },
    });
    expect(res.statusCode).toBe(201);
    const { deployment } = res.json() as {
      deployment: { deployment_id: string; confirmed_at: string };
    };
    expect(deployment.confirmed_at).toBeTruthy();
    const evs = await store.listEvents({ workspace: WS, ticket_id: rel });
    expect(evs.map((e) => e.event)).toContain('deployment_confirmed');
    await app.close();
  });

  it('400 on missing/invalid evidence; 409 before the release ships', async () => {
    const app = makeServer();
    const rel = await shipRelease(app);
    const missing = await post(
      app,
      `/api/v1/releases/${WS}/${rel}/deployments`,
      {
        env: 'prod',
        sha: SHA,
      },
    );
    expect(missing.statusCode).toBe(400);

    const empty = await post(app, `/api/v1/releases/${WS}/${rel}/deployments`, {
      env: 'prod',
      sha: SHA,
      evidence: { type: 'manual', by: 'op' },
    });
    expect(empty.statusCode).toBe(400);

    const webhook = await post(
      app,
      `/api/v1/releases/${WS}/${rel}/deployments`,
      {
        env: 'prod',
        sha: SHA,
        evidence: {
          type: 'webhook',
          by: 'ci',
          note: 'auto',
          url: 'https://x',
        },
      },
    );
    expect(webhook.statusCode).toBe(400);

    const draft = await createRelease(app, 'draft rel');
    const early = await post(
      app,
      `/api/v1/releases/${WS}/${draft}/deployments`,
      {
        env: 'prod',
        sha: SHA,
        evidence: { type: 'manual', by: 'op', note: 'n', url: 'https://x' },
      },
    );
    expect(early.statusCode).toBe(409);
    await app.close();
  });
});

describe('POST /features/…/exposure — invariant 4', () => {
  it('available requires a linked confirmed deployment carrying the feature', async () => {
    const app = makeServer();
    const rel = await shipRelease(app);
    // No deployment yet → `available` must fail closed (409).
    const noDep = await post(app, `/api/v1/features/${WS}/F-0001/exposure`, {
      env: 'prod',
      state: 'available',
    });
    expect(noDep.statusCode).toBe(409);

    const dep = await post(app, `/api/v1/releases/${WS}/${rel}/deployments`, {
      env: 'prod',
      sha: SHA,
      evidence: { type: 'manual', by: 'op', note: 'n', url: 'https://x' },
    });
    const depId = (dep.json() as { deployment: { deployment_id: string } })
      .deployment.deployment_id;

    const ok = await post(app, `/api/v1/features/${WS}/F-0001/exposure`, {
      env: 'prod',
      state: 'available',
      deployment_id: depId,
    });
    expect(ok.statusCode).toBe(200);
    const row = await store.getFeatureExposure({
      workspace: WS,
      feature_id: 'F-0001',
      environment: 'prod',
    });
    expect(row?.state).toBe('available');
    const evs = await store.listEvents({ workspace: WS, ticket_id: 'F-0001' });
    expect(evs.map((e) => e.event)).toContain('feature_exposed');
    await app.close();
  });

  it('hidden is free-standing; unknown feature 404s; malformed 400s', async () => {
    const app = makeServer();
    await seedFeature('F-0009');
    const hidden = await post(app, `/api/v1/features/${WS}/F-0009/exposure`, {
      env: 'staging',
      state: 'hidden',
    });
    expect(hidden.statusCode).toBe(200);

    const missing = await post(app, `/api/v1/features/${WS}/F-XXXX/exposure`, {
      env: 'prod',
      state: 'hidden',
    });
    expect(missing.statusCode).toBe(404);

    const bad = await post(app, `/api/v1/features/${WS}/F-0009/exposure`, {
      env: 'prod',
      state: 'glowing',
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /merge-center — readiness view', () => {
  it('returns per-ticket readiness for ci-watch tickets', async () => {
    const app = makeServer();
    await seedTicket('SR-0007', 'ci-watch');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/merge-center/${WS}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const { tickets } = res.json() as {
      tickets: {
        ticket_id: string;
        ready: boolean;
        items: { id: string; ok: boolean }[];
      }[];
    };
    const row = tickets.find((t) => t.ticket_id === 'SR-0007');
    expect(row).toBeTruthy();
    expect(row?.ready).toBe(false);
    expect(row?.items.map((i) => i.id)).toContain('ac-evidence');
    await app.close();
  });

  it('404 on an unknown workspace', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/merge-center/nowhere',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /tickets/…/corrections', () => {
  it('files an origin:correction ticket with a parent link', async () => {
    const app = makeServer();
    await seedMergedTicket('SR-0001');
    const res = await post(app, `/api/v1/tickets/${WS}/SR-0001/corrections`, {
      title: 'checkout double-charges on retry',
      severity: 'major',
      description: 'seen in prod',
    });
    expect(res.statusCode).toBe(201);
    const { ticket } = res.json() as {
      ticket: { ticket_id: string; origin: string; parent: string };
    };
    expect(ticket.origin).toBe('correction');
    expect(ticket.parent).toBe('SR-0001');
    expect(ticket.ticket_id).toMatch(/^SR-\d+$/);
    const evs = await store.listEvents({ workspace: WS, ticket_id: 'SR-0001' });
    expect(evs.map((e) => e.event)).toContain('correction_filed');
    await app.close();
  });

  it('400 missing title, 404 unknown parent, 409 unmerged parent', async () => {
    const app = makeServer();
    await seedMergedTicket('SR-0001');
    await seedTicket('SR-0002', 'in-progress');

    const bad = await post(app, `/api/v1/tickets/${WS}/SR-0001/corrections`, {
      severity: 'major',
    });
    expect(bad.statusCode).toBe(400);

    const missing = await post(
      app,
      `/api/v1/tickets/${WS}/SR-XXXX/corrections`,
      {
        title: 'ghost defect',
      },
    );
    expect(missing.statusCode).toBe(404);

    const early = await post(app, `/api/v1/tickets/${WS}/SR-0002/corrections`, {
      title: 'pre-merge defect',
    });
    expect(early.statusCode).toBe(409);
    await app.close();
  });
});

describe('notes approve / publish — human-only (invariant 6)', () => {
  async function seedNotesDraft(rel: string, audience = 'customer') {
    await store.appendDocVersion(
      { workspace: WS, subject: rel, doc: `notes-${audience}.md` as never },
      '# Draft notes\n',
      'agent',
    );
  }

  it('approves + publishes a drafted note; agent approve → 403', async () => {
    const app = makeServer();
    const rel = await shipRelease(app);
    await seedNotesDraft(rel);

    const agent = await post(
      app,
      `/api/v1/releases/${WS}/${rel}/notes/customer/approve`,
      { actor_kind: 'agent' },
    );
    expect(agent.statusCode).toBe(403);

    const ok = await post(
      app,
      `/api/v1/releases/${WS}/${rel}/notes/customer/approve`,
      { approver: 'release-owner' },
    );
    expect(ok.statusCode).toBe(200);
    const evs = await store.listEvents({ workspace: WS, ticket_id: rel });
    expect(evs.map((e) => e.event)).toContain('release_note_approved');

    const pub = await post(
      app,
      `/api/v1/releases/${WS}/${rel}/notes/customer/publish`,
    );
    expect(pub.statusCode).toBe(200);
    const note = await store.getReleaseNote({
      workspace: WS,
      release_id: rel,
      audience: 'customer',
    });
    expect(note?.published_at).toBeTruthy();
    await app.close();
  });

  it('approve with no draft → 409; publish unapproved → 409; bad audience → 400', async () => {
    const app = makeServer();
    const rel = await shipRelease(app);
    const noDraft = await post(
      app,
      `/api/v1/releases/${WS}/${rel}/notes/customer/approve`,
    );
    expect(noDraft.statusCode).toBe(409);

    await seedNotesDraft(rel, 'technical');
    const unpub = await post(
      app,
      `/api/v1/releases/${WS}/${rel}/notes/technical/publish`,
    );
    expect(unpub.statusCode).toBe(409);

    const badAudience = await post(
      app,
      `/api/v1/releases/${WS}/${rel}/notes/aliens/approve`,
    );
    expect(badAudience.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST …/retro — queues a retro run', () => {
  it('queues a pending retro run on a shipped release', async () => {
    const app = makeServer();
    const rel = await shipRelease(app);
    const res = await post(app, `/api/v1/releases/${WS}/${rel}/retro`);
    expect(res.statusCode).toBe(200);
    const { run } = res.json() as { run: string };
    expect(run).toContain(rel);
    const runs = await store.listRuns({ workspace: WS, subject: rel });
    expect(
      runs.some((r) => r.stage === 'retro' && r.status === 'pending'),
    ).toBe(true);
    // A second request is fenced by the live run → 409.
    const dup = await post(app, `/api/v1/releases/${WS}/${rel}/retro`);
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it('409 on a draft release — nothing shipped to retrospect', async () => {
    const app = makeServer();
    const rel = await createRelease(app);
    const res = await post(app, `/api/v1/releases/${WS}/${rel}/retro`);
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe('SSE — DELIVERY §5 event names mirror onto /api/v1/stream', () => {
  it('release_created + release_items_changed stream to clients', async () => {
    const app = makeServer();
    const stream = app.inject({
      method: 'GET',
      url: '/api/v1/stream',
      headers: AUTH,
    });
    await vi.waitFor(() => expect(app.streamCount()).toBe(1));

    await seedMergedTicket('SR-0001');
    const rel = await createRelease(app);
    await post(app, `/api/v1/releases/${WS}/${rel}/items`, {
      item_kind: 'ticket',
      item_id: 'SR-0001',
    });

    app.closeStreams();
    const res = await stream;
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: release_created');
    expect(res.body).toContain('event: release_items_changed');
    await app.close();
  });
});
