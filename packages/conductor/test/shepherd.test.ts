/**
 * wp-051 shepherd tests — stub GhClient + SqliteStore tmp + a real
 * git tickets repo (status commits are real). Drives `pollOpenPrs`
 * directly; the tick wiring is covered by the interval test below.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '@sprint-runner/config';
import type { Store, TicketRepoRow, TicketRow } from '@sprint-runner/core';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConductorDeps } from '../src/index.js';
import {
  type GhClient,
  LeaseManager,
  type PrCheck,
  type PrComment,
  type PrCreateOptions,
  type PrInfo,
  type ShepherdCtx,
  pollOpenPrs,
} from '../src/index.js';
import type { ToolCtx } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_FIXTURE = join(HERE, '../../../fixtures/code-repo');
const WS = 'ws';
const PR = 'https://github.com/acme/widgets/pull/7';
const PR2 = 'https://github.com/acme/api/pull/9';

let dir: string;
let ticketsRepo: string;
let codeRepo: string;
let store: SqliteStore;

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

function writeTicket(
  id: string,
  status: string,
  opts: { testMd?: string; title?: string } = {},
): string {
  const tdir = join(ticketsRepo, 'tickets', id);
  mkdirSync(tdir, { recursive: true });
  writeFileSync(
    join(tdir, 'ticket.md'),
    [
      '---',
      'schema: 1',
      `id: ${id}`,
      `title: ${opts.title ?? `Shepherd ${id}`}`,
      `status: ${status}`,
      'priority: medium',
      'repos: [code-repo]',
      '---',
      '',
      '## Description',
      'fixture',
      '',
    ].join('\n'),
    'utf8',
  );
  if (opts.testMd) {
    writeFileSync(join(tdir, 'test.md'), opts.testMd, 'utf8');
  }
  return tdir;
}

const DOD_MD = (rows: string) =>
  [
    '# Test plan — SR-0001',
    '',
    '## Cases',
    '| case_id | title | type | file | covers |',
    '| --- | --- | --- | --- | --- |',
    '| case:c1 | works | unit | src/a.ts | x |',
    '',
    '## Definition of Done',
    '| criterion | verified_by |',
    '| --- | --- |',
    rows,
    '',
  ].join('\n');

/** Stub gh client — per-url checks/views/comments maps. */
class StubGh implements GhClient {
  checks = new Map<string, PrCheck[]>();
  views = new Map<string, PrInfo>();
  comments = new Map<string, PrComment[]>();
  created: { head: string; title: string }[] = [];
  createdUrl = 'https://github.com/acme/widgets/pull/42';
  calls = { checks: 0, view: 0, comments: 0, create: 0 };

  async prChecks(url: string): Promise<PrCheck[]> {
    this.calls.checks++;
    return this.checks.get(url) ?? [];
  }
  async prView(url: string): Promise<PrInfo> {
    this.calls.view++;
    return this.views.get(url) ?? { state: 'OPEN' };
  }
  async reviewComments(url: string): Promise<PrComment[]> {
    this.calls.comments++;
    return this.comments.get(url) ?? [];
  }
  async prCreate(opts: PrCreateOptions): Promise<string> {
    this.calls.create++;
    this.created.push({ head: opts.head, title: opts.title });
    return this.createdUrl;
  }
  async prUrlForHead(): Promise<string | null> {
    return null;
  }
}

const PASS: PrCheck = { name: 'unit', state: 'SUCCESS', bucket: 'pass' };
const FAIL: PrCheck = {
  name: 'unit',
  state: 'FAILURE',
  bucket: 'fail',
  link: 'https://ci/log/1',
};
const FAIL2: PrCheck = { name: 'e2e', state: 'FAILURE', bucket: 'fail' };
const PENDING: PrCheck = { name: 'unit', state: 'PENDING', bucket: 'pending' };

