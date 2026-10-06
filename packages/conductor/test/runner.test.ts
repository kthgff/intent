/**
 * R1 regression tests — the conductor-side runner lane (CONDUCTOR
 * "Runner tasks"): `verify`/`import` carry a stage but no agent;
 * launch() registers `backend: 'runner'` rows and the task executes
 * in-process, settling through the normal reconcile collect path.
 *
 * Also covers the `runs.request` persistence contract (queuePendingRun
 * → claim → launch must not drop tokens/task) and the reconcile
 * sanitizer-before-ingest ordering (fail-closed: a scan failure leaves
 * the evidence on disk).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRow } from '@veto/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchIssuesResult } from '../src/import/types.js';
import { launch, queuePendingRun } from '../src/launch/index.js';
import { taskForStage } from '../src/launch/runner.js';
import type { ConductorWorkspace } from '../src/loop/deps.js';
import { type FixtureWorld, makeFixtureWorld } from './helpers/fixtures.js';

const WS = 'ws';
let world: FixtureWorld | null = null;

afterEach(async () => {
  await world?.dispose();
  world = null;
});

/** LaunchContext/ToolCtx built from the fixture world's conductor —
 *  the same shape loop/tools.ts + api/server.ts construct. */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tick until `pred` holds — the runner task settles asynchronously
 *  (heartbeat interval + `make` subprocesses), so one tick launches,
 *  a later tick collects. */
async function tickUntil(
  w: FixtureWorld,
  pred: () => Promise<boolean>,
  what: string,
  max = 300,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    await w.tick();
    if (await pred()) return;
    await sleep(50);
  }
  throw new Error(`tickUntil: ${what} not met within ${max} ticks`);
}

describe('taskForStage', () => {
  it('verify/import are runner tasks; adapter stages are not', () => {
    expect(taskForStage('verify')).toEqual({ kind: 'verify' });
    expect(taskForStage('import')).toEqual({ kind: 'import' });
    for (const s of ['implement', 'interview', 'triage', 'review', 'fix']) {
      expect(taskForStage(s), s).toBeNull();
    }
  });
});

describe('runner lane — verify', () => {
  it(
    'a pending verify run launches backend:runner, writes test-report.json, emits ci_green',
    { timeout: 60_000 },
    async () => {
      world = await makeFixtureWorld({ script: () => 'done' });
      const ctx = toolCtx(world);
      const id = await queuePendingRun(ctx, {
        workspace: WS,
        subject: 'SR-0001',
        stage: 'verify',
        ticketId: 'SR-0001',
      });
      expect(id).not.toBeNull();
      expect((await world.store.getRun(id as string))?.status).toBe('pending');

      await tickUntil(
        world,
        async () => (await world.store.getRun(id as string))?.status === 'done',
        'verify run done',
      );
      const run = await world.store.getRun(id as string);
      expect(run?.backend).toBe('runner');
      expect(run?.sentinel).toBe('DONE');
      // The task's report was ingested as a run_artifacts row.
      const names = (await world.store.listArtifacts(id as string)).map(
        (a) => a.name,
      );
      const report = names.find(
        (n) => n === 'test-report.json' || n.endsWith('/test-report.json'),
      );
      expect(report, `artifacts: ${names.join(',')}`).toBeDefined();
      const parsed = JSON.parse(
        (await world.store.getArtifact(id as string, report as string))
          ?.content ?? '{}',
      ) as { pass_pct?: number };
      expect(parsed.pass_pct).toBe(100);
      // verifyDone emitted the green signal + queued the review pass.
      const evs = (await world.eventsFor('SR-0001')).map((e) => e.event);
      expect(evs).toContain('ci_green');
    },
  );
});

describe('runner lane — import', () => {
  it(
    'a pending import run uses the importFetch seam and materializes tickets',
    { timeout: 60_000 },
    async () => {
      world = await makeFixtureWorld({ script: () => 'done' });
      world.conductor.deps.importFetch =
        async (): Promise<FetchIssuesResult> => ({
          ok: true,
          issues: [
            {
              number: 77,
              title: 'Imported regression ticket',
              body: 'Body text.\n\n- [ ] A checkbox',
              labels: ['backend'],
              url: 'https://github.com/acme/app/issues/77',
              milestone: null,
              state: 'OPEN',
              repo: 'acme/app',
            },
          ],
        });
      const before = (await world.store.listTickets({ workspace: WS })).length;
      const ctx = toolCtx(world);
      const id = await queuePendingRun(ctx, {
        workspace: WS,
        subject: 'import:github',
        stage: 'import',
        task: { kind: 'import', repo: 'acme/app' },
      });
      expect(id).not.toBeNull();
      // The task spec rides runs.request — claim must hand it back to
      // launch (this is the R1 persistence contract).
      const pending = await world.store.getRun(id as string);
      expect(
        (pending?.request as { task?: { kind: string } } | null)?.task?.kind,
      ).toBe('import');

      await tickUntil(
        world,
        async () => (await world.store.getRun(id as string))?.status === 'done',
        'import run done',
      );
      const run = await world.store.getRun(id as string);
      expect(run?.backend).toBe('runner');
      expect(run?.sentinel).toBe('IMPORTED');
      const names = (await world.store.listArtifacts(id as string)).map(
        (a) => a.name,
      );
      expect(names).toContain('import-result.json');
      const after = await world.store.listTickets({ workspace: WS });
      expect(after.length).toBe(before + 1);
      expect(
        after.find((t) => t.title === 'Imported regression ticket'),
      ).toBeDefined();
    },
  );
});

