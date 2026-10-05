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
} from '@sprint-runner/conductor';
import { resolveConfig } from '@sprint-runner/config';
import type { BoardItem, GateItem, TicketRow } from '@sprint-runner/core';
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
  dir = mkdtempSync(join(tmpdir(), 'sr-api-board-'));
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
