import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContainerRow, EventRow, RunRow } from '@sprint-runner/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteClient } from '../src/client.js';
import { PostgresStore } from '../src/index.js';

let dir: string;
let store: PostgresStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-store-'));
  store = await PostgresStore.connect('pglite:');
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const s = () => store;

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
  it('applies pg/0001_init through 0008 and records schema_meta', async () => {
    expect(await s().getSchemaVersion()).toBe(8);
    const rows = await s().db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const t of [
      'leases',
      'claims',
      'runs',
      'run_artifacts',
      'presence',
      'notifications',
      'projects',
      'boards',
      'board_items',
      'initiatives',
      'features',
      'tickets',
      'ticket_repos',
      'doc_versions',
      'events',
      'dossiers',
      'entities',
      'relations',
      'embeddings',
      'usage_calls',
      'gate_items',
      'containers',
      'schema_meta',
      // wp-131 contracts v3 + wp-140 changeset allocator
      'releases',
      'release_items',
      'release_manifests',
      'release_approvals',
      'release_notes',
      'release_gate_results',
      'deployments',
      'feature_exposure',
      'release_outcomes',
      'changesets',
      'changeset_items',
      'semantic_statements',
      'statement_versions',
      'statement_relations',
      'statement_clarifications',
      'statement_decisions',
      'statement_artifact_links',
      'semantic_extraction_runs',
      'wizard_definitions',
      'wizard_versions',
      'interview_sessions',
      'interview_branches',
      'interview_messages',
      'knowledge_slots',
      'question_candidates',
      'session_snapshots',
      'review_sessions',
      'review_revisions',
      'review_findings',
      'review_comments',
      'review_decisions',
      'finding_resolutions',
      'review_evidence_links',
      'external_review_mappings',
      'design_approvals',
      'assumptions',
      'quality_debt',
      'delivery_commitments',
      'eval_runs',
      'eval_cases',
      'eval_results',
      // wp-110 code intelligence / evidence plane
      'repo_indexes',
      'code_units',
      'code_edges',
      'retrieval_evaluations',
      // wp-157 test-environment requests
      'test_env_requests',
      // wp-112 continuous alignment (D37 Phase B)
      'alignment_runs',
      'alignment_findings',
      'alignment_finding_decisions',
      // wp-120 telemetry/incident intelligence (D37 Phase C)
      'telemetry_sources',
      'error_signatures',
      'incidents',
      'incident_decisions',
      'incident_ticket_proposals',
    ]) {
      expect(tables).toContain(t);
    }
    // re-running migrations is idempotent
    await s().migrate();
    expect(await s().getSchemaVersion()).toBe(8);
  });
});

describe('leases', () => {
  it('contended acquire over one connection → one winner', async () => {
    // Two logical stores share one PgClient (PGlite is single-process);
    // the contended path — existing non-expired lease → null — is what
    // the conductor relies on either way.
    const a = s();
    const b = PostgresStore.wrap(s().db);
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
  });

  it('sweeps expired leases and lets a new holder re-acquire', async () => {
    const l = await s().acquireLease(leaseKey, 'a', 1);
    expect(l).not.toBeNull();
    const future = new Date(Date.now() + 60_000).toISOString();
    const swept = await s().sweepExpiredLeases(future);
    expect(swept).toEqual([leaseKey]);
    expect(await s().getLease(leaseKey)).toBeNull();
    // fresh acquire works
    expect(await s().acquireLease(leaseKey, 'b', 300)).not.toBeNull();
    // contested while fresh → null
    expect(await s().acquireLease(leaseKey, 'c', 300)).toBeNull();
  });

  it('heartbeat extends the lease TTL', async () => {
    await s().acquireLease(leaseKey, 'a', 60);
    const hb = new Date(Date.now() + 55_000).toISOString();
    await s().heartbeatLease(leaseKey, 'a', hb);
    // before hb+ttl → still held
    expect(
      await s().sweepExpiredLeases(new Date(Date.now() + 61_000).toISOString()),
    ).toHaveLength(0);
    // after hb+ttl → swept
    expect(
      await s().sweepExpiredLeases(
        new Date(Date.now() + 120_000).toISOString(),
      ),
    ).toHaveLength(1);
  });

  it('heartbeat is holder-fenced — a stale owner cannot refresh', async () => {
    await s().acquireLease(leaseKey, 'a', 60);
    const hb = new Date(Date.now() + 55_000).toISOString();
    // wrong holder → false, lease untouched (still expires at +60s)
    expect(await s().heartbeatLease(leaseKey, 'stale-b', hb)).toBe(false);
    expect(
      await s().sweepExpiredLeases(new Date(Date.now() + 61_000).toISOString()),
    ).toHaveLength(1);
    // re-acquire + right holder → true
    await s().acquireLease(leaseKey, 'b', 60);
    expect(await s().heartbeatLease(leaseKey, 'b', hb)).toBe(true);
    expect(
      await s().sweepExpiredLeases(new Date(Date.now() + 61_000).toISOString()),
    ).toHaveLength(0);
  });
});

