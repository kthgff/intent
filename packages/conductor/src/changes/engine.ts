/**
 * changes/engine.ts — the ChangeSet lifecycle engine (PRD §15.5,
 * wp-140; store layer is wp-131).
 *
 * Lifecycle: `draft → analyzing → awaiting-decision →
 * approved|deferred|rejected → applying → verified`.
 *
 * Rules implemented here (fail-closed — a malformed or out-of-order
 * call throws `ChangesetError`, never mutates):
 *
 *   - The ChangeSet pins a `baseline` (subject+doc+version); the
 *     version resolves to the doc head AT CREATE — baselines are
 *     immutable anchors, never "latest".
 *   - Proposed diffs ride `changeset_items.change` (`{content: …}` for
 *     doc-addressable items). Apply appends `doc_versions` — never an
 *     in-place edit — and stamps `proposed_version` with the landed
 *     version.
 *   - `analyzing` computes the affected-artifact set from `relations`
 *     (both directions), `semantic_statements`, and open-release
 *     membership; conflicting OPEN ChangeSets on the same baseline/docs
 *     are recorded and serialized (apply is FIFO per baseline — an
 *     earlier-approved set must resolve first).
 *   - Decision options are first-class: `add-now|swap-scope →
 *     approved`, `next-release → deferred`, `decline → rejected`.
 *     `swap-scope` requires `consequences.swap_out` and removes the
 *     named release items (DELIVERY release_items soft-remove);
 *     `next-release` may pin `consequences.target_release`.
 *   - `expires_on` invalidates approvals: a material upstream change
 *     (another set applied over the same baseline/docs) expires open
 *     approvals, and the tick sweep parks expired `approved` sets back
 *     at `awaiting-decision` — revalidate only what's invalidated.
 *   - `emergency` = expedited decision (allowed pre-analysis) + a
 *     MANDATORY `retro.md` doc_version before `verified` (`retro_ref`).
 *   - Apply is transactional where possible: all pending items land or
 *     record per-item failure in one commit; `apply-failed` keeps
 *     partial application visible (`changeset_items.status` +
 *     `reconciliation`). `rebaseChangesetItem` re-pins drifted items and
 *     returns the set to `awaiting-decision` for re-decision.
 *   - `spec_hash` updates ride the same apply transaction (a ratified
 *     ChangeSet IS the new baseline — not silent adoption: the human
 *     decided; wp-141 owns mid-run pin reconciliation).
 *   - A review comment typed `out-of-scope` creates a draft ChangeSet
 *     and links via `review_comments.changeset_id` (§15.8 handoff —
 *     a comment is an instruction, not authorization).
 */
import {
  type ActorType,
  type BaselineRef,
  CHANGESET_DECISIONS,
  type ChangesetDecision,
  type ChangesetItemRow,
  type ChangesetRow,
  DOC_KINDS,
  type DocKind,
  type EventName,
  type ReviewCommentRow,
  type Store,
} from '@sprint-runner/core';
import type { StreamEvent } from '../loop/deps.js';
import { specInputsHash } from '../transitions/actions.js';
import {
  OPEN_CHANGESET_STATUSES,
  type ChangesetAnalysis,
  analyzeImpact,
  detectConflicts,
  itemFootprint,
} from './analysis.js';

// ---------------------------------------------------------------------------
// Context + errors
// ---------------------------------------------------------------------------

/** Everything the engine needs — a TransitionContext minus rootPath
 *  (the store is the truth; nothing changeset touches disk). */
export interface ChangesCtx {
  workspace: string;
  store: Store;
  actor: string;
  now: () => Date;
  /** Live-channel hook (API.md SSE) — fired AFTER the durable write. */
  notify?: ((event: StreamEvent) => void) | undefined;
}

export type ChangesetErrorCode =
  | 'not_found'
  | 'bad_state'
  | 'conflict'
  | 'invalid';

export class ChangesetError extends Error {
  readonly code: ChangesetErrorCode;
  readonly statusCode: number;

  constructor(code: ChangesetErrorCode, message: string) {
    super(message);
    this.code = code;
    this.statusCode =
      code === 'not_found'
        ? 404
        : code === 'conflict'
          ? 409
          : code === 'invalid'
            ? 400
            : 409; // bad_state → 409 (stale/invalid transition)
  }
}

const notFound = (m: string) => new ChangesetError('not_found', m);
const badState = (m: string) => new ChangesetError('bad_state', m);
const conflict = (m: string) => new ChangesetError('conflict', m);
const invalid = (m: string) => new ChangesetError('invalid', m);

// ---------------------------------------------------------------------------
// Constants + small helpers
// ---------------------------------------------------------------------------

/** Gate instance name surfaced while a set awaits a human decision. */
export const CHANGESET_DECISION_GATE = 'changeset-decision';

/** Docs that feed `tickets.spec_hash` (CONDUCTOR stale-spec check). */
const SPEC_INPUT_DOCS = new Set<string>([
  'ticket.md',
  'prd.md',
  'tdd.md',
  'test.md',
]);

/** Decisions that leave the set approved. */
const APPROVING_DECISIONS = new Set<ChangesetDecision>([
  'add-now',
  'swap-scope',
]);
const DECISION_TO_STATUS: Record<ChangesetDecision, ChangesetRow['status']> = {
  'add-now': 'approved',
  'swap-scope': 'approved',
  'next-release': 'deferred',
  decline: 'rejected',
};

