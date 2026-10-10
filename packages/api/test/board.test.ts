/**
 * wp-144 API tests — board surfaces (PRD §15.3).
 *
 * fastify inject only, no real port. Covers:
 *   - `GET /board`: derived `phase` grouping + server-computed
 *     `drop_targets` + attention, and the failed/blocked in-phase rule;
 *   - idea board CRUD + typed notes + statement-derived surface;
 *   - the board → statements extraction handoff over HTTP;
 *   - referencing approved items (reference card vs ChangeSet);
 *   - spawn provenance;
 *   - bearer auth on the new routes.
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
import type { BoardItem, GateItem, TicketRow } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApiServer, createServer } from '../src/index.js';

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

const ticketRow = (over: Partial<TicketRow>): TicketRow => ({
  workspace: WS,
  ticket_id: 'SR-0001',
  title: 't',
  status: 'triage',
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

const boardItem = (
  over: Partial<BoardItem> & Pick<BoardItem, 'id'>,
): BoardItem => ({
  workspace: WS,
  board: 'ideas',
  kind: 'note',
  ref: null,
  title: null,
  body: null,
  x: null,
  y: null,
  w: null,
  h: null,
  zone: null,
  serves: null,
  status: 'active',
  consumed_by: null,
  note_kind: null,
  topic: null,
  importance: null,
  applies_to: null,
  note_status: 'open',
  rationale: null,
  provenance: 'stakeholder-verified',
  created_at: '2026-10-05T00:00:00Z',
  updated_at: '2026-10-05T00:00:00Z',
  ...over,
});

const gateItem = (over: Partial<GateItem>): GateItem => ({
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
  dir = mkdtempSync(join(tmpdir(), 'veto-api-board-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  const ROUTES: [string, string][] = [
    ['GET', '/api/v1/board'],
    ['GET', '/api/v1/boards?workspace=ws'],
    ['POST', '/api/v1/boards'],
    ['GET', '/api/v1/boards/ideas?workspace=ws'],
    ['POST', '/api/v1/boards/ideas/items'],
    ['POST', '/api/v1/boards/ideas/extract'],
    ['GET', '/api/v1/board-items/x/statements?workspace=ws'],
  ];
  it('requires the bearer token on every board route', async () => {
    const app = makeServer();
    for (const [method, url] of ROUTES) {
      const res = await app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// pipeline board
// ---------------------------------------------------------------------------

describe('GET /board', () => {
  it('groups tickets by derived phase with attention + drop_targets', async () => {
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0001', status: 'triage' }),
    );
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0002', status: 'prd-review' }),
    );
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0003', status: 'in-progress' }),
    );
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0004', status: 'ci-watch' }),
    );
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0005', status: 'merged' }),
    );
    // A failed ticket that died in build — the ledger carries the
    // in-progress transition before the failure (derivePhase walks
    // status_changed targets back to the last meaningful phase).
    await store.upsertTicket(
      ticketRow({ ticket_id: 'SR-0006', status: 'failed' }),
    );
    for (const [ts, data] of [
      ['2026-10-03T00:00:00Z', { from: 'ready', to: 'in-progress' }],
      ['2026-10-03T01:00:00Z', { from: 'in-progress', to: 'failed' }],
    ] as const) {
      await store.appendEvent({
        workspace: WS,
        ticket_id: 'SR-0006',
        ts,
        stage: null,
        actor_type: 'runner',
        actor_id: 'bot',
        event: 'status_changed',
        run: null,
        refs: [],
        data,
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        human_minutes: null,
      });
    }
    await store.upsertGateItem(
      gateItem({ subject: 'SR-0001', gate: 'prd-review' }),
    );

    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/board?workspace=ws',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cards: {
        ref: string;
        phase: string;
        flagged: string | null;
        attention: unknown[];
        drop_targets: { column: string; action: string }[];
      }[];
      ops: unknown[];
    };
    const byPhase = new Map<string, typeof body.cards>();
    for (const c of body.cards) {
      const list = byPhase.get(c.phase) ?? [];
      list.push(c);
      byPhase.set(c.phase, list);
    }
    expect(byPhase.get('backlog')).toHaveLength(1);
    expect(byPhase.get('spec')).toHaveLength(1);
    // in-progress + the failed ticket (died in build) both land in build.
    expect(byPhase.get('build')).toHaveLength(2);
    expect(byPhase.get('review')).toHaveLength(1);
    expect(byPhase.get('done')).toHaveLength(1);

    const failed = byPhase.get('build')?.find((c) => c.ref === 'ws/SR-0006');
    expect(failed?.phase).toBe('build');
    expect(failed?.flagged).toBe('failed');
    // Dead card: abandon-to-done + retry-in-place are the allowed drops.
    expect(failed?.drop_targets.map((t) => [t.column, t.action])).toEqual([
      ['done', 'wont_do'],
      ['build', 'retry'],
    ]);

    const triage = byPhase.get('backlog')?.find((c) => c.ref === 'ws/SR-0001');
    expect(triage?.attention).toHaveLength(1);
    expect(triage?.drop_targets.map((t) => [t.column, t.action])).toEqual([
      ['done', 'wont_do'],
    ]);

    const merged = byPhase.get('done')?.find((c) => c.ref === 'ws/SR-0005');
    expect(merged?.drop_targets).toEqual([]);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// idea boards
// ---------------------------------------------------------------------------

describe('idea boards', () => {
  it('creates + lists boards with type config', async () => {
    const app = makeServer();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: {
        workspace: WS,
        board: 'ideas',
        name: 'Q1 ideas',
        board_type: 'new-project',
        status: 'discovery',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().board.board_type).toBe('new-project');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/boards?workspace=ws',
      headers: AUTH,
    });
    expect(listed.statusCode).toBe(200);
    const boards = listed.json().boards as {
      board: string;
      type_config: { board_type: string };
    }[];
    expect(boards).toHaveLength(1);
    expect(boards[0]?.type_config.board_type).toBe('new-project');

    // Fail-closed on a bad type.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: { workspace: WS, board: 'x', board_type: 'pipeline' },
    });
    expect(bad.statusCode).toBe(400);

    await app.close();
  });

  it('creates a typed note and fails closed on a bad note_kind', async () => {
    const app = makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: { workspace: WS, board: 'ideas', board_type: 'exploration' },
    });
    const note = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        note_kind: 'constraint',
        importance: 'must',
        title: 'SSO must be optional',
        applies_to: ['SR-0001'],
      },
    });
    expect(note.statusCode).toBe(201);
    expect(note.json().item.note_kind).toBe('constraint');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: { workspace: WS, note_kind: 'vibe' },
    });
    expect(bad.statusCode).toBe(400);

    await app.close();
  });

  it('ingests statements and surfaces them per item', async () => {
    const app = makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: { workspace: WS, board: 'ideas', board_type: 'new-project' },
    });
    await store.upsertBoardItem(
      boardItem({
        id: 'a1',
        board: 'ideas',
        title: 'Password resets take 3 days',
        body: 'We must cut that to under an hour.',
      }),
    );
    await store.upsertBoardItem(
      boardItem({
        id: 'a2',
        board: 'ideas',
        title: 'Admins need an audit log',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/extract',
      headers: AUTH,
      payload: {
        workspace: WS,
        output: {
          schema: 1,
          statements: [
            {
              key: 'problem',
              text: 'Password resets take 3 days',
              source: 0,
              source_text: 'Password resets take 3 days',
              intent: 'problem',
            },
            {
              key: 'req',
              text: 'Resets complete in under an hour',
              source: 0,
              source_text: 'We must cut that to under an hour.',
              intent: 'requires',
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as {
      statements: unknown[];
      byItem: Record<string, string[]>;
    };
    expect(result.statements).toHaveLength(2);
    expect(result.byItem.a1).toHaveLength(2);
    expect(result.byItem.a2).toHaveLength(0);

    // Statement-derived surface for one card.
    const stmts = await app.inject({
      method: 'GET',
      url: '/api/v1/board-items/a1/statements?workspace=ws',
      headers: AUTH,
    });
    expect(stmts.statusCode).toBe(200);
    expect(stmts.json().statements).toHaveLength(2);

    // The board surface carries per-item statements too.
    const boardRes = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/ideas?workspace=ws',
      headers: AUTH,
    });
    const items = boardRes.json().items as {
      item: { id: string };
      statements: unknown[];
    }[];
    expect(items.find((i) => i.item.id === 'a1')?.statements).toHaveLength(2);
    expect(items.find((i) => i.item.id === 'a2')?.statements).toHaveLength(0);

    await app.close();
  });

  it('references approved items without mutating; changes arrive as ChangeSets', async () => {
    const app = makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: { workspace: WS, board: 'enhance', board_type: 'enhancement' },
    });
    await store.upsertProject({ workspace: WS });
    await store.appendDocVersion(
      { workspace: WS, subject: 'I-0001', doc: 'rs.md' },
      '# RS v1',
      'human',
    );

    const ref = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/enhance/reference',
      headers: AUTH,
      payload: { workspace: WS, subject: 'I-0001', doc: 'rs.md' },
    });
    expect(ref.statusCode).toBe(201);
    expect(ref.json().item.ref).toBe('I-0001:rs.md@v1');
    expect(
      await store.listDocVersions({
        workspace: WS,
        subject: 'I-0001',
        doc: 'rs.md',
      }),
    ).toHaveLength(1);

    const cs = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/enhance/reference',
      headers: AUTH,
      payload: {
        workspace: WS,
        subject: 'I-0001',
        doc: 'rs.md',
        request: 'SSO must be optional for admins',
      },
    });
    expect(cs.statusCode).toBe(201);
    expect(cs.json().changeset.changeset_id).toMatch(/^CS-\d{4}$/);
    expect(cs.json().changeset.baseline.version).toBe(1);
    // Still exactly one version — the approved doc was never mutated.
    expect(
      await store.listDocVersions({
        workspace: WS,
        subject: 'I-0001',
        doc: 'rs.md',
      }),
    ).toHaveLength(1);

    await app.close();
  });

  it('spawns a workspace from an org board with provenance', async () => {
    const app = makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: {
        workspace: WS,
        board: 'org-inbox',
        org: 'acme',
        board_type: 'new-project',
      },
    });
    const spawned = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/org-inbox/spawn',
      headers: AUTH,
      payload: { workspace: WS, new_workspace: 'myapp' },
    });
    expect(spawned.statusCode).toBe(201);
    expect(spawned.json().provenance.ref).toBe('board:ws/org-inbox');
    expect(await store.getProject('myapp')).not.toBeNull();

    await app.close();
  });

  it('defers a board and resurfaces it as a proposal', async () => {
    const app = makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: { workspace: WS, board: 'ideas', board_type: 'enhancement' },
    });
    await store.upsertBoardItem(boardItem({ id: 'a1', board: 'ideas' }));
    await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/status',
      headers: AUTH,
      payload: { workspace: WS, status: 'deferred' },
    });
    const proposal = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/resurface',
      headers: AUTH,
      payload: { workspace: WS, reason: 'now cheap' },
    });
    expect(proposal.statusCode).toBe(200);
    expect(proposal.json().proposal.requires_approval).toBe(true);
    expect(proposal.json().proposal.retained_items).toBe(1);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/resurface/accept',
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().board.status).toBe('discovery');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// s-16 board canvas — batch OCC, connectors, kind/ref guards
// ---------------------------------------------------------------------------

describe('board canvas (s-16)', () => {
  async function seedBoard(app: ApiServer) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: { workspace: WS, board: 'ideas', board_type: 'exploration' },
    });
    expect(res.statusCode).toBe(201);
  }

  it('GET /boards/:board carries connectors + appearance — case:canvas-connector', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'i-1', x: 10, y: 10 }));
    await store.upsertBoardItem(boardItem({ id: 'i-2', x: 300, y: 10 }));
    const conn = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/connectors',
      headers: AUTH,
      payload: { workspace: WS, source_item_id: 'i-1', target_item_id: 'i-2' },
    });
    expect(conn.statusCode).toBe(201);
    expect(conn.json().connector.status).toBe('active');

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/ideas?workspace=ws',
      headers: AUTH,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().connectors).toHaveLength(1);
    // Drawing a connector never mutates the canonical `serves` edge.
    const item = await store.getBoardItem('i-1');
    expect(item?.serves).toBeNull();
    await app.close();
  });

  it('connector PATCH/DELETE with OCC — stale fence → 409', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'i-1' }));
    await store.upsertBoardItem(boardItem({ id: 'i-2' }));
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/connectors',
      headers: AUTH,
      payload: { workspace: WS, source_item_id: 'i-1', target_item_id: 'i-2' },
    });
    const conn = created.json().connector;

    const relabel = await app.inject({
      method: 'PATCH',
      url: `/api/v1/boards/ideas/connectors/${conn.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        label: 'depends on',
        expected_updated_at: conn.updated_at,
      },
    });
    expect(relabel.statusCode).toBe(200);
    expect(relabel.json().connector.label).toBe('depends on');

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/boards/ideas/connectors/${conn.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        label: 'stale',
        expected_updated_at: conn.updated_at,
      },
    });
    expect(stale.statusCode).toBe(409);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/boards/ideas/connectors/${conn.id}?workspace=ws`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().connector.status).toBe('superseded');
    // Superseded connectors drop out of the board projection.
    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/ideas?workspace=ws',
      headers: AUTH,
    });
    expect(get.json().connectors).toHaveLength(0);
    await app.close();
  });

  it('rejects connector to inactive item, self-loop, and duplicate', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'i-1' }));
    await store.upsertBoardItem(boardItem({ id: 'i-2', status: 'consumed' }));

    const inactive = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/connectors',
      headers: AUTH,
      payload: { workspace: WS, source_item_id: 'i-1', target_item_id: 'i-2' },
    });
    expect(inactive.statusCode).toBe(409);

    const selfLoop = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/connectors',
      headers: AUTH,
      payload: { workspace: WS, source_item_id: 'i-1', target_item_id: 'i-1' },
    });
    expect(selfLoop.statusCode).toBe(400);

    await store.upsertBoardItem(boardItem({ id: 'i-3' }));
    await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/connectors',
      headers: AUTH,
      payload: { workspace: WS, source_item_id: 'i-1', target_item_id: 'i-3' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/connectors',
      headers: AUTH,
      payload: { workspace: WS, source_item_id: 'i-1', target_item_id: 'i-3' },
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it('batch PATCH is atomic — one stale member fails the whole batch, case:canvas-batch-atomic', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'i-1', x: 0, y: 0 }));
    await store.upsertBoardItem(boardItem({ id: 'i-2', x: 50, y: 50 }));

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'i-1',
            expected_updated_at: '2026-10-05T00:00:00Z',
            patch: { x: 100, y: 100 },
          },
          {
            id: 'i-2',
            expected_updated_at: 'STALE-FENCE',
            patch: { x: 200, y: 200 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    // Atomicity — i-1 must not have moved.
    const item = await store.getBoardItem('i-1');
    expect(item?.x).toBe(0);
    expect(item?.updated_at).toBe('2026-10-05T00:00:00Z');
    await app.close();
  });

  it('batch PATCH refuses consumed/frozen members — case:canvas-locked', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(
      boardItem({ id: 'i-1', status: 'consumed', x: 0 }),
    );
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'i-1',
            expected_updated_at: '2026-10-05T00:00:00Z',
            patch: { x: 500 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('zone writes must reference a real active zone item — case:canvas-zone', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'zone-1', kind: 'zone' }));
    await store.upsertBoardItem(boardItem({ id: 'i-1' }));

    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'i-1',
            expected_updated_at: '2026-10-05T00:00:00Z',
            patch: { zone: 'zone-1' },
          },
        ],
      },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'i-1',
            expected_updated_at: ok.json().items[0].updated_at,
            patch: { zone: 'not-a-zone' },
          },
        ],
      },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('batch PATCH applies Easy Edit semantic fields — case:easy-edit-06', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'i-1' }));
    await store.upsertBoardItem(boardItem({ id: 'i-2' }));

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'i-1',
            expected_updated_at: '2026-10-05T00:00:00Z',
            patch: { note_kind: 'want', importance: 'must' },
          },
          {
            id: 'i-2',
            expected_updated_at: '2026-10-05T00:00:00Z',
            patch: { note_status: 'deferred', status: 'icebox' },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as BoardItem[];
    expect(items.find((i) => i.id === 'i-1')?.note_kind).toBe('want');
    expect(items.find((i) => i.id === 'i-1')?.importance).toBe('must');
    expect(items.find((i) => i.id === 'i-2')?.note_status).toBe('deferred');
    expect(items.find((i) => i.id === 'i-2')?.status).toBe('icebox');
    await app.close();
  });

  it('batch PATCH board:null moves to tray; other slugs 400 — case:easy-edit-06', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'i-1' }));

    const toTray = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'i-1',
            expected_updated_at: '2026-10-05T00:00:00Z',
            patch: { board: null },
          },
        ],
      },
    });
    expect(toTray.statusCode).toBe(200);
    const moved = await store.getBoardItem('i-1');
    expect(moved?.board).toBeNull();

    // Re-seed on the board, then attempt a cross-board move via batch.
    await store.upsertBoardItem(
      boardItem({ id: 'i-2', updated_at: '2026-10-05T00:00:00Z' }),
    );
    const cross = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'i-2',
            expected_updated_at: '2026-10-05T00:00:00Z',
            patch: { board: 'other-board' },
          },
        ],
      },
    });
    expect(cross.statusCode).toBe(400);
    const stayed = await store.getBoardItem('i-2');
    expect(stayed?.board).toBe('ideas');
    await app.close();
  });

  it('batch PATCH still refuses tray items and drawer-only fields — case:easy-edit-06', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'tray-1', board: null }));

    const tray = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'tray-1',
            expected_updated_at: '2026-10-05T00:00:00Z',
            patch: { board: 'ideas' },
          },
        ],
      },
    });
    expect(tray.statusCode).toBe(404);

    await store.upsertBoardItem(boardItem({ id: 'i-1' }));
    for (const patch of [
      { ref: 'https://example.com' },
      { kind: 'text' },
      { topic: 'x' },
      { serves: ['a'] },
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/boards/ideas/items',
        headers: AUTH,
        payload: {
          workspace: WS,
          mutations: [
            {
              id: 'i-1',
              expected_updated_at: '2026-10-05T00:00:00Z',
              patch,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it('image kind is refused and link refs must be http(s) — case:canvas-image-security', async () => {
    const app = makeServer();
    await seedBoard(app);

    const image = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: { workspace: WS, kind: 'image', ref: 'a-1' },
    });
    expect(image.statusCode).toBe(400);

    const badLink = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: { workspace: WS, kind: 'link', ref: 'javascript:alert(1)' },
    });
    expect(badLink.statusCode).toBe(400);

    const link = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        kind: 'link',
        ref: 'https://example.com/spec',
      },
    });
    expect(link.statusCode).toBe(201);

    // PATCH-side guard: retyping a note to image is refused too.
    const retype = await app.inject({
      method: 'PATCH',
      url: '/api/v1/board-items/i-1',
      headers: AUTH,
      payload: {
        workspace: WS,
        kind: 'image',
        expected_updated_at: 'x',
      },
    });
    // i-1 doesn't exist yet — create one first, then retype it.
    await store.upsertBoardItem(boardItem({ id: 'i-1' }));
    const retype2 = await app.inject({
      method: 'PATCH',
      url: '/api/v1/board-items/i-1',
      headers: AUTH,
      payload: {
        workspace: WS,
        kind: 'image',
        expected_updated_at: '2026-10-05T00:00:00Z',
      },
    });
    expect(retype.statusCode).toBe(404);
    expect(retype2.statusCode).toBe(400);
    await app.close();
  });

  it('opening a board writes nothing for unpositioned legacy items — case:canvas-legacy-layout', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(
      boardItem({ id: 'legacy-1', x: null, y: null }),
    );

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/ideas?workspace=ws',
      headers: AUTH,
    });
    expect(get.statusCode).toBe(200);
    const item = await store.getBoardItem('legacy-1');
    expect(item?.x).toBeNull();
    expect(item?.updated_at).toBe('2026-10-05T00:00:00Z');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// BOARD-CANVAS-TOOLS-TDD — annotations, votes, comment pins,
// presentation order
// ---------------------------------------------------------------------------

describe('board canvas tools', () => {
  async function seedBoard(app: ApiServer) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: AUTH,
      payload: { workspace: WS, board: 'ideas', board_type: 'exploration' },
    });
    expect(res.statusCode).toBe(201);
  }

  const stroke = {
    pts: [
      { x: 0, y: 0 },
      { x: 10, y: 4 },
      { x: 40, y: 8 },
    ],
  };

  it('comment pins persist as feedback items with position + ref — case:canvas-tools-03', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'target', x: 0, y: 0 }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        kind: 'feedback',
        note_kind: 'comment',
        ref: 'target',
        x: 220,
        y: 60,
        w: 44,
        h: 44,
      },
    });
    expect(res.statusCode).toBe(201);
    const pin = res.json().item;
    expect(pin.kind).toBe('feedback');
    expect(pin.note_kind).toBe('comment');
    expect(pin.ref).toBe('target');
    expect(pin.x).toBe(220);

    // Resolve archives via note_status — the row survives (never a
    // hard delete); a second client sees it in the board surface.
    const resolved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/board-items/${pin.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        expected_updated_at: pin.updated_at,
        note_status: 'resolved',
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().item.note_status).toBe('resolved');
    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/ideas?workspace=ws',
      headers: AUTH,
    });
    expect(
      get.json().items.some((s: { item: BoardItem }) => s.item.id === pin.id),
    ).toBe(true);
    await app.close();
  });

  it('vote sessions: open → stamp → re-stamp updates → close → 409 — case:canvas-tools-04', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(boardItem({ id: 'i-1', importance: 'must' }));

    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/vote-sessions',
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(opened.statusCode).toBe(201);
    const session = opened.json().session;
    expect(session.status).toBe('open');

    // A second open session on the same board is a conflict.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/vote-sessions',
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(dup.statusCode).toBe(409);

    const cast = await app.inject({
      method: 'PUT',
      url: '/api/v1/boards/ideas/votes',
      headers: AUTH,
      payload: {
        workspace: WS,
        session_id: session.id,
        item_id: 'i-1',
        stamp: 'up',
      },
    });
    expect(cast.statusCode).toBe(200);

    // Re-vote updates the same row — one vote per voter per session.
    const revote = await app.inject({
      method: 'PUT',
      url: '/api/v1/boards/ideas/votes',
      headers: AUTH,
      payload: {
        workspace: WS,
        session_id: session.id,
        item_id: 'i-1',
        stamp: 'down',
      },
    });
    expect(revote.statusCode).toBe(200);
    expect(revote.json().vote.stamp).toBe('down');
    const detail = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/ideas?workspace=ws',
      headers: AUTH,
    });
    expect(detail.json().votes).toHaveLength(1);

    // Voting never mutates importance.
    const item = await store.getBoardItem('i-1');
    expect(item?.importance).toBe('must');

    const closed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/boards/ideas/vote-sessions/${session.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        expected_updated_at: session.updated_at,
        status: 'closed',
      },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().session.status).toBe('closed');

    // Closed session → hard 409, server-enforced.
    const late = await app.inject({
      method: 'PUT',
      url: '/api/v1/boards/ideas/votes',
      headers: AUTH,
      payload: {
        workspace: WS,
        session_id: session.id,
        item_id: 'i-1',
        stamp: 'question',
      },
    });
    expect(late.statusCode).toBe(409);
    await app.close();
  });

  it('annotations: CRUD with OCC + fail-closed geometry — case:canvas-tools-06', async () => {
    const app = makeServer();
    await seedBoard(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/annotations',
      headers: AUTH,
      payload: { workspace: WS, kind: 'stroke', geometry: stroke },
    });
    expect(created.statusCode).toBe(201);
    const ann = created.json().annotation;

    // Persisted through a fresh board read (the reload path).
    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/ideas?workspace=ws',
      headers: AUTH,
    });
    expect(
      get.json().annotations.some((a: { id: string }) => a.id === ann.id),
    ).toBe(true);

    // OCC fence: a stale expected_updated_at → 409.
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/boards/ideas/annotations/${ann.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        expected_updated_at: '1970-01-01T00:00:00Z',
        color: 'blue',
      },
    });
    expect(stale.statusCode).toBe(409);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/boards/ideas/annotations/${ann.id}`,
      headers: AUTH,
      payload: {
        workspace: WS,
        expected_updated_at: ann.updated_at,
        color: 'blue',
      },
    });
    expect(patched.statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/boards/ideas/annotations/${ann.id}?workspace=ws`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/ideas?workspace=ws',
      headers: AUTH,
    });
    expect(after.json().annotations).toHaveLength(0);
    await app.close();
  });

  it('annotations reject bad kind, malformed + oversized geometry fail-closed — case:canvas-tools-06', async () => {
    const app = makeServer();
    await seedBoard(app);

    const badKind = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/annotations',
      headers: AUTH,
      payload: { workspace: WS, kind: 'scribble', geometry: stroke },
    });
    expect(badKind.statusCode).toBe(400);

    // Wrong geometry shape for the declared kind.
    const mismatched = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/annotations',
      headers: AUTH,
      payload: {
        workspace: WS,
        kind: 'rect',
        geometry: stroke,
      },
    });
    expect(mismatched.statusCode).toBe(400);

    // Degenerate stroke (single point).
    const degenerate = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/annotations',
      headers: AUTH,
      payload: {
        workspace: WS,
        kind: 'stroke',
        geometry: { pts: [{ x: 1, y: 1 }] },
      },
    });
    expect(degenerate.statusCode).toBe(400);

    // >2 000-point path — the cap rejects, it doesn't truncate.
    const tooLong = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/annotations',
      headers: AUTH,
      payload: {
        workspace: WS,
        kind: 'stroke',
        geometry: {
          pts: Array.from({ length: 2001 }, (_, i) => ({
            x: i,
            y: 0,
          })),
        },
      },
    });
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  });

  it('presentation_order persists on zones and refuses elsewhere — case:canvas-tools-05', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertBoardItem(
      boardItem({ id: 'z-1', kind: 'zone', x: 0, y: 0, w: 400, h: 300 }),
    );
    await store.upsertBoardItem(boardItem({ id: 'n-1' }));
    const z1 = await store.getBoardItem('z-1');
    const n1 = await store.getBoardItem('n-1');

    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'z-1',
            expected_updated_at: z1?.updated_at,
            patch: { presentation_order: 1 },
          },
        ],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items[0].presentation_order).toBe(1);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: {
        workspace: WS,
        mutations: [
          {
            id: 'n-1',
            expected_updated_at: n1?.updated_at,
            patch: { presentation_order: 2 },
          },
        ],
      },
    });
    expect(bad.statusCode).toBe(400);

    // Single-item PATCH honours it on zones too (inspector path).
    const z1b = await store.getBoardItem('z-1');
    const single = await app.inject({
      method: 'PATCH',
      url: '/api/v1/board-items/z-1',
      headers: AUTH,
      payload: {
        workspace: WS,
        expected_updated_at: z1b?.updated_at,
        presentation_order: 3,
      },
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().item.presentation_order).toBe(3);
    await app.close();
  });
});
