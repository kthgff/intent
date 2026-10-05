/**
 * Runner tasks — conductor-side stages (CONDUCTOR.md "Runner tasks").
 *
 * `verify` and `import` carry `stage` in the runs table like any other
 * stage, but no agent is involved: launch() registers the row with
 * `backend: 'runner'` and the work executes in-process (detached child
 * commands under their own `timeouts.*` budget). On settle the task
 * writes `run.log` (sentinel as the last non-empty line, per the
 * adapter contract) + `result.json` + its artifacts into the run dir,
 * then flips the row to `exited` — RECONCILE collects it exactly like
 * an adapter run (ingest → sanitizer → run row → sentinel handoff to
 * the transition table).
 *
 * Crash semantics: a conductor that dies mid-task leaves a `running`
 * row whose heartbeat goes stale → stalled → stage-timeout kill →
 * retry ladder. Control ops on a runner row update the DB state only —
 * detached child commands self-terminate via their own timeout.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  LeaseKey,
  RunRow,
  TestReport,
  TestReportCase,
  TicketRepoRow,
} from '@sprint-runner/core';
import { TestReportSchema } from '@sprint-runner/core';
import type { RunnerTask } from '../contracts.js';
import { runVerifyTask } from '../envops/index.js';
import type { VerifyResult } from '../envops/index.js';
import type { MaterializeResult } from '../import/materialize.js';
import { runImport } from '../import/run.js';
import {
  type ConductorDeps,
  type ConductorWorkspace,
  actorOf,
  nowIso,
  resolveRepoPath,
  stageTimeout,
} from '../loop/deps.js';
import type { LeaseManager } from '../loop/lease.js';

/** The task's RunResult equivalent — collectRun reads it back for
 *  `backend: 'runner'` rows (there is no adapter.collect). */
export interface RunnerResultFile {
  sentinel: string | null;
  sentinel_raw: string | null;
  exit_code: number | null;
}

export const RUNNER_RESULT_FILE = 'result.json';

export interface RunnerTaskArgs {
  deps: ConductorDeps;
  ws: ConductorWorkspace;
  leases: LeaseManager;
  /** The registered run row (status 'running', backend 'runner'). */
  run: RunRow;
  task: RunnerTask;
  /** Ticket worktrees (verify) — already created/reused by launch(). */
  ticketRepos: TicketRepoRow[];
}

interface TaskOutcome {
  result: RunnerResultFile;
  /** Extra artifacts to drop into the run dir (run_dir-relative). */
  files: Record<string, string>;
  /** Appended to run.log under the sentinel line. */
  log?: string;
}

/** Live statuses a running runner task may legitimately settle from —
 *  a killed/exited row means something else already finished the
 *  lifecycle (control op, timeout kill); don't resurrect it. */
const SETTLE_FROM = new Set(['running', 'paused', 'stalled']);

/** Fire-and-forget executor — launch() calls this and returns; the
 *  task heartbeats, settles its artifacts, and flips `exited` for
 *  the next reconcile sweep. Never throws. */
export async function runRunnerTask(args: RunnerTaskArgs): Promise<void> {
  const { deps, ws, leases, run, task } = args;
  const runDir = run.run_dir ?? join(deps.runsDir, ...run.id.split('/'));
  const leaseKey: LeaseKey = {
    workspace: ws.name,
    subject: run.subject,
    stage: run.stage,
    attempt: run.attempt,
  };

  // The task's own liveness — stale heartbeat after a crash is what
  // the sweep uses to reap zombie runner rows (no pid to signal).
  const beatEvery = Math.max(
    2_000,
    Math.floor((deps.stallAfterMs ?? 25_000) / 4),
  );
  const hb = setInterval(() => {
    const at = nowIso(deps);
    void deps.store.heartbeatRun(run.id, at).catch(() => {});
    void leases.heartbeat(leaseKey, at); // fenced — a stolen lease no-ops
  }, beatEvery);
  hb.unref?.();

  let outcome: TaskOutcome;
  try {
    outcome =
      task.kind === 'import'
        ? await importOutcome(args, runDir)
        : await verifyOutcome(args, runDir);
  } catch (e) {
    outcome = {
      result: { sentinel: null, sentinel_raw: null, exit_code: 1 },
      files: {},
      log: `runner task error: ${(e as Error).message}`,
    };
  }
  clearInterval(hb);

  try {
    for (const [name, content] of Object.entries(outcome.files)) {
      const p = join(runDir, name);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, 'utf8');
    }
    await appendFile(
      join(runDir, 'run.log'),
      `${outcome.log ?? ''}${outcome.result.sentinel_raw ?? ''}\n`,
      'utf8',
    );
    await writeFile(
      join(runDir, RUNNER_RESULT_FILE),
      `${JSON.stringify(outcome.result, null, 2)}\n`,
      'utf8',
    );
    const cur = await deps.store.getRun(run.id);
    if (cur && SETTLE_FROM.has(cur.status)) {
      await deps.store.updateRun(run.id, {
        status: 'exited',
        exited_at: nowIso(deps),
      });
    }
  } catch (e) {
    deps.onError?.(e);
  }
}

// ---------------------------------------------------------------------------
// verify — repo card test/lint/build in the ticket worktree(s)
// ---------------------------------------------------------------------------

