/**
 * registers/commitments.ts — Delivery Commitments (PRD §15.6/§15.10,
 * wp-153).
 *
 * `delivery_commitments` rows are VERSIONED committed scope — the
 * store's `commitDeliveryCommitment` allocates `max(version)+1` per
 * commitment under a lock and the table is append-only. This module
 * owns the lifecycle on top:
 *
 *   - `commitScope` — record (a new version of) the committed scope:
 *     features + requirement versions + target + success criteria +
 *     exclusions + accountable owner;
 *   - `advanceCommitment` — status transition as a NEW version
 *     carrying the head's scope (planned ≠ committed ≠ implemented ≠
 *     verified ≠ delivered; history is never rewritten);
 *   - `commitmentDrift` — the radar-visible drift check: the
 *     committed `requirement_versions` (`{ "<subject>/<doc>": v }`)
 *     are compared against current doc heads, and `tickets` entries
 *     against delivered statuses — committed-vs-current, not a score;
 *   - `auditCommitments` — emits `commitment_drift` events for heads
 *     whose drift is non-empty, deduped per drift signature so a
 *     standing drift doesn't spam the ledger.
 */
import { createHash } from 'node:crypto';
import type {
  DeliveryCommitmentRow,
  DeliveryCommitmentStatus,
  Store,
} from '@veto/core';

export interface CommitmentCtx {
  store: Store;
  workspace: string;
  actor: string;
  now: () => Date;
}

/** Ticket statuses that count as delivered for scope-ticket drift. */
const DELIVERED_STATUSES = new Set(['merged', 'verifying', 'released']);

/** Statuses a head may move to — `missed`/`cancelled` are terminal. */
export const COMMITMENT_TRANSITIONS: Record<
  DeliveryCommitmentStatus,
  DeliveryCommitmentStatus[]
> = {
  planned: ['committed', 'cancelled'],
  committed: ['implemented', 'missed', 'cancelled'],
  implemented: ['verified', 'missed'],
  verified: ['delivered', 'missed'],
  delivered: [],
  missed: [],
  cancelled: [],
};

async function commitmentEvent(
  ctx: CommitmentCtx,
  row: DeliveryCommitmentRow,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: null,
    ts: ctx.now().toISOString(),
    stage: null,
    actor_type: 'runner',
    actor_id: ctx.actor,
    event,
    run: null,
    refs: [`commitment:${row.commitment_id}#v${row.version}`],
    data,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
}

/** Record committed scope — appends the next version. */
export async function commitScope(
  ctx: CommitmentCtx,
  args: Omit<
    DeliveryCommitmentRow,
    'workspace' | 'version' | 'status' | 'created_at'
  > & { status?: DeliveryCommitmentStatus },
): Promise<DeliveryCommitmentRow> {
  const row = await ctx.store.commitDeliveryCommitment({
    ...args,
    workspace: ctx.workspace,
    status: args.status ?? 'committed',
    created_by: args.created_by ?? ctx.actor,
    created_at: ctx.now().toISOString(),
  });
  await commitmentEvent(ctx, row, 'commitment_recorded', {
    commitment_id: row.commitment_id,
    version: row.version,
    target: row.target ?? null,
    status: row.status,
  });
  return row;
}

/**
 * Advance a commitment's status as a NEW version (append-only). The
 * transition must be legal per COMMITMENT_TRANSITIONS — fail-closed:
 * an illegal move throws rather than silently rewriting history.
 */
export async function advanceCommitment(
  ctx: CommitmentCtx,
  args: {
    commitment_id: string;
    status: DeliveryCommitmentStatus;
    actor?: string;
  },
): Promise<DeliveryCommitmentRow> {
  const head = await ctx.store.getDeliveryCommitment({
    workspace: ctx.workspace,
    commitment_id: args.commitment_id,
  });
  if (!head) {
    throw new Error(`no delivery commitment '${args.commitment_id}'`);
  }
  const legal =
    COMMITMENT_TRANSITIONS[head.status as DeliveryCommitmentStatus] ?? [];
  if (!legal.includes(args.status)) {
    throw new Error(
      `commitment ${args.commitment_id}: illegal transition ${head.status} → ${args.status}`,
    );
  }
  const row = await ctx.store.commitDeliveryCommitment({
    workspace: ctx.workspace,
    org: head.org ?? null,
    commitment_id: head.commitment_id,
    scope: head.scope,
    target: head.target ?? null,
    success_criteria: head.success_criteria ?? null,
    exclusions: head.exclusions ?? null,
    assumptions: head.assumptions ?? null,
    owner: head.owner ?? null,
    status: args.status,
    created_by: args.actor ?? ctx.actor,
    created_at: ctx.now().toISOString(),
  });
  await commitmentEvent(ctx, row, 'commitment_status', {
    commitment_id: row.commitment_id,
    version: row.version,
    from: head.status,
    to: row.status,
  });
  return row;
}

