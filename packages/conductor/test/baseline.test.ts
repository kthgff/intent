/**
 * wp-141 tests — run baseline pinning + mid-run reconciliation
 * (PRD §15.5).
 *
 * Real PostgresStore on PGlite; the pin/reconcile functions are
 * exercised directly (launch/reconcile are thin callers), plus a
 * fixture-world integration pass through `queuePendingRun` → `launch`.
 *
 * Covers the four required behaviours:
 *   - pin-at-launch: every run carries a complete pinned baseline
 *     (concrete doc versions, AC set, base SHA — never "latest");
 *   - no-retro-edit: a pending row's pinned set survives the
 *     queue→claim relaunch even after doc heads move;
 *   - drift detection → `baseline-drift` gate item (3-way policy);
 *   - `baseline_reconciled` event recorded on drift.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunBaseline, RunRow } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pinnedBaselineOf,
  resolveRunBaseline,
} from '../src/launch/baseline.js';
import type { ConductorWorkspace } from '../src/loop/deps.js';
import {
  BASELINE_DRIFT_GATE,
  type BaselineReconcileCtx,
  classifyBaselineDrift,
  detectBaselineDrift,
  reconcileAffectedRuns,
  reconcileRunBaseline,
} from '../src/reconcile/baseline.js';
import { type FixtureWorld, makeFixtureWorld } from './helpers/fixtures.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');
const T0ISO = new Date(T0).toISOString();

let store: PostgresStore;
let clock: number;

function bctx(over: Partial<BaselineReconcileCtx> = {}): BaselineReconcileCtx {
  return {
    store,
    workspace: WS,
    actor: 'test-actor',
    now: () => new Date(clock),
    ...over,
  };
}

beforeEach(async () => {
  store = await PostgresStore.connect('pglite:');
  clock = T0;
  await store.upsertProject({ workspace: WS, name: 'Team A' });
});

afterEach(async () => {
  await store.close();
});

async function seedTicket(id: string) {
  await store.upsertTicket({
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `Ticket ${id}`,
    status: 'ready',
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos: ['code-repo'],
    parent: null,
    depends_on: [],
    source: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: T0ISO,
    updated_at: T0ISO,
  });
}

async function putDoc(
  subject: string,
  doc: string,
  content: string,
): Promise<number> {
  return (
    await store.appendDocVersion(
      { workspace: WS, subject, doc: doc as never },
      content,
      'test-seed',
    )
  ).version;
}

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: `${WS}/SR-0001/001-implement`,
    workspace: WS,
    subject: 'SR-0001',
    ticket_id: 'SR-0001',
    stage: 'implement',
    attempt: 1,
    backend: 'mock',
    model: null,
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: null,
    status: 'running',
    started_at: T0ISO,
    heartbeat_at: T0ISO,
    exited_at: null,
    sentinel: null,
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// resolveRunBaseline — pin-at-launch
// ---------------------------------------------------------------------------

describe('resolveRunBaseline (pin at launch)', () => {
  it('resolves concrete doc heads, the AC set, and null base_sha without a worktree', async () => {
    await seedTicket('SR-0001');
    await putDoc('SR-0001', 'rs.md', '# RS\n\n- [ ] AC-1 login works\n');
    await putDoc('SR-0001', 'ticket.md', '---\nstatus: ready\n---\nbody\n');
    await putDoc('SR-0001', 'tdd.md', '# TDD\n');
    await putDoc('SR-0001', 'contract.json', '{"api":"v1"}\n');

    const baseline = await resolveRunBaseline({
      store,
      workspace: WS,
      subject: 'SR-0001',
    });
    expect(baseline).toEqual({
      rs_version: 1,
      ticket_rev: 1,
      design_rev: 1,
      ac_ids: ['AC-1'],
      base_sha: null,
      contract_ver: 1,
    });
    // Concrete versions — never a "latest" pointer.
    expect(typeof baseline.rs_version).toBe('number');
  });

  it('records base_sha from the worktree HEAD when a checkout exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-base-'));
    try {
      execFileSync('git', ['init', '-qb', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
      execFileSync('git', ['commit', '--allow-empty', '-qm', 'seed'], {
        cwd: dir,
      });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir })
        .toString()
        .trim();

      const baseline = await resolveRunBaseline({
        store,
        workspace: WS,
        subject: 'SR-0001',
        worktree: dir,
      });
      expect(baseline.base_sha).toBe(sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pinnedBaselineOf', () => {
  it('parses the persisted pin and returns null for absent/malformed', () => {
    const pin: RunBaseline = {
      rs_version: 2,
      ticket_rev: 1,
      design_rev: null,
      ac_ids: ['AC-1'],
      base_sha: 'abc',
      contract_ver: null,
    };
    expect(pinnedBaselineOf(runRow({ request: { baseline: pin } }))).toEqual(
      pin,
    );
    expect(pinnedBaselineOf(runRow({ request: null }))).toBeNull();
    expect(pinnedBaselineOf(runRow({ request: {} }))).toBeNull();
    // Malformed pin (wrong types) → null, never a guessed shape.
    expect(
      pinnedBaselineOf(runRow({ request: { baseline: { ac_ids: 3 } } })),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectBaselineDrift + classifyBaselineDrift — the 3-way policy
// ---------------------------------------------------------------------------

describe('detectBaselineDrift + classifyBaselineDrift', () => {
  async function pinned(): Promise<RunBaseline> {
    await seedTicket('SR-0001');
    await putDoc('SR-0001', 'rs.md', 'rs v1\n- [ ] AC-1\n');
    await putDoc('SR-0001', 'ticket.md', '---\nstatus: ready\n---\nbody\n');
    await putDoc('SR-0001', 'tdd.md', 'tdd v1\n');
    await putDoc('SR-0001', 'contract.json', '{"api":"v1"}\n');
    return resolveRunBaseline({
      store,
      workspace: WS,
      subject: 'SR-0001',
    });
  }

  it('continue: no doc moved → no drift', async () => {
    const pin = await pinned();
    const drift = await detectBaselineDrift({
      store,
      workspace: WS,
      subject: 'SR-0001',
      pinned: pin,
    });
    expect(drift).toEqual([]);
    expect(classifyBaselineDrift(drift)).toBe('continue');
  });

  it('stop-replan: the RS moving past the pin is substantial', async () => {
    const pin = await pinned();
    await putDoc('SR-0001', 'rs.md', 'rs v2 — requirements changed\n');
    const drift = await detectBaselineDrift({
      store,
      workspace: WS,
      subject: 'SR-0001',
      pinned: pin,
    });
    expect(drift).toEqual([
      { field: 'rs_version', doc: 'rs.md', pinned: 1, head: 2 },
    ]);
    expect(classifyBaselineDrift(drift)).toBe('stop-replan');
  });

  it('stop-replan: a changed contract version is substantial', async () => {
    const pin = await pinned();
    await putDoc('SR-0001', 'contract.json', '{"api":"v2"}\n');
    const drift = await detectBaselineDrift({
      store,
      workspace: WS,
      subject: 'SR-0001',
      pinned: pin,
    });
    expect(drift.map((d) => d.field)).toEqual(['contract_ver']);
    expect(classifyBaselineDrift(drift)).toBe('stop-replan');
  });

  it('pause-reconcile: a design revision is small', async () => {
    const pin = await pinned();
    await putDoc('SR-0001', 'tdd.md', 'tdd v2 — design revised\n');
    const drift = await detectBaselineDrift({
      store,
      workspace: WS,
      subject: 'SR-0001',
      pinned: pin,
    });
    expect(drift.map((d) => d.field)).toEqual(['design_rev']);
    expect(classifyBaselineDrift(drift)).toBe('pause-reconcile');
  });

  it('ignores ticket.md status churn but catches a real ticket body change', async () => {
    const pin = await pinned();
    // Status rewrite (applyTicketStatus) → same body → NOT drift.
    await putDoc('SR-0001', 'ticket.md', '---\nstatus: blocked\n---\nbody\n');
    let drift = await detectBaselineDrift({
      store,
      workspace: WS,
      subject: 'SR-0001',
      pinned: pin,
    });
    expect(drift).toEqual([]);

    // AC/body change → drift (pause-reconcile).
    await putDoc(
      'SR-0001',
      'ticket.md',
      '---\nstatus: blocked\n---\nbody + new AC\n',
    );
    drift = await detectBaselineDrift({
      store,
      workspace: WS,
      subject: 'SR-0001',
      pinned: pin,
    });
    expect(drift.map((d) => d.field)).toEqual(['ticket_rev']);
    expect(classifyBaselineDrift(drift)).toBe('pause-reconcile');
  });
});

// ---------------------------------------------------------------------------
// reconcileRunBaseline — gate item + reconciled event
// ---------------------------------------------------------------------------

describe('reconcileRunBaseline', () => {
  it('surfaces a baseline-drift gate + baseline_reconciled event, idempotently', async () => {
    await seedTicket('SR-0001');
    await putDoc('SR-0001', 'rs.md', 'rs v1\n- [ ] AC-1\n');
    const pinned = await resolveRunBaseline({
      store,
      workspace: WS,
      subject: 'SR-0001',
    });
    const run = runRow({ request: { baseline: pinned } });
    await store.createRun(run);

    // No drift yet.
    let res = await reconcileRunBaseline(bctx(), run);
    expect(res.decision).toBe('continue');
    expect(
      await store.getGateItem({
        workspace: WS,
        subject: 'SR-0001',
        gate: BASELINE_DRIFT_GATE,
      }),
    ).toBeNull();

    // RS moves past the pin → drift.
    await putDoc('SR-0001', 'rs.md', 'rs v2\n');
    res = await reconcileRunBaseline(bctx(), run);
    expect(res.decision).toBe('stop-replan');
    expect(res.surfaced).toBe(true);

    const gate = await store.getGateItem({
      workspace: WS,
      subject: 'SR-0001',
      gate: BASELINE_DRIFT_GATE,
    });
    expect(gate).not.toBeNull();
    expect(gate?.blocked_agent).toBe(true);
    expect(gate?.priority).toBe('high');

    const events = await store.listEvents({
      workspace: WS,
      event: 'baseline_reconciled',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.run).toBe(run.id);
    expect((events[0]?.data as { decision?: string })?.decision).toBe(
      'stop-replan',
    );
    const drift = (events[0]?.data as { drift?: { field: string }[] })?.drift;
    expect(drift?.map((d) => d.field)).toEqual(['rs_version']);

    // Idempotent: the open gate already carries the drift — no re-emit.
    res = await reconcileRunBaseline(bctx(), run);
    expect(res.surfaced).toBe(false);
    expect(
      await store.listEvents({ workspace: WS, event: 'baseline_reconciled' }),
    ).toHaveLength(1);
  });

  it('does nothing for a run with no pinned baseline', async () => {
    const run = runRow({ request: null });
    const res = await reconcileRunBaseline(bctx(), run);
    expect(res).toEqual({ decision: 'continue', drift: [], surfaced: false });
    expect(await store.listGateItems({ workspace: WS, open: true })).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// reconcileAffectedRuns — ChangeSet fan-out
// ---------------------------------------------------------------------------

describe('reconcileAffectedRuns (ChangeSet fan-out)', () => {
  it('reconciles only live runs pinned to an affected subject', async () => {
    await seedTicket('SR-0001');
    await seedTicket('SR-0002');
    await putDoc('SR-0001', 'rs.md', 'rs v1\n');
    await putDoc('SR-0002', 'rs.md', 'rs v1\n');
    const pin1 = await resolveRunBaseline({
      store,
      workspace: WS,
      subject: 'SR-0001',
    });
    const pin2 = await resolveRunBaseline({
      store,
      workspace: WS,
      subject: 'SR-0002',
    });
    await store.createRun(
      runRow({
        id: `${WS}/SR-0001/001-implement`,
        subject: 'SR-0001',
        request: { baseline: pin1 },
      }),
    );
    await store.createRun(
      runRow({
        id: `${WS}/SR-0002/001-implement`,
        subject: 'SR-0002',
        ticket_id: 'SR-0002',
        request: { baseline: pin2 },
      }),
    );

    // The ChangeSet applied rs.md v2 on SR-0001 only.
    await putDoc('SR-0001', 'rs.md', 'rs v2\n');
    const decisions = await reconcileAffectedRuns(bctx(), ['SR-0001']);

    expect([...decisions.entries()]).toEqual([
      [`${WS}/SR-0001/001-implement`, 'stop-replan'],
    ]);
    // SR-0002 is unaffected — no gate.
    expect(
      await store.getGateItem({
        workspace: WS,
        subject: 'SR-0002',
        gate: BASELINE_DRIFT_GATE,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// launch integration — pin at queue, no retro-edit at relaunch
// ---------------------------------------------------------------------------

describe('launch integration (fixture world)', () => {
  let world: FixtureWorld | null = null;

  afterEach(async () => {
    await world?.dispose();
    world = null;
  });

  function toolCtx(w: FixtureWorld) {
    const ws: ConductorWorkspace = { name: WS, rootPath: w.dir };
    return {
      deps: w.conductor.deps,
      ws,
      leases: w.conductor.leases,
      handles: w.conductor.handles,
      killedForCap: w.conductor.killedForCap,
    };
  }

  it('queuePendingRun pins a complete baseline on the pending row', async () => {
    const { queuePendingRun } = await import('../src/launch/index.js');
    world = await makeFixtureWorld({ script: () => 'done' });
    const id = await queuePendingRun(toolCtx(world), {
      workspace: WS,
      subject: 'SR-0001',
      stage: 'implement',
      ticketId: 'SR-0001',
    });
    expect(id).not.toBeNull();
    const row = await world.store.getRun(id as string);
    const baseline = (row?.request as { baseline?: RunBaseline } | null)
      ?.baseline;
    expect(baseline).toBeDefined();
    // ticket.md is seeded at v1 by the fixture; no rs.md/tdd.md yet.
    expect(baseline?.ticket_rev).toBe(1);
    expect(baseline?.rs_version).toBeNull();
    expect(Array.isArray(baseline?.ac_ids)).toBe(true);
  });

  it(
    'relaunch reuses the pinned set — a moved doc head is NOT retro-edited',
    { timeout: 60_000 },
    async () => {
      const { launch } = await import('../src/launch/index.js');
      world = await makeFixtureWorld({ script: () => 'done' });
      const ctx = toolCtx(world);
      const { queuePendingRun } = await import('../src/launch/index.js');
      const id = await queuePendingRun(ctx, {
        workspace: WS,
        subject: 'SR-0001',
        stage: 'triage',
        ticketId: 'SR-0001',
      });
      const pending = await world.store.getRun(id as string);
      expect(
        (pending?.request as { baseline?: RunBaseline })?.baseline?.ticket_rev,
      ).toBe(1);

      // The ticket doc moves on BEFORE the run actually launches.
      await world.store.appendDocVersion(
        { workspace: WS, subject: 'SR-0001', doc: 'ticket.md' },
        '---\nstatus: ready\n---\nrewritten body\n',
        'test-seed',
      );

      await launch(ctx, {
        workspace: WS,
        subject: 'SR-0001',
        stage: 'triage',
        ticketId: 'SR-0001',
        pendingRow: pending as RunRow,
      });
      const launched = await world.store.getRun(id as string);
      const baseline = (launched?.request as { baseline?: RunBaseline } | null)
        ?.baseline;
      // The pin is the version recorded at QUEUE time (v1) — the newer
      // head (v2) was not silently adopted.
      expect(baseline?.ticket_rev).toBe(1);
    },
  );
});
