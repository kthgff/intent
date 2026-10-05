/**
 * Run control (CONDUCTOR "Run lifecycle — Run control"; ADAPTERS
 * control contract): kill = SIGTERM → SIGKILL after grace, pause =
 * SIGSTOP, resume = SIGCONT. Container runs (D30) route through the
 * adapter's docker verbs (kill = `docker kill -s TERM` → grace →
 * `docker kill`; pause/resume = `docker pause`/`unpause`) — the handle
 * carries `container_id` (persisted in handle.json, or synthesized from
 * `runs.container_id` by loadHandle). Same `run_paused`/`run_resumed`/
 * `run_killed` events + run status either way. A paused run's lease and
 * timeout keep ticking — pause freezes work, not the clock.
 */
import type { ControlOp, EventName, RunRow } from '@sprint-runner/core';
import {
  type ConductorDeps,
  actorOf,
  adapterFor,
  loadHandle,
  nowIso,
} from '../loop/deps.js';
import type { LeaseManager } from '../loop/lease.js';

const EVENT_BY_OP: Record<ControlOp, EventName> = {
  kill: 'run_killed',
  pause: 'run_paused',
  resume: 'run_resumed',
};

const STATUS_BY_OP: Record<ControlOp, RunRow['status']> = {
  kill: 'killed',
  pause: 'paused',
  resume: 'running',
};

export async function controlRun(
  deps: ConductorDeps,
  leases: LeaseManager,
  handles: Map<string, import('@sprint-runner/core').RunHandle>,
  runId: string,
  op: ControlOp,
): Promise<void> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new Error(`control ${op}: unknown run ${runId}`);
  const ts = nowIso(deps);

  // `backend: 'runner'` rows have no pid/handle — control ops apply to
  // the DB state only; the in-process task's own timeouts bound its
  // children, and its settle path won't resurrect a killed row
  // (launch/runner.ts SETTLE_FROM).
  if (run.backend !== 'runner') {
    const handle = handles.get(runId) ?? (await loadHandle(run));
    if (handle) handles.set(runId, handle);
    const adapter = adapterFor(deps, run.backend ?? deps.config.backend);
    if (handle) await adapter.control(handle, op);
  }

  // Status flip + audit event commit together (ARCHITECTURE §4.4) —
  // a crash between them must not leave a killed run with no
  // run_killed (notifications key off the event).
  await deps.store.transaction(async (s) => {
    await s.updateRun(runId, {
      status: STATUS_BY_OP[op],
      ...(op === 'kill' ? { exited_at: ts } : {}),
    });
    await s.appendEvent({
      workspace: run.workspace,
      ticket_id: run.ticket_id,
      ts,
      stage: run.stage,
      actor_type: 'runner',
      actor_id: actorOf(deps),
      event: EVENT_BY_OP[op],
      run: runId,
      refs: [],
      data: { op },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
  });
  // API.md stream: run_status after the durable row update.
  deps.notify?.({
    type: 'run_status',
    payload: { id: runId, workspace: run.workspace, status: STATUS_BY_OP[op] },
  });
  if (op === 'kill') {
    // Preserve the worktree (CONDUCTOR) — only the lease is released.
    await leases.release(
      { name: run.workspace, rootPath: '' },
      {
        workspace: run.workspace,
        subject: run.subject,
        stage: run.stage,
        attempt: run.attempt,
      },
    );
  }
}
