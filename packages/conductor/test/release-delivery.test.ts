/**
 * wp-135 tests — deployments, feature exposure, release notes,
 * outcomes, retrospectives (DELIVERY §3 tail + §7) over a real PGlite
 * PostgresStore, plus the transition-table wiring for the `retro` and
 * `release-notes` stages.
 *
 * Covers: manual deployment evidence fail-closed (invariant 4);
 * `available` exposure requiring a linked confirmed deployment;
 * notes draft → human approve → publish with the pinned approved
 * revision; KPI outcomes; retro completion producing draft board
 * proposals only (invariant 6) + `retro_completed`; and the
 * `retro|DONE` / `release-notes|DONE` sentinel rows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@sprint-runner/config';
import type {
  FeatureRow,
  RunResult,
  RunRow,
  Stage,
  TicketRepoRow,
  TicketRow,
  TicketStatus,
} from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApplyStatusOptions,
  RunOutcome,
  TransitionTools,
} from '../src/contracts.js';
import { applyTicketStatus } from '../src/contracts.js';
import type { ReleaseCtx } from '../src/release/index.js';
import {
  ReleaseError,
  addReleaseItem,
  approveRelease,
  approveReleaseNote,
  buildReleaseBundle,
  completeRetro,
  createRelease,
  freezeRelease,
  markReleased,
  publishReleaseNote,
  recordDeployment,
  recordReleaseOutcome,
  registerNotesDraft,
  releaseNotesRunRequest,
  retroRunRequest,
  saveReleaseNoteDraft,
  setFeatureExposure,
} from '../src/release/index.js';
import { RealTransitionHandler } from '../src/transitions/index.js';

const WS = 'ws';
const NOW = '2026-10-06T12:00:00Z';
let dir: string;
let store: PostgresStore;
let ctx: ReleaseCtx;
let handler: RealTransitionHandler;

function ticketRow(
  id: string,
  status: TicketStatus,
  patch: Partial<TicketRow> = {},
): TicketRow {
  const now = new Date().toISOString();
  return {
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `Ticket ${id}`,
    status,
    priority: 'medium',
    depth: 'standard',
    backend: 'mock',
    model: null,
    repos: ['api'],
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    work_type: null,
    origin: null,
    severity: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: now,
    updated_at: now,
    ...patch,
  };
}

async function seedTicket(
  id: string,
  opts: { feature?: string | null } = {},
): Promise<void> {
  await store.upsertTicket(
    ticketRow(id, 'merged', { feature: opts.feature ?? null }),
  );
  const row: TicketRepoRow = {
    workspace: WS,
    ticket_id: id,
    repo: 'api',
    branch: `ticket/${id}`,
    worktree: null,
    pr_url: null,
    pr_state: 'merged',
    ci_state: 'green',
    merged_sha: `sha-${id}`,
  };
  await store.upsertTicketRepo(row);
}

async function seedFeature(id: string, members: string[]): Promise<void> {
  await store.upsertFeature({
    workspace: WS,
    feature: id,
    title: `Feature ${id}`,
    status: 'done',
  } as FeatureRow);
  for (const m of members) await seedTicket(m, { feature: id });
}

/** A fully shipped release containing feature F-0001 → items at
 *  delivery_state 'released'. */
async function seedReleased(): Promise<string> {
  await seedFeature('F-0001', ['SR-0101', 'SR-0102']);
  const rel = await createRelease(ctx, { title: 'v1.0' });
  await addReleaseItem(ctx, rel.release_id, {
    itemKind: 'feature',
    itemId: 'F-0001',
  });
  await freezeRelease(ctx, rel.release_id);
  await approveRelease(ctx, rel.release_id, {
    approver: 'keith',
    actorType: 'human',
    decision: 'approved',
  });
  await markReleased(ctx, rel.release_id);
  return rel.release_id;
}

const goodEvidence = {
  type: 'manual' as const,
  by: 'keith',
  note: 'deployed via ansible run 441',
  url: 'https://ci.example.com/deploys/441',
};

async function eventsOf(subject: string): Promise<string[]> {
  return (await store.listEvents({ workspace: WS, subject })).map(
    (e) => e.event,
  );
}

