import { randomUUID } from 'node:crypto';
/**
 * telemetry/decide.ts — wp-120 validated resolution + draft-ticket
 * gate (INTELLIGENCE §6.2, wp-111/112 OCC-decide convention).
 *
 *   * `decideIncidentStatus` — the ONLY path that moves
 *     `incidents.status`. `resolve` additionally requires recorded
 *     EVIDENCE (deployment/ticket/pr refs or an investigation ref):
 *     an incident never resolves on an AI assertion alone
 *     (wp-120 AC). OCC + append-only `incident_decisions` audit +
 *     `incident_decided` event, idempotent like decideAlignmentFinding.
 *   * `proposeDraftTicket` / `decideDraftTicket` — the draft-ticket
 *     gate: an incident may PROPOSE scope; only a human `approve`
 *     lands a capture-tray board item (retro-proposal parity —
 *     nothing enters committed scope without it).
 */
import type { BoardItem, IncidentRow } from '@veto/core';
import { type TelemetryCtx, TelemetryServiceError } from './ingest.js';

// ---------------------------------------------------------------------------
// human incident decisions (OCC + audit + event)
// ---------------------------------------------------------------------------

const ACTION_TARGET: Record<string, IncidentRow['status']> = {
  investigate: 'investigating',
  resolve: 'resolved',
  close: 'closed',
  reopen: 'open',
};

export interface DecideIncidentArgs {
  id: string;
  action: 'investigate' | 'resolve' | 'close' | 'reopen';
  /** OCC — the status the human saw. */
  expected: IncidentRow['status'] | null | undefined;
  rationale?: string | null | undefined;
  /** Resolution evidence — REQUIRED for `resolve`: deployment/ticket/
   *  pr refs (or the investigation doc ref) proving the fix shipped /
   *  telemetry improved. AI text alone can never resolve. */
  evidence?:
    | {
        root_cause?: string | undefined;
        resolution?: string | undefined;
        deployment_refs?: string[] | undefined;
        ticket_refs?: string[] | undefined;
        pr_refs?: string[] | undefined;
      }
    | undefined;
}

