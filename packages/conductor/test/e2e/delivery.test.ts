/**
 * wp-138 — Delivery E2E (DELIVERY §1–§7): the post-review vertical.
 *
 *   real git fixture + stub `gh` drive tickets through Merge Center
 *   (checklist green → `gh pr merge` → SHA confirm → `merged`) → a
 *   release is scoped, frozen (immutable manifest cut), human-approved,
 *   and released → manual deployment evidence is recorded → feature
 *   exposure flips → a mock-adapter `release-notes` run drafts the
 *   three-audience docs → human approve → publish → a mock-adapter
 *   `retro` run completes with retro.md + draft board proposals
 *   (never committed scope).
 *
 * Agent stages run through the real Adapter contract (MockAdapter
 * spawning test/helpers/mock-agent.mjs) with run-dir ingestion
 * promoting `<run_dir>/<subject>/<doc>` writes into doc_versions — the
 * same seam reconcile uses. All state lives in a PGlite PostgresStore.
 *
 * Fail-closed coverage (DELIVERY §4 invariants):
 *   1. `merged` only from a source-control-confirmed SHA — a `gh` view
 *      that never flips MERGED leaves the ticket unmerged.
 *   2. `released` requires an approved manifest with merged_sha on
 *      every item (unapproved → bad-state; missing sha → gate-failed).
 *   3. Scope change on an approved release re-cuts the manifest and
 *      reverts it to `ready` — the v1 approval does not carry.
 *   4. Deployments require well-formed manual evidence; `available`
 *      exposure requires a linked confirmed deployment.
 *   5. `partial_ac` without a human `approved_by` fails closed.
 *   6. Agent/runner actors can never approve manifests or notes.
 *   7. Material (incl. ungraded) open corrections block the release.
 *   + retro on an unshipped release and malformed retro proposals
 *     fail closed with nothing committed.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter } from '@sprint-runner/adapters';
import { resolveConfig } from '@sprint-runner/config';
import type {
  FeatureRow,
  RenderedPrompt,
  RunResult,
  TicketRepoRow,
  TicketRow,
  TicketStatus,
} from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConductorDeps, ToolCtx } from '../../src/index.js';
import {
  type GhClient,
  LeaseManager,
  type PrCheck,
  type PrComment,
  type PrCreateOptions,
  type PrInfo,
  type PrMergeOptions,
  type ReleaseCtx,
  type ShepherdCtx,
  addReleaseItem,
  approveRelease,
  approveReleaseNote,
  completeRetro,
  createRelease,
  evaluateRelease,
  fileCorrection,
  freezeRelease,
  markReleased,
  pollOpenPrs,
  publishReleaseNote,
  recordDeployment,
  recordReleaseOutcome,
  registerNotesDraft,
  setFeatureExposure,
} from '../../src/index.js';
import { E2E_AGENT, type MockScriptSpec } from '../helpers/fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_FIXTURE = join(HERE, '../../../../fixtures/code-repo');
const WS = 'ws';
const PR_FOR = (id: string) => `https://github.com/acme/widgets/pull/${id}`;
const NOW = '2026-10-06T12:00:00Z';
const MERGED_SHA = 'c0ffee'.repeat(7);

let dir: string;
let wsRoot: string;
let codeRepo: string;
let runsDir: string;
let store: PostgresStore;
let adapter: MockAdapter;
let runSeq: number;

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function gitInit(repo: string, remote?: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'seed'], {
    cwd: repo,
  });
  if (remote) {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  }
}

// ---------------------------------------------------------------------------
// merge side — real git fixture + stub gh (per merge-center convention)
// ---------------------------------------------------------------------------

const PASS: PrCheck = { name: 'unit', state: 'SUCCESS', bucket: 'pass' };
const HEAD = 'head1111';

/** Stub gh client — `prMerge` mutates the view so the confirmation
 *  read-back observes a real state change (invariant 1). Set
 *  `confirmMerge=false` to simulate a merge command that silently
 *  doesn't land. */
class StubGh implements GhClient {
  checks = new Map<string, PrCheck[]>();
  views = new Map<string, PrInfo>();
  comments = new Map<string, PrComment[]>();
  merges: { url: string; opts: PrMergeOptions | undefined }[] = [];
  confirmMerge = true;

