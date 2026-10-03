/**
 * RECONCILE — CONDUCTOR.md loop step 1.
 *
 * Per workspace, each tick:
 *   1. `git pull --rebase` the tickets repo (skipped when the checkout
 *      has no `origin` remote — local-only installs), then rebuild the
 *      `tickets`/`ticket_repos` projections from frontmatter.
 *   2. Sweep live runs: pid liveness + artifact/log mtime →
 *      `runs.heartbeat_at` (conductor-observed — the detached process
 *      never touches the DB). Dead heartbeat → `stalled` warn; stage
 *      timeout exceeded → kill + `run_killed`, ticket status stays for
 *      retry.
 *   3. Collect exited runs via adapter.collect → usage.json →
 *      sanitizer scan (fail-closed → `repair` gate) → write the run
 *      row → release the lease → hand the sentinel to the
 *      TransitionHandler (wp-031) → notifications on failure events.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunResult, RunRow, Stage } from '@sprint-runner/core';
import { git, pullRebase } from '@sprint-runner/gitops';
import type { RunOutcome } from '../contracts.js';
import { applyTicketStatus } from '../contracts.js';
import { collectArtifacts, scanArtifacts } from '../envops/index.js';
import { blockTicketForCap } from '../launch/caps-action.js';
import { queuePendingRun } from '../launch/index.js';
import { capExceeded } from '../loop/caps.js';
import {
  type ConductorDeps,
  type ConductorWorkspace,
  actorOf,
  adapterFor,
  gitActor,
  lastActivityMs,
  loadHandle,
  nowIso,
  pidAlive,
  stageTimeout,
} from '../loop/deps.js';
import type { LeaseManager } from '../loop/lease.js';
import { retryDecision } from '../loop/retry.js';
import { makeTransitionTools } from '../loop/tools.js';
import { projectTickets } from '../projection/index.js';

export interface ReconcileReport {
  pulled: string[];
  stalled: string[];
  killed: string[];
  collected: string[];
  warnings: string[];
}

interface ReconcileCtx {
  deps: ConductorDeps;
  ws: ConductorWorkspace;
  leases: LeaseManager;
  handles: Map<string, import('@sprint-runner/core').RunHandle>;
  killedForCap: Set<string>;
  report: ReconcileReport;
}

/** Does this tickets-repo checkout have an `origin` remote? */
async function hasOrigin(repo: string): Promise<boolean> {
  try {
    const { stdout } = await git(['remote'], { cwd: repo });
    return stdout.split('\n').some((l) => l.trim() === 'origin');
  } catch {
    return false;
  }
}

export async function reconcile(ctx: ReconcileCtx): Promise<void> {
  const { deps, ws, report } = ctx;

  // --- step 1a: pull + project (CONDUCTOR loop step 1) ---
  if (deps.pull !== false && (await hasOrigin(ws.ticketsRepoPath))) {
    try {
      await pullRebase(ws.ticketsRepoPath);
      report.pulled.push(ws.name);
    } catch (e) {
      // pull-rebase-retry is bounded upstream in real ops; a failed pull
      // must not stall the tick — the projection still reflects HEAD.
      report.warnings.push(`pull ${ws.name}: ${(e as Error).message}`);
    }
  }
  await projectTickets(ws.ticketsRepoPath, deps.store, ws.name);
  await deps.store.sweepExpiredLeases(nowIso(deps));

  // --- step 1b: sweep live runs ---
  for (const run of await deps.store.listLiveRuns()) {
    if (run.workspace !== ws.name) continue;
    try {
      await sweepRun(ctx, run);
    } catch (e) {
      report.warnings.push(`run ${run.id}: ${(e as Error).message}`);
    }
  }
}

