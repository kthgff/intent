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
import type {
  MergeStrategy,
  RunRow,
  TicketRepoRow,
  TicketRow,
} from '@sprint-runner/core';
import type { TransitionTools } from '../contracts.js';
import { nowIso } from '../loop/deps.js';
import { makeTransitionTools } from '../loop/tools.js';
import type { PrCheck, PrInfo } from '../shepherd/gh.js';
import { loadShepherdFile } from '../shepherd/state.js';
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
  /** Rows the shepherd poll actually fetched this pass (ticket_id →
   *  repo-keyed `gh` results). When present the evaluator reuses them
   *  — no second `gh pr view`/`gh pr checks` per row — and skips
   *  tickets the poll never touched (an escalated PR is human-owned
   *  until its gate clears). */
  polled?: Map<
    string,
    { prInfos: Map<string, PrInfo>; checks: Map<string, PrCheck[]> }
  >;
}

/** Readiness evaluation for `ci-watch` tickets (no writes). When
 *  `opts.polled` is given only tickets the shepherd poll fetched are
 *  evaluated, reusing its `gh` results. */
export async function evaluateMergeCenter(
  ctx: MergeCtx,
  opts: Pick<MergeCenterOptions, 'gitRun' | 'polled'> = {},
): Promise<Map<string, MergeReadiness>> {
  const out = new Map<string, MergeReadiness>();
  let tickets = (
    await ctx.deps.store.listTickets({
      workspace: ctx.ws.name,
    })
  ).filter((t) => t.status === 'ci-watch');
  if (opts.polled) {
    tickets = tickets.filter((t) => opts.polled?.has(t.ticket_id));
  }
  for (const ticket of tickets) {
    const rows = await ctx.deps.store.listTicketRepos({
      workspace: ctx.ws.name,
      ticket_id: ticket.ticket_id,
    });
    const pd = opts.polled?.get(ticket.ticket_id);
    out.set(
      ticket.ticket_id,
      await evaluateReadiness(ctx, ticket, rows, {
        ...(opts.gitRun ? { gitRun: opts.gitRun } : {}),
        ...(pd ? { prInfos: pd.prInfos, checksByRepo: pd.checks } : {}),
      }),
    );
  }
  return out;
}

/** Earliest `merge_ready` event time for the ticket (FIFO order), or null. */
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

/** True when a gate item is already surfaced and open. */
async function gateOpen(
  ctx: MergeCtx,
  subject: string,
  gate: string,
): Promise<boolean> {
  const item = await ctx.deps.store.getGateItem({
    workspace: ctx.ws.name,
    subject,
    gate,
  });
  return item != null && item.cleared_at == null;
}

/**
 * Surface the gate items / follow-up runs a non-ready ticket needs:
 * a `branch-protection` blocker → a `merge` gate (stop, never bypass);
 * a `conflict` blocker → a `merge_conflict` gate + a `rebase` run.
 * Idempotent: an already-open gate is not re-surfaced.
 */
async function surfaceBlockers(
  ctx: MergeCtx,
  tools: TransitionTools,
  ticket: TicketRow,
  readiness: MergeReadiness,
  report: MergeCenterReport,
): Promise<void> {
  const id = ticket.ticket_id;
  for (const item of readiness.blockers) {
    if (item.id === 'branch-protection') {
      if (await gateOpen(ctx, id, 'merge')) continue;
      await tools.surfaceGateItem({
        subject: id,
        gate: 'merge',
        kind: 'escalation',
        blockedAgent: true,
        payload: {
          reason: 'branch protection blocks the merge',
          detail: item.detail,
        },
      });
      report.blocked.push(id);
      report.actions.push(`${id}: branch protection → merge gate`);
    } else if (item.id === 'conflict') {
      if (await gateOpen(ctx, id, 'merge_conflict')) continue;
      await tools.appendEvent({
        ticketId: id,
        event: 'merge_conflict',
        data: { detail: item.detail ?? null, via: 'merge-center-checklist' },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'merge_conflict',
        kind: 'escalation',
        blockedAgent: true,
        payload: { detail: item.detail ?? null },
      });
      // The rebase run owns the branch rewrite — never a silent force-push.
      await tools.requestRun({
        workspace: ctx.ws.name,
        subject: id,
        stage: 'rebase',
        ticketId: id,
      });
      report.conflicts.push(id);
      report.actions.push(`${id}: conflict → merge_conflict gate + rebase run`);
    }
  }
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

  const readiness = opts.readiness ?? (await evaluateMergeCenter(ctx, opts));

  // ---- 0. surface gate items for blocking checklist rows ----
  for (const [id, r] of readiness) {
    if (r.ready) continue;
    const ticket = await store.getTicket({
      workspace: ws.name,
      ticket_id: id,
    });
    if (!ticket) continue;
    try {
      await surfaceBlockers(ctx, tools, ticket, r, report);
    } catch (e) {
      report.warnings.push(`${id}: ${(e as Error).message}`);
    }
  }

  // ---- 1. emit merge_ready once, collect ready tickets ----
  const readyTickets: { ticket: TicketRow; readyAt: string }[] = [];
  for (const [id, r] of readiness) {
    if (!r.ready) continue;
    report.ready.push(id);
    let readyAt = await mergeReadyAt(ctx, id);
    if (!readyAt) {
      readyAt = r.at;
      const ticket = await store.getTicket({
        workspace: ws.name,
        ticket_id: id,
      });
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
