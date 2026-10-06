/**
 * changes/radar.ts — the Scope Creep Radar (PRD §15.5, wp-142).
 *
 * A computed metrics surface, NOT a score — every number here is
 * traceable to rows/events the caller can inspect:
 *
 *   - scope added vs removed per RELEASE: live `release_items`
 *     (removed_at = null) diffed against the FIRST manifest cut
 *     (`release_manifests` v1 — the frozen baseline). Manifest recuts
 *     (`version` count) are reported as scope churn.
 *   - scope added vs removed per BASELINE SUBJECT: changeset items on
 *     sets classified `addition` / `removal` (modification/clarification
 *     /correction counted separately — categories are handled
 *     differently per §15.5).
 *   - post-approval changes: changesets pinned to a baseline subject
 *     whose doc had a `doc_approved` event BEFORE the set was created —
 *     scope touched after it was ratified.
 *   - rework events: `status_changed → changes-requested` loops and
 *     `fix_round_started` rows on affected tickets, plus changeset
 *     approval invalidation/expiry notes on the subject's sets.
 *   - affected running executions: live runs (the same status set
 *     `listLiveRuns` reconciles) whose subject sits in the blast
 *     radius.
 *   - estimate/spec drift vs baseline: for each pinned baseline doc the
 *     version delta `head − baseline.version` (spec text moved N
 *     versions past the pin). The contract has no machine-readable
 *     estimate field yet — versioned-doc drift is the honest proxy and
 *     `delivery_commitments` (wp-153) will supply real estimate deltas.
 *   - schedule drift: age of the oldest pinned baseline in days.
 *   - cost: Σ `events.cost_usd` over affected tickets (null when the
 *     subject isn't a ticket / nothing recorded).
 *
 * Budgets (config `scope_budgets:`) — any configured threshold crossed
 * escalates the ChangeSet: a `scope-budget` escalation gate item on
 * the changeset subject + an `escalated` event + owner-scoped
 * notifications. While that gate is open the engine refuses approving
 * decisions and apply — clearing it IS the higher approval
 * (fail-closed: a breached set can never sail through unattended).
 */
import type { ChangesetRow, ScopeBudgets, Store } from '@sprint-runner/core';
import type { StreamEvent } from '../loop/deps.js';
import { OPEN_CHANGESET_STATUSES } from './analysis.js';
import type { ChangesetAnalysis } from './analysis.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Gate instance name for budget-breach escalations (higher approval). */
export const SCOPE_BUDGET_GATE = 'scope-budget';

/** Live run statuses — mirrors `listLiveRuns` (reconcile set). */
const LIVE_RUN_STATUSES = new Set([
  'pending',
  'leased',
  'running',
  'paused',
  'exited',
]);

export interface RadarBreach {
  metric:
    | 'cost_usd'
    | 'schedule_days'
    | 'scope_pct'
    | 'post_approval_changes'
    | 'rework_events'
    | 'affected_executions';
  threshold: number;
  observed: number;
}

export interface ChangesetVolume {
  total: number;
  open: number;
  post_approval: number;
  by_classification: Record<string, number>;
  changeset_ids: string[];
}

export interface SubjectRadar {
  subject: string;
  /** Per-doc drift: pinned baseline version → current head. */
  drift: { doc: string; baseline: number | null; head: number | null }[];
  /** Cumulative spec/estimate drift — Σ (head − baseline) over pins. */
  drift_total: number;
  changesets: ChangesetVolume;
  /** Changeset items by parent classification (scope Δ counts). */
  items: { added: number; removed: number; other: number; total: number };
  rework: {
    changes_requested: number;
    fix_rounds: number;
    revalidations: number;
    total: number;
  };
  affected_executions: string[];
  cost_usd: number | null;
  /** Days since the oldest pinned baseline version was cut. */
  baseline_age_days: number | null;
}

export interface ReleaseRadar {
  release_id: string;
  status: string;
  /** v1 manifest = frozen baseline scope (null = never frozen). */
  baseline_items: number;
  live_items: number;
  scope_added: string[];
  scope_removed: string[];
  /** (added + removed) ÷ baseline_items — null when never frozen. */
  scope_change_pct: number | null;
  /** Manifest cuts — each re-cut after v1 is visible scope churn. */
  manifest_versions: number;
  /** Changesets whose analysis names this release. */
  changeset_ids: string[];
}

