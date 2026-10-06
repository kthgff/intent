/**
 * wp-111 /links route tests (D37 traceability edges).
 *
 * Covered: propose (source→verification semantics; a suggestion never
 * lands `verified`), list, and the human decide route — idempotent,
 * evented, OCC 409 on stale `expected`, and the stale-pin/unauthorized
 * guards that keep unverifiable evidence from landing `verified`.
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiServer,
  type ServerOptions,
  createServer,
} from '../src/index.js';

const TOKEN = 'b'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';
const SHA = 'a'.repeat(40);

let dir: string;
let repoDir: string;
let store: PostgresStore;

function makeConfig() {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      security: { scan_on_commit: false },
      semantic: { embeddings: 'off' },
      repos: { api: { path: repoDir } },
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

async function seedTicket(id: string, repos: string[]): Promise<void> {
  const ts = '2026-10-05T00:00:00Z';
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `${id} title`,
    status: 'in-progress',
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos,
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
}

/** Propose a suggested edge through the API (the fixture edge the
 *  decide tests act on). */
async function suggest(
  app: ApiServer,
  object = 'doc:SR-L1:rs.md',
  subject = 'SR-L1',
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/links',
    headers: AUTH,
    payload: {
      workspace: WS,
      subject,
      predicate: 'implements',
      object,
      source: 'model',
      confidence: 0.4,
    },
  });
  return res;
}

function decide(app: ApiServer, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/links/decide',
    headers: AUTH,
    payload: { workspace: WS, ...body },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-links-'));
  repoDir = join(dir, 'api-repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir });
  writeFileSync(`${repoDir}/a.ts`, 'export const a = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repoDir });
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /links — propose (D37 provenance)', () => {
  it('model proposals land suggested/auto-verified, explicit lands verified', async () => {
    const app = makeServer();
    const low = await suggest(app);
    expect(low.statusCode).toBe(201);
    expect(
      (low.json() as { relation: { verification: string } }).relation
        .verification,
    ).toBe('suggested');

    const high = await app.inject({
      method: 'POST',
      url: '/api/v1/links',
      headers: AUTH,
      payload: {
        workspace: WS,
        subject: 'SR-L1',
        predicate: 'documents',
        object: 'doc:SR-L1:tdd.md',
        source: 'tool',
        confidence: 0.99,
      },
    });
    expect(
      (high.json() as { relation: { verification: string } }).relation
        .verification,
    ).toBe('auto-verified');

    const expl = await app.inject({
      method: 'POST',
      url: '/api/v1/links',
      headers: AUTH,
      payload: {
        workspace: WS,
        subject: 'SR-L1',
        predicate: 'tests',
        object: 'doc:SR-L1:vs.md',
        source: 'explicit',
      },
    });
    expect(
      (expl.json() as { relation: { verification: string } }).relation
        .verification,
    ).toBe('verified');
    await app.close();
  });

  it('is idempotent — a duplicate proposal returns the stored edge (200)', async () => {
    const app = makeServer();
    await suggest(app);
    const dup = await suggest(app);
    expect(dup.statusCode).toBe(200);
    await app.close();
  });

  it('an inferred link without confidence is a 400, never a guess', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/links',
      headers: AUTH,
      payload: {
        workspace: WS,
        subject: 'SR-L1',
        predicate: 'implements',
        object: 'doc:SR-L1:rs.md',
        source: 'model',
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /links', () => {
  it('lists edges for a subject with provenance + verification', async () => {
    const app = makeServer();
    await suggest(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/links?workspace=${WS}&subject=SR-L1`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const { relations } = res.json() as {
      relations: {
        subject: string;
        predicate: string;
        object: string;
        source: string;
        confidence: number;
        verification: string;
      }[];
    };
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      source: 'model',
      confidence: 0.4,
      verification: 'suggested',
    });
    await app.close();
  });

  it('ticket-scoped read — subject=SR-L1 also returns SR-L1:ac:* edges', async () => {
    const app = makeServer();
    await suggest(app, 'doc:SR-L1:ac.md', 'SR-L1:ac:AC-1');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/links?workspace=${WS}&subject=SR-L1`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const { relations } = res.json() as { relations: { subject: string }[] };
    expect(relations.map((r) => r.subject)).toContain('SR-L1:ac:AC-1');
    await app.close();
  });
});

describe('POST /links/decide — human verify/reject', () => {
  it('verify is evented + idempotent; a stale expected loses 409', async () => {
    const app = makeServer();
    await suggest(app);

    const ok = await decide(app, {
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      action: 'verify',
      expected: 'suggested',
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (ok.json() as { relation: { verification: string } }).relation
        .verification,
    ).toBe('verified');

    // One link_verified event in the ledger.
    const evs = await store.listEvents({ workspace: WS });
    expect(evs.filter((e) => e.event === 'link_verified')).toHaveLength(1);

    // A stale-page reject (still thinks it's `suggested`) → 409, no event.
    const stale = await decide(app, {
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      action: 'reject',
      expected: 'suggested',
    });
    expect(stale.statusCode).toBe(409);
    const evs2 = await store.listEvents({ workspace: WS });
    expect(evs2.filter((e) => e.event === 'link_rejected')).toHaveLength(0);
    await app.close();
  });

  it('repeat reject against the terminal state is a 200 noop', async () => {
    const app = makeServer();
    await suggest(app);
    const body = {
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      action: 'reject',
      expected: 'suggested',
    };
    expect((await decide(app, body)).statusCode).toBe(200);
    expect((await decide(app, body)).statusCode).toBe(200);
    const evs = await store.listEvents({ workspace: WS });
    expect(evs.filter((e) => e.event === 'link_rejected')).toHaveLength(1);
    await app.close();
  });

  it('404 on a missing edge', async () => {
    const app = makeServer();
    const res = await decide(app, {
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:nowhere',
      action: 'verify',
      expected: 'suggested',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /links/decide — stale/unauthorized evidence guards', () => {
  it('a superseded index-head pin cannot verify (409); out-of-scope repo 403', async () => {
    const app = makeServer();
    await seedTicket('SR-L1', ['api']);

    // Index head is SHA; a pin to a DIFFERENT commit is stale.
    await store.upsertRepoIndex({
      workspace: WS,
      repo: 'api',
      commit_sha: SHA,
      status: 'current',
      parser_version: 'test',
      indexed_at: '2026-10-05T00:00:00Z',
      stats: {},
    });
    const stalePin = `code:api:${'c'.repeat(40)}:a.ts:a`;
    await suggest(app, stalePin);
    const stale = await decide(app, {
      subject: 'SR-L1',
      predicate: 'implements',
      object: stalePin,
      action: 'verify',
      expected: 'suggested',
    });
    expect(stale.statusCode).toBe(409);

    // A pin to a repo outside the ticket's scope is forbidden.
    const outside = `code:ghost:${SHA}:x.ts:y`;
    await suggest(app, outside);
    const denied = await decide(app, {
      subject: 'SR-L1',
      predicate: 'implements',
      object: outside,
      action: 'verify',
      expected: 'suggested',
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});
