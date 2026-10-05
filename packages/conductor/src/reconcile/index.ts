/**
 * RECONCILE — CONDUCTOR.md loop step 1 (rewired wp-092, D29).
 *
 * Per workspace, each tick:
 *   1. Sweep live runs: pid liveness + artifact/log mtime →
 *      `runs.heartbeat_at` (conductor-observed — the detached process
 *      never touches the DB). Dead heartbeat → `stalled` warn; stage
 *      timeout exceeded → kill + `run_killed`, ticket status stays for
 *      retry.
 *   2. Collect exited runs via adapter.collect → ingest the run_dir's
 *      structured output into `run_artifacts`/`doc_versions` rows
 *      (run_dir keeps only transcripts/logs — DB-SCHEMA) → usage →
 *      sanitizer scan (fail-closed → `repair` gate) → write the run
 *      row → release the lease → hand the sentinel to the
 *      TransitionHandler → notifications on failure events.
 *
 *   There is no tickets repo: nothing to pull, nothing to project —
 *   `tickets`/`events`/`doc_versions` ARE the truth (D29).
 */
import type { Dirent } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  DOC_KINDS,
  type RunResult,
  type RunRow,
  type Stage,
} from '@sprint-runner/core';
import { escalationModelFor } from '@sprint-runner/prompts';
import type { RunOutcome, RunnerTask } from '../contracts.js';
import { applyTicketStatus } from '../contracts.js';
import { collectArtifacts, scanArtifacts } from '../envops/index.js';
import { blockTicketForCap } from '../launch/caps-action.js';
import { queuePendingRun } from '../launch/index.js';
import { RUNNER_RESULT_FILE } from '../launch/runner.js';
import { capExceeded } from '../loop/caps.js';
import {
  type ConductorDeps,
  type ConductorWorkspace,
  actorOf,
  adapterFor,
  lastActivityMs,
  loadHandle,
  nowIso,
  pidAlive,
  stageTimeout,
} from '../loop/deps.js';
import type { LeaseManager } from '../loop/lease.js';
import { retryDecision } from '../loop/retry.js';
import { makeTransitionTools } from '../loop/tools.js';

