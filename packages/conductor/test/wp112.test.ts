/**
 * wp-112 — continuous alignment + evidence-backed release readiness
 * (D37 Phase B, SCHEMAS §18, INTELLIGENCE §5).
 *
 * Driven directly against PostgresStore (pglite) — the same harness as
 * wp111's second half. Fixtures cover every finding kind, a clean
 * aligned case, stale pins, contradictory evidence, dedupe on
 * duplicate on-merge events, the decide lifecycle (OCC + audit +
 * events), the release-readiness narrative's subordination to
 * deterministic gates, and workspace-scoped feedback clustering.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@sprint-runner/config';
import type {
  BoardItem,
  Relation,
  RepoIndexRow,
  RunRow,
  TicketRow,
} from '@sprint-runner/core';
import { releaseManifestDigest } from '@sprint-runner/lints';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AlignmentServiceError,
  clusterFeedback,
  compareAlignment,
  decideAlignmentFinding,
  releaseReadiness,
  runAlignment,
} from '../src/align/index.js';

const WS = 'ws-a';
const NOW = '2026-10-06T00:00:00Z';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const MERGED_SHA = 'c'.repeat(40);

let dir: string;
let store: PostgresStore;

const ctx = (workspace = WS) => ({
  store,
  workspace,
  actor: 'test-bot',
  now: () => new Date(NOW),
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      gates: 'minimal',
      repos: {},
      security: { scan_on_commit: false },
      intelligence: { alignment: 'manual' },
      ...overrides,
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-wp112-'));
  store = await PostgresStore.connect('pglite:');
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function ticketMd(id: string, acs: string[], status = 'ready'): string {
  return [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${status}`,
    'priority: medium',
    'repos: [code-repo]',
    '---',
    '',
    '## Description',
    'A sufficiently long description for spec lint purposes.',
    '',
    '## Acceptance criteria',
    ...acs.map((a) => `- [ ] ${a}`),
    '',
  ].join('\n');
}

async function seedTicket(
  id: string,
  acs: string[],
  status = 'ready',
): Promise<TicketRow> {
  const raw = ticketMd(id, acs, status);
  const ts = NOW;
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `${id} title`,
    status: status as TicketRow['status'],
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos: ['code-repo'],
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
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    raw,
    'test-seed',
  );
  return row;
}

async function seedHead(repo = 'code-repo', sha = HEAD) {
  const row: RepoIndexRow = {
    workspace: WS,
    repo,
    commit_sha: sha,
    status: 'current',
    parser_version: 'test',
    indexed_at: NOW,
    stats: null,
  };
  await store.upsertRepoIndex(row);
}

async function link(r: Relation) {
  await store.upsertRelation(r);
}

const implEdge = (
  tid: string,
  ac: string,
  sha = HEAD,
  verification: Relation['verification'] = 'verified',
): Relation => ({
  subject: `${tid}:ac:${ac}`,
  predicate: 'implements',
  object: `code:code-repo:${sha}:src/app.ts:main`,
  evidence: `code:code-repo:${sha}:src/app.ts:main`,
  source: 'human',
  verification,
});

const testEdge = (
  tid: string,
  ac: string,
  verification: Relation['verification'] = 'verified',
): Relation => ({
  subject: `${tid}:ac:${ac}`,
  predicate: 'tests',
  object: `code:code-repo:${HEAD}:test/app.test.ts:main works`,
  source: 'human',
  verification,
});

let runSeq = 0;
async function seedRun(subject: string): Promise<RunRow> {
  const row: RunRow = {
    id: `${WS}/${subject}/${String(++runSeq).padStart(3, '0')}-verify`,
    workspace: WS,
    subject,
    ticket_id: subject,
    stage: 'verify',
    attempt: runSeq,
    backend: 'mock',
    model: null,
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: null,
    status: 'done',
    started_at: NOW,
    heartbeat_at: null,
    exited_at: NOW,
    sentinel: 'DONE',
    sentinel_raw: 'DONE',
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: null,
  };
  await store.createRun(row);
  return row;
}

async function seedReport(subject: string, passed: boolean) {
  const run = await seedRun(subject);
  await store.putArtifact({
    run_id: run.id,
    name: 'test-report.json',
    content: JSON.stringify({
      schema: 1,
      subject,
      totals: { pass: passed ? 3 : 2, fail: passed ? 0 : 1 },
      cases: [
        { id: 't1', type: 'unit', result: 'pass' },
        { id: 't2', type: 'unit', result: passed ? 'pass' : 'fail' },
      ],
    }),
    created_at: NOW,
  });
  return run;
}

// ---------------------------------------------------------------------------
// the comparison engine — one fixture per finding kind (SCHEMAS §18)
// ---------------------------------------------------------------------------

describe('compareAlignment — intended/implemented/verified findings', () => {
  it('emits every §18 kind; each finding is a cited, checkable hypothesis', async () => {
    await seedHead();
    // missing-implementation-evidence + unverified-ac + unlinked-change
    await seedTicket('SR-0001', ['First criterion', 'Second criterion']);
    // AC-2 gets implementation evidence but no tests → unverified-ac.
    await link(implEdge('SR-0001', 'AC-2'));
    // AC-1 gets nothing → missing-implementation-evidence.
    // A merged ticket_repos row nobody cites → unlinked-change.
    await store.upsertTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0001',
      repo: 'code-repo',
      branch: 'sr-0001',
      worktree: null,
      pr_url: 'https://example/pr/1',
      pr_state: 'merged',
      ci_state: 'green',
      merged_sha: MERGED_SHA,
    });

    // likely-drift on a not-yet-merged ticket.
    await seedTicket('SR-0002', ['Drifting criterion']);
    await link(implEdge('SR-0002', 'AC-1', OLD));

    // affected-approved-behavior on a merged ticket.
    await seedTicket('SR-0003', ['Shipped criterion'], 'merged');
    await link(implEdge('SR-0003', 'AC-1', OLD));

    const artifact = await runAlignment(ctx(), makeConfig(), {
      scope: 'SR-0001',
      trigger: 'manual',
    }).then((r) => r.artifact);
    expect(artifact?.schema).toBe(1);
    const kinds = new Set(artifact?.findings.map((f) => f.kind));
    expect(kinds).toContain('missing-implementation-evidence');
    expect(kinds).toContain('unverified-ac');
    expect(kinds).toContain('unlinked-change');

    const drift2 = await compareAlignment(ctx(), 'SR-0002');
    expect(drift2.findings.map((f) => f.kind)).toContain('likely-drift');
    const drift3 = await compareAlignment(ctx(), 'SR-0003');
    expect(drift3.findings.map((f) => f.kind)).toContain(
      'affected-approved-behavior',
    );

    // Every finding: evidence, confidence, freshness, next check,
    // status open — a reviewable hypothesis, never a verdict.
    for (const f of [
      ...(artifact?.findings ?? []),
      ...drift2.findings,
      ...drift3.findings,
    ]) {
      expect(f.evidence_refs.length).toBeGreaterThan(0);
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(['current', 'stale']).toContain(f.freshness);
      expect(f.suggested_next_check.length).toBeGreaterThan(0);
      expect(f.status).toBe('open');
      expect(f.claim).not.toMatch(
        /\bis (verified|proven|correct|guaranteed)\b/i,
      );
    }
    // Drift findings cite the superseding head and carry stale freshness.
    const drift = drift2.findings.find((f) => f.kind === 'likely-drift');
    expect(drift?.freshness).toBe('stale');
    expect(
      drift?.evidence_refs.some((r) => r.includes(HEAD.slice(0, 12))),
    ).toBe(true);
  });

  it('clean aligned case: settled impl + settled tests + green report → zero findings', async () => {
    await seedHead();
    await seedTicket('SR-0010', ['Covered criterion']);
    await link(implEdge('SR-0010', 'AC-1'));
    await link(testEdge('SR-0010', 'AC-1'));
    await seedReport('SR-0010', true);
    // The merge IS cited — no unlinked-change.
    await store.upsertTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0010',
      repo: 'code-repo',
      branch: 'sr-0010',
      worktree: null,
      pr_url: 'https://example/pr/10',
      pr_state: 'merged',
      ci_state: 'green',
      merged_sha: HEAD,
    });
    await link({
      subject: 'SR-0010',
      predicate: 'implements',
      object: `code:code-repo:${HEAD}:src/app.ts:main`,
      evidence: `commit ${HEAD}`,
      source: 'explicit',
      verification: 'verified',
    });
    const artifact = await compareAlignment(ctx(), 'SR-0010');
    expect(artifact.findings).toHaveLength(0);
    expect(artifact.index_heads).toEqual([
      { repo: 'code-repo', commit_sha: HEAD },
    ]);
  });

  it('contradictory evidence: a suggested impl link surfaces as disconfirming, never hidden', async () => {
    await seedHead();
    await seedTicket('SR-0020', ['Contested criterion']);
    await link(implEdge('SR-0020', 'AC-1', HEAD, 'suggested'));
    const artifact = await compareAlignment(ctx(), 'SR-0020');
    const f = artifact.findings.find(
      (x) => x.kind === 'missing-implementation-evidence',
    );
    expect(f).toBeDefined();
    // The unverified suggestion is disclosed as disconfirming evidence —
    // the claim remains a hypothesis, not a silently-missed link.
    expect(f?.disconfirming_refs.length).toBeGreaterThan(0);
    expect(f?.status).toBe('open');
  });

  it('fail-closed: unknown scope 404s; alignment: off refuses a run', async () => {
    await expect(compareAlignment(ctx(), 'SR-9999')).rejects.toMatchObject({
      kind: 'missing',
    });
    await seedTicket('SR-0030', ['x']);
    await expect(
      runAlignment(ctx(), makeConfig({ intelligence: { alignment: 'off' } }), {
        scope: 'SR-0030',
        trigger: 'manual',
      }),
    ).rejects.toMatchObject({ kind: 'disabled' });
  });
});

// ---------------------------------------------------------------------------
// run lifecycle — dedupe, durable artifact, events
// ---------------------------------------------------------------------------

describe('runAlignment — dedupe + durability + spend', () => {
  it('duplicate on-merge events coalesce into ONE run with a durable artifact', async () => {
    await seedHead();
    await seedTicket('SR-0040', ['Merged criterion']);
    const cfg = makeConfig({ intelligence: { alignment: 'on-merge' } });
    const a = await runAlignment(ctx(), cfg, {
      scope: 'SR-0040',
      trigger: 'on-merge',
      triggerSha: MERGED_SHA,
    });
    const b = await runAlignment(ctx(), cfg, {
      scope: 'SR-0040',
      trigger: 'on-merge',
      triggerSha: MERGED_SHA,
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.run.run_id).toBe(a.run.run_id);
    const runs = await store.listAlignmentRuns({
      workspace: WS,
      scope: 'SR-0040',
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.artifact).toBeTruthy();
    expect(() => JSON.parse(runs[0]?.artifact ?? '')).not.toThrow();
    // One completion event — no duplicate ledger.
    const evs = await store.listEvents({ workspace: WS });
    expect(
      evs.filter((e) => e.event === 'alignment_run_completed'),
    ).toHaveLength(1);
  });

  it('a different merged head runs a fresh comparison', async () => {
    await seedHead();
    await seedTicket('SR-0041', ['x']);
    const cfg = makeConfig({ intelligence: { alignment: 'on-merge' } });
    await runAlignment(ctx(), cfg, {
      scope: 'SR-0041',
      trigger: 'on-merge',
      triggerSha: MERGED_SHA,
    });
    const second = await runAlignment(ctx(), cfg, {
      scope: 'SR-0041',
      trigger: 'on-merge',
      triggerSha: HEAD,
    });
    expect(second.created).toBe(true);
    expect(
      await store.listAlignmentRuns({ workspace: WS, scope: 'SR-0041' }),
    ).toHaveLength(2);
  });

  it('honors configured spend/token caps — refuses once the cap is reached', async () => {
    await seedHead();
    await seedTicket('SR-0042', ['x']);
    const cfg = makeConfig({ budgets: { spend_cap_usd_per_ticket: 0 } });
    await expect(
      runAlignment(ctx(), cfg, { scope: 'SR-0042', trigger: 'manual' }),
    ).rejects.toMatchObject({ kind: 'budget' });
  });
});

// ---------------------------------------------------------------------------
// human decisions — OCC, audit, events, settled status survives re-runs
// ---------------------------------------------------------------------------

describe('decideAlignmentFinding — hypotheses settle only by humans', () => {
  it('dismiss/verify/resolve are OCC-guarded, idempotent, evented, audited', async () => {
    await seedHead();
    await seedTicket('SR-0050', ['Open criterion']);
    const { artifact } = await runAlignment(ctx(), makeConfig(), {
      scope: 'SR-0050',
      trigger: 'manual',
    });
    const f = artifact?.findings[0];
    expect(f).toBeDefined();

    // OCC: wrong expected state → conflict (HTTP 409 at the API).
    await expect(
      decideAlignmentFinding(ctx(), {
        id: f?.id ?? '',
        action: 'dismiss',
        expected: 'verified',
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });

    const dismissed = await decideAlignmentFinding(ctx(), {
      id: f?.id ?? '',
      action: 'dismiss',
      expected: 'open',
      rationale: 'accepted risk',
    });
    expect(dismissed.status).toBe('dismissed');
    // Idempotent repeat — same target state, still 200-shaped, no new event.
    const again = await decideAlignmentFinding(ctx(), {
      id: f?.id ?? '',
      action: 'dismiss',
      expected: 'dismissed',
    });
    expect(again.status).toBe('dismissed');
    const evs = (await store.listEvents({ workspace: WS })).filter(
      (e) => e.event === 'alignment_finding_decided',
    );
    expect(evs).toHaveLength(1);
    const audit = await store.listAlignmentFindingDecisions({
      workspace: WS,
      finding_id: f?.id ?? '',
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.rationale).toBe('accepted risk');

    // Re-running the comparison refreshes evidence but NEVER reopens
    // the human-settled finding.
    await runAlignment(ctx(), makeConfig(), {
      scope: 'SR-0050',
      trigger: 'manual',
    });
    const kept = await store.getAlignmentFinding({
      workspace: WS,
      id: f?.id ?? '',
    });
    expect(kept?.status).toBe('dismissed');
    // …and the original claim/evidence is preserved (no silent rewrite
    // of the hypothesis text the human judged — same id, same claim).
    expect(kept?.claim).toBe(f?.claim);

    // A finding can never verify a link or approve anything itself:
    // verify changes only its own status.
    const v = await decideAlignmentFinding(ctx(), {
      id: f?.id ?? '',
      action: 'verify',
      expected: 'dismissed',
    });
    expect(v.status).toBe('verified');
    const rel = await store.listRelations({ subject_prefix: 'SR-0050' });
    expect(
      rel.every(
        (r) => r.verification !== 'verified' || r.predicate !== 'implements',
      ),
    ).toBe(true);
  });

  it('missing finding → missing (404 shape)', async () => {
    await expect(
      decideAlignmentFinding(ctx(), {
        id: 'aln_nope',
        action: 'resolve',
        expected: 'open',
      }),
    ).rejects.toMatchObject({ kind: 'missing' });
  });
});

// ---------------------------------------------------------------------------
// release readiness — gates are truth; the narrative is advisory
// ---------------------------------------------------------------------------

async function seedRelease(id: string, green: boolean) {
  const ts = NOW;
  await store.upsertRelease({
    workspace: WS,
    org: null,
    release_id: id,
    title: id,
    status: 'open',
    target: null,
    created_by: 'test',
    created_at: ts,
    updated_at: ts,
  });
  await store.upsertReleaseItem({
    workspace: WS,
    org: null,
    release_id: id,
    item_kind: 'ticket',
    item_id: 'SR-0060',
    partial_ac: null,
    delivery_state: 'planned',
    approved_by: null,
    added_by: 'test',
    added_at: ts,
    removed_at: null,
  });
  if (!green) return;
  const items = [
    {
      item_kind: 'ticket' as const,
      item_id: 'SR-0060',
      partial_ac: null,
      repos: [{ repo: 'code-repo', ticket: 'SR-0060', merged_sha: MERGED_SHA }],
    },
  ];
  await store.appendReleaseManifest({
    workspace: WS,
    org: null,
    release_id: id,
    version: 1,
    digest: releaseManifestDigest(items),
    items,
    created_at: ts,
  });
  await store.appendReleaseApproval({
    workspace: WS,
    org: null,
    release_id: id,
    manifest_version: 1,
    approver: 'human-1',
    decision: 'approved',
    rationale: 'ship it',
    created_at: ts,
  });
}

describe('releaseReadiness — narrative subordinate to gates', () => {
  it('failed gate + open findings → blocked, with both visible', async () => {
    await seedHead();
    await seedTicket('SR-0060', ['Unbuilt AC'], 'merged');
    await seedRelease('REL-0001', false);
    // Even an optimistic reading cannot unblock: manifest/approved/merged
    // gates fail → verdict blocked regardless of narrative content.
    const rr = await releaseReadiness({ ...ctx(), rootPath: dir }, 'REL-0001');
    expect(rr.gate_verdict).toBe('blocked');
    expect(rr.gates.some((g) => g.verdict === 'fail')).toBe(true);
    expect(rr.narrative.advisory_only).toBe(true);
    expect(rr.narrative.summary).toMatch(/stays blocked/i);
  });

  it('green gates + high-risk findings → ready, human sees both', async () => {
    await seedHead();
    await seedTicket('SR-0060', ['Unbuilt AC'], 'merged');
    await seedRelease('REL-0002', true);
    // Seed a blocker finding under the release scope.
    await runAlignment(ctx(), makeConfig(), {
      scope: 'release:REL-0002',
      trigger: 'manual',
    });
    // Force a blocker-severity open finding via the engine's own output:
    // the merged ticket's AC has no impl edge → missing-implementation
    // (major). Escalate severity by deciding nothing — risk=elevated.
    const rr = await releaseReadiness({ ...ctx(), rootPath: dir }, 'REL-0002');
    expect(rr.gate_verdict).toBe('ready');
    expect(rr.gates.every((g) => g.verdict === 'pass')).toBe(true);
    // The narrative reports elevated risk but does NOT block.
    expect(['elevated', 'high']).toContain(rr.narrative.risk);
    expect(rr.narrative.open_findings).toBeGreaterThan(0);
    expect(rr.narrative.finding_refs.length).toBe(rr.narrative.open_findings);
    expect(rr.narrative.summary).toMatch(/gates pass/i);
  });
});

// ---------------------------------------------------------------------------
// feedback clustering — proposals only, workspace-scoped
// ---------------------------------------------------------------------------

async function seedFeedback(
  workspace: string,
  id: string,
  title: string,
): Promise<BoardItem> {
  const item: BoardItem = {
    id,
    workspace,
    org: null,
    board: 'feedback-board',
    kind: 'feedback',
    note_kind: 'feedback',
    topic: null,
    importance: null,
    applies_to: null,
    note_status: null,
    rationale: null,
    provenance: null,
    ref: null,
    title,
    body: null,
    x: null,
    y: null,
    w: null,
    h: null,
    zone: null,
    serves: null,
    status: 'active',
    consumed_by: null,
    created_at: NOW,
    updated_at: NOW,
  };
  await store.upsertBoardItem(item);
  return item;
}

describe('clusterFeedback — proposals, never silent work', () => {
  it('similar feedback clusters; originals preserved; nothing created', async () => {
    await seedFeedback(WS, 'fb-1', 'Search results are slow to load');
    await seedFeedback(WS, 'fb-2', 'Search results load slowly');
    await seedFeedback(WS, 'fb-3', 'Export button missing on reports');
    const proposals = await clusterFeedback(ctx());
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.members.sort()).toEqual(['fb-1', 'fb-2']);
    expect(proposals[0]?.requires_human).toBe(true);
    // Proposed — NOT created: no new board items appeared.
    const items = await store.listBoardItems({ workspace: WS });
    expect(items).toHaveLength(3);
    const evs = (await store.listEvents({ workspace: WS })).filter(
      (e) => e.event === 'feedback_cluster_proposed',
    );
    expect(evs).toHaveLength(1);
  });

  it('clusters never cross workspace scope', async () => {
    await seedFeedback(WS, 'fb-a1', 'Dark mode contrast is too low');
    await seedFeedback('ws-b', 'fb-b1', 'Dark mode contrast is too low');
    const a = await clusterFeedback(ctx(WS));
    const b = await clusterFeedback(ctx('ws-b'));
    // Identical text in two workspaces → zero clusters (needs ≥2 members
    // in the SAME scope).
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(0);
    await seedFeedback(WS, 'fb-a2', 'Dark mode contrast too low');
    const a2 = await clusterFeedback(ctx(WS));
    expect(a2).toHaveLength(1);
    expect(a2[0]?.members.sort()).toEqual(['fb-a1', 'fb-a2']);
  });
});

// ---------------------------------------------------------------------------
// error mapping sanity (API layer maps kinds to HTTP)
// ---------------------------------------------------------------------------

describe('AlignmentServiceError kinds', () => {
  it('carries kind + optional current for OCC detail', () => {
    const e = new AlignmentServiceError('conflict', 'x', 'dismissed');
    expect(e.kind).toBe('conflict');
    expect(e.current).toBe('dismissed');
  });
});
