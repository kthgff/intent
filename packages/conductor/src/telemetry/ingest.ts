/**
 * telemetry/ingest.ts — wp-120 sanitized telemetry connector +
 * fingerprint/dedupe (INTELLIGENCE §6.1, D37 Phase C).
 *
 * The first supported backend is OTLP (OpenTelemetry) — chosen by the
 * wp-120 spike because it is the vendor-neutral wire protocol every
 * observability backend already ingests, so the ADAPTER CONTRACT here
 * stays backend-neutral: callers hand us decoded event objects; a
 * Loki/OTel-collector/etc. receiver only has to produce
 * `TelemetryEvent[]`. Raw events are NEVER persisted — only sanitized
 * fingerprints, bounded representatives, and backend locators.
 */
import type {
  ErrorSignatureRow,
  IncidentRow,
  Store,
  TelemetrySourceRow,
} from '@sprint-runner/core';
import {
  FINGERPRINT_VERSION,
  TELEMETRY_SOURCE_KINDS,
} from '@sprint-runner/core';
import {
  TELEMETRY_REDACTION_POLICY,
  type TelemetryEvent,
  fingerprintEvent,
  representativeSample,
  sanitizeTelemetryEvent,
  secretConfigIssues,
  signatureId,
} from './sanitize.js';

/** Everything a telemetry operation needs — same shape as AlignCtx. */
export interface TelemetryCtx {
  store: Store;
  workspace: string;
  actor: string;
  now: () => Date;
}

/** Why a telemetry operation failed — mapped to HTTP by the API. */
export type TelemetryErrorKind =
  | 'invalid' // 400 — malformed payload/config
  | 'missing' // 404 — no such source/signature/incident/proposal
  | 'conflict' // 409 — stale OCC `expected`
  | 'disabled'; // 409 — source disabled

export class TelemetryServiceError extends Error {
  readonly kind: TelemetryErrorKind;
  readonly current?: string | null | undefined;
  constructor(
    kind: TelemetryErrorKind,
    message: string,
    current?: string | null,
  ) {
    super(message);
    this.name = 'TelemetryServiceError';
    this.kind = kind;
    this.current = current;
  }
}

// ---------------------------------------------------------------------------
// source administration — authorize + secret-refs-only config
// ---------------------------------------------------------------------------

export interface RegisterSourceArgs {
  id: string;
  kind: string;
  config?: Record<string, unknown> | undefined;
  redaction_policy?: string | undefined;
  enabled?: boolean | undefined;
}

export async function registerTelemetrySource(
  ctx: TelemetryCtx,
  args: RegisterSourceArgs,
): Promise<TelemetrySourceRow> {
  if (!(TELEMETRY_SOURCE_KINDS as readonly string[]).includes(args.kind)) {
    throw new TelemetryServiceError(
      'invalid',
      `unknown telemetry source kind '${args.kind}' (allowed: ${TELEMETRY_SOURCE_KINDS.join(', ')})`,
    );
  }
  const issues = secretConfigIssues(args.config ?? {});
  if (issues.length > 0) {
    throw new TelemetryServiceError(
      'invalid',
      `telemetry source config refused — ${issues.join('; ')}`,
    );
  }
  const nowIso = ctx.now().toISOString();
  const row: TelemetrySourceRow = {
    id: args.id,
    workspace: ctx.workspace,
    kind: args.kind,
    config: args.config ?? {},
    redaction_policy: args.redaction_policy ?? TELEMETRY_REDACTION_POLICY,
    enabled: args.enabled === false ? 0 : 1,
    created_at: nowIso,
    updated_at: nowIso,
  };
  await ctx.store.upsertTelemetrySource(row);
  return row;
}

// ---------------------------------------------------------------------------
// ingest — sanitize → fingerprint → dedupe (raw events never persist)
// ---------------------------------------------------------------------------

export interface IngestArgs {
  source_id: string;
  events: TelemetryEvent[];
}

export interface IngestResult {
  signatures: ErrorSignatureRow[];
  incidents_opened: IncidentRow[];
  /** Per-fingerprint event counts — the ONLY thing tracked per event;
   *  event bodies are dropped after sanitization. */
  counts: {
    fingerprint: string;
    events: number;
    state: 'created' | 'updated';
  }[];
}

/**
 * Ingest a decoded telemetry batch for one configured source.
 * Authorization is the source row itself: unknown or disabled sources
 * are refused before any content is touched. Every event is sanitized
 * (fail-closed — one poisonous event rejects the batch), fingerprinted,
 * and merged into its signature row; a NEW signature opens an
 * `INC-NNNN` incident and a signature whose prior incidents all settled
 * opens a recurrence incident. No raw event, request body, or secret
 * is ever written.
 */
