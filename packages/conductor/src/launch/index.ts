/**
 * LAUNCH — CONDUCTOR.md loop step 3.
 *
 * For repo-executing stages (REPO_EXECUTING_STAGES — implement, fix,
 * ci-fix, comment-fix, rebase, revert, verify): create worktree(s)
 * `<repo>.worktrees/<id>` + `ticket/<id>` branches — one ticket_repos
 * row per repo in `repos:`.
 *
 * Cardless stages (triage/design/testplan/doc stages, probe, import,
 * interview, survey) run with the tickets repo checkout as cwd — they
 * may write into `tickets/<id>/` (their outputs are committed by the
 * conductor-side status commit, never by the agent pushing).
 *
 * Then: prepare → adapter.run detached → register the run row +
 * conductor-observed heartbeat + live usage stream → cap check.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PROMPT_TOKENS,
  REPO_EXECUTING_STAGES,
  type RunRow,
  type Stage,
  type TicketRow,
  type TokenValues,
} from '@sprint-runner/core';
import { createWorktree } from '@sprint-runner/gitops';
import type { RunRequest } from '../contracts.js';
import { capExceeded } from '../loop/caps.js';
import {
  type ConductorDeps,
  type ConductorWorkspace,
  actorOf,
  adapterFor,
  nowIso,
  resolveRepoPath,
  saveHandle,
  stageTimeout,
} from '../loop/deps.js';
import type { LeaseManager } from '../loop/lease.js';
import { blockTicketForCap } from './caps-action.js';

export interface LaunchContext {
  deps: ConductorDeps;
  ws: ConductorWorkspace;
  leases: LeaseManager;
  /** In-memory run-handle registry (persisted to handle.json too). */
  handles: Map<string, import('@sprint-runner/core').RunHandle>;
  /** Run ids already killed for a cap hit (stream may refire). */
  killedForCap: Set<string>;
  /** Called when a mid-run usage stream trips a cap. */
  onCapHit?: (run: RunRow, cap: string) => void;
}

/** `<workspace>/<subject>/<attempt:03d>-<stage>` (DB-SCHEMA runs.id
 *  example: `team-a/ABC-123/003-implement`). */
export function formatRunId(
  workspace: string,
  subject: string,
  attempt: number,
  stage: string,
): string {
  return `${workspace}/${subject}/${String(attempt).padStart(3, '0')}-${stage}`;
}

/** Next attempt number for (subject, stage) — max existing + 1. */
export async function nextAttempt(
  ctx: LaunchContext,
  subject: string,
  stage: string,
): Promise<number> {
  const runs = await ctx.deps.store.listRuns({
    workspace: ctx.ws.name,
    subject,
  });
  let max = 0;
  for (const r of runs) {
    if (r.stage === stage && r.attempt > max) max = r.attempt;
  }
  return max + 1;
}

/** True when a live run already fences (subject, stage). */
export async function hasLiveRun(
  deps: ConductorDeps,
  workspace: string,
  subject: string,
  stage: string,
): Promise<boolean> {
  const live = await deps.store.listLiveRuns();
  return live.some(
    (r) =>
      r.workspace === workspace && r.subject === subject && r.stage === stage,
  );
}

/**
 * Queue a `pending` run row (TransitionTools.requestRun + the
 * conductor's own probe queueing). Deduplicated on live runs for
 * (subject, stage). Returns the run id or null when already queued.
 */