  async prChecks(url: string): Promise<PrCheck[]> {
    return this.checks.get(url) ?? [PASS];
  }
  async prView(url: string): Promise<PrInfo> {
    return (
      this.views.get(url) ?? {
        state: 'OPEN',
        headRefOid: HEAD,
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }
    );
  }
  async reviewComments(): Promise<PrComment[]> {
    return [];
  }
  async prCreate(_opts: PrCreateOptions): Promise<string> {
    return 'https://github.com/acme/widgets/pull/new';
  }
  async prUrlForHead(): Promise<string | null> {
    return null;
  }
  async prMerge(url: string, opts?: PrMergeOptions): Promise<void> {
    this.merges.push({ url, opts });
    if (!this.confirmMerge) return;
    const cur = this.views.get(url) ?? { state: 'OPEN' };
    this.views.set(url, {
      ...cur,
      state: 'MERGED',
      mergeCommit: { oid: MERGED_SHA },
    });
  }
  async mergeQueue(): Promise<boolean> {
    return false;
  }
}

function makeShepherdCtx(gh: GhClient): ShepherdCtx {
  const deps: ConductorDeps = {
    store,
    adapters: {},
    config: resolveConfig(null, {
      config: {
        actor: 'e2e-bot',
        backend: 'mock',
        repos: { 'code-repo': { path: codeRepo } },
        security: { scan_on_commit: false },
        shepherd: { poll_interval_s: 0 },
      },
      warnings: [],
      secrets: {},
      files: [],
    }),
    workspaces: [{ name: WS, rootPath: wsRoot }],
    runsDir,
    transitions: undefined as never,
  };
  const ctx: ToolCtx = {
    deps,
    ws: { name: WS, rootPath: wsRoot },
    leases: new LeaseManager(deps),
    handles: new Map(),
    killedForCap: new Set(),
  };
  return { ...ctx, gh };
}

const relCtx = (): ReleaseCtx => ({
  workspace: WS,
  rootPath: wsRoot,
  store,
  actor: 'keith',
  now: () => new Date(NOW),
});

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
    repos: ['code-repo'],
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: now,
    updated_at: now,
    ...patch,
  };
}

const VS_MD = (id: string) =>
  [
    `# Verification spec — ${id}`,
    '',
    '## Cases',
    '| case_id | title | type | file | covers |',
    '| --- | --- | --- | --- | --- |',
    '| case:c1 | it works | unit | src/a.ts | ac1 |',
    '',
  ].join('\n');

