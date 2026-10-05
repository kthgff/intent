/**
 * wp-148 API tests — the /api/v1/reviews surface (PRD §15.8).
 *
 * Fastify inject only, PGlite store. Covers the HTTP contract: session
 * create/read, revision pinning, commit-bound decisions with the
 * expected_revision stale-write guard + gate-clear/fix-run side
 * effects, finding lifecycle transitions (400/403/404 mapping),
 * out-of-scope → ChangeSet routing, the server-side delta, evidence
 * links, and external mappings. Auth inherits the global hook — these
 * tests prove the route table + error mapping, not the engine (the
 * conductor suite owns engine semantics).
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
import {
  type ApiServer,
  type ServerOptions,
  createServer,
} from '../src/index.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';
const RV = 'rv-SR-0001';

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-api-review-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Helper: create session + pin a revision through the routes. */
async function seedSessionAndRevision(
  app: ApiServer,
  head = 'sha-a',
): Promise<void> {
  const s = await app.inject({
    method: 'POST',
    url: '/api/v1/reviews',
    headers: AUTH,
    payload: { workspace: WS, subject: 'SR-0001' },
  });
  expect(s.statusCode).toBe(201);
  const r = await app.inject({
    method: 'POST',
    url: `/api/v1/reviews/${WS}/${RV}/revisions`,
    headers: AUTH,
    payload: { head_sha: head, baseline: { rs_version: 1, ac_ids: [] } },
  });
  expect(r.statusCode).toBe(201);
}

