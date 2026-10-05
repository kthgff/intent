/**
 * interview/session.ts — interview sessions, the two readiness
 * thresholds, resumable snapshots and the resume diff briefing
 * (PRD §15.9).
 *
 * A session pins a `(wizard_id, wizard_version)` so an in-flight
 * interview keeps the knowledge requirements it started on. Its
 * `status` is `active|paused|completed|abandoned`; `draft_ready` and
 * `approval_ready` are materialized from {@link evaluateReadiness} —
 * two separate gates, never one score.
 *
 * Snapshots are append-only resume points; resuming diffs the current
 * knowledge state against the latest snapshot and returns a "what
 * changed since you left" briefing.
 */
import { randomUUID } from 'node:crypto';
import type {
  InterviewMessageRow,
  InterviewSessionRow,
  KnowledgeSlotRow,
  SessionSnapshotRow,
} from '@sprint-runner/core';
import { listSlots, openDecisionsForSlots } from './slots.js';
import {
  type InterviewCtx,
  type ReadinessBlocker,
  type ReadinessReport,
  type ResumeBriefing,
  type SlotState,
  type WizardConfig,
  asSlotState,
  conflict,
  invalid,
  notFound,
  sessionIdFor,
} from './types.js';
import { initialSlots, loadWizardConfig, thresholdsOf } from './wizard.js';

const ALL_STATES: SlotState[] = [
  'known',
  'inferred',
  'missing',
  'conflicted',
  'not-applicable',
  'deferred',
];

