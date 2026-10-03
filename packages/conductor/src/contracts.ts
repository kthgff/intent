/**
 * contracts.ts — the TransitionHandler seam (wp-030).
 *
 * CONDUCTOR.md splits the conductor's job in two:
 *
 *   - The TICK LOOP (this wp): RECONCILE → CLAIM → LAUNCH, heartbeats,
 *     leases, caps, retries. Owns *when* a transition happens.
 *   - The sentinel→transition TABLE (wp-031): "what does this sentinel
 *     mean" — which status to write, which gate_items to surface, which
 *     follow-up runs to queue. Owns *what* a transition means.
 *
 * `TransitionHandler` is the injectable boundary between them. The
 * conductor calls exactly two methods; wp-031 implements the real
 * table behind this interface. `StubTransitionHandler` below is the
 * no-op/minimal implementation used until then (and in tests).
 *
 * Spec anchors:
 *   - CONDUCTOR.md "The loop" steps 1–3 (RECONCILE / CLAIM / LAUNCH)
 *   - CONDUCTOR.md "Auto-advance rules" — which transitions auto-fire
 *   - CONDUCTOR.md "Sentinel → transition table" — wp-031's payload
 *   - CONDUCTOR.md "Run lifecycle" — sentinel missing/unparseable →
 *     `run_failed` is CONDUCTOR-owned; the handler never sees it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ActorType,
  EventName,
  EventRow,
  GateItem,
  GateKind,
  RunResult,
  RunRow,
  Stage,
  Store,
  TicketPriority,
  TicketRow,
  TicketStatus,
} from '@sprint-runner/core';
import { commitAll } from '@sprint-runner/gitops';
import { regenerateLog } from './events/index.js';

// ---------------------------------------------------------------------------
// Context handed to the handler
// ---------------------------------------------------------------------------

/** Everything the handler needs to reason about one workspace. */
export interface TransitionContext {
  /** Workspace key (tickets_repos.<name>). */
  workspace: string;
  /** Absolute path to the tickets repo checkout. */
  ticketsRepoPath: string;
  /** Storage (projections, gate items, events, runs). */
  store: Store;
  /** `actor:` identity for commits/events. */
  actor: string;
  /** Wall clock (injectable for tests). */
  now: () => Date;
}

/** A finished run as the handler sees it (CONDUCTOR reconcile step 1). */
export interface RunOutcome {
  /** Post-collect run row — status is `done` (sentinel parsed) or
   *  `failed`. `sentinel`/`sentinel_raw`/usage fields are populated. */
  run: RunRow;
  /** Raw adapter.collect() output — artifacts, usage, exit_code. */
  result: RunResult;
  /** Absolute path of the written usage.json, if any. */
  usagePath: string | null;
  /** Absolute ticket dir for ticket subjects, undefined otherwise. */
  ticketDir?: string;
}

/** What the CLAIM step should launch next for a ticket, if anything. */
export interface NextTransition {
  /** Stage to run (e.g. `triage`, `prd`, `implement`). */
  stage: Stage;
  /** Optional subject override — defaults to the ticket id. */
  subject?: string;
  /** Optional model override (e.g. escalation_model retry). */
  model?: string;
}

// ---------------------------------------------------------------------------
// Transition application API — the narrow write surface wp-031 uses
// ---------------------------------------------------------------------------

/** Options for {@link TransitionTools.applyTicketStatus}. */
export interface ApplyStatusOptions {
  ticketId: string;
  status: TicketStatus;
  /** `blocked_reason` — set with status `blocked`; null clears it. */
  blockedReason?: string | null;
  /** Commit message override; default `conductor: <ticket> → <status>`. */
  commitMessage?: string;
  /** Related run id — stamped onto the status_changed event. */
  run?: string;
  /** Extra event data payload. */
  data?: Record<string, unknown>;
}

/** Result of a status write — the tickets-repo commit sha. */
export interface ApplyStatusResult {
  commit: string;
}

/** A run the handler asks the conductor to queue (deduplicated on
 *  live same-subject+same-stage runs). */
