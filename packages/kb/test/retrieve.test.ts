import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RetrievalRequest } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codeContentRef,
  evaluateGoldenSet,
  indexRepo,
  queryEvidence,
  resolveCodeHeads,
} from '../src/index.js';
import type { Embedder } from '../src/index.js';

let dir: string;
let repoDir: string;
let store: PostgresStore;

const WS = 'ws-a';
const REPO = 'api';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-kb-retrieve-'));
  repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  store = await PostgresStore.connect('pglite:');
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Two-commit git fixture
// ---------------------------------------------------------------------------

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir }).toString().trim();
}

function commitAll(msg: string): string {
  git('add', '-A');
  git('commit', '-qm', msg);
  return git('rev-parse', 'HEAD');
}

/** Commit 1: prefs + notify + legacy + a test file + an unsupported file. */
function writeCommitOne(): void {
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  mkdirSync(join(repoDir, 'data'), { recursive: true });
  writeFileSync(
    join(repoDir, 'src/prefs.ts'),
    [
      "import { persist } from './store';",
      '',
      'export function savePreferences(userId: string) {',
      '  return persist(userId);',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repoDir, 'src/store.ts'),
    [
      'export function persist(userId: string) {',
      '  return userId;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repoDir, 'src/notify.ts'),
    [
      'export function notifyUser(user: string) {',
      '  // push notification preferences to the channel',
      '  return user;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repoDir, 'src/legacy.ts'),
    'export function legacyHelper() { return 1; }\n',
  );
  writeFileSync(
    join(repoDir, 'tests/prefs.test.ts'),
    // Namespace import + no identifier use — the test file carries a
    // `tests` edge to src/prefs but never contains `savePreferences`,
    // so a 'savePreferences' query can only reach it structurally.
    [
      "import * as prefs from '../src/prefs';",
      '',
      'export function exercisePrefs() {',
      '  return prefs;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repoDir, 'data/notes.txt'),
    'plain text notes — no symbols here, only prose.\n',
  );
}

/** Commit 2: prefs gains a symbol, legacy.ts is deleted, audit.ts added. */
function writeCommitTwo(): void {
  writeFileSync(
    join(repoDir, 'src/prefs.ts'),
    [
      "import { persist } from './store';",
      '',
      'export function savePreferences(userId: string) {',
      '  return persist(userId);',
      '}',
      '',
      'export function resetPreferences(userId: string) {',
      '  return persist(userId);',
      '}',
      '',
    ].join('\n'),
  );
  rmSync(join(repoDir, 'src/legacy.ts'));
  writeFileSync(
    join(repoDir, 'src/audit.ts'),
    'export function auditLog(msg: string) { return msg; }\n',
  );
}

async function indexHead(sha: string, workspace = WS): Promise<void> {
  await indexRepo(store, {
    workspace,
    repo: REPO,
    checkoutDir: repoDir,
    commitSha: sha,
  });
}

/** Build the two-commit fixture and index both heads. */
async function buildFixture(): Promise<{ sha1: string; sha2: string }> {
  git('init', '-qb', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  writeCommitOne();
  const sha1 = commitAll('c1');
  await indexHead(sha1);
  writeCommitTwo();
  const sha2 = commitAll('c2');
  await indexHead(sha2);
  return { sha1, sha2 };
}

function req(
  query: string,
  over: Partial<RetrievalRequest> = {},
): RetrievalRequest {
  return {
    workspace: WS,
    task: 'implement',
    query,
    repos: [REPO],
    source_types: ['code'],
    commit_policy: 'current',
    limit: 20,
    token_limit: 8000,
    ...over,
  } as RetrievalRequest;
}

const ACL = [REPO];

// ---------------------------------------------------------------------------

describe('indexRepo — two-commit lifecycle', () => {
  it('promotes heads atomically, reuses unchanged files, drops deleted paths', async () => {
    const { sha1, sha2 } = await buildFixture();

    const c1 = await store.getRepoIndex({
      workspace: WS,
      repo: REPO,
      commit_sha: sha1,
    });
    expect(c1?.status).toBe('superseded');
    const c2 = await store.getRepoIndex({
      workspace: WS,
      repo: REPO,
      commit_sha: sha2,
    });
    expect(c2?.status).toBe('current');
    expect((await store.getCurrentRepoIndex(WS, REPO))?.commit_sha).toBe(sha2);

    // Unchanged file reused by content hash — notify.ts was not re-parsed.
    const stats = c2?.stats as { reused_files?: number; units?: number };
    expect(stats.reused_files).toBeGreaterThanOrEqual(1);
    expect(stats.units).toBeGreaterThan(0);

    // Deleted path has no units at the new head, but its historical
    // units remain addressable at the superseded commit (audit).
    const legacyNow = await store.listCodeUnits({
      workspace: WS,
      repo: REPO,
      commit_sha: sha2,
      path: 'src/legacy.ts',
    });
    expect(legacyNow).toHaveLength(0);
    const legacyThen = await store.listCodeUnits({
      workspace: WS,
      repo: REPO,
      commit_sha: sha1,
      path: 'src/legacy.ts',
    });
    expect(legacyThen.length).toBeGreaterThan(0);
    expect(legacyThen[0]?.symbol).toBe('legacyHelper');

    // Symbol-boundary units + bounded fallback for the .txt file.
    const prefs = await store.listCodeUnits({
      workspace: WS,
      repo: REPO,
      commit_sha: sha2,
      path: 'src/prefs.ts',
    });
    expect(prefs.map((u) => u.symbol)).toEqual(
      expect.arrayContaining(['savePreferences', 'resetPreferences']),
    );
    const notes = await store.listCodeUnits({
      workspace: WS,
      repo: REPO,
      commit_sha: sha2,
      path: 'data/notes.txt',
    });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((u) => u.parse_status === 'fallback')).toBe(true);
  });

  it('marks a failed index failed and never serves it as current', async () => {
    git('init', '-qb', 'main');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    writeCommitOne();
    const sha1 = commitAll('c1');
    await indexHead(sha1);

    // Force a mid-index write failure — the head must flip to `failed`
    // and the previous `current` head keeps serving (never partial).
    const failing = Object.create(store) as PostgresStore;
    failing.upsertCodeUnits = () =>
      Promise.reject(new Error('injected write failure'));
    await expect(
      indexRepo(failing, {
        workspace: WS,
        repo: REPO,
        checkoutDir: repoDir,
        commitSha: 'deadbeef',
      }),
    ).rejects.toThrow('injected write failure');

    const dead = await store.getRepoIndex({
      workspace: WS,
      repo: REPO,
      commit_sha: 'deadbeef',
    });
    expect(dead?.status).toBe('failed');
    const heads = await resolveCodeHeads(store, {
      workspace: WS,
      repos: [REPO],
      commitPolicy: 'current',
    });
    expect(heads[0]?.commit_sha).toBe(sha1);
    expect(
      await store.listRepoIndexes({
        workspace: WS,
        repo: REPO,
        status: 'current',
      }),
    ).toHaveLength(1);
  });
});

describe('queryEvidence — hybrid retrieval', () => {
  it('exact symbol match is cited, scored, and explained', async () => {
    await buildFixture();
    const bundle = await queryEvidence(store, req('savePreferences'), {
      authorizedRepos: ACL,
    });
    expect(bundle.results.length).toBeGreaterThan(0);
    const hit = bundle.results.find((r) => r.symbol === 'savePreferences');
    expect(hit).toBeDefined();
    expect(hit?.scores.exact).toBe(1);
    expect(hit?.why).toContain('exact-symbol');
    // Full citation per SCHEMAS §17.
    expect(hit?.repo).toBe(REPO);
    expect(hit?.commit_sha).toBe(bundle.index_heads[0]?.commit_sha);
    expect(hit?.path).toBe('src/prefs.ts');
    expect(hit?.start_line).toBeGreaterThan(0);
    expect(hit?.end_line).toBeGreaterThanOrEqual(hit?.start_line ?? 0);
    expect(hit?.content_hash).toMatch(/^sha256:/);
    expect(hit?.freshness).toBe('current');
    expect(hit?.object_ref).toContain(`code:${REPO}:`);
    expect(hit?.evidence_id).toMatch(/^ev_/);
    expect(bundle.zero_result_reason).toBeFalsy();
  });

  it('FTS phrase surfaces the matching unit with an fts score', async () => {
    await buildFixture();
    const bundle = await queryEvidence(store, req('notification preferences'), {
      authorizedRepos: ACL,
    });
    const hit = bundle.results.find((r) => r.path === 'src/notify.ts');
    expect(hit).toBeDefined();
    expect(hit?.scores.fts).toBeDefined();
    expect(hit?.why).toContain('fts');
  });

  it('structural expansion surfaces the test neighbor', async () => {
    await buildFixture();
    const bundle = await queryEvidence(store, req('savePreferences'), {
      authorizedRepos: ACL,
    });
    const neighbor = bundle.results.find(
      (r) => r.path === 'tests/prefs.test.ts',
    );
    expect(neighbor).toBeDefined();
    expect(neighbor?.scores.structural).toBeDefined();
    expect(neighbor?.why.some((w) => w.startsWith('structural:'))).toBe(true);
  });

  it('zero results is a valid explicit artifact, not an error', async () => {
    await buildFixture();
    const bundle = await queryEvidence(store, req('qqqzzz-nomatch'), {
      authorizedRepos: ACL,
    });
    expect(bundle.results).toHaveLength(0);
    expect(bundle.zero_result_reason).toBeTruthy();
    expect(bundle.schema).toBe(1);
  });

  it('embeddings off degrades to exact/FTS/structural with no error', async () => {
    await buildFixture();
    const off: Embedder = { model: 'none', dims: 0, embed: async () => null };
    const bundle = await queryEvidence(store, req('savePreferences'), {
      authorizedRepos: ACL,
      embedder: off,
    });
    expect(bundle.results.length).toBeGreaterThan(0);
    expect(bundle.results.every((r) => r.scores.semantic === undefined)).toBe(
      true,
    );
    expect(
      bundle.results.find((r) => r.symbol === 'savePreferences'),
    ).toBeDefined();
  });

  it('semantic candidates map embeddings back to authorized rows', async () => {
    // Index with a stub embedder so units get content-addressed vectors.
    git('init', '-qb', 'main');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    writeCommitOne();
    const sha = commitAll('c1');
    const stub: Embedder = {
      model: 'test-model',
      dims: 3,
      embed: async () => new Float32Array([1, 0, 0]),
    };
    await indexRepo(store, {
      workspace: WS,
      repo: REPO,
      checkoutDir: repoDir,
      commitSha: sha,
      embedder: stub,
    });
    // The embedder rows exist keyed by content hash.
    const units = await store.listCodeUnits({
      workspace: WS,
      repo: REPO,
      commit_sha: sha,
    });
    const embedded = await store.getEmbedding({
      object_ref: codeContentRef(units[0]?.content_hash ?? ''),
      model: 'test-model',
    });
    expect(embedded).not.toBeNull();

    // A query that only the semantic strategy can answer (no lexical
    // overlap, not an identifier): the stub vector matches every unit.
    const bundle = await queryEvidence(store, req('zzzqqq-nothing-lexical'), {
      authorizedRepos: ACL,
      embedder: stub,
    });
    expect(bundle.results.length).toBeGreaterThan(0);
    expect(bundle.results.every((r) => r.scores.semantic !== undefined)).toBe(
      true,
    );
    expect(bundle.results.every((r) => r.why.includes('semantic'))).toBe(true);
  });
});

describe('queryEvidence — authorization', () => {
  it('two workspaces with similar code never cross rows', async () => {
    const { sha2 } = await buildFixture();
    // ws-b indexes deliberately similar code (same checkout).
    await indexHead(sha2, 'ws-b');
    const bundle = await queryEvidence(store, req('savePreferences'), {
      authorizedRepos: ACL,
    });
    expect(bundle.results.length).toBeGreaterThan(0);
    for (const r of bundle.results) {
      expect(r.repo).toBe(REPO);
      expect(r.commit_sha).toBe(sha2);
    }
    // ws-b's identical symbol is invisible to ws-a's workspace scope.
    const wsB = await queryEvidence(
      store,
      req('savePreferences', { workspace: 'ws-b' }),
      {
        authorizedRepos: ACL,
      },
    );
    for (const r of wsB.results) expect(r.repo).toBe(REPO);
  });

  it('a repo outside the authorized set contributes nothing', async () => {
    await buildFixture();
    // A second repo in the same workspace with the same symbol.
    const otherDir = join(dir, 'secret');
    mkdirSync(join(otherDir, 'src'), { recursive: true });
    writeFileSync(
      join(otherDir, 'src/prefs.ts'),
      'export function savePreferences() { return 42; }\n',
    );
    await indexRepo(store, {
      workspace: WS,
      repo: 'secret',
      checkoutDir: otherDir,
      commitSha: 's1',
    });
    const bundle = await queryEvidence(store, req('savePreferences'), {
      authorizedRepos: ['api'], // 'secret' NOT authorized
    });
    expect(bundle.results.length).toBeGreaterThan(0);
    expect(bundle.results.every((r) => r.repo === 'api')).toBe(true);
    expect(bundle.results.every((r) => r.repo !== 'secret')).toBe(true);

    // No authorized repos at all → explicit zero result.
    const denied = await queryEvidence(store, req('savePreferences'), {
      authorizedRepos: [],
    });
    expect(denied.results).toHaveLength(0);
    expect(denied.zero_result_reason).toContain('authorized');
  });

  it('requested repos are intersected with the ACL before strategies run', async () => {
    await buildFixture();
    const bundle = await queryEvidence(
      store,
      req('savePreferences', { repos: ['api', 'secret'] }),
      { authorizedRepos: ['api'] },
    );
    expect(bundle.index_heads.map((h) => h.repo)).toEqual(['api']);
  });
});

describe('evaluateGoldenSet — golden-set harness', () => {
  it('scores a suite and persists a retrieval_evaluations row', async () => {
    await buildFixture();
    const { row, metrics, cases } = await evaluateGoldenSet(
      store,
      {
        suite_version: 'golden-v1',
        task: 'implement',
        k: 10,
        cases: [
          {
            id: 'exact-symbol',
            query: 'savePreferences',
            relevant_symbols: ['savePreferences'],
            relevant_paths: ['src/prefs.ts'],
          },
          {
            id: 'fts-phrase',
            query: 'notification preferences',
            relevant_paths: ['src/notify.ts'],
          },
          {
            id: 'no-match',
            query: 'qqqzzz-nomatch',
          },
        ],
      },
      { workspace: WS, authorizedRepos: ACL },
    );

    expect(metrics.unauthorized_count).toBe(0);
    expect(metrics.citation_valid).toBe(1);
    expect(metrics.citation_fresh).toBe(1);
    expect(metrics.recall_at_k).toBe(1);
    expect(metrics.exact_recall).toBe(1);
    expect(metrics.queries).toBe(3);
    expect(metrics.zero_result).toBe(1);
    expect(metrics.latency_ms.avg).toBeGreaterThanOrEqual(0);
    expect(cases.find((c) => c.id === 'exact-symbol')?.hits).toBe(2);

    // Row persisted via insertRetrievalEvaluation.
    const stored = await store.getRetrievalEvaluation(row.id);
    expect(stored?.suite_version).toBe('golden-v1');
    expect(stored?.task).toBe('implement');
    expect(stored?.metrics?.unauthorized_count).toBe(0);
    expect(stored?.index_heads?.[0]?.repo).toBe('api');
    expect(
      await store.listRetrievalEvaluations({ suite_version: 'golden-v1' }),
    ).toHaveLength(1);
  });
});