export interface ScopeRadarReport {
  workspace: string;
  computed_at: string;
  subjects: SubjectRadar[];
  releases: ReleaseRadar[];
  totals: {
    changesets: number;
    open_changesets: number;
    post_approval_changes: number;
    rework_events: number;
    affected_executions: number;
    cost_usd: number;
    scope_added: number;
    scope_removed: number;
  };
}

// ---------------------------------------------------------------------------
// Computation — pure reads, explainable
// ---------------------------------------------------------------------------

async function subjectRadar(
  store: Store,
  workspace: string,
  subject: string,
  changesets: ChangesetRow[],
  nowIso: string,
): Promise<SubjectRadar> {
  const sets = changesets.filter((c) => c.baseline?.subject === subject);

  // Drift + post-approval: compare each pin to the doc head, and each
  // set's created_at to the subject's doc_approved event timestamps.
  const approvals = new Set<string>();
  for (const e of await store.listEvents({
    workspace,
    ticket_id: subject,
    event: 'doc_approved',
  })) {
    const doc = (e.data as { doc?: string } | null)?.doc;
    approvals.add(`${e.ts}:${doc ?? ''}`);
  }
  const approvedAt = (doc: string | null | undefined): string[] =>
    [...approvals]
      .filter((k) => k.endsWith(`:${doc ?? ''}`))
      .map((k) => k.slice(0, k.indexOf(':')))
      .sort();

  // Drift is per (subject, doc) — the baseline's own movement, not the
  // sum over sets pinning it (ten sets on one pin ≠ ten drift). The
  // OLDEST pinned version per doc is the baseline that drifted.
  const pins = new Map<string, number>();
  let oldestBaselineAt: string | null = null;
  let postApproval = 0;
  const items = { added: 0, removed: 0, other: 0, total: 0 };
  const byClassification: Record<string, number> = {};

  for (const cs of sets) {
    byClassification[cs.classification ?? 'unclassified'] =
      (byClassification[cs.classification ?? 'unclassified'] ?? 0) + 1;
    const csItems = await store.listChangesetItems({
      workspace,
      changeset_id: cs.changeset_id,
    });
    for (const i of csItems) {
      items.total += 1;
      if (cs.classification === 'addition') items.added += 1;
      else if (cs.classification === 'removal') items.removed += 1;
      else items.other += 1;
    }
    const b = cs.baseline;
    if (b?.doc) {
      const prev = pins.get(b.doc);
      if (prev === undefined || (b.version ?? 0) < prev) {
        pins.set(b.doc, b.version ?? 0);
      }
      const pinned = b.version
        ? await store.getDocVersion(
            { workspace, subject, doc: b.doc },
            b.version,
          )
        : null;
      if (
        pinned?.created_at &&
        (oldestBaselineAt === null || pinned.created_at < oldestBaselineAt)
      ) {
        oldestBaselineAt = pinned.created_at;
      }
      // Post-approval: the pinned doc was approved before this set was
      // created — the change touches ratified scope.
      if (
        approvedAt(b.doc).some((at) => at <= (cs.created_at ?? '')) &&
        cs.created_at
      ) {
        postApproval += 1;
      }
    }
  }

  const drift: SubjectRadar['drift'] = [];
  let driftTotal = 0;
  for (const [doc, baseVersion] of [...pins.entries()].sort()) {
    const head = await store.getDoc({ workspace, subject, doc });
    const headVersion = head?.version ?? null;
    drift.push({
      doc,
      baseline: baseVersion > 0 ? baseVersion : null,
      head: headVersion,
    });
    if (baseVersion > 0 && headVersion != null) {
      driftTotal += Math.max(0, headVersion - baseVersion);
    }
  }

  // Rework on the subject when it is a ticket (changes-requested
  // loops + fix rounds) plus approval invalidation/expiry notes on
  // this subject's sets (re-review rounds forced by upstream change).
  let changesRequested = 0;
  let fixRounds = 0;
  for (const e of await store.listEvents({ workspace, ticket_id: subject })) {
    if (
      e.event === 'status_changed' &&
      (e.data as { to?: string } | null)?.to === 'changes-requested'
    ) {
      changesRequested += 1;
    }
    if (e.event === 'fix_round_started') fixRounds += 1;
  }
  let revalidations = 0;
  const setIds = new Set(sets.map((c) => c.changeset_id));
  for (const e of await store.listEvents({ workspace })) {
    if (e.event !== 'note_added') continue;
    const d = e.data as {
      changeset_id?: string;
      kind?: string;
    } | null;
    if (
      d?.changeset_id &&
      setIds.has(d.changeset_id) &&
      (d.kind === 'changeset-approval-invalidated' ||
        d.kind === 'changeset-approval-expired')
    ) {
      revalidations += 1;
    }
  }

  // Affected running executions: live runs on the subject itself and
  // on tickets the sets' analyses hit.
  const blast = new Set<string>([subject]);
  for (const cs of sets) {
    const a = cs.analysis as ChangesetAnalysis | null;
    for (const t of a?.affected_tickets ?? []) blast.add(t);
  }
  const affectedExecutions = (await store.listLiveRuns())
    .filter((r) => blast.has(r.subject))
    .map((r) => r.id)
    .sort();

  // Cost of the blast radius — explainable Σ over the events ledger.
  let cost: number | null = null;
  for (const s of blast) {
    for (const e of await store.listEvents({ workspace, ticket_id: s })) {
      if (e.cost_usd != null) cost = (cost ?? 0) + e.cost_usd;
    }
  }

  const baselineAgeDays = oldestBaselineAt
    ? Math.max(
        0,
        (Date.parse(nowIso) - Date.parse(oldestBaselineAt)) / 86_400_000,
      )
    : null;

  return {
    subject,
    drift,
    drift_total: driftTotal,
    changesets: {
      total: sets.length,
      open: sets.filter((c) => OPEN_CHANGESET_STATUSES.has(c.status)).length,
      post_approval: postApproval,
      by_classification: byClassification,
      changeset_ids: sets.map((c) => c.changeset_id).sort(),
    },
    items,
    rework: {
      changes_requested: changesRequested,
      fix_rounds: fixRounds,
      revalidations,
      total: changesRequested + fixRounds + revalidations,
    },
    affected_executions: affectedExecutions,
    cost_usd: cost,
    baseline_age_days: baselineAgeDays,
  };
}

