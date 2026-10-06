/**
 * reconcile/baseline.ts — mid-run baseline reconciliation (PRD §15.5,
 * wp-141).
 *
 * A run works against the spec baseline pinned at launch
 * (`runs.request.baseline`, launch/baseline.ts). If a doc version moves
 * past that pin while the run is live — a ChangeSet applied, the RS or
 * design revised, or the interface `contract.json` re-approved — the
 * running agent must NOT silently adopt the newer spec. Reconcile
 * detects the drift and:
 *
 *   - `continue`        — no drift; unaffected runs carry on.
 *   - `pause-reconcile` — small drift (design/ticket revision): pause at
 *                         the next checkpoint and reconcile context/ACs.
 *   - `stop-replan`     — substantial drift (requirements or the
 *                         approved interface contract moved): stop
 *                         further work, preserve the branch/worktree,
 *                         and re-plan (human decision via the gate).
 *
 * Either way the drift is SURFACED — a `baseline-drift` gate item for a
 * human and a `baseline_reconciled` event recording old → new versions —
 * never a silent re-baseline. Detection is idempotent per open gate.
 */
import type { EventName, RunBaseline, RunRow, Store } from '@veto/core';
import {
  CONTRACT_DOC,
  DESIGN_DOCS,
  RS_DOCS,
  TICKET_DOC,
  firstDocHead,
  pinnedBaselineOf,
} from '../launch/baseline.js';
import type { StreamEvent } from '../loop/deps.js';

/** Gate instance name surfaced while a run's baseline has drifted. */
export const BASELINE_DRIFT_GATE = 'baseline-drift';

/** Fields the pin records that can drift under a live run. */
export type BaselineField =
  | 'rs_version'
  | 'design_rev'
  | 'contract_ver'
  | 'ticket_rev';

/** Doc precedence per pinned field (must mirror launch/baseline.ts). */
export const FIELD_DOCS: Record<BaselineField, readonly string[]> = {
  rs_version: RS_DOCS,
  design_rev: DESIGN_DOCS,
  contract_ver: [CONTRACT_DOC],
  ticket_rev: [TICKET_DOC],
};

export interface BaselineDrift {
  field: BaselineField;
  /** The doc kind whose head moved (first of FIELD_DOCS). */
  doc: string;
  /** Version pinned at launch (null = doc absent then). */
  pinned: number | null;
  /** Current doc head (null = doc absent now). */
  head: number | null;
}

export type BaselineDecision = 'continue' | 'pause-reconcile' | 'stop-replan';

/** Context the reconcile + ChangeSet fan-out share — the narrow slice of
 *  ConductorDeps this module needs (so `changes/**` can call it too). */
export interface BaselineReconcileCtx {
  store: Store;
  workspace: string;
  actor: string;
  now: () => Date;
  notify?: ((event: StreamEvent) => void) | undefined;
}

const nowIso = (ctx: BaselineReconcileCtx) => ctx.now().toISOString();

/** Frontmatter keys that churn without being a spec change. */
const CHURN_KEY_RE = /^\s*(status|blocked_reason)\s*:/m;
const CHURN_LINE_RE = /^\s*(status|blocked_reason)\s*:.*$/gm;

function normalizeChurn(content: string): string {
  return CHURN_KEY_RE.test(content)
    ? content.replace(CHURN_LINE_RE, '')
    : content;
}

/**
 * `ticket.md` is rewritten on every status change (applyTicketStatus) —
 * that is not spec drift. Only a genuine body/AC change counts, so
 * compare the pinned vs head content with status lines normalized out.
 * A doc that can't be fetched is treated as drifted (fail-open to the
 * gate, never silent).
 */
async function ticketBodyChanged(
  args: { store: Store; workspace: string; subject: string },
  pinnedVersion: number | null,
  headVersion: number | null,
): Promise<boolean> {
  if (pinnedVersion === null || headVersion === null) return true;
  const [pinned, head] = await Promise.all([
    args.store.getDocVersion(
      { workspace: args.workspace, subject: args.subject, doc: TICKET_DOC },
      pinnedVersion,
    ),
    args.store.getDocVersion(
      { workspace: args.workspace, subject: args.subject, doc: TICKET_DOC },
      headVersion,
    ),
  ]);
  if (!pinned || !head) return true;
  return normalizeChurn(pinned.content) !== normalizeChurn(head.content);
}

/**
 * Compare the pinned baseline against current doc heads. Returns one
 * drift descriptor per moved field (empty = no drift).
 *
 * Cheap by construction: only fields that were actually PINNED are
 * checked, and a run with no spec doc pinned at all (triage/probe — the
 * spec doesn't exist yet) short-circuits with zero reads. A run's
 * pinned set never includes a doc that was absent at launch, so there
 * is nothing for it to "move past". `ticket_rev` ignores pure
 * frontmatter status churn.
 */