export interface RunRequest {
  workspace: string;
  /** ticket id, or `probe:<repo>` / `survey:<scope>:<name>` / … */
  subject: string;
  stage: Stage;
  ticketId?: string;
  model?: string;
  /** Extra prompt tokens merged over the conductor's defaults. */
  tokens?: Record<string, string>;
}

/**
 * The narrow transition-application API handed to `onRunComplete` —
 * everything wp-031's table needs to mutate the world, nothing more.
 * (CONDUCTOR reconcile step 1: "commit status + artifacts + events →
 * release lease → check auto-advance" — lease release and artifact/
 * usage writes happen BEFORE this is called; these methods cover the
 * commit/status/gate/event/follow-up parts.)
 */
export interface TransitionTools extends TransitionContext {
  /**
   * Rewrite `status:` (and optionally `blocked_reason:`) in
   * `tickets/<id>/ticket.md` frontmatter, commit the tickets repo,
   * update the `tickets` projection row, and append a `status_changed`
   * events_idx row. Returns the commit sha.
   */
  applyTicketStatus(opts: ApplyStatusOptions): Promise<ApplyStatusResult>;

  /**
   * Surface a `gate_items` row + its notification (DB-SCHEMA:
   * notifications are generated on gate_items insert). Gates wait for
   * a human forever — the conductor never clears them (CONDUCTOR
   * "Auto-advance rules").
   */
  surfaceGateItem(item: {
    subject: string;
    gate: string;
    kind: GateKind;
    priority?: TicketPriority;
    blockedAgent?: boolean;
    payload?: unknown;
  }): Promise<void>;

  /** Append an events_idx row (projection of events.jsonl, SCHEMAS §7).
   *  `seq` is assigned by the store. */
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

  /**
   * Queue a follow-up run (a `pending` runs row the next CLAIM pass
   * leases + launches). Deduplicated: returns the run id, or null when
   * a live run for (subject, stage) already exists — the conductor
   * uses the same path for its own `probe:<repo>` queueing (CONDUCTOR
   * "Repo-card rule").
   */
  requestRun(req: RunRequest): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * The sentinel→transition decision surface (wp-031 implements it).
 *
 * The conductor guarantees:
 *   - `nextStage` is only asked for non-terminal tickets.
 *   - `onRunComplete` is called exactly once per collected run whose
 *     sentinel parsed; lease release, usage.json, sanitizer scan, and
 *     the run row update have already happened. A run with a missing/
 *     unparseable sentinel goes down the conductor-owned retry ladder
 *     (CONDUCTOR "Run lifecycle") and never reaches the handler.
 */
export interface TransitionHandler {
  /**
   * CLAIM query (CONDUCTOR "CLAIM" + "Auto-advance rules"): does this
   * ticket's status allow a non-gate transition right now? Return the
   * stage to launch, or null. Gates/terminal statuses → null.
   */
  nextStage(
    ticket: TicketRow,
    ctx: TransitionContext,
  ): Promise<NextTransition | null> | NextTransition | null;

  /**
   * RECONCILE handoff (CONDUCTOR "Sentinel → transition table"):
   * interpret `outcome.result.sentinel` and apply the table's action
   * via `tools` — status commits, gate items, follow-up run requests.
   */
  onRunComplete(outcome: RunOutcome, tools: TransitionTools): Promise<void>;
}

/**
 * Stub/no-op handler (wp-030). `nextStages` is an explicit
 * status→stage map used by tests and early integration — it is NOT
 * the real transition table; wp-031 replaces this whole class.
 */
export class StubTransitionHandler implements TransitionHandler {
  readonly #nextStages: Record<string, Stage>;
  readonly #onRunComplete?: (
    outcome: RunOutcome,
    tools: TransitionTools,
  ) => void | Promise<void>;

  constructor(
    opts: {
      /** status → next stage (e.g. `{ imported: 'triage' }`). */
      nextStages?: Record<string, Stage>;
      onRunComplete?: (
        outcome: RunOutcome,
        tools: TransitionTools,
      ) => void | Promise<void>;
    } = {},
  ) {
    this.#nextStages = opts.nextStages ?? {};
    if (opts.onRunComplete) this.#onRunComplete = opts.onRunComplete;
  }

