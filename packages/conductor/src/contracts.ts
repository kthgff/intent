/**
 * contracts.ts — the TransitionHandler seam (wp-030; rewired wp-092).
 *
 * CONDUCTOR.md splits the conductor's job in two:
 *
 *   - The TICK LOOP: RECONCILE → CLAIM → LAUNCH, heartbeats, leases,
 *     caps, retries. Owns *when* a transition happens.
 *   - The sentinel→transition TABLE (wp-031): "what does this sentinel
 *     mean" — which status to write, which gate_items to surface, which
 *     follow-up runs to queue. Owns *what* a transition means.
 *
 * `TransitionHandler` is the injectable boundary between them.
 *
 * D29 (wp-092): the DB is the system of record — no ticket.md files on
 * disk, no events.jsonl, no tickets-repo commits. Docs are immutable
 * `doc_versions` rows; structured stage output is `run_artifacts`;
 * status changes update `tickets` + append an `events` row in the same
 * write path. `rootPath` is the workspace's plain working root (run
 * dirs, repo anchoring, `.veto/` scratch state) — it is NOT a git
 * ledger.
 */
import type {
  ActorType,
  DocKind,
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

// ---------------------------------------------------------------------------
// Context handed to the handler
// ---------------------------------------------------------------------------

/** Everything the handler needs to reason about one workspace. */
export interface TransitionContext {
  /** Workspace key (projects.workspace). */
  workspace: string;
  /** Absolute path to the workspace root dir (run dirs, repo anchoring,
   *  `.veto/` scratch state). Not a git repo — DB is truth (D29). */
  rootPath: string;
  /** Storage (truth rows, gate items, events, runs, docs, artifacts). */
  store: Store;
  /** `actor:` identity for events/edits. */
  actor: string;
  /** Wall clock (injectable for tests). */
  now: () => Date;
}

/** A finished run as the handler sees it (CONDUCTOR reconcile step 1). */
export interface RunOutcome {
  /** Post-collect run row — status is `done` (sentinel parsed) or
   *  `failed`. `sentinel`/`sentinel_raw`/usage fields are populated. */
  run: RunRow;
  /** Raw adapter.collect() output — artifacts (runDir paths), usage,
   *  exit_code. Structured files have already been ingested into
   *  `run_artifacts`/`doc_versions` by reconcile. */
  result: RunResult;
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
  /** Related run id — stamped onto the status_changed event. */
  run?: string;
  /** Extra event data payload. */
  data?: Record<string, unknown>;
}

/** Result of a status write (wp-092 — was the tickets-repo commit sha
 *  under v1; now the doc_version written, if the ticket has a
 *  ticket.md doc). */
export interface ApplyStatusResult {
  /** New doc_versions.version for the ticket.md status rewrite, or
   *  null when the ticket has no ticket.md doc. */
  docVersion: number | null;
}

/**
 * Conductor-side runner-task spec (CONDUCTOR "Runner tasks") — a run
 * that executes inside the conductor process instead of an agent
 * adapter. Persisted in `runs.request.task` so a queued row's launch is
 * durable.
 *
 * - `verify` — repo-card test/lint/build suite (envops runVerifyTask);
 *   derives repos + worktrees from the run's ticket.
 * - `import` — fetch → materialize into tickets/doc_versions rows
 *   (import/run.ts). `repo` = `owner/name` (GitHub).
 */
export type RunnerTask =
  | { kind: 'verify' }
  | {
      kind: 'import';
      repo?: string;
      milestone?: string;
      labels?: string[];
    };

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
  /** Runner-task spec for agent-less stages (verify/import) — inferred
   *  from the stage when omitted. */
  task?: RunnerTask;
}

/**
 * The narrow transition-application API handed to `onRunComplete` —
 * everything the transition table needs to mutate the world, nothing
 * more. DB-only (D29): status writes, gate items, events, doc versions,
 * run artifacts, id allocation.
 */
export interface TransitionTools extends TransitionContext {
  /**
   * Update the `tickets` truth row's `status`/`blocked_reason`, append
   * a `status_changed` events row, and — when a ticket.md doc exists —
   * rewrite its frontmatter into a new `doc_versions` version
   * (D24: every persisted doc change is a version). In one logical
   * write path; no git involvement.
   */
  applyTicketStatus(opts: ApplyStatusOptions): Promise<ApplyStatusResult>;

  /**
   * Surface a `gate_items` row + its notification (DB-SCHEMA:
   * notifications are generated on gate_items insert). Gates wait for
   * a human forever — the conductor never clears them.
   */
  surfaceGateItem(item: {
    subject: string;
    gate: string;
    kind: GateKind;
    priority?: TicketPriority;
    blockedAgent?: boolean;
    payload?: unknown;
  }): Promise<void>;

  /** Append an events row (append-only truth, SCHEMAS §7). `seq` is
   *  assigned by the store. */
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
   * a live run for (subject, stage) already exists.
   */
  requestRun(req: RunRequest): Promise<string | null>;

