/**
 * registers/assumptions.ts — the Assumption Register (PRD §15.10,
 * wp-153).
 *
 * Stages record unverified dependencies as `assumptions` rows — owner,
 * affected artifacts, impact-if-false, evidence needed, status. This
 * module owns the register's rules (the store owns the rows):
 *
 *   - capture stamps PROVENANCE: `source` is the run/stage that
 *     recorded it and `affected` can pin spec docs as
 *     `doc:<name>#v<version>` — the version the assumption was
 *     captured against;
 *   - confirm/expire is a HUMAN act for `verified`/`risk-accepted`
 *     (an agent never risk-accepts its own unverified dependency);
 *     `invalidated` may come from a human or the conductor;
 *   - high-impact (`high`) unverified rows gate the `ready`
 *     transition through the DoR engine — lower-impact rows surface
 *     in context but don't block;
 *   - STALE = an `unverified` row whose pinned doc head has advanced
 *     past the captured version. Stale rows revalidate LOUDLY —
 *     `revalidateStaleAssumptions` emits an `assumption_stale` event
 *     per row so the drift lands in the ledger (and the gate payload)
 *     instead of silently rotting.
 */
import type { AssumptionRow, AssumptionStatus, Store } from '@veto/core';

/** Impact levels that block `ready` while unverified (TICKET_PRIORITIES
 *  enum — 'high' is the top tier). */
const BLOCKING_IMPACTS = new Set(['high']);

/** Provenance pin recorded in `affected` — `doc:<name>#v<version>`. */
export const DOC_PIN_RE = /^doc:(\S+)#v(\d+)$/;

export interface AssumptionCtx {
  store: Store;
  workspace: string;
  actor: string;
  now: () => Date;
}

/** Build `doc:<name>#v<version>` pins for the subject's current doc
 *  heads — called at capture time so staleness is detectable later. */
export async function pinDocVersions(
  store: Store,
  workspace: string,
  subject: string,
  docs: readonly string[] = ['ticket.md', 'rs.md'],
): Promise<string[]> {
  const pins: string[] = [];
  for (const doc of docs) {
    const head = await store.getDoc({ workspace, subject, doc });
    if (head) pins.push(`doc:${doc}#v${head.version}`);
  }
  return pins;
}

/** Record an assumption (idempotent upsert). `affected` should carry
 *  the artifact refs plus any `doc:*#v*` pins the caller captured. */
export async function captureAssumption(
  ctx: AssumptionCtx,
  row: Omit<
    AssumptionRow,
    'workspace' | 'status' | 'created_at' | 'updated_at'
  > & {
    status?: AssumptionStatus;
  },
): Promise<AssumptionRow> {
  const ts = ctx.now().toISOString();
  const full: AssumptionRow = {
    ...row,
    workspace: ctx.workspace,
    status: row.status ?? 'unverified',
    created_at: ts,
    updated_at: ts,
  };
  await ctx.store.upsertAssumption(full);
  return full;
}

/**
 * Human confirmation of an assumption. `verified` and `risk-accepted`
 * require `actorKind === 'human'` — a machine never certifies its own
 * guesses; `invalidated` is open to system callers (stale detection,
 * doc drift). Returns the updated row.
 */
