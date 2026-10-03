import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventRow, RunRow } from '@sprint-runner/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/index.js';

let dir: string;
let url: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-store-'));
  url = `sqlite://${join(dir, 'state.db')}`;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const leaseKey = {
  workspace: 'ws1',
  subject: 'SR-0001',
  stage: 'implement',
  attempt: 1,
};

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'ws1/SR-0001/001-implement',
  workspace: 'ws1',
  subject: 'SR-0001',
  ticket_id: 'SR-0001',
  stage: 'implement',
  attempt: 1,
  status: 'running',
  started_at: '2026-10-03T14:00:00Z',
  ...over,
});

describe('migrations + meta', () => {
  it('applies 0001_init and records schema_meta', async () => {
    const s = new SqliteStore(url);
    expect(await s.getSchemaVersion()).toBe(1);
    const tables = s.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'leases',
      'claims',
      'runs',
      'presence',
      'notifications',
      'tickets',
      'ticket_repos',
      'dossiers',
      'entities',
      'relations',
      'embeddings',
      'events_idx',
      'usage_calls',
      'gate_items',
      'schema_meta',
    ]) {
      expect(tables).toContain(t);
    }
    // re-opening is idempotent
    s.close();
    const s2 = new SqliteStore(url);
    expect(await s2.getSchemaVersion()).toBe(1);
    s2.close();
  });
});

describe('leases', () => {
  it('contended acquire across two Store instances → one winner', async () => {
    const a = new SqliteStore(url);
    const b = new SqliteStore(url);
    const [ra, rb] = await Promise.all([
      a.acquireLease(leaseKey, 'install-a', 300),
      b.acquireLease(leaseKey, 'install-b', 300),
    ]);
    expect([ra, rb].filter((r) => r !== null)).toHaveLength(1);
    const winner = ra ?? rb;
    expect(winner).not.toBeNull();
    expect(['install-a', 'install-b']).toContain(winner?.holder);
    // loser releasing winner's lease is a no-op
    const loser = ra ? 'install-b' : 'install-a';
    await a.releaseLease(leaseKey, loser);
    expect(await a.getLease(leaseKey)).not.toBeNull();
    await a.releaseLease(leaseKey, winner?.holder ?? '');
    expect(await a.getLease(leaseKey)).toBeNull();
    a.close();
    b.close();
  });

  it('sweeps expired leases and lets a new holder re-acquire', async () => {
    const s = new SqliteStore(url);
    const l = await s.acquireLease(leaseKey, 'a', 1);
    expect(l).not.toBeNull();
    const future = new Date(Date.now() + 60_000).toISOString();
    const swept = await s.sweepExpiredLeases(future);
    expect(swept).toEqual([leaseKey]);
    expect(await s.getLease(leaseKey)).toBeNull();
    // fresh acquire works
    expect(await s.acquireLease(leaseKey, 'b', 300)).not.toBeNull();
    // contested while fresh → null
    expect(await s.acquireLease(leaseKey, 'c', 300)).toBeNull();
    s.close();
  });

  it('heartbeat extends the lease TTL', async () => {
    const s = new SqliteStore(url);
    await s.acquireLease(leaseKey, 'a', 60);
    const hb = new Date(Date.now() + 55_000).toISOString();
    await s.heartbeatLease(leaseKey, hb);
    // before hb+ttl → still held
    expect(
      await s.sweepExpiredLeases(new Date(Date.now() + 61_000).toISOString()),
    ).toHaveLength(0);
    // after hb+ttl → swept
    expect(
      await s.sweepExpiredLeases(new Date(Date.now() + 120_000).toISOString()),
    ).toHaveLength(1);
    s.close();
  });
});

describe('claims', () => {
  it('atomic acquire + expired takeover', async () => {
    const a = new SqliteStore(url);
    const b = new SqliteStore(url);
    const key = { workspace: 'ws1', subject: 'SR-0001', gate: 'merge' };
    expect(await a.acquireClaim(key, 'human-1', 1)).not.toBeNull();
    expect(await b.acquireClaim(key, 'human-2', 300)).toBeNull();
    // backdate the claim past its TTL
    a.db
      .prepare('UPDATE claims SET claimed_at=? WHERE workspace=?')
      .run(new Date(Date.now() - 60_000).toISOString(), 'ws1');
    const c2 = await b.acquireClaim(key, 'human-2', 300);
    expect(c2?.claimed_by).toBe('human-2');
    a.close();
    b.close();
  });
});

