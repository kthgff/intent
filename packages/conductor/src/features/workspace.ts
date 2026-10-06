/**
 * features/workspace.ts — deterministic Feature Workspace rollups
 * (PRD §15.7, wp-152).
 *
 * Feature Health is an EXPLAINABLE FINDINGS LIST — blockers,
 * unverified ACs, stale approvals, open gates — each carrying evidence
 * refs. It is never an opaque score.
 *
 * The Feature Acceptance Package is the bundle a human reviews before
 * release assignment: the approved scope doc (feature.md) + AC slice
 * (ac.md) + test evidence doc (test.md) + mockups + member-ticket
 * delivery evidence + known exclusions. Acceptance is an explicit
 * human act (`acceptFeature` → `doc_approved` event + status 'done');
 * ticket completion alone NEVER completes a feature (see
 * merge/bookkeeping — the auto-rollup caps at 'active'), and
 * addReleaseItem refuses an unaccepted feature.
 */
import type {
  DocVersion,
  EventName,
  FeatureRow,
  Relation,
  TicketRow,
} from '@veto/core';
import type { TransitionContext } from '../contracts.js';

export type FeatureCtx = TransitionContext;

/** Machine-readable failure codes — API maps them to 4xx. */
export type FeatureErrorCode =
  | 'not-found'
  /** Transition not allowed from the current status. */
  | 'bad-state'
  /** Accept attempted while blocking prerequisites are absent. */
  | 'bad-item';

/** Fail-closed lifecycle error — thrown, never logged-and-continued. */
export class FeatureError extends Error {
  readonly code: FeatureErrorCode;
  constructor(code: FeatureErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FeatureError';
    this.code = code;
  }
}

/** Feature docs the workspace surfaces (DB-SCHEMA doc_versions on the
 *  feature subject). */
export const FEATURE_DOC_KINDS = [
  'feature.md',
  'ac.md',
  'vs.md',
  'mockup.json',
  'notes.md',
] as const;

/** Ticket statuses that count as delivered for health/rollup purposes
 *  (D27 post-merge lifecycle). `shipped` is a feature-level rollup,
 *  never a ticket status. */
const DELIVERED = new Set(['merged', 'verifying', 'released']);
const TICKET_TERMINAL = new Set([
  ...DELIVERED,
  'wont-do',
  'aborted',
  'reverted',
  'split',
  'discarded',
]);

// ---------------------------------------------------------------------------
// Health — explainable findings, evidence-linked, no score
// ---------------------------------------------------------------------------

export interface FeatureFinding {
  /** Stable finding id (deterministic — re-derivation is stable). */
  id: string;
  kind:
    | 'blocked_ticket'
    | 'failed_ticket'
    | 'open_gate'
    | 'unverified_ac'
    | 'stale_approval'
    | 'undelivered_ticket'
    | 'not_accepted'
    | 'no_tickets';
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  /** Evidence refs — ticket ids, gate names, doc subjects. */
  refs: string[];
}

/** AC table row parsed from ac.md (`| ac_id | criterion | … |`). */
export interface FeatureAcRow {
  ac_id: string;
  criterion: string;
  /** Relation edges proving the AC (`tests`/`verified-by`/`implements`
   *  on `ac:<id>` or the feature subject referencing the id). */
  evidence: Relation[];
  verified: boolean;
}

/** Parse `| ac_id | criterion |` rows out of an ac.md/rs.md table —
 *  fail-soft row-wise (a malformed line is skipped, never guessed). */
export function parseAcRows(content: string): FeatureAcRow[] {
  const rows: FeatureAcRow[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || t.startsWith('| ---') || t.startsWith('|---'))
      continue;
    const cells = t
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const id = cells[0] ?? '';
    if (!/^AC-[\w.-]+$/i.test(id)) continue;
    rows.push({
      ac_id: id,
      criterion: cells[1] ?? '',
      evidence: [],
      verified: false,
    });
  }
  return rows;
}

