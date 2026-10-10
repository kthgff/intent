/**
 * wp-164 API tests — Board Assistant REST surface + OpenRouter
 * provider (BOARD-CHAT-TDD "REST surface" + contract amendment 4).
 *
 * fastify inject + PGlite only — `assistantFetch` stubs the provider
 * HTTP call; no test ever touches live OpenRouter. Covers:
 *   - `ui.board_chat` flag gating (flag off → no routes at all);
 *   - bearer auth on every route;
 *   - GET panel state is read-only (no session created on GET);
 *   - POST messages: `/interview` run, answer → proposals, freeform
 *     via the stub provider (incl. malformed → zero ops);
 *   - proposals accept/reject/batch over REST (OCC → 409 + stale);
 *   - SSE `board_proposal`/`interview_updated` after durable writes;
 *   - `resolveAssistantProvider`: allowlist, absent key, request shape.
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
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBoardAssistantRoutes } from '../src/board-assistant.js';
import { type ApiServer, createServer } from '../src/index.js';
import { resolveAssistantProvider } from '../src/openrouter.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';
const BOARD = 'b1';
const MODEL = 'qwen/qwen3-30b-a3b-instruct-2507';

let dir: string;
let store: PostgresStore;

interface CfgOpts {
  boardChat?: boolean;
  model?: string;
  key?: string;
}

function makeConfig(o: CfgOpts = {}) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      security: { scan_on_commit: false },
      ui: { board_chat: o.boardChat ?? true, idea_canvas_v2: true },
      ...(o.model
        ? {
            models: {
              assistant: { primary: o.model, providers: ['openrouter'] },
            },
          }
        : {}),
    },
    warnings: [],
    secrets: o.key ? { OPENROUTER_API_KEY: o.key } : {},
    files: [],
  });
}

function makeServer(o: CfgOpts & { fetchImpl?: typeof fetch }): ApiServer {
  const config = makeConfig(o);
  const deps: ConductorDeps = {
    store,
    adapters: {},
    config,
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir: join(dir, 'runs'),
    transitions: new StubTransitionHandler(),
  };
  return createServer({
    store,
    conductor: new Conductor(deps),
    config,
    uiToken: TOKEN,
    ...(o.fetchImpl ? { assistantFetch: o.fetchImpl } : {}),
  });
}

const post = (app: ApiServer, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: AUTH, payload });
const get = (app: ApiServer, url: string) =>
  app.inject({ method: 'GET', url, headers: AUTH });
const ws = { workspace: WS };

async function makeBoard(app: ApiServer) {
  const res = await post(app, '/api/v1/boards', {
    workspace: WS,
    board: BOARD,
    board_type: 'exploration',
  });
  expect(res.statusCode).toBe(201);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-api-assistant-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// flag + auth
// ---------------------------------------------------------------------------

describe('gate + auth', () => {
  it('ui.board_chat off → no assistant routes (404)', async () => {
    const app = makeServer({ boardChat: false });
    await makeBoard(app);
    const res = await get(
      app,
      `/api/v1/boards/${BOARD}/assistant?workspace=${WS}`,
    );
    expect(res.statusCode).toBe(404);
    const post_ = await post(
      app,
      `/api/v1/boards/${BOARD}/assistant/messages`,
      {
        ...ws,
        text: 'hi',
      },
    );
    expect(post_.statusCode).toBe(404);
    await app.close();
  });

  it('requires the bearer token', async () => {
    const app = makeServer({});
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/boards/${BOARD}/assistant?workspace=${WS}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET panel state (read-only)
// ---------------------------------------------------------------------------

describe('GET /assistant', () => {
  it('returns session:null, model:absent, skills+chips — and creates nothing', async () => {
    const app = makeServer({});
    await makeBoard(app);
    const res = await get(
      app,
      `/api/v1/boards/${BOARD}/assistant?workspace=${WS}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session).toBeNull();
    expect(body.model).toBe('absent');
    expect(body.messages).toEqual([]);
    expect(body.skills.map((s: { skill: string }) => s.skill)).toEqual([
      'interview',
      'expand',
      'critique',
    ]);
    expect(body.chips).toEqual([
      { id: 'interview', label: 'Run /interview', command: '/interview' },
    ]);
    // read-only: no thread session was materialized
    expect(await store.listInterviewSessions({ workspace: WS })).toHaveLength(
      0,
    );
    await app.close();
  });

  it('404s for an unknown board', async () => {
    const app = makeServer({});
    const res = await get(app, `/api/v1/boards/nope/assistant?workspace=${WS}`);
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST messages — the turn pipeline over HTTP
// ---------------------------------------------------------------------------

describe('POST /assistant/messages', () => {
  it('/interview starts a run and asks the goals question', async () => {
    const app = makeServer({});
    await makeBoard(app);
    const res = await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: '/interview',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pending_question).not.toBeNull();
    expect(body.pending_question.slot).toBe('goals');
    expect(
      body.messages.some((m: { role: string }) => m.role === 'assistant'),
    ).toBe(true);
    // user turn was recorded
    expect(
      body.messages.some(
        (m: { role: string; content: string }) =>
          m.role === 'user' && m.content === '/interview',
      ),
    ).toBe(true);
    await app.close();
  });

  it('answering the pending question drafts a pending proposal', async () => {
    const app = makeServer({});
    await makeBoard(app);
    await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: '/interview',
    });
    const res = await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: 'offline sync for field tablets',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposals.length).toBe(1);
    expect(body.proposals[0].op).toBe('create-item');
    expect(body.proposals[0].status).toBe('pending');
    // durable audit rows exist
    const events = await store.listEvents({ workspace: WS });
    expect(events.some((e) => e.event === 'proposal_created')).toBe(true);
    // /critique posts via appendThreadMessage → assistant_message event
    await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: '/critique',
    });
    const events2 = await store.listEvents({ workspace: WS });
    expect(events2.some((e) => e.event === 'assistant_message')).toBe(true);
    await app.close();
  });

  it('freeform text without a provider → fail-loud reply, zero proposals', async () => {
    const app = makeServer({});
    await makeBoard(app);
    const res = await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: 'add a sticky',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposals).toEqual([]);
    expect(body.messages.at(-1).content).toContain('No model is configured');
    await app.close();
  });

  it('zod-strict: empty text and foreign keys are 400', async () => {
    const app = makeServer({});
    await makeBoard(app);
    const empty = await post(
      app,
      `/api/v1/boards/${BOARD}/assistant/messages`,
      {
        ...ws,
        text: '',
      },
    );
    expect(empty.statusCode).toBe(400);
    const extra = await post(
      app,
      `/api/v1/boards/${BOARD}/assistant/messages`,
      {
        ...ws,
        text: 'hi',
        smuggled: true,
      },
    );
    expect(extra.statusCode).toBe(400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// provider-backed freeform (stub fetch — never live)
// ---------------------------------------------------------------------------

describe('provider-backed turns', () => {
  const stubFetch = (reply: unknown) => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    return fetchImpl;
  };

  it('valid provider output → ops drafted as proposals; model:configured', async () => {
    const fetchImpl = stubFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: 'added a problem card',
              ops: [
                {
                  op: 'create-item',
                  kind: 'note',
                  note_kind: 'problem',
                  title: 'imports crash',
                },
              ],
            }),
          },
        },
      ],
    });
    const app = makeServer({ model: MODEL, key: 'sk-test', fetchImpl });
    await makeBoard(app);
    const res = await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: 'add a problem card for imports crashing',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposals.length).toBe(1);
    expect(body.messages.at(-1).content).toBe('added a problem card');
    // the provider call carried the resolved model + bearer auth
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-test',
    );
    expect(JSON.parse(init?.body as string).model).toBe(MODEL);
    // panel now reports the model configured
    const state = (
      await get(app, `/api/v1/boards/${BOARD}/assistant?workspace=${WS}`)
    ).json();
    expect(state.model).toBe('configured');
    await app.close();
  });

  it('malformed provider output → zero ops + explanatory reply', async () => {
    const fetchImpl = stubFetch({
      choices: [{ message: { content: 'not json at all' } }],
    });
    const app = makeServer({ model: MODEL, key: 'sk-test', fetchImpl });
    await makeBoard(app);
    const res = await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: 'do something',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposals).toEqual([]);
    expect(body.messages.at(-1).content).toContain("couldn't shape");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// runs endpoints
// ---------------------------------------------------------------------------

describe('runs endpoints', () => {
  it('POST /runs + /runs/:branch/end round-trip', async () => {
    const app = makeServer({});
    await makeBoard(app);
    const start = await post(app, `/api/v1/boards/${BOARD}/assistant/runs`, {
      ...ws,
      skill: 'interview',
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().branch).toBe('run-1');
    expect(start.json().asked).not.toBeNull();

    const end = await post(
      app,
      `/api/v1/boards/${BOARD}/assistant/runs/run-1/end`,
      ws,
    );
    expect(end.statusCode).toBe(200);
    expect(end.json().summary).toContain('Coverage:');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// proposals endpoints
// ---------------------------------------------------------------------------

describe('proposals endpoints', () => {
  async function draftOne(app: ApiServer): Promise<string> {
    await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: '/interview',
    });
    const res = await post(app, `/api/v1/boards/${BOARD}/assistant/messages`, {
      ...ws,
      text: 'offline sync for field tablets',
    });
    const body = res.json();
    return body.proposals[0].proposal_id as string;
  }

  it('GET /proposals lists + ?status= filters; bad status 400s', async () => {
    const app = makeServer({});
    await makeBoard(app);
    const id = await draftOne(app);
    const all = (
      await get(app, `/api/v1/boards/${BOARD}/proposals?workspace=${WS}`)
    ).json();
    expect(
      all.proposals.map((p: { proposal_id: string }) => p.proposal_id),
    ).toContain(id);
    const pending = (
      await get(
        app,
        `/api/v1/boards/${BOARD}/proposals?workspace=${WS}&status=pending`,
      )
    ).json();
    expect(pending.proposals).toHaveLength(1);
    const bogus = await get(
      app,
      `/api/v1/boards/${BOARD}/proposals?workspace=${WS}&status=bogus`,
    );
    expect(bogus.statusCode).toBe(400);
    await app.close();
  });

  it('accept commits the item through legality; reject stamps the decision', async () => {
    const app = makeServer({});
    await makeBoard(app);
    const id = await draftOne(app);
    const acc = await post(
      app,
      `/api/v1/boards/${BOARD}/proposals/${id}/accept`,
      ws,
    );
    expect(acc.statusCode).toBe(200);
    expect(acc.json().proposal.status).toBe('accepted');
    expect(acc.json().items[0].provenance).toBe('inferred');
    const rej2 = await post(
      app,
      `/api/v1/boards/${BOARD}/proposals/${id}/reject`,
      ws,
    );
    expect(rej2.statusCode).toBe(409); // already decided
    const id2 = await draftOne(app);
    const rej = await post(
      app,
      `/api/v1/boards/${BOARD}/proposals/${id2}/reject`,
      { ...ws, reason: 'off-topic' },
    );
    expect(rej.statusCode).toBe(200);
    expect(rej.json().proposal.status).toBe('rejected');
    await app.close();
  });

  it('batch accept is atomic + OCC conflict → 409 and stale rows', async () => {
    const app = makeServer({});
    await makeBoard(app);
    const id = await draftOne(app);
    const batch = await post(app, `/api/v1/boards/${BOARD}/proposals/accept`, {
      ...ws,
      ids: [id],
    });
    expect(batch.statusCode).toBe(200);
    // replay → pending-set check fails
    const again = await post(app, `/api/v1/boards/${BOARD}/proposals/accept`, {
      ...ws,
      ids: [id],
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// SSE emission (bare fastify + notify spy)
// ---------------------------------------------------------------------------

describe('SSE emission', () => {
  it('mutations emit interview_updated + board_proposal post-write', async () => {
    const events: { type: string; payload: unknown }[] = [];
    const app = Fastify();
    registerBoardAssistantRoutes(app, {
      store,
      actor: 'test-bot',
      provider: undefined,
      model: null,
      workspace: (name) => ({ name, rootPath: dir }),
      notify: (e) => {
        events.push(e);
      },
    });
    const { createBoard } = await import('@veto/conductor');
    await createBoard(store, {
      workspace: WS,
      board: BOARD,
      board_type: 'exploration',
      actor: { id: 'test-bot', type: 'human' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/boards/${BOARD}/assistant/messages`,
      payload: { workspace: WS, text: '/interview' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/boards/${BOARD}/assistant/messages`,
      payload: { workspace: WS, text: 'offline sync for field tablets' },
    });
    const pid = res.json().proposals[0].proposal_id as string;
    expect(events.some((e) => e.type === 'interview_updated')).toBe(true);
    const prop = events.find((e) => e.type === 'board_proposal');
    expect(prop?.payload).toMatchObject({
      workspace: WS,
      board: BOARD,
      proposal_id: pid,
      status: 'pending',
    });
    // accept → resolved proposal event + item hint
    await app.inject({
      method: 'POST',
      url: `/api/v1/boards/${BOARD}/proposals/${pid}/accept`,
      payload: ws,
    });
    const resolved = events.filter((e) => e.type === 'board_proposal').at(-1);
    expect(resolved?.payload).toMatchObject({ status: 'accepted' });
    expect(
      events.some(
        (e) =>
          e.type === 'notification' &&
          (e.payload as { kind?: string }).kind === 'board_item_updated',
      ),
    ).toBe(true);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// resolveAssistantProvider (unit)
// ---------------------------------------------------------------------------

describe('resolveAssistantProvider', () => {
  it('missing key or model → provider undefined, model still resolved', () => {
    const noKey = resolveAssistantProvider({
      config: makeConfig({ model: MODEL }),
    });
    expect(noKey.provider).toBeUndefined();
    expect(noKey.model).toBe(MODEL);
    const noModel = resolveAssistantProvider({
      config: makeConfig({ key: 'sk' }),
    });
    expect(noModel.provider).toBeUndefined();
    const both = resolveAssistantProvider({
      config: makeConfig({ model: MODEL, key: 'sk' }),
    });
    expect(both.provider).toBeDefined();
    expect(both.route.latency_class).toBe('interactive');
  });

  it('providers allowlist excluding openrouter → throws at wiring', () => {
    const config = resolveConfig(null, {
      config: {
        actor: 'test-bot',
        backend: 'mock',
        models: {
          assistant: { primary: MODEL, providers: ['anthropic'] },
        },
      },
      warnings: [],
      secrets: { OPENROUTER_API_KEY: 'sk' },
      files: [],
    });
    expect(() => resolveAssistantProvider({ config })).toThrow(
      /allowlists providers/,
    );
  });

  it('non-2xx + missing content fail loudly', async () => {
    const errFetch = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch;
    const { provider } = resolveAssistantProvider({
      config: makeConfig({ model: MODEL, key: 'sk' }),
      fetchImpl: errFetch,
    });
    expect(provider).toBeDefined();
    await expect(
      provider?.converse([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/500/);
    const emptyFetch = (async () =>
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
      })) as typeof fetch;
    const { provider: p2 } = resolveAssistantProvider({
      config: makeConfig({ model: MODEL, key: 'sk' }),
      fetchImpl: emptyFetch,
    });
    expect(p2).toBeDefined();
    await expect(
      p2?.converse([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/content/);
  });
});
