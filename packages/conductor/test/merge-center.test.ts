/**
 * wp-133 Merge Center tests (DELIVERY §2) — a stub `gh` client + a real
 * git worktree over PGlite PostgresStore.
 *
 * Covers: the readiness checklist green path, the branch-protection
 * blocked path (gate + stop, never bypass), the git-conflict path
 * (`merge_conflict` gate + `rebase` run, no force-push), the merge-queue
 * enqueue path (`--auto`), the stale-approval check, and post-merge
 * bookkeeping (merged_sha + status + `merged` event + implementation-
 * note append).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '@veto/config';
import type { TicketRepoRow, TicketRow } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConductorDeps } from '../src/index.js';
import {
  type GhClient,
  LeaseManager,
  type PrCheck,
  type PrComment,
  type PrCreateOptions,
  type PrInfo,
  type PrMergeOptions,
  type ShepherdCtx,
  evaluateReadiness,
  pollOpenPrs,
  runMergeCenter,
} from '../src/index.js';
import type { ToolCtx } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_FIXTURE = join(HERE, '../../../fixtures/code-repo');
const WS = 'ws';
const PR = 'https://github.com/acme/widgets/pull/7';

let dir: string;
let wsRoot: string;
let codeRepo: string;
let store: PostgresStore;

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function gitInit(repo: string, remote?: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
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

function ticketRow(
  id: string,
  status: TicketRow['status'],
  repos: string[],
): TicketRow {
  const now = new Date().toISOString();
  return {
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `Merge ${id}`,
    status,
    priority: 'medium',
    depth: 'standard',
    backend: 'mock',
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
    created_at: now,
    updated_at: now,
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

async function seedTicket(
  id: string,
  opts: { status?: TicketRow['status']; repos?: string[]; vsMd?: string } = {},
): Promise<void> {
  const repos = opts.repos ?? ['code-repo'];
  await store.upsertTicket(ticketRow(id, opts.status ?? 'ci-watch', repos));
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    [
      '---',
      'schema: 1',
      `id: ${id}`,
      `title: Merge ${id}`,
      `status: ${opts.status ?? 'ci-watch'}`,
      'priority: medium',
      `repos: [${repos.join(', ')}]`,
      '---',
      '',
      '## Description',
      'fixture',
      '',
    ].join('\n'),
    'test-seed',
  );
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'vs.md' },
    opts.vsMd ?? VS_MD(id),
    'test-seed',
  );
}

function repoRow(
  id: string,
  patch: Partial<TicketRepoRow> = {},
): TicketRepoRow {
  return {
    workspace: WS,
    ticket_id: id,
    repo: 'code-repo',
    branch: `ticket/${id}`,
    worktree: codeRepo,
    pr_url: PR,
    pr_state: 'open',
    ci_state: 'green',
    merged_sha: null,
    ...patch,
  };
}

const PASS: PrCheck = { name: 'unit', state: 'SUCCESS', bucket: 'pass' };
const HEAD = 'head1111';
const MERGED_SHA = 'merge9999';

/** Stub gh client — merges mutate the view so confirmation succeeds. */
class StubGh implements GhClient {
  checks = new Map<string, PrCheck[]>([[PR, [PASS]]]);
  views = new Map<string, PrInfo>();
  comments = new Map<string, PrComment[]>();
  queues = new Set<string>();
  merges: { url: string; opts: PrMergeOptions | undefined }[] = [];
  createdUrl = 'https://github.com/acme/widgets/pull/42';

  async prChecks(url: string): Promise<PrCheck[]> {
    return this.checks.get(url) ?? [];
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
    return this.createdUrl;
  }
  async prUrlForHead(): Promise<string | null> {
    return null;
  }
  async prMerge(url: string, opts?: PrMergeOptions): Promise<void> {
    this.merges.push({ url, opts });
    const cur = this.views.get(url) ?? { state: 'OPEN' };
    if (opts?.auto) {
      this.views.set(url, {
        ...cur,
        state: 'OPEN',
        autoMergeRequest: { enabledAt: new Date().toISOString() },
      });
    } else {
      this.views.set(url, {
        ...cur,
        state: 'MERGED',
        mergeCommit: { oid: MERGED_SHA },
      });
    }
  }
  async mergeQueue(url: string): Promise<boolean> {
    return this.queues.has(url);
  }
}

