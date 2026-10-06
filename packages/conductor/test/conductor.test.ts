/**
 * wp-030 conductor tests — MockAdapter (real detached children) +
 * PostgresStore on PGlite + the fixture code repo copied to a tmp git
 * repo (wp-094: D29 — tickets are seeded as `tickets` rows +
 * `doc_versions`, no tickets repo).
 *
 * Drives a fixture ticket through one full transition end-to-end via a
 * stub TransitionHandler (wp-031's table is out of scope — the stub
 * returns a status change through the TransitionTools API).
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter } from '@veto/adapters';
import { resolveConfig } from '@veto/config';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTicketMd } from '../src/import/parse.js';
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
let codeRepo: string;
let runsDir: string;
let store: PostgresStore;

function gitInit(repo: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
}

/** Seed every fixture ticket.md into `tickets` + `doc_versions` (D29). */
async function seedTickets(s: PostgresStore): Promise<void> {
  const now = new Date().toISOString();
  const ticketsDir = join(TICKETS_FIXTURE, 'tickets');
  for (const id of readdirSync(ticketsDir)) {
    const raw = readFileSync(join(ticketsDir, id, 'ticket.md'), 'utf8');
    const parsed = parseTicketMd(raw, `${id}/ticket.md`);
    if (!parsed.ok) throw new Error(`fixture ${id}: ${parsed.error.error}`);
    const fm = parsed.value.frontmatter;
    await s.upsertTicket({
      workspace: WS,
      ticket_id: id,
      feature: fm.feature ?? null,
      title: fm.title,
      status: fm.status,
      priority: fm.priority,
      depth: fm.depth ?? null,
      backend: fm.backend ?? null,
      model: fm.model ?? null,
      repos: fm.repos,
      parent: fm.parent ?? null,
      depends_on: fm.depends_on,
      source: fm.source ?? null,
      forced: fm.forced ?? false,
      spec_score: null,
      spec_hash: null,
      blocked_reason: fm.blocked_reason ?? null,
      created_at: now,
      updated_at: now,
    });
    await s.appendDocVersion(
      { workspace: WS, subject: id, doc: 'ticket.md' },
      raw,
      'test-seed',
    );
  }
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
    store?: PostgresStore;
  } = {},
): Conductor {
  const deps: ConductorDeps = {
    store: opts.store ?? store,
    adapters: { mock: opts.adapter ?? new MockAdapter({ delayMs: 50 }) },
    config: makeConfig(opts.configOverrides),
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir,
    transitions:
      opts.transitions ??
      new StubTransitionHandler({ nextStages: { imported: 'triage' } }),
    scan: NOOP_SCAN,
    stallAfterMs: 200,
    onError: (e) => console.error('[conductor onError]', e),
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

/** `status:` line from the ticket.md doc_versions content (D29 —
 *  frontmatter lives in the DB now). */
async function ticketStatus(id: string): Promise<string> {
  const doc = await store.getDoc({
    workspace: WS,
    subject: id,
    doc: 'ticket.md',
  });
  return /^status:\s*(\S+)/m.exec(doc?.content ?? '')?.[1] ?? '';
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-conductor-'));
  runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  codeRepo = join(dir, 'code-repo');
  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });
  gitInit(codeRepo);
  store = await PostgresStore.connect('pglite:');
  await seedTickets(store);
});

afterEach(async () => {
  await store.close();
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
    // Doc frontmatter + truth row both moved (D29).
    expect(await ticketStatus('SR-0001')).toBe('triage');
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
    // usage.json is a run_artifacts row now, not a run-dir file (D29).
    const usage = await store.getArtifact(run.id, 'usage.json');
    expect(usage).not.toBeNull();

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
    // budget 200ms → stalled. Generous waitFor budget — each tick is
    // seconds under full-suite load, so the default 10s can lapse
    // after only a handful of ticks.
    await sleep(300);
    await waitFor(async () => {
      await conductor.tick();
      return (await store.getRun(run.id))?.status === 'stalled';
    }, 60_000);

    // Timeout 1s → kill + run_killed; the ticket stays for retry.
    await waitFor(async () => {
      await conductor.tick();
      return (await store.getRun(run.id))?.status === 'killed';
    }, 60_000);
    const events = await store.listEvents({ workspace: WS });
    expect(events.map((e) => e.event)).toContain('run_killed');
    const notes = await store.listNotifications({ workspace: WS });
    expect(notes.some((n) => n.kind === 'run_killed')).toBe(true);
    // Status stays for retry — ticket untouched.
    expect(await ticketStatus('SR-0001')).toBe('imported');
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
    // One shared store instance — the lease CAS is still exercised
    // through the same DB (PGlite is single-process; a second PGlite
    // cannot attach to the same dir).
    const c1 = makeConductor();
    const c2 = makeConductor();
    await c1.tick();
    await c2.tick();
    const runs = await store.listRuns({
      workspace: WS,
      subject: 'SR-0001',
    });
    expect(runs).toHaveLength(1);
    // Clean up the spawned child so the test can exit.
    await c1.killRun(must(runs[0], 'the claimed run').id);
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
    expect(await ticketStatus('SR-0001')).toBe('blocked');
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