export async function detectBaselineDrift(args: {
  store: Store;
  workspace: string;
  subject: string;
  pinned: RunBaseline;
}): Promise<BaselineDrift[]> {
  const { store, workspace, subject, pinned } = args;
  // No spec pinned (rs/design/contract all absent) → nothing to drift.
  if (
    pinned.rs_version == null &&
    pinned.design_rev == null &&
    pinned.contract_ver == null
  ) {
    return [];
  }
  const out: BaselineDrift[] = [];
  for (const field of [
    'rs_version',
    'design_rev',
    'contract_ver',
    'ticket_rev',
  ] as const) {
    const pinnedV = pinned[field] ?? null;
    if (pinnedV === null) continue; // nothing pinned → nothing moved past
    const docs = FIELD_DOCS[field];
    const head = await firstDocHead(store, workspace, subject, docs);
    if (head === pinnedV) continue;
    if (field === 'ticket_rev') {
      const changed = await ticketBodyChanged(
        { store, workspace, subject },
        pinnedV,
        head,
      );
      if (!changed) continue;
    }
    out.push({ field, doc: docs[0] as string, pinned: pinnedV, head });
  }
  return out;
}

/**
 * The 3-way policy for one run. Requirements (`rs.md`) or the approved
 * interface contract (`contract.json`) moving under a running agent is
 * substantial → stop and re-plan. A design/ticket revision is small →
 * pause at the next checkpoint and reconcile context/ACs. Multi-ticket
 * ChangeSets reconcile as one coordinated set — the caller fans this
 * out per affected run and a single decision is taken per run.
 */
export function classifyBaselineDrift(
  drift: BaselineDrift[],
): BaselineDecision {
  if (drift.length === 0) return 'continue';
  const substantial = drift.some(
    (d) => d.field === 'rs_version' || d.field === 'contract_ver',
  );
  return substantial ? 'stop-replan' : 'pause-reconcile';
}

/** Surface the drift: gate item + notification + `baseline_reconciled`
 *  event. The gate blocks agent progress for `stop-replan`. */
async function surfaceBaselineDrift(
  ctx: BaselineReconcileCtx,
  run: RunRow,
  subject: string,
  pinned: RunBaseline,
  drift: BaselineDrift[],
  decision: BaselineDecision,
): Promise<void> {
  const ts = nowIso(ctx);
  const stop = decision === 'stop-replan';
  const gate = {
    workspace: ctx.workspace,
    subject,
    gate: BASELINE_DRIFT_GATE,
    kind: 'approval' as const,
    surfaced_at: ts,
    cleared_at: null,
    blocked_agent: stop,
    priority: stop ? ('high' as const) : null,
  };
  await ctx.store.upsertGateItem(gate);
  ctx.notify?.({ type: 'gate_surfaced', payload: gate });
  await ctx.store.insertNotification({
    workspace: ctx.workspace,
    subject,
    kind: `gate:${BASELINE_DRIFT_GATE}`,
    payload: JSON.stringify({
      gate: BASELINE_DRIFT_GATE,
      run: run.id,
      decision,
      drift,
    }),
    created_at: ts,
    read_at: null,
  });
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: run.ticket_id,
    ts,
    stage: run.stage,
    actor_type: 'runner',
    actor_id: ctx.actor,
    event: 'baseline_reconciled' satisfies EventName,
    run: run.id,
    refs: drift.map((d) => `doc:${subject}:${d.doc}`),
    data: {
      decision,
      drift,
      pinned,
      // "never silently adopt the newer spec" — the pinned set is kept
      // verbatim; only the drift is reported.
      pinned_kept: true,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
}

export interface BaselineReconcileResult {
  decision: BaselineDecision;
  drift: BaselineDrift[];
  /** True when a gate/event was (re-)surfaced this pass. */
  surfaced: boolean;
}

/**
 * Reconcile ONE run's baseline: detect drift, classify, and surface.
 * Idempotent — while the `baseline-drift` gate is open the drift is
 * already on the human's plate, so nothing is re-emitted.
 */
export async function reconcileRunBaseline(
  ctx: BaselineReconcileCtx,
  run: RunRow,
): Promise<BaselineReconcileResult> {
  const pinned = pinnedBaselineOf(run);
  if (!pinned) return { decision: 'continue', drift: [], surfaced: false };
  const subject = run.ticket_id ?? run.subject;
  const drift = await detectBaselineDrift({
    store: ctx.store,
    workspace: ctx.workspace,
    subject,
    pinned,
  });
  const decision = classifyBaselineDrift(drift);
  if (drift.length === 0) return { decision, drift, surfaced: false };

  const key = {
    workspace: ctx.workspace,
    subject,
    gate: BASELINE_DRIFT_GATE,
  };
  const existing = await ctx.store.getGateItem(key);
  if (existing && !existing.cleared_at)
    return { decision, drift, surfaced: false };

  await surfaceBaselineDrift(ctx, run, subject, pinned, drift, decision);
  return { decision, drift, surfaced: true };
}

/**
 * ChangeSet → affected-run fan-out (PRD §15.5): after a set applies on
 * a subject, reconcile every live run whose pinned baseline covers that
 * subject. Unaffected runs are untouched; each affected run gets its
 * own classification (one coordinated set, per-run effects).
 */
export async function reconcileAffectedRuns(
  ctx: BaselineReconcileCtx,
  affectedSubjects: Iterable<string>,
): Promise<Map<string, BaselineDecision>> {
  const subjects = new Set(affectedSubjects);
  const out = new Map<string, BaselineDecision>();
  if (subjects.size === 0) return out;
  const live = await ctx.store.listLiveRuns();
  for (const run of live) {
    if (run.workspace !== ctx.workspace) continue;
    const subject = run.ticket_id ?? run.subject;
    if (!subjects.has(subject)) continue;
    const res = await reconcileRunBaseline(ctx, run);
    if (res.decision !== 'continue') out.set(run.id, res.decision);
  }
  return out;
}