export async function getSession(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<InterviewSessionRow | null> {
  return ctx.store.getInterviewSession({
    workspace: ctx.workspace,
    session_id: sessionId,
  });
}

/** 404 when absent — every other engine call requires the session. */
export async function requireSession(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<InterviewSessionRow> {
  const s = await getSession(ctx, sessionId);
  if (!s) {
    throw notFound(`no interview session '${sessionId}' in ${ctx.workspace}`);
  }
  return s;
}

/** Load the wizard config the session is pinned to. */
export async function sessionWizard(
  ctx: InterviewCtx,
  session: InterviewSessionRow,
): Promise<WizardConfig> {
  if (!session.wizard_id) {
    throw invalid(`session ${session.session_id} has no wizard`);
  }
  return loadWizardConfig(
    ctx,
    session.wizard_id,
    session.wizard_version ?? undefined,
  );
}

export interface StartSessionArgs {
  wizardId: string;
  subject?: string | null;
  mode?: InterviewSessionRow['mode'];
  /** Explicit session id — otherwise deterministic per (wizard, subject). */
  sessionId?: string;
  /** Branch to open with the session (multi-stakeholder, §15.9). */
  branch?: string | null;
  role?: string | null;
}

/**
 * Start (or resume) a session for a wizard. Idempotent on the session
 * id: re-starting an existing session returns it untouched. Seeds the
 * declared knowledge slots and appends an `interview_started` event +
 * system transcript message.
 */
export async function startSession(
  ctx: InterviewCtx,
  args: StartSessionArgs,
): Promise<InterviewSessionRow> {
  const cfg = await loadWizardConfig(ctx, args.wizardId);
  const sessionId =
    args.sessionId ?? sessionIdFor(args.wizardId, args.subject ?? null);
  const existing = await getSession(ctx, sessionId);
  if (existing) return existing;

  const ts = ctx.now().toISOString();
  const row: InterviewSessionRow = {
    workspace: ctx.workspace,
    org: null,
    session_id: sessionId,
    wizard_id: cfg.wizard_id,
    wizard_version: cfg.version,
    subject: args.subject ?? null,
    mode: args.mode ?? 'conversation',
    status: 'active',
    draft_ready: false,
    approval_ready: false,
    knowledge_version: null,
    created_by: ctx.actor,
    created_at: ts,
    updated_at: ts,
  };
  await ctx.store.upsertInterviewSession(row);
  for (const slot of initialSlots(
    cfg,
    { workspace: ctx.workspace, sessionId },
    ts,
  )) {
    await ctx.store.upsertKnowledgeSlot(slot);
  }
  if (args.branch) {
    await ctx.store.upsertInterviewBranch({
      workspace: ctx.workspace,
      org: null,
      session_id: sessionId,
      branch: args.branch,
      role: args.role ?? null,
      status: 'active',
      created_at: ts,
      merged_at: null,
    });
  }
  await appendMessage(ctx, {
    sessionId,
    role: 'system',
    content: `interview started — wizard ${cfg.wizard_id} v${cfg.version}${
      args.subject ? ` for ${args.subject}` : ''
    }`,
    branch: args.branch ?? null,
  });
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: args.subject ?? null,
    ts,
    stage: 'interview',
    actor_type: 'human',
    actor_id: ctx.actor,
    event: 'interview_started',
    run: null,
    refs: [`interview:${sessionId}`],
    data: { wizard_id: cfg.wizard_id, wizard_version: cfg.version },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  return row;
}

/** Append a transcript message (store-assigned seq). */
export async function appendMessage(
  ctx: InterviewCtx,
  args: {
    sessionId: string;
    role: InterviewMessageRow['role'];
    content: string;
    branch?: string | null;
  },
): Promise<InterviewMessageRow> {
  const ts = ctx.now().toISOString();
  const seq = await ctx.store.appendInterviewMessage({
    workspace: ctx.workspace,
    org: null,
    session_id: args.sessionId,
    branch: args.branch ?? null,
    role: args.role,
    content: args.content,
    created_at: ts,
  });
  return {
    workspace: ctx.workspace,
    org: null,
    session_id: args.sessionId,
    seq,
    branch: args.branch ?? null,
    role: args.role,
    content: args.content,
    created_at: ts,
  };
}

/** The durable transcript (incremental when `after` is given). */
export async function transcript(
  ctx: InterviewCtx,
  sessionId: string,
  after?: number,
): Promise<InterviewMessageRow[]> {
  return ctx.store.listInterviewMessages({
    workspace: ctx.workspace,
    session_id: sessionId,
    ...(after !== undefined ? { after } : {}),
  });
}

/** Switch input mode without loss (§15.9) — the transcript is durable. */
export async function setMode(
  ctx: InterviewCtx,
  args: { sessionId: string; mode: NonNullable<InterviewSessionRow['mode']> },
): Promise<InterviewSessionRow> {
  const session = await requireSession(ctx, args.sessionId);
  const next: InterviewSessionRow = {
    ...session,
    mode: args.mode,
    updated_at: ctx.now().toISOString(),
  };
  await ctx.store.upsertInterviewSession(next);
  return next;
}

/** Move the session status (`active|paused|completed|abandoned`). */
export async function setStatus(
  ctx: InterviewCtx,
  args: {
    sessionId: string;
    status: InterviewSessionRow['status'];
  },
): Promise<InterviewSessionRow> {
  const session = await requireSession(ctx, args.sessionId);
  if (session.status === 'completed' && args.status === 'active') {
    throw conflict(
      `session ${args.sessionId} is completed — start a new session to continue`,
    );
  }
  const next: InterviewSessionRow = {
    ...session,
    status: args.status,
    updated_at: ctx.now().toISOString(),
  };
  await ctx.store.upsertInterviewSession(next);
  return next;
}

// ---------------------------------------------------------------------------
// readiness — the two thresholds
// ---------------------------------------------------------------------------

/** Pure readiness computation from slot rows + open decision ids. */
export function computeReadiness(
  cfg: WizardConfig,
  rows: KnowledgeSlotRow[],
  openDecisions: string[],
): ReadinessReport {
  const thresholds = thresholdsOf(cfg);
  const draftSet = new Set<SlotState>(thresholds.draft);
  const approvalSet = new Set<SlotState>(thresholds.approval);
  const required = new Set(
    cfg.slots.filter((s) => s.required === true).map((s) => s.slot),
  );
  const requiredRows = rows.filter((r) => required.has(r.slot));

  const states = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<
    SlotState,
    number
  >;
  for (const r of requiredRows) states[asSlotState(r.state)] += 1;

  const draft_blockers: ReadinessBlocker[] = [];
  const approval_blockers: ReadinessBlocker[] = [];
  for (const r of requiredRows) {
    const state = asSlotState(r.state);
    if (!draftSet.has(state)) {
      draft_blockers.push({
        slot: r.slot,
        state,
        reason: `required slot is ${r.state}`,
      });
    }
    if (!approvalSet.has(state)) {
      approval_blockers.push({
        slot: r.slot,
        state,
        reason: `required slot is ${r.state} — approval needs ${thresholds.approval.join('|')}`,
      });
    }
  }
  if (openDecisions.length > 0) {
    approval_blockers.push({
      slot: '(decisions)',
      state: 'conflicted',
      reason: `${openDecisions.length} open decision item(s) must be ruled on`,
    });
  }

  const draft_ready = draft_blockers.length === 0;
  const approval_ready = approval_blockers.length === 0;
  const slotCounts = ALL_STATES.filter((s) => states[s] > 0)
    .map((s) => `${states[s]} ${s}`)
    .join(', ');
  const summary = `draft_ready=${draft_ready} approval_ready=${approval_ready}; ${requiredRows.length} required slot(s): ${slotCounts}${openDecisions.length > 0 ? `; ${openDecisions.length} open decision(s)` : ''}`;
  return {
    draft_ready,
    approval_ready,
    required_total: requiredRows.length,
    states,
    draft_blockers,
    approval_blockers,
    open_decisions: openDecisions,
    summary,
  };
}

/** Compute + persist the session's readiness flags. */
export async function refreshReadiness(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<ReadinessReport> {
  const session = await requireSession(ctx, sessionId);
  const cfg = await sessionWizard(ctx, session);
  const rows = await listSlots(ctx, sessionId);
  const open = await openDecisionsForSlots(ctx, rows);
  const report = computeReadiness(cfg, rows, open);
  if (
    session.draft_ready !== report.draft_ready ||
    session.approval_ready !== report.approval_ready
  ) {
    await ctx.store.upsertInterviewSession({
      ...session,
      draft_ready: report.draft_ready,
      approval_ready: report.approval_ready,
      updated_at: ctx.now().toISOString(),
    });
  }
  return report;
}

/** Read-only readiness view. */
export async function evaluateReadiness(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<ReadinessReport> {
  const session = await requireSession(ctx, sessionId);
  const cfg = await sessionWizard(ctx, session);
  const rows = await listSlots(ctx, sessionId);
  const open = await openDecisionsForSlots(ctx, rows);
  return computeReadiness(cfg, rows, open);
}

// ---------------------------------------------------------------------------
// snapshots + resume diff briefing
// ---------------------------------------------------------------------------

interface SnapshotBody {
  last_seq: number;
  readiness: ReadinessReport;
  slots: { slot: string; state: SlotState; value: string | null }[];
}

/** Append a resume point capturing the current knowledge state. */
export async function snapshot(
  ctx: InterviewCtx,
  args: { sessionId: string; reason?: string | null },
): Promise<SessionSnapshotRow> {
  const session = await requireSession(ctx, args.sessionId);
  const rows = await listSlots(ctx, args.sessionId);
  const readiness = await evaluateReadiness(ctx, args.sessionId);
  const messages = await transcript(ctx, args.sessionId);
  const latest = await ctx.store.getSessionSnapshot({
    workspace: ctx.workspace,
    session_id: args.sessionId,
  });
  const version = (latest?.version ?? 0) + 1;
  const body: SnapshotBody = {
    last_seq:
      messages.length > 0 ? (messages[messages.length - 1]?.seq ?? 0) : 0,
    readiness,
    slots: rows.map((r) => ({
      slot: r.slot,
      state: asSlotState(r.state),
      value: r.value ?? null,
    })),
  };
  const row: SessionSnapshotRow = {
    workspace: ctx.workspace,
    org: null,
    session_id: args.sessionId,
    version,
    snapshot: body as unknown as Record<string, unknown>,
    reason: args.reason ?? null,
    created_at: ctx.now().toISOString(),
  };
  await ctx.store.appendSessionSnapshot(row);
  await ctx.store.upsertInterviewSession({
    ...session,
    knowledge_version: version,
    updated_at: ctx.now().toISOString(),
  });
  return row;
}

/**
 * Resume a session: diff the current knowledge state against the
 * latest snapshot and return a "what changed since you left" briefing.
 * The briefing is also appended to the durable transcript so the
 * change note is never stream-only.
 */
export async function resume(
  ctx: InterviewCtx,
  args: { sessionId: string; persist?: boolean },
): Promise<ResumeBriefing> {
  await requireSession(ctx, args.sessionId);
  const latest = await ctx.store.getSessionSnapshot({
    workspace: ctx.workspace,
    session_id: args.sessionId,
  });
  const rows = await listSlots(ctx, args.sessionId);
  const readinessAfter = await evaluateReadiness(ctx, args.sessionId);
  const after: SnapshotBody | null = latest
    ? (latest.snapshot as unknown as SnapshotBody)
    : null;

  const beforeBySlot = new Map(
    (after?.slots ?? []).map((s) => [s.slot, s] as const),
  );
  const changed_slots = rows
    .map((r) => {
      const before = beforeBySlot.get(r.slot);
      return {
        slot: r.slot,
        from: before ? before.state : null,
        to: asSlotState(r.state),
      };
    })
    .filter((c) => c.from !== c.to);

  const newMessages = await transcript(
    ctx,
    args.sessionId,
    after?.last_seq ?? undefined,
  );

  const parts: string[] = [];
  if (!latest) {
    parts.push('no prior snapshot — first resume');
  } else {
    parts.push(`${changed_slots.length} slot(s) changed`);
    if (newMessages.length > 0) {
      parts.push(`${newMessages.length} new message(s)`);
    }
    if (after && after.readiness.draft_ready !== readinessAfter.draft_ready) {
      parts.push(
        `draft_ready ${after.readiness.draft_ready} → ${readinessAfter.draft_ready}`,
      );
    }
    if (
      after &&
      after.readiness.approval_ready !== readinessAfter.approval_ready
    ) {
      parts.push(
        `approval_ready ${after.readiness.approval_ready} → ${readinessAfter.approval_ready}`,
      );
    }
  }

  const briefing: ResumeBriefing = {
    session_id: args.sessionId,
    from_version: latest?.version ?? null,
    to_version: latest?.version ?? 0,
    changed_slots,
    new_messages: newMessages,
    readiness_before: after?.readiness ?? null,
    readiness_after: readinessAfter,
    summary: parts.join('; '),
  };

  if (args.persist !== false) {
    await appendMessage(ctx, {
      sessionId: args.sessionId,
      role: 'system',
      content: `[resume briefing] ${briefing.summary}`,
    });
  }
  return briefing;
}

/** Convenience: pause a session — snapshot first, then flip status. */
export async function pauseSession(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<InterviewSessionRow> {
  await snapshot(ctx, { sessionId, reason: 'pause' });
  return setStatus(ctx, { sessionId, status: 'paused' });
}

/** Convenience: resume a paused session with a change briefing. */
export async function resumeSession(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<{ session: InterviewSessionRow; briefing: ResumeBriefing }> {
  const briefing = await resume(ctx, { sessionId });
  const session = await setStatus(ctx, { sessionId, status: 'active' });
  return { session, briefing };
}

/** Random id helper for callers that want a fresh session. */
export function newSessionId(wizardId: string): string {
  return sessionIdFor(wizardId, `s-${randomUUID().slice(0, 8)}`);
}