const TERMINAL = new Set(['verified', 'abandoned']);

async function loadChangeset(
  ctx: ChangesCtx,
  changesetId: string,
): Promise<ChangesetRow> {
  const cs = await ctx.store.getChangeset({
    workspace: ctx.workspace,
    changeset_id: changesetId,
  });
  if (!cs) {
    throw notFound(`unknown changeset '${ctx.workspace}/${changesetId}'`);
  }
  return cs;
}

function nowIso(ctx: ChangesCtx): string {
  return ctx.now().toISOString();
}

/** `ticket_id` for the event row — set only when the baseline subject
 *  is a real ticket (changeset events land in that ticket's ledger). */
async function subjectTicketId(
  ctx: ChangesCtx,
  cs: ChangesetRow,
): Promise<string | null> {
  const s = cs.baseline?.subject;
  if (!s) return null;
  const t = await ctx.store.getTicket({
    workspace: ctx.workspace,
    ticket_id: s,
  });
  return t ? s : null;
}

async function emit(
  ctx: ChangesCtx,
  cs: ChangesetRow,
  event: EventName,
  data: Record<string, unknown> = {},
  opts: { refs?: string[]; actorType?: ActorType } = {},
): Promise<void> {
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: await subjectTicketId(ctx, cs),
    ts: nowIso(ctx),
    stage: null,
    actor_type: opts.actorType ?? 'human',
    actor_id: ctx.actor,
    event,
    run: null,
    refs: opts.refs ?? [],
    data: { changeset_id: cs.changeset_id, ...data },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  ctx.notify?.({ type: 'changeset', payload: cs });
}

/** Owner-scoped notification fan-out (PRD §15.5 safeguards): one
 *  notification per affected owner (plus a workspace-wide one so the
 *  inbox never misses unowned sets). */
async function notifyOwners(
  ctx: ChangesCtx,
  cs: ChangesetRow,
  kind: string,
  analysis: ChangesetAnalysis | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const ts = nowIso(ctx);
  const owners = (analysis?.owners ?? []).filter((o): o is string => !!o);
  const targets = owners.length > 0 ? owners : [null];
  for (const owner of targets) {
    await ctx.store.insertNotification({
      workspace: ctx.workspace,
      subject: cs.changeset_id,
      kind,
      payload: JSON.stringify({
        changeset_id: cs.changeset_id,
        owner,
        baseline: cs.baseline ?? null,
        decision: cs.decision ?? null,
        affected_subjects:
          analysis?.affected_subjects?.map((a) => a.subject) ?? [],
        ...extra,
      }),
      created_at: ts,
      read_at: null,
    });
    ctx.notify?.({
      type: 'notification',
      payload: {
        workspace: ctx.workspace,
        subject: cs.changeset_id,
        kind,
        owner,
      },
    });
  }
}

/** Surface (or re-surface) the decision gate item — DB-SCHEMA
 *  notifications fire on gate_items insert. */
async function surfaceDecisionGate(
  ctx: ChangesCtx,
  cs: ChangesetRow,
): Promise<void> {
  const existing = await ctx.store.getGateItem({
    workspace: ctx.workspace,
    subject: cs.changeset_id,
    gate: CHANGESET_DECISION_GATE,
  });
  if (existing && !existing.cleared_at) return; // already open
  await ctx.store.upsertGateItem({
    workspace: ctx.workspace,
    subject: cs.changeset_id,
    gate: CHANGESET_DECISION_GATE,
    kind: 'approval',
    surfaced_at: nowIso(ctx),
    cleared_at: null,
    blocked_agent: false,
    priority: cs.emergency ? 'high' : null,
  });
}

async function clearDecisionGate(
  ctx: ChangesCtx,
  cs: ChangesetRow,
): Promise<void> {
  const key = {
    workspace: ctx.workspace,
    subject: cs.changeset_id,
    gate: CHANGESET_DECISION_GATE,
  };
  const item = await ctx.store.getGateItem(key);
  if (item && !item.cleared_at) {
    await ctx.store.clearGateItem(key, nowIso(ctx));
    ctx.notify?.({
      type: 'gate_cleared',
      payload: { ...item, cleared_at: nowIso(ctx) },
    });
  }
}

/** Persist a status + audit fields in one row write + event. */
async function writeState(
  ctx: ChangesCtx,
  cs: ChangesetRow,
  patch: Partial<ChangesetRow>,
  event?: EventName,
  data: Record<string, unknown> = {},
): Promise<ChangesetRow> {
  const next: ChangesetRow = { ...cs, ...patch, updated_at: nowIso(ctx) };
  await ctx.store.upsertChangeset(next);
  if (event) await emit(ctx, next, event, data);
  return next;
}

// ---------------------------------------------------------------------------
// Item input
// ---------------------------------------------------------------------------

export interface ChangesetItemInput {
  subject: string;
  doc?: string;
  base_version?: number | null;
  /** Proposed-change payload — `{content: string}` applies as a new
   *  doc_version for doc-addressable items. */
  change?: Record<string, unknown>;
}

function assertDocKind(doc: string): DocKind {
  if (!(DOC_KINDS as readonly string[]).includes(doc)) {
    throw invalid(
      `changeset item doc '${doc}' is not a doc kind (${DOC_KINDS.join('|')})`,
    );
  }
  return doc as DocKind;
}