export async function decideIncidentStatus(
  ctx: TelemetryCtx,
  args: DecideIncidentArgs,
): Promise<IncidentRow> {
  const next = ACTION_TARGET[args.action];
  if (!next) {
    throw new TelemetryServiceError(
      'invalid',
      `unknown incident action '${args.action}'`,
    );
  }
  const prior = await ctx.store.getIncident({
    workspace: ctx.workspace,
    id: args.id,
  });
  if (!prior) {
    throw new TelemetryServiceError(
      'missing',
      `no incident '${args.id}' in ${ctx.workspace}`,
    );
  }
  if (prior.status === next) return prior; // idempotent noop

  if (args.action === 'resolve') {
    // Validated resolution: evidence beyond assertions. The decider
    // must supply at least one concrete ref — a linked deployment,
    // ticket, or PR proving the fix shipped / telemetry improved —
    // otherwise 400 (fail-closed). An investigation artifact alone is
    // analysis, not resolution evidence.
    const ev = args.evidence ?? {};
    const deploymentRefs = (ev.deployment_refs ?? []).filter(
      (r): r is string => typeof r === 'string' && r.trim() !== '',
    );
    const ticketRefs = (ev.ticket_refs ?? []).filter(
      (r): r is string => typeof r === 'string' && r.trim() !== '',
    );
    const prRefs = (ev.pr_refs ?? []).filter(
      (r): r is string => typeof r === 'string' && r.trim() !== '',
    );
    if (deploymentRefs.length + ticketRefs.length + prRefs.length === 0) {
      throw new TelemetryServiceError(
        'invalid',
        `resolve requires recorded evidence (deployment/ticket/pr refs) — ${args.id} cannot resolve on assertion alone`,
      );
    }
    // Presence alone isn't evidence — at least one ref must RESOLVE:
    // a real deployment id, a real ticket, or a non-empty PR url.
    // Anything else fails closed (400) — a fabricated ref list can
    // never settle an incident.
    let resolvable = prRefs.length > 0;
    if (!resolvable && deploymentRefs.length > 0) {
      const known = new Set(
        (await ctx.store.listDeployments({ workspace: ctx.workspace })).map(
          (d) => d.deployment_id,
        ),
      );
      resolvable = deploymentRefs.some((r) => known.has(r));
    }
    if (!resolvable) {
      for (const t of ticketRefs) {
        const ticket = await ctx.store.getTicket({
          workspace: ctx.workspace,
          ticket_id: t,
        });
        if (ticket) {
          resolvable = true;
          break;
        }
      }
    }
    if (!resolvable) {
      throw new TelemetryServiceError(
        'invalid',
        `resolve evidence for ${args.id} does not resolve — no listed deployment id, ticket, or PR exists in this workspace`,
      );
    }
  }

  const at = ctx.now().toISOString();
  const result = await ctx.store.transaction(async (tx) => {
    if (args.action === 'resolve' && args.evidence) {
      const ev = args.evidence;
      const patch: Parameters<typeof tx.updateIncident>[1] = {};
      if (ev.root_cause != null) patch.root_cause = ev.root_cause;
      if (ev.resolution != null) patch.resolution = ev.resolution;
      if (ev.deployment_refs) patch.deployment_refs = ev.deployment_refs;
      if (ev.ticket_refs) patch.ticket_refs = ev.ticket_refs;
      if (ev.pr_refs) patch.pr_refs = ev.pr_refs;
      await tx.updateIncident({ workspace: ctx.workspace, id: args.id }, patch);
    }
    const r = await tx.decideIncident(
      { workspace: ctx.workspace, id: args.id },
      args.expected ?? null,
      next,
      at,
    );
    if (r.state !== 'updated') return r;
    const seq =
      (
        await tx.listIncidentDecisions({
          workspace: ctx.workspace,
          incident_id: args.id,
        })
      ).length + 1;
    await tx.appendIncidentDecision({
      workspace: ctx.workspace,
      incident_id: args.id,
      seq,
      status: next,
      actor: ctx.actor,
      rationale: args.rationale ?? null,
      at,
    });
    await tx.appendEvent({
      workspace: ctx.workspace,
      ticket_id: null,
      ts: at,
      stage: null,
      actor_type: 'human',
      actor_id: ctx.actor,
      event: 'incident_decided',
      run: null,
      refs: [`incident:${args.id}`, `signature:${prior.signature_id}`],
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
      data: {
        id: args.id,
        action: args.action,
        prior: prior.status,
        status: next,
        rationale: args.rationale ?? null,
      },
    });
    return r;
  });
  if (result.state === 'missing') {
    throw new TelemetryServiceError(
      'missing',
      `no incident '${args.id}' in ${ctx.workspace}`,
    );
  }
  if (result.state === 'conflict') {
    throw new TelemetryServiceError(
      'conflict',
      `stale write: expected status '${args.expected}', incident is '${result.current ?? 'unset'}'`,
      result.current,
    );
  }
  const updated = await ctx.store.getIncident({
    workspace: ctx.workspace,
    id: args.id,
  });
  return updated ?? { ...prior, status: next };
}

// ---------------------------------------------------------------------------
// draft-ticket gate — proposals only until a human approves
// ---------------------------------------------------------------------------

export interface ProposeDraftTicketArgs {
  incident_id: string;
  title: string;
  body?: string | null | undefined;
  /** Advisory draft fields (work_type/severity/repos/…). */
  draft?: Record<string, unknown> | undefined;
  created_by?: string | undefined;
}

export async function proposeDraftTicket(
  ctx: TelemetryCtx,
  args: ProposeDraftTicketArgs,
): Promise<{ id: string }> {
  const incident = await ctx.store.getIncident({
    workspace: ctx.workspace,
    id: args.incident_id,
  });
  if (!incident) {
    throw new TelemetryServiceError(
      'missing',
      `no incident '${args.incident_id}' in ${ctx.workspace}`,
    );
  }
  if (!args.title?.trim()) {
    throw new TelemetryServiceError('invalid', 'proposal title is required');
  }
  const nowIso = ctx.now().toISOString();
  const id = `prop_${randomUUID().slice(0, 12)}`;
  await ctx.store.insertIncidentTicketProposal({
    workspace: ctx.workspace,
    id,
    incident_id: args.incident_id,
    title: args.title.trim(),
    body: args.body ?? null,
    draft: args.draft ?? {},
    status: 'draft',
    board_item_id: null,
    decided_by: null,
    decided_at: null,
    created_by: args.created_by ?? ctx.actor,
    created_at: nowIso,
    updated_at: nowIso,
  });
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: null,
    ts: nowIso,
    stage: null,
    actor_type: 'system',
    actor_id: ctx.actor,
    event: 'draft_ticket_proposed',
    run: null,
    refs: [`incident:${args.incident_id}`, `proposal:${id}`],
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
    data: { incident: args.incident_id, proposal: id, title: args.title },
  });
  return { id };
}