export interface ReconcileReport {
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

export async function reconcile(ctx: ReconcileCtx): Promise<void> {
  const { deps, report } = ctx;
  await deps.store.sweepExpiredLeases(nowIso(deps));

  for (const run of await deps.store.listLiveRuns()) {
    if (run.workspace !== ctx.ws.name) continue;
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
    case 'exited':
      // Stranded transient/legacy run states resolve through the same
      // collect path — a conductor crash between collect steps (or a
      // foreign status write) must not drop the row from the sweep:
      // skipping it here would strand it in listLiveRuns forever.
      await collectRun(ctx, run);
      return;
    default:
      break; // running | paused | stalled
  }

  if (run.backend === 'runner') {
    await sweepRunnerRun(ctx, run);
    return;
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

/**
 * Liveness for `backend: 'runner'` rows — the task runs in-process
 * (launch/runner.ts), so there is no pid and no adapter handle. The
 * task itself refreshes `runs.heartbeat_at` on an interval; the sweep
 * deliberately does NOT heartbeat here — a stale heartbeat is the only
 * crash signal (dead task = dead heartbeat = stalled → stage-timeout
 * kill → retry ladder).
 */
async function sweepRunnerRun(ctx: ReconcileCtx, run: RunRow): Promise<void> {
  const { deps, report } = ctx;

  // Stage timeout still bounds the task (the task's own per-command
  // timeouts usually fire first; this reaps the row regardless).
  const timeoutS = stageTimeout(deps, run.stage);
  const startedMs = Date.parse(run.started_at ?? '');
  if (Number.isFinite(startedMs) && Date.now() - startedMs > timeoutS * 1000) {
    await killRun(ctx, run, `timeout (${timeoutS}s)`);
    return;
  }

  const stallAfterMs = deps.stallAfterMs ?? 25_000;
  const hbMs = Date.parse(run.heartbeat_at ?? run.started_at ?? '');
  const stale = !Number.isFinite(hbMs) || Date.now() - hbMs > stallAfterMs;
  if (stale) {
    if (run.status !== 'stalled') {
      await deps.store.updateRun(run.id, { status: 'stalled' });
      report.stalled.push(run.id);
    }
  } else if (run.status === 'stalled') {
    // Heartbeat resumed (e.g. a recycled conductor re-attached).
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
  // Run row + run_killed event commit together — a half-written kill
  // would drop the notification the event generates.
  await deps.store.transaction(async (s) => {
    await s.updateRun(run.id, { status: 'killed', exited_at: ts });
    await s.appendEvent({
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

// ---------------------------------------------------------------------------
// Run-dir ingestion → run_artifacts + doc_versions (D29)
// ---------------------------------------------------------------------------

/** Files that are runner bookkeeping/logs — never ingested and never
 *  deleted (run_dir = transcripts/logs only, DB-SCHEMA). */
const SKIP_FILES = new Set(['handle.json', 'run.log']);
const SKIP_EXT = /\.(log|ndjson|jsonl)$/;

const DOC_NAMES = new Set<string>(DOC_KINDS);

interface RunDirFile {
  /** Absolute path — what the sanitizer scans. */
  path: string;
  /** `/`-joined path relative to runDir — the run_artifacts name.
   *  Nested names are preserved (`<repo>/test-report.json`); the walk
   *  is rooted at runDir so names can never escape it (readdir yields
   *  no `..`; symlinks fail `isFile()` and are skipped). */
  rel: string;
}

/** Recursive file listing under `runDir`, run-dir-relative names. */
async function walkRunDir(runDir: string): Promise<RunDirFile[]> {
  const out: RunDirFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        out.push({
          path: p,
          rel: p
            .slice(runDir.length + 1)
            .split(sep)
            .join('/'),
        });
      }
    }
  };
  await walk(runDir);
  return out;
}

/** True when `rel` is runner bookkeeping/logs — never ingested. */
function isSkipped(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  return SKIP_FILES.has(base) || SKIP_EXT.test(base);
}

/**
 * Walk `runDir`, ingest every structured file as a `run_artifacts` row
 * (name = run-dir-relative path), promote files whose basename is a
 * DOC_KINDS doc into `doc_versions`, and remove the ingested files so
 * the run dir carries only transcripts/logs (DB-SCHEMA rule).
 *
 * Doc subject rule: a doc nested in `runDir/<subject>/<doc>` belongs
 * to that dir-named subject (interview's `<NEW_ID>/ticket.md`,
 * importer's `<KEY>/ticket.md`, stage docs under `<ticket_id>/`);
 * top-level doc files belong to `run.ticket_id ?? run.subject`.
 */
export async function ingestRunDir(
  ctx: Pick<ReconcileCtx, 'deps'>,
  run: RunRow,
  runDir: string,
): Promise<{ artifacts: string[]; docs: string[] }> {
  const { deps } = ctx;
  const ts = nowIso(deps);
  const ingested: { artifacts: string[]; docs: string[] } = {
    artifacts: [],
    docs: [],
  };

  for (const { path: file, rel } of await walkRunDir(runDir)) {
    const base = rel.split('/').pop() ?? rel;
    if (isSkipped(rel)) continue;

    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue; // unreadable/binary → leave the blob on disk
    }

    await deps.store.putArtifact({
      run_id: run.id,
      name: rel,
      content,
      created_at: ts,
    });
    ingested.artifacts.push(rel);

    if (DOC_NAMES.has(base)) {
      const parts = rel.split('/');
      const head = parts.at(0);
      const subject = parts.length > 1 ? head : (run.ticket_id ?? run.subject);
      if (subject) {
        await deps.store.appendDocVersion(
          { workspace: run.workspace, subject, doc: base as never },
          content,
          actorOf(deps),
        );
        ingested.docs.push(rel);
      }
    }

    // Structured output lives in Postgres now — remove the file so the
    // run dir carries only transcripts/logs (DB-SCHEMA rule).
    await rm(file, { force: true }).catch(() => {});
  }
  return ingested;
}

/**
 * Reconstruct a RunResult for a `backend: 'runner'` row — the task
 * (launch/runner.ts) writes `result.json` + the sentinel as run.log's
 * last non-empty line; both are recovered here. A missing/garbled
 * result file falls back to the log tail so a task that crashed after
 * writing run.log still resolves deterministically.
 */
async function collectRunnerResult(runDir: string): Promise<RunResult> {
  let sentinel: string | null = null;
  let sentinelRaw: string | null = null;
  let exitCode: number | null = null;
  try {
    const raw = JSON.parse(
      await readFile(join(runDir, RUNNER_RESULT_FILE), 'utf8'),
    ) as Record<string, unknown>;
    if (typeof raw.sentinel === 'string') sentinel = raw.sentinel;
    if (typeof raw.sentinel_raw === 'string') sentinelRaw = raw.sentinel_raw;
    if (typeof raw.exit_code === 'number') exitCode = raw.exit_code;
  } catch {
    /* fall through to the log tail */
  }
  if (!sentinelRaw) {
    try {
      const log = await readFile(join(runDir, 'run.log'), 'utf8');
      const last = log
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1);
      if (last) {
        sentinelRaw = last;
        sentinel = (last.split(':', 1)[0] ?? '').trim() || null;
      }
    } catch {
      /* no log either — null sentinel */
    }
  }
  return {
    sentinel,
    sentinel_raw: sentinelRaw,
    artifacts: [],
    usage: null,
    exit_code: exitCode,
  };
}

/**
 * Collect an exited run: adapter/task collect → scratch residue →
 * sanitizer → ingest → usage → run row → release lease →
 * TransitionHandler handoff (CONDUCTOR reconcile step 1, ADAPTERS
 * collect contract + failure mapping).
 *
 * Ordering invariant (fail-closed): the sanitizer runs on the walked
 * run-dir files BEFORE ingest deletes them — a scan failure must leave
 * the evidence in place for the repair gate, not strand it deleted.
 */
async function collectRun(ctx: ReconcileCtx, run: RunRow): Promise<void> {
  const { deps, ws } = ctx;
  const ts = nowIso(deps);
  await deps.store.updateRun(run.id, { status: 'collecting' });

  const runDir = run.run_dir ?? join(deps.runsDir, ...run.id.split('/'));
  // Agents write ticket-scoped docs under `<run_dir>/<ticket_id>/` —
  // the TICKET_DIR token resolves there (launch). Passed to collect so
  // adapters honoring ticket_dir keep working.
  const ticketDir = run.ticket_id ? join(runDir, run.ticket_id) : undefined;

  let result: RunResult;
  if (run.backend === 'runner') {
    // Conductor-side task (launch/runner.ts): no adapter, no handle —
    // the RunResult equivalent is result.json / the run.log tail.
    result = await collectRunnerResult(runDir);
  } else {
    const handle = ctx.handles.get(run.id) ?? (await loadHandle(run));
    const adapter = adapterFor(deps, run.backend ?? deps.config.backend);
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

    // Scratch-dir collection for backends that can't write outside
    // the tree (ADAPTERS ARTIFACT_TARGETS — the diff never sees them).
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
  }

  // --- sanitizer BEFORE ingest (SETTINGS security.scan_on_commit —
  //     FAIL-CLOSED). Scans every file ingest would trust — walked
  //     under run_dir (containment is inherent: readdir yields no `..`,
  //     symlinks fail isFile()). On failure the files stay on disk for
  //     the repair gate; nothing has been ingested or deleted yet.
  const scannable = (await walkRunDir(runDir)).filter((f) => !isSkipped(f.rel));
  if (deps.config.security.scan_on_commit && scannable.length > 0) {
    const scan = deps.scan ?? ((paths: string[]) => scanArtifacts(paths));
    const scanResult = await scan(scannable.map((f) => f.path));
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

  // usage.json — a run_artifacts row now (DB-SCHEMA: "was usage.json —
  // now the run_artifacts row of the same name"); extraction failure →
  // source: estimated, never blocks.
  if (result.usage) {
    await deps.store.putArtifact({
      run_id: run.id,
      name: 'usage.json',
      content: `${JSON.stringify(result.usage, null, 2)}\n`,
      created_at: ts,
    });
  }

  // Ingest structured output → run_artifacts + doc_versions rows.
  const ingested = await ingestRunDir(ctx, { ...run, run_dir: runDir }, runDir);

  // Usage → run row + per-call ledger projection.
  const totals = result.usage?.totals;
  // ADAPTERS failure mapping: exit 124 = timeout → run_killed,
  // aborted-eligible (the ticket status stays for retry).
  const timedOut = result.exit_code === 124;
  const failed = !timedOut && result.sentinel === null;
  // Terminal row + usage ledger + lifecycle event commit together —
  // a crash mid-way must not leave a `done` run with no run_finished
  // (transitions/notification key off the event).
  await deps.store.transaction(async (s) => {
    await s.updateRun(run.id, {
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
      await s.insertUsageCalls(
        result.usage.calls.map((c) => ({ ...c, run_id: run.id })),
      );
    }

    await s.appendEvent({
      workspace: ws.name,
      ticket_id: run.ticket_id,
      ts,
      stage: run.stage,
      actor_type: 'runner',
      actor_id: actorOf(deps),
      event: timedOut ? 'run_killed' : failed ? 'run_failed' : 'run_finished',
      run: run.id,
      refs: ingested.artifacts,
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
  const outcome: RunOutcome = { run: finalRun, result };
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
  // Row + event commit together (same transactional write rule).
  await deps.store.transaction(async (s) => {
    await s.updateRun(run.id, {
      status: 'failed',
      exited_at: run.exited_at ?? ts,
      sentinel: result.sentinel,
      sentinel_raw: result.sentinel_raw,
    });
    await s.appendEvent({
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
  // wp-155: the escalation tier resolves through the routing registry
  // (models.escalation → legacy escalation_model) — no hardcoded model.
  const verdict = retryDecision({
    stage: run.stage,
    transient: true,
    failures,
    escalationModel: escalationModelFor(deps.config),
  });

  if (verdict.kind === 'retry') {
    const isEscalation = 'escalation' in verdict && verdict.escalation;
    // Bounded escalation (PRD §15.12): a premium-tier retry respects the
    // per-ticket spend/token caps BEFORE the stronger model is queued —
    // a capped ticket blocks rather than paying escalation rates.
    if (isEscalation && run.ticket_id) {
      const cap = await capExceeded(deps, ws.name, run.ticket_id);
      if (cap) {
        await blockTerminalRunTicket(ctx, run, cap);
        return;
      }
    }
    // Propagate the runner-task spec (runs.request.task) — an `import`
    // retry must keep its repo/labels/milestone; a bare stage inference
    // would lose them (and task-less `import` fails closed).
    const savedReq =
      run.request && typeof run.request === 'object'
        ? (run.request as {
            task?: RunnerTask;
            tokens?: Record<string, string>;
          })
        : undefined;
    const queuedId = await queuePendingRun(ctx, {
      workspace: ws.name,
      subject: run.subject,
      stage: run.stage as Stage,
      ...(run.ticket_id ? { ticketId: run.ticket_id } : {}),
      ...(verdict.model ? { model: verdict.model } : {}),
      ...(savedReq?.task ? { task: savedReq.task } : {}),
      ...(savedReq?.tokens ? { tokens: savedReq.tokens } : {}),
    });
    // Record the mid-flight model switch for audit (SCHEMAS §7:
    // `model_transition` — the ticket trail explains why the retry runs
    // on a different tier).
    if (queuedId && isEscalation) {
      const ts = nowIso(deps);
      await deps.store.appendEvent({
        workspace: ws.name,
        ticket_id: run.ticket_id,
        ts,
        stage: run.stage,
        actor_type: 'runner',
        actor_id: actorOf(deps),
        event: 'model_transition',
        run: queuedId,
        refs: [run.id],
        data: {
          from_run: run.id,
          from_model: run.model,
          to_model: verdict.model ?? null,
          reason: 'escalation',
          failures,
        },
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        human_minutes: null,
      });
    }
    return;
  }

  // Ladder exhausted → the ticket itself goes `failed`.
  if (run.ticket_id) {
    await applyTicketStatus({
      ctx: {
        workspace: ws.name,
        rootPath: ws.rootPath,
        store: deps.store,
        actor: actorOf(deps),
        now: () => deps.now?.() ?? new Date(),
      },
      opts: {
        ticketId: run.ticket_id,
        status: 'failed',
        run: run.id,
        data: { reason: 'retry ladder exhausted' },
      },
    });
  }
}

/**
 * Ticket-side `blocked` write for an already-terminal run — used when a
 * cap stops the ESCALATION rung (the run died on its own; the cap only
 * prevents the premium retry). Mirrors blockTicketForCap's ticket half
 * without rewriting the finished run row to `killed`.
 */
async function blockTerminalRunTicket(
  ctx: ReconcileCtx,
  run: RunRow,
  cap: import('../loop/caps.js').CapKind,
): Promise<void> {
  const { deps, ws } = ctx;
  if (!run.ticket_id) return;
  const ts = nowIso(deps);
  await deps.store.transaction(async (s) => {
    await s.appendEvent({
      workspace: ws.name,
      ticket_id: run.ticket_id,
      ts,
      stage: run.stage,
      actor_type: 'runner',
      actor_id: actorOf(deps),
      event: 'blocked',
      run: run.id,
      refs: [],
      data: { reason: `cap before model-tier escalation: ${cap}` },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    await applyTicketStatus({
      ctx: {
        workspace: ws.name,
        rootPath: ws.rootPath,
        store: s,
        actor: actorOf(deps),
        now: () => new Date(ts),
      },
      opts: {
        ticketId: run.ticket_id as string,
        status: 'blocked',
        blockedReason: cap,
        run: run.id,
      },
    });
  });
}