async function requireFeature(
  ctx: FeatureCtx,
  featureId: string,
): Promise<FeatureRow> {
  const feature = await ctx.store.getFeature(ctx.workspace, featureId);
  if (!feature) {
    throw new FeatureError('not-found', `no feature ${featureId}`);
  }
  return feature;
}

/** Member tickets of the feature (tickets.feature = F-NNNN). */
export async function featureTickets(
  ctx: FeatureCtx,
  featureId: string,
): Promise<TicketRow[]> {
  const all = await ctx.store.listTickets({ workspace: ctx.workspace });
  return all.filter((t) => t.feature === featureId);
}

/**
 * The Feature Health findings list (PRD §15.7) — every finding is
 * explainable and evidence-linked; there is deliberately no aggregate
 * number.
 */
export async function featureHealth(
  ctx: FeatureCtx,
  featureId: string,
): Promise<FeatureFinding[]> {
  const feature = await requireFeature(ctx, featureId);
  const tickets = await featureTickets(ctx, featureId);
  const findings: FeatureFinding[] = [];

  if (tickets.length === 0) {
    findings.push({
      id: 'no-tickets',
      kind: 'no_tickets',
      severity: 'info',
      message: 'No member tickets — the feature has no delivery work yet',
      refs: [featureId],
    });
  }
  for (const t of tickets) {
    if (t.status === 'blocked' || t.status === 'failed') {
      findings.push({
        id: `ticket-${t.ticket_id}-${t.status}`,
        kind: t.status === 'blocked' ? 'blocked_ticket' : 'failed_ticket',
        severity: 'blocker',
        message: `${t.ticket_id} is ${t.status}${t.blocked_reason ? ` — ${t.blocked_reason}` : ''}`,
        refs: [t.ticket_id],
      });
    } else if (t.status === 'verify_failed') {
      findings.push({
        id: `ticket-${t.ticket_id}-verify_failed`,
        kind: 'failed_ticket',
        severity: 'blocker',
        message: `${t.ticket_id} failed post-merge verification`,
        refs: [t.ticket_id],
      });
    } else if (!TICKET_TERMINAL.has(t.status)) {
      findings.push({
        id: `ticket-${t.ticket_id}-open`,
        kind: 'undelivered_ticket',
        severity: 'info',
        message: `${t.ticket_id} is still '${t.status}'`,
        refs: [t.ticket_id],
      });
    }
  }

  // Open gate items on the feature subject and its member tickets.
  const members = new Set([featureId, ...tickets.map((t) => t.ticket_id)]);
  const gates = await ctx.store.listGateItems({
    workspace: ctx.workspace,
    open: true,
  });
  for (const g of gates) {
    if (!members.has(g.subject)) continue;
    findings.push({
      id: `gate-${g.subject}-${g.gate}`,
      kind: 'open_gate',
      severity: g.blocked_agent ? 'blocker' : 'warning',
      message: `Open ${g.kind} gate '${g.gate}' on ${g.subject}`,
      refs: [g.subject, g.gate],
    });
  }

  // Unverified ACs — the ac.md rows with no verified traceability edge.
  const acs = await featureAcceptanceCriteria(ctx, featureId);
  for (const ac of acs) {
    if (ac.verified) continue;
    findings.push({
      id: `ac-${ac.ac_id}`,
      kind: 'unverified_ac',
      severity: 'warning',
      message: `${ac.ac_id} has no verified test/traceability evidence`,
      refs: [ac.ac_id, `${featureId}:ac.md`],
    });
  }

  // Stale approvals — a doc_approved event on a feature doc followed by
  // a newer doc_version (§15.8 stale-approval policy applied to the
  // feature's own docs).
  const events = await ctx.store.listEvents({
    workspace: ctx.workspace,
    ticket_id: featureId,
    event: 'doc_approved',
  });
  const docs = await ctx.store.listDocs({
    workspace: ctx.workspace,
    subject: featureId,
  });
  for (const e of events) {
    const doc = (e.data?.doc as string | undefined) ?? null;
    if (doc === null || doc === 'acceptance-package') continue;
    const dv = docs.find((d) => d.doc === doc || d.doc === `${doc}.md`);
    if (dv?.created_at && dv.created_at > e.ts) {
      findings.push({
        id: `stale-approval-${doc}`,
        kind: 'stale_approval',
        severity: 'warning',
        message: `${doc} was edited (v${dv.version}) after its approval — re-review needed`,
        refs: [`${featureId}:${doc}`],
      });
    }
  }

  if (feature.status !== 'done' && feature.status !== 'discarded') {
    findings.push({
      id: 'not-accepted',
      kind: 'not_accepted',
      severity: 'info',
      message:
        'Feature is not accepted — ticket completion never completes a feature (PRD §15.7)',
      refs: [featureId],
    });
  }
  return findings;
}