function ticketRow(id: string, status: string, repos: string[]): TicketRow {
  return {
    workspace: WS,
    ticket_id: id,
    title: `Shepherd ${id}`,
    status,
    priority: 'medium',
    depth: 'standard',
    backend: 'mock',
    model: null,
    repos,
    parent: null,
    depends_on: [],
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    updated_at: new Date().toISOString(),
  };
}

function repoRow(
  id: string,
  repo: string,
  patch: Partial<TicketRepoRow> = {},
): TicketRepoRow {
  return {
    workspace: WS,
    ticket_id: id,
    repo,
    branch: `ticket/${id}`,
    worktree: codeRepo,
    pr_url: PR,
    pr_state: 'open',
    ci_state: 'pending',
    merged_sha: null,
    ...patch,
  };
}

function makeCtx(
  gh: GhClient,
  configOverrides: Record<string, unknown> = {},
): ShepherdCtx {
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
        ...configOverrides,
      },
      warnings: [],
      secrets: {},
      files: [],
    }),
    workspaces: [{ name: WS, ticketsRepoPath: ticketsRepo }],
    runsDir: join(dir, 'runs'),
    transitions: undefined as never,
    pull: false,
  };
  const ctx: ToolCtx = {
    deps,
    ws: { name: WS, ticketsRepoPath: ticketsRepo },
    leases: new LeaseManager(deps),
    handles: new Map(),
    killedForCap: new Set(),
  };
  return { ...ctx, gh };
}