/** Resolve `base_version` — the doc head the proposal applies against.
 *  Explicit pins win; absent pin → current head (null when the doc
 *  doesn't exist yet — an addition creates v1). */
async function resolveBaseVersion(
  ctx: ChangesCtx,
  input: ChangesetItemInput,
): Promise<number | null> {
  if (input.base_version !== undefined) return input.base_version;
  if (!input.doc) return null;
  const head = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject: input.subject,
    doc: assertDocKind(input.doc),
  });
  return head?.version ?? null;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateChangesetArgs {
  /** Original request text, verbatim — never rewritten after create. */
  request: string;
  title?: string;
  /** Baseline pin; `version` resolves to the doc head when omitted. */
  baseline?: { subject: string; doc: string; version?: number | null };
  classification?: ChangesetRow['classification'];
  /** Emergency route: expedited decision + mandatory retro doc. */
  emergency?: boolean;
  createdBy?: string;
  items?: ChangesetItemInput[];
  /** §15.8 handoff — an `out-of-scope` review comment routes here. */
  review_comment_id?: string;
}

export async function createChangeset(
  ctx: ChangesCtx,
  args: CreateChangesetArgs,
): Promise<ChangesetRow> {
  if (!args.request?.trim()) {
    throw invalid('changeset request text is required (verbatim)');
  }

  // Review-comment routing: the comment must exist, be typed
  // `out-of-scope`, and not already route to a set (idempotent — a
  // comment drives exactly one ChangeSet).
  let comment: ReviewCommentRow | null = null;
  if (args.review_comment_id) {
    comment =
      (
        await ctx.store.listReviewComments({ workspace: ctx.workspace })
      ).find((c) => c.comment_id === args.review_comment_id) ?? null;
    if (!comment) {
      throw notFound(
        `unknown review comment '${args.review_comment_id}'`,
      );
    }
    if (comment.type !== 'out-of-scope') {
      throw invalid(
        `review comment '${comment.comment_id}' is '${comment.type ?? 'untyped'}' — only 'out-of-scope' routes to a ChangeSet`,
      );
    }
    if (comment.changeset_id) {
      throw conflict(
        `review comment '${comment.comment_id}' already routed to ${comment.changeset_id}`,
      );
    }
  }

  // Baseline pinning: resolve version at CREATE so the set anchors a
  // concrete immutable version (never "latest").
  let baseline: BaselineRef | null = null;
  if (args.baseline) {
    const version =
      args.baseline.version === undefined
        ? ((await ctx.store.getDoc({
            workspace: ctx.workspace,
            subject: args.baseline.subject,
            doc: assertDocKind(args.baseline.doc),
          }))?.version ?? null)
        : args.baseline.version;
    baseline = {
      subject: args.baseline.subject,
      doc: args.baseline.doc,
      version: version ?? null,
    };
  }

  const ts = nowIso(ctx);
  const changeset_id = await ctx.store.allocChangesetId(ctx.workspace);
  const row: ChangesetRow = {
    workspace: ctx.workspace,
    org: null,
    changeset_id,
    title:
      args.title ??
      (comment
        ? `Out-of-scope: ${comment.subject ?? comment.review_id}`
        : args.request.slice(0, 80)),
    request: args.request,
    baseline,
    classification: args.classification ?? null,
    status: 'draft',
    analysis: null,
    decision: null,
    decision_rationale: null,
    decided_by: null,
    decided_at: null,
    expires_on: null,
    emergency: args.emergency ?? false,
    retro_ref: null,
    reconciliation: null,
    created_by: args.createdBy ?? ctx.actor,
    created_at: ts,
    updated_at: ts,
  };
  await ctx.store.upsertChangeset(row);

  // Ordered apply list — seqs are caller-assignable ordinals.
  let seq = 0;
  for (const item of args.items ?? []) {
    await addChangesetItem(ctx, {
      changesetId: changeset_id,
      input: item,
      seq: seq++,
      _created: row,
    });
  }

  if (comment) {
    await ctx.store.upsertReviewComment({
      ...comment,
      changeset_id,
    });
  }

  await emit(
    ctx,
    row,
    'changeset_created',
    {
      classification: row.classification,
      emergency: row.emergency,
      baseline: row.baseline,
      ...(comment ? { review_comment_id: comment.comment_id } : {}),
    },
    {
      refs: [
        ...(comment ? [`comment:${comment.comment_id}`] : []),
        ...(baseline
          ? [
              `doc:${baseline.subject}:${baseline.doc}${baseline.version ? `:v${baseline.version}` : ''}`,
            ]
          : []),
      ],
      actorType: comment ? 'human' : 'runner',
    },
  );
  return (await ctx.store.getChangeset({
    workspace: ctx.workspace,
    changeset_id,
  })) as ChangesetRow;
}

// ---------------------------------------------------------------------------
// items (draft/analyzing/awaiting-decision mutation surface)
// ---------------------------------------------------------------------------

const ITEM_MUTABLE_STATUSES = new Set([
  'draft',
  'analyzing',
  'awaiting-decision',
]);