describe('claims', () => {
  it('atomic acquire + expired takeover', async () => {
    const a = s();
    const b = PostgresStore.wrap(s().db);
    const key = { workspace: 'ws1', subject: 'SR-0001', gate: 'merge' };
    expect(await a.acquireClaim(key, 'human-1', 1)).not.toBeNull();
    expect(await b.acquireClaim(key, 'human-2', 300)).toBeNull();
    // backdate the claim past its TTL
    await a.db.query('UPDATE claims SET claimed_at=$1 WHERE workspace=$2', [
      new Date(Date.now() - 60_000).toISOString(),
      'ws1',
    ]);
    const c2 = await b.acquireClaim(key, 'human-2', 300);
    expect(c2?.claimed_by).toBe('human-2');
  });
});

describe('runs registry', () => {
  it('lifecycle fields: create → usage → heartbeat → live list → exit', async () => {
    await s().createRun(run());
    await s().createRun(
      run({
        id: 'ws1/SR-0002/001-spec',
        subject: 'SR-0002',
        ticket_id: 'SR-0002',
        status: 'done',
      }),
    );
    await s().updateRunUsage(run().id, { tokens_in: 100, tokens_out: 10 });
    await s().updateRunUsage(run().id, { tokens_in: 50, tokens_cached: 30 });
    let r = await s().getRun(run().id);
    expect(r?.tokens_in).toBe(150);
    expect(r?.tokens_out).toBe(10);
    expect(r?.tokens_cached).toBe(30);
    await s().heartbeatRun(run().id, '2026-10-03T14:05:00Z');
    await s().updateRun(run().id, { pid: 4242, status: 'running' });
    r = await s().getRun(run().id);
    expect(r?.heartbeat_at).toBe('2026-10-03T14:05:00Z');
    expect(r?.pid).toBe(4242);
    const live = await s().listLiveRuns();
    expect(live.map((x) => x.id)).toEqual([run().id]);
    await s().updateRun(run().id, {
      status: 'exited',
      exited_at: '2026-10-03T14:10:00Z',
      sentinel: 'done',
      duration_s: 600,
    });
    r = await s().getRun(run().id);
    expect(r?.status).toBe('exited');
    expect(r?.sentinel).toBe('done');
  });

  it('container_id round-trips on runs rows (D30)', async () => {
    await s().createRun(run({ container_id: 'docker-abc123' }));
    expect((await s().getRun(run().id))?.container_id).toBe('docker-abc123');
    await s().updateRun(run().id, { container_id: null });
    expect((await s().getRun(run().id))?.container_id).toBeNull();
  });
});

