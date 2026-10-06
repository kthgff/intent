/**
 * api/telemetry.ts — wp-120 telemetry + incident intelligence routes
 * (D37 Phase C, API.md `/telemetry/*` `/incidents*` rows, SCHEMAS §19).
 *
 *   GET  /api/v1/telemetry/sources?workspace=      — list sources.
 *   POST /api/v1/telemetry/sources                 — register/update a
 *        source `{workspace, id, kind, config?, enabled?}`; secret-ish
 *        config keys must hold `env:`/`ref:`/`$NAME` refs → 400 raw.
 *   POST /api/v1/telemetry/ingest                  — `{workspace,
 *        source_id, events[]}` → sanitize → fingerprint → dedupe;
 *        new/regressed signatures open `INC-NNNN` incidents. Raw event
 *        bodies are never persisted or returned.
 *   GET  /api/v1/telemetry/signatures?workspace=&source_id= — the
 *        deduplicated signature list (counts come from these rows,
 *        never vector retrieval).
 *   GET  /api/v1/incidents?workspace=&status=      — incident list.
 *   GET  /api/v1/incidents/<id>?workspace=         — incident + latest
 *        `incident-investigation.json` (validated fail-closed).
 *   POST /api/v1/incidents/<id>/investigate        — run deterministic
 *        correlation → durable doc_version + `investigation_ref`.
 *   POST /api/v1/incidents/decide                  — `{workspace, id,
 *        action: investigate|resolve|close|reopen, expected, rationale?,
 *        evidence?}` — OCC (`expected` = the status the human saw; a
 *        racing write → 409), idempotent, audited (`incident_decisions`)
 *        + `incident_decided` event. `resolve` REQUIRES evidence refs —
 *        never AI assertion alone → 400 otherwise.
 *   POST /api/v1/incidents/<id>/proposals          — propose a draft
 *        ticket `{workspace, title, body?, draft?}` → `draft` proposal
 *        + `draft_ticket_proposed`. Proposals never enter scope.
 *   POST /api/v1/incidents/proposals/decide        — `{workspace, id,
 *        action: approve|reject, expected, rationale?}` — OCC; approve
 *        lands ONE capture-tray board item (retro-proposal parity).
 */
import {
  TelemetryServiceError,
  decideDraftTicket,
  decideIncidentStatus,
  ingestTelemetry,
  investigateIncident,
  proposeDraftTicket,
  registerTelemetrySource,
} from '@sprint-runner/conductor';
import type { Store } from '@sprint-runner/core';
import {
  DRAFT_TICKET_ACTIONS,
  DRAFT_TICKET_STATUSES,
  INCIDENT_ACTIONS,
  INCIDENT_STATUSES,
  validateIncidentInvestigation,
} from '@sprint-runner/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, parseBody } from './server.js';

const Ws = z.object({ workspace: z.string().min(1) });

const RegisterBody = Ws.extend({
  id: z.string().min(1),
  kind: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  redaction_policy: z.string().nullish(),
  enabled: z.boolean().nullish(),
});

const IngestBody = Ws.extend({
  source_id: z.string().min(1),
  events: z.array(z.record(z.unknown())).min(1),
});

const DecideIncidentBody = Ws.extend({
  id: z.string().min(1),
  action: z.enum(INCIDENT_ACTIONS),
  expected: z.enum(INCIDENT_STATUSES).nullable(),
  rationale: z.string().nullish(),
  evidence: z
    .object({
      root_cause: z.string().nullish(),
      resolution: z.string().nullish(),
      deployment_refs: z.array(z.string()).nullish(),
      ticket_refs: z.array(z.string()).nullish(),
      pr_refs: z.array(z.string()).nullish(),
    })
    .nullish(),
});

const ProposeBody = Ws.extend({
  title: z.string().min(1),
  body: z.string().nullish(),
  draft: z.record(z.unknown()).default({}),
});

const DecideProposalBody = Ws.extend({
  id: z.string().min(1),
  action: z.enum(DRAFT_TICKET_ACTIONS),
  expected: z.enum(DRAFT_TICKET_STATUSES).nullable(),
  rationale: z.string().nullish(),
});

export interface TelemetryRouteDeps {
  store: Store;
  actor: string;
  notify?: (event: { type: string; payload: unknown }) => void;
}

function telemetryHttp(e: TelemetryServiceError): ApiError {
  switch (e.kind) {
    case 'invalid':
      return new ApiError(400, 'bad_request', e.message);
    case 'missing':
      return new ApiError(404, 'not_found', e.message);
    case 'conflict':
      return new ApiError(409, 'conflict', e.message);
    case 'disabled':
      return new ApiError(409, 'conflict', e.message);
  }
}

