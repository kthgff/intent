/**
 * CLAIM — CONDUCTOR.md loop step 2.
 *
 * Next runnable unit = a ticket whose status allows a NON-GATE
 * transition (TransitionHandler.nextStage — the wp-031 seam) AND:
 *   - lease free
 *   - all `depends_on` tickets `merged`
 *   - neither spend nor token cap exceeded
 *   - for REPO_EXECUTING_STAGES only: every repo's card `verified` —
 *     else the conductor queues a `probe:<repo>` run itself and skips
 *     (the scoped repo-card rule; triage never deadlocks on a card)
 * Order: ticket priority → oldest-first. Contended lease → skip this
 * tick. Pending rows queued by requestRun/probe are leased + launched
 * here too.
 */
import {
  REPO_EXECUTING_STAGES,
  type Stage,
  TERMINAL_STATUSES,
  type TicketPriority,
  type TicketRow,
} from '@veto/core';
import { z } from 'zod';
import { applyTicketStatus } from '../contracts.js';
import type { RunnerTask } from '../contracts.js';
import { coordinateClaim } from '../decompose/coordinator.js';
import { hasLiveRun, launch, queuePendingRun } from '../launch/index.js';
import { capsBlockClaim } from '../loop/caps.js';
import type { ConductorDeps } from '../loop/deps.js';
import { actorOf } from '../loop/deps.js';
import type { LeaseManager } from '../loop/lease.js';
import { transitionContext } from '../loop/tools.js';
import type { ToolCtx } from '../loop/tools.js';

export interface ClaimReport {
  launched: string[];
  skipped: { ticket: string; reason: string }[];
}

const PRIORITY_RANK: Record<TicketPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const rank = (p: string) => PRIORITY_RANK[p as TicketPriority] ?? 1;

/** Serialized `pending`-row request (runs.request) — fail-closed:
 *  malformed rows launch with conductor-default tokens. */
const PendingRequestSchema = z.object({
  tokens: z.record(z.string(), z.string()).optional(),
  model: z.string().optional(),
  /** Runner-task spec persisted by queuePendingRun (verify/import). */
  task: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('verify') }),
      z.object({
        kind: z.literal('import'),
        repo: z.string().optional(),
        milestone: z.string().optional(),
        labels: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
});

