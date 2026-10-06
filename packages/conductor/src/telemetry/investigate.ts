/**
 * telemetry/investigate.ts — wp-120 incident investigation
 * (INTELLIGENCE §6.2, SCHEMAS §19).
 *
 * Deterministic correlation — the same precedent wp-112 set for
 * alignment findings: no model call, every hypothesis carries
 * evidence refs + disconfirming refs + next checks, and the artifact
 * is validated fail-closed (`validateIncidentInvestigation`) before it
 * is persisted as the incident's durable
 * `incident-investigation.json` doc_version. Counts and time windows
 * come from the structured `error_signatures`/`deployments` rows —
 * never from vector retrieval.
 *
 * Correlation chain (INTELLIGENCE §6.2): signature → deployments in
 * the observed window → release/ticket members → prior incidents on
 * the same signature (verified resolutions first).
 */
import type { IncidentInvestigation, Store } from '@veto/core';
import { validateIncidentInvestigation } from '@veto/core';
import { type TelemetryCtx, TelemetryServiceError } from './ingest.js';
import { TELEMETRY_REDACTION_POLICY } from './sanitize.js';

/**
 * Run a correlation over one incident and persist the validated
 * `incident-investigation.json` artifact. Idempotent-ish: each run
 * appends a NEW doc_version (immutable history — D24) and points
 * `incidents.investigation_ref` at the latest.
 */
