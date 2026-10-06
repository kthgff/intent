/**
 * release/delivery.ts — deployments, feature exposure, and KPI
 * outcomes (DELIVERY §3 tail + §1, wp-135).
 *
 * The delivery dimension (`planned → released → deployed → exposed`)
 * is materialized on `release_items` — wp-134 writes `released`, this
 * module writes `deployed`/`exposed`:
 *
 *   - `recordDeployment` is the MVP manual path: the evidence IS the
 *     confirmation (`evidence.by` attests it landed), so a valid row
 *     is inserted already-confirmed and `deployment_confirmed` fires.
 *     `evidence.type` must be `manual` — `webhook`/`probe` are reserved
 *     slots, not accepted inputs (fail-closed). `by`, `note`, and
 *     `url` are all required; an empty attestation proves nothing.
 *   - `setFeatureExposure` writes `feature_exposure`; `available`
 *     requires a linked deployment that EXISTS, is confirmed, targets
 *     the same environment, and belongs to a release carrying the
 *     feature (invariant 4 — every clause fails closed).
 *   - `recordReleaseOutcome` upserts KPI baseline/target/observed.
 */
import { randomUUID } from 'node:crypto';
import type {
  DeploymentEvidence,
  DeploymentRow,
  FeatureExposureRow,
  FeatureExposureState,
  ReleaseOutcomeRow,
  ReleaseRow,
} from '@veto/core';
import { resolveItemTickets } from './manifest.js';
import { type ReleaseCtx, ReleaseError } from './types.js';

/** Deployment/exposure are post-release facts — a release that hasn't
 *  shipped (or was abandoned) can't deploy. `closed` stays writable so
 *  evidence landing after closure still records. */
const DEPLOYABLE = new Set(['released', 'closed']);