/** Liveness/timeout sweep for one live run. */
async function sweepRun(ctx: ReconcileCtx, run: RunRow): Promise<void> {
  const { deps, report } = ctx;
  const now = nowIso(deps);

  switch (run.status) {
    case 'pending':
    case 'leased':
      // CLAIM/LAUNCH owns these — not spawned yet.
      return;
    case 'collecting':
    case 'validated':
    case 'committed':
    case 'blocked':
      return;
    case 'exited': {
      await collectRun(ctx, run);
      return;
    }
    default:
      break; // running | paused | stalled
  }

  const handle = ctx.handles.get(run.id) ?? (await loadHandle(run));
  if (handle) ctx.handles.set(run.id, handle);
  const alive = pidAlive(handle?.pid ?? run.pid);

  if (!alive) {
    // Process exited between ticks → mark and collect inline
    // (CONDUCTOR: "fires every ~10s tick + on run-exit").
    await deps.store.updateRun(run.id, { status: 'exited', exited_at: now });
    await collectRun(ctx, { ...run, status: 'exited', exited_at: now });
    return;
  }

  // Conductor-observed heartbeat (DB-SCHEMA rules).
  await deps.store.heartbeatRun(run.id, now);
  await ctx.leases.heartbeat(
    {
      workspace: run.workspace,
      subject: run.subject,
      stage: run.stage,
      attempt: run.attempt,
    },
    now,
  );

  if (run.status === 'paused') return; // pause freezes work, not the clock

  // Stage timeout → kill + run_killed; ticket status stays for retry.
  const timeoutS = stageTimeout(deps, run.stage);
  const startedMs = Date.parse(run.started_at ?? '');
  if (Number.isFinite(startedMs) && Date.now() - startedMs > timeoutS * 1000) {
    await killRun(ctx, run, `timeout (${timeoutS}s)`);
    return;
  }

  // Heartbeat staleness: pid alive but no log/artifact progress for
  // ~2 ticks → stalled warn (CONDUCTOR/DB-SCHEMA).
  const stallAfterMs = deps.stallAfterMs ?? 25_000;
  const lastActivity = await lastActivityMs(run, handle ?? null);
  if (Date.now() - lastActivity > stallAfterMs) {
    if (run.status !== 'stalled') {
      await deps.store.updateRun(run.id, { status: 'stalled' });
      report.stalled.push(run.id);
    }
  } else if (run.status === 'stalled') {
    // Recovered progress.
    await deps.store.updateRun(run.id, { status: 'running' });
  }
}

/** Kill a timed-out/dead run (preserve the worktree; status stays
 *  for retry — CONDUCTOR "Run lifecycle"). */