describe('containers (D30 subject lifecycle)', () => {
  const crow = (over: Partial<ContainerRow> = {}): ContainerRow => ({
    workspace: 'ws1',
    subject: 'SR-0001',
    container_id: 'cid-1',
    image: 'veto/agent:latest',
    state: 'running',
    created_at: '2026-10-03T14:00:00Z',
    stopped_at: null,
    ...over,
  });

  it('upserts, reads, lists and transitions the subject row', async () => {
    await s().upsertContainer(crow());
    const row = await s().getContainer({
      workspace: 'ws1',
      subject: 'SR-0001',
    });
    expect(row?.container_id).toBe('cid-1');
    expect(row?.state).toBe('running');

    // state transition: running → stopped
    await s().upsertContainer(
      crow({ state: 'stopped', stopped_at: '2026-10-03T15:00:00Z' }),
    );
    expect(
      (await s().getContainer({ workspace: 'ws1', subject: 'SR-0001' }))?.state,
    ).toBe('stopped');

    // recreate: new container id + fresh created_at
    await s().upsertContainer(
      crow({
        container_id: 'cid-2',
        state: 'running',
        created_at: '2026-10-03T16:00:00Z',
        stopped_at: null,
      }),
    );
    const after = await s().getContainer({
      workspace: 'ws1',
      subject: 'SR-0001',
    });
    expect(after?.container_id).toBe('cid-2');
    expect(after?.created_at).toBe('2026-10-03T16:00:00Z');

    await s().upsertContainer(
      crow({ subject: 'probe:code-repo', container_id: 'cid-9' }),
    );
    expect(await s().listContainers({ workspace: 'ws1' })).toHaveLength(2);
    expect(
      (await s().listContainers({ workspace: 'ws1', state: 'running' })).map(
        (r) => r.subject,
      ),
    ).toEqual(['SR-0001', 'probe:code-repo']);
    expect(
      await s().getContainer({ workspace: 'ws1', subject: 'SR-9999' }),
    ).toBeNull();
    expect(await s().listContainers({ workspace: 'ws2' })).toHaveLength(0);
  });
});

describe('run_artifacts', () => {
  it('put/get/list structured artifacts', async () => {
    await s().putArtifact({
      run_id: 'ws1/SR-0001/001-triage',
      name: 'triage.json',
      content: '{"schema":1}',
    });
    await s().putArtifact({
      run_id: 'ws1/SR-0001/001-triage',
      name: 'usage.json',
      content: '{"schema":1,"totals":{}}',
    });
    const a = await s().getArtifact('ws1/SR-0001/001-triage', 'triage.json');
    expect(a?.content).toBe('{"schema":1}');
    // upsert overwrites
    await s().putArtifact({
      run_id: 'ws1/SR-0001/001-triage',
      name: 'triage.json',
      content: '{"schema":1,"round":2}',
    });
    expect(
      (await s().getArtifact('ws1/SR-0001/001-triage', 'triage.json'))?.content,
    ).toContain('round');
    expect(await s().listArtifacts('ws1/SR-0001/001-triage')).toHaveLength(2);
  });
});

describe('tickets (truth rows)', () => {
  it('upserts tickets + per-repo rows', async () => {
    await s().upsertTicket({
      workspace: 'ws1',
      ticket_id: 'SR-0001',
      title: 'Thing',
      status: 'triage',
      priority: 'high',
      depth: 'standard',
      feature: 'F-0001',
      source: 'manual',
      repos: ['backend', 'frontend'],
      depends_on: ['SR-0000'],
      spec_score: 82,
      updated_at: '2026-10-03T14:00:00Z',
    });
    await s().upsertTicketRepo({
      workspace: 'ws1',
      ticket_id: 'SR-0001',
      repo: 'backend',
      branch: 'sr-0001',
      pr_state: 'open',
      ci_state: 'pending',
    });
    const t = await s().getTicket({ workspace: 'ws1', ticket_id: 'SR-0001' });
    expect(t?.repos).toEqual(['backend', 'frontend']);
    expect(t?.depends_on).toEqual(['SR-0000']);
    expect(t?.feature).toBe('F-0001');
    const repos = await s().listTicketRepos({
      workspace: 'ws1',
      ticket_id: 'SR-0001',
    });
    expect(repos).toHaveLength(1);
    expect(repos[0]?.ci_state).toBe('pending');
  });
});