export async function ingestTelemetry(
  ctx: TelemetryCtx,
  args: IngestArgs,
): Promise<IngestResult> {
  const source = await ctx.store.getTelemetrySource({
    workspace: ctx.workspace,
    id: args.source_id,
  });
  if (!source) {
    throw new TelemetryServiceError(
      'missing',
      `no telemetry source '${args.source_id}' in ${ctx.workspace}`,
    );
  }
  if (!source.enabled) {
    throw new TelemetryServiceError(
      'disabled',
      `telemetry source '${args.source_id}' is disabled`,
    );
  }
  if (!Array.isArray(args.events) || args.events.length === 0) {
    throw new TelemetryServiceError(
      'invalid',
      'events must be a non-empty array',
    );
  }

  // Sanitize the WHOLE batch first — a single unclassifiable event
  // refuses the batch rather than landing a partial ingest (fail-closed).
  const sanitized = args.events.map((e, i) => {
    try {
      return sanitizeTelemetryEvent(e);
    } catch (err) {
      throw new TelemetryServiceError(
        'invalid',
        `event ${i} failed sanitization: ${(err as Error).message}`,
      );
    }
  });

  // Group by fingerprint — repeated events update ONE versioned row's
  // count; no per-event rows are ever written (wp-120 AC).
  const groups = new Map<string, { evs: typeof sanitized; n: number }>();
  for (const ev of sanitized) {
    const fp = fingerprintEvent(ev);
    const g = groups.get(fp) ?? { evs: [], n: 0 };
    g.evs.push(ev);
    g.n += 1;
    groups.set(fp, g);
  }

  const nowIso = ctx.now().toISOString();
  const signatures: ErrorSignatureRow[] = [];
  const incidentsOpened: IncidentRow[] = [];
  const counts: IngestResult['counts'] = [];

  for (const [fp, g] of groups) {
    const first = g.evs.at(0);
    if (!first) continue; // a group always has ≥1 event — guard anyway
    const timestamps = g.evs
      .map((e) => e.timestamp)
      .filter((t): t is string => !!t)
      .sort();
    const id = signatureId(ctx.workspace, args.source_id, fp);
    const res = await ctx.store.upsertErrorSignature(
      {
        id,
        workspace: ctx.workspace,
        source_id: args.source_id,
        fingerprint_version: FINGERPRINT_VERSION,
        fingerprint: fp,
        normalized_pattern: first.message || first.exception_class || fp,
        representative: representativeSample(first),
        attributes: first.attributes,
        first_seen: timestamps[0] ?? nowIso,
        last_seen: timestamps[timestamps.length - 1] ?? nowIso,
        count: g.n,
        raw_locator: `query:${args.source_id}:${fp}`,
      },
      g.n,
    );
    signatures.push(res.row);
    counts.push({ fingerprint: fp, events: g.n, state: res.state });

    // Incident policy: a NEW signature opens one incident; an existing
    // signature whose incidents all settled (resolved/closed) opens a
    // RECURRENCE incident — a live open/investigating incident absorbs
    // the count silently (no duplicate investigations, wp-120 AC).
    const existing = await ctx.store.listIncidents({
      workspace: ctx.workspace,
      signature_id: res.row.id,
    });
    const live = existing.some(
      (i) => i.status === 'open' || i.status === 'investigating',
    );
    if (!live && (res.state === 'created' || existing.length > 0)) {
      const incidentId = await ctx.store.allocIncidentId(ctx.workspace);
      const recurrence = existing.length > 0;
      const incident: IncidentRow = {
        id: incidentId,
        workspace: ctx.workspace,
        signature_id: res.row.id,
        status: 'open',
        summary:
          `${recurrence ? 'recurrence: ' : ''}${res.row.normalized_pattern}`.slice(
            0,
            300,
          ),
        investigation_ref: null,
        root_cause: null,
        resolution: null,
        resolution_verified: 0,
        deployment_refs: [],
        ticket_refs: [],
        pr_refs: [],
        opened_at: nowIso,
        resolved_at: null,
      };
      await ctx.store.insertIncident(incident);
      incidentsOpened.push(incident);
      await ctx.store.appendEvent({
        workspace: ctx.workspace,
        ticket_id: null,
        ts: nowIso,
        stage: null,
        actor_type: 'system',
        actor_id: ctx.actor,
        event: 'incident_opened',
        run: null,
        refs: [`incident:${incidentId}`, `signature:${res.row.id}`],
        data: {
          incident: incidentId,
          signature: res.row.id,
          fingerprint: fp,
          recurrence,
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
  }

  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: null,
    ts: nowIso,
    stage: null,
    actor_type: 'system',
    actor_id: ctx.actor,
    event: 'telemetry_ingested',
    run: null,
    refs: signatures.map((s) => `signature:${s.id}`),
    data: {
      source_id: args.source_id,
      events: sanitized.length,
      signatures: signatures.length,
      incidents_opened: incidentsOpened.map((i) => i.id),
      sanitization_policy:
        source.redaction_policy ?? TELEMETRY_REDACTION_POLICY,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });

  return { signatures, incidents_opened: incidentsOpened, counts };
}