export async function addChangesetItem(
  ctx: ChangesCtx,
  args: {
    changesetId: string;
    input: ChangesetItemInput;
    seq?: number;
    /** Internal: skip state check inside createChangeset. */
    _created?: ChangesetRow;
  },
): Promise<ChangesetItemRow> {
  const cs = args._created ?? (await loadChangeset(ctx, args.changesetId));
  if (!ITEM_MUTABLE_STATUSES.has(cs.status)) {
    throw badState(
      `changeset ${cs.changeset_id} is '${cs.status}' — items change only in draft|analyzing|awaiting-decision`,
    );
  }
  const items = await ctx.store.listChangesetItems({
    workspace: ctx.workspace,
    changeset_id: cs.changeset_id,
  });
  const seq = args.seq ?? (items.at(-1)?.seq ?? -1) + 1;
  if (items.some((i) => i.seq === seq)) {
    throw conflict(
      `changeset ${cs.changeset_id} already has item seq ${seq}`,
    );
  }
  const row: ChangesetItemRow = {
    workspace: ctx.workspace,
    org: null,
    changeset_id: cs.changeset_id,
    seq,
    subject: args.input.subject,
    doc: args.input.doc ?? null,
    base_version: await resolveBaseVersion(ctx, args.input),
    proposed_version: null,
    change: args.input.change ?? null,
    status: 'pending',
    applied_at: null,
  };
  await ctx.store.upsertChangesetItem(row);
  return row;
}

// ---------------------------------------------------------------------------
// analyze — draft|analyzing → awaiting-decision (+ gate + notifications)
// ---------------------------------------------------------------------------

export async function analyzeChangeset(
  ctx: ChangesCtx,
  args: { changesetId: string; extras?: Record<string, unknown> },
): Promise<ChangesetRow> {
  const cs = await loadChangeset(ctx, args.changesetId);
  if (cs.status !== 'draft' && cs.status !== 'analyzing') {
    throw badState(
      `changeset ${cs.changeset_id} is '${cs.status}' — analyze runs from draft`,
    );
  }
  // `analyzing` is a real persisted step — a crash mid-analysis leaves
  // the set visibly in-flight, not half-drafted.
  await writeState(ctx, cs, { status: 'analyzing' });

  const items = await ctx.store.listChangesetItems({
    workspace: ctx.workspace,
    changeset_id: cs.changeset_id,
  });
  const analysis = await analyzeImpact(
    ctx.store,
    { ...cs, status: 'analyzing' },
    items,
    nowIso(ctx),
    args.extras ?? {},
  );

  const next = await writeState(
    ctx,
    cs,
    { status: 'awaiting-decision', analysis },
    'note_added',
    {
      kind: 'changeset-analyzed',
      affected: analysis.affected_subjects.length,
      releases: analysis.affected_releases.map((r) => r.release_id),
      conflicts: analysis.conflicts.map((c) => c.changeset_id),
    },
  );
  await surfaceDecisionGate(ctx, next);
  await notifyOwners(ctx, next, 'changeset:awaiting-decision', analysis);
  return next;
}

// ---------------------------------------------------------------------------
// decide — awaiting-decision → approved|deferred|rejected
// ---------------------------------------------------------------------------

export interface DecideConsequences {
  /** `swap-scope`: release items to remove — each stated consequence. */
  swap_out?: { release_id: string; item_kind: string; item_id: string }[];
  /** `next-release`: the deferred-to release (must exist + be open). */
  target_release?: string;
}

export interface DecideArgs {
  changesetId: string;
  decision: ChangesetDecision;
  /** Stated consequence — required for `decline` + `swap-scope`. */
  rationale?: string;
  decidedBy?: string;
  /** ISO timestamp — approval expiry (§15.5 safeguards). */
  expiresOn?: string;
  consequences?: DecideConsequences;
}

