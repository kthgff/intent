/**
 * wp-148 tests — Review Studio engine (PRD §15.8).
 *
 * Real PostgresStore on PGlite; the engine functions are exercised
 * directly (the API layer is a thin shell over the same calls). Covers:
 *   - findings lifecycle legality + permissioned terminal dispositions
 *     (rationale + human) + append-only finding_resolutions audit;
 *   - blocking human findings: AI may propose, never self-resolve;
 *   - review sessions + append-only revisions (head_sha + baseline pin);
 *   - commit-bound decisions + stale-approval detection on new commits;
 *   - the server-side "Changes Since Your Review" delta;
 *   - semantic comments + out-of-scope → ChangeSet routing;
 *   - requirement-first AC → code → test evidence resolution;
 *   - idempotent evidence links + external mappings;
 *   - review.json → studio projection (sync).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ReviewFindingRow,
  ReviewFindingStatus,
  RunBaseline,
  RunRow,
} from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addComment,
  approvalState,
  changesSince,
  ensureSession,
  evidenceKind,
  linkEvidence,
  listComments,
  listDecisions,
  listEvidenceLinks,
  listExternalMappings,
  mapExternal,
  reclassifyComment,
  recordDecision,
  recordRevision,
  requirementView,
  syncReviewStudio,
  transitionBlocked,
  transitionFinding,
  unlinkEvidence,
  upsertFinding,
} from '../src/review/studio/index.js';
import type { StudioCtx } from '../src/review/studio/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let dir: string;
let store: PostgresStore;
let clock: number;

/** A mutable clock — pin times must differ for the delta view's
 *  "transitions after the bound pin" filter to see real ordering. */
function ctx(): StudioCtx & { rootPath: string } {
  return {
    store,
    workspace: WS,
    rootPath: dir,
    actor: 'test-actor',
    now: () => new Date(clock),
  };
}

