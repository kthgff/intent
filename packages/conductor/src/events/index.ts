/**
 * events/ — SCHEMAS §7 events.jsonl emission + LOG.md regeneration
 * (wp-031).
 *
 * `emitEvent` is the single funnel: every transition-table row and
 * gate-clear path writes events through it so the ledger stays uniform
 * (v:1 implied by the store projection; actor defaults to `runner`).
 * `regenerateLog` renders a ticket's event stream as a markdown table
 * into `tickets/<id>/LOG.md` — CONDUCTOR "cheap mechanical checks run
 * INLINE in the tick … LOG.md regeneration".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActorType, EventName, EventRow } from '@sprint-runner/core';
import { commitAll } from '@sprint-runner/gitops';
import type { TransitionContext } from '../contracts.js';

/** Narrow emit surface — works with either a TransitionContext (claim
 *  path) or the richer TransitionTools (reconcile path). */
export interface EventSink {
  /** When present (TransitionContext/TransitionTools), emitted ticket
   *  events also land in `tickets/<id>/events.jsonl` (SCHEMAS §7 — the
   *  git-side ledger the events_idx table projects). */
  ticketsRepoPath?: string;
  /** Store — needed for the events.jsonl/LOG.md rewrite on emit. */
  store?: {
    listEvents(f: { workspace: string; ticket_id: string }): Promise<
      EventRow[]
    >;
  };
  /** Workspace key — needed alongside ticketsRepoPath for regen. */
  workspace?: string;
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
  const seq = await sink.appendEvent({
    ...args,
    ticketId: args.ticketId ?? null,
  });
  // PRD: tickets/<id>/events.jsonl is the git-side ledger (events_idx is
  // its projection). Regenerate it (+ LOG.md, which derives from it) on
  // every emitted event so the file never trails the DB. Sinks without
  // a repo path (pure DB callers) skip the write. Best-effort: a fs
  // hiccup must not mask the event itself.
  if (args.ticketId && sink.ticketsRepoPath && sink.store && sink.workspace) {
    await regenerateLog(
      {
        workspace: sink.workspace,
        ticketsRepoPath: sink.ticketsRepoPath,
        store: sink.store as TransitionContext['store'],
        actor: '',
        now: () => new Date(),
      },
      args.ticketId,
    ).catch(() => {});
  }
  return seq;
}

/**
 * Render `events_idx` rows for one ticket as a markdown table
 * (timestamped, append-only — the human-readable mirror of
 * events.jsonl). Written to `tickets/<id>/LOG.md`.
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

/**
 * Regenerate `tickets/<id>/LOG.md` from the event projection. Cheap —
 * called after every event batch the transition table appends for a
 * ticket subject (CONDUCTOR "Runner tasks … LOG.md regeneration").
 * Returns the written path, or null for non-ticket subjects.
 */
/** Serialize one events_idx row as a SCHEMAS §7 events.jsonl line. */
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

export async function regenerateLog(
  ctx: TransitionContext,
  ticketId: string,
): Promise<string | null> {
  const events = await ctx.store.listEvents({
    workspace: ctx.workspace,
    ticket_id: ticketId,
  });
  const dir = join(ctx.ticketsRepoPath, 'tickets', ticketId);
  await mkdir(dir, { recursive: true });
  // events.jsonl is the machine ledger (SCHEMAS §7); LOG.md is generated
  // from the same projection — write the ledger first, then its mirror.
  await writeFile(
    join(dir, 'events.jsonl'),
    `${events.map(renderEventLine).join('\n')}${events.length ? '\n' : ''}`,
    'utf8',
  );
  const path = join(dir, 'LOG.md');
  await writeFile(path, renderLogMd(ticketId, events), 'utf8');
  return path;
}

/**
 * Commit + LOG.md tail shared by transition rows that mutate the
 * tickets repo outside `applyTicketStatus` (artifact commits like
 * split-plan.md, LOG.md itself). Returns the commit sha.
 */
export async function commitWorkspace(
  ctx: TransitionContext,
  message: string,
): Promise<string> {
  return commitAll(ctx.ticketsRepoPath, message, {
    name: ctx.actor,
    email: `${ctx.actor}@sprint-runner.local`,
  });
}