describe('runs registry', () => {
  it('lifecycle fields: create → usage → heartbeat → live list → exit', async () => {
    const s = new SqliteStore(url);
    await s.createRun(run());
    await s.createRun(
      run({
        id: 'ws1/SR-0002/001-spec',
        subject: 'SR-0002',
        ticket_id: 'SR-0002',
        status: 'done',
      }),
    );
    await s.updateRunUsage(run().id, { tokens_in: 100, tokens_out: 10 });
    await s.updateRunUsage(run().id, { tokens_in: 50, tokens_cached: 30 });
    let r = await s.getRun(run().id);
    expect(r?.tokens_in).toBe(150);
    expect(r?.tokens_out).toBe(10);
    expect(r?.tokens_cached).toBe(30);
    await s.heartbeatRun(run().id, '2026-10-03T14:05:00Z');
    await s.updateRun(run().id, { pid: 4242, status: 'running' });
    r = await s.getRun(run().id);
    expect(r?.heartbeat_at).toBe('2026-10-03T14:05:00Z');
    expect(r?.pid).toBe(4242);
    const live = await s.listLiveRuns();
    expect(live.map((x) => x.id)).toEqual([run().id]);
    await s.updateRun(run().id, {
      status: 'exited',
      exited_at: '2026-10-03T14:10:00Z',
      sentinel: 'done',
      duration_s: 600,
    });
    r = await s.getRun(run().id);
    expect(r?.status).toBe('exited');
    expect(r?.sentinel).toBe('done');
    s.close();
  });
});

describe('ticket projections', () => {
  it('upserts tickets + per-repo rows', async () => {
    const s = new SqliteStore(url);
    await s.upsertTicket({
      workspace: 'ws1',
      ticket_id: 'SR-0001',
      title: 'Thing',
      status: 'spec',
      priority: 'high',
      depth: 'standard',
      repos: ['backend', 'frontend'],
      depends_on: ['SR-0000'],
      spec_score: 82,
      updated_at: '2026-10-03T14:00:00Z',
    });
    await s.upsertTicketRepo({
      workspace: 'ws1',
      ticket_id: 'SR-0001',
      repo: 'backend',
      branch: 'sr-0001',
      pr_state: 'open',
      ci_state: 'pending',
    });
    const t = await s.getTicket({ workspace: 'ws1', ticket_id: 'SR-0001' });
    expect(t?.repos).toEqual(['backend', 'frontend']);
    expect(t?.depends_on).toEqual(['SR-0000']);
    const repos = await s.listTicketRepos({
      workspace: 'ws1',
      ticket_id: 'SR-0001',
    });
    expect(repos).toHaveLength(1);
    expect(repos[0]?.ci_state).toBe('pending');
    s.close();
  });
});

const ev = (over: Partial<EventRow> = {}): EventRow => ({
  workspace: 'ws1',
  ticket_id: 'SR-0001',
  ts: '2026-10-03T14:22:10Z',
  stage: 'review',
  actor_type: 'agent',
  actor_id: 'aider/sonnet',
  event: 'finding_created',
  run: '003-review',
  refs: ['runs/003-review/review.json'],
  data: { n: 1 },
  ...over,
});

