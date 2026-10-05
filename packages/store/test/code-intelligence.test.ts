import type { CodeUnitRow, RepoIndexRow } from '@sprint-runner/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/index.js';

let store: PostgresStore;
const WS = 'ws1';

beforeEach(async () => {
  store = await PostgresStore.connect('pglite:');
});
afterEach(async () => {
  await store.close();
});

const head = (
  repo: string,
  sha: string,
  status: RepoIndexRow['status'] = 'building',
): RepoIndexRow => ({
  workspace: WS,
  repo,
  commit_sha: sha,
  status,
  parser_version: 'p1',
  indexed_at: '2026-10-05T00:00:00Z',
  stats: { files: 1, units: 1 },
});

const unit = (over: Partial<CodeUnitRow> = {}): CodeUnitRow => ({
  id: `cu_${over.commit_sha ?? 'a1'}_${over.path ?? 'src/x.ts'}_${over.start_line ?? 1}`,
  workspace: WS,
  repo: 'api',
  commit_sha: 'a1',
  path: 'src/x.ts',
  language: 'typescript',
  symbol: 'savePrefs',
  symbol_kind: 'function',
  start_line: 1,
  end_line: 3,
  content_hash: 'sha256:aaa',
  content: 'export function savePrefs() {}',
  parse_status: 'parsed',
  ...over,
});

describe('repo indexes (D37 commit-pinned heads)', () => {
  it('upserts, reads the current head, and lists by status', async () => {
    await store.upsertRepoIndex(head('api', 'a1', 'current'));
    await store.upsertRepoIndex(head('api', 'b2', 'building'));

    const current = await store.getCurrentRepoIndex(WS, 'api');
    expect(current?.commit_sha).toBe('a1');
    expect(current?.stats).toEqual({ files: 1, units: 1 });

    const all = await store.listRepoIndexes({ workspace: WS, repo: 'api' });
    expect(all).toHaveLength(2);
    const building = await store.listRepoIndexes({
      workspace: WS,
      repo: 'api',
      status: 'building',
    });
    expect(building.map((r) => r.commit_sha)).toEqual(['b2']);
  });

  it('promotes a head atomically and supersedes the previous one', async () => {
    await store.upsertRepoIndex(head('api', 'a1', 'current'));
    await store.upsertRepoIndex(head('api', 'b2', 'building'));
    await store.upsertRepoIndex(head('api', 'old', 'superseded'));

    await store.promoteRepoIndexHead(
      { workspace: WS, repo: 'api', commit_sha: 'b2' },
      '2026-10-05T01:00:00Z',
    );

    expect((await store.getCurrentRepoIndex(WS, 'api'))?.commit_sha).toBe('b2');
    const a1 = await store.getRepoIndex({
      workspace: WS,
      repo: 'api',
      commit_sha: 'a1',
    });
    // Historical head remains addressable, now superseded.
    expect(a1?.status).toBe('superseded');
    // exactly one current
    const currents = await store.listRepoIndexes({
      workspace: WS,
      repo: 'api',
      status: 'current',
    });
    expect(currents).toHaveLength(1);
  });

  it('refuses to promote a failed or missing head', async () => {
    await store.upsertRepoIndex(head('api', 'bad', 'failed'));
    await expect(
      store.promoteRepoIndexHead({
        workspace: WS,
        repo: 'api',
        commit_sha: 'bad',
      }),
    ).rejects.toThrow(/failed/);
    await expect(
      store.promoteRepoIndexHead({
        workspace: WS,
        repo: 'api',
        commit_sha: 'missing',
      }),
    ).rejects.toThrow(/no index head/);
  });

  it('scopes heads per repo (no cross-repo leakage)', async () => {
    await store.upsertRepoIndex(head('api', 'a1', 'current'));
    await store.upsertRepoIndex(head('web', 'w1', 'current'));
    await store.upsertRepoIndex(head('secret', 's1', 'current'));
    expect((await store.getCurrentRepoIndex(WS, 'api'))?.commit_sha).toBe('a1');
    expect((await store.getCurrentRepoIndex(WS, 'web'))?.commit_sha).toBe('w1');
    expect(await store.getCurrentRepoIndex(WS, 'nope')).toBeNull();
  });
});