async function releaseRadar(
  store: Store,
  workspace: string,
  releaseId: string,
  changesets: ChangesetRow[],
): Promise<ReleaseRadar> {
  const release = await store.getRelease({
    workspace,
    release_id: releaseId,
  });
  const manifests = await store.listReleaseManifests({
    workspace,
    release_id: releaseId,
  });
  const baseline = manifests.length > 0 ? manifests[0] : null;
  const baselineKeys = new Set(
    (baseline?.items ?? []).map((i) => `${i.item_kind}:${i.item_id}`),
  );
  const liveItems = (
    await store.listReleaseItems({ workspace, release_id: releaseId })
  ).filter((i) => i.removed_at == null);
  const liveKeys = new Set(liveItems.map((i) => `${i.item_kind}:${i.item_id}`));
  const added = [...liveKeys].filter((k) => !baselineKeys.has(k)).sort();
  const removed = [...baselineKeys].filter((k) => !liveKeys.has(k)).sort();
  const changesetIds = changesets
    .filter((c) =>
      ((c.analysis as ChangesetAnalysis | null)?.affected_releases ?? []).some(
        (r) => r.release_id === releaseId,
      ),
    )
    .map((c) => c.changeset_id)
    .sort();
  return {
    release_id: releaseId,
    status: release?.status ?? 'unknown',
    baseline_items: baselineKeys.size,
    live_items: liveKeys.size,
    scope_added: added,
    scope_removed: removed,
    scope_change_pct:
      baselineKeys.size > 0
        ? (added.length + removed.length) / baselineKeys.size
        : null,
    manifest_versions: manifests.length,
    changeset_ids: changesetIds,
  };
}