function makeCtx(gh: GhClient): ShepherdCtx {
  const deps: ConductorDeps = {
    store,
    adapters: {},
    config: resolveConfig(null, {
      config: {
        actor: 'test-bot',
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
    runsDir: join(dir, 'runs'),
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

async function eventsFor(id: string): Promise<string[]> {
  return (await store.listEvents({ workspace: WS, ticket_id: id })).map(
    (e) => e.event,
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-merge-'));
  wsRoot = join(dir, 'ws');
  codeRepo = join(dir, 'code-repo');
  const remote = join(dir, 'code-remote.git');
  mkdirSync(wsRoot, { recursive: true });
  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });
  execFileSync('git', ['init', '-qb', 'main', '--bare', remote]);
  gitInit(codeRepo, remote);
  execFileSync('git', ['push', '-qu', 'origin', 'main'], { cwd: codeRepo });
  store = await PostgresStore.connect('pglite:');
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('merge center — checklist', () => {
  it('green readiness: every item passes and merge executes via gh pr merge', async () => {
    await seedTicket('SR-1001');
    execFileSync('git', ['branch', 'ticket/SR-1001'], { cwd: codeRepo });
    await store.upsertTicketRepo(repoRow('SR-1001'));
    const gh = new StubGh();
    const ctx = makeCtx(gh);

    const readiness = await evaluateReadiness(
      ctx,
      (await store.getTicket({
        workspace: WS,
        ticket_id: 'SR-1001',
      })) as TicketRow,
      await store.listTicketRepos({ workspace: WS, ticket_id: 'SR-1001' }),
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.items.map((i) => i.id)).toContain('approval');
    expect(readiness.items.map((i) => i.id)).toContain('branch-protection');

    const report = await runMergeCenter(ctx);
    expect(report.ready).toContain('SR-1001');
    expect(report.merged).toContain('SR-1001');
    expect(gh.merges).toHaveLength(1);
    expect(gh.merges[0]?.opts?.strategy).toBe('squash');
    expect(gh.merges[0]?.opts?.auto).toBeFalsy();
    const evs = await eventsFor('SR-1001');
    expect(evs).toContain('merge_ready');
    expect(evs).toContain('merge_attempted');
    const row = await store.getTicketRepo({
      workspace: WS,
      ticket_id: 'SR-1001',
      repo: 'code-repo',
    });
    expect(row?.merged_sha).toBe(MERGED_SHA);
  });

  it('stale approval (bound to an older head) blocks the merge', async () => {
    await seedTicket('SR-1002');
    execFileSync('git', ['branch', 'ticket/SR-1002'], { cwd: codeRepo });
    await store.upsertTicketRepo(repoRow('SR-1002'));
    // Review session + approve decision bound to an OLD head.
    await store.upsertReviewSession({
      workspace: WS,
      org: null,
      review_id: 'rv-SR-1002',
      subject: 'SR-1002',
      status: 'approved',
      created_by: 'human',
      created_at: new Date().toISOString(),
      closed_at: null,
    });
    await store.appendReviewRevision({
      workspace: WS,
      org: null,
      review_id: 'rv-SR-1002',
      revision: 1,
      head_sha: 'oldsha',
      base_sha: null,
      baseline: null,
      created_at: new Date().toISOString(),
    });
    await store.appendReviewDecision({
      workspace: WS,
      org: null,
      decision_id: 'rd-1',
      review_id: 'rv-SR-1002',
      revision: 1,
      reviewer: 'human',
      action: 'approve',
      head_sha: 'oldsha',
      baseline: null,
      rationale: null,
      created_at: new Date().toISOString(),
    });
    const gh = new StubGh();
    const ctx = makeCtx(gh);

    const readiness = await evaluateReadiness(
      ctx,
      (await store.getTicket({
        workspace: WS,
        ticket_id: 'SR-1002',
      })) as TicketRow,
      await store.listTicketRepos({ workspace: WS, ticket_id: 'SR-1002' }),
    );
    expect(readiness.ready).toBe(false);
    const approval = readiness.items.find((i) => i.id === 'approval');
    expect(approval?.ok).toBe(false);
    expect(approval?.detail).toMatch(/stale/);

    const report = await runMergeCenter(ctx);
    expect(report.ready).not.toContain('SR-1002');
    expect(gh.merges).toHaveLength(0);
  });
});

describe('merge center — branch protection (never bypass)', () => {
  it('a protection-blocked PR surfaces a `merge` gate and stops', async () => {
    await seedTicket('SR-2001');
    execFileSync('git', ['branch', 'ticket/SR-2001'], { cwd: codeRepo });
    await store.upsertTicketRepo(repoRow('SR-2001'));
    const gh = new StubGh();
    gh.views.set(PR, {
      state: 'OPEN',
      headRefOid: HEAD,
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
    });
    const ctx = makeCtx(gh);

    const report = await runMergeCenter(ctx);
    expect(report.blocked).toContain('SR-2001');
    expect(gh.merges).toHaveLength(0); // never attempted
    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-2001',
      gate: 'merge',
    });
    expect(gate?.cleared_at).toBeNull();
    expect(gate?.kind).toBe('escalation');
    const notes = await store.listNotifications({ workspace: WS });
    expect(
      notes.some((n) => (n.payload ?? '').includes('branch protection')),
    ).toBe(true);
  });
});

describe('merge center — conflict', () => {
  it('a git conflict surfaces `merge_conflict` + queues a rebase run', async () => {
    // Build a conflicting worktree: branch ticket/SR-3001 vs origin/main.
    const wt = join(dir, 'wt-3001');
    writeFileSync(join(codeRepo, 'f.txt'), 'base\n');
    git(codeRepo, ['add', '-A']);
    git(codeRepo, ['commit', '-qm', 'base file']);
    git(codeRepo, ['branch', 'ticket/SR-3001']);
    git(codeRepo, ['worktree', 'add', wt, 'ticket/SR-3001']);
    writeFileSync(join(wt, 'f.txt'), 'branch change\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-qm', 'branch change']);
    writeFileSync(join(codeRepo, 'f.txt'), 'main change\n');
    git(codeRepo, ['add', '-A']);
    git(codeRepo, ['commit', '-qm', 'main change']);
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: codeRepo });

    await seedTicket('SR-3001');
    await store.upsertTicketRepo(
      repoRow('SR-3001', { branch: 'ticket/SR-3001', worktree: wt }),
    );
    const gh = new StubGh();
    const ctx = makeCtx(gh);

    const report = await runMergeCenter(ctx);
    expect(report.conflicts).toContain('SR-3001');
    expect(gh.merges).toHaveLength(0);
    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-3001',
      gate: 'merge_conflict',
    });
    expect(gate?.cleared_at).toBeNull();
    const runs = await store.listRuns({ workspace: WS, subject: 'SR-3001' });
    expect(
      runs.some((r) => r.stage === 'rebase' && r.status === 'pending'),
    ).toBe(true);
    expect(await eventsFor('SR-3001')).toContain('merge_conflict');
  });
});