async function requireRelease(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<ReleaseRow> {
  const release = await ctx.store.getRelease({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  if (!release) {
    throw new ReleaseError('not-found', `no release ${releaseId}`);
  }
  return release;
}

/** Is `featureId` part of the release's live scope — as a `feature`
 *  item or via a `ticket` item whose ticket rolls up to it? */
async function releaseContainsFeature(
  ctx: ReleaseCtx,
  releaseId: string,
  featureId: string,
): Promise<boolean> {
  const items = await ctx.store.listReleaseItems({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  for (const item of items) {
    if (item.item_kind === 'feature' && item.item_id === featureId) {
      return true;
    }
    if (item.item_kind === 'ticket') {
      const members = await resolveItemTickets(ctx, item);
      if (members.some((t) => t.feature === featureId)) return true;
    }
  }
  return false;
}

/** Materialize the delivery dimension: flip live items between
 *  `from` → `to` (never regresses a further-along state). */
async function materializeDeliveryState(
  ctx: ReleaseCtx,
  releaseId: string,
  to: 'deployed' | 'exposed',
  opts: {
    from: readonly string[];
    /** Restrict the flip to one feature's items (exposure is
     *  per-feature); undefined = every live item. */
    featureId?: string;
  },
): Promise<void> {
  const items = await ctx.store.listReleaseItems({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  const from = new Set(opts.from);
  for (const item of items) {
    if (!from.has(item.delivery_state)) continue;
    if (opts.featureId !== undefined) {
      const isFeature =
        item.item_kind === 'feature' && item.item_id === opts.featureId;
      const isMemberTicket =
        item.item_kind === 'ticket' &&
        (await resolveItemTickets(ctx, item)).some(
          (t) => t.feature === opts.featureId,
        );
      if (!isFeature && !isMemberTicket) continue;
    }
    await ctx.store.upsertReleaseItem({ ...item, delivery_state: to });
  }
}

// ---------------------------------------------------------------------------
// deployments (DELIVERY §3 — MVP manual evidence only, invariant 4)
// ---------------------------------------------------------------------------

/** Validate manual deployment evidence — fail-closed on every clause
 *  of "non-empty": `type` must be `manual` (webhook/probe are reserved
 *  for automated confirmation, not accepted MVP inputs), and `by`,
 *  `note`, `url` are all required. */
export function validateDeploymentEvidence(
  evidence: unknown,
): DeploymentEvidence {
  const ev = (evidence ?? {}) as Partial<DeploymentEvidence> &
    Record<string, unknown>;
  if (ev.type !== 'manual') {
    throw new ReleaseError(
      'invalid-evidence',
      `deployment evidence.type must be 'manual' for MVP (got ${JSON.stringify(ev.type ?? null)}) — webhook|probe are reserved`,
    );
  }
  const missing = (['by', 'note', 'url'] as const).filter(
    (k) => typeof ev[k] !== 'string' || (ev[k] as string).trim() === '',
  );
  if (missing.length > 0) {
    throw new ReleaseError(
      'invalid-evidence',
      `manual deployment evidence requires non-empty ${missing.join(', ')} (DELIVERY invariant 4)`,
    );
  }
  return {
    type: 'manual',
    by: ev.by as string,
    note: ev.note as string,
    url: ev.url as string,
  };
}

/**
 * Record a confirmed deployment of a release to an environment. The
 * manual evidence attests the deploy — `evidence.by` becomes
 * `confirmed_by` and the row lands already-confirmed in one atomic
 * write with `deployment_confirmed` + the `released → deployed`
 * delivery_state materialization.
 */
export async function recordDeployment(
  ctx: ReleaseCtx,
  releaseId: string,
  args: {
    environment: string;
    sha: string;
    evidence: unknown;
    deploymentId?: string;
  },
): Promise<DeploymentRow> {
  const release = await requireRelease(ctx, releaseId);
  if (!DEPLOYABLE.has(release.status)) {
    throw new ReleaseError(
      'bad-state',
      `deployment: release ${releaseId} is '${release.status}' — deployments attach to released|closed work (DELIVERY §1)`,
    );
  }
  if (!args.environment?.trim()) {
    throw new ReleaseError('bad-item', 'deployment environment is required');
  }
  if (!args.sha?.trim()) {
    throw new ReleaseError('bad-item', 'deployment sha is required');
  }
  const evidence = validateDeploymentEvidence(args.evidence);
  const ts = ctx.now().toISOString();
  const row: DeploymentRow = {
    workspace: ctx.workspace,
    deployment_id: args.deploymentId ?? `dep-${randomUUID().slice(0, 12)}`,
    release_id: releaseId,
    environment: args.environment,
    sha: args.sha,
    evidence,
    confirmed_by: evidence.by ?? null,
    confirmed_at: ts,
    created_at: ts,
  };
  const created = await ctx.store.transaction(async (store) => {
    const tx: ReleaseCtx = { ...ctx, store };
    if (!(await store.insertDeployment(row))) return false;
    await materializeDeliveryState(tx, releaseId, 'deployed', {
      from: ['released'],
    });
    await store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: releaseId,
      ts,
      stage: null,
      actor_type: 'human',
      actor_id: ctx.actor,
      event: 'deployment_confirmed',
      run: null,
      refs: [row.deployment_id],
      data: {
        deployment_id: row.deployment_id,
        environment: row.environment,
        sha: row.sha,
        evidence,
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    return true;
  });
  if (!created) {
    // Idempotent retry — the deployment row already exists (client-
    // supplied or minted id); return the stored row, never duplicate
    // the state write or the audit event.
    const existing = (
      await ctx.store.listDeployments({ workspace: ctx.workspace })
    ).find((d) => d.deployment_id === row.deployment_id);
    if (!existing) {
      // Conflict target == find filter — a miss can only mean a
      // concurrent delete; fail closed rather than claim a row that
      // was never persisted.
      throw new ReleaseError(
        'bad-state',
        `deployment ${row.deployment_id} exists but is unreadable`,
      );
    }
    return existing;
  }
  return row;
}

// ---------------------------------------------------------------------------
// feature exposure (DELIVERY §3 — `available` requires a linked
// deployment, invariant 4)
// ---------------------------------------------------------------------------

/**
 * Set a feature's exposure in an environment. `hidden`/`limited` are
 * free-standing; `available` fails closed unless `deploymentId` links a
 * CONFIRMED deployment of a release carrying the feature to the SAME
 * environment. Emits `feature_exposed` on the feature subject and
 * materializes `deployed ↔ exposed` on the deployment's release items.
 */
export async function setFeatureExposure(
  ctx: ReleaseCtx,
  featureId: string,
  args: {
    environment: string;
    state: FeatureExposureState;
    audience?: string | null;
    evidence?: string | null;
    deploymentId?: string | null;
  },
): Promise<FeatureExposureRow> {
  const feature = await ctx.store.getFeature(ctx.workspace, featureId);
  if (!feature) {
    throw new ReleaseError('not-found', `no feature ${featureId}`);
  }
  if (!args.environment?.trim()) {
    throw new ReleaseError('bad-item', 'exposure environment is required');
  }

  let deployment: DeploymentRow | null = null;
  if (args.state === 'available') {
    // Invariant 4 — every clause fails closed.
    if (!args.deploymentId?.trim()) {
      throw new ReleaseError(
        'no-deployment',
        `feature ${featureId}: 'available' requires a linked deployment_id`,
      );
    }
    deployment =
      (await ctx.store.listDeployments({ workspace: ctx.workspace })).find(
        (d) => d.deployment_id === args.deploymentId,
      ) ?? null;
    if (!deployment) {
      throw new ReleaseError(
        'no-deployment',
        `feature ${featureId}: linked deployment ${args.deploymentId} does not exist`,
      );
    }
    if (!deployment.confirmed_at) {
      throw new ReleaseError(
        'no-deployment',
        `feature ${featureId}: deployment ${deployment.deployment_id} is unconfirmed`,
      );
    }
    if (deployment.environment !== args.environment) {
      throw new ReleaseError(
        'no-deployment',
        `feature ${featureId}: deployment ${deployment.deployment_id} is env '${deployment.environment}', not '${args.environment}'`,
      );
    }
    if (
      !(await releaseContainsFeature(ctx, deployment.release_id, featureId))
    ) {
      throw new ReleaseError(
        'no-deployment',
        `feature ${featureId}: deployment ${deployment.deployment_id} (release ${deployment.release_id}) does not carry this feature`,
      );
    }
  }

  const ts = ctx.now().toISOString();
  const prior = await ctx.store.getFeatureExposure({
    workspace: ctx.workspace,
    feature_id: featureId,
    environment: args.environment,
  });
  const row: FeatureExposureRow = {
    workspace: ctx.workspace,
    feature_id: featureId,
    environment: args.environment,
    state: args.state,
    audience: args.audience ?? null,
    evidence: args.evidence ?? null,
    deployment_id:
      args.state === 'available' ? (deployment?.deployment_id ?? null) : null,
    updated_at: ts,
  };
  await ctx.store.transaction(async (store) => {
    const tx: ReleaseCtx = { ...ctx, store };
    await store.upsertFeatureExposure(row);
    if (args.state === 'available' && deployment) {
      await materializeDeliveryState(tx, deployment.release_id, 'exposed', {
        from: ['released', 'deployed'],
        featureId,
      });
    } else if (prior?.state === 'available' && prior.deployment_id) {
      // Rolling back availability — the items return to `deployed`.
      const prev = (
        await store.listDeployments({ workspace: ctx.workspace })
      ).find((d) => d.deployment_id === prior.deployment_id);
      if (prev) {
        await materializeDeliveryState(tx, prev.release_id, 'deployed', {
          from: ['exposed'],
          featureId,
        });
      }
    }
    await store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: featureId,
      ts,
      stage: null,
      actor_type: 'human',
      actor_id: ctx.actor,
      event: 'feature_exposed',
      run: null,
      refs: [
        ...(deployment ? [deployment.deployment_id] : []),
        ...(deployment ? [deployment.release_id] : []),
      ],
      data: {
        feature_id: featureId,
        environment: args.environment,
        state: args.state,
        audience: row.audience,
        deployment_id: row.deployment_id,
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
  });
  return row;
}

// ---------------------------------------------------------------------------
// release outcomes (DELIVERY §3 — KPI baseline/target/observed)
// ---------------------------------------------------------------------------

/**
 * Upsert a KPI outcome row for a release. `kpi` is the row identity;
 * `data` carries {baseline, target, observed, unit} (+ passthrough
 * extras). Fail-closed on an empty payload — an outcome with no
 * numbers and no unit records nothing. Abandoned releases are
 * unwritable.
 */
export async function recordReleaseOutcome(
  ctx: ReleaseCtx,
  releaseId: string,
  args: {
    kpi: string;
    baseline?: number | null;
    target?: number | null;
    observed?: number | null;
    unit?: string | null;
    /** Extra passthrough keys folded into `data` (DELIVERY §3 json). */
    extra?: Record<string, unknown>;
    measuredAt?: string | null;
  },
): Promise<ReleaseOutcomeRow> {
  const release = await requireRelease(ctx, releaseId);
  if (release.status === 'abandoned') {
    throw new ReleaseError(
      'bad-state',
      `outcome: release ${releaseId} is abandoned — outcomes attach to live work`,
    );
  }
  if (!args.kpi?.trim()) {
    throw new ReleaseError('bad-item', 'outcome kpi name is required');
  }
  const data: ReleaseOutcomeRow['data'] = {
    ...(args.extra ?? {}),
    baseline: args.baseline ?? null,
    target: args.target ?? null,
    observed: args.observed ?? null,
    unit: args.unit ?? null,
  };
  if (
    data.baseline == null &&
    data.target == null &&
    data.observed == null &&
    data.unit == null &&
    Object.keys(args.extra ?? {}).length === 0
  ) {
    throw new ReleaseError(
      'bad-item',
      `outcome ${args.kpi}: empty payload — supply at least one of baseline/target/observed/unit`,
    );
  }
  const row: ReleaseOutcomeRow = {
    workspace: ctx.workspace,
    release_id: releaseId,
    kpi: args.kpi,
    data,
    measured_at: args.measuredAt ?? ctx.now().toISOString(),
  };
  await ctx.store.upsertReleaseOutcome(row);
  return row;
}
