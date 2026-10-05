/**
 * merge/center.ts — the Merge Center orchestrator (DELIVERY §2, wp-133).
 *
 * Runs at the tail of the shepherd poll (the `ci-watch` tail becomes
 * the Merge Center). For every `ci-watch` ticket it:
 *
 *   1. evaluates the deterministic readiness checklist;
 *   2. when green, emits `merge_ready` once and records the readiness
 *      time;
 *   3. merges ready tickets FIFO by readiness time — `depends_on` is
 *      re-evaluated every pass, so a ticket whose dependency merges
 *      this pass becomes ready on the next;
 *   4. executes via `gh pr merge` (never bypassing protection), or
 *      surfaces a gate + stops on a protection block / conflict.
 *
 * Merge execution is registered in the runner-task lane as a
 * `backend: 'runner'` runs row (`stage: 'merge'`) — the same audit
 * convention as the DoD verify task (`runDodVerify`). It is
 * conductor-side compute, so the row is created already-terminal and
 * is never handed to the sentinel transition table.
 */
import type { MergeStrategy, RunRow, TicketRepoRow, TicketRow } from '@sprint-runner/core';
import type { TransitionTools } from '../contracts.js';
import { makeTransitionTools } from '../loop/tools.js';
import { nowIso } from '../loop/deps.js';
import { evaluateReadiness } from './checklist.js';
import { type GitRunner, executeMerge } from './exec.js';
import type { MergeCtx, MergeReadiness, MergeRowOutcome } from './types.js';

export interface MergeCenterReport {
  workspace: string;
  /** Tickets whose checklist was fully green this pass. */
  ready: string[];
  /** Tickets fully merged this pass. */
  merged: string[];
  /** Tickets whose merge was enqueued (`--auto`) this pass. */
  queued: string[];
  /** Tickets that hit a git conflict (gate + rebase queued). */
  conflicts: string[];
  /** Tickets whose merge was blocked by branch protection. */
  blocked: string[];
  actions: string[];
  warnings: string[];
}

export interface MergeCenterOptions {
  strategy?: MergeStrategy;
  gitRun?: GitRunner;
  /** Pre-fetched readiness (tests) — skips re-evaluation. */
  readiness?: Map<string, MergeReadiness>;
}

/** Readiness evaluation for every `ci-watch` ticket (no writes). */
export async function evaluateMergeCenter(
  ctx: MergeCtx,
  opts: { gitRun?: GitRunner } = {},
): Promise<Map<string, MergeReadiness>> {
  const out = new Map<string, MergeReadiness>();
  const tickets = (await ctx.deps.store.listTickets({
    workspace: ctx.ws.name,
  })).filter((t) => t.status === 'ci-watch');
  for (const ticket of tickets) {
    const rows = await ctx.deps.store.listTicketRepos({
      workspace: ctx.ws.name,
      ticket_id: ticket.ticket_id,
    });
    out.set(
      ticket.ticket_id,
      await evaluateReadiness(ctx, ticket, rows, {
        ...(opts.gitRun ? { gitRun: opts.gitRun } : {}),
      }),
    );
  }
  return out;
}

/** True when a `merge_ready` event already exists for the ticket. */
async function mergeReadyAt(
  ctx: MergeCtx,
  ticketId: string,
): Promise<string | null> {
  const events = await ctx.deps.store.listEvents({
    workspace: ctx.ws.name,
    ticket_id: ticketId,
    event: 'merge_ready',
  });
  return events[0]?.ts ?? null;
}

/** Latest merge_attempted head per repo — attempt dedup. */
async function attemptedHeads(
  ctx: MergeCtx,
  ticketId: string,
): Promise<Record<string, string | null>> {
  const events = await ctx.deps.store.listEvents({
    workspace: ctx.ws.name,
    ticket_id: ticketId,
    event: 'merge_attempted',
  });
  const out: Record<string, string | null> = {};
  for (const e of events) {
    const repo = (e.data as { repo?: string }).repo;
    const head = (e.data as { head_sha?: string | null }).head_sha ?? null;
    if (repo) out[repo] = head;
  }
  return out;
}

/**
 * Run the Merge Center for one workspace. Called from the shepherd poll
 * after the per-ticket poll loop; never throws for a single ticket's
 * merge failure (reported as a warning).
 */