const tick = (ms = 60_000) => {
  clock += ms;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-studio-'));
  store = await PostgresStore.connect('pglite:');
  clock = T0;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function findingRow(
  over: Partial<ReviewFindingRow> & { finding_id: string },
): ReviewFindingRow {
  return {
    workspace: WS,
    org: null,
    review_id: 'rv-SR-0001',
    revision: 1,
    subject: null,
    status: 'open',
    severity: 'major',
    category: 'correctness',
    kind: 'code-bug',
    thread_id: 'f-aaaa',
    file: 'src/a.ts',
    line: 40,
    symbol: null,
    repo: 'code-repo',
    body: 'off-by-one drops the last row',
    evidence: null,
    suggested_fix: null,
    confidence: null,
    blocking: false,
    security_category: null,
    affected_asset: null,
    exposure: null,
    policy_violated: null,
    author: 'review-bot',
    created_at: null,
    updated_at: null,
    ...over,
  };
}

async function seedSession(
  subject = 'SR-0001',
): Promise<{ review_id: string }> {
  const s = await ensureSession(ctx(), { subject });
  return { review_id: s.review_id };
}

const BASELINE_A: RunBaseline = {
  rs_version: 3,
  ticket_rev: 2,
  design_rev: 1,
  ac_ids: ['AC-1', 'AC-2'],
  base_sha: null,
  contract_ver: null,
};

let runSeq = 0;
async function seedRun(
  subject: string,
  ticketId: string,
  artifacts: Record<string, string> = {},
): Promise<RunRow> {
  const id = `${WS}/${subject}/${String(++runSeq).padStart(3, '0')}-review`;
  await store.createRun({
    id,
    workspace: WS,
    subject,
    ticket_id: ticketId,
    stage: 'review',
    attempt: runSeq,
    backend: 'mock',
    model: null,
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: null,
    status: 'done',
    started_at: new Date(clock).toISOString(),
    heartbeat_at: null,
    exited_at: new Date(clock).toISOString(),
    sentinel: 'PASS-COMPLETE',
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: null,
  });
  for (const [name, content] of Object.entries(artifacts)) {
    await store.putArtifact({
      run_id: id,
      name,
      content,
      created_at: new Date(clock).toISOString(),
    });
  }
  return (await store.getRun(id)) as RunRow;
}

// ---------------------------------------------------------------------------
// transitionBlocked — pure lifecycle legality
// ---------------------------------------------------------------------------

describe('transitionBlocked (pure)', () => {
  const f = (status: string, blocking = false) => ({
    status: status as ReviewFindingStatus,
    blocking,
  });

  it('forward moves along the main path are always legal (fast-forward ok)', () => {
    for (const to of [
      'triaged',
      'in-remediation',
      'ready-for-verification',
      'resolved',
    ] as const) {
      expect(transitionBlocked(f('open'), to, 'human')).toBeNull();
      expect(transitionBlocked(f('open'), to, 'agent')).toBeNull();
    }
    expect(transitionBlocked(f('triaged'), 'in-remediation', 'human')).toBeNull();
    expect(transitionBlocked(f('open'), 'resolved', 'system')).toBeNull();
  });

  it('backward moves are blocked — except verification-failed back to remediation', () => {
    expect(transitionBlocked(f('in-remediation'), 'triaged', 'human')).toMatch(
      /cannot regress/,
    );
    expect(
      transitionBlocked(f('ready-for-verification'), 'triaged', 'human'),
    ).toMatch(/cannot regress/);
    // The ONE real backward edge: verification found it incomplete.
    expect(
      transitionBlocked(f('ready-for-verification'), 'in-remediation', 'human'),
    ).toBeNull();
    expect(
      transitionBlocked(f('ready-for-verification'), 'in-remediation', 'agent'),
    ).toBeNull();
  });

  it('re-open to open is human-only, from any non-open state', () => {
    expect(transitionBlocked(f('resolved'), 'open', 'human')).toBeNull();
    expect(transitionBlocked(f('accepted-risk'), 'open', 'human')).toBeNull();
    expect(transitionBlocked(f('triaged'), 'open', 'agent')).toMatch(/human/);
    expect(transitionBlocked(f('triaged'), 'open', 'system')).toMatch(/human/);
    expect(transitionBlocked(f('open'), 'open', 'agent')).toBeNull(); // no-op
  });

  it('settled findings only leave via re-open', () => {
    for (const from of [
      'resolved',
      'accepted-risk',
      'not-applicable',
      'duplicate',
      'deferred-with-approval',
    ] as const) {
      expect(transitionBlocked(f(from), 'triaged', 'human')).toMatch(
        /terminal|settled/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// transitionFinding — audit-backed lifecycle
// ---------------------------------------------------------------------------

describe('transitionFinding', () => {
  it('walks the main path, appending one finding_resolutions row per move', async () => {
    await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-1' }));

    const path: ReviewFindingStatus[] = [
      'triaged',
      'in-remediation',
      'ready-for-verification',
      'resolved',
    ];
    for (const to of path) {
      const r = await transitionFinding(ctx(), {
        findingId: 'f-1',
        to,
        actor: 'keith',
        actorKind: 'human',
      });
      expect(r.finding.status).toBe(to);
      expect(r.resolution?.status).toBe(to);
    }
    const history = await store.listFindingResolutions({
      workspace: WS,
      finding_id: 'f-1',
    });
    // seq 0 = creation, then one row per move.
    expect(history.map((h) => h.status)).toEqual(['open', ...path]);
    expect(history.map((h) => h.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('creation writes the seq-0 open audit row; no-op is a read, never a write', async () => {
    await seedSession();
    const { finding, created } = await upsertFinding(
      ctx(),
      findingRow({ finding_id: 'f-2' }),
    );
    expect(created).toBe(true);
    expect(finding.status).toBe('open');
    expect(
      await store.listFindingResolutions({
        workspace: WS,
        finding_id: 'f-2',
      }),
    ).toHaveLength(1);

    const noop = await transitionFinding(ctx(), {
      findingId: 'f-2',
      to: 'open',
      actor: 'keith',
    });
    expect(noop.resolution).toBeNull();
    expect(
      await store.listFindingResolutions({
        workspace: WS,
        finding_id: 'f-2',
      }),
    ).toHaveLength(1);
  });

  it('upsert refreshes content but never regresses lifecycle status', async () => {
    await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-3' }));
    await transitionFinding(ctx(), {
      findingId: 'f-3',
      to: 'triaged',
      actor: 'k',
    });
    const { finding, created } = await upsertFinding(
      ctx(),
      findingRow({ finding_id: 'f-3', status: 'open', body: 'reworded' }),
    );
    expect(created).toBe(false);
    expect(finding.status).toBe('triaged'); // status did NOT regress
    expect(finding.body).toBe('reworded');
  });

  it('terminal dispositions require a rationale AND a human actor', async () => {
    await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-4' }));

    // No rationale → invalid.
    await expect(
      transitionFinding(ctx(), {
        findingId: 'f-4',
        to: 'accepted-risk',
        actor: 'keith',
        actorKind: 'human',
      }),
    ).rejects.toMatchObject({ code: 'invalid-transition' });

    // Machine actor + rationale → forbidden.
    await expect(
      transitionFinding(ctx(), {
        findingId: 'f-4',
        to: 'not-applicable',
        actor: 'review-bot',
        actorKind: 'agent',
        rationale: 'not a real defect',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // Human + rationale → settled.
    const r = await transitionFinding(ctx(), {
      findingId: 'f-4',
      to: 'accepted-risk',
      actor: 'keith',
      actorKind: 'human',
      rationale: 'documented trade-off, accepted by owner',
    });
    expect(r.finding.status).toBe('accepted-risk');
    expect(r.resolution?.rationale).toContain('trade-off');
  });

  it('AI may propose resolution but never self-resolves a BLOCKING human finding', async () => {
    await seedSession();
    await upsertFinding(
      ctx(),
      findingRow({ finding_id: 'f-5', blocking: true }),
    );

    // Propose → allowed.
    const propose = await transitionFinding(ctx(), {
      findingId: 'f-5',
      to: 'ready-for-verification',
      actor: 'fix-bot',
      actorKind: 'agent',
    });
    expect(propose.finding.status).toBe('ready-for-verification');

    // Self-resolve → forbidden (blocking human finding).
    await expect(
      transitionFinding(ctx(), {
        findingId: 'f-5',
        to: 'resolved',
        actor: 'fix-bot',
        actorKind: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      transitionFinding(ctx(), {
        findingId: 'f-5',
        to: 'not-applicable',
        actor: 'fix-bot',
        actorKind: 'agent',
        rationale: 'claims not applicable',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // A human closes it.
    const done = await transitionFinding(ctx(), {
      findingId: 'f-5',
      to: 'resolved',
      actor: 'keith',
      actorKind: 'human',
    });
    expect(done.finding.status).toBe('resolved');
  });

  it('a non-blocking finding CAN be agent-resolved (proposals welcome)', async () => {
    await seedSession();
    await upsertFinding(
      ctx(),
      findingRow({ finding_id: 'f-6', blocking: false }),
    );
    const r = await transitionFinding(ctx(), {
      findingId: 'f-6',
      to: 'resolved',
      actor: 'fix-bot',
      actorKind: 'agent',
    });
    expect(r.finding.status).toBe('resolved');
  });

  it('human re-open works from a terminal disposition', async () => {
    await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-7' }));
    await transitionFinding(ctx(), {
      findingId: 'f-7',
      to: 'duplicate',
      actor: 'keith',
      rationale: 'dup of f-1',
    });
    const r = await transitionFinding(ctx(), {
      findingId: 'f-7',
      to: 'open',
      actor: 'keith',
      rationale: 'not actually the same bug',
    });
    expect(r.finding.status).toBe('open');
  });

  it('missing finding → not-found', async () => {
    await expect(
      transitionFinding(ctx(), {
        findingId: 'nope',
        to: 'triaged',
        actor: 'k',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

// ---------------------------------------------------------------------------
// sessions + revisions + commit-bound approvals
// ---------------------------------------------------------------------------

describe('sessions, revisions, stale approvals', () => {
  it('ensureSession is deterministic + idempotent', async () => {
    const a = await ensureSession(ctx(), { subject: 'SR-0001' });
    const b = await ensureSession(ctx(), { subject: 'SR-0001' });
    expect(a.review_id).toBe('rv-SR-0001');
    expect(b.review_id).toBe(a.review_id);
    expect(a.status).toBe('open');
  });

  it('recordRevision pins head+baseline; identical pin is a no-op; moved head appends', async () => {
    const { review_id } = await seedSession();
    const r1 = await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    expect(r1.revision.revision).toBe(1);
    expect(r1.created).toBe(true);

    const same = await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: { ...BASELINE_A },
    });
    expect(same.created).toBe(false);
    expect(same.revision.revision).toBe(1);

    const r2 = await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-b',
      baseline: BASELINE_A,
    });
    expect(r2.created).toBe(true);
    expect(r2.revision.revision).toBe(2);
    const revisions = await store.listReviewRevisions({
      workspace: WS,
      review_id,
    });
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
  });

  it('recordDecision refuses without a pinned revision; binds the LATEST pin', async () => {
    const { review_id } = await seedSession();
    await expect(
      recordDecision(ctx(), {
        reviewId: review_id,
        decisionId: 'd-0',
        reviewer: 'keith',
        action: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    const { decision, session } = await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-1',
      reviewer: 'keith',
      action: 'approve',
      rationale: 'lgtm',
    });
    expect(decision.revision).toBe(1);
    expect(decision.head_sha).toBe('sha-a');
    expect(decision.baseline).toMatchObject({ rs_version: 3 });
    expect(session.status).toBe('approved');
    expect(
      (await approvalState(ctx(), review_id))[0]?.currency,
    ).toBe('current');
  });

  it('new commits after approval → stale approval + session falls back to open + ledger event', async () => {
    const { review_id } = await seedSession();
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-1',
      reviewer: 'keith',
      action: 'approve',
    });
    expect(
      (await store.getReviewSession({ workspace: WS, review_id }))?.status,
    ).toBe('approved');

    tick();
    const r2 = await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-b',
      baseline: BASELINE_A,
    });
    expect(r2.stale_approvals.map((d) => d.decision_id)).toEqual(['d-1']);
    expect(
      (await store.getReviewSession({ workspace: WS, review_id }))?.status,
    ).toBe('open');
    expect(
      (await approvalState(ctx(), review_id))[0]?.currency,
    ).toBe('stale');

    const events = await store.listEvents({
      workspace: WS,
      ticket_id: 'SR-0001',
    });
    const staleEvt = events.find(
      (e) => e.data?.reason === 'stale-approval',
    );
    expect(staleEvt).toBeTruthy();
    expect(staleEvt?.data).toMatchObject({
      from: 'approved',
      to: 'open',
      new_revision: 2,
    });
  });

  it('a moved spec BASELINE (same head) also stales the approval', async () => {
    const { review_id } = await seedSession();
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-1',
      reviewer: 'keith',
      action: 'approve',
    });
    const r = await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: { ...BASELINE_A, rs_version: 4 },
    });
    expect(r.created).toBe(true); // baseline moved → new pin
    expect(r.stale_approvals.map((d) => d.decision_id)).toEqual(['d-1']);
  });

  it('a non-approval latest word supersedes an older approval (rollup = changes-requested)', async () => {
    const { review_id } = await seedSession();
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-1',
      reviewer: 'keith',
      action: 'approve',
    });
    await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-2',
      reviewer: 'keith',
      action: 'request-changes',
      rationale: 'missed the migration',
    });
    const states = await approvalState(ctx(), review_id);
    expect(states[0]?.currency).toBe('superseded');
    expect(
      (await store.getReviewSession({ workspace: WS, review_id }))?.status,
    ).toBe('changes-requested');
  });

  it('decision ids are idempotent — a retry returns the durable row, never a double verdict', async () => {
    const { review_id } = await seedSession();
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-1',
      reviewer: 'keith',
      action: 'approve',
    });
    const again = await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-1',
      reviewer: 'keith',
      action: 'request-changes', // different payload, same id
    });
    expect(again.decision.action).toBe('approve'); // original wins
    const decisions = await listDecisions(ctx(), review_id);
    expect(decisions.filter((d) => d.decision_id === 'd-1')).toHaveLength(1);
  });

  it('send-to-board captures a tray board_item (feedback, icebox)', async () => {
    const { review_id } = await seedSession();
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    const { board_item } = await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-b1',
      reviewer: 'keith',
      action: 'send-to-board',
      rationale: 'wider rethink needed',
    });
    expect(board_item?.kind).toBe('feedback');
    expect(board_item?.board).toBeNull(); // tray
    expect(board_item?.applies_to).toEqual(['SR-0001']);
    expect(
      (await store.listBoardItems({ workspace: WS })).some(
        (b) => b.id === board_item?.id,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// changesSince — "Changes Since Your Review" delta
// ---------------------------------------------------------------------------

describe('changesSince', () => {
  it('resolves the reviewer’s bound revision → head moved, new findings, transitions', async () => {
    const { review_id } = await seedSession();
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    await upsertFinding(
      ctx(),
      findingRow({ finding_id: 'f-old', revision: 1 }),
    );
    // Reviewer approves at r1.
    tick();
    await recordDecision(ctx(), {
      reviewId: review_id,
      decisionId: 'd-1',
      reviewer: 'keith',
      action: 'approve',
    });
    // New commits + spec move + another finding + a transition.
    tick();
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-b',
      baseline: { ...BASELINE_A, rs_version: 4 },
    });
    await upsertFinding(
      ctx(),
      findingRow({ finding_id: 'f-new', revision: 2, thread_id: 'f-bbbb' }),
    );
    await transitionFinding(ctx(), {
      findingId: 'f-old',
      to: 'triaged',
      actor: 'keith',
    });

    const delta = await changesSince(ctx(), {
      reviewId: review_id,
      reviewer: 'keith',
      diffFn: async (from, to) => [
        { repo: 'code-repo', diff: `${from}..${to} fake-diff` },
      ],
    });
    expect(delta.from_revision).toBe(1);
    expect(delta.to_revision).toBe(2);
    expect(delta.head).toEqual({ from_sha: 'sha-a', to_sha: 'sha-b' });
    expect(delta.baseline_changed).toBe(true);
    expect(delta.baseline_changes.rs_version).toEqual({ from: 3, to: 4 });
    expect(delta.findings_added.map((f) => f.finding_id)).toEqual(['f-new']);
    // Creation audit (f-new:open) + the later transition both landed
    // after the bound pin — the delta reports both.
    expect(
      delta.finding_transitions
        .map((t) => `${t.finding_id}:${t.status}`)
        .sort(),
    ).toEqual(['f-new:open', 'f-old:triaged']);
    expect(delta.diff?.[0]?.diff).toContain('sha-a..sha-b');
  });

  it('explicit from_revision works; missing reviewer/from → bad-request', async () => {
    const { review_id } = await seedSession();
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-a',
      baseline: BASELINE_A,
    });
    await recordRevision(ctx(), {
      reviewId: review_id,
      headSha: 'sha-b',
      baseline: BASELINE_A,
    });
    const delta = await changesSince(ctx(), {
      reviewId: review_id,
      fromRevision: 1,
    });
    expect(delta.from_revision).toBe(1);
    await expect(changesSince(ctx(), { reviewId: review_id })).rejects
      .toMatchObject({ code: 'bad-request' });
    await expect(
      changesSince(ctx(), { reviewId: review_id, reviewer: 'nobody' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      changesSince(ctx(), { reviewId: review_id, fromRevision: 99 }),
    ).rejects.toMatchObject({ code: 'bad-request' });
  });
});

// ---------------------------------------------------------------------------
// comments — semantic types + out-of-scope → ChangeSet
// ---------------------------------------------------------------------------

describe('comments + changeset routing', () => {
  it('an ordinary comment lands with type/disposition and no changeset', async () => {
    const { review_id } = await seedSession();
    const { comment, changeset_id } = await addComment(ctx(), {
      reviewId: review_id,
      commentId: 'cm-1',
      body: 'why not early-return here?',
      type: 'question',
      disposition: 'question',
      file: 'src/a.ts',
      line: 40,
    });
    expect(comment.type).toBe('question');
    expect(changeset_id).toBeNull();
    expect(await store.listChangesets({ workspace: WS })).toHaveLength(0);
  });

  it('out-of-scope routes to a draft ChangeSet — request verbatim, baseline pinned, comment linked', async () => {
    await seedSession();
    // Pin the spec doc head so the changeset baseline carries it.
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0001', doc: 'rs.md' },
      '# spec v1\n',
      'seed',
    );
    const { comment, changeset_id } = await addComment(ctx(), {
      reviewId: 'rv-SR-0001',
      commentId: 'cm-2',
      body: 'also support SAML SSO please',
      type: 'out-of-scope',
    });
    expect(changeset_id).toBe('cs-cm-2');
    expect(comment.changeset_id).toBe('cs-cm-2');

    const cs = await store.getChangeset({
      workspace: WS,
      changeset_id: 'cs-cm-2',
    });
    expect(cs?.status).toBe('draft');
    expect(cs?.request).toBe('also support SAML SSO please');
    expect(cs?.baseline).toMatchObject({
      subject: 'SR-0001',
      doc: 'rs.md',
      version: 1,
    });
    // Routing is auditable.
    const events = await store.listEvents({
      workspace: WS,
      ticket_id: 'SR-0001',
    });
    expect(
      events.some(
        (e) => e.event === 'changeset_created' && e.data?.changeset_id === 'cs-cm-2',
      ),
    ).toBe(true);
  });

  it('AI-proposed classification routes too — the effective type decides', async () => {
    await seedSession();
    const { changeset_id } = await addComment(ctx(), {
      reviewId: 'rv-SR-0001',
      commentId: 'cm-3',
      body: 'can we also do dark mode',
      aiClassification: { type: 'out-of-scope', confidence: 0.81 },
    });
    expect(changeset_id).toBe('cs-cm-3');
    const c = (await listComments(ctx(), { reviewId: 'rv-SR-0001' }))[0];
    expect(c?.ai_classification).toMatchObject({ type: 'out-of-scope' });
  });

  it('reclassify TO out-of-scope routes lazily; reclassify AWAY keeps the changeset row', async () => {
    await seedSession();
    await addComment(ctx(), {
      reviewId: 'rv-SR-0001',
      commentId: 'cm-4',
      body: 'could the API also paginate',
      type: 'improvement',
    });
    const routed = await reclassifyComment(ctx(), {
      reviewId: 'rv-SR-0001',
      commentId: 'cm-4',
      type: 'out-of-scope',
    });
    expect(routed.changeset_id).toBe('cs-cm-4');

    const back = await reclassifyComment(ctx(), {
      reviewId: 'rv-SR-0001',
      commentId: 'cm-4',
      type: 'improvement',
    });
    // wp-140 owns the lifecycle — the drafted set stays (abandoned is a
    // lifecycle move, not a delete).
    expect(back.comment.changeset_id).toBe('cs-cm-4');
    expect(
      await store.getChangeset({ workspace: WS, changeset_id: 'cs-cm-4' }),
    ).toBeTruthy();
  });

  it('empty body fails closed', async () => {
    await seedSession();
    await expect(
      addComment(ctx(), {
        reviewId: 'rv-SR-0001',
        commentId: 'cm-5',
        body: '   ',
      }),
    ).rejects.toMatchObject({ code: 'bad-request' });
  });
});

// ---------------------------------------------------------------------------
// requirement-first + evidence links + external mappings
// ---------------------------------------------------------------------------

describe('requirement-first view + evidence links + external mappings', () => {
  it('resolves AC → implementing code + test evidence + linked refs + run artifacts', async () => {
    const { review_id } = await seedSession();
    // Semantic edges the schema carries (wp-110 commit-pinned refs land
    // as objects — the view passes them through).
    await store.upsertRelation({
      subject: 'ac:AC-1',
      predicate: 'implements',
      object: 'ev_src_a_login',
      source: 'explicit',
    });
    await store.upsertRelation({
      subject: 'ac:AC-1',
      predicate: 'tests',
      object: 'ev_test_login_spec',
      source: 'explicit',
    });
    await store.upsertRelation({
      subject: 'ac:AC-1',
      predicate: 'calls', // NOT a code/test edge — excluded
      object: 'ev_other',
      source: 'explicit',
    });
    await upsertFinding(
      ctx(),
      findingRow({
        finding_id: 'f-ac1',
        subject: 'AC-1',
        body: 'login does not lock out after 5 tries',
      }),
    );
    await linkEvidence(ctx(), {
      reviewId: review_id,
      findingId: 'f-ac1',
      evidenceRef: 'run:ws/SR-0001/001-verify:test-report.json',
    });
    // The verification plane — latest test-report.json run_artifact.
    await seedRun('SR-0001', 'SR-0001', {
      'test-report.json': '{"schema":1,"results":[]}',
    });

    const view = await requirementView(ctx(), {
      reviewId: review_id,
      acId: 'AC-1',
    });
    expect(view.implementing.map((r) => r.object)).toEqual([
      'ev_src_a_login',
    ]);
    expect(view.test_edges.map((r) => r.object)).toEqual([
      'ev_test_login_spec',
    ]);
    expect(view.findings.map((f) => f.finding_id)).toEqual(['f-ac1']);
    expect(view.evidence_refs).toEqual([
      'run:ws/SR-0001/001-verify:test-report.json',
    ]);
    expect(view.run_evidence).toEqual([
      'run:ws/SR-0001/001-review:test-report.json',
    ]);
  });

  it('evidence links are idempotent; kind is inferred from the ref scheme', async () => {
    const { review_id } = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-e' }));
    expect(evidenceKind('ac:AC-1')).toBe('requirement');
    expect(evidenceKind('doc:ticket.md:3')).toBe('doc');
    expect(evidenceKind('run:r:test-report.json')).toBe('run-artifact');
    expect(evidenceKind('ev_src_a')).toBe('code-unit');
    expect(evidenceKind('screenshot://x')).toBe('manual');

    await linkEvidence(ctx(), {
      reviewId: review_id,
      findingId: 'f-e',
      evidenceRef: 'ev_src_a',
    });
    await linkEvidence(ctx(), {
      reviewId: review_id,
      findingId: 'f-e',
      evidenceRef: 'ev_src_a', // duplicate collapses
    });
    const links = await listEvidenceLinks(ctx(), {
      reviewId: review_id,
      findingId: 'f-e',
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.kind).toBe('code-unit');

    await unlinkEvidence(ctx(), {
      reviewId: review_id,
      findingId: 'f-e',
      evidenceRef: 'ev_src_a',
    });
    expect(
      await listEvidenceLinks(ctx(), { reviewId: review_id }),
    ).toHaveLength(0);
  });

  it('external mappings are idempotent correspondences — never approval proxies', async () => {
    const { review_id } = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-x' }));
    const m1 = await mapExternal(ctx(), {
      reviewId: review_id,
      findingId: 'f-x',
      externalKind: 'github-review-thread',
      externalId: 'PRRT_kwDOABc123',
    });
    const m2 = await mapExternal(ctx(), {
      reviewId: review_id,
      findingId: 'f-x',
      externalKind: 'github-review-thread',
      externalId: 'PRRT_kwDOABc123',
    });
    const list = await listExternalMappings(ctx(), {
      reviewId: review_id,
      findingId: 'f-x',
    });
    expect(list).toHaveLength(1);
    expect(m2.external_id).toBe(m1.external_id);
    await expect(
      mapExternal(ctx(), {
        reviewId: review_id,
        findingId: 'nope',
        externalKind: 'k',
        externalId: 'x',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

// ---------------------------------------------------------------------------
// syncReviewStudio — review.json → studio projection
// ---------------------------------------------------------------------------

describe('syncReviewStudio', () => {
  const reviewJson = (status: string) =>
    JSON.stringify({
      schema: 1,
      ticket: 'SR-0001',
      round: 1,
      passes: ['correctness', 'security', 'spec-compliance', 'test-gap'],
      findings: [
        {
          thread_id: 'f-aaaa',
          status,
          severity: 'major',
          category: 'correctness',
          kind: 'code-bug',
          file: 'src/a.ts',
          line: 40,
          repo: 'code-repo',
          body: 'off-by-one drops the last row',
        },
      ],
    });

  it('projects threads + head pin into durable rows; later syncs move the lifecycle', async () => {
    await store.upsertTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0001',
      repo: 'code-repo',
      branch: 'sr-0001',
      worktree: '/wt/sr-0001',
      pr_url: null,
      pr_state: null,
      ci_state: null,
      merged_sha: null,
    });
    await seedRun('SR-0001', 'SR-0001', { 'review.json': reviewJson('open') });

    const headFor = async (_wt: string, _repo: string) => 'sha-one';
    const r1 = await syncReviewStudio(ctx(), {
      ticketId: 'SR-0001',
      headFor,
    });
    expect(r1.review_id).toBe('rv-SR-0001');
    expect(r1.revision).toBe(1);
    expect(r1.revision_created).toBe(true);
    expect(r1.findings_created).toBe(1);

    const fid = 'rv-SR-0001:f-aaaa';
    const f = await store.getReviewFinding({
      workspace: WS,
      finding_id: fid,
    });
    expect(f?.status).toBe('open');
    expect(f?.thread_id).toBe('f-aaaa');
    expect(f?.body).toContain('off-by-one');

    // Thread went fixed in review.json → lifecycle moves to
    // ready-for-verification (audit-backed).
    tick();
    await seedRun('SR-0001', 'SR-0001', {
      'review.json': reviewJson('fixed'),
    });
    const r2 = await syncReviewStudio(ctx(), {
      ticketId: 'SR-0001',
      headFor,
    });
    expect(r2.findings_transitioned).toBe(1);
    expect(
      (await store.getReviewFinding({ workspace: WS, finding_id: fid }))
        ?.status,
    ).toBe('ready-for-verification');

    // A reopened thread moves it back into remediation; the head pin
    // moving appends a revision too.
    tick();
    await seedRun('SR-0001', 'SR-0001', {
      'review.json': reviewJson('reopened'),
    });
    const r3 = await syncReviewStudio(ctx(), {
      ticketId: 'SR-0001',
      headFor: async () => 'sha-two',
    });
    expect(r3.revision).toBe(2);
    expect(
      (await store.getReviewFinding({ workspace: WS, finding_id: fid }))
        ?.status,
    ).toBe('in-remediation');
  });

  it('is idempotent — re-syncing the same artifacts is a no-op', async () => {
    await store.upsertTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0001',
      repo: 'code-repo',
      branch: null,
      worktree: '/wt/sr-0001',
      pr_url: null,
      pr_state: null,
      ci_state: null,
      merged_sha: null,
    });
    await seedRun('SR-0001', 'SR-0001', { 'review.json': reviewJson('open') });
    const headFor = async () => 'sha-one';
    await syncReviewStudio(ctx(), { ticketId: 'SR-0001', headFor });
    const again = await syncReviewStudio(ctx(), {
      ticketId: 'SR-0001',
      headFor,
    });
    expect(again.revision_created).toBe(false);
    expect(again.findings_created).toBe(0);
    expect(again.findings_transitioned).toBe(0);
  });
});