export async function confirmAssumption(
  ctx: AssumptionCtx,
  args: {
    assumption_id: string;
    status: 'verified' | 'invalidated' | 'risk-accepted';
    actor: string;
    actorKind?: 'human' | 'agent' | 'system';
    evidence?: string | null;
  },
): Promise<AssumptionRow> {
  // Fail-closed default: an unspecified caller is an AGENT — the API
  // passes 'human' explicitly; absence must never silently grant the
  // human-only statuses.
  const actorKind = args.actorKind ?? 'agent';
  if (
    actorKind !== 'human' &&
    (args.status === 'verified' || args.status === 'risk-accepted')
  ) {
    throw new Error(
      `assumption ${args.assumption_id}: only a human may mark an assumption ${args.status}`,
    );
  }
  const row = await ctx.store.getAssumption({
    workspace: ctx.workspace,
    assumption_id: args.assumption_id,
  });
  if (!row) {
    throw new Error(`no assumption '${args.assumption_id}'`);
  }
  const ts = ctx.now().toISOString();
  const next: AssumptionRow = {
    ...row,
    status: args.status,
    resolved_at: ts,
    updated_at: ts,
  };
  await ctx.store.upsertAssumption(next);
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: row.subject ?? null,
    ts,
    stage: null,
    actor_type: actorKind === 'human' ? 'human' : 'runner',
    actor_id: args.actor,
    event: 'assumption_confirmed',
    run: null,
    refs: [`assumption:${args.assumption_id}`],
    data: {
      status: args.status,
      statement: row.statement,
      evidence: args.evidence ?? null,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  return next;
}

/** Unverified, high-impact rows for a subject — the DoR blockers. */
export function blockingAssumptions(
  rows: readonly AssumptionRow[],
): AssumptionRow[] {
  return rows.filter(
    (r) => r.status === 'unverified' && BLOCKING_IMPACTS.has(r.impact ?? ''),
  );
}

/**
 * Stale rows: `unverified` assumptions carrying a `doc:*#vN` pin whose
 * current head has moved past vN. Rows without pins are never stale
 * (no baseline to drift from).
 */
export async function staleAssumptions(
  store: Store,
  workspace: string,
  rows: readonly AssumptionRow[],
): Promise<
  { row: AssumptionRow; doc: string; pinned: number; head: number }[]
> {
  const out: {
    row: AssumptionRow;
    doc: string;
    pinned: number;
    head: number;
  }[] = [];
  for (const row of rows) {
    if (row.status !== 'unverified') continue;
    for (const ref of row.affected ?? []) {
      const m = DOC_PIN_RE.exec(ref);
      if (!m) continue;
      const doc = m[1] as string;
      const pinned = Number(m[2]);
      const head = await store.getDoc({
        workspace,
        subject: row.subject ?? '',
        doc,
      });
      if (head && head.version > pinned) {
        out.push({ row, doc, pinned, head: head.version });
      }
    }
  }
  return out;
}

/**
 * Revalidate stale assumptions LOUDLY — one `assumption_stale` event
 * per (row, drifted doc), deduped against already-emitted stale events
 * for the same pin→head pair so a parked ticket doesn't spam the
 * ledger every tick. Returns the rows that re-flagged.
 */
export async function revalidateStaleAssumptions(
  ctx: AssumptionCtx,
  subject: string,
): Promise<
  { row: AssumptionRow; doc: string; pinned: number; head: number }[]
> {
  const rows = await ctx.store.listAssumptions({
    workspace: ctx.workspace,
    subject,
  });
  const stale = await staleAssumptions(ctx.store, ctx.workspace, rows);
  if (stale.length === 0) return stale;
  const events = await ctx.store.listEvents({
    workspace: ctx.workspace,
    ticket_id: subject,
  });
  const flagged = new Set(
    events
      .filter((e) => e.event === 'assumption_stale')
      .map((e) => {
        const d = e.data as Record<string, unknown> | null;
        return `${d?.assumption_id}:${d?.doc}:${d?.head}`;
      }),
  );
  const ts = ctx.now().toISOString();
  const fresh: typeof stale = [];
  for (const s of stale) {
    const key = `${s.row.assumption_id}:${s.doc}:${s.head}`;
    if (flagged.has(key)) continue;
    fresh.push(s);
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: subject,
      ts,
      stage: null,
      actor_type: 'runner',
      actor_id: ctx.actor,
      event: 'assumption_stale',
      run: null,
      refs: [`assumption:${s.row.assumption_id}`],
      data: {
        assumption_id: s.row.assumption_id,
        statement: s.row.statement,
        doc: s.doc,
        pinned: s.pinned,
        head: s.head,
        reason: 'unverified assumption predates the current spec — revalidate',
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
  return fresh;
}

/** Render the open register for prompt/gate context (`{{CONTEXT_MD}}`,
 *  DoR payloads) — provenance included so the reader can trace where
 *  each assumption came from. */
export function formatAssumptionContext(
  rows: readonly AssumptionRow[],
): string {
  const open = rows.filter(
    (r) => r.status === 'unverified' || r.status === 'risk-accepted',
  );
  if (open.length === 0) return '';
  const lines = open.map((r) => {
    const bits = [`impact=${r.impact ?? 'unspecified'}`, `status=${r.status}`];
    if (r.owner) bits.push(`owner=${r.owner}`);
    if (r.source) bits.push(`source=${r.source}`);
    if (r.impact_if_false) bits.push(`if-false: ${r.impact_if_false}`);
    if (r.evidence_needed) bits.push(`evidence: ${r.evidence_needed}`);
    return `- [${r.assumption_id}] ${r.statement} (${bits.join('; ')})`;
  });
  return `## Assumption register\n${lines.join('\n')}`;
}