export async function decideChangeset(
  ctx: ChangesCtx,
  args: DecideArgs,
): Promise<ChangesetRow> {
  const cs = await loadChangeset(ctx, args.changesetId);
  const decidable = new Set<string>(['awaiting-decision']);
  if (cs.emergency) {
    // Expedited route — a human may decide before analysis completes.
    decidable.add('draft');
    decidable.add('analyzing');
  }
  if (!decidable.has(cs.status)) {
    throw badState(
      `changeset ${cs.changeset_id} is '${cs.status}' — decisions land on awaiting-decision${cs.emergency ? ' (emergency: draft|analyzing|awaiting-decision)' : ''}`,
    );
  }
  if (!(CHANGESET_DECISIONS as readonly string[]).includes(args.decision)) {
    throw invalid(`unknown decision '${args.decision}'`);
  }
  if (
    (args.decision === 'decline' || args.decision === 'swap-scope') &&
    !args.rationale?.trim()
  ) {
    throw invalid(
      `decision '${args.decision}' requires a stated consequence (rationale)`,
    );
  }
  let expiresOn: string | null = null;
  if (args.expiresOn !== undefined && args.expiresOn !== null) {
    const t = Date.parse(args.expiresOn);
    if (!Number.isFinite(t)) {
      throw invalid(`expiresOn '${args.expiresOn}' is not a valid timestamp`);
    }
    // Normalize to UTC ISO — expiry checks compare ISO strings
    // lexicographically; an offset-suffixed stamp would misorder.
    expiresOn = new Date(t).toISOString();
  }

  const ts = nowIso(ctx);
  const decidedBy = args.decidedBy ?? ctx.actor;
  const status = DECISION_TO_STATUS[args.decision];
  const consequences: Record<string, unknown> = {};

  // --- decision consequences land on affected releases (wp-134 link) ---
  if (args.decision === 'swap-scope') {
    const swapOut = args.consequences?.swap_out ?? [];
    if (swapOut.length === 0) {
      throw invalid(
        `swap-scope requires consequences.swap_out — the displaced release items`,
      );
    }
    const removed: DecideConsequences['swap_out'] = [];
    for (const s of swapOut) {
      const rel = await ctx.store.getRelease({
        workspace: ctx.workspace,
        release_id: s.release_id,
      });
      if (!rel) throw notFound(`swap-scope: unknown release '${s.release_id}'`);
      const items = await ctx.store.listReleaseItems({
        workspace: ctx.workspace,
        release_id: s.release_id,
      });
      const item = items.find(
        (i) => i.item_kind === s.item_kind && i.item_id === s.item_id,
      );
      if (!item) {
        throw notFound(
          `swap-scope: release ${s.release_id} has no ${s.item_kind} ${s.item_id}`,
        );
      }
      await ctx.store.removeReleaseItem(
        {
          workspace: ctx.workspace,
          release_id: s.release_id,
          item_kind: s.item_kind,
          item_id: s.item_id,
        },
        ts,
      );
      removed.push(s);
      await emit(ctx, cs, 'release_items_changed', {
        release_id: s.release_id,
        removed: [`${s.item_kind}:${s.item_id}`],
        consequence_of: args.decision,
      });
    }
    consequences.swap_out = removed;
  }
  if (args.decision === 'next-release') {
    const target = args.consequences?.target_release;
    if (target) {
      const rel = await ctx.store.getRelease({
        workspace: ctx.workspace,
        release_id: target,
      });
      if (!rel) throw notFound(`next-release: unknown release '${target}'`);
      if (rel.status === 'released' || rel.status === 'closed' || rel.status === 'abandoned') {
        throw badState(
          `next-release: release ${target} is '${rel.status}' — not a live target`,
        );
      }
      consequences.target_release = target;
    }
  }

  const reconciliation = {
    ...(cs.reconciliation ?? {}),
    consequence: {
      decision: args.decision,
      ...consequences,
      decided_at: ts,
    },
  };

  const next = await writeState(
    ctx,
    cs,
    {
      status,
      decision: args.decision,
      decision_rationale: args.rationale ?? null,
      decided_by: decidedBy,
      decided_at: ts,
      expires_on: expiresOn,
      reconciliation,
    },
    'changeset_decided',
    {
      decision: args.decision,
      decided_by: decidedBy,
      emergency: cs.emergency,
      consequences,
      expires_on: expiresOn,
    },
  );
  await clearDecisionGate(ctx, cs);
  const analysis = (cs.analysis ?? null) as ChangesetAnalysis | null;
  await notifyOwners(ctx, next, 'changeset:decided', analysis);
  return next;
}

// ---------------------------------------------------------------------------
// apply — approved → applying → (all landed | apply-failed)
// ---------------------------------------------------------------------------

/** Apply ordering per baseline/docs — conflicting sets serialize FIFO;
 *  an in-flight or failed apply of a sibling set blocks this one. */
async function assertApplySerialized(
  ctx: ChangesCtx,
  cs: ChangesetRow,
): Promise<void> {
  const items = await ctx.store.listChangesetItems({
    workspace: ctx.workspace,
    changeset_id: cs.changeset_id,
  });
  const footprint = itemFootprint(cs, items);
  for (const other of await ctx.store.listChangesets({
    workspace: ctx.workspace,
  })) {
    if (other.changeset_id === cs.changeset_id) continue;
    if (!OPEN_CHANGESET_STATUSES.has(other.status ?? '')) continue;
    const otherItems = await ctx.store.listChangesetItems({
      workspace: other.workspace,
      changeset_id: other.changeset_id,
    });
    const overlaps =
      [...itemFootprint(other, otherItems)].some((p) => footprint.has(p)) ||
      (!!cs.baseline &&
        !!other.baseline &&
        cs.baseline.subject === other.baseline.subject);
    if (!overlaps) continue;
    if (other.status === 'applying' || other.status === 'apply-failed') {
      throw conflict(
        `changeset ${other.changeset_id} is '${other.status}' on the same baseline — resolve it first (serialized apply)`,
      );
    }
    if (
      other.status === 'approved' &&
      (other.created_at ?? '') <= (cs.created_at ?? '')
    ) {
      throw conflict(
        `changeset ${other.changeset_id} was approved earlier on the same baseline — it applies first (serialized FIFO)`,
      );
    }
  }
}

interface ApplyOutcome {
  applied: { seq: number; subject: string; doc: string | null; version: number | null }[];
  skipped: { seq: number; reason: string }[];
  failed: { seq: number; reason: string }[];
  spec_hash: Record<string, { from: string | null; to: string }>;
}