export interface ComputeRadarOpts {
  /** Restrict to one baseline subject (ChangeSet decision view). */
  subject?: string;
  /** Restrict to one release (Release Center header). */
  release?: string;
}

/**
 * Compute the radar for a workspace — per baseline subject and per
 * release, plus workspace totals. Pure reads; callers own any writes.
 */
export async function computeScopeRadar(
  store: Store,
  workspace: string,
  nowIso: string,
  opts: ComputeRadarOpts = {},
): Promise<ScopeRadarReport> {
  const changesets = await store.listChangesets({ workspace });
  const subjects = new Set<string>();
  for (const cs of changesets) {
    if (cs.baseline?.subject) subjects.add(cs.baseline.subject);
  }
  if (opts.subject) subjects.add(opts.subject);

  const subjectRadars: SubjectRadar[] = [];
  for (const s of [...subjects].sort()) {
    subjectRadars.push(
      await subjectRadar(store, workspace, s, changesets, nowIso),
    );
  }

  const releases = (await store.listReleases({ workspace })).filter(
    (r) => !opts.release || r.release_id === opts.release,
  );
  const releaseRadars: ReleaseRadar[] = [];
  for (const r of releases) {
    releaseRadars.push(
      await releaseRadar(store, workspace, r.release_id, changesets),
    );
  }

  const totals = {
    changesets: changesets.length,
    open_changesets: changesets.filter((c) =>
      OPEN_CHANGESET_STATUSES.has(c.status),
    ).length,
    post_approval_changes: subjectRadars.reduce(
      (n, s) => n + s.changesets.post_approval,
      0,
    ),
    rework_events: subjectRadars.reduce((n, s) => n + s.rework.total, 0),
    affected_executions: [
      ...new Set(subjectRadars.flatMap((s) => s.affected_executions)),
    ].length,
    cost_usd: subjectRadars.reduce((n, s) => n + (s.cost_usd ?? 0), 0),
    scope_added:
      subjectRadars.reduce((n, s) => n + s.items.added, 0) +
      releaseRadars.reduce((n, r) => n + r.scope_added.length, 0),
    scope_removed:
      subjectRadars.reduce((n, s) => n + s.items.removed, 0) +
      releaseRadars.reduce((n, r) => n + r.scope_removed.length, 0),
  };
  return {
    workspace,
    computed_at: nowIso,
    subjects: subjectRadars,
    releases: releaseRadars,
    totals,
  };
}

// ---------------------------------------------------------------------------
// Budgets → escalation (fail-closed, evented)
// ---------------------------------------------------------------------------

/** Observed values for one changeset's blast radius — the union of its
 *  baseline subject radar and its named releases. */
function changesetObserved(
  report: ScopeRadarReport,
  cs: ChangesetRow,
): Record<RadarBreach['metric'], number | null> {
  const sub = report.subjects.find((s) => s.subject === cs.baseline?.subject);
  const ids = new Set(
    ((cs.analysis as ChangesetAnalysis | null)?.affected_releases ?? []).map(
      (r) => r.release_id,
    ),
  );
  const releases = report.releases.filter((r) => ids.has(r.release_id));
  const scopePct =
    releases
      .map((r) => r.scope_change_pct)
      .filter((p): p is number => p != null)
      .reduce((a, b) => Math.max(a, b), 0) ||
    // No release scope? Fall back to the subject's own added+removed
    // over the affected-artifact count (blast radius vs touched scope).
    (sub && sub.changesets.total + sub.items.total > 0
      ? sub.items.added + sub.items.removed
      : null);
  return {
    cost_usd: sub?.cost_usd ?? null,
    schedule_days: sub?.baseline_age_days ?? null,
    scope_pct: scopePct,
    post_approval_changes: sub?.changesets.post_approval ?? 0,
    rework_events: sub?.rework.total ?? 0,
    affected_executions: sub?.affected_executions.length ?? 0,
  };
}

/** Compare observed metrics against configured budgets. Unset
 *  thresholds never fire; null observations never fire (no evidence →
 *  no breach claim — the radar reports, it doesn't invent). */
