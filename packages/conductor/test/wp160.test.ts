/**
 * wp-160 conductor-side backlog items:
 *   2. import failure surfaces over deps.notify (gate_surfaced +
 *      notification emitted AFTER the durable writes)
 *   6. tailRunOutputs — bounded run.log tail → `run_output` SSE events
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamEvent } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_FAILURE_GATE, runImport } from '../src/index.js';
import type { ConductorDeps, ConductorWorkspace } from '../src/loop/deps.js';
import type { LeaseManager } from '../src/loop/lease.js';
import {
  CHUNK_SIZE,
  TAIL_WINDOW,
  newTailState,
  tailRunOutputs,
} from '../src/loop/tail.js';
import type { ToolCtx } from '../src/loop/tools.js';

const WS = 'tail-ws';

let dir: string;
let runsDir: string;
let store: PostgresStore;

function logPath(runId: string): string {
  return join(runsDir, ...runId.split('/'), 'run.log');
}

function writeLog(runId: string, content: string): void {
  const p = logPath(runId);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

async function runningRun(runId: string, status = 'running'): Promise<void> {
  await store.createRun({
    id: runId,
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
    status,
    started_at: null,
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
    run_dir: null,
  });
}

function ctxWith(events: StreamEvent[]): {
  ctx: ToolCtx;
  ws: ConductorWorkspace;
} {
  const ws: ConductorWorkspace = { name: WS, rootPath: dir };
  const deps = {
    store,
    runsDir,
    workspaces: [ws],
    adapters: {},
    notify: (e: StreamEvent) => events.push(e),
  } as unknown as ConductorDeps;
  const ctx: ToolCtx = {
    deps,
    ws,
    leases: {} as LeaseManager,
    handles: new Map(),
    killedForCap: new Set(),
  };
  return { ctx, ws };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-tail-'));
  runsDir = join(dir, 'runs');
  store = await PostgresStore.connect('pglite:');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tailRunOutputs (backlog 6)', () => {
  it('emits new run.log bytes as run_output chunks, then only the delta', async () => {
    const events: StreamEvent[] = [];
    const { ctx, ws } = ctxWith(events);
    const state = newTailState();
    await runningRun(`${WS}/SR-0001/001-implement`);
    writeLog(`${WS}/SR-0001/001-implement`, 'line one\nline two\n');

    await tailRunOutputs(ctx, ws, state);
    const first = events
      .filter((e) => e.type === 'run_output')
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join('');
    expect(first).toBe('line one\nline two\n');

    // No new bytes → no new events.
    events.length = 0;
    await tailRunOutputs(ctx, ws, state);
    expect(events.filter((e) => e.type === 'run_output')).toHaveLength(0);

    // Appended bytes arrive on the next pass.
    appendFileSync(logPath(`${WS}/SR-0001/001-implement`), 'line three\n');
    await tailRunOutputs(ctx, ws, state);
    const second = events
      .filter((e) => e.type === 'run_output')
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join('');
    expect(second).toBe('line three\n');
  });

  it('chunks payloads at CHUNK_SIZE', async () => {
    const events: StreamEvent[] = [];
    const { ctx, ws } = ctxWith(events);
    const state = newTailState();
    const runId = `${WS}/SR-0001/001-implement`;
    await runningRun(runId);
    writeLog(runId, 'x'.repeat(CHUNK_SIZE * 2 + 10));

    await tailRunOutputs(ctx, ws, state);
    const chunks = events
      .filter((e) => e.type === 'run_output')
      .map((e) => (e.payload as { chunk: string }).chunk);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.length).toBe(CHUNK_SIZE);
    expect(chunks[2]?.length).toBe(10);
  });

  it('overflow past TAIL_WINDOW emits a truncation marker, bounded read', async () => {
    const events: StreamEvent[] = [];
    const { ctx, ws } = ctxWith(events);
    const state = newTailState();
    const runId = `${WS}/SR-0001/001-implement`;
    await runningRun(runId);
    writeLog(runId, 'y'.repeat(TAIL_WINDOW + 1000));

    await tailRunOutputs(ctx, ws, state);
    const chunks = events
      .filter((e) => e.type === 'run_output')
      .map((e) => (e.payload as { chunk: string }).chunk);
    expect(chunks[0]).toContain('truncated');
    const bytes = chunks.slice(1).join('').length;
    expect(bytes).toBe(TAIL_WINDOW);
  });

  it('settled run delivers its final bytes once, then releases the offset', async () => {
    const events: StreamEvent[] = [];
    const { ctx, ws } = ctxWith(events);
    const state = newTailState();
    const runId = `${WS}/SR-0001/001-implement`;
    await runningRun(runId);
    writeLog(runId, 'partial\n');
    await tailRunOutputs(ctx, ws, state);
    expect(state.offsets.has(runId)).toBe(true);

    // Run settles with one more line — the tail must still be emitted.
    appendFileSync(logPath(runId), 'final\n');
    await store.updateRun(runId, { status: 'done' });
    events.length = 0;
    await tailRunOutputs(ctx, ws, state);
    const tail = events
      .filter((e) => e.type === 'run_output')
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join('');
    expect(tail).toBe('final\n');
    expect(state.offsets.has(runId)).toBe(false);

    // Third pass: nothing left, no events.
    events.length = 0;
    await tailRunOutputs(ctx, ws, state);
    expect(events).toHaveLength(0);
  });

  it('no notify sink → offsets untouched (late subscriber still gets bytes)', async () => {
    const ws: ConductorWorkspace = { name: WS, rootPath: dir };
    const deps = {
      store,
      runsDir,
      workspaces: [ws],
      adapters: {},
    } as unknown as ConductorDeps;
    const ctx: ToolCtx = {
      deps,
      ws,
      leases: {} as LeaseManager,
      handles: new Map(),
      killedForCap: new Set(),
    };
    const state = newTailState();
    const runId = `${WS}/SR-0001/001-implement`;
    await runningRun(runId);
    writeLog(runId, 'held\n');
    await tailRunOutputs(ctx, ws, state);
    expect(state.offsets.size).toBe(0);
  });
});

describe('import failure → notify (backlog 2)', () => {
  it('emits gate_surfaced + notification AFTER the durable rows', async () => {
    const events: StreamEvent[] = [];
    await runImport({
      subject: 'import:github',
      workspace: WS,
      store,
      repoMap: {},
      fetch: { repo: 'acme/app', ghPath: join(dir, 'missing-gh') },
      notify: (e) => events.push(e),
    });
    const gates = await store.listGateItems({ workspace: WS });
    expect(gates[0]?.gate).toBe(IMPORT_FAILURE_GATE);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['gate_surfaced', 'notification']);
    const gate = events[0]?.payload as { gate: string };
    expect(gate.gate).toBe(IMPORT_FAILURE_GATE);
  });

  it('omitting notify still lands the durable rows (stream optional)', async () => {
    const r = await runImport({
      subject: 'import:github',
      workspace: WS,
      store,
      repoMap: {},
      fetch: { repo: 'acme/app', ghPath: join(dir, 'missing-gh') },
    });
    expect(r.sentinelLine).toMatch(/^IMPORT-FAILED:/);
    expect(await store.listGateItems({ workspace: WS })).toHaveLength(1);
  });
});