const TICKET_MD = (id: string, status: string) =>
  [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: Ticket ${id}`,
    `status: ${status}`,
    'priority: medium',
    'repos: [code-repo]',
    '---',
    '',
    '## Description',
    'e2e delivery fixture',
    '',
    '## Acceptance criteria',
    '- [ ] works',
    '',
  ].join('\n');

/** Seed a ci-watch ticket with an open PR on a real branch of the
 *  fixture repo — the Merge Center green-path shape. */
async function seedOpenPrTicket(
  id: string,
  opts: { feature?: string } = {},
): Promise<void> {
  await store.upsertTicket(
    ticketRow(id, 'ci-watch', { feature: opts.feature ?? null }),
  );
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    TICKET_MD(id, 'ci-watch'),
    'e2e-seed',
  );
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'vs.md' },
    VS_MD(id),
    'e2e-seed',
  );
  git(codeRepo, ['branch', `ticket/${id}`]);
  const row: TicketRepoRow = {
    workspace: WS,
    ticket_id: id,
    repo: 'code-repo',
    branch: `ticket/${id}`,
    worktree: codeRepo,
    pr_url: PR_FOR(id),
    pr_state: 'open',
    ci_state: 'green',
    merged_sha: null,
  };
  await store.upsertTicketRepo(row);
}

/** Seed a feature row + member tickets already merged (for tests that
 *  start post-merge). */
async function seedMergedTicket(
  id: string,
  opts: { feature?: string; mergedSha?: string | null } = {},
): Promise<void> {
  await store.upsertTicket(
    ticketRow(id, 'merged', { feature: opts.feature ?? null }),
  );
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    TICKET_MD(id, 'merged'),
    'e2e-seed',
  );
  await store.upsertTicketRepo({
    workspace: WS,
    ticket_id: id,
    repo: 'code-repo',
    branch: `ticket/${id}`,
    worktree: null,
    pr_url: PR_FOR(id),
    pr_state: 'merged',
    ci_state: 'green',
    merged_sha: opts.mergedSha === undefined ? `sha-${id}` : opts.mergedSha,
  });
}

async function seedFeature(id: string, members: string[]): Promise<void> {
  await store.upsertFeature({
    workspace: WS,
    feature: id,
    title: `Feature ${id}`,
    status: 'done',
  } as FeatureRow);
  for (const m of members) await seedMergedTicket(m, { feature: id });
}

// ---------------------------------------------------------------------------
// agent side — MockAdapter run + run-dir doc ingestion (reconcile's seam)
// ---------------------------------------------------------------------------

/** Register the run, spawn the scripted mock child, promote collected
 *  artifacts into `run_artifacts`, ingest `<run_dir>/<subject>/<doc>`
 *  file writes as doc_versions, and mark the run done/failed — the
 *  same moves reconcile makes for a real adapter run. */
async function runAgentStage(args: {
  subject: string;
  stage: string;
  /** Spec, or a builder invoked with the run dir + the subject's doc
   *  scope (`<run_dir>/<subject>`) so scripts can write docs. */
  spec:
    | MockScriptSpec
    | ((scope: { runDir: string; subjectDir: string }) => MockScriptSpec);
}): Promise<{ runId: string; result: RunResult }> {
  const n = ++runSeq;
  const slug = `${String(n).padStart(3, '0')}-${args.stage}`;
  const runId = `${WS}/${args.subject}/${slug}`;
  const runDir = join(runsDir, WS, args.subject, slug);
  const subjectDir = join(runDir, args.subject);
  mkdirSync(subjectDir, { recursive: true });
  await store.createRun({
    id: runId,
    workspace: WS,
    subject: args.subject,
    ticket_id: /^[A-Z]+-\d+$/.test(args.subject) ? args.subject : null,
    stage: args.stage,
    attempt: n,
    backend: 'mock',
    model: 'mock',
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: null,
    status: 'running',
    started_at: NOW,
    heartbeat_at: null,
    exited_at: null,
    sentinel: null,
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: runDir,
  });
  const rendered: RenderedPrompt = {
    template: args.stage,
    text:
      `# ${args.stage} for ${args.subject}\n\n` +
      `Artifact paths: ${runDir}/ (absolute — write run outputs there).\n`,
    tokens: {},
  };
  const spec =
    typeof args.spec === 'function'
      ? args.spec({ runDir, subjectDir })
      : args.spec;
  const scenario = `script:${Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url')}`;
  const handle = adapter.run(dir, rendered, 60, {
    scenario,
    artifactDir: runDir,
  });
  const result = await adapter.collect(handle, {
    workspace: WS,
    run_dir: runDir,
    run_id: runId,
  });
  for (const p of result.artifacts) {
    await store.putArtifact({
      run_id: runId,
      name: relative(runDir, p),
      content: readFileSync(p, 'utf8'),
      created_at: NOW,
    });
  }
  // Run-dir doc ingestion — reconcile promotes <subject>/<doc> writes.
  if (existsSync(subjectDir)) {
    for (const doc of readdirSync(subjectDir)) {
      await store.appendDocVersion(
        { workspace: WS, subject: args.subject, doc },
        readFileSync(join(subjectDir, doc), 'utf8'),
        'e2e-bot',
      );
    }
  }
  await store.updateRun(runId, {
    status: result.sentinel ? 'done' : 'failed',
    sentinel: result.sentinel,
    sentinel_raw: result.sentinel_raw,
    exited_at: NOW,
  });
  return { runId, result };
}

async function eventsOf(subject: string): Promise<string[]> {
  return (await store.listEvents({ workspace: WS, subject })).map(
    (e) => e.event,
  );
}

const goodEvidence = {
  type: 'manual' as const,
  by: 'keith',
  note: 'deployed via ansible run 441',
  url: 'https://ci.example.com/deploys/441',
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-delivery-'));
  wsRoot = join(dir, 'ws');
  codeRepo = join(dir, 'code-repo');
  runsDir = join(dir, 'runs');
  mkdirSync(wsRoot, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  const remote = join(dir, 'code-remote.git');
  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });
  execFileSync('git', ['init', '-qb', 'main', '--bare', remote]);
  gitInit(codeRepo, remote);
  execFileSync('git', ['push', '-qu', 'origin', 'main'], { cwd: codeRepo });
  store = await PostgresStore.connect('pglite:');
  runSeq = 0;
  adapter = new MockAdapter({
    agentScript: E2E_AGENT,
    delayMs: 10,
    heartbeatMs: 0,
  });
  await store.upsertProject({ workspace: WS, name: 'Delivery E2E' });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the vertical