/**
 * The AC slice (ac.md rows) joined with traceability evidence — an AC
 * is verified when a `verified-by`/`tests`/`implements` relation on
 * `ac:<id>` (or the feature subject referencing the id) is itself
 * `verified`/`auto-verified`, or when a member ticket covering the AC
 * is delivered AND an edge exists. Suggested edges never verify.
 */
export async function featureAcceptanceCriteria(
  ctx: FeatureCtx,
  featureId: string,
): Promise<FeatureAcRow[]> {
  const acDoc = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject: featureId,
    doc: 'ac.md',
  });
  if (!acDoc) return [];
  const rows = parseAcRows(acDoc.content);
  const deliveredMembers = new Set(
    (await featureTickets(ctx, featureId))
      .filter((t) => DELIVERED.has(t.status))
      .map((t) => t.ticket_id),
  );
  for (const row of rows) {
    const edges = await ctx.store.listRelations({
      subject: `ac:${row.ac_id}`,
    });
    const featureEdges = (
      await ctx.store.listRelations({ subject: featureId })
    ).filter((r) => r.object === row.ac_id || r.object === `ac:${row.ac_id}`);
    const all = [...edges, ...featureEdges];
    row.evidence = all;
    const trusted = all.filter(
      (e) =>
        e.verification === 'verified' || e.verification === 'auto-verified',
    );
    row.verified =
      trusted.some((e) =>
        ['verified-by', 'tests', 'implements'].includes(e.predicate),
      ) ||
      (trusted.length > 0 && deliveredMembers.size > 0);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Acceptance package — the human acceptance gate bundle
// ---------------------------------------------------------------------------

export interface AcceptancePackage {
  feature: FeatureRow;
  /** Latest approved scope revision — newest feature.md version +
   *  the doc_approved event that accepted it (null when never
   *  approved). */
  scope: {
    doc: DocVersion | null;
    approved_at: string | null;
    approved_by: string | null;
  };
  /** The AC slice (ac.md) + per-AC evidence state. */
  acceptance_criteria: FeatureAcRow[];
  /** Design/test docs — newest versions (mockups + actual
   *  screens/journeys spec). */
  docs: { doc: string; version: number; created_at: string | null }[];
  /** Member-ticket delivery evidence — status + merged refs. */
  tickets: {
    ticket_id: string;
    title: string;
    status: string;
    delivered: boolean;
    merged_refs: string[];
  }[];
  /** Known exclusions recorded at acceptance (and any prior accepts). */
  exclusions: string[];
  /** The recorded acceptance (null until a human accepts). */
  accepted: { at: string; by: string; exclusions: string[] } | null;
  /** Current health findings — the human judges the package WITH the
   *  findings visible; nothing is hidden. */
  findings: FeatureFinding[];
}

/** Assemble the acceptance package (PRD §15.7 — approved scope
 *  revision + mockups + actual screens/journeys + test evidence +
 *  known exclusions → human acceptance gate). */
export async function assembleAcceptancePackage(
  ctx: FeatureCtx,
  featureId: string,
): Promise<AcceptancePackage> {
  const feature = await requireFeature(ctx, featureId);
  const [featureDoc, docs, tickets, events, findings, acs] = await Promise.all([
    ctx.store.getDoc({
      workspace: ctx.workspace,
      subject: featureId,
      doc: 'feature.md',
    }),
    ctx.store.listDocs({ workspace: ctx.workspace, subject: featureId }),
    featureTickets(ctx, featureId),
    ctx.store.listEvents({ workspace: ctx.workspace, ticket_id: featureId }),
    featureHealth(ctx, featureId),
    featureAcceptanceCriteria(ctx, featureId),
  ]);

  const approvals = events.filter((e) => e.event === 'doc_approved');
  const scopeApproval =
    approvals
      .filter((e) => e.data?.doc === 'feature.md' || e.data?.doc === 'feature')
      .at(-1) ?? null;
  const acceptance =
    approvals.filter((e) => e.data?.doc === 'acceptance-package').at(-1) ??
    null;

  const ticketEvidence = await Promise.all(
    tickets.map(async (t) => {
      const repos = await ctx.store.listTicketRepos({
        workspace: ctx.workspace,
        ticket_id: t.ticket_id,
      });
      return {
        ticket_id: t.ticket_id,
        title: t.title,
        status: t.status,
        delivered: DELIVERED.has(t.status),
        merged_refs: repos
          .filter((r) => r.merged_sha)
          .map((r) => `${r.repo}@${r.merged_sha}`),
      };
    }),
  );

  return {
    feature,
    scope: {
      doc: featureDoc,
      approved_at: scopeApproval?.ts ?? null,
      approved_by: scopeApproval?.actor_id ?? null,
    },
    acceptance_criteria: acs,
    docs: docs.map((d) => ({
      doc: d.doc,
      version: d.version,
      created_at: d.created_at ?? null,
    })),
    tickets: ticketEvidence,
    exclusions: acceptance
      ? ((acceptance.data?.exclusions as string[] | undefined) ?? [])
      : [],
    accepted: acceptance
      ? {
          at: acceptance.ts,
          by: acceptance.actor_id,
          exclusions:
            (acceptance.data?.exclusions as string[] | undefined) ?? [],
        }
      : null,
    findings,
  };
}

/**
 * Explicit human acceptance — the ONLY path to `done`. Records a
 * durable `doc_approved` event bound to the acceptance package
 * (`doc: 'acceptance-package'`, exclusions + member-ticket snapshot in
 * `data`) and flips the feature status to `done`. `discarded` is
 * terminal; accepting an already-`done` feature is a conflict-class
 * bad-state (the event stays the audit, a second accept never
 * double-commits).
 */
export async function acceptFeature(
  ctx: FeatureCtx,
  featureId: string,
  opts: { exclusions?: string[]; actorType?: 'human' } = {},
): Promise<FeatureRow> {
  const feature = await requireFeature(ctx, featureId);
  if (feature.status === 'done') {
    throw new FeatureError(
      'bad-state',
      `feature ${featureId} is already accepted (done)`,
    );
  }
  if (feature.status === 'discarded') {
    throw new FeatureError(
      'bad-state',
      `feature ${featureId} is discarded — acceptance is impossible`,
    );
  }
  const ts = ctx.now().toISOString();
  const tickets = await featureTickets(ctx, featureId);
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: featureId,
    ts,
    stage: null,
    actor_type: opts.actorType ?? 'human',
    actor_id: ctx.actor,
    event: 'doc_approved' satisfies EventName,
    run: null,
    refs: [featureId],
    data: {
      doc: 'acceptance-package',
      exclusions: opts.exclusions ?? [],
      tickets: tickets.map((t) => ({ id: t.ticket_id, status: t.status })),
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  const next: FeatureRow = { ...feature, status: 'done', updated_at: ts };
  await ctx.store.upsertFeature(next);
  return next;
}