export async function claim(ctx: ToolCtx): Promise<ClaimReport> {
  const { deps, ws } = ctx;
  const report: ClaimReport = { launched: [], skipped: [] };
  const tctx = transitionContext(ctx);
  /** wp-154 Integration Coordinator context (deps.notify → the SSE
   *  fan-out; optional everywhere downstream). */
  const coordCtx = { ...tctx, notify: deps.notify };

  // Live-run snapshot the coordinator fences against — refreshed as
  // this pass launches so exclusive/predicted-conflict checks see
  // runs claimed earlier in the SAME tick.
  const live = await deps.store.listLiveRuns();
  const noteLaunched = async (id: string) => {
    const row = await deps.store.getRun(id);
    if (row) live.push(row);
  };

  // --- queued pending runs first (probe/split/fix requests) ---
  const pending = (
    await deps.store.listRuns({
      workspace: ws.name,
      status: 'pending',
    })
  ).sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
  for (const row of pending) {
    // wp-154: a ticket-bound pending run in a repo-executing stage is
    // still an AI execution — the coordinator's exclusive/contract/
    // shared-file fences apply (a queued retry must not jump the fence).
    if (
      row.ticket_id &&
      (REPO_EXECUTING_STAGES as readonly string[]).includes(row.stage)
    ) {
      const ticket = await deps.store.getTicket({
        workspace: ws.name,
        ticket_id: row.ticket_id,
      });
      if (ticket) {
        const reason = await coordinateClaim({
          ctx: coordCtx,
          ticket,
          stage: row.stage,
          live,
        });
        if (reason) {
          report.skipped.push({ ticket: ticket.ticket_id, reason });
          continue;
        }
      }
    }
    const saved = PendingRequestSchema.safeParse(row.request);
    const req = saved.success ? saved.data : null;
    const id = await launch(ctx, {
      workspace: ws.name,
      subject: row.subject,
      stage: row.stage as Stage,
      ...(row.ticket_id ? { ticketId: row.ticket_id } : {}),
      ...(req?.model ? { model: req.model } : {}),
      ...(req?.tokens ? { tokens: req.tokens } : {}),
      ...(req?.task ? { task: req.task as RunnerTask } : {}),
      pendingRow: row,
    });
    if (id) {
      report.launched.push(id);
      await noteLaunched(id);
    }
  }

  // --- ticket-driven claims ---
  const tickets = (await deps.store.listTickets({ workspace: ws.name }))
    .filter((t) => !(TERMINAL_STATUSES as readonly string[]).includes(t.status))
    .sort(
      (a, b) =>
        rank(a.priority) - rank(b.priority) ||
        a.updated_at.localeCompare(b.updated_at),
    );

  // Implement concurrency budget (CONDUCTOR "Scheduling policy").
  let implementActive = live.filter(
    (r) => r.stage === 'implement' && ['running', 'paused'].includes(r.status),
  ).length;

  for (const ticket of tickets) {
    const next = await deps.transitions.nextStage(ticket, tctx);
    if (!next) continue;
    const subject = next.subject ?? ticket.ticket_id;
    const skip = (reason: string) =>
      report.skipped.push({ ticket: ticket.ticket_id, reason });

    // Already in flight for this stage?
    if (await hasLiveRun(deps, ws.name, subject, next.stage)) {
      skip('already-live');
      continue;
    }

    // DAG: depends_on children park until parents merged.
    if (!(await depsMerged(deps, ticket))) {
      skip('depends_on-unmerged');
      continue;
    }

    // Caps: neither spend nor token cap exceeded.
    const cap = await capsBlockClaim(deps, ticket);
    if (cap) {
      skip(cap);
      await blockPreClaim(ctx, ticket, cap);
      continue;
    }

    // Implement concurrency.
    if (
      next.stage === 'implement' &&
      implementActive >= deps.config.concurrency.implement
    ) {
      skip('concurrency.implement');
      continue;
    }

    // Repo-card rule (scoped): only repo-executing stages need a
    // verified card; missing/unverified → conductor queues probe runs.
    if ((REPO_EXECUTING_STAGES as readonly string[]).includes(next.stage)) {
      const unprobed = ticket.repos.filter(
        (r) => deps.config.repos[r]?.card?.verified !== true,
      );
      if (unprobed.length > 0) {
        for (const repo of unprobed) {
          await queuePendingRun(ctx, {
            workspace: ws.name,
            subject: `probe:${repo}`,
            stage: 'probe',
          });
        }
        skip(`repo-card-unverified:${unprobed.join(',')}`);
        continue;
      }
    }

    // wp-154 Integration Coordinator (repo-executing stages only):
    // exclusive fencing, shared-file conflict prediction, and the
    // contract-first pin — every rejection is a named skip reason on
    // the report (dependency-aware sequencing is observable in claim
    // order, never silent).
    const coordReason = await coordinateClaim({
      ctx: coordCtx,
      ticket,
      stage: next.stage,
      live,
    });
    if (coordReason) {
      skip(coordReason);
      continue;
    }

    const id = await launch(ctx, {
      workspace: ws.name,
      subject,
      stage: next.stage,
      ticketId: ticket.ticket_id,
      ...(next.model ? { model: next.model } : {}),
    });
    if (id) {
      report.launched.push(id);
      if (next.stage === 'implement') implementActive += 1;
      await noteLaunched(id);
    } else {
      skip('lease-contested');
    }
  }

  return report;
}

/** All depends_on tickets delivered? (CONDUCTOR CLAIM + scheduling
 *  DAG; D27 — `merged` and its post-merge lifecycle statuses count). */
async function depsMerged(
  deps: ConductorDeps,
  ticket: TicketRow,
): Promise<boolean> {
  const DELIVERED = ['merged', 'verifying', 'released'];
  for (const dep of ticket.depends_on) {
    const row = await deps.store.getTicket({
      workspace: ticket.workspace,
      ticket_id: dep,
    });
    if (!row || !DELIVERED.includes(row.status)) return false;
  }
  return true;
}

/** Cap already exceeded at claim time → the ticket is parked as
 *  `blocked` with the cap as its reason (the dual-cap kill-switch
 *  applied to not-yet-running work). */
async function blockPreClaim(
  ctx: ToolCtx,
  ticket: TicketRow,
  cap: string,
): Promise<void> {
  const { deps, ws } = ctx;
  if (ticket.status === 'blocked' && ticket.blocked_reason === cap) return;
  await applyTicketStatus({
    ctx: {
      workspace: ws.name,
      rootPath: ws.rootPath,
      store: deps.store,
      actor: actorOf(deps),
      now: () => deps.now?.() ?? new Date(),
    },
    opts: {
      ticketId: ticket.ticket_id,
      status: 'blocked',
      blockedReason: cap,
      data: { reason: cap },
    },
  });
  await deps.store.appendEvent({
    workspace: ws.name,
    ticket_id: ticket.ticket_id,
    ts: (deps.now?.() ?? new Date()).toISOString(),
    stage: null,
    actor_type: 'runner',
    actor_id: actorOf(deps),
    event: 'blocked',
    run: null,
    refs: [],
    data: { reason: cap, phase: 'claim' },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
}