export function evaluateScopeBudgets(
  observed: Record<RadarBreach['metric'], number | null>,
  budgets: ScopeBudgets,
): RadarBreach[] {
  const breaches: RadarBreach[] = [];
  const check = (
    metric: RadarBreach['metric'],
    threshold: number | null | undefined,
  ) => {
    const observedValue = observed[metric];
    if (
      threshold != null &&
      observedValue != null &&
      observedValue > threshold
    ) {
      breaches.push({ metric, threshold, observed: observedValue });
    }
  };
  check('cost_usd', budgets.cost_usd);
  check('schedule_days', budgets.schedule_days);
  check('scope_pct', budgets.scope_pct);
  check('post_approval_changes', budgets.post_approval_changes);
  check('rework_events', budgets.rework_events);
  check('affected_executions', budgets.affected_executions);
  return breaches;
}

/** Is the changeset currently blocked by an open scope-budget gate? */
export async function scopeBudgetGateOpen(
  store: Store,
  workspace: string,
  changesetId: string,
): Promise<boolean> {
  const item = await store.getGateItem({
    workspace,
    subject: changesetId,
    gate: SCOPE_BUDGET_GATE,
  });
  return item != null && item.cleared_at == null;
}

interface EscalationCtx {
  workspace: string;
  store: Store;
  actor: string;
  now: () => Date;
  notify?: ((event: StreamEvent) => void) | undefined;
  scope_budgets?: ScopeBudgets | null;
}

/**
 * Compute the radar for `cs`'s blast radius and escalate on breach:
 * surfaces the `scope-budget` escalation gate (idempotent — an open
 * gate is not re-surfaced), emits the durable `escalated` event, and
 * notifies affected artifact owners. Returns the breach list.
 */
export async function enforceScopeBudgets(
  ctx: EscalationCtx,
  cs: ChangesetRow,
  notifyOwners: (
    cs: ChangesetRow,
    kind: string,
    extra?: Record<string, unknown>,
  ) => Promise<void>,
): Promise<RadarBreach[]> {
  const budgets = ctx.scope_budgets;
  if (!budgets) return [];
  const report = await computeScopeRadar(
    ctx.store,
    ctx.workspace,
    ctx.now().toISOString(),
    cs.baseline?.subject ? { subject: cs.baseline.subject } : {},
  );
  const breaches = evaluateScopeBudgets(changesetObserved(report, cs), budgets);
  if (breaches.length === 0) return [];

  const ts = ctx.now().toISOString();
  const existing = await ctx.store.getGateItem({
    workspace: ctx.workspace,
    subject: cs.changeset_id,
    gate: SCOPE_BUDGET_GATE,
  });
  // Idempotent: an open gate is not re-surfaced, and a CLEARED gate
  // stays cleared — clearing it was the higher approval (the human
  // saw the breach and accepted it). A fresh escalation requires a
  // new breach episode, i.e. a new changeset.
  if (!existing) {
    await ctx.store.upsertGateItem({
      workspace: ctx.workspace,
      subject: cs.changeset_id,
      gate: SCOPE_BUDGET_GATE,
      kind: 'escalation',
      surfaced_at: ts,
      cleared_at: null,
      blocked_agent: false,
      priority: 'high',
    });
    ctx.notify?.({
      type: 'gate_surfaced',
      payload: {
        workspace: ctx.workspace,
        subject: cs.changeset_id,
        gate: SCOPE_BUDGET_GATE,
        kind: 'escalation',
        breaches,
      },
    });
    // Durable audit row — the escalation is evented, never silent.
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: cs.baseline?.subject ?? null,
      ts,
      stage: null,
      actor_type: 'system',
      actor_id: ctx.actor,
      event: 'escalated',
      run: null,
      refs: [],
      data: {
        changeset_id: cs.changeset_id,
        gate: SCOPE_BUDGET_GATE,
        breaches,
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    ctx.notify?.({ type: 'changeset', payload: cs });
    await notifyOwners(cs, 'changeset:scope-budget-breach', { breaches });
  }
  return breaches;
}