async function verifyOutcome(
  args: RunnerTaskArgs,
  runDir: string,
): Promise<TaskOutcome> {
  const { deps, ws, run, ticketRepos } = args;
  const ticketId = run.ticket_id;
  if (!ticketId) {
    return {
      result: { sentinel: null, sentinel_raw: null, exit_code: 1 },
      files: {},
      log: 'verify task: run has no ticket_id — cannot resolve repos\n',
    };
  }
  const ticket = await deps.store.getTicket({
    workspace: ws.name,
    ticket_id: ticketId,
  });
  const repos = ticket?.repos ?? [];
  const timeoutMs = stageTimeout(deps, 'verify') * 1000;
  const perRepo = Math.max(
    1_000,
    Math.floor(timeoutMs / Math.max(repos.length, 1)),
  );

  const cases: TestReportCase[] = [];
  const commands: string[] = [];
  const risks: string[] = [];
  let exitCode = 0;
  let timedOut = false;
  let durationMs = 0;

  if (repos.length === 0) {
    risks.push('no repos on ticket — nothing to verify (vacuous pass)');
  }
  for (const repo of repos) {
    const card = deps.config.repos[repo]?.card;
    if (!card) {
      exitCode = exitCode || 1;
      risks.push(`${repo}: no repo card — verify cannot run (probe first)`);
      continue;
    }
    const tr = ticketRepos.find((t) => t.repo === repo);
    const worktree =
      tr?.worktree && existsSync(tr.worktree) ? tr.worktree : undefined;
    const repoPath = worktree ?? resolveRepoPath(deps, ws, repo);
    const r: VerifyResult = await runVerifyTask({
      repoPath,
      ...(worktree ? { worktree } : {}),
      runId: `${run.id}:${repo}`,
      runDir: join(runDir, repo),
      card,
      ticket: ticketId,
      timeoutMs: perRepo,
    });
    exitCode = exitCode === 0 ? r.exitCode : exitCode;
    timedOut = timedOut || r.timedOut;
    durationMs += r.commands.reduce((s, c) => s + c.durationMs, 0);
    commands.push(`${repo}: ${r.report.command}`);
    // Tag multi-repo case files so the report stays unambiguous.
    for (const c of r.report.cases) {
      cases.push({
        ...c,
        ...(c.file ? { file: `${repo}/${c.file}` } : {}),
      });
    }
    for (const risk of r.report.risks ?? []) risks.push(`${repo}: ${risk}`);
  }

  const withResults = cases.filter((c) => c.result !== undefined);
  const passPct =
    withResults.length > 0
      ? Math.round(
          (withResults.filter((c) => c.result === 'pass').length /
            withResults.length) *
            1000,
        ) / 10
      : exitCode === 0
        ? 100
        : 0;

  const report: TestReport = TestReportSchema.parse({
    schema: 1,
    ticket: ticketId,
    ts: nowIso(deps),
    command: commands.join(' && ') || '(no commands)',
    cases,
    pass_pct: passPct,
    planned: cases.length,
    implemented: cases.filter((c) => c.implemented).length,
    risks: [
      ...risks,
      ...(timedOut ? ['verify task timed out — killed by runner'] : []),
    ],
  });
  const log = `verify ${ticketId}: exit ${exitCode} pass_pct ${passPct} (${durationMs}ms)\n`;
  return {
    result: { sentinel: 'DONE', sentinel_raw: 'DONE', exit_code: exitCode },
    files: { 'test-report.json': `${JSON.stringify(report, null, 2)}\n` },
    log,
  };
}

// ---------------------------------------------------------------------------
// import — fetch → materialize → import-result.json
// ---------------------------------------------------------------------------

async function importOutcome(
  args: RunnerTaskArgs,
  _runDir: string,
): Promise<TaskOutcome> {
  const { deps, ws, run, task } = args;
  const spec = task.kind === 'import' ? task : { kind: 'import' as const };
  if (!spec.repo && !deps.importFetch) {
    return {
      result: {
        sentinel: 'IMPORT-FAILED',
        sentinel_raw: 'IMPORT-FAILED: repo required',
        exit_code: 1,
      },
      files: {},
      log: 'import task: no repo in the run request\n',
    };
  }
  const tokenEnv = deps.config.importers.github?.token_env;
  const res = await runImport({
    subject: run.subject,
    workspace: ws.name,
    store: deps.store,
    repoMap: deps.config.importers.default_repo_map,
    actor: actorOf(deps),
    fetch: {
      // Placeholder satisfies the option type when importFetch is
      // injected; the real fetch path requires a `owner/repo`.
      repo: spec.repo ?? '(unset)',
      ...(spec.milestone ? { milestone: spec.milestone } : {}),
      ...(spec.labels ? { labels: spec.labels } : {}),
      ...(tokenEnv ? { tokenEnv } : {}),
      env: deps.config.secrets,
    },
    ...(deps.importFetch ? { fetchImpl: deps.importFetch } : {}),
  });
  const files: Record<string, string> = {};
  if (res.materialize) {
    files['import-result.json'] = `${JSON.stringify(
      {
        imported: res.materialize.imported,
        collisions: res.materialize.collisions,
      } satisfies MaterializeResult,
      null,
      2,
    )}\n`;
  }
  const failed = res.outcome.sentinel === 'IMPORT-FAILED';
  return {
    result: {
      sentinel: res.outcome.sentinel,
      sentinel_raw: res.sentinelLine,
      exit_code: failed ? 1 : 0,
    },
    files,
    log: `${res.sentinelLine}\n`,
  };
}

/** Stage → runner-task inference when the request didn't carry one. */
export function taskForStage(stage: string): RunnerTask | null {
  if (stage === 'verify') return { kind: 'verify' };
  if (stage === 'import') return { kind: 'import' };
  return null;
}
