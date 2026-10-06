/**
 * wp-158 API leg — the discovery vertical over HTTP (PRD §15.3).
 *
 * The engine-level vertical lives in
 * `packages/conductor/test/e2e/discovery.test.ts`; this file proves the
 * same seams at the wire boundary: typed-note seeding, the board →
 * statements extraction handoff (with the fail-closed verbatim gate
 * enforced at ingest — nothing persists on a bad batch), the
 * statement-derived per-item surface, and the deferred-board resurface
 * as an approval-required proposal.
 *
 * fastify inject only, no real port. Bearer auth on every route.
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

async function seedBoard(app: ApiServer) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/boards',
    headers: AUTH,
    payload: {
      workspace: WS,
      board: 'ideas',
      name: 'Discovery',
      board_type: 'new-project',
      status: 'discovery',
    },
  });
  expect(res.statusCode).toBe(201);
}

async function addNote(
  app: ApiServer,
  payload: Record<string, unknown>,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/boards/ideas/items',
    headers: AUTH,
    payload: { workspace: WS, ...payload },
  });
  expect(res.statusCode).toBe(201);
  return (res.json().item as { id: string }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-api-discovery-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('discovery vertical over HTTP (wp-158)', () => {
  it('seeds typed notes → extracts statements with provenance → per-item surface', async () => {
    const app = makeServer();
    await seedBoard(app);

    // One note per taxonomy kind — the board accepts the full set.
    const ids: Record<string, string> = {};
    for (const [kind, note] of Object.entries({
      idea: { title: 'Self-serve password resets' },
      want: { title: 'Admins need an audit trail' },
      avoid: { title: 'No emailed plaintext passwords' },
      problem: {
        title: 'Password resets take 3 days',
        body: 'We must cut that to under an hour.',
      },
      constraint: {
        title: 'Postgres only',
        body: 'All data must stay in Postgres.',
        importance: 'must',
      },
      question: { title: 'Session expiry on reset?' },
      decision: { title: 'Admins approve bulk resets' },
      feedback: { title: 'Users find the flow confusing' },
    })) {
      ids[kind] = await addNote(app, { note_kind: kind, ...note });
    }
    expect(Object.keys(ids)).toHaveLength(8);

    // Unknown note kinds fail closed at the wire.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/items',
      headers: AUTH,
      payload: { workspace: WS, note_kind: 'vibe' },
    });
    expect(bad.statusCode).toBe(400);

    // The extraction handoff — what the `extract` agent stage's
    // statements.json would look like for these sources. Board items
    // come back ordered by id; `source` indexes that order.
    const listed = await store.listBoardItems({
      workspace: WS,
      board: 'ideas',
    });
    const srcIdx = new Map(listed.map((i, x) => [i.id, x]));
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
              text: 'Password resets take three days',
              source: srcIdx.get(ids.problem),
              source_text: 'Password resets take 3 days',
              intent: 'problem',
              subject: 'password-reset',
            },
            {
              key: 'sla',
              text: 'Resets must complete in under an hour',
              source: srcIdx.get(ids.problem),
              source_text: 'We must cut that to under an hour.',
              intent: 'requires',
              strength: 'must',
              subject: 'password-reset',
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as {
      statements: {
        statement_id: string;
        status: string;
        provenance: string;
      }[];
      byItem: Record<string, string[]>;
      decisions: string[];
    };
    expect(result.statements).toHaveLength(2);
    // AI proposes; humans confirm — nothing lands confirmed.
    for (const s of result.statements) {
      expect(s.status).toBe('proposed');
      expect(s.provenance).toBe('source-backed');
    }
    expect(result.byItem[ids.problem as string]).toHaveLength(2);
    // The `requires`+must statement opens a confirmation decision item.
    expect(result.decisions).toHaveLength(1);

    const surface = await app.inject({
      method: 'GET',
      url: `/api/v1/board-items/${ids.problem}/statements?workspace=${WS}`,
      headers: AUTH,
    });
    expect(surface.statusCode).toBe(200);
    expect(surface.json().statements).toHaveLength(2);

    await app.close();
  });

  it('fails closed on a paraphrased binding statement — nothing persists', async () => {
    const app = makeServer();
    await seedBoard(app);
    const noteId = await addNote(app, {
      note_kind: 'constraint',
      title: 'Postgres only',
      body: 'All data must stay in Postgres.',
      importance: 'must',
    });
    const items = await store.listBoardItems({
      workspace: WS,
      board: 'ideas',
    });
    const srcIdx = items.findIndex((i) => i.id === noteId);

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
              key: 'bad',
              text: 'All data lives in Postgres',
              source: srcIdx,
              source_text: 'All data lives in Postgres.', // paraphrase
              intent: 'constraint',
              strength: 'must',
            },
          ],
        },
      },
    });
    // Fail-closed at ingest — an error, and zero ledger writes.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await store.listStatements({ workspace: WS })).toHaveLength(0);
    expect(
      await store.listStatementDecisions({ workspace: WS, status: 'open' }),
    ).toHaveLength(0);

    await app.close();
  });

  it('deferred board resurfaces as a proposal; human accept re-enters discovery', async () => {
    const app = makeServer();
    await seedBoard(app);
    await addNote(app, {
      note_kind: 'idea',
      title: 'Offline mode',
      body: 'The app works without a network connection.',
    });

    const deferred = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/status',
      headers: AUTH,
      payload: { workspace: WS, status: 'deferred' },
    });
    expect(deferred.statusCode).toBe(200);
    expect(deferred.json().board.status).toBe('deferred');

    const proposed = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/resurface',
      headers: AUTH,
      payload: { workspace: WS, reason: 'offline demand in feedback' },
    });
    expect(proposed.statusCode).toBe(200);
    const proposal = proposed.json().proposal as {
      requires_approval: boolean;
      retained_items: number;
      proposed_by: string;
    };
    expect(proposal.requires_approval).toBe(true);
    expect(proposal.retained_items).toBe(1);
    // Read-only — the board is still deferred until a human accepts.
    expect((await store.getBoard(WS, 'ideas'))?.status).toBe('deferred');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/resurface/accept',
      headers: AUTH,
      payload: { workspace: WS },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().board.status).toBe('discovery');
    // Evidence retained through the defer/resurface round trip.
    expect(
      (await store.listBoardItems({ workspace: WS, board: 'ideas' })).length,
    ).toBe(1);

    await app.close();
  });

  it('routes a board change request on an approved doc to a pinned ChangeSet', async () => {
    const app = makeServer();
    await seedBoard(app);
    await store.upsertProject({ workspace: WS });
    await store.appendDocVersion(
      { workspace: WS, subject: 'I-0001', doc: 'rs.md' },
      '# RS v1',
      'human',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/boards/ideas/reference',
      headers: AUTH,
      payload: {
        workspace: WS,
        subject: 'I-0001',
        doc: 'rs.md',
        request: 'Add session expiry on reset',
      },
    });
    expect(res.statusCode).toBe(201);
    const cs = res.json().changeset as {
      changeset_id: string;
      status: string;
      baseline: { subject: string; doc: string; version: number };
    };
    expect(cs.changeset_id).toMatch(/^CS-\d{4}$/);
    expect(cs.status).toBe('draft');
    // The baseline pins the approved head — never "latest".
    expect(cs.baseline).toEqual({
      subject: 'I-0001',
      doc: 'rs.md',
      version: 1,
    });
    // The approved doc was never mutated by the request.
    expect(
      await store.listDocVersions({
        workspace: WS,
        subject: 'I-0001',
        doc: 'rs.md',
      }),
    ).toHaveLength(1);

    await app.close();
  });
});