export async function runMergeCenter(
  ctx: MergeCtx,
  opts: MergeCenterOptions = {},
): Promise<MergeCenterReport> {
  const { deps, ws } = ctx;
  const store = deps.store;
  const report: MergeCenterReport = {
    workspace: ws.name,
    ready: [],
    merged: [],
    queued: [],
    conflicts: [],
    blocked: [],
    actions: [],
    warnings: [],
  };
  const tools = makeTransitionTools(ctx);

  const readiness =
    opts.readiness ?? (await evaluateMergeCenter(ctx, opts));

  // ---- 1. emit merge_ready once, collect ready tickets ----
  const readyTickets: { ticket: TicketRow; readyAt: string }[] = [];
  for (const [id, r] of readiness) {
    if (!r.ready) continue;
    report.ready.push(id);
    let readyAt = await mergeReadyAt(ctx, id);
    if (!readyAt) {
      readyAt = r.at;
      const ticket = await store.getTicket({ workspace: ws.name, ticket_id: id });
      await tools.appendEvent({
        ticketId: id,
        event: 'merge_ready',
        data: {
          items: r.items.map((i) => i.id),
          repos: ticket?.repos ?? [],
        },
      });
      report.actions.push(`${id}: merge_ready`);
    }
    readyTickets.push({
      ticket: (await store.getTicket({
        workspace: ws.name,
        ticket_id: id,
      })) as TicketRow,
      readyAt,
    });
  }

  // ---- 2. FIFO by readiness time ----
  readyTickets.sort((a, b) => a.readyAt.localeCompare(b.readyAt));

  for (const { ticket } of readyTickets) {
    const id = ticket.ticket_id;
    try {
      const rows = await store.listTicketRepos({
        workspace: ws.name,
        ticket_id: id,
      });
      const openRows = rows.filter(
        (r) => r.pr_url && r.pr_state !== 'merged' && r.pr_state !== 'closed',
      );
      if (openRows.length === 0) continue;

      // Dedup: don't re-attempt the same head that was already merged
      // or enqueued. A rebase (the conflict path) rewrites the head, so
      // the post-rebase push naturally re-arms the attempt.
      const attempted = await attemptedHeads(ctx, id);
      const r = readiness.get(id);
      const alreadyAttempted = openRows.every(
        (row) => attempted[row.repo] === (r?.heads[row.repo] ?? null),
      );
      if (alreadyAttempted) {
        report.actions.push(`${id}: merge already attempted at this head`);
        continue;
      }

      const outcomes = await executeMerge({
        ctx,
        ticket,
        rows,
        tools,
        strategy:
          opts.strategy ?? (deps.config.merge_strategy as MergeStrategy),
        ...(opts.gitRun ? { gitRun: opts.gitRun } : {}),
      });
      await recordMergeRun(ctx, ticket, outcomes);
      for (const o of outcomes) {
        if (o.kind === 'merged') {
          report.merged.push(id);
          report.actions.push(`${id}/${o.repo}: merged ${o.sha ?? ''}`.trim());
        } else if (o.kind === 'queued') {
          report.queued.push(id);
          report.actions.push(`${id}/${o.repo}: merge enqueued (--auto)`);
        } else if (o.kind === 'conflict') {
          report.conflicts.push(id);
          report.actions.push(`${id}/${o.repo}: conflict → rebase queued`);
        } else if (o.kind === 'blocked') {
          report.blocked.push(id);
          report.actions.push(`${id}/${o.repo}: blocked — ${o.detail}`);
        }
      }
    } catch (e) {
      report.warnings.push(`${id}: merge-center: ${(e as Error).message}`);
    }
  }

  return report;
}

/** Register the merge attempt in the runner-task lane (`backend:
 *  'runner'`, `stage: 'merge'`) as an already-terminal audit row. */
async function recordMergeRun(
  ctx: MergeCtx,
  ticket: TicketRow,
  outcomes: MergeRowOutcome[],
): Promise<void> {
  const { deps, ws } = ctx;
  const id = ticket.ticket_id;
  const prior = (
    await deps.store.listRuns({ workspace: ws.name, subject: id })
  ).filter((run) => run.stage === 'merge');
  const attempt = prior.length + 1;
  const ts = nowIso(deps);
  const sentinel = outcomes.some((o) => o.kind === 'blocked')
    ? 'BLOCKED'
    : outcomes.some((o) => o.kind === 'conflict')
      ? 'CONFLICT'
      : 'MERGED';
  const run: RunRow = {
    id: `${ws.name}/${id}/${String(attempt).padStart(3, '0')}-merge`,
    workspace: ws.name,
    subject: id,
    ticket_id: id,
    stage: 'merge',
    attempt,
    backend: 'runner',
    model: null,
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: { task: { kind: 'merge' } },
    status: 'done',
    started_at: ts,
    heartbeat_at: ts,
    exited_at: nowIso(deps),
    sentinel,
    sentinel_raw: sentinel,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: null,
  };
  await deps.store.createRun(run);
}

/** Convenience re-export for callers building tools. */
export type { TransitionTools, TicketRepoRow };