export async function queuePendingRun(
  ctx: LaunchContext,
  req: RunRequest,
): Promise<string | null> {
  if (await hasLiveRun(ctx.deps, ctx.ws.name, req.subject, req.stage)) {
    return null;
  }
  const attempt = await nextAttempt(ctx, req.subject, req.stage);
  const id = formatRunId(ctx.ws.name, req.subject, attempt, req.stage);
  const ts = nowIso(ctx.deps);
  await ctx.deps.store.createRun({
    id,
    workspace: ctx.ws.name,
    subject: req.subject,
    ticket_id: req.ticketId ?? null,
    stage: req.stage,
    attempt,
    backend: null,
    model: req.model ?? null,
    depth: null,
    pid: null,
    worktree: null,
    status: 'pending',
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
  return id;
}

/**
 * Build the token table for a stage prompt (ADAPTERS token table).
 * wp-030 ships sane conductor-owned defaults — file contents the
 * runner can supply mechanically (ticket.md, repo cards, paths) and
 * explicit `pending`/empty markers for tokens whose producers are
 * later work packages (dossiers, prior art, spec docs, CI state).
 * {{ARTIFACT_TARGETS}}/{{CAPABILITY_NOTES}} are computed by the
 * renderer from capability flags.
 */
async function buildTokens(
  ctx: LaunchContext,
  req: RunRequest,
  ticket: TicketRow | null,
  runId: string,
): Promise<TokenValues> {
  // Every token starts as '' so fail-closed rendering never dies on a
  // token this wp can't produce yet — the prompt still names it.
  const tokens: Record<string, string> = {};
  for (const t of PROMPT_TOKENS) tokens[t] = '';
  const ws = ctx.ws;

  let ticketDir = '';
  if (ticket) {
    ticketDir = join(ws.ticketsRepoPath, 'tickets', ticket.ticket_id);
    tokens.TICKET_ID = ticket.ticket_id;
    tokens.TICKET_DIR = ticketDir;
    try {
      tokens.TICKET_MD = await readFile(join(ticketDir, 'ticket.md'), 'utf8');
    } catch {
      tokens.TICKET_MD = '';
    }
    tokens.REPO_NAMES = ticket.repos.join(', ');
    tokens.REPO_NAME = ticket.repos[0] ?? '';
    tokens.DEPTH = ticket.depth ?? ctx.deps.config.spec_depth;
    tokens.BRANCH = `ticket/${ticket.ticket_id}`;
    const cards = Object.fromEntries(
      ticket.repos.map((r) => [r, ctx.deps.config.repos[r]?.card ?? null]),
    );
    tokens.REPO_CARDS = JSON.stringify(cards);
  } else {
    tokens.TICKET_ID = req.subject;
  }
  tokens.TICKETS_DIR = ws.ticketsRepoPath;
  tokens.DOSSIER = 'dossier pending';
  tokens.PRIOR_ART = 'none';
  tokens.SPEC_LINT = 'not computed (wp-032)';
  tokens.CONTEXT_MD = '';
  tokens.SPLIT_MAX_CHILDREN = String(
    ctx.deps.config.budgets.split_max_children,
  );
  tokens.SURVEY_BUDGET = String(
    ctx.deps.config.survey.budget_usd ?? 'uncapped',
  );
  tokens.DISMISSAL_CAP = String(ctx.deps.config.budgets.fix_dismissal_cap);
  if (req.subject.startsWith('probe:')) {
    const repo = req.subject.slice('probe:'.length);
    tokens.REPO_NAME = repo;
    tokens.REPO_NAMES = repo;
    const path = resolveRepoPath(ctx.deps, ws, repo);
    tokens.REPO_PATH = path;
    tokens.CARD_PATH = join(path, '.sprint-runner', 'card.json');
  }
  return { ...tokens, ...(req.tokens ?? {}) } as TokenValues;
}

/**
 * LAUNCH one run: lease → worktree(s) → prepare → spawn detached →
 * register. `pendingRow` set → reuses that row (requestRun path).
 * Returns the run id, or null when the lease was contested.
 */
export async function launch(
  ctx: LaunchContext,
  req: RunRequest & { pendingRow?: RunRow },
): Promise<string | null> {
  const { deps, ws } = ctx;
  const store = deps.store;
  const ticket = req.ticketId
    ? await store.getTicket({ workspace: ws.name, ticket_id: req.ticketId })
    : null;

  const attempt =
    req.pendingRow?.attempt ?? (await nextAttempt(ctx, req.subject, req.stage));
  const runId =
    req.pendingRow?.id ?? formatRunId(ws.name, req.subject, attempt, req.stage);

  // --- lease (CONDUCTOR CLAIM: contested → skip this tick) ---
  const leaseKey = {
    workspace: ws.name,
    subject: req.subject,
    stage: req.stage,
    attempt,
  };
  if (!(await ctx.leases.acquire(ws, leaseKey))) return null;

  const backend = (ticket?.backend ?? deps.config.backend) as string;
  const adapter = adapterFor(deps, backend);
  const model = req.model ?? ticket?.model ?? deps.config.main_model ?? null;
  const depth = (ticket?.depth ?? deps.config.spec_depth) as RunRow['depth'];
  const ts = nowIso(deps);
  const runDir = join(deps.runsDir, ...runId.split('/'));
  await mkdir(runDir, { recursive: true });

  // --- worktrees (CONDUCTOR LAUNCH step 3) ---
  let worktree = ws.ticketsRepoPath;
  if (
    ticket &&
    (REPO_EXECUTING_STAGES as readonly string[]).includes(req.stage)
  ) {
    const slug = runId.replaceAll('/', '-');
    for (const repo of ticket.repos) {
      const repoPath = resolveRepoPath(deps, ws, repo);
      const branch = `ticket/${ticket.ticket_id}`;
      // The worktree+branch are per-TICKET (ticket_repos row), not per
      // run — a verify/fix/rebase run after `implement` must reuse the
      // existing checkout: `git worktree add` refuses a branch that is
      // already checked out elsewhere.
      const existing = await store.getTicketRepo({
        workspace: ws.name,
        ticket_id: ticket.ticket_id,
        repo,
      });
      const dir =
        existing?.worktree && existsSync(existing.worktree)
          ? existing.worktree
          : await createWorktree(repoPath, slug, branch);
      await store.upsertTicketRepo({
        workspace: ws.name,
        ticket_id: ticket.ticket_id,
        repo,
        branch,
        worktree: dir,
        pr_url: existing?.pr_url ?? null,
        pr_state: existing?.pr_state ?? null,
        ci_state: existing?.ci_state ?? null,
        merged_sha: existing?.merged_sha ?? null,
      });
      worktree = dir; // last wins for multi-repo; cwd only anchors the spawn
    }
  }

  // --- render + spawn ---
  const ticketDir = ticket
    ? join(ws.ticketsRepoPath, 'tickets', ticket.ticket_id)
    : undefined;
  // `verify` is a runner task with no agent and no prompt template
  // (CONDUCTOR "Runner tasks"; renderPrompt throws for it) — synthesize
  // a minimal rendered prompt carrying just the ARTIFACT_TARGETS line
  // so adapters can still place their artifact dir.
  const rendered =
    req.stage === 'verify'
      ? {
          template: 'verify',
          text: `${runDir}/ (absolute — write all run artifacts under this directory)\n`,
          tokens: {} as TokenValues,
        }
      : await adapter.prepare(req.subject, req.stage, {
          workspace: ws.name,
          run_dir: runDir,
          run_id: runId,
          backend: adapter.name,
          ...(model ? { model } : {}),
          ...(depth ? { depth } : {}),
          ...(ticketDir ? { ticket_dir: ticketDir } : {}),
          tokens: await buildTokens(ctx, req, ticket, runId),
        });
  const handle = await adapter.run(
    worktree,
    rendered,
    stageTimeout(deps, req.stage),
  );
  await saveHandle(runDir, handle);
  ctx.handles.set(runId, handle);

  // --- register run row ---
  const row: RunRow = {
    id: runId,
    workspace: ws.name,
    subject: req.subject,
    ticket_id: ticket?.ticket_id ?? req.ticketId ?? null,
    stage: req.stage,
    attempt,
    backend: adapter.name,
    model,
    depth,
    pid: handle.pid,
    worktree,
    status: 'running',
    started_at: ts,
    heartbeat_at: ts,
    exited_at: null,
    sentinel: null,
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: runDir,
  };
  if (req.pendingRow) await store.updateRun(runId, row);
  else await store.createRun(row);

  // API.md stream: run_status after the durable row write.
  deps.notify?.({ type: 'run_status', payload: { ...row } });

  await store.appendEvent({
    workspace: ws.name,
    ticket_id: row.ticket_id,
    ts,
    stage: req.stage,
    actor_type: 'runner',
    actor_id: actorOf(deps),
    event: 'run_started',
    run: runId,
    refs: [],
    data: { attempt, pid: handle.pid, worktree },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });

  // --- live usage stream → runs.tokens_* + cap check (ADAPTERS
  //     on_usage; CONDUCTOR "evaluated on every streamed usage_partial") ---
  adapter.on_usage(handle, (partial) => {
    void store
      .updateRunUsage(runId, partial)
      .then(async () => {
        // API.md stream: usage_partial mirrors the durable counters.
        deps.notify?.({
          type: 'usage_partial',
          payload: { run_id: runId, ...partial },
        });
        if (!row.ticket_id) return;
        const cap = await capExceeded(deps, ws.name, row.ticket_id as string);
        if (cap) await blockTicketForCap(ctx, row, cap);
      })
      .catch((e) => deps.onError?.(e));
  });

  return runId;
}