async function itemStates(rel: string): Promise<Map<string, string>> {
  const items = await store.listReleaseItems({
    workspace: WS,
    release_id: rel,
  });
  return new Map(
    items.map((i) => [`${i.item_kind}:${i.item_id}`, i.delivery_state]),
  );
}

// -- transition-handler plumbing (release subjects are not tickets) --

function tools(): TransitionTools {
  return {
    ...ctx,
    applyTicketStatus: (opts: ApplyStatusOptions) =>
      applyTicketStatus({ ctx, opts }),
    surfaceGateItem: async (item) => {
      await store.upsertGateItem({
        workspace: WS,
        subject: item.subject,
        gate: item.gate,
        kind: item.kind,
        surfaced_at: NOW,
        cleared_at: null,
        blocked_agent: item.blockedAgent ?? false,
        priority: item.priority ?? null,
      });
    },
    appendEvent: (e) =>
      store.appendEvent({
        workspace: WS,
        ticket_id: e.ticketId ?? null,
        ts: NOW,
        stage: e.stage ?? null,
        actor_type: e.actorType ?? 'runner',
        actor_id: ctx.actor,
        event: e.event,
        run: e.run ?? null,
        refs: e.refs ?? [],
        data: e.data ?? {},
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        human_minutes: null,
      }),
    requestRun: async () => null,
    getDocText: async (subject, doc) =>
      (await store.getDoc({ workspace: WS, subject, doc }))?.content ?? null,
    putDoc: async (subject, doc, content) =>
      (
        await store.appendDocVersion(
          { workspace: WS, subject, doc },
          content,
          ctx.actor,
        )
      ).version,
    getArtifactText: async (runId, name) =>
      (await store.getArtifact(runId, name))?.content ?? null,
    putArtifact: async (runId, name, content) => {
      await store.putArtifact({
        run_id: runId,
        name,
        content,
        created_at: NOW,
      });
    },
    getLatestArtifactText: async () => null,
    allocTicketId: () => store.allocTicketId(WS),
  };
}