export async function investigateIncident(
  ctx: TelemetryCtx,
  incidentId: string,
): Promise<{ incident: string; artifact: IncidentInvestigation; ref: string }> {
  const incident = await ctx.store.getIncident({
    workspace: ctx.workspace,
    id: incidentId,
  });
  if (!incident) {
    throw new TelemetryServiceError(
      'missing',
      `no incident '${incidentId}' in ${ctx.workspace}`,
    );
  }
  const signature = await ctx.store.getErrorSignature({
    workspace: ctx.workspace,
    id: incident.signature_id,
  });
  if (!signature) {
    throw new TelemetryServiceError(
      'missing',
      `incident ${incidentId} references missing signature ${incident.signature_id}`,
    );
  }
  const source = signature.source_id
    ? await ctx.store.getTelemetrySource({
        workspace: ctx.workspace,
        id: signature.source_id,
      })
    : null;

  const window = { from: signature.first_seen, to: signature.last_seen };
  const fromMs = Date.parse(signature.first_seen);
  const toMs = Date.parse(signature.last_seen);
  // Look back 24h before first_seen for the deployment that plausibly
  // introduced the regression.
  const LOOKBACK_MS = 24 * 60 * 60 * 1000;

  const depAt = (d: {
    confirmed_at?: string | null | undefined;
    created_at?: string | null | undefined;
  }) => Date.parse(d.confirmed_at ?? d.created_at ?? '');
  const allDeployments = await ctx.store.listDeployments({
    workspace: ctx.workspace,
  });
  const deployments = allDeployments.filter((d) => {
    const t = depAt(d);
    return Number.isFinite(t) && t >= fromMs - LOOKBACK_MS && t <= toMs;
  });
  // Confirmed AFTER the observed window — can't have caused it;
  // disclosed as disconfirming refs (never hidden).
  const afterWindow = allDeployments.filter(
    (d) => Number.isFinite(depAt(d)) && depAt(d) > toMs,
  );

  const services = new Set<string>();
  for (const k of ['service', 'service_name', 'resource']) {
    const v = signature.attributes[k];
    if (typeof v === 'string' && v) services.add(v);
  }

  const hypotheses: IncidentInvestigation['hypotheses'] = [];

  // Hypothesis 1 — a deployment inside the window introduced the
  // regression. Evidence: the deployment row + the signature's
  // first_seen falling after it. Disconfirming: deployments confirmed
  // AFTER last_seen can't be the cause; incidents on the same
  // signature that predate the deployment also cut against it.
  const introducing = deployments
    .filter((d) => depAt(d) <= fromMs)
    .sort((a, b) => depAt(b) - depAt(a));
  if (introducing.length > 0) {
    const dep = introducing.at(0);
    if (!dep) throw new Error('unreachable: introducing is non-empty');

    const release = await ctx.store.getRelease({
      workspace: ctx.workspace,
      release_id: dep.release_id,
    });
    const items = release
      ? (
          await ctx.store.listReleaseItems({
            workspace: ctx.workspace,
            release_id: dep.release_id,
          })
        ).filter((i) => !i.removed_at)
      : [];
    hypotheses.push({
      rank: 1,
      summary:
        `signature first observed after deployment ${dep.deployment_id} ` +
        `(${dep.release_id}@${dep.sha.slice(0, 12)} → ${dep.environment})`,
      confidence: introducing.length === 1 ? 0.75 : 0.6,
      evidence_refs: [
        `signature:${signature.id}`,
        `deployment:${dep.deployment_id}`,
        `release:${dep.release_id}`,
        ...items.map((i) => `${i.item_kind}:${i.item_id}`),
      ],
      disconfirming_refs: afterWindow
        .map((d) => `deployment:${d.deployment_id}`)
        .slice(0, 5),
      next_checks: [
        `diff ${dep.release_id}@${dep.sha.slice(0, 12)} against the prior deployed sha in ${dep.environment}`,
        `query source backend for ${signature.raw_locator ?? signature.fingerprint} around ${dep.confirmed_at ?? dep.created_at}`,
      ],
    });
  } else {
    hypotheses.push({
      rank: 1,
      summary:
        'no deployment inside the observed window — likely a latent or ' +
        'externally triggered failure mode',
      confidence: 0.45,
      evidence_refs: [`signature:${signature.id}`],
      disconfirming_refs: afterWindow
        .map((d) => `deployment:${d.deployment_id}`)
        .slice(0, 5),
      next_checks: [
        'widen the window and re-run correlation',
        `query source backend for ${signature.raw_locator ?? signature.fingerprint} upstream dependency errors`,
      ],
    });
  }

  // Prior incidents on the same signature — verified resolutions are
  // the reusable knowledge records (INTELLIGENCE §6.2).
  const prior = (
    await ctx.store.listIncidents({
      workspace: ctx.workspace,
      signature_id: signature.id,
    })
  ).filter((i) => i.id !== incident.id);
  const similar_incidents = prior
    .sort((a, b) => b.resolution_verified - a.resolution_verified)
    .slice(0, 10)
    .map((i) => ({
      incident: i.id,
      resolution_verified: i.resolution_verified === 1,
    }));
  const verifiedPrior = prior.find((i) => i.resolution_verified === 1);
  if (verifiedPrior) {
    hypotheses.push({
      rank: hypotheses.length + 1,
      summary: `recurrence of a pattern previously resolved in ${verifiedPrior.id} — the earlier resolution may not have held`,
      confidence: 0.65,
      evidence_refs: [
        `signature:${signature.id}`,
        `incident:${verifiedPrior.id}`,
        ...(verifiedPrior.resolution ? [`resolution:${verifiedPrior.id}`] : []),
      ],
      disconfirming_refs: [],
      next_checks: [
        `inspect ${verifiedPrior.id} resolution (${verifiedPrior.resolution ?? 'no text'}) and check whether the fix shipped`,
      ],
    });
  }

  const artifact = validateIncidentInvestigation({
    schema: 1,
    workspace: ctx.workspace,
    incident: incident.id,
    signature: signature.id,
    window,
    sanitization_policy: source?.redaction_policy ?? TELEMETRY_REDACTION_POLICY,
    observed: {
      count: signature.count,
      first_seen: signature.first_seen,
      last_seen: signature.last_seen,
      services: [...services],
      deployments: deployments.map((d) => d.deployment_id),
    },
    hypotheses: hypotheses.map((h, i) => ({ ...h, rank: i + 1 })),
    similar_incidents,
    proposed_action: { kind: 'none', requires_human: true as const },
    generated_at: ctx.now().toISOString(),
  });

  const version = await ctx.store.appendDocVersion(
    {
      workspace: ctx.workspace,
      subject: incident.id,
      doc: 'incident-investigation.json',
    },
    `${JSON.stringify(artifact, null, 2)}\n`,
    ctx.actor,
  );
  const ref = `doc:${incident.id}:incident-investigation.json:v${version.version}`;
  await ctx.store.updateIncident(
    { workspace: ctx.workspace, id: incident.id },
    { investigation_ref: ref },
  );
  return { incident: incident.id, artifact, ref };
}