export interface CommitmentDriftItem {
  kind: 'doc-advanced' | 'doc-missing' | 'ticket-undelivered';
  ref: string;
  detail: string;
}

/**
 * Committed scope vs current truth. `scope.requirement_versions` is a
 * `{ "<subject>/<doc>": <pinned version> }` map — a head that advanced
 * (or vanished) is drift. `scope.tickets` is a list of ticket ids that
 * must be `merged|verifying|released` to satisfy the commitment.
 */
export async function commitmentDrift(
  store: Store,
  workspace: string,
  head: DeliveryCommitmentRow,
): Promise<CommitmentDriftItem[]> {
  const drift: CommitmentDriftItem[] = [];
  const scope = (head.scope ?? {}) as Record<string, unknown>;

  const reqVersions = scope.requirement_versions;
  if (reqVersions && typeof reqVersions === 'object') {
    for (const [ref, pinned] of Object.entries(
      reqVersions as Record<string, unknown>,
    )) {
      const slash = ref.indexOf('/');
      if (slash === -1) continue;
      const subject = ref.slice(0, slash);
      const doc = ref.slice(slash + 1);
      const headDoc = await store.getDoc({ workspace, subject, doc });
      if (!headDoc) {
        drift.push({
          kind: 'doc-missing',
          ref,
          detail: `committed ${ref}@v${String(pinned)} — doc absent`,
        });
      } else if (typeof pinned === 'number' && headDoc.version !== pinned) {
        drift.push({
          kind: 'doc-advanced',
          ref,
          detail: `committed ${ref}@v${pinned} — head now v${headDoc.version}`,
        });
      }
    }
  }

  const tickets = scope.tickets;
  if (Array.isArray(tickets)) {
    for (const t of tickets) {
      if (typeof t !== 'string') continue;
      const row = await store.getTicket({ workspace, ticket_id: t });
      if (!row || !DELIVERED_STATUSES.has(row.status)) {
        drift.push({
          kind: 'ticket-undelivered',
          ref: t,
          detail: `committed ticket ${t} is ${row?.status ?? 'missing'}`,
        });
      }
    }
  }
  return drift;
}

/** Stable signature of a drift set (dedupe key for loud events). */
function driftSignature(drift: readonly CommitmentDriftItem[]): string {
  const raw = drift.map((d) => `${d.kind}:${d.ref}`).join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Audit every non-terminal commitment head for drift — emits one
 * `commitment_drift` event per commitment whose drift signature is
 * new (drift is radar-visible through the event ledger + metrics, per
 * wp-142's surface). Returns the drifting heads.
 */
export async function auditCommitments(
  ctx: CommitmentCtx,
): Promise<{ head: DeliveryCommitmentRow; drift: CommitmentDriftItem[] }[]> {
  const heads = (
    await ctx.store.listDeliveryCommitments({ workspace: ctx.workspace })
  ).filter(
    (h) =>
      !['delivered', 'missed', 'cancelled'].includes(h.status) &&
      h.status !== 'planned',
  );
  const out: { head: DeliveryCommitmentRow; drift: CommitmentDriftItem[] }[] =
    [];
  const prior = await ctx.store.listEvents({ workspace: ctx.workspace });
  const seen = new Set(
    prior
      .filter((e) => e.event === 'commitment_drift')
      .map(
        (e) =>
          `${(e.data as Record<string, unknown>)?.commitment_id}:${(e.data as Record<string, unknown>)?.signature}`,
      ),
  );
  for (const head of heads) {
    const drift = await commitmentDrift(ctx.store, ctx.workspace, head);
    if (drift.length === 0) continue;
    out.push({ head, drift });
    const signature = driftSignature(drift);
    if (seen.has(`${head.commitment_id}:${signature}`)) continue;
    await commitmentEvent(ctx, head, 'commitment_drift', {
      commitment_id: head.commitment_id,
      version: head.version,
      signature,
      drift,
    });
  }
  return out;
}
