/**
 * Spend/token caps (CONDUCTOR "Run lifecycle" + SETTINGS `budgets:`).
 *
 * Dual caps: `spend_cap_usd_per_ticket` and `tokens_cap_per_ticket`
 * (in+out — bounds backends whose billing isn't $-visible). Evaluated
 * on every streamed `usage_partial` AND at run end. On hit:
 * `run_killed` + a `blocked` reason — mid-run the conductor kills the
 * pid; at run end the run is already dead so the blocked event + ticket
 * `blocked` status carry it.
 *
 * Spec note: CONDUCTOR says "cumulative counters live on the ticket
 * row" but DB-SCHEMA's `tickets` table has no cost/token columns —
 * counters are computed by summing the ticket's `runs` rows, which is
 * the same truth (runs is coordination data, not rebuildable). See
 * wp-030 ticket notes.
 */
import type { Store, TicketRow } from '@sprint-runner/core';
import type { ConductorDeps } from './deps.js';

export type CapKind = 'spend_cap_usd_per_ticket' | 'tokens_cap_per_ticket';

/** Cumulative usage across ALL of a ticket's runs (retries included —
 *  the cap is per-ticket, not per-run). */
export async function cumulativeUsage(
  store: Store,
  workspace: string,
  ticketId: string,
): Promise<{ costUsd: number; tokens: number }> {
  const runs = await store.listRuns({ workspace, ticket_id: ticketId });
  let costUsd = 0;
  let tokens = 0;
  for (const r of runs) {
    costUsd += r.cost_usd ?? 0;
    tokens += (r.tokens_in ?? 0) + (r.tokens_out ?? 0);
  }
  return { costUsd, tokens };
}

/** Which cap (if any) the ticket's cumulative usage has reached. */
export async function capExceeded(
  deps: ConductorDeps,
  workspace: string,
  ticketId: string,
): Promise<CapKind | null> {
  const { spend_cap_usd_per_ticket: spendCap, tokens_cap_per_ticket: tokCap } =
    deps.config.budgets;
  if (spendCap == null && tokCap == null) return null;
  const { costUsd, tokens } = await cumulativeUsage(
    deps.store,
    workspace,
    ticketId,
  );
  if (spendCap != null && costUsd >= spendCap)
    return 'spend_cap_usd_per_ticket';
  if (tokCap != null && tokens >= tokCap) return 'tokens_cap_per_ticket';
  return null;
}

/** CLAIM-side pre-flight: true when claiming this ticket would blow a
 *  configured cap (CONDUCTOR CLAIM: "neither spend nor token cap
 *  exceeded"). */
export async function capsBlockClaim(
  deps: ConductorDeps,
  ticket: TicketRow,
): Promise<CapKind | null> {
  return capExceeded(deps, ticket.workspace, ticket.ticket_id);
}
