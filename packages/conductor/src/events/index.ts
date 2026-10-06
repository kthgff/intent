/**
 * events/ — SCHEMAS §7 event emission (wp-031; rewired wp-092).
 *
 * `emitEvent` is the single funnel: every transition-table row and
 * gate-clear path writes events through it so the ledger stays uniform
 * (actor defaults to `runner`). D29: the `events` table IS the ledger —
 * append-only Postgres rows; there is no events.jsonl and no LOG.md
 * file to regenerate. `renderLogMd`/`renderEventLine` remain as pure
 * renderers for the API/UI (LOG.md is a derived render, DB-SCHEMA).
 */
import type { ActorType, EventName, EventRow } from '@veto/core';

/** Narrow emit surface — works with either a TransitionContext (claim
 *  path) or the richer TransitionTools (reconcile path). */
export interface EventSink {
  /** Store — append-only `events` rows (the ledger, DB-SCHEMA). */
  appendEvent(e: {
    ticketId?: string | null;
    stage?: string | null;
    actorType?: ActorType;
    event: EventName;
    run?: string | null;
    refs?: string[];
    data?: Record<string, unknown>;
    costUsd?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    tokensCached?: number | null;
    usageSource?: EventRow['usage_source'];
    durationS?: number | null;
    humanMinutes?: number | null;
  }): Promise<number>;
}

export interface EmitArgs {
  ticketId?: string | null | undefined;
  stage?: string | null;
  event: EventName;
  run?: string | null;
  refs?: string[];
  data?: Record<string, unknown>;
  actorType?: ActorType;
  humanMinutes?: number;
}

export async function emitEvent(
  sink: EventSink,
  args: EmitArgs,
): Promise<number> {
  return sink.appendEvent({
    ...args,
    ticketId: args.ticketId ?? null,
  });
}

/**
 * Render `events` rows for one ticket as a markdown table — the
 * human-readable LOG view, derived at read time (DB-SCHEMA: "LOG.md is
 * a derived render (API/UI), never stored").
 */
export function renderLogMd(ticketId: string, events: EventRow[]): string {
  const lines = [
    `# LOG — ${ticketId}`,
    '',
    '| ts | event | stage | run | actor | data |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of events) {
    const data = JSON.stringify(e.data ?? {}).replaceAll('|', '\\|');
    lines.push(
      `| ${e.ts} | ${e.event} | ${e.stage ?? ''} | ${e.run ?? ''} | ${e.actor_type}:${e.actor_id} | ${data} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Serialize one `events` row as a SCHEMAS §7-style jsonl line —
 *  kept for export/debug surfaces, never written to disk by the
 *  conductor. */
export function renderEventLine(e: EventRow): string {
  return JSON.stringify({
    v: 1,
    seq: (e as { seq?: number }).seq ?? undefined,
    ts: e.ts,
    ticket: e.ticket_id,
    stage: e.stage,
    actor: { type: e.actor_type, id: e.actor_id },
    event: e.event,
    run: e.run,
    refs: e.refs ?? [],
    data: e.data ?? {},
    cost_usd: e.cost_usd,
    tokens_in: e.tokens_in,
    tokens_out: e.tokens_out,
    tokens_cached: e.tokens_cached,
    usage_source: e.usage_source,
    duration_s: e.duration_s,
    human_minutes: e.human_minutes,
  });
}