describe('projects + id allocation', () => {
  it('allocates SR/F/I ids transactionally per project', async () => {
    await s().upsertProject({ workspace: 'ws1', name: 'Team A' });
    expect(await s().allocTicketId('ws1')).toBe('SR-0001');
    expect(await s().allocTicketId('ws1')).toBe('SR-0002');
    expect(await s().allocFeatureId('ws1')).toBe('F-0001');
    expect(await s().allocInitiativeId('ws1')).toBe('I-0001');
    // sequences are per-project
    await s().upsertProject({ workspace: 'ws2' });
    expect(await s().allocTicketId('ws2')).toBe('SR-0001');
    const p = await s().getProject('ws1');
    expect(p?.next_ticket_seq).toBe(3);
    expect(p?.name).toBe('Team A');
  });

  it('allocSeq self-heals a missing projects row ABOVE existing ids', async () => {
    // ws1 has seeded tickets but no projects row (a workspace that
    // predates registration) — allocation must start above the
    // high-water mark, never reissue SR-0001 (an upsertTicket on a
    // recycled id silently overwrites a live ticket).
    const now = new Date().toISOString();
    for (const id of ['SR-0001', 'SR-0002', 'SR-0005']) {
      await s().upsertTicket({
        workspace: 'ws1',
        ticket_id: id,
        feature: null,
        title: id,
        status: 'imported',
        priority: 'medium',
        depth: null,
        backend: null,
        model: null,
        repos: [],
        parent: null,
        depends_on: [],
        source: null,
        forced: false,
        spec_score: null,
        spec_hash: null,
        blocked_reason: null,
        created_at: now,
        updated_at: now,
      });
    }
    expect(await s().allocTicketId('ws1')).toBe('SR-0006');
    const p = await s().getProject('ws1');
    expect(p?.next_ticket_seq).toBe(7);
    // An empty workspace self-heals at seq 1.
    expect(await s().allocTicketId('ws-empty')).toBe('SR-0001');
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
  refs: ['run:ws1/SR-0001/003-review:review.json'],
  data: { n: 1 },
  ...over,
});

describe('events (append-only truth)', () => {
  it('appends in order with identity seq', async () => {
    const seq1 = await s().appendEvent(ev());
    const seq2 = await s().appendEvent(
      ev({ ts: '2026-10-03T14:40:00Z', event: 'finding_fixed' }),
    );
    expect(seq2).toBeGreaterThan(seq1);
    const rows = await s().listEvents({
      workspace: 'ws1',
      ticket_id: 'SR-0001',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.event).toBe('finding_created');
    expect(rows[1]?.refs).toEqual(['run:ws1/SR-0001/003-review:review.json']);
  });

  it('notifies on run_failed/run_killed/blocked events', async () => {
    await s().appendEvent(ev({ event: 'run_failed', ticket_id: 'SR-0001' }));
    const ns = await s().listNotifications({ workspace: 'ws1' });
    expect(ns).toHaveLength(1);
    expect(ns[0]?.kind).toBe('run_failed');
  });
});

describe('doc_versions', () => {
  it('appends immutable versions; latest wins; history preserved', async () => {
    const key = {
      workspace: 'ws1',
      subject: 'SR-0001',
      doc: 'rs.md' as const,
    };
    const v1 = await s().appendDocVersion(key, '# rs v1', 'agent:prd');
    expect(v1.version).toBe(1);
    const v2 = await s().appendDocVersion(key, '# rs v2', 'human:keith');
    expect(v2.version).toBe(2);
    expect((await s().getDoc(key))?.content).toBe('# rs v2');
    expect((await s().getDocVersion(key, 1))?.content).toBe('# rs v1');
    expect((await s().listDocVersions(key)).map((v) => v.version)).toEqual([
      1, 2,
    ]);
    await s().appendDocVersion(
      { ...key, doc: 'tdd.md' },
      '# tdd v1',
      'agent:design',
    );
    const docs = await s().listDocs({ workspace: 'ws1', subject: 'SR-0001' });
    expect(docs.map((d) => d.doc).sort()).toEqual(['rs.md', 'tdd.md']);
  });
});

describe('boards + hierarchy', () => {
  it('board items incl. capture tray (board NULL)', async () => {
    await s().upsertBoard({ workspace: 'ws1', board: 'main', name: 'Main' });
    await s().upsertBoardItem({
      id: 'bi-1',
      workspace: 'ws1',
      board: 'main',
      kind: 'idea',
      title: 'A card',
      status: 'icebox',
      x: 10,
      y: 20,
    });
    await s().upsertBoardItem({
      id: 'bi-2',
      workspace: 'ws1',
      board: null,
      kind: 'feedback',
      title: 'tray item',
      status: 'icebox',
    });
    expect(await s().listBoards('ws1')).toHaveLength(1);
    expect(
      await s().listBoardItems({ workspace: 'ws1', board: 'main' }),
    ).toHaveLength(1);
    const tray = await s().listBoardItems({ workspace: 'ws1', board: null });
    expect(tray).toHaveLength(1);
    expect(tray[0]?.kind).toBe('feedback');
  });

  it('initiatives + features CRUD', async () => {
    await s().upsertInitiative({
      workspace: 'ws1',
      initiative: 'I-0001',
      board: 'main',
      title: 'Big thing',
      status: 'draft',
      priority: 'high',
    });
    await s().upsertFeature({
      workspace: 'ws1',
      feature: 'F-0001',
      initiative: 'I-0001',
      title: 'Slice',
      status: 'ready',
    });
    expect((await s().getInitiative('ws1', 'I-0001'))?.status).toBe('draft');
    expect(
      (await s().listFeatures({ workspace: 'ws1', initiative: 'I-0001' })).map(
        (f) => f.feature,
      ),
    ).toEqual(['F-0001']);
  });
});

describe('gate_items + notifications + presence', () => {
  it('surfacing a gate item creates a notification; prune works', async () => {
    await s().upsertGateItem({
      workspace: 'ws1',
      subject: 'SR-0001',
      gate: 'merge',
      kind: 'approval',
      surfaced_at: '2026-10-03T14:00:00Z',
      blocked_agent: true,
      priority: 'high',
    });
    const g = await s().getGateItem({
      workspace: 'ws1',
      subject: 'SR-0001',
      gate: 'merge',
    });
    expect(g?.blocked_agent).toBe(true);
    const ns = await s().listNotifications({ workspace: 'ws1' });
    expect(ns).toHaveLength(1);
    expect(ns[0]?.kind).toBe('gate:approval');
    // re-upsert does not double-notify
    await s().upsertGateItem({
      workspace: 'ws1',
      subject: 'SR-0001',
      gate: 'merge',
      kind: 'approval',
      surfaced_at: '2026-10-03T14:00:00Z',
      blocked_agent: true,
    });
    expect(await s().listNotifications({ workspace: 'ws1' })).toHaveLength(1);
    // snooze keeps it open but flagged
    await s().upsertGateItem({
      workspace: 'ws1',
      subject: 'SR-0001',
      gate: 'merge',
      kind: 'approval',
      surfaced_at: '2026-10-03T14:00:00Z',
      snoozed_until: '2026-10-05T00:00:00Z',
      blocked_agent: true,
    });
    expect(
      (
        await s().getGateItem({
          workspace: 'ws1',
          subject: 'SR-0001',
          gate: 'merge',
        })
      )?.snoozed_until,
    ).toBe('2026-10-05T00:00:00Z');
    await s().clearGateItem(
      { workspace: 'ws1', subject: 'SR-0001', gate: 'merge' },
      '2026-10-03T15:00:00Z',
    );
    expect(
      await s().listGateItems({ workspace: 'ws1', open: true }),
    ).toHaveLength(0);
    // prune
    const before = new Date().toISOString();
    expect(await s().pruneNotifications(before)).toBe(1);
    // presence
    await s().upsertPresence({
      install_id: 'inst-1',
      actor: 'keith',
      last_seen: '2020-01-01T00:00:00Z',
    });
    await s().upsertPresence({
      install_id: 'inst-2',
      actor: 'keith',
      last_seen: new Date().toISOString(),
    });
    expect(await s().prunePresence('2026-01-01T00:00:00Z')).toBe(1);
    expect(await s().listPresence()).toHaveLength(1);
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
    await s().upsertDossierSection(entry());
    await s().upsertDossierSection(
      entry({ content: '# arch v2', surveyed_at: '2026-10-04T14:00:00Z' }),
    );
    let d = await s().getDossierSection('repo', 'backend', 'architecture-map');
    expect(d?.version).toBe(2);
    expect(d?.content).toBe('# arch v2');
    // human edit → next version, unflagged
    await s().upsertDossierSection(
      entry({
        content: '# human fix',
        surveyed_at: '2026-10-05T14:00:00Z',
        edited_by: 'keith',
        edited_at: '2026-10-05T14:00:00Z',
      }),
    );
    d = await s().getDossierSection('repo', 'backend', 'architecture-map');
    expect(d?.version).toBe(3);
    expect(d?.edited_by).toBe('keith');
    expect(d?.stale).toBe(false);
    // machine refresh over a human-edited latest → stored but flagged
    await s().upsertDossierSection(
      entry({ content: '# survey again', surveyed_at: '2026-10-06T14:00:00Z' }),
    );
    d = await s().getDossierSection('repo', 'backend', 'architecture-map');
    expect(d?.version).toBe(4);
    expect(d?.stale).toBe(true); // flagged for review — human v3 wins
    const human = await s().getDossierSection(
      'repo',
      'backend',
      'architecture-map',
      3,
    );
    expect(human?.content).toBe('# human fix');
    const versions = await s().listDossierVersions(
      'repo',
      'backend',
      'architecture-map',
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });
});

describe('semantic layer', () => {
  it('entities, relations, embeddings', async () => {
    await s().upsertEntity({
      id: 'e1',
      product: 'sr',
      kind: 'entity',
      name: 'Store',
      canonical: 'store',
      aliases: ['db'],
      source: 'inferred',
    });
    expect((await s().getEntity('e1'))?.aliases).toEqual(['db']);
    await s().upsertRelation({
      subject: 'e1',
      predicate: 'depends-on',
      object: 'e2',
      evidence: 'imports',
    });
    expect(await s().listRelations({ subject: 'e1' })).toHaveLength(1);
    await s().upsertEmbedding({
      object_ref: 'e1',
      model: 'm',
      vector: [1, 0, 0],
    });
    await s().upsertEmbedding({
      object_ref: 'e2',
      model: 'm',
      vector: [0, 1, 0],
    });
    const nearest = await s().nearestEmbeddings({
      model: 'm',
      vector: [1, 0, 0],
      limit: 1,
    });
    expect(nearest[0]?.object_ref).toBe('e1');
    expect(nearest[0]?.distance).toBeCloseTo(0, 5);
  });
});

describe('regression — R1 review findings', () => {
  it('updateRun: empty / id-only patch is a no-op (not a SQL error)', async () => {
    await s().createRun(run());
    await s().updateRun(run().id, {});
    await s().updateRun(run().id, { id: 'other' });
    expect((await s().getRun(run().id))?.status).toBe('running');
  });

  it('updateRun: request column round-trips JSON (not "[object Object]")', async () => {
    await s().createRun(run());
    const request = {
      tokens: { NEW_ID: 'SR-0099', VERIFY_FOR: 'implement' },
      task: { kind: 'verify', verify_for: 'implement' },
      model: 'sonnet',
    };
    await s().updateRun(run().id, { request });
    const r = await s().getRun(run().id);
    expect(r?.request).toEqual(request);
  });

  it('run_artifacts: nested names (<subject>/file) round-trip exactly', async () => {
    await s().createRun(run());
    await s().putArtifact({
      run_id: run().id,
      name: 'SR-0001/triage.json',
      content: '{"questions":[]}',
    });
    const a = await s().getArtifact(run().id, 'SR-0001/triage.json');
    expect(a?.name).toBe('SR-0001/triage.json');
    const all = await s().listArtifacts(run().id);
    expect(all.map((x) => x.name)).toContain('SR-0001/triage.json');
    // bare name does NOT collide with the nested row
    expect(await s().getArtifact(run().id, 'triage.json')).toBeNull();
  });

  it('transaction: a throwing fn rolls back all writes', async () => {
    await s().createRun(run());
    await expect(
      s().transaction(async (tx) => {
        await tx.updateRun(run().id, { status: 'failed' });
        await tx.appendEvent(ev({ event: 'run_failed' }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await s().getRun(run().id))?.status).toBe('running');
    expect(
      await s().listEvents({ workspace: 'ws1', ticket_id: 'SR-0001' }),
    ).toHaveLength(0);
  });

  it('transaction: nested calls reuse the outer tx (rollback covers all)', async () => {
    await s().createRun(run());
    await expect(
      s().transaction(async (outer) => {
        await outer.updateRun(run().id, { status: 'paused' });
        // nested transaction must not open a second tx on the tx-bound
        // store — it reuses the open one, so the throw still rolls back.
        await outer.transaction(async (inner) => {
          await inner.appendEvent(ev({ event: 'run_paused' }));
        });
        throw new Error('outer boom');
      }),
    ).rejects.toThrow('outer boom');
    expect((await s().getRun(run().id))?.status).toBe('running');
    expect(
      await s().listEvents({ workspace: 'ws1', ticket_id: 'SR-0001' }),
    ).toHaveLength(0);
  });

  it('events is append-only at the DB layer (0002 triggers)', async () => {
    const seq = await s().appendEvent(ev());
    await expect(
      s().db.query('UPDATE events SET event=$1 WHERE seq=$2', [
        'tampered',
        seq,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      s().db.query('DELETE FROM events WHERE seq=$1', [seq]),
    ).rejects.toThrow(/append-only/);
    // INSERT still works
    const seq2 = await s().appendEvent(ev({ event: 'gate_cleared' }));
    expect(seq2).toBeGreaterThan(seq);
  });

  it('doc_versions is immutable at the DB layer (0002 triggers)', async () => {
    const key = {
      workspace: 'ws1',
      subject: 'SR-0001',
      doc: 'rs.md' as const,
    };
    const v = await s().appendDocVersion(key, '# v1', 'agent:prd');
    const pk = [key.workspace, key.subject, key.doc, v.version];
    await expect(
      s().db.query(
        `UPDATE doc_versions SET content=$5
         WHERE workspace=$1 AND subject=$2 AND doc=$3 AND version=$4`,
        [...pk, 'tampered'],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      s().db.query(
        `DELETE FROM doc_versions
         WHERE workspace=$1 AND subject=$2 AND doc=$3 AND version=$4`,
        pk,
      ),
    ).rejects.toThrow(/append-only/);
  });
});

describe('parseStorageUrl', () => {
  it('pglite: forms map to the embedded driver', async () => {
    const { parseStorageUrl } = await import('../src/client.js');
    expect(parseStorageUrl('pglite:')).toEqual({ driver: 'pglite', url: '' });
    expect(parseStorageUrl('pglite://./data')).toEqual({
      driver: 'pglite',
      url: './data',
    });
    expect(parseStorageUrl(':memory:')).toEqual({
      driver: 'pglite',
      url: ':memory:',
    });
  });

  it('postgres:// passes through; anything else fails closed', async () => {
    const { parseStorageUrl } = await import('../src/client.js');
    expect(parseStorageUrl('postgres://u@h/db')).toEqual({
      driver: 'postgres',
      url: 'postgres://u@h/db',
    });
    expect(parseStorageUrl('postgresql://u@h/db').driver).toBe('postgres');
    expect(() => parseStorageUrl('sqlite://x.db')).toThrow(
      /unsupported storage_url/,
    );
    expect(() => parseStorageUrl('./data')).toThrow(/unsupported storage_url/);
  });
});