let runSeq = 0;
async function fakeRun(subject: string, stage: Stage): Promise<RunOutcome> {
  const attempt = ++runSeq;
  const run: RunRow = {
    id: `${WS}/${subject}/${String(attempt).padStart(3, '0')}-${stage}`,
    workspace: WS,
    subject,
    ticket_id: null,
    stage,
    attempt,
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
  await store.createRun(run);
  const result: RunResult = {
    sentinel: 'DONE',
    sentinel_raw: 'DONE',
    artifacts: [],
    usage: null,
    exit_code: 0,
  };
  return { run, result };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-rel135-'));
  store = await PostgresStore.connect('pglite:');
  ctx = {
    workspace: WS,
    rootPath: dir,
    store,
    actor: 'keith',
    now: () => new Date(NOW),
  };
  handler = new RealTransitionHandler(
    resolveConfig(null, {
      config: { actor: 'test-bot', backend: 'mock', repos: {} },
      warnings: [],
      secrets: {},
      files: [],
    }),
  );
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('deployments — manual evidence (invariant 4)', () => {
  it('manual evidence is required and validated — every clause fails closed', async () => {
    const rel = await seedReleased();
    for (const evidence of [
      undefined,
      null,
      {},
      { type: 'webhook', by: 'k', note: 'n', url: 'u' },
      { type: 'probe', by: 'k', note: 'n', url: 'u' },
      { type: 'manual', note: 'n', url: 'u' }, // no by
      { type: 'manual', by: 'k', url: 'u' }, // no note
      { type: 'manual', by: 'k', note: 'n' }, // no url
      { type: 'manual', by: '  ', note: 'n', url: 'u' }, // blank by
    ]) {
      await expect(
        recordDeployment(ctx, rel, {
          environment: 'prod',
          sha: 'abc123',
          evidence,
        }),
      ).rejects.toMatchObject({ code: 'invalid-evidence' });
    }
    expect(await store.listDeployments({ workspace: WS })).toHaveLength(0);
  });

  it('deploys only on released|closed; a confirmed deployment flips items → deployed and emits deployment_confirmed', async () => {
    const rel = await seedReleased();

    // Draft-ish releases can't deploy.
    const pending = await createRelease(ctx, { title: 'v-next' });
    await expect(
      recordDeployment(ctx, pending.release_id, {
        environment: 'prod',
        sha: 'abc',
        evidence: goodEvidence,
      }),
    ).rejects.toMatchObject({ code: 'bad-state' });

    const dep = await recordDeployment(ctx, rel, {
      environment: 'prod',
      sha: 'deadbeef'.repeat(5),
      evidence: goodEvidence,
    });
    expect(dep.deployment_id).toMatch(/^dep-/);
    expect(dep.confirmed_by).toBe('keith');
    expect(dep.confirmed_at).toBe(new Date(NOW).toISOString());
    expect(dep.evidence.type).toBe('manual');

    expect(await itemStates(rel)).toEqual(
      new Map([['feature:F-0001', 'deployed']]),
    );
    const evs = await store.listEvents({
      workspace: WS,
      ticket_id: rel,
      event: 'deployment_confirmed',
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]?.refs).toEqual([dep.deployment_id]);
    expect(evs[0]?.data.environment).toBe('prod');

    // Second env deploys keep working and stay 'deployed'.
    await recordDeployment(ctx, rel, {
      environment: 'staging',
      sha: 'deadbeef'.repeat(5),
      evidence: goodEvidence,
    });
    expect((await itemStates(rel)).get('feature:F-0001')).toBe('deployed');
  });
});

describe('feature exposure — available requires a linked deployment (invariant 4)', () => {
  it('fails closed: missing, unknown, unconfirmed, wrong-env, or non-member deployments all reject', async () => {
    const rel = await seedReleased();

    await expect(
      setFeatureExposure(ctx, 'F-0001', {
        environment: 'prod',
        state: 'available',
      }),
    ).rejects.toMatchObject({ code: 'no-deployment' });

    await expect(
      setFeatureExposure(ctx, 'F-0001', {
        environment: 'prod',
        state: 'available',
        deploymentId: 'dep-nope',
      }),
    ).rejects.toMatchObject({ code: 'no-deployment' });

    // An unconfirmed row (bypassing the engine) is not a link target.
    await store.insertDeployment({
      workspace: WS,
      deployment_id: 'dep-unconfirmed',
      release_id: rel,
      environment: 'prod',
      sha: 'abc',
      evidence: goodEvidence,
      confirmed_by: null,
      confirmed_at: null,
      created_at: NOW,
    });
    await expect(
      setFeatureExposure(ctx, 'F-0001', {
        environment: 'prod',
        state: 'available',
        deploymentId: 'dep-unconfirmed',
      }),
    ).rejects.toMatchObject({ code: 'no-deployment' });

    const dep = await recordDeployment(ctx, rel, {
      environment: 'prod',
      sha: 'aaa',
      evidence: goodEvidence,
    });
    // Env mismatch: deployment was prod, exposure claims staging.
    await expect(
      setFeatureExposure(ctx, 'F-0001', {
        environment: 'staging',
        state: 'available',
        deploymentId: dep.deployment_id,
      }),
    ).rejects.toMatchObject({ code: 'no-deployment' });

    // The deployment's release doesn't carry F-9999.
    await seedFeature('F-9999', []);
    await expect(
      setFeatureExposure(ctx, 'F-9999', {
        environment: 'prod',
        state: 'available',
        deploymentId: dep.deployment_id,
      }),
    ).rejects.toMatchObject({ code: 'no-deployment' });
  });

  it('available → row + feature_exposed + items → exposed; rollback to hidden reverts to deployed', async () => {
    const rel = await seedReleased();
    const dep = await recordDeployment(ctx, rel, {
      environment: 'prod',
      sha: 'aaa',
      evidence: goodEvidence,
    });

    // hidden/limited need no deployment.
    const limited = await setFeatureExposure(ctx, 'F-0001', {
      environment: 'prod',
      state: 'limited',
      audience: 'beta',
      evidence: 'flagged cohort',
    });
    expect(limited.state).toBe('limited');
    expect(limited.deployment_id).toBeNull();

    const row = await setFeatureExposure(ctx, 'F-0001', {
      environment: 'prod',
      state: 'available',
      deploymentId: dep.deployment_id,
    });
    expect(row.deployment_id).toBe(dep.deployment_id);
    expect((await itemStates(rel)).get('feature:F-0001')).toBe('exposed');

    const evs = await store.listEvents({
      workspace: WS,
      ticket_id: 'F-0001',
      event: 'feature_exposed',
    });
    expect(evs).toHaveLength(2); // limited + available
    expect(evs.at(-1)?.data.state).toBe('available');
    expect(evs.at(-1)?.refs).toContain(dep.deployment_id);

    // Rollback — the materialized state returns to 'deployed'.
    await setFeatureExposure(ctx, 'F-0001', {
      environment: 'prod',
      state: 'hidden',
    });
    expect((await itemStates(rel)).get('feature:F-0001')).toBe('deployed');
  });
});

describe('release notes — draft → human approve → publish', () => {
  it('per-audience flow with the approved revision pinned', async () => {
    const rel = await seedReleased();

    // Publish before anything exists fails closed.
    await expect(
      publishReleaseNote(ctx, rel, { audience: 'customer' }),
    ).rejects.toMatchObject({ code: 'not-approved' });
    // Approve without a draft fails closed.
    await expect(
      approveReleaseNote(ctx, rel, {
        audience: 'customer',
        approver: 'keith',
        actorType: 'human',
      }),
    ).rejects.toMatchObject({ code: 'bad-state' });
    // Unknown audience fails closed.
    await expect(
      saveReleaseNoteDraft(ctx, rel, { audience: 'robots', content: 'x' }),
    ).rejects.toMatchObject({ code: 'bad-item' });

    await saveReleaseNoteDraft(ctx, rel, {
      audience: 'customer',
      content: '# v1.0\nFaster everything.',
    });
    const drafted = await store.getReleaseNote({
      workspace: WS,
      release_id: rel,
      audience: 'customer',
    });
    expect(drafted?.doc_version).toBeNull(); // approved revision only
    expect(drafted?.approved_by).toBeNull();

    // An agent can never approve (invariant 6).
    await expect(
      approveReleaseNote(ctx, rel, {
        audience: 'customer',
        approver: 'agent:notes',
        actorType: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'ai-approval' });
    await expect(
      publishReleaseNote(ctx, rel, { audience: 'customer' }),
    ).rejects.toMatchObject({ code: 'not-approved' });

    const approved = await approveReleaseNote(ctx, rel, {
      audience: 'customer',
      approver: 'keith',
      actorType: 'human',
    });
    expect(approved.doc_version).toBe(1);
    expect(approved.approved_by).toBe('keith');
    expect(approved.approved_at).toBe(new Date(NOW).toISOString());
    const evs = await store.listEvents({
      workspace: WS,
      ticket_id: rel,
      event: 'release_note_approved',
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]?.data).toMatchObject({
      audience: 'customer',
      doc_version: 1,
    });

    const published = await publishReleaseNote(ctx, rel, {
      audience: 'customer',
    });
    expect(published.published_at).toBe(new Date(NOW).toISOString());

    // A newer draft does not launder itself into the published note —
    // doc_version stays pinned at the approved revision.
    await saveReleaseNoteDraft(ctx, rel, {
      audience: 'customer',
      content: '# v1.0 (edited)\nActually, even faster.',
    });
    const after = await store.getReleaseNote({
      workspace: WS,
      release_id: rel,
      audience: 'customer',
    });
    expect(after?.doc_version).toBe(1);
    expect(after?.published_at).toBe(new Date(NOW).toISOString());

    // The other audiences are independent rows.
    const tech = await store.getReleaseNote({
      workspace: WS,
      release_id: rel,
      audience: 'technical',
    });
    expect(tech).toBeNull();
  });

  it('registerNotesDraft is all-or-nothing — a missing audience doc writes no rows', async () => {
    const rel = await seedReleased();
    await store.appendDocVersion(
      { workspace: WS, subject: rel, doc: 'notes-customer.md' },
      'customer notes',
      'agent',
    );
    const res = await registerNotesDraft(ctx, rel);
    expect(res.drafted).toEqual([]);
    expect(res.missing.sort()).toEqual(['stakeholder', 'technical']);
    expect(
      await store.listReleaseNotes({ workspace: WS, release_id: rel }),
    ).toHaveLength(0);

    await store.appendDocVersion(
      { workspace: WS, subject: rel, doc: 'notes-stakeholder.md' },
      'stakeholder notes',
      'agent',
    );
    await store.appendDocVersion(
      { workspace: WS, subject: rel, doc: 'notes-technical.md' },
      'technical notes',
      'agent',
    );
    const ok = await registerNotesDraft(ctx, rel);
    expect(ok.missing).toEqual([]);
    expect(ok.drafted.sort()).toEqual(['customer', 'stakeholder', 'technical']);
    const rows = await store.listReleaseNotes({
      workspace: WS,
      release_id: rel,
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.approved_by === null)).toBe(true);
  });
});

describe('release outcomes', () => {
  it('records KPI baseline/target/observed; empty payload fails closed', async () => {
    const rel = await seedReleased();
    const row = await recordReleaseOutcome(ctx, rel, {
      kpi: 'activation_rate',
      baseline: 0.41,
      target: 0.5,
      observed: 0.52,
      unit: 'ratio',
    });
    expect(row.data.observed).toBe(0.52);
    expect(row.measured_at).toBe(new Date(NOW).toISOString());
    const rows = await store.listReleaseOutcomes({
      workspace: WS,
      release_id: rel,
    });
    expect(rows).toHaveLength(1);

    await expect(
      recordReleaseOutcome(ctx, rel, { kpi: 'empty' }),
    ).rejects.toMatchObject({ code: 'bad-item' });
    await expect(
      recordReleaseOutcome(ctx, 'REL-9999', { kpi: 'x', target: 1 }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('retro — run request + completion (DELIVERY §7)', () => {
  it('retro/notes run requests validate the release state', async () => {
    const draft = await createRelease(ctx, { title: 'v-draft' });
    await expect(retroRunRequest(ctx, draft.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });
    await expect(
      releaseNotesRunRequest(ctx, draft.release_id),
    ).rejects.toMatchObject({ code: 'bad-state' });

    const rel = await seedReleased();
    const retro = await retroRunRequest(ctx, rel);
    expect(retro).toMatchObject({ subject: rel, stage: 'retro' });
    const notes = await releaseNotesRunRequest(ctx, rel);
    expect(notes).toMatchObject({ subject: rel, stage: 'release-notes' });
  });

  it('RELEASE_MD bundle carries manifest, deployments, exposure, outcomes', async () => {
    const rel = await seedReleased();
    await recordDeployment(ctx, rel, {
      environment: 'prod',
      sha: 'deadbeef'.repeat(5),
      evidence: goodEvidence,
    });
    await recordReleaseOutcome(ctx, rel, {
      kpi: 'activation_rate',
      baseline: 0.41,
      target: 0.5,
      observed: 0.52,
      unit: 'ratio',
    });
    const md = await buildReleaseBundle(ctx, rel);
    expect(md).toContain(`# Release ${rel}`);
    expect(md).toContain('status: released');
    expect(md).toContain('Manifest v1');
    expect(md).toContain('F-0001');
    expect(md).toContain('## Deployments');
    expect(md).toContain('prod');
    expect(md).toContain('activation_rate');
    expect(md).toContain('0.52');
    expect(md).toContain('## Release notes');
  });

  it('completeRetro commits retro.md + draft board proposals, never scope', async () => {
    const rel = await seedReleased();
    const dep = await recordDeployment(ctx, rel, {
      environment: 'prod',
      sha: 'abc',
      evidence: goodEvidence,
    });
    await store.appendDocVersion(
      { workspace: WS, subject: rel, doc: 'retro.md' },
      '# retro\nAll good.',
      'agent:retro',
    );
    const run = await fakeRun(rel, 'retro');
    await store.putArtifact({
      run_id: run.run.id,
      name: 'retro-proposals.json',
      content: JSON.stringify({
        schema: 1,
        proposals: [
          { title: 'Cache warmer for cold starts', refs: ['SR-0101'] },
          { title: 'Split deploy checklist' },
        ],
      }),
      created_at: NOW,
    });

    const res = await completeRetro(ctx, rel, { runId: run.run.id });
    expect(res.docVersion).toBe(1);
    expect(res.proposalIds).toHaveLength(2);

    const items = await store.listBoardItems({ workspace: WS });
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.kind).toBe('retro');
      expect(it.board).toBeNull(); // capture tray
      expect(it.status).toBe('icebox'); // draft — not committed scope
      expect(it.provenance).toBe('inferred'); // ai-suggested
      expect(it.ref).toBe(rel);
    }
    expect(
      items.find((i) => i.title === 'Cache warmer for cold starts')?.applies_to,
    ).toEqual(['SR-0101']);

    const evs = await store.listEvents({
      workspace: WS,
      ticket_id: rel,
      event: 'retro_completed',
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]?.data.proposal_count).toBe(2);
    expect(evs[0]?.run).toBe(run.run.id);

    // No silent scope writes — release items are untouched.
    expect((await itemStates(rel)).get('feature:F-0001')).toBe('deployed');
    expect(dep.release_id).toBe(rel);
  });

  it('fails closed: no retro.md, malformed proposals, or unshipped release', async () => {
    const rel = await seedReleased();
    const run = await fakeRun(rel, 'retro');
    await expect(
      completeRetro(ctx, rel, { runId: run.run.id }),
    ).rejects.toMatchObject({ code: 'bad-state' });

    await store.appendDocVersion(
      { workspace: WS, subject: rel, doc: 'retro.md' },
      '# retro',
      'agent:retro',
    );
    await store.putArtifact({
      run_id: run.run.id,
      name: 'retro-proposals.json',
      content: '{ not json',
      created_at: NOW,
    });
    await expect(
      completeRetro(ctx, rel, { runId: run.run.id }),
    ).rejects.toMatchObject({ code: 'bad-item' });
    // Nothing committed — no board items, no event.
    expect(await store.listBoardItems({ workspace: WS })).toHaveLength(0);
    expect(
      await store.listEvents({
        workspace: WS,
        ticket_id: rel,
        event: 'retro_completed',
      }),
    ).toHaveLength(0);

    const draft = await createRelease(ctx, { title: 'v-draft' });
    await expect(completeRetro(ctx, draft.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });
  });
});

describe('sentinel wiring — retro | DONE, release-notes | DONE', () => {
  it('retro DONE run on a release completes via the transition table', async () => {
    const rel = await seedReleased();
    await store.appendDocVersion(
      { workspace: WS, subject: rel, doc: 'retro.md' },
      '# retro\nShipped.',
      'agent:retro',
    );
    const outcome = await fakeRun(rel, 'retro');
    await handler.onRunComplete(outcome, tools());
    const evs = await store.listEvents({
      workspace: WS,
      ticket_id: rel,
      event: 'retro_completed',
    });
    expect(evs).toHaveLength(1);
  });

  it('release-notes DONE registers rows; missing docs → repair gate, no rows', async () => {
    const rel = await seedReleased();
    for (const a of ['customer', 'stakeholder', 'technical'] as const) {
      await store.appendDocVersion(
        { workspace: WS, subject: rel, doc: `notes-${a}.md` },
        `${a} notes`,
        'agent:notes',
      );
    }
    await handler.onRunComplete(await fakeRun(rel, 'release-notes'), tools());
    const rows = await store.listReleaseNotes({
      workspace: WS,
      release_id: rel,
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.doc_version === null)).toBe(true);

    // Fail-closed half: DONE with only two docs surfaces a repair gate.
    const rel2 = await createRelease(ctx, { title: 'v2' });
    const rel2Row = await store.getRelease({
      workspace: WS,
      release_id: rel2.release_id,
    });
    expect(rel2Row).toBeTruthy();
    if (!rel2Row) throw new Error('release row missing');
    await store.upsertRelease({
      ...rel2Row,
      status: 'released',
    });
    await store.appendDocVersion(
      { workspace: WS, subject: rel2.release_id, doc: 'notes-customer.md' },
      'x',
      'agent:notes',
    );
    await handler.onRunComplete(
      await fakeRun(rel2.release_id, 'release-notes'),
      tools(),
    );
    expect(
      await store.listReleaseNotes({
        workspace: WS,
        release_id: rel2.release_id,
      }),
    ).toHaveLength(0);
    const gates = await store.listGateItems({ workspace: WS });
    expect(
      gates.some(
        (g) => g.subject === rel2.release_id && g.gate === 'release-notes',
      ),
    ).toBe(true);
    expect((await eventsOf(rel2.release_id)).includes('run_failed')).toBe(true);
  });
});