export async function applyChangeset(
  ctx: ChangesCtx,
  args: { changesetId: string },
): Promise<ChangesetRow> {
  let cs = await loadChangeset(ctx, args.changesetId);
  if (!['approved', 'applying', 'apply-failed'].includes(cs.status)) {
    throw badState(
      `changeset ${cs.changeset_id} is '${cs.status}' — apply runs from approved`,
    );
  }

  // Approval expiry — fail-closed: an expired approval revalidates
  // rather than applying against a stale mandate.
  if (cs.expires_on && cs.expires_on <= nowIso(ctx)) {
    cs = await writeState(
      ctx,
      cs,
      {
        status: 'awaiting-decision',
        decided_at: null,
      },
      'note_added',
      { kind: 'changeset-approval-expired', expires_on: cs.expires_on },
    );
    await surfaceDecisionGate(ctx, cs);
    await notifyOwners(
      ctx,
      cs,
      'changeset:expired',
      (cs.analysis as ChangesetAnalysis | null) ?? null,
    );
    return cs;
  }

  await assertApplySerialized(ctx, cs);
  await writeState(ctx, cs, { status: 'applying' });

  const ts = nowIso(ctx);
  try {
    const outcome = await ctx.store.transaction(
      async (store): Promise<ApplyOutcome> => {
        const txCtx = { ...ctx, store };
        const items = await store.listChangesetItems({
          workspace: ctx.workspace,
          changeset_id: cs.changeset_id,
        });
        const out: ApplyOutcome = {
          applied: [],
          skipped: [],
          failed: [],
          spec_hash: {},
        };
        const specHashSubjects = new Set<string>();

        for (const item of items) {
          if (item.status !== 'pending') continue; // applied/skipped stick
          if (item.doc) {
            const doc = assertDocKind(item.doc);
            const head = await store.getDoc({
              workspace: ctx.workspace,
              subject: item.subject,
              doc,
            });
            // Base drift — the pinned base version moved under the
            // approved proposal (upstream change lands only what it
            // invalidates, §15.5).
            const headVersion = head?.version ?? 0;
            const baseVersion = item.base_version ?? 0;
            if (headVersion !== baseVersion) {
              const next = {
                ...item,
                status: 'failed' as const,
                change: {
                  ...(item.change ?? {}),
                  fail_reason: `base drift: pinned v${baseVersion} ≠ head v${headVersion}`,
                },
              };
              await store.upsertChangesetItem(next);
              out.failed.push({
                seq: item.seq,
                reason: `base drift (v${baseVersion} → v${headVersion})`,
              });
              continue;
            }
            const content = item.change?.content;
            if (typeof content !== 'string') {
              const next = { ...item, status: 'skipped' as const };
              await store.upsertChangesetItem(next);
              out.skipped.push({
                seq: item.seq,
                reason: 'no doc content proposal in change.content',
              });
              continue;
            }
            // The diff lands as a new immutable doc_version — baselines
            // never mutate in place.
            const v = await store.appendDocVersion(
              {
                workspace: ctx.workspace,
                subject: item.subject,
                doc,
              },
              content,
              txCtx.actor,
            );
            await store.upsertChangesetItem({
              ...item,
              proposed_version: v.version,
              status: 'applied',
              applied_at: ts,
            });
            out.applied.push({
              seq: item.seq,
              subject: item.subject,
              doc: item.doc,
              version: v.version,
            });
            if (SPEC_INPUT_DOCS.has(doc)) specHashSubjects.add(item.subject);
          } else {
            // Non-doc-addressable artifact — recorded as acknowledged
            // (affected-entity rows/releases handle their own state).
            await store.upsertChangesetItem({ ...item, status: 'skipped' });
            out.skipped.push({
              seq: item.seq,
              reason: 'non-doc artifact — recorded, nothing to append',
            });
          }
        }

        // spec_hash updates — the ratified change re-baselines spec
        // inputs so queued tickets implement the approved spec (mid-run
        // pins are wp-141's runs.request.baseline).
        for (const subject of specHashSubjects) {
          const ticket = await store.getTicket({
            workspace: ctx.workspace,
            ticket_id: subject,
          });
          if (!ticket) continue;
          const to = await specInputsHash(
            { workspace: ctx.workspace, rootPath: '', store, actor: txCtx.actor, now: ctx.now },
            subject,
          );
          if (to !== ticket.spec_hash) {
            await store.upsertTicket({
              ...ticket,
              spec_hash: to,
              updated_at: ts,
            });
            out.spec_hash[subject] = { from: ticket.spec_hash ?? null, to };
          }
        }

        return out;
      },
    );

    const failed = outcome.failed.length > 0;
    const reconciliation = {
      ...(cs.reconciliation ?? {}),
      applied_at: ts,
      applied: outcome.applied,
      skipped: outcome.skipped,
      failed: outcome.failed,
      spec_hash: outcome.spec_hash,
    };
    const next = await writeState(
      ctx,
      cs,
      {
        status: failed ? 'apply-failed' : 'applying',
        reconciliation,
      },
      'changeset_applied',
      {
        applied: outcome.applied.map((a) => a.seq),
        skipped: outcome.skipped.map((s) => s.seq),
        failed: outcome.failed.map((f) => f.seq),
      },
    );

    // Material upstream change → expire open approvals over the same
    // baseline/docs (revalidate only what's invalidated).
    if (outcome.applied.length > 0) {
      await invalidateConflictingApprovals(ctx, next, ts);
    }
    await notifyOwners(
      ctx,
      next,
      failed ? 'changeset:apply-failed' : 'changeset:applied',
      (next.analysis as ChangesetAnalysis | null) ?? null,
      { failed: outcome.failed },
    );
    return next;
  } catch (e) {
    // Exceptional apply — the tx rolled back; keep partial application
    // visible (status + event, never silent).
    if (e instanceof ChangesetError) throw e;
    await writeState(
      ctx,
      cs,
      {
        status: 'apply-failed',
        reconciliation: {
          ...(cs.reconciliation ?? {}),
          error: (e as Error).message,
          failed_at: ts,
        },
      },
      'note_added',
      { kind: 'changeset-apply-error', error: (e as Error).message },
    );
    throw new ChangesetError(
      'conflict',
      `changeset ${cs.changeset_id} apply failed: ${(e as Error).message} (set is apply-failed — partial state on changeset_items)`,
    );
  }
}