describe('review sessions + revisions', () => {
  it('creates a session (deterministic id), lists it, reads the detail rollup', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews?workspace=${WS}`,
      headers: AUTH,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions.map((s: { review_id: string }) => s.review_id)).toEqual([RV]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${WS}/${RV}`,
      headers: AUTH,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.session.review_id).toBe(RV);
    expect(body.latest_revision.revision).toBe(1);
    expect(body.latest_revision.head_sha).toBe('sha-a');
    await app.close();
  });

  it('404s an unknown review; identical revision re-pin returns 200 not 201', async () => {
    const app = makeServer();
    const miss = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${WS}/rv-nope`,
      headers: AUTH,
    });
    expect(miss.statusCode).toBe(404);

    await seedSessionAndRevision(app);
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/revisions`,
      headers: AUTH,
      payload: { head_sha: 'sha-a', baseline: { rs_version: 1, ac_ids: [] } },
    });
    expect(again.statusCode).toBe(200); // idempotent re-pin
    const moved = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/revisions`,
      headers: AUTH,
      payload: { head_sha: 'sha-b', baseline: { rs_version: 1, ac_ids: [] } },
    });
    expect(moved.statusCode).toBe(201);
    expect(moved.json().revision.revision).toBe(2);
    await app.close();
  });
});

describe('decisions — commit-bound + stale-write guard + side effects', () => {
  it('approve binds the latest revision; expected_revision 409s a stale write', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/decisions`,
      headers: AUTH,
      payload: {
        action: 'approve',
        reviewer: 'keith',
        expected_revision: 1,
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().decision.head_sha).toBe('sha-a');
    expect(ok.json().session.status).toBe('approved');

    // A second approval claiming the old pin after head moved → 409.
    await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/revisions`,
      headers: AUTH,
      payload: { head_sha: 'sha-b' },
    });
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/decisions`,
      headers: AUTH,
      payload: {
        action: 'approve',
        reviewer: 'keith',
        expected_revision: 1,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('conflict');
    // …and the session dropped back to open (stale-approval rollup).
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${WS}/${RV}`,
      headers: AUTH,
    });
    expect(detail.json().session.status).toBe('open');
    expect(detail.json().approval_state[0].currency).toBe('stale');
    await app.close();
  });

  it('approve clears the surfaced review gates (conductor side-effect)', async () => {
    await store.upsertGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'changes-requested',
      kind: 'review',
      surfaced_at: '2026-10-05T00:00:00Z',
      cleared_at: null,
      blocked_agent: true,
      priority: 'medium',
    });
    const app = makeServer();
    await seedSessionAndRevision(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/decisions`,
      headers: AUTH,
      payload: { action: 'approve', reviewer: 'keith' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().gates_cleared).toEqual(['changes-requested']);
    expect(
      (
        await store.getGateItem({
          workspace: WS,
          subject: 'SR-0001',
          gate: 'changes-requested',
        })
      )?.cleared_at,
    ).toBeTruthy();
    await app.close();
  });

  it('request-fix queues a fix run; a live fence reports, never fails the decision', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/decisions`,
      headers: AUTH,
      payload: { action: 'request-fix', reviewer: 'keith' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().run).toBeTruthy();

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/decisions`,
      headers: AUTH,
      payload: { action: 'request-fix', reviewer: 'keith' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().fix_already_running).toBe(true);
    await app.close();
  });

  it('malformed action → 400, never a write', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/decisions`,
      headers: AUTH,
      payload: { action: 'ship-it', reviewer: 'keith' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('findings lifecycle over HTTP', () => {
  async function seedFinding(app: ApiServer, fid = 'f-1'): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/findings`,
      headers: AUTH,
      payload: { finding_id: fid, body: 'bug', severity: 'major' },
    });
    expect(res.statusCode).toBe(201);
  }

  it('create → transition → history; terminal disposition enforces rationale', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    await seedFinding(app);

    const triage = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/findings/f-1/transition`,
      headers: AUTH,
      payload: { to: 'triaged' },
    });
    expect(triage.statusCode).toBe(200);
    expect(triage.json().finding.status).toBe('triaged');

    // Terminal without rationale → 400.
    const noRationale = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/findings/f-1/transition`,
      headers: AUTH,
      payload: { to: 'accepted-risk' },
    });
    expect(noRationale.statusCode).toBe(400);

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/findings/f-1/transition`,
      headers: AUTH,
      payload: {
        to: 'accepted-risk',
        rationale: 'documented trade-off',
      },
    });
    expect(accepted.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${WS}/${RV}/findings/f-1`,
      headers: AUTH,
    });
    expect(
      detail.json().history.map((h: { status: string }) => h.status),
    ).toEqual(['open', 'triaged', 'accepted-risk']);
    await app.close();
  });

  it('expected_status on transition → 409 on a stale write', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    await seedFinding(app);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/findings/f-1/transition`,
      headers: AUTH,
      payload: { to: 'triaged', expected_status: 'resolved' },
    });
    expect(stale.statusCode).toBe(409);
    await app.close();
  });

  it('agent actor_kind cannot take a permissioned disposition', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    await seedFinding(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/findings/f-1/transition`,
      headers: AUTH,
      payload: {
        to: 'not-applicable',
        actor_kind: 'agent',
        rationale: 'machine says n/a',
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('comments — out-of-scope → ChangeSet', () => {
  it('routes the comment to a draft changeset and links changeset_id', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/comments`,
      headers: AUTH,
      payload: {
        comment_id: 'cm-1',
        body: 'also add SSO',
        type: 'out-of-scope',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().changeset_id).toBe('cs-cm-1');
    expect(
      await store.getChangeset({ workspace: WS, changeset_id: 'cs-cm-1' }),
    ).toMatchObject({ status: 'draft', request: 'also add SSO' });
    await app.close();
  });

  it('reclassify flips a comment into out-of-scope and routes lazily', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/comments`,
      headers: AUTH,
      payload: { comment_id: 'cm-2', body: 'wider ask', type: 'improvement' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/comments/cm-2/reclassify`,
      headers: AUTH,
      payload: { type: 'out-of-scope' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changeset_id).toBe('cs-cm-2');
    await app.close();
  });
});

describe('delta + evidence + mappings', () => {
  it('GET /delta computes the since-your-review view server-side', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/decisions`,
      headers: AUTH,
      payload: { action: 'approve', reviewer: 'keith' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/revisions`,
      headers: AUTH,
      payload: { head_sha: 'sha-b' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${WS}/${RV}/delta?reviewer=keith`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().head).toEqual({ from_sha: 'sha-a', to_sha: 'sha-b' });
    expect(res.json().from_revision).toBe(1);
    // no ticket_repos worktrees in this fixture → empty per-repo diff.
    expect(res.json().diff).toEqual([]);
    await app.close();
  });

  it('evidence links + external mappings round-trip idempotently', async () => {
    const app = makeServer();
    await seedSessionAndRevision(app);
    await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/findings`,
      headers: AUTH,
      payload: { finding_id: 'f-e', body: 'bug' },
    });
    for (let i = 0; i < 2; i += 1) {
      const link = await app.inject({
        method: 'POST',
        url: `/api/v1/reviews/${WS}/${RV}/findings/f-e/evidence`,
        headers: AUTH,
        payload: { evidence_ref: 'ac:AC-1' },
      });
      expect(link.statusCode).toBe(201);
    }
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${WS}/${RV}/findings/f-e`,
      headers: AUTH,
    });
    expect(detail.json().evidence_links).toHaveLength(1);
    expect(detail.json().evidence_links[0].kind).toBe('requirement');

    await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${WS}/${RV}/mappings`,
      headers: AUTH,
      payload: {
        finding_id: 'f-e',
        external_kind: 'github-review-thread',
        external_id: 'PRRT_1',
      },
    });
    const maps = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${WS}/${RV}/mappings?finding_id=f-e`,
      headers: AUTH,
    });
    expect(maps.json().mappings).toHaveLength(1);
    await app.close();
  });

  it('requirement view resolves AC edges', async () => {
    await store.upsertRelation({
      subject: 'ac:AC-1',
      predicate: 'implements',
      object: 'ev_code_unit_1',
      source: 'explicit',
    });
    const app = makeServer();
    await seedSessionAndRevision(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/${WS}/${RV}/requirements/AC-1`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().implementing.map((r: { object: string }) => r.object)).toEqual([
      'ev_code_unit_1',
    ]);
    await app.close();
  });
});