export interface DecideDraftTicketArgs {
  id: string;
  action: 'approve' | 'reject';
  expected: 'draft' | 'approved' | 'rejected' | null | undefined;
  rationale?: string | null | undefined;
}

/**
 * The human gate. `approve` creates ONE capture-tray board item
 * (`board: null`, kind `ticket`, provenance `inferred` — ai/incident
 * proposals never auto-approve; retro-proposal parity) inside the same
 * transaction as the OCC status move, then emits
 * `draft_ticket_decided`. `reject` retires the proposal; nothing else
 * is written. Repeat decisions are idempotent noops.
 */
export async function decideDraftTicket(
  ctx: TelemetryCtx,
  args: DecideDraftTicketArgs,
): Promise<{
  proposal_id: string;
  status: string;
  board_item_id: string | null;
}> {
  const next = args.action === 'approve' ? 'approved' : 'rejected';
  const prior = await ctx.store.getIncidentTicketProposal({
    workspace: ctx.workspace,
    id: args.id,
  });
  if (!prior) {
    throw new TelemetryServiceError(
      'missing',
      `no ticket proposal '${args.id}' in ${ctx.workspace}`,
    );
  }
  if (prior.status === next) {
    return {
      proposal_id: prior.id,
      status: prior.status,
      board_item_id: prior.board_item_id ?? null,
    };
  }

  const at = ctx.now().toISOString();
  let boardItemId: string | null = null;
  const result = await ctx.store.transaction(async (tx) => {
    if (args.action === 'approve') {
      const item: BoardItem = {
        id: `bi-${randomUUID().slice(0, 12)}`,
        workspace: ctx.workspace,
        board: null, // capture tray — a human triages it onward (D27)
        kind: 'ticket',
        ref: prior.incident_id,
        title: prior.title,
        body: prior.body ?? null,
        status: 'icebox',
        consumed_by: null,
        applies_to: [prior.incident_id],
        provenance: 'inferred', // incident-sourced — never auto-approves
        created_at: at,
        updated_at: at,
      };
      await tx.upsertBoardItem(item);
      boardItemId = item.id;
    }
    const r = await tx.decideIncidentTicketProposal(
      { workspace: ctx.workspace, id: args.id },
      args.expected ?? null,
      next,
      at,
      ctx.actor,
      boardItemId,
    );
    if (r.state !== 'updated') return r;
    await tx.appendEvent({
      workspace: ctx.workspace,
      ticket_id: null,
      ts: at,
      stage: null,
      actor_type: 'human',
      actor_id: ctx.actor,
      event: 'draft_ticket_decided',
      run: null,
      refs: [
        `incident:${prior.incident_id}`,
        `proposal:${args.id}`,
        ...(boardItemId ? [`board_item:${boardItemId}`] : []),
      ],
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
      data: {
        proposal: args.id,
        incident: prior.incident_id,
        action: args.action,
        prior: prior.status,
        status: next,
        board_item_id: boardItemId,
        rationale: args.rationale ?? null,
      },
    });
    return r;
  });
  if (result.state === 'missing') {
    throw new TelemetryServiceError(
      'missing',
      `no ticket proposal '${args.id}' in ${ctx.workspace}`,
    );
  }
  if (result.state === 'conflict') {
    throw new TelemetryServiceError(
      'conflict',
      `stale write: expected status '${args.expected}', proposal is '${result.current ?? 'unset'}'`,
      result.current,
    );
  }
  return { proposal_id: args.id, status: next, board_item_id: boardItemId };
}