/** Expire `approved` sibling sets that overlap what this set just
 *  applied — their mandate predates a material upstream change. */
async function invalidateConflictingApprovals(
  ctx: ChangesCtx,
  cs: ChangesetRow,
  at: string,
): Promise<void> {
  const conflicts = await detectConflicts(ctx.store, cs);
  for (const c of conflicts) {
    if (c.status !== 'approved') continue;
    const other = await ctx.store.getChangeset({
      workspace: ctx.workspace,
      changeset_id: c.changeset_id,
    });
    if (!other) continue;
    const next = await writeState(
      ctx,
      other,
      {
        status: 'awaiting-decision',
        expires_on: at,
        decided_at: null,
      },
      'note_added',
      {
        kind: 'changeset-approval-invalidated',
        by: cs.changeset_id,
        overlap: c.overlap,
      },
    );
    await surfaceDecisionGate(ctx, next);
    await notifyOwners(
      ctx,
      next,
      'changeset:invalidated',
      (next.analysis as ChangesetAnalysis | null) ?? null,
      { by: cs.changeset_id },
    );
  }
}

// ---------------------------------------------------------------------------
// verify — applying → verified (reconciliation of record)
// ---------------------------------------------------------------------------

export async function verifyChangeset(
  ctx: ChangesCtx,
  args: { changesetId: string },
): Promise<ChangesetRow> {
  const cs = await loadChangeset(ctx, args.changesetId);
  if (cs.status !== 'applying') {
    throw badState(
      `changeset ${cs.changeset_id} is '${cs.status}' — verify runs from applying`,
    );
  }
  if (cs.emergency && !cs.retro_ref) {
    throw badState(
      `emergency changeset ${cs.changeset_id} has no retro doc — attach one (attachRetro) before verify (mandatory, §15.5)`,
    );
  }

  const items = await ctx.store.listChangesetItems({
    workspace: ctx.workspace,
    changeset_id: cs.changeset_id,
  });
  const pending = items.filter((i) => i.status === 'pending' || i.status === 'failed');
  if (pending.length > 0) {
    throw badState(
      `changeset ${cs.changeset_id} has unresolved items (${pending.map((i) => `seq ${i.seq}:${i.status}`).join(', ')}) — rebase + re-decide`,
    );
  }

  // Post-apply drift audit — a head that moved past proposed_version
  // after apply means another change landed on top; record it, never
  // hide it.
  const drift: { seq: number; subject: string; doc: string; expected: number; head: number }[] = [];
  for (const item of items) {
    if (item.status !== 'applied' || !item.doc || !item.proposed_version) continue;
    const head = await ctx.store.getDoc({
      workspace: ctx.workspace,
      subject: item.subject,
      doc: item.doc as DocKind,
    });
    if (head && head.version !== item.proposed_version) {
      drift.push({
        seq: item.seq,
        subject: item.subject,
        doc: item.doc,
        expected: item.proposed_version,
        head: head.version,
      });
    }
  }

  const ts = nowIso(ctx);
  const reconciliation = {
    ...(cs.reconciliation ?? {}),
    verified_at: ts,
    post_apply_drift: drift,
    item_rollup: {
      applied: items.filter((i) => i.status === 'applied').length,
      skipped: items.filter((i) => i.status === 'skipped').length,
      failed: items.filter((i) => i.status === 'failed').length,
    },
  };
  const next = await writeState(
    ctx,
    cs,
    { status: 'verified', reconciliation },
    'changeset_verified',
    {
      post_apply_drift: drift.length,
      releases: (
        (cs.analysis as ChangesetAnalysis | null)?.affected_releases ?? []
      ).map((r) => r.release_id),
    },
  );
  await notifyOwners(
    ctx,
    next,
    'changeset:verified',
    (next.analysis as ChangesetAnalysis | null) ?? null,
  );
  return next;
}

// ---------------------------------------------------------------------------
// retro — emergency route's mandatory documentation
// ---------------------------------------------------------------------------

export async function attachRetro(
  ctx: ChangesCtx,
  args: { changesetId: string; content: string },
): Promise<ChangesetRow> {
  const cs = await loadChangeset(ctx, args.changesetId);
  if (TERMINAL.has(cs.status)) {
    throw badState(
      `changeset ${cs.changeset_id} is '${cs.status}' — retro lands before verify`,
    );
  }
  if (!args.content?.trim()) {
    throw invalid('retro content is required (mandatory retro note)');
  }
  // The retro note is a doc_version on the changeset's own subject —
  // content lives in doc_versions like every durable doc (DELIVERY §3).
  const v = await ctx.store.appendDocVersion(
    { workspace: ctx.workspace, subject: cs.changeset_id, doc: 'retro.md' },
    args.content,
    ctx.actor,
  );
  const retro_ref = `doc:${cs.changeset_id}:retro.md:v${v.version}`;
  return writeState(ctx, cs, { retro_ref }, 'note_added', {
    kind: 'changeset-retro',
    retro_ref,
  });
}