describe('merge center — merge queue', () => {
  it('a merge-queue repo enqueues with --auto and confirms on a later poll', async () => {
    await seedTicket('SR-4001');
    execFileSync('git', ['branch', 'ticket/SR-4001'], { cwd: codeRepo });
    await store.upsertTicketRepo(repoRow('SR-4001'));
    const gh = new StubGh();
    gh.queues.add(PR);
    const ctx = makeCtx(gh);

    const report = await runMergeCenter(ctx);
    expect(report.queued).toContain('SR-4001');
    expect(report.merged).not.toContain('SR-4001');
    expect(gh.merges[0]?.opts?.auto).toBe(true);
    // Enqueue counts as execution — the ticket is still ci-watch until
    // the merge is confirmed.
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-4001' }))?.status,
    ).toBe('ci-watch');
    expect(await eventsFor('SR-4001')).toContain('merge_attempted');
  });
});

describe('merge center — post-merge bookkeeping', () => {
  it('merged_sha + status + merged event + implementation note land together', async () => {
    await seedTicket('SR-5001');
    execFileSync('git', ['branch', 'ticket/SR-5001'], { cwd: codeRepo });
    await store.upsertTicketRepo(repoRow('SR-5001'));
    const gh = new StubGh();
    const ctx = makeCtx(gh);

    // Poll 1: merge center executes + confirms the merge (row merged).
    await pollOpenPrs(ctx);
    expect(gh.merges).toHaveLength(1);
    let row = await store.getTicketRepo({
      workspace: WS,
      ticket_id: 'SR-5001',
      repo: 'code-repo',
    });
    expect(row?.merged_sha).toBe(MERGED_SHA);

    // Poll 2: the rollup finalizes the ticket + post-merge bookkeeping.
    await pollOpenPrs(ctx);
    const ticket = await store.getTicket({
      workspace: WS,
      ticket_id: 'SR-5001',
    });
    expect(ticket?.status).toBe('merged');
    const evs = await eventsFor('SR-5001');
    expect(evs).toContain('merged');
    const note = await store.getDoc({
      workspace: WS,
      subject: 'SR-5001',
      doc: 'notes.md',
    });
    expect(note?.content).toContain('## Merge — merged');
    expect(note?.content).toContain(MERGED_SHA);
    row = await store.getTicketRepo({
      workspace: WS,
      ticket_id: 'SR-5001',
      repo: 'code-repo',
    });
    expect(row?.merged_sha).toBe(MERGED_SHA);
  });
});