async function killRun(
  ctx: ReconcileCtx,
  run: RunRow,
  reason: string,
): Promise<void> {
  const { deps, ws, report } = ctx;
  const ts = nowIso(deps);
  const handle = ctx.handles.get(run.id) ?? (await loadHandle(run));
  const adapter = deps.adapters[run.backend ?? ''];
  if (handle && adapter) {
    await Promise.resolve(adapter.control(handle, 'kill')).catch(() => {});
  }
  await deps.store.updateRun(run.id, { status: 'killed', exited_at: ts });
  await deps.store.appendEvent({
    workspace: ws.name,
    ticket_id: run.ticket_id,
    ts,
    stage: run.stage,
    actor_type: 'runner',
    actor_id: actorOf(deps),
    event: 'run_killed',
    run: run.id,
    refs: [],
    data: { reason },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  await ctx.leases.release(ws, {
    workspace: run.workspace,
    subject: run.subject,
    stage: run.stage,
    attempt: run.attempt,
  });
  report.killed.push(run.id);
  // "status stays for retry" (CONDUCTOR "Run lifecycle") — a killed run
  // is a transient failure; it must re-enter the retry ladder or the
  // ticket strands on its current status forever.
  const killed = await deps.store.getRun(run.id);
  if (killed) await applyRetryLadder(ctx, killed);
}

/**
 * Collect an exited run: artifacts → sanitizer → usage → run row →
 * release lease → TransitionHandler handoff (CONDUCTOR reconcile
 * step 1, ADAPTERS collect contract + failure mapping).
 */
async function collectRun(ctx: ReconcileCtx, run: RunRow): Promise<void> {
  const { deps, ws } = ctx;
  const ts = nowIso(deps);
  await deps.store.updateRun(run.id, { status: 'collecting' });

  const handle = ctx.handles.get(run.id) ?? (await loadHandle(run));
  const adapter = adapterFor(deps, run.backend ?? deps.config.backend);
  const runDir = run.run_dir ?? join(deps.runsDir, ...run.id.split('/'));
  const ticketDir = run.ticket_id
    ? join(ws.ticketsRepoPath, 'tickets', run.ticket_id)
    : undefined;

  let result: RunResult;
  if (handle) {
    result = await adapter.collect(handle, {
      workspace: ws.name,
      run_dir: runDir,
      run_id: run.id,
      ...(ticketDir ? { ticket_dir: ticketDir } : {}),
    });
  } else {
    result = {
      sentinel: null,
      sentinel_raw: null,
      artifacts: [],
      usage: null,
      exit_code: null,
    };
  }

  // Scratch-dir collection for backends that can't write outside the
  // tree (ADAPTERS ARTIFACT_TARGETS — the diff never sees them).
  if (run.worktree && !adapter.capabilities.can_write_outside_tree) {
    const collect = await collectArtifacts({
      worktree: run.worktree,
      runId: run.id,
      runDir,
      canWriteOutsideTree: false,
    });
    if (!collect.ok) {
      await surfaceRepair(ctx, run, {
        reason: 'scratch-residue',
        residue: collect.residue,
      });
      await finishFailed(ctx, run, result, ts);
      return;
    }
  }

  // usage.json — always written when the adapter produced a ledger
  // (SCHEMAS §13; extraction failure → source: estimated, never blocks).
  let usagePath: string | null = null;
  if (result.usage) {
    usagePath = join(runDir, 'usage.json');
    await writeFile(
      usagePath,
      `${JSON.stringify(result.usage, null, 2)}\n`,
      'utf8',
    );
  }

  // Sanitizer scan (SETTINGS security.scan_on_commit — FAIL-CLOSED).
  const scan = deps.scan ?? ((paths: string[]) => scanArtifacts(paths));
  if (deps.config.security.scan_on_commit && result.artifacts.length > 0) {
    const scanResult = await scan(result.artifacts);
    if (!scanResult.ok) {
      await surfaceRepair(ctx, run, {
        reason: `sanitizer-${scanResult.reason}`,
        scanner: scanResult.scanner,
        findings: scanResult.findings,
        ...(scanResult.detail ? { detail: scanResult.detail } : {}),
      });
      await finishFailed(ctx, run, result, ts);
      return;
    }
  }

  // Usage → run row + per-call ledger projection.
  const totals = result.usage?.totals;
  // ADAPTERS failure mapping: exit 124 = timeout → run_killed,
  // aborted-eligible (the ticket status stays for retry).
  const timedOut = result.exit_code === 124;
  const failed = !timedOut && result.sentinel === null;
  await deps.store.updateRun(run.id, {
    status: timedOut ? 'killed' : failed ? 'failed' : 'done',
    exited_at: run.exited_at ?? ts,
    sentinel: result.sentinel,
    sentinel_raw: result.sentinel_raw,
    cost_usd: totals?.cost_usd ?? null,
    tokens_in: totals?.tokens_in ?? null,
    tokens_out: totals?.tokens_out ?? null,
    tokens_cached: totals?.tokens_cached ?? null,
    usage_source: result.usage?.source ?? null,
    duration_s: totals?.duration_s ?? null,
    run_dir: runDir,
  });
  if (result.usage?.calls.length) {
    await deps.store.insertUsageCalls(
      result.usage.calls.map((c) => ({ ...c, run_id: run.id })),
    );
  }

  await deps.store.appendEvent({
    workspace: ws.name,
    ticket_id: run.ticket_id,
    ts,
    stage: run.stage,
    actor_type: 'runner',
    actor_id: actorOf(deps),
    event: timedOut ? 'run_killed' : failed ? 'run_failed' : 'run_finished',
    run: run.id,
    refs: result.artifacts.map((a) => a.replace(`${runDir}/`, '')),
    data: {
      sentinel: result.sentinel,
      sentinel_raw: result.sentinel_raw,
      exit_code: result.exit_code,
    },
    cost_usd: totals?.cost_usd ?? null,
    tokens_in: totals?.tokens_in ?? null,
    tokens_out: totals?.tokens_out ?? null,
    tokens_cached: totals?.tokens_cached ?? null,
    usage_source: result.usage?.source ?? null,
    duration_s: totals?.duration_s ?? null,
    human_minutes: null,
  });

  await ctx.leases.release(ws, {
    workspace: run.workspace,
    subject: run.subject,
    stage: run.stage,
    attempt: run.attempt,
  });
  const finalRun = (await deps.store.getRun(run.id)) ?? run;
  ctx.report.collected.push(run.id);

  if (timedOut) {
    ctx.report.killed.push(run.id);
    // killed — no transition handoff, but the retry ladder still applies
    // (CONDUCTOR "status stays for retry").
    await applyRetryLadder(ctx, finalRun);
    return;
  }

  // Dual caps are evaluated at run end too (CONDUCTOR "Run lifecycle").
  if (run.ticket_id) {
    const cap = await capExceeded(deps, ws.name, run.ticket_id);
    if (cap) {
      await blockTicketForCap(ctx, finalRun, cap);
      return; // ticket blocked — no transition this round
    }
  }

  if (failed) {
    await applyRetryLadder(ctx, finalRun);
    return;
  }

  // --- sentinel → TransitionHandler (wp-031 seam) ---
  const outcome: RunOutcome = {
    run: finalRun,
    result,
    usagePath,
    ...(ticketDir ? { ticketDir } : {}),
  };
  const tools = makeTransitionTools(ctx);
  await deps.transitions.onRunComplete(outcome, tools);
}

/** Shared tail for sanitizer/residue blocks: run_failed + release. */
async function finishFailed(
  ctx: ReconcileCtx,
  run: RunRow,
  result: { sentinel: string | null; sentinel_raw: string | null },
  ts: string,
): Promise<void> {
  const { deps, ws } = ctx;
  await deps.store.updateRun(run.id, {
    status: 'failed',
    exited_at: run.exited_at ?? ts,
    sentinel: result.sentinel,
    sentinel_raw: result.sentinel_raw,
  });
  await deps.store.appendEvent({
    workspace: ws.name,
    ticket_id: run.ticket_id,
    ts,
    stage: run.stage,
    actor_type: 'runner',
    actor_id: actorOf(deps),
    event: 'run_failed',
    run: run.id,
    refs: [],
    data: { reason: 'fail-closed collect path' },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  await ctx.leases.release(ws, {
    workspace: run.workspace,
    subject: run.subject,
    stage: run.stage,
    attempt: run.attempt,
  });
  ctx.report.collected.push(run.id);
}

/** Fail-closed block → `repair` gate item + notification (CONDUCTOR
 *  "a scan error or finding blocks the commit and surfaces a repair
 *  gate item"). */
async function surfaceRepair(
  ctx: ReconcileCtx,
  run: RunRow,
  detail: Record<string, unknown>,
): Promise<void> {
  const { deps, ws } = ctx;
  const ts = nowIso(deps);
  const subject = run.ticket_id ?? run.subject;
  await deps.store.upsertGateItem({
    workspace: ws.name,
    subject,
    gate: 'repair',
    kind: 'repair',
    surfaced_at: ts,
    cleared_at: null,
    blocked_agent: true,
    priority: null,
  });
  await deps.store.insertNotification({
    workspace: ws.name,
    subject,
    kind: 'gate:repair',
    payload: JSON.stringify({ gate: 'repair', run: run.id, ...detail }),
    created_at: ts,
    read_at: null,
  });
}

/** Missing/unparseable sentinel → `run_failed` (conductor-owned;
 *  CONDUCTOR "Run lifecycle") → retry ladder → ticket `failed` when
 *  the ladder is exhausted. */
async function applyRetryLadder(ctx: ReconcileCtx, run: RunRow): Promise<void> {
  const { deps, ws } = ctx;
  const all = await deps.store.listRuns({
    workspace: ws.name,
    subject: run.subject,
  });
  const failures = all.filter(
    (r) => r.stage === run.stage && ['failed', 'killed'].includes(r.status),
  ).length;

  // Missing sentinel / nonzero exit / no handle = transient-shaped.
  const verdict = retryDecision({
    stage: run.stage,
    transient: true,
    failures,
    escalationModel: deps.config.escalation_model ?? null,
  });

  if (verdict.kind === 'retry') {
    await queuePendingRun(ctx, {
      workspace: ws.name,
      subject: run.subject,
      stage: run.stage as Stage,
      ...(run.ticket_id ? { ticketId: run.ticket_id } : {}),
      ...(verdict.model ? { model: verdict.model } : {}),
    });
    return;
  }

  // Ladder exhausted → the ticket itself goes `failed`.
  if (run.ticket_id) {
    await applyTicketStatus({
      ctx: {
        workspace: ws.name,
        ticketsRepoPath: ws.ticketsRepoPath,
        store: deps.store,
        actor: actorOf(deps),
        now: () => new Date(),
      },
      opts: {
        ticketId: run.ticket_id,
        status: 'failed',
        run: run.id,
        data: { reason: 'retry ladder exhausted' },
      },
      actor: gitActor(deps),
    });
  }
}