// ---------------------------------------------------------------------------
// rebase — apply-failed recovery: re-pin drifted items → re-decision
// ---------------------------------------------------------------------------

export async function rebaseChangesetItem(
  ctx: ChangesCtx,
  args: {
    changesetId: string;
    seq: number;
    /** Replacement proposal against the new base (else content kept). */
    change?: Record<string, unknown>;
  },
): Promise<ChangesetItemRow> {
  const cs = await loadChangeset(ctx, args.changesetId);
  if (cs.status !== 'apply-failed' && cs.status !== 'awaiting-decision') {
    throw badState(
      `changeset ${cs.changeset_id} is '${cs.status}' — rebase runs on apply-failed`,
    );
  }
  const items = await ctx.store.listChangesetItems({
    workspace: ctx.workspace,
    changeset_id: cs.changeset_id,
  });
  const item = items.find((i) => i.seq === args.seq);
  if (!item) throw notFound(`changeset ${cs.changeset_id} has no item seq ${args.seq}`);
  if (item.status !== 'failed' && cs.status === 'apply-failed') {
    throw badState(`item seq ${args.seq} is '${item.status}' — only failed items rebase`);
  }
  const head = item.doc
    ? await ctx.store.getDoc({
        workspace: ctx.workspace,
        subject: item.subject,
        doc: item.doc as DocKind,
      })
    : null;
  const next: ChangesetItemRow = {
    ...item,
    base_version: head?.version ?? null,
    change: args.change ?? item.change,
    status: 'pending',
    applied_at: null,
  };
  await ctx.store.upsertChangesetItem(next);

  // A rebase invalidates the original decision — the set returns to
  // awaiting-decision; only the drifted items get re-pinned.
  if (cs.status === 'apply-failed') {
    const remaining = (await ctx.store.listChangesetItems({
      workspace: ctx.workspace,
      changeset_id: cs.changeset_id,
    })).filter((i) => i.status === 'failed');
    if (remaining.length === 0) {
      const upd = await writeState(
        ctx,
        cs,
        { status: 'awaiting-decision', decided_at: null },
        'note_added',
        { kind: 'changeset-rebased' },
      );
      await surfaceDecisionGate(ctx, upd);
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// abandon / reopen — retirement + deferred-ideas-never-die (§15.3)
// ---------------------------------------------------------------------------

export async function abandonChangeset(
  ctx: ChangesCtx,
  args: { changesetId: string },
): Promise<ChangesetRow> {
  const cs = await loadChangeset(ctx, args.changesetId);
  if (cs.status === 'applying') {
    throw badState(`changeset ${cs.changeset_id} is applying — cannot abandon mid-apply`);
  }
  if (cs.status === 'verified' || cs.status === 'abandoned') {
    throw badState(`changeset ${cs.changeset_id} is already '${cs.status}'`);
  }
  const next = await writeState(ctx, cs, { status: 'abandoned' }, 'note_added', {
    kind: 'changeset-abandoned',
  });
  await clearDecisionGate(ctx, cs);
  return next;
}

export async function reopenChangeset(
  ctx: ChangesCtx,
  args: { changesetId: string },
): Promise<ChangesetRow> {
  const cs = await loadChangeset(ctx, args.changesetId);
  if (!['deferred', 'rejected', 'abandoned'].includes(cs.status)) {
    throw badState(
      `changeset ${cs.changeset_id} is '${cs.status}' — reopen runs on deferred|rejected|abandoned`,
    );
  }
  // Deferred work never dies — reopening returns to draft with the
  // analysis preserved (evidence is kept; the decision is re-taken).
  const next = await writeState(
    ctx,
    cs,
    {
      status: 'draft',
      decision: null,
      decision_rationale: null,
      decided_by: null,
      decided_at: null,
      expires_on: null,
    },
    'note_added',
    { kind: 'changeset-reopened', from: cs.status },
  );
  return next;
}

// ---------------------------------------------------------------------------
// sweep — approval expiry (conductor tick; "material upstream change"
// invalidation happens inline at apply time)
// ---------------------------------------------------------------------------

export interface ChangesetSweepReport {
  expired: string[];
}

/** Approved sets past `expires_on` park back at awaiting-decision +
 *  re-surface the decision gate. Runs every conductor tick — cheap
 *  (list + filter). */
export async function sweepChangesetExpiry(
  ctx: ChangesCtx,
): Promise<ChangesetSweepReport> {
  const report: ChangesetSweepReport = { expired: [] };
  const now = nowIso(ctx);
  for (const cs of await ctx.store.listChangesets({
    workspace: ctx.workspace,
    status: 'approved',
  })) {
    if (!cs.expires_on || cs.expires_on > now) continue;
    const next = await writeState(
      ctx,
      cs,
      { status: 'awaiting-decision', decided_at: null },
      'note_added',
      { kind: 'changeset-approval-expired', expires_on: cs.expires_on },
    );
    await surfaceDecisionGate(ctx, next);
    await notifyOwners(
      ctx,
      next,
      'changeset:expired',
      (cs.analysis as ChangesetAnalysis | null) ?? null,
    );
    report.expired.push(cs.changeset_id);
  }
  return report;
}