describe('events_idx replay', () => {
  it('drop + rebuild restores the projection in order', async () => {
    const s = new SqliteStore(url);
    await s.appendEvent(ev());
    await s.appendEvent(
      ev({ ts: '2026-10-03T14:40:00Z', event: 'finding_fixed' }),
    );
    await s.clearEvents('ws1');
    expect(await s.listEvents({ workspace: 'ws1' })).toHaveLength(0);
    // replay from (simulated) events.jsonl
    const seq1 = await s.appendEvent(ev());
    const seq2 = await s.appendEvent(
      ev({ ts: '2026-10-03T14:40:00Z', event: 'finding_fixed' }),
    );
    expect(seq2).toBeGreaterThan(seq1);
    const rows = await s.listEvents({
      workspace: 'ws1',
      ticket_id: 'SR-0001',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.event).toBe('finding_created');
    expect(rows[1]?.refs).toEqual(['runs/003-review/review.json']);
    s.close();
  });

  it('notifies on run_failed/run_killed/blocked events', async () => {
    const s = new SqliteStore(url);
    await s.appendEvent(ev({ event: 'run_failed', ticket_id: 'SR-0001' }));
    const ns = await s.listNotifications({ workspace: 'ws1' });
    expect(ns).toHaveLength(1);
    expect(ns[0]?.kind).toBe('run_failed');
    s.close();
  });
});

describe('gate_items + notifications + presence', () => {
  it('surfacing a gate item creates a notification; prune works', async () => {
    const s = new SqliteStore(url);
    await s.upsertGateItem({
      workspace: 'ws1',
      subject: 'SR-0001',
      gate: 'merge',
      kind: 'approval',
      surfaced_at: '2026-10-03T14:00:00Z',
      blocked_agent: true,
      priority: 'high',
    });
    const g = await s.getGateItem({
      workspace: 'ws1',
      subject: 'SR-0001',
      gate: 'merge',
    });
    expect(g?.blocked_agent).toBe(true);
    const ns = await s.listNotifications({ workspace: 'ws1' });
    expect(ns).toHaveLength(1);
    expect(ns[0]?.kind).toBe('gate:approval');
    // re-upsert does not double-notify
    await s.upsertGateItem({
      workspace: 'ws1',
      subject: 'SR-0001',
      gate: 'merge',
      kind: 'approval',
      surfaced_at: '2026-10-03T14:00:00Z',
      blocked_agent: true,
    });
    expect(await s.listNotifications({ workspace: 'ws1' })).toHaveLength(1);
    await s.clearGateItem(
      { workspace: 'ws1', subject: 'SR-0001', gate: 'merge' },
      '2026-10-03T15:00:00Z',
    );
    expect(
      await s.listGateItems({ workspace: 'ws1', open: true }),
    ).toHaveLength(0);
    // prune
    const before = new Date().toISOString();
    expect(await s.pruneNotifications(before)).toBe(1);
    // presence
    await s.upsertPresence({
      install_id: 'inst-1',
      actor: 'keith',
      last_seen: '2020-01-01T00:00:00Z',
    });
    await s.upsertPresence({
      install_id: 'inst-2',
      actor: 'keith',
      last_seen: new Date().toISOString(),
    });
    expect(await s.prunePresence('2026-01-01T00:00:00Z')).toBe(1);
    expect(await s.listPresence()).toHaveLength(1);
    s.close();
  });
});

describe('dossiers', () => {
  const entry = (over = {}) => ({
    scope: 'repo' as const,
    name: 'backend',
    section: 'architecture-map' as const,
    version: 0,
    content: '# arch',
    surveyed_at: '2026-10-03T14:00:00Z',
    sources_used: ['code' as const],
    stale: false,
    ...over,
  });

  it('version+1 on refresh; human edited_by wins the conflict', async () => {
    const s = new SqliteStore(url);
    await s.upsertDossierSection(entry());
    await s.upsertDossierSection(
      entry({ content: '# arch v2', surveyed_at: '2026-10-04T14:00:00Z' }),
    );
    let d = await s.getDossierSection('repo', 'backend', 'architecture-map');
    expect(d?.version).toBe(2);
    expect(d?.content).toBe('# arch v2');
    // human edit → next version, unflagged
    await s.upsertDossierSection(
      entry({
        content: '# human fix',
        surveyed_at: '2026-10-05T14:00:00Z',
        edited_by: 'keith',
        edited_at: '2026-10-05T14:00:00Z',
      }),
    );
    d = await s.getDossierSection('repo', 'backend', 'architecture-map');
    expect(d?.version).toBe(3);
    expect(d?.edited_by).toBe('keith');
    expect(d?.stale).toBe(false);
    // machine refresh over a human-edited latest → stored but flagged
    await s.upsertDossierSection(
      entry({ content: '# survey again', surveyed_at: '2026-10-06T14:00:00Z' }),
    );
    d = await s.getDossierSection('repo', 'backend', 'architecture-map');
    expect(d?.version).toBe(4);
    expect(d?.stale).toBe(true); // flagged for review — human v3 wins
    const human = await s.getDossierSection(
      'repo',
      'backend',
      'architecture-map',
      3,
    );
    expect(human?.content).toBe('# human fix');
    const versions = await s.listDossierVersions(
      'repo',
      'backend',
      'architecture-map',
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    s.close();
  });
});

describe('semantic layer', () => {
  it('entities, relations, embeddings', async () => {
    const s = new SqliteStore(url);
    await s.upsertEntity({
      id: 'e1',
      product: 'sr',
      kind: 'entity',
      name: 'Store',
      canonical: 'store',
      aliases: ['db'],
      source: 'inferred',
    });
    expect((await s.getEntity('e1'))?.aliases).toEqual(['db']);
    await s.upsertRelation({
      subject: 'e1',
      predicate: 'depends-on',
      object: 'e2',
      evidence: 'imports',
    });
    expect(await s.listRelations({ subject: 'e1' })).toHaveLength(1);
    await s.upsertEmbedding({
      object_ref: 'e1',
      model: 'm',
      vector: [1, 0, 0],
    });
    await s.upsertEmbedding({
      object_ref: 'e2',
      model: 'm',
      vector: [0, 1, 0],
    });
    const nearest = await s.nearestEmbeddings({
      model: 'm',
      vector: [1, 0, 0],
      limit: 1,
    });
    expect(nearest[0]?.object_ref).toBe('e1');
    expect(nearest[0]?.distance).toBeCloseTo(0, 5);
    s.close();
  });
});