async function pendingStages(id: string): Promise<string[]> {
  const runs = await store.listRuns({ workspace: WS, subject: id });
  return runs.filter((r) => r.status === 'pending').map((r) => r.stage);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-shepherd-'));
  ticketsRepo = join(dir, 'tickets-repo');
  codeRepo = join(dir, 'code-repo');
  const remote = join(dir, 'code-remote.git');
  mkdirSync(ticketsRepo, { recursive: true });
  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });
  execFileSync('git', ['init', '-qb', 'main', '--bare', remote]);
  gitInit(codeRepo, remote);
  execFileSync('git', ['push', '-qu', 'origin', 'main'], { cwd: codeRepo });
  gitInit(ticketsRepo);
  store = new SqliteStore(`sqlite://${join(dir, 'state.db')}`);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('shepherd poll', () => {
  it('pr-open: opens the PR (push + gh pr create) then flips to ci-watch once checks register', async () => {
    writeTicket('SR-0001', 'pr-open');
    execFileSync('git', ['branch', 'ticket/SR-0001'], { cwd: codeRepo });
    await store.upsertTicket(ticketRow('SR-0001', 'pr-open', ['code-repo']));
    await store.upsertTicketRepo(
      repoRow('SR-0001', 'code-repo', { pr_url: null, pr_state: null }),
    );
    const gh = new StubGh();
    const ctx = makeCtx(gh);

    // No checks yet → stays pr-open, but the PR got opened.
    await pollOpenPrs(ctx);
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]?.head).toBe('ticket/SR-0001');
    let row = await store.getTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0001',
      repo: 'code-repo',
    });
    expect(row?.pr_url).toBe(gh.createdUrl);
    expect(row?.pr_state).toBe('open');
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' }))?.status,
    ).toBe('pr-open');

    // Checks register → ci-watch + merge gate item.
    gh.checks.set(gh.createdUrl, [PENDING]);
    await pollOpenPrs(ctx);
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' }))?.status,
    ).toBe('ci-watch');
    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: 'ci-watch',
    });
    expect(gate?.cleared_at).toBeNull();
    row = await store.getTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0001',
      repo: 'code-repo',
    });
    expect(row?.ci_state).toBe('pending');
  });

  it('failing checks → one ci-fix run queued, deduped while live', async () => {
    writeTicket('SR-0002', 'ci-watch');
    await store.upsertTicket(ticketRow('SR-0002', 'ci-watch', ['code-repo']));
    await store.upsertTicketRepo(repoRow('SR-0002', 'code-repo'));
    const gh = new StubGh();
    gh.checks.set(PR, [FAIL]);
    const ctx = makeCtx(gh);

    await pollOpenPrs(ctx);
    expect(await pendingStages('SR-0002')).toEqual(['ci-fix']);

    // Same failures, run still pending → no duplicate.
    await pollOpenPrs(ctx);
    expect(await pendingStages('SR-0002')).toEqual(['ci-fix']);

    // Run finished + same fingerprint → still no requeue.
    const run = (
      await store.listRuns({ workspace: WS, subject: 'SR-0002' })
    )[0];
    await store.updateRun((run as NonNullable<typeof run>).id, {
      status: 'done',
    });
    await pollOpenPrs(ctx);
    expect(
      (await store.listRuns({ workspace: WS, subject: 'SR-0002' })).filter(
        (r) => r.stage === 'ci-fix',
      ),
    ).toHaveLength(1);

    // New failure fingerprint → second cycle queued.
    gh.checks.set(PR, [FAIL, FAIL2]);
    await pollOpenPrs(ctx);
    expect(
      (await store.listRuns({ workspace: WS, subject: 'SR-0002' })).filter(
        (r) => r.stage === 'ci-fix',
      ),
    ).toHaveLength(2);

    const row = await store.getTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0002',
      repo: 'code-repo',
    });
    expect(row?.ci_state).toBe('failing');
  });

  it('new review comments → comment-fix with PR_COMMENTS_JSON, deduped', async () => {
    writeTicket('SR-0003', 'ci-watch');
    await store.upsertTicket(ticketRow('SR-0003', 'ci-watch', ['code-repo']));
    await store.upsertTicketRepo(repoRow('SR-0003', 'code-repo'));
    const gh = new StubGh();
    gh.checks.set(PR, [PENDING]); // not green — comment path still runs
    gh.comments.set(PR, [
      {
        id: 'r1',
        body: 'nit: rename',
        kind: 'review',
        created_at: '2026-01-01',
      },
    ]);
    const ctx = makeCtx(gh);

    await pollOpenPrs(ctx);
    expect(await pendingStages('SR-0003')).toEqual(['comment-fix']);

    // Pending run live → no duplicate; new comment later → requeued.
    await pollOpenPrs(ctx);
    expect(await pendingStages('SR-0003')).toEqual(['comment-fix']);
    const run = (
      await store.listRuns({ workspace: WS, subject: 'SR-0003' })
    )[0];
    await store.updateRun((run as NonNullable<typeof run>).id, {
      status: 'done',
    });
    gh.comments.set(PR, [
      { id: 'r1', body: 'nit: rename', kind: 'review' },
      { id: 'r2', body: 'blocker: wrong api', kind: 'review' },
    ]);
    await pollOpenPrs(ctx);
    expect(
      (await store.listRuns({ workspace: WS, subject: 'SR-0003' })).filter(
        (r) => r.stage === 'comment-fix',
      ),
    ).toHaveLength(2);
  });

  it('cycle cap → escalation gate + stops polling that PR', async () => {
    writeTicket('SR-0004', 'ci-watch');
    await store.upsertTicket(ticketRow('SR-0004', 'ci-watch', ['code-repo']));
    await store.upsertTicketRepo(repoRow('SR-0004', 'code-repo'));
    const gh = new StubGh();
    gh.checks.set(PR, [FAIL]);
    const ctx = makeCtx(gh, { budgets: { shepherd_max_cycles: 1 } });

    await pollOpenPrs(ctx); // cycle 1 queued
    const run = (
      await store.listRuns({ workspace: WS, subject: 'SR-0004' })
    )[0];
    await store.updateRun((run as NonNullable<typeof run>).id, {
      status: 'done',
    });

    gh.checks.set(PR, [FAIL2]); // different fingerprint, cap reached
    await pollOpenPrs(ctx);
    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0004',
      gate: 'shepherd-cycle-cap',
    });
    expect(gate?.cleared_at).toBeNull();
    expect(gate?.kind).toBe('escalation');
    expect(
      (await store.listRuns({ workspace: WS, subject: 'SR-0004' })).filter(
        (r) => r.stage === 'ci-fix',
      ),
    ).toHaveLength(1);

    // Escalated → the PR isn't polled anymore.
    const calls = gh.calls.checks;
    await pollOpenPrs(ctx);
    expect(gh.calls.checks).toBe(calls);
  });

  it('green + quiet → merge enabled only after DoD cmd verify + manual attest', async () => {
    const tdir = writeTicket('SR-0005', 'ci-watch', {
      testMd: DOD_MD(
        '| smoke suite passes | cmd:exit 0 |\n' +
          '| human eyeballs it | manual |',
      ),
    });
    await store.upsertTicket(ticketRow('SR-0005', 'ci-watch', ['code-repo']));
    await store.upsertTicketRepo(repoRow('SR-0005', 'code-repo'));
    const gh = new StubGh();
    gh.checks.set(PR, [PASS]);
    const ctx = makeCtx(gh);

    // cmd verified, manual unattested → not enabled.
    await pollOpenPrs(ctx);
    await expect(readFile(join(tdir, 'merge.json'), 'utf8')).rejects.toThrow();
    const dodRun = (await store.listRuns({ workspace: WS })).find(
      (r) => r.subject === 'dod:SR-0005',
    );
    expect(dodRun?.status).toBe('done');

    // Attest → next poll enables merge (never auto-merges).
    await writeFile(
      join(tdir, 'dod-attestations.json'),
      JSON.stringify(
        {
          schema: 1,
          attested: [
            {
              criterion: 'human eyeballs it',
              attested_by: 'tester',
              at: '2026-01-01T00:00:00Z',
            },
          ],
        },
        null,
        2,
      ),
    );
    await pollOpenPrs(ctx);
    const flag = JSON.parse(
      await readFile(join(tdir, 'merge.json'), 'utf8'),
    ) as { enabled: boolean };
    expect(flag.enabled).toBe(true);
    // Still ci-watch — merge NEVER auto-fires.
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-0005' }))?.status,
    ).toBe('ci-watch');
  });

  it('failing DoD cmd → dod-failed gate, merge stays disabled', async () => {
    const tdir = writeTicket('SR-0006', 'ci-watch', {
      testMd: DOD_MD('| smoke | cmd:exit 1 |'),
    });
    await store.upsertTicket(ticketRow('SR-0006', 'ci-watch', ['code-repo']));
    await store.upsertTicketRepo(repoRow('SR-0006', 'code-repo'));
    const gh = new StubGh();
    gh.checks.set(PR, [PASS]);
    await pollOpenPrs(makeCtx(gh));

    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0006',
      gate: 'dod-failed',
    });
    expect(gate?.cleared_at).toBeNull();
    await expect(readFile(join(tdir, 'merge.json'), 'utf8')).rejects.toThrow();
  });

  it('multi-repo: merged iff ALL ticket_repos rows merged', async () => {
    writeTicket('SR-0007', 'ci-watch');
    await store.upsertTicket(
      ticketRow('SR-0007', 'ci-watch', ['code-repo', 'api']),
    );
    await store.upsertTicketRepo(repoRow('SR-0007', 'code-repo'));
    await store.upsertTicketRepo(
      repoRow('SR-0007', 'api', { pr_url: PR2, branch: 'ticket/SR-0007' }),
    );
    const gh = new StubGh();
    gh.checks.set(PR, [PASS]);
    gh.checks.set(PR2, [PASS]);

    // One repo merges → ticket stays ci-watch.
    gh.views.set(PR, { state: 'MERGED', mergeCommit: { oid: 'abc123' } });
    await pollOpenPrs(makeCtx(gh));
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-0007' }))?.status,
    ).toBe('ci-watch');
    const mergedRow = await store.getTicketRepo({
      workspace: WS,
      ticket_id: 'SR-0007',
      repo: 'code-repo',
    });
    expect(mergedRow?.merged_sha).toBe('abc123');

    // Both merged → ticket merged.
    gh.views.set(PR2, { state: 'MERGED', mergeCommit: { oid: 'def456' } });
    await pollOpenPrs(makeCtx(gh));
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-0007' }))?.status,
    ).toBe('merged');
  });

  it('revert path: merged revert PR → reverted, revert PR opened with revert title', async () => {
    writeTicket('SR-0008', 'ci-watch');
    await store.upsertTicket(ticketRow('SR-0008', 'ci-watch', ['code-repo']));
    // A finished revert run marks this ticket's PR as a revert PR.
    await store.createRun({
      id: `${WS}/SR-0008/001-revert`,
      workspace: WS,
      subject: 'SR-0008',
      ticket_id: 'SR-0008',
      stage: 'revert',
      attempt: 1,
      backend: 'mock',
      model: null,
      depth: null,
      pid: null,
      worktree: codeRepo,
      status: 'done',
      started_at: new Date().toISOString(),
      heartbeat_at: null,
      exited_at: null,
      sentinel: 'REVERT-READY',
      sentinel_raw: 'REVERT-READY',
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      run_dir: null,
    });
    await store.upsertTicketRepo(
      repoRow('SR-0008', 'code-repo', { pr_url: null, pr_state: null }),
    );
    const gh = new StubGh();
    const ctx = makeCtx(gh);

    // REVERT-READY already pushed; shepherd opens the revert PR.
    execFileSync('git', ['branch', 'ticket/SR-0008'], { cwd: codeRepo });
    await pollOpenPrs(ctx);
    expect(gh.created[0]?.title).toMatch(/^Revert SR-0008/);

    // Checks register + merge → reverted (not merged).
    gh.checks.set(gh.createdUrl, [PASS]);
    gh.views.set(gh.createdUrl, {
      state: 'MERGED',
      mergeCommit: { oid: 'rev1' },
    });
    await pollOpenPrs(ctx);
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-0008' }))?.status,
    ).toBe('reverted');
  });

  it('tick wiring: shepherd interval throttles (skipped between polls)', async () => {
    const { Conductor, StubTransitionHandler } = await import(
      '../src/index.js'
    );
    writeTicket('SR-0009', 'ci-watch');
    await store.upsertTicket(ticketRow('SR-0009', 'ci-watch', ['code-repo']));
    await store.upsertTicketRepo(repoRow('SR-0009', 'code-repo'));
    const gh = new StubGh();
    gh.checks.set(PR, [PASS]);
    const deps: ConductorDeps = {
      store: store as Store,
      adapters: {},
      config: resolveConfig(null, {
        config: {
          actor: 'test-bot',
          backend: 'mock',
          repos: { 'code-repo': { path: codeRepo } },
          security: { scan_on_commit: false },
          shepherd: { poll_interval_s: 3600 },
        },
        warnings: [],
        secrets: {},
        files: [],
      }),
      workspaces: [{ name: WS, ticketsRepoPath: ticketsRepo }],
      runsDir: join(dir, 'runs'),
      transitions: new StubTransitionHandler(),
      gh,
      pull: false,
      scan: async () => ({ ok: true as const, scanner: 'stub', findings: [] }),
    };
    const conductor = new Conductor(deps);
    const r1 = await conductor.tick();
    expect(gh.calls.view).toBe(1);
    expect(r1.shepherd[0]?.polled).toEqual([PR]);
    const r2 = await conductor.tick();
    expect(gh.calls.view).toBe(1); // throttled — poll_interval_s=3600
    expect(r2.shepherd[0]?.polled).toEqual([]);
  });
});