  nextStage(ticket: TicketRow): NextTransition | null {
    const stage = this.#nextStages[ticket.status];
    return stage === undefined ? null : { stage };
  }

  async onRunComplete(
    outcome: RunOutcome,
    tools: TransitionTools,
  ): Promise<void> {
    await this.#onRunComplete?.(outcome, tools);
  }
}

// ---------------------------------------------------------------------------
// applyTicketStatus — frontmatter status write + commit helper
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Rewrite `status:` / `blocked_reason:` inside the frontmatter block
 * of a ticket.md, preserving everything else byte-for-byte (comments,
 * key order, body). Line-level edit — no YAML re-serialization.
 */
export function rewriteFrontmatterStatus(
  raw: string,
  status: string,
  blockedReason: string | null | undefined,
): string {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m || m[1] === undefined) {
    throw new Error('ticket.md: missing or malformed --- frontmatter block');
  }
  const lines = m[1].split('\n');
  const hasBlockedKey = lines.some((l) => /^blocked_reason\s*:/.test(l));
  const insertBlocked =
    !hasBlockedKey && blockedReason !== undefined && blockedReason !== null;
  const out: string[] = [];
  let sawStatus = false;
  for (const line of lines) {
    if (/^status\s*:/.test(line)) {
      out.push(`status: ${status}`);
      if (insertBlocked) out.push(`blocked_reason: ${blockedReason}`);
      sawStatus = true;
      continue;
    }
    if (/^blocked_reason\s*:/.test(line)) {
      if (blockedReason === null) continue; // explicit clear → drop line
      if (blockedReason === undefined) {
        out.push(line); // untouched
      } else {
        out.push(`blocked_reason: ${blockedReason}`);
      }
      continue;
    }
    out.push(line);
  }
  if (!sawStatus) {
    throw new Error('ticket.md frontmatter has no status: line');
  }
  return raw.replace(m[1], out.join('\n'));
}

/**
 * The status-write half of every transition row (wp-031 calls this via
 * `tools.applyTicketStatus`): edit frontmatter → commitAll → update the
 * `tickets` projection → append `status_changed`.
 */
export async function applyTicketStatus(args: {
  ctx: TransitionContext;
  opts: ApplyStatusOptions;
  actor: { name: string; email: string };
}): Promise<ApplyStatusResult> {
  const { ctx, opts, actor } = args;
  const file = join(ctx.ticketsRepoPath, 'tickets', opts.ticketId, 'ticket.md');
  const raw = await readFile(file, 'utf8');
  const next = rewriteFrontmatterStatus(raw, opts.status, opts.blockedReason);
  await writeFile(file, next, 'utf8');

  const commit = await commitAll(
    ctx.ticketsRepoPath,
    opts.commitMessage ?? `conductor: ${opts.ticketId} → ${opts.status}`,
    actor,
  );

  const ts = ctx.now().toISOString();
  const ticket = await ctx.store.getTicket({
    workspace: ctx.workspace,
    ticket_id: opts.ticketId,
  });
  if (ticket) {
    await ctx.store.upsertTicket({
      ...ticket,
      status: opts.status,
      blocked_reason:
        opts.blockedReason === undefined
          ? ticket.blocked_reason
          : opts.blockedReason,
      updated_at: ts,
    });
  }

  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: opts.ticketId,
    ts,
    stage: null,
    actor_type: 'runner',
    actor_id: ctx.actor,
    event: 'status_changed',
    run: opts.run ?? null,
    refs: [],
    data: {
      from: ticket?.status ?? null,
      to: opts.status,
      commit,
      ...opts.data,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });

  // Keep the ticket's git-side ledger (events.jsonl + LOG.md) in step —
  // run_failed/status_changed paths that bypass emitEvent still land.
  await regenerateLog(ctx, opts.ticketId).catch(() => {});

  return { commit };
}

export type { GateItem };
