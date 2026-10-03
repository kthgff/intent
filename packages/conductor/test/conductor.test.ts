/**
 * wp-030 conductor tests — MockAdapter (real detached children) +
 * SqliteStore :memory:/tmp + fixture repos copied to tmp git repos.
 *
 * Drives a fixture ticket through one full transition end-to-end via a
 * stub TransitionHandler (wp-031's table is out of scope — the stub
 * returns a status change through the TransitionTools API).
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter } from '@sprint-runner/adapters';
import { resolveConfig } from '@sprint-runner/config';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Conductor,
  type ConductorDeps,
  StubTransitionHandler,
  type TransitionTools,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TICKETS_FIXTURE = join(HERE, '../../../fixtures/tickets-repo');
const CODE_FIXTURE = join(HERE, '../../../fixtures/code-repo');
const WS = 'ws';
const NOOP_SCAN = async () => ({
  ok: true as const,
  scanner: 'stub',
  findings: [],
});

let dir: string;
let ticketsRepo: string;
let codeRepo: string;
let runsDir: string;
let store: SqliteStore;

function gitInit(repo: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
}

function seedRepos(): void {
  ticketsRepo = join(dir, 'tickets-repo');
  codeRepo = join(dir, 'code-repo');
  cpSync(TICKETS_FIXTURE, ticketsRepo, { recursive: true });
  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });
  gitInit(ticketsRepo);
  gitInit(codeRepo);
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      repos: {
        'code-repo': {
          path: codeRepo,
          card: {
            test: 'make test',
            lint: 'make lint',
            build: 'make build',
            forbidden_paths: [],
            probed_at: '2026-10-03T00:00:00Z',
            verified: true,
          },
        },
      },
      security: { scan_on_commit: false },
      ...overrides,
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function makeConductor(
  opts: {
    adapter?: MockAdapter;
    transitions?: StubTransitionHandler;
    configOverrides?: Record<string, unknown>;
    store?: SqliteStore;
  } = {},
): Conductor {
  const deps: ConductorDeps = {
    store: opts.store ?? store,
    adapters: { mock: opts.adapter ?? new MockAdapter({ delayMs: 50 }) },
    config: makeConfig(opts.configOverrides),
    workspaces: [{ name: WS, ticketsRepoPath: ticketsRepo }],
    runsDir,
    transitions:
      opts.transitions ??
      new StubTransitionHandler({ nextStages: { imported: 'triage' } }),
    scan: NOOP_SCAN,
    stallAfterMs: 200,
    pull: true,
  };
  return new Conductor(deps);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function must<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  stepMs = 75,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  throw new Error('waitFor: condition not met within timeout');
}

function ticketStatus(id: string): string {
  const raw = readFileSync(
    join(ticketsRepo, 'tickets', id, 'ticket.md'),
    'utf8',
  );
  return /^status:\s*(\S+)/m.exec(raw)?.[1] ?? '';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-conductor-'));
  runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  seedRepos();
  store = new SqliteStore(':memory:');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('conductor tick loop (wp-030)', () => {
  it('drives a fixture ticket through one transition end-to-end', async () => {
    let transitioned: string | null = null;
    const transitions = new StubTransitionHandler({
      nextStages: { imported: 'triage' },
      onRunComplete: async (outcome, tools: TransitionTools) => {
        expect(outcome.result.sentinel).toBe('DONE');
        transitioned = outcome.run.ticket_id;
        await tools.applyTicketStatus({
          ticketId: outcome.run.ticket_id as string,
          status: 'triage',
          run: outcome.run.id,
        });
      },
    });
    const conductor = makeConductor({ transitions });

    // Tick until the run completes and the transition lands.
    for (let i = 0; i < 60; i++) {
      await conductor.tick();
      if (transitioned) break;
      await sleep(75);
    }

    expect(transitioned).toBe('SR-0001');
    // Frontmatter truth + projection both moved.
    expect(ticketStatus('SR-0001')).toBe('triage');
    const ticket = await store.getTicket({
      workspace: WS,
      ticket_id: 'SR-0001',
    });
    expect(ticket?.status).toBe('triage');

    const runs = await store.listRuns({ workspace: WS, subject: 'SR-0001' });
    expect(runs).toHaveLength(1);
    const run = must(runs[0], 'a run row');
    expect(run.status).toBe('done');
    expect(run.sentinel).toBe('DONE');
    expect(run.stage).toBe('triage');
    expect(existsSync(join(run.run_dir as string, 'usage.json'))).toBe(true);

    // Lease released after collect.
    const lease = await store.getLease({
      workspace: WS,
      subject: 'SR-0001',
      stage: 'triage',
      attempt: 1,
    });
    expect(lease).toBeNull();

    // Events: run_started, run_finished, status_changed.
    const events = await store.listEvents({
      workspace: WS,
      ticket_id: 'SR-0001',
    });
    const names = events.map((e) => e.event);
    expect(names).toContain('run_started');
    expect(names).toContain('run_finished');
    expect(names).toContain('status_changed');

    // The status commit landed in the tickets repo.
    const log = execFileSync('git', ['log', '--format=%s'], {
      cwd: ticketsRepo,
      encoding: 'utf8',
    });
    expect(log).toMatch(/SR-0001 → triage/);
  });

  it('marks a silent run stalled then kills it at the stage timeout', async () => {
    const conductor = makeConductor({
      adapter: new MockAdapter({
        scenario: 'hang',
        delayMs: 0,
        heartbeatMs: 0,
      }),
      configOverrides: { timeouts: { triage: 1 } },
    });

    await conductor.tick(); // claim + launch
    const run = must(
      (await store.listRuns({ workspace: WS, subject: 'SR-0001' }))[0],
      'a run row',
    );
    expect(run.status).toBe('running');

    // No log/artifact progress (heartbeat noise disabled) + stall
    // budget 200ms → stalled.
    await sleep(400);
    await conductor.tick();
    expect((await store.getRun(run.id))?.status).toBe('stalled');

    // Timeout 1s → kill + run_killed; the ticket stays for retry.
    await waitFor(async () => {
      await conductor.tick();
      return (await store.getRun(run.id))?.status === 'killed';
    });
    const events = await store.listEvents({ workspace: WS });
    expect(events.map((e) => e.event)).toContain('run_killed');
    const notes = await store.listNotifications({ workspace: WS });
    expect(notes.some((n) => n.kind === 'run_killed')).toBe(true);
    // Status stays for retry — ticket untouched.
    expect(ticketStatus('SR-0001')).toBe('imported');
  });

  it('lease contention: a held lease blocks the other claimer', async () => {
    // A rival install holds the lease for the only runnable subject.
    const rival = await store.acquireLease(
      { workspace: WS, subject: 'SR-0001', stage: 'triage', attempt: 1 },
      'rival-install',
      300,
    );
    expect(rival).not.toBeNull();

    const conductor = makeConductor();
    const report = await conductor.tick();
    const launched = report.claim.flatMap((c) => c.launched);
    const skipped = report.claim.flatMap((c) => c.skipped);
    expect(launched).toHaveLength(0);
    expect(skipped.some((s) => s.reason === 'lease-contested')).toBe(true);
    expect(
      await store.listRuns({ workspace: WS, subject: 'SR-0001' }),
    ).toHaveLength(0);
  });

  it('two conductors on one store: exactly one claims the run', async () => {
    const dbPath = join(dir, 'state.db');
    const shared1 = new SqliteStore(`sqlite://${dbPath}`);
    const shared2 = new SqliteStore(`sqlite://${dbPath}`);
    try {
      const c1 = makeConductor({ store: shared1 });
      const c2 = makeConductor({ store: shared2 });
      await c1.tick();
      await c2.tick();
      const runs = await shared1.listRuns({
        workspace: WS,
        subject: 'SR-0001',
      });
      expect(runs).toHaveLength(1);
      // Clean up the spawned child so the test can exit.
      await c1.killRun(must(runs[0], 'the claimed run').id);
    } finally {
      shared1.close();
      shared2.close();
    }
  });

  it('kills a run when the per-ticket token cap is hit mid-run', async () => {
    const conductor = makeConductor({
      adapter: new MockAdapter({ scenario: 'usage', delayMs: 400 }),
      configOverrides: { budgets: { tokens_cap_per_ticket: 10 } },
    });
    for (let i = 0; i < 40; i++) {
      await conductor.tick();
      const t = await store.getTicket({ workspace: WS, ticket_id: 'SR-0001' });
      if (t?.status === 'blocked') break;
      await sleep(75);
    }
    const ticket = await store.getTicket({
      workspace: WS,
      ticket_id: 'SR-0001',
    });
    expect(ticket?.status).toBe('blocked');
    expect(ticket?.blocked_reason).toBe('tokens_cap_per_ticket');
    expect(ticketStatus('SR-0001')).toBe('blocked');
    const events = await store.listEvents({
      workspace: WS,
      ticket_id: 'SR-0001',
    });
    const names = events.map((e) => e.event);
    expect(names).toContain('run_killed');
    expect(names).toContain('blocked');
  });

  it('heartbeats are conductor-observed: the run row moves while the detached child never writes the DB', async () => {
    const conductor = makeConductor({
      adapter: new MockAdapter({ scenario: 'done', delayMs: 600 }),
    });
    await conductor.tick(); // launch
    const run = must(
      (await store.listRuns({ workspace: WS, subject: 'SR-0001' }))[0],
      'a run row',
    );
    const hb1 = must((await store.getRun(run.id))?.heartbeat_at, 'hb1');

    await sleep(150);
    await conductor.tick(); // sweep → heartbeat refresh while alive
    const after = await store.getRun(run.id);
    const hb2 = must(after?.heartbeat_at, 'hb2');
    expect(hb2 >= hb1).toBe(true);
    expect(hb2 !== hb1 || after?.status === 'done').toBe(true);

    // The child is a detached node process with no DB handle — the only
    // writer of heartbeat_at is the conductor's own sweep.
    await waitFor(async () => {
      await conductor.tick();
      return (await store.getRun(run.id))?.status === 'done';
    });
    await conductor.killRun(run.id).catch(() => {});
  });
});