describe('code units + FTS + exact + hash', () => {
  const heads = [{ repo: 'api', commit_sha: 'a1' }];

  beforeEach(async () => {
    await store.upsertCodeUnits([
      unit({
        id: 'u1',
        path: 'src/prefs.ts',
        symbol: 'savePreferences',
        start_line: 10,
        end_line: 20,
        content_hash: 'sha256:p1',
        content:
          'export function savePreferences(userId) { return store.save(userId); }',
      }),
      unit({
        id: 'u2',
        path: 'src/notify.ts',
        symbol: 'notifyUser',
        start_line: 1,
        end_line: 8,
        content_hash: 'sha256:n1',
        content:
          'export function notifyUser(user) { push notification preferences }',
      }),
      unit({
        id: 'u3',
        repo: 'web',
        path: 'src/other.ts',
        symbol: 'savePreferences',
        commit_sha: 'w1',
        content_hash: 'sha256:other',
        content: 'savePreferences other',
      }),
    ]);
  });

  it('lists units for a commit and deletes a path', async () => {
    const api = await store.listCodeUnits({
      workspace: WS,
      repo: 'api',
      commit_sha: 'a1',
    });
    expect(api).toHaveLength(2);
    await store.deleteCodeUnitsForPath({
      workspace: WS,
      repo: 'api',
      commit_sha: 'a1',
      path: 'src/notify.ts',
    });
    expect(
      await store.listCodeUnits({
        workspace: WS,
        repo: 'api',
        commit_sha: 'a1',
      }),
    ).toHaveLength(1);
  });

  it('full-text search is scoped to authorized heads only', async () => {
    const hits = await store.searchCodeUnitsFts({
      workspace: WS,
      heads,
      query: 'notification preferences',
      limit: 10,
    });
    expect(hits.map((h) => h.unit.id)).toContain('u2');
    // The web-repo unit shares the phrase but is not in the authorized heads.
    expect(hits.map((h) => h.unit.id)).not.toContain('u3');
    expect(hits.every((h) => h.unit.repo === 'api')).toBe(true);
  });

  it('returns nothing for empty heads (fail-closed ACL)', async () => {
    expect(
      await store.searchCodeUnitsFts({
        workspace: WS,
        heads: [],
        query: 'notification',
        limit: 10,
      }),
    ).toEqual([]);
  });

  it('exact symbol/path match scoped to heads', async () => {
    const bySymbol = await store.findCodeUnitsExact({
      workspace: WS,
      heads,
      symbols: ['savePreferences'],
      limit: 10,
    });
    expect(bySymbol.map((u) => u.id)).toEqual(['u1']);
    const byPath = await store.findCodeUnitsExact({
      workspace: WS,
      heads,
      paths: ['src/notify.ts'],
      limit: 10,
    });
    expect(byPath.map((u) => u.id)).toEqual(['u2']);
    // cross-repo symbol name must not leak
    const webHeads = [{ repo: 'api', commit_sha: 'a1' }];
    const leaked = await store.findCodeUnitsExact({
      workspace: WS,
      heads: webHeads,
      symbols: ['savePreferences'],
      limit: 10,
    });
    expect(leaked.every((u) => u.repo === 'api')).toBe(true);
  });

  it('maps content hashes back to authorized rows', async () => {
    const rows = await store.findCodeUnitsByHash({
      workspace: WS,
      heads,
      hashes: ['sha256:p1', 'sha256:other'],
      limit: 10,
    });
    expect(rows.map((u) => u.id)).toEqual(['u1']);
  });
});

describe('code edges + retrieval evaluations', () => {
  it('upserts edges idempotently and lists them', async () => {
    const edge = {
      workspace: WS,
      repo: 'api',
      commit_sha: 'a1',
      subject_ref: 'file:src/prefs.ts',
      predicate: 'imports' as const,
      object_ref: 'module:./store',
      evidence: 'src/prefs.ts:1',
      source: 'parser',
    };
    await store.upsertCodeEdge(edge);
    await store.upsertCodeEdge(edge);
    const edges = await store.listCodeEdges({
      workspace: WS,
      repo: 'api',
      commit_sha: 'a1',
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.predicate).toBe('imports');
  });

  it('persists golden-set retrieval evaluations', async () => {
    await store.insertRetrievalEvaluation({
      id: 're_1',
      suite_version: 'v1',
      task: 'impact',
      index_heads: [{ repo: 'api', commit_sha: 'a1' }],
      metrics: { unauthorized_count: 0, relevant_file_recall_at_k: 1 },
      created_at: '2026-10-05T00:00:00Z',
    });
    const got = await store.getRetrievalEvaluation('re_1');
    expect(got?.metrics?.unauthorized_count).toBe(0);
    expect(got?.index_heads).toEqual([{ repo: 'api', commit_sha: 'a1' }]);
    expect(
      await store.listRetrievalEvaluations({ task: 'impact' }),
    ).toHaveLength(1);
  });
});
