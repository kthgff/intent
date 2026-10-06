/**
 * wp-110 evidence + repository-index route tests (D37).
 * Real git fixture checkout for POST /repositories/<repo>/index;
 * PGlite for everything else.
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-evidence-'));
  repoDir = join(dir, 'api-repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir });
  writeFileSync(
    join(repoDir, 'prefs.ts'),
    'export function savePreferences(userId: string) {\n  return userId;\n}\n',
  );
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repoDir });
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /evidence/search (D37)', () => {
  it('rejects repos outside the configured scope — never silently intersected', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/evidence/search',
      headers: AUTH,
      payload: { workspace: WS, query: 'savePreferences', repos: ['secrets'] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns a valid retrieval-evidence bundle (zero-result is explicit)', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/evidence/search',
      headers: AUTH,
      payload: { workspace: WS, query: 'savePreferences' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      schema: number;
      results: unknown[];
      zero_result_reason: string | null;
    };
    expect(body.schema).toBe(1);
    expect(body.results).toHaveLength(0);
    expect(body.zero_result_reason).toBeTruthy();
    await app.close();
  });
});

describe('repositories/<repo>/index (D37)', () => {
  it('GET returns heads (empty before any index run)', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/repositories/${WS}/api/index`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { heads: unknown[] }).heads).toHaveLength(0);
    await app.close();
  });

  it('POST indexes the configured checkout at HEAD, promotes a current head', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/repositories/${WS}/api/index`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      repoIndex: { commit_sha: string; status: string };
      stats: { units: number };
    };
    expect(body.repoIndex.status).toBe('current');
    expect(body.stats.units).toBeGreaterThan(0);

    // The head is now servable through GET + search.
    const heads = await app.inject({
      method: 'GET',
      url: `/api/v1/repositories/${WS}/api/index`,
      headers: AUTH,
    });
    expect(
      (heads.json() as { current: { commit_sha: string } }).current.commit_sha,
    ).toBe(body.repoIndex.commit_sha);

    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/evidence/search',
      headers: AUTH,
      payload: { workspace: WS, query: 'savePreferences' },
    });
    const hit = (
      search.json() as {
        results: { path: string; commit_sha: string }[];
      }
    ).results.find((r) => r.path === 'prefs.ts');
    expect(hit).toBeDefined();
    expect(hit?.commit_sha).toBe(body.repoIndex.commit_sha);
    await app.close();
  });

  it('POST 404s on an unconfigured repo — never a client-supplied path', async () => {
    const app = makeServer();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/repositories/${WS}/nope/index`,
      headers: AUTH,
      payload: { path: '/etc' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /evidence/source (wp-111 — navigable pinned citations)', () => {
  async function indexHead(app: ApiServer): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/repositories/${WS}/api/index`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { repoIndex: { commit_sha: string } }).repoIndex
      .commit_sha;
  }

  it('resolves a code: citation to the pinned unit, labeled current', async () => {
    const app = makeServer();
    const sha = await indexHead(app);
    const res = await app.inject({
      method: 'GET',
      url:
        `/api/v1/evidence/source?workspace=${WS}` +
        `&ref=code:api:${sha}:prefs.ts:savePreferences`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      repo: string;
      commit_sha: string;
      path: string;
      freshness: string;
      current_head: string;
      unit: { symbol: string; content: string; start_line: number };
    };
    expect(body).toMatchObject({
      repo: 'api',
      commit_sha: sha,
      path: 'prefs.ts',
      freshness: 'current',
      current_head: sha,
    });
    expect(body.unit.symbol).toBe('savePreferences');
    expect(body.unit.content).toContain('savePreferences');
    await app.close();
  });

  it('a superseded pin is labeled stale, never current', async () => {
    const app = makeServer();
    const sha1 = await indexHead(app);
    // Advance the head — the sha1 citation must now render stale.
    writeFileSync(
      join(repoDir, 'prefs.ts'),
      'export function savePreferences(u: string) {\n  return `${u}!`;\n}\n',
    );
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync('git', ['commit', '-qm', 'advance'], { cwd: repoDir });
    const sha2 = await indexHead(app);
    expect(sha2).not.toBe(sha1);

    const res = await app.inject({
      method: 'GET',
      url:
        `/api/v1/evidence/source?workspace=${WS}` +
        `&ref=code:api:${sha1}:prefs.ts:savePreferences`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      freshness: string;
      current_head: string;
    };
    expect(body.freshness).toBe('stale');
    expect(body.current_head).toBe(sha2);
    await app.close();
  });

  it('fail-closed: 400 unparseable · 403 unconfigured repo · 404 missing unit', async () => {
    const app = makeServer();
    const sha = await indexHead(app);

    const bad = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/source?workspace=${WS}&ref=not-a-ref`,
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(400);

    const forbidden = await app.inject({
      method: 'GET',
      url:
        `/api/v1/evidence/source?workspace=${WS}` +
        `&ref=code:nope:${sha}:prefs.ts:savePreferences`,
      headers: AUTH,
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'GET',
      url:
        `/api/v1/evidence/source?workspace=${WS}` +
        `&ref=code:api:${sha}:absent.ts:ghost`,
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
