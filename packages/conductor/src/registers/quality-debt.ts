/**
 * registers/quality-debt.ts — the Quality Debt Register (PRD §15.10,
 * wp-153).
 *
 * Accepted risk, deferred refactors, security exceptions, weak tests
 * and doc gaps are `quality_debt` rows with owner + revisit condition +
 * approval trail. This module owns the register's rules:
 *
 *   - `recordQualityDebt` writes a row + audit event (the trail);
 *   - `recordGateWaiver` feeds the register from gate OVERRIDES — a
 *     forced/rs-quality waiver is accepted risk, and it must land in
 *     the register rather than evaporating into an event;
 *   - `expireQualityDebt` flips live rows (`open`/`acknowledged`)
 *     whose `expires_at` has passed to `expired` LOUDLY — an event +
 *     a notification per row, same expiry semantics as the security
 *     exception model (review/security.ts). Safe to call every tick.
 */
import type {
  QualityDebtKind,
  QualityDebtRow,
  Store,
} from '@sprint-runner/core';

export interface DebtCtx {
  store: Store;
  workspace: string;
  actor: string;
  now: () => Date;
}

const LIVE_STATUSES = new Set(['open', 'acknowledged']);

function isExpired(row: QualityDebtRow, now: Date): boolean {
  if (!row.expires_at) return false; // unbounded debt isn't expired —
  // it just stays open (security exceptions REQUIRE expiry, enforced
  // at grant time in review/security.ts).
  const t = Date.parse(row.expires_at);
  return Number.isFinite(t) && t <= now.getTime();
}

async function debtEvent(
  ctx: DebtCtx,
  row: QualityDebtRow,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: row.subject ?? null,
    ts: ctx.now().toISOString(),
    stage: null,
    actor_type: 'runner',
    actor_id: ctx.actor,
    event,
    run: null,
    refs: [`debt:${row.debt_id}`],
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

/** Write a debt row + `quality_debt_recorded` audit event. */
export async function recordQualityDebt(
  ctx: DebtCtx,
  row: Omit<QualityDebtRow, 'workspace' | 'created_at' | 'updated_at'> & {
    kind: QualityDebtKind;
  },
): Promise<QualityDebtRow> {
  const ts = ctx.now().toISOString();
  const full: QualityDebtRow = {
    ...row,
    workspace: ctx.workspace,
    created_at: ts,
    updated_at: ts,
  };
  await ctx.store.upsertQualityDebt(full);
  await debtEvent(ctx, full, 'quality_debt_recorded', {
    debt_id: full.debt_id,
    kind: full.kind,
    title: full.title,
    owner: full.owner ?? null,
    expires_at: full.expires_at ?? null,
  });
  return full;
}

/**
 * Feed the register from a gate OVERRIDE (wp-153: waivers like the
 * `rs-quality` gate_overridden are accepted risk). Idempotent per
 * (subject, gate) — re-waiving the same gate updates the row instead
 * of duplicating it. Owner defaults to the clearing actor.
 */
export async function recordGateWaiver(
  ctx: DebtCtx,
  args: {
    subject: string;
    gate: string;
    actor: string;
    reason?: string | null;
    kind?: QualityDebtKind;
  },
): Promise<QualityDebtRow> {
  const debtId = `waiver:${args.subject}:${args.gate}`;
  const existing = await ctx.store.getQualityDebt({
    workspace: ctx.workspace,
    debt_id: debtId,
  });
  const ts = ctx.now().toISOString();
  const row: QualityDebtRow = {
    workspace: ctx.workspace,
    org: existing?.org ?? null,
    debt_id: debtId,
    subject: args.subject,
    kind: args.kind ?? 'accepted-risk',
    title: `Gate waiver — ${args.gate} on ${args.subject}`,
    body: `${args.reason ?? `gate '${args.gate}' overridden`}\n\n${JSON.stringify({ schema: 1, gate: args.gate })}`,
    owner: existing?.owner ?? args.actor,
    revisit: existing?.revisit ?? `revisit ${args.gate} waiver`,
    expires_at: existing?.expires_at ?? null,
    approved_by: args.actor,
    approved_at: ts,
    consolidated_into: existing?.consolidated_into ?? null,
    status: 'open',
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  };
  await ctx.store.upsertQualityDebt(row);
  await debtEvent(ctx, row, 'quality_debt_recorded', {
    debt_id: row.debt_id,
    kind: row.kind,
    gate: args.gate,
    reason: args.reason ?? null,
    via: 'gate-override',
  });
  return row;
}

/**
 * Expire lapsed debt LOUDLY: live rows past `expires_at` flip to
 * `expired` + audit event + notification (visible in the inbox, not
 * just the ledger). Returns the rows that expired — a no-op when
 * nothing lapsed, so it is safe to call on every tick.
 */
export async function expireQualityDebt(
  ctx: DebtCtx,
  args: { subject?: string } = {},
): Promise<QualityDebtRow[]> {
  const rows = await ctx.store.listQualityDebt({
    workspace: ctx.workspace,
  });
  const now = ctx.now();
  const expired: QualityDebtRow[] = [];
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    if (!isExpired(row, now)) continue;
    if (args.subject && row.subject !== args.subject) continue;
    const ts = now.toISOString();
    const next: QualityDebtRow = {
      ...row,
      status: 'expired',
      updated_at: ts,
    };
    await ctx.store.upsertQualityDebt(next);
    await debtEvent(ctx, next, 'quality_debt_expired', {
      debt_id: row.debt_id,
      kind: row.kind,
      title: row.title,
      owner: row.owner ?? null,
      expires_at: row.expires_at,
    });
    await ctx.store.insertNotification({
      workspace: ctx.workspace,
      subject: row.subject ?? row.debt_id,
      kind: 'quality-debt:expired',
      payload: JSON.stringify({
        debt_id: row.debt_id,
        kind: row.kind,
        title: row.title,
        owner: row.owner ?? null,
        expires_at: row.expires_at,
      }),
      created_at: ts,
      read_at: null,
    });
    expired.push(next);
  }
  return expired;
}