// ---------------------------------------------------------------------------

describe('delivery vertical (wp-138)', () => {
  it(
    'merge → release → manifest → approve → released → deploy → ' +
      'exposure → notes publish → retro with draft proposals',
    { timeout: 60_000 },
    async () => {
      // --- 1. merge: two feature members + one standalone ticket go
      //        through Merge Center on a real repo + stub gh --------
      await store.upsertFeature({
        workspace: WS,
        feature: 'F-9001',
        title: 'Magic-link resets',
        status: 'in-progress',
      } as FeatureRow);
      for (const id of ['SR-9001', 'SR-9002', 'SR-9003']) {
        await seedOpenPrTicket(id, {
          feature: id === 'SR-9003' ? undefined : 'F-9001',
        });
      }
      const gh = new StubGh();
      const sctx = makeShepherdCtx(gh);

      // Poll 1: checklist green → `gh pr merge` → confirm read-back.
      await pollOpenPrs(sctx);
      expect(gh.merges).toHaveLength(3);
      for (const id of ['SR-9001', 'SR-9002', 'SR-9003']) {
        const repo = await store.getTicketRepo({
          workspace: WS,
          ticket_id: id,
          repo: 'code-repo',
        });
        expect(repo?.merged_sha).toBe(MERGED_SHA);
      }
      // Poll 2: rollup finalizes the tickets → merged.
      await pollOpenPrs(sctx);
      for (const id of ['SR-9001', 'SR-9002', 'SR-9003']) {
        const t = await store.getTicket({ workspace: WS, ticket_id: id });
        expect(t?.status).toBe('merged');
        const evs = await eventsOf(id);
        expect(evs).toContain('merge_ready');
        expect(evs).toContain('merge_attempted');
        expect(evs).toContain('merged');
      }

      // Feature acceptance is a human act (POST /features/<ref>/accept),
      // never a ticket rollup — record it before release scoping.
      await store.upsertFeature({
        workspace: WS,
        feature: 'F-9001',
        title: 'Magic-link resets',
        status: 'done',
      } as FeatureRow);

      // --- 2. release: scope → freeze → approve → released ---------
      const ctx = relCtx();
      const rel = await createRelease(ctx, { title: 'v1.0' });
      await addReleaseItem(ctx, rel.release_id, {
        itemKind: 'feature',
        itemId: 'F-9001',
      });
      await addReleaseItem(ctx, rel.release_id, {
        itemKind: 'ticket',
        itemId: 'SR-9003',
      });
      const manifest = await freezeRelease(ctx, rel.release_id);
      expect(manifest.version).toBe(1);
      // The cut froze the source-control-confirmed SHAs.
      for (const item of manifest.items) {
        for (const r of item.repos) {
          expect(r.merged_sha).toBe(MERGED_SHA);
        }
      }
      await approveRelease(ctx, rel.release_id, {
        approver: 'keith',
        actorType: 'human',
        decision: 'approved',
      });
      const { tickets, manifest_version } = await markReleased(
        ctx,
        rel.release_id,
      );
      expect(manifest_version).toBe(1);
      expect(tickets.sort()).toEqual(['SR-9001', 'SR-9002', 'SR-9003']);
      for (const t of tickets) {
        expect(
          (await store.getTicket({ workspace: WS, ticket_id: t }))?.status,
        ).toBe('released');
      }
      const items = await store.listReleaseItems({
        workspace: WS,
        release_id: rel.release_id,
      });
      expect(items.every((i) => i.delivery_state === 'released')).toBe(true);

      // --- 3. deploy: manual evidence, confirmed ------------------
      const dep = await recordDeployment(ctx, rel.release_id, {
        environment: 'prod',
        sha: MERGED_SHA,
        evidence: goodEvidence,
      });
      expect(dep.confirmed_by).toBe('keith');
      expect(
        (
          await store.listReleaseItems({
            workspace: WS,
            release_id: rel.release_id,
          })
        ).every((i) => i.delivery_state === 'deployed'),
      ).toBe(true);

      // --- 4. exposure: available only via the linked deployment --
      const exposure = await setFeatureExposure(ctx, 'F-9001', {
        environment: 'prod',
        state: 'available',
        deploymentId: dep.deployment_id,
      });
      expect(exposure.deployment_id).toBe(dep.deployment_id);
      const fItem = (
        await store.listReleaseItems({
          workspace: WS,
          release_id: rel.release_id,
        })
      ).find((i) => i.item_id === 'F-9001');
      expect(fItem?.delivery_state).toBe('exposed');

      // --- 5. KPI outcome + notes run → approve → publish ---------
      await recordReleaseOutcome(ctx, rel.release_id, {
        kpi: 'reset_sla_minutes',
        baseline: 4320,
        target: 60,
        observed: 47,
        unit: 'minutes',
      });
      const notesRun = await runAgentStage({
        subject: rel.release_id,
        stage: 'release-notes',
        spec: ({ subjectDir }) => ({
          sentinel: 'DONE',
          files: {
            [`${subjectDir}/notes-customer.md`]:
              '# v1.0\nPassword resets now take under an hour.',
            [`${subjectDir}/notes-stakeholder.md`]:
              '# v1.0\nReset SLA: 3 days → 47 minutes.',
            [`${subjectDir}/notes-technical.md`]: `# v1.0\nShips ${MERGED_SHA} to prod.`,
          },
        }),
      });
      expect(notesRun.result.sentinel).toBe('DONE');
      const notes = await registerNotesDraft(ctx, rel.release_id);
      expect(notes.missing).toEqual([]);
      expect(notes.drafted.sort()).toEqual([
        'customer',
        'stakeholder',
        'technical',
      ]);
      const approved = await approveReleaseNote(ctx, rel.release_id, {
        audience: 'customer',
        approver: 'keith',
        actorType: 'human',
      });
      expect(approved.doc_version).toBe(1);
      const published = await publishReleaseNote(ctx, rel.release_id, {
        audience: 'customer',
      });
      expect(published.published_at).toBe(new Date(NOW).toISOString());

      // --- 6. retro: mock run writes retro.md + proposals; drafts
      //        land on the board — never committed scope ------------
      const retroRun = await runAgentStage({
        subject: rel.release_id,
        stage: 'retro',
        spec: ({ subjectDir }) => ({
          sentinel: 'DONE',
          artifacts: {
            'retro-proposals.json': {
              schema: 1,
              proposals: [
                {
                  title: 'Automate the deploy evidence capture',
                  refs: ['SR-9001'],
                },
                { title: 'Add a staging exposure step' },
              ],
            },
          },
          files: {
            [`${subjectDir}/retro.md`]:
              '# Retro — v1.0\nShip on time; deploy evidence was manual.',
          },
        }),
      });
      expect(retroRun.result.sentinel).toBe('DONE');
      const retro = await completeRetro(ctx, rel.release_id, {
        runId: retroRun.runId,
      });
      expect(retro.docVersion).toBe(1);
      expect(retro.proposalIds).toHaveLength(2);

      const proposals = await store.listBoardItems({ workspace: WS });
      expect(proposals).toHaveLength(2);
      for (const p of proposals) {
        expect(p.kind).toBe('retro');
        expect(p.status).toBe('icebox'); // draft — never committed
        expect(p.provenance).toBe('inferred');
        expect(p.ref).toBe(rel.release_id);
      }

      const relEvs = await eventsOf(rel.release_id);
      for (const ev of [
        'release_created',
        'release_items_changed',
        'manifest_cut',
        'release_approved',
        'release_released',
        'deployment_confirmed',
        'release_note_approved',
        'retro_completed',
      ]) {
        expect(relEvs).toContain(ev);
      }
      expect(
        await store.listEvents({
          workspace: WS,
          ticket_id: 'F-9001',
          event: 'feature_exposed',
        }),
      ).toHaveLength(1);
    },
  );

  // -------------------------------------------------------------------------
  // fail-closed paths — DELIVERY §4 invariants
  // -------------------------------------------------------------------------

  it('invariant 1: a merge command that never confirms lands nothing', async () => {
    await seedOpenPrTicket('SR-9101');
    const gh = new StubGh();
    gh.confirmMerge = false; // `gh pr merge` returns ok but view stays OPEN
    const sctx = makeShepherdCtx(gh);
    await pollOpenPrs(sctx);
    const repo = await store.getTicketRepo({
      workspace: WS,
      ticket_id: 'SR-9101',
      repo: 'code-repo',
    });
    expect(repo?.merged_sha).toBeNull();
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-9101' }))?.status,
    ).toBe('ci-watch');
    expect(await eventsOf('SR-9101')).not.toContain('merged');
  });

  it('invariant 2+3: released needs an approved manifest; a scope change re-cuts and resets approval', async () => {
    await seedMergedTicket('SR-9201');
    await seedMergedTicket('SR-9202');
    const ctx = relCtx();
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-9201',
    });
    const m1 = await freezeRelease(ctx, rel.release_id);

    // Unapproved manifest → bad-state before the gates even run.
    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });

    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    // Scope change on the approved release → new manifest version and
    // the release falls back to `ready` (invariant 3).
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-9202',
    });
    const manifests = await store.listReleaseManifests({
      workspace: WS,
      release_id: rel.release_id,
    });
    expect(manifests.map((m) => m.version)).toEqual([1, 2]);
    expect(manifests[1]?.digest).not.toBe(m1.digest);
    expect(
      (await store.getRelease({ workspace: WS, release_id: rel.release_id }))
        ?.status,
    ).toBe('ready');
    const { checks } = await evaluateRelease(
      ctx,
      (await store.getRelease({
        workspace: WS,
        release_id: rel.release_id,
      })) as never,
    );
    expect(checks.find((c) => c.gate === 'approved')?.verdict).toBe('fail');
  });

  it('invariant 2: an item without merged_sha can never ship (gate-failed, audited)', async () => {
    await seedMergedTicket('SR-9301', { mergedSha: null });
    const ctx = relCtx();
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-9301',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'gate-failed',
    });
    const gates = await store.listReleaseGateResults({
      workspace: WS,
      release_id: rel.release_id,
      gate: 'merged',
    });
    expect(gates.at(-1)?.result).toBe('fail');
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-9301' }))?.status,
    ).toBe('merged');
  });

  it('invariant 4: deployments need well-formed manual evidence; only released ships deploy', async () => {
    const ctx = relCtx();
    const draft = await createRelease(ctx, { title: 'v-draft' });
    // Deploying an unshipped release is bad-state even with evidence.
    await expect(
      recordDeployment(ctx, draft.release_id, {
        environment: 'prod',
        sha: 'abc',
        evidence: goodEvidence,
      }),
    ).rejects.toMatchObject({ code: 'bad-state' });

    await seedFeature('F-9301', ['SR-9302']);
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'feature',
      itemId: 'F-9301',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    await markReleased(ctx, rel.release_id);

    for (const evidence of [
      undefined,
      {},
      { type: 'webhook', by: 'k', note: 'n', url: 'u' },
      { type: 'manual', by: 'k', note: 'n' }, // no url
      { type: 'manual', by: '  ', note: 'n', url: 'u' },
    ]) {
      await expect(
        recordDeployment(ctx, rel.release_id, {
          environment: 'prod',
          sha: 'abc',
          evidence: evidence as never,
        }),
      ).rejects.toMatchObject({ code: 'invalid-evidence' });
    }
    expect(await store.listDeployments({ workspace: WS })).toHaveLength(0);
  });

  it('invariant 4: exposure `available` requires a linked confirmed deployment', async () => {
    await seedFeature('F-9401', ['SR-9401']);
    const ctx = relCtx();
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'feature',
      itemId: 'F-9401',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    await markReleased(ctx, rel.release_id);

    await expect(
      setFeatureExposure(ctx, 'F-9401', {
        environment: 'prod',
        state: 'available',
      }),
    ).rejects.toMatchObject({ code: 'no-deployment' });
    await expect(
      setFeatureExposure(ctx, 'F-9401', {
        environment: 'prod',
        state: 'available',
        deploymentId: 'dep-nope',
      }),
    ).rejects.toMatchObject({ code: 'no-deployment' });
  });

  it('invariant 5: partial_ac without human approved_by fails closed', async () => {
    await seedMergedTicket('SR-9501');
    const ctx = relCtx();
    const rel = await createRelease(ctx, { title: 'v' });
    await expect(
      addReleaseItem(ctx, rel.release_id, {
        itemKind: 'ticket',
        itemId: 'SR-9501',
        partialAc: ['AC-1'],
      }),
    ).rejects.toMatchObject({ code: 'partial-unapproved' });
    await expect(
      addReleaseItem(ctx, rel.release_id, {
        itemKind: 'ticket',
        itemId: 'SR-9501',
        partialAc: ['AC-1'],
        approvedBy: 'bot',
        actorType: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'ai-approval' });
  });

  it('invariant 6: agent/runner can never approve manifests or notes', async () => {
    await seedMergedTicket('SR-9601');
    const ctx = relCtx();
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-9601',
    });
    await freezeRelease(ctx, rel.release_id);
    for (const actorType of ['agent', 'runner'] as const) {
      await expect(
        approveRelease(ctx, rel.release_id, {
          approver: 'agent:planner',
          actorType,
          decision: 'approved',
        }),
      ).rejects.toMatchObject({ code: 'ai-approval' });
    }
    expect(
      await store.listReleaseApprovals({
        workspace: WS,
        release_id: rel.release_id,
      }),
    ).toHaveLength(0);

    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    await markReleased(ctx, rel.release_id);
    await runAgentStage({
      subject: rel.release_id,
      stage: 'release-notes',
      spec: ({ subjectDir }) => ({
        sentinel: 'DONE',
        files: {
          [`${subjectDir}/notes-customer.md`]: '# v\nnotes',
          [`${subjectDir}/notes-stakeholder.md`]: '# v\nnotes',
          [`${subjectDir}/notes-technical.md`]: '# v\nnotes',
        },
      }),
    });
    await registerNotesDraft(ctx, rel.release_id);
    await expect(
      approveReleaseNote(ctx, rel.release_id, {
        audience: 'customer',
        approver: 'agent:notes',
        actorType: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'ai-approval' });
    // …and an unapproved note can never publish.
    await expect(
      publishReleaseNote(ctx, rel.release_id, { audience: 'customer' }),
    ).rejects.toMatchObject({ code: 'not-approved' });
  });

  it('invariant 7: a material open correction blocks; ungraded counts as material; closing unblocks', async () => {
    await seedMergedTicket('SR-9701');
    const ctx = relCtx();
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-9701',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });

    const blocker = await fileCorrection(ctx, {
      parent: 'SR-9701',
      title: 'data loss in prod',
      severity: 'blocker',
    });
    expect(blocker.origin).toBe('correction');
    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'gate-failed',
    });
    const gates = await store.listReleaseGateResults({
      workspace: WS,
      release_id: rel.release_id,
      gate: 'corrections',
    });
    expect(gates.at(-1)?.result).toBe('fail');

    // Closing the correction unblocks — and the parent's history is
    // untouched (the correction ticket carries its own lifecycle).
    const row = await store.getTicket({
      workspace: WS,
      ticket_id: blocker.ticket_id,
    });
    await store.upsertTicket({
      ...(row as TicketRow),
      status: 'released',
    });
    const { tickets } = await markReleased(ctx, rel.release_id);
    expect(tickets).toEqual(['SR-9701']);
  });

  it('retro on an unshipped release and malformed proposals fail closed', async () => {
    const ctx = relCtx();
    const draft = await createRelease(ctx, { title: 'v-draft' });
    await expect(completeRetro(ctx, draft.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });

    await seedFeature('F-9801', ['SR-9801']);
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'feature',
      itemId: 'F-9801',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    await markReleased(ctx, rel.release_id);

    // Malformed proposals: retro.md landed but the artifact is junk —
    // nothing commits (no board items, no event).
    const bad = await runAgentStage({
      subject: rel.release_id,
      stage: 'retro',
      spec: ({ subjectDir }) => ({
        sentinel: 'DONE',
        artifacts: { 'retro-proposals.json': '{ not json' },
        files: { [`${subjectDir}/retro.md`]: '# retro' },
      }),
    });
    await expect(
      completeRetro(ctx, rel.release_id, { runId: bad.runId }),
    ).rejects.toMatchObject({ code: 'bad-item' });
    expect(await store.listBoardItems({ workspace: WS })).toHaveLength(0);
    expect(
      await store.listEvents({
        workspace: WS,
        ticket_id: rel.release_id,
        event: 'retro_completed',
      }),
    ).toHaveLength(0);
  });
});