export function registerTelemetryRoutes(
  app: FastifyInstance,
  deps: TelemetryRouteDeps,
): void {
  const ctx = (workspace: string) => ({
    store: deps.store,
    workspace,
    actor: deps.actor,
    now: () => new Date(),
  });

  app.get('/api/v1/telemetry/sources', async (req) => {
    const q = parseBody(
      Ws.extend({
        enabled: z.enum(['0', '1', 'true', 'false']).optional(),
      }),
      req.query,
      'sources query',
    );
    const sources = await deps.store.listTelemetrySources({
      workspace: q.workspace,
      ...(q.enabled === undefined
        ? {}
        : { enabled: q.enabled === '1' || q.enabled === 'true' }),
    });
    return { sources };
  });

  app.post('/api/v1/telemetry/sources', async (req, reply) => {
    const body = parseBody(RegisterBody, req.body, 'telemetry source');
    try {
      const source = await registerTelemetrySource(ctx(body.workspace), {
        id: body.id,
        kind: body.kind,
        config: body.config,
        redaction_policy: body.redaction_policy ?? undefined,
        enabled: body.enabled ?? undefined,
      });
      return reply.status(201).send({ source });
    } catch (e) {
      if (e instanceof TelemetryServiceError) throw telemetryHttp(e);
      throw e;
    }
  });

  app.post('/api/v1/telemetry/ingest', async (req, reply) => {
    const body = parseBody(IngestBody, req.body, 'telemetry ingest');
    try {
      const result = await ingestTelemetry(ctx(body.workspace), {
        source_id: body.source_id,
        events: body.events,
      });
      deps.notify?.({
        type: 'incident_status',
        payload: {
          workspace: body.workspace,
          source_id: body.source_id,
          signatures: result.signatures.length,
          incidents_opened: result.incidents_opened.map((i) => i.id),
        },
      });
      return reply.status(200).send(result);
    } catch (e) {
      if (e instanceof TelemetryServiceError) throw telemetryHttp(e);
      throw e;
    }
  });

  app.get('/api/v1/telemetry/signatures', async (req) => {
    const q = parseBody(
      Ws.extend({ source_id: z.string().optional() }),
      req.query,
      'signatures query',
    );
    const signatures = await deps.store.listErrorSignatures({
      workspace: q.workspace,
      ...(q.source_id ? { source_id: q.source_id } : {}),
    });
    return { signatures };
  });

  app.get('/api/v1/incidents', async (req) => {
    const q = parseBody(
      Ws.extend({
        status: z.string().optional(),
        signature_id: z.string().optional(),
      }),
      req.query,
      'incidents query',
    );
    const incidents = await deps.store.listIncidents({
      workspace: q.workspace,
      ...(q.status ? { status: q.status } : {}),
      ...(q.signature_id ? { signature_id: q.signature_id } : {}),
    });
    const proposals = await deps.store.listIncidentTicketProposals({
      workspace: q.workspace,
    });
    return { incidents, proposals };
  });

  app.get('/api/v1/incidents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const q = parseBody(Ws, req.query, 'incident query');
    const incident = await deps.store.getIncident({
      workspace: q.workspace,
      id,
    });
    if (!incident) {
      throw new ApiError(404, 'not_found', `no incident '${id}'`);
    }
    let investigation: ReturnType<typeof validateIncidentInvestigation> | null =
      null;
    if (incident.investigation_ref) {
      const doc = await deps.store.getDoc({
        workspace: q.workspace,
        subject: incident.id,
        doc: 'incident-investigation.json',
      });
      if (doc) {
        // Fail-closed: a malformed stored artifact is a 502, never a
        // silently degraded response.
        try {
          investigation = validateIncidentInvestigation(
            JSON.parse(doc.content),
          );
        } catch (e) {
          throw new ApiError(502, 'corrupt_artifact', (e as Error).message);
        }
      }
    }
    const decisions = await deps.store.listIncidentDecisions({
      workspace: q.workspace,
      incident_id: id,
    });
    const proposals = await deps.store.listIncidentTicketProposals({
      workspace: q.workspace,
      incident_id: id,
    });
    return { incident, investigation, decisions, proposals };
  });

  app.post('/api/v1/incidents/:id/investigate', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(Ws, req.body, 'investigate');
    try {
      const result = await investigateIncident(ctx(body.workspace), id);
      deps.notify?.({
        type: 'incident_status',
        payload: {
          workspace: body.workspace,
          incident: id,
          investigation_ref: result.ref,
        },
      });
      return result;
    } catch (e) {
      if (e instanceof TelemetryServiceError) throw telemetryHttp(e);
      throw e;
    }
  });

  app.post('/api/v1/incidents/decide', async (req) => {
    const body = parseBody(DecideIncidentBody, req.body, 'incident decide');
    try {
      const incident = await decideIncidentStatus(ctx(body.workspace), {
        id: body.id,
        action: body.action,
        expected: body.expected ?? undefined,
        rationale: body.rationale ?? null,
        evidence: body.evidence
          ? {
              root_cause: body.evidence.root_cause ?? undefined,
              resolution: body.evidence.resolution ?? undefined,
              deployment_refs: body.evidence.deployment_refs ?? undefined,
              ticket_refs: body.evidence.ticket_refs ?? undefined,
              pr_refs: body.evidence.pr_refs ?? undefined,
            }
          : undefined,
      });
      deps.notify?.({ type: 'incident_status', payload: incident });
      return { incident };
    } catch (e) {
      if (e instanceof TelemetryServiceError) throw telemetryHttp(e);
      throw e;
    }
  });

  app.post('/api/v1/incidents/:id/proposals', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ProposeBody, req.body, 'ticket proposal');
    try {
      const proposal = await proposeDraftTicket(ctx(body.workspace), {
        incident_id: id,
        title: body.title,
        body: body.body ?? null,
        draft: body.draft,
      });
      deps.notify?.({
        type: 'incident_status',
        payload: {
          workspace: body.workspace,
          incident: id,
          proposal: proposal.id,
        },
      });
      return reply.status(201).send(proposal);
    } catch (e) {
      if (e instanceof TelemetryServiceError) throw telemetryHttp(e);
      throw e;
    }
  });

  app.post('/api/v1/incidents/proposals/decide', async (req) => {
    const body = parseBody(DecideProposalBody, req.body, 'proposal decide');
    try {
      const result = await decideDraftTicket(ctx(body.workspace), {
        id: body.id,
        action: body.action,
        expected: body.expected ?? undefined,
        rationale: body.rationale ?? null,
      });
      deps.notify?.({ type: 'incident_status', payload: result });
      return result;
    } catch (e) {
      if (e instanceof TelemetryServiceError) throw telemetryHttp(e);
      throw e;
    }
  });
}