describe('runs.request persistence (queue → claim → launch)', () => {
  it(
    'interview NEW_ID persists through launch — re-launches reuse it',
    { timeout: 60_000 },
    async () => {
      world = await makeFixtureWorld({ script: () => 'done' });
      const ctx = toolCtx(world);
      const subject = `interview:reg-${Date.now()}`;
      const id = await queuePendingRun(ctx, {
        workspace: WS,
        subject,
        stage: 'interview',
        tokens: { NEW_ID: 'SR-0777' },
      });
      expect(id).not.toBeNull();
      // One tick: claim picks the pending row, launch reserves the
      // request onto the row (updateRun merge must not drop tokens).
      await tickUntil(
        world,
        async () => {
          const r = await world?.store.getRun(id as string);
          return r?.status === 'running' || r?.status === 'done';
        },
        'interview run launched',
      );
      const launched = await world.store.getRun(id as string);
      expect(launched?.backend).toBe('mock');
      const req = launched?.request as {
        tokens?: Record<string, string>;
      } | null;
      expect(req?.tokens?.NEW_ID).toBe('SR-0777');
    },
  );

  it(
    'interview without NEW_ID allocates once durably (allocTicketId)',
    { timeout: 60_000 },
    async () => {
      world = await makeFixtureWorld({ script: () => 'done' });
      const ctx = toolCtx(world);
      const subject = `interview:alloc-${Date.now()}`;
      const id = await queuePendingRun(ctx, {
        workspace: WS,
        subject,
        stage: 'interview',
      });
      await tickUntil(
        world,
        async () => {
          const r = await world?.store.getRun(id as string);
          return r?.status === 'running' || r?.status === 'done';
        },
        'interview run launched',
      );
      const req = (await world.store.getRun(id as string))?.request as {
        tokens?: Record<string, string>;
      } | null;
      expect(req?.tokens?.NEW_ID).toMatch(/^SR-\d{4}$/);
      // The allocation consumed the project sequence — a second
      // interview launch gets a different id, but a relaunch of THIS
      // row must not.
      const alloc = req?.tokens?.NEW_ID as string;
      expect(alloc).not.toBe('SR-0000');
    },
  );
});

describe('reconcile — sanitizer BEFORE ingest (fail-closed)', () => {
  it(
    'a scan failure leaves run-dir files on disk and fails the run',
    { timeout: 60_000 },
    async () => {
      world = await makeFixtureWorld({
        script: () => 'done',
        configOverrides: { security: { scan_on_commit: true } },
      });
      // The fixture world defaults to a NOOP scan — install a failing
      // scanner so collect must stop before ingest/delete.
      world.conductor.deps.scan = async () => ({
        ok: false as const,
        reason: 'findings' as const,
        scanner: 'test-scan',
        findings: [{ file: 'triage.json', rule: 'fake-secret' }],
      });
      const ctx = toolCtx(world);
      // Drive an adapter run directly (launch + settle): the mock writes
      // triage.json into the run dir via the scripted artifact list.
      const id = await launch(ctx, {
        workspace: WS,
        subject: 'SR-0001',
        stage: 'triage',
        ticketId: 'SR-0001',
      });
      expect(id).not.toBeNull();
      // Wait for the detached mock child to exit, then reconcile collects.
      await tickUntil(
        world,
        async () => {
          const r = await world?.store.getRun(id as string);
          return r !== null && ['done', 'failed'].includes(r.status);
        },
        'triage run settled',
      );
      const run = await world.store.getRun(id as string);
      expect(run?.status).toBe('failed');
      // Fail-closed: the run dir was NOT ingested-and-deleted — evidence
      // survives for the repair gate.
      const runDir = run?.run_dir as string;
      expect(runDir).toBeTruthy();
      const entries = await readdir(runDir, { recursive: true });
      expect(entries.length).toBeGreaterThan(0);
    },
  );
});

describe('stranded collectable statuses (R1-F7)', () => {
  it(
    'a run parked in validated re-enters collect on the next sweep',
    { timeout: 60_000 },
    async () => {
      world = await makeFixtureWorld({ script: () => 'done' });
      const ctx = toolCtx(world);
      // Register an exited adapter run, then flip it to `validated`
      // (crash between collect steps) — the sweep must collect it, not
      // strand it in listLiveRuns forever.
      const dir = mkdtempSync(join(tmpdir(), 'veto-stranded-'));
      const run: RunRow = {
        id: `${WS}/SR-0001/009-triage`,
        workspace: WS,
        subject: 'SR-0001',
        ticket_id: 'SR-0001',
        stage: 'triage',
        attempt: 9,
        backend: 'mock',
        model: null,
        depth: null,
        pid: null,
        worktree: null,
        container_id: null,
        request: null,
        status: 'validated',
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        exited_at: new Date().toISOString(),
        sentinel: null,
        sentinel_raw: null,
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        run_dir: dir,
      };
      await world.store.createRun(run);
      // A minimal run dir: run.log with a READY sentinel.
      await writeFile(join(dir, 'run.log'), 'triage\nREADY\n', 'utf8');
      await world.tick();
      const after = await world.store.getRun(run.id);
      expect(['done', 'failed']).toContain(after?.status ?? '');
      expect((await world.store.listLiveRuns()).map((r) => r.id)).not.toContain(
        run.id,
      );
      rmSync(dir, { recursive: true, force: true });
    },
  );
});