  // ---- doc + artifact + id helpers (wp-092) ----

  /** Latest content of a `doc_versions` doc for a subject, or null. */
  getDocText(subject: string, doc: DocKind): Promise<string | null>;
  /** Append a new immutable doc version; returns the version number. */
  putDoc(subject: string, doc: DocKind, content: string): Promise<number>;

  /** Content of one run_artifacts row, or null. */
  getArtifactText(runId: string, name: string): Promise<string | null>;
  /** Write/replace a run_artifacts row. */
  putArtifact(runId: string, name: string, content: string): Promise<void>;
  /**
   * Latest artifact with `name` across a subject's runs (e.g. the
   * split-plan.md the triage run produced, read back at gate clear).
   * Pass `ticketId` to scan that ticket's runs; null = the current
   * run only. */
  getLatestArtifactText(
    name: string,
    filter: { ticketId?: string | null; runId?: string | null },
  ): Promise<string | null>;

  /** Transactional id allocation (projects.next_*_seq → `SR-NNNN`). */
  allocTicketId(): Promise<string>;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * The sentinel→transition decision surface.
 *
 * The conductor guarantees:
 *   - `nextStage` is only asked for non-terminal tickets.
 *   - `onRunComplete` is called exactly once per collected run whose
 *     sentinel parsed; lease release, artifact/doc ingestion, sanitizer
 *     scan, and the run row update have already happened. A run with a
 *     missing/unparseable sentinel goes down the conductor-owned retry
 *     ladder and never reaches the handler.
 */
export interface TransitionHandler {
  /**
   * CLAIM query: does this ticket's status allow a non-gate transition
   * right now? Return the stage to launch, or null. Gates/terminal
   * statuses → null.
   */
  nextStage(
    ticket: TicketRow,
    ctx: TransitionContext,
  ): Promise<NextTransition | null> | NextTransition | null;

  /**
   * RECONCILE handoff: interpret `outcome.result.sentinel` and apply
   * the table's action via `tools` — status writes, gate items,
   * follow-up run requests.
   */
  onRunComplete(outcome: RunOutcome, tools: TransitionTools): Promise<void>;
}

/**
 * Stub/no-op handler. `nextStages` is an explicit status→stage map
 * used by tests and early integration — it is NOT the real transition
 * table.
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
// applyTicketStatus — status row + event + doc version (DB-only)
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
 * The status-write half of every transition row: update the `tickets`
 * truth row → append `status_changed` → new ticket.md doc_version when
 * the ticket has one (D24/D29). Throws when the ticket doesn't exist —
 * a status write against a missing truth row is a bug, never a
 * silent skip.
 */
export async function applyTicketStatus(args: {
  ctx: TransitionContext;
  opts: ApplyStatusOptions;
}): Promise<ApplyStatusResult> {
  const { ctx, opts } = args;
  // Row change + audit event + doc version commit together
  // (ARCHITECTURE §4.4 transactional write rule).
  return ctx.store.transaction((store) =>
    applyTicketStatusTx(store, ctx, opts),
  );
}

async function applyTicketStatusTx(
  store: Store,
  ctx: TransitionContext,
  opts: ApplyStatusOptions,
): Promise<ApplyStatusResult> {
  const ts = ctx.now().toISOString();
  const ticket = await store.getTicket({
    workspace: ctx.workspace,
    ticket_id: opts.ticketId,
  });
  if (!ticket) {
    throw new Error(
      `applyTicketStatus: no tickets row for ${ctx.workspace}/${opts.ticketId} (D29: rows are truth — create via allocTicketId + upsertTicket first)`,
    );
  }
  await store.upsertTicket({
    ...ticket,
    status: opts.status,
    blocked_reason:
      opts.blockedReason === undefined
        ? ticket.blocked_reason
        : opts.blockedReason,
    updated_at: ts,
  });

  await store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: opts.ticketId,
    ts,
    stage: null,
    actor_type: 'runner',
    actor_id: ctx.actor,
    event: 'status_changed',
    run: opts.run ?? null,
    refs: [],
    data: { from: ticket.status ?? null, to: opts.status, ...opts.data },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });

  // Keep the ticket.md doc's frontmatter in step — a new version, never
  // an in-place edit (D24). Absent doc → status lives on the row only.
  let docVersion: number | null = null;
  const doc = await store.getDoc({
    workspace: ctx.workspace,
    subject: opts.ticketId,
    doc: 'ticket.md',
  });
  if (doc && FRONTMATTER_RE.test(doc.content)) {
    const next = rewriteFrontmatterStatus(
      doc.content,
      opts.status,
      opts.blockedReason,
    );
    if (next !== doc.content) {
      const v = await store.appendDocVersion(
        {
          workspace: ctx.workspace,
          subject: opts.ticketId,
          doc: 'ticket.md',
        },
        next,
        ctx.actor,
      );
      docVersion = v.version;
    }
  }

  return { docVersion };
}

export type { GateItem };
