/**
 * Run control (CONDUCTOR "Run lifecycle — Run control"; ADAPTERS
 * control contract): kill = SIGTERM → SIGKILL after grace, pause =
 * SIGSTOP, resume = SIGCONT. A paused run's lease and timeout keep
 * ticking — pause freezes work, not the clock.
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

  const handle = handles.get(runId) ?? (await loadHandle(run));
  if (handle) handles.set(runId, handle);
  const adapter = adapterFor(deps, run.backend ?? deps.config.backend);
  if (handle) await adapter.control(handle, op);

  await deps.store.updateRun(runId, {
    status: STATUS_BY_OP[op],
    ...(op === 'kill' ? { exited_at: ts } : {}),
  });
  await deps.store.appendEvent({
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
  if (op === 'kill') {
    // Preserve the worktree (CONDUCTOR) — only the lease is released.
    await leases.release(
      { name: run.workspace, ticketsRepoPath: '' },
      {
        workspace: run.workspace,
        subject: run.subject,
        stage: run.stage,
        attempt: run.attempt,
      },
    );
  }
}
