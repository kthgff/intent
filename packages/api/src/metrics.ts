/**
 * metrics.ts — S-12 aggregate computations for `GET /metrics` (wp-160).
 *
 * Two PRD formulas are implemented here (PRD "Headline metric" +
 * event-fields section):
 *
 * - `deviation_rate = merged tickets with deviation_count ≥ 1 ÷ merged
 *   tickets`; `addenda_per_ticket = Σ deviation_count ÷ merged tickets`.
 *   Per-ticket `deviation_count` = DEVIATIONS.md table entries +
 *   committed TDD `## Addenda` rows at merge — counted literally per
 *   the PRD formula (the implement protocol appends the same row to
 *   both, so a deviation counts twice — the rate uses ≥1 and is
 *   unaffected; addenda intentionally weighs volume).
 * - `human_minutes` = **gate dwell**: gate_items `surfaced_at →
 *   cleared_at` (open items accrue to now) — reported with the PRD's
 *   "honest idle-time caveat": dwell is wall-clock, not attention.
 *
 * Post-merge lifecycle statuses (DB-SCHEMA ticket_repos rollup comment:
 * merged → verifying → released) all count as "merged" for the
 * denominator; `reverted` is included too — a reverted ticket did
 * merge, and its deviations still measure spec-vs-reality disagreement.
 * `?since=<ISO>` bounds the window by each ticket's first
 * `status_changed → <post-merge>` event ts, and bounds gate dwell to
 * items surfaced at/after it.
 */
import type { GateItem, Store } from '@sprint-runner/core';

/** Ticket statuses that mean "reached merge" (DB-SCHEMA post-merge
 *  lifecycle + revert tail). */
const MERGED_STATUSES = new Set([
  'merged',
  'verifying',
  'verify_failed',
  'released',
  'reverted',
]);

// ---------------------------------------------------------------------------
// Pinned markdown pipe-table counting (SCHEMAS §3 Addenda / §8 DEVIATIONS.md)
// ---------------------------------------------------------------------------

const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
const isSepRow = (cells: string[]) =>
  cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));

/** Lines under a `## <name>` heading (any depth ≥2, case-insensitive)
 *  up to the next heading — null when the section is absent. */
function sectionLines(md: string, name: string): string[] | null {
  const wanted = name.trim().toLowerCase();
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{2,6}\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? '');
    if (h?.[1] !== undefined && h[1].trim().toLowerCase() === wanted) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

/**
 * Data rows of the first pipe table in `lines` — the first `|` line is
 * the header (SCHEMAS pinned-header convention); a `| --- |` separator
 * is consumed, never counted. Returns the normalized row strings —
 * callers dedupe across artifact copies (a retried run re-ingests the
 * same worktree file → identical rows).
 */
function tableDataRows(lines: string[]): string[] {
  const rows: string[] = [];
  let i = 0;
  while (i < lines.length && !isTableLine(lines[i] ?? '')) i++;
  if (i >= lines.length) return rows; // no table
  i++; // header
  // Optional separator row.
  if (i < lines.length && isSepRow(splitRow(lines[i] ?? ''))) i++;
  while (i < lines.length && isTableLine(lines[i] ?? '')) {
    rows.push(splitRow(lines[i] ?? '').join(' | '));
    i++;
  }
  return rows;
}

/** Data rows of the first pipe table inside `md`'s `## <name>` section
 *  (or the whole doc when `name` is undefined). 0 when absent. */
export function countTableRows(md: string, name?: string): number {
  const lines = name === undefined ? md.split(/\r?\n/) : sectionLines(md, name);
  if (lines === null) return 0;
  return tableDataRows(lines).length;
}

// ---------------------------------------------------------------------------
// Deviation counting
// ---------------------------------------------------------------------------

const DEVIATIONS_BASENAME = 'DEVIATIONS.md';

/**
 * `deviation_count` for one ticket (PRD formula): distinct DEVIATIONS.md
 * table entries across its runs' artifacts + the latest tdd.md's
 * `## Addenda` row count. Rows dedupe on their normalized text so a
 * retried/re-ingested run can't double-count the accumulated file.
 */
export async function deviationCount(
  store: Store,
  workspace: string,
  ticketId: string,
): Promise<number> {
  const rows = new Set<string>();
  const runs = await store.listRuns({ workspace, ticket_id: ticketId });
  for (const r of runs) {
    for (const a of await store.listArtifacts(r.id)) {
      const base = a.name.split('/').pop() ?? a.name;
      if (base !== DEVIATIONS_BASENAME) continue;
      for (const row of tableDataRows(a.content.split(/\r?\n/))) {
        rows.add(row);
      }
    }
  }
  const tdd = await store.getDoc({
    workspace,
    subject: ticketId,
    doc: 'tdd.md',
  });
  const addenda = tdd ? countTableRows(tdd.content, 'Addenda') : 0;
  return rows.size + addenda;
}

export interface DeviationMetrics {
  merged_tickets: number;
  tickets_with_deviations: number;
  deviations_total: number;
  /** merged-with-deviation ÷ merged (0 when nothing merged yet). */
  deviation_rate: number;
  /** Σ deviation_count ÷ merged (0 when nothing merged yet). */
  addenda_per_ticket: number;
}

/**
 * Deviation metrics over the workspace's merged tickets. `since`
 * (ISO timestamp) windows the denominator by each ticket's first
 * `status_changed → <post-merge>` event ts — a ticket whose merge
 * predates the window drops out entirely.
 */
export async function deviationMetrics(
  store: Store,
  workspace: string,
  since?: string | null,
): Promise<DeviationMetrics> {
  const tickets = (await store.listTickets({ workspace })).filter((t) =>
    MERGED_STATUSES.has(t.status),
  );

  // Merge time = the first status_changed event landing on a post-merge
  // status (the ticket row's updated_at drifts with later edits).
  let mergeAt: Map<string, string> | null = null;
  if (since) {
    mergeAt = new Map();
    for (const e of await store.listEvents({
      workspace,
      event: 'status_changed',
    })) {
      const to = (e.data as { to?: string } | null)?.to;
      if (!to || !MERGED_STATUSES.has(to) || !e.ticket_id) continue;
      const prev = mergeAt.get(e.ticket_id);
      if (!prev || e.ts < prev) mergeAt.set(e.ticket_id, e.ts);
    }
  }

  let withDeviations = 0;
  let total = 0;
  let merged = 0;
  for (const t of tickets) {
    if (mergeAt !== null) {
      const at = mergeAt.get(t.ticket_id);
      if (!at || at < (since as string)) continue;
    }
    merged += 1;
    const n = await deviationCount(store, workspace, t.ticket_id);
    total += n;
    if (n >= 1) withDeviations += 1;
  }
  return {
    merged_tickets: merged,
    tickets_with_deviations: withDeviations,
    deviations_total: total,
    deviation_rate: merged > 0 ? withDeviations / merged : 0,
    addenda_per_ticket: merged > 0 ? total / merged : 0,
  };
}

// ---------------------------------------------------------------------------
// Gate dwell → human_minutes (PRD "captured as gate dwell")
// ---------------------------------------------------------------------------

export interface GateDwellMetrics {
  /** surfaced_at → cleared_at for cleared items (minutes, ≥0). */
  cleared_minutes: number;
  /** surfaced_at → now for still-open items — the in-flight accrual. */
  open_minutes: number;
  /** cleared + open — feeds `totals.human_minutes` (PRD). */
  total_minutes: number;
}

/**
 * Sum gate dwell over gate_items rows — `human_minutes` per the PRD.
 * `since` windows by `surfaced_at`; `now` is injectable for tests.
 * Caveat (PRD): dwell is wall-clock — a gate sitting over a weekend
 * counts in full; snoozed time is not carved out.
 */
export function gateDwell(
  items: GateItem[],
  opts: { now?: Date; since?: string | null } = {},
): GateDwellMetrics {
  const nowMs = (opts.now ?? new Date()).getTime();
  const since = opts.since ?? null;
  let cleared = 0;
  let open = 0;
  for (const item of items) {
    const surfacedMs = Date.parse(item.surfaced_at);
    if (!Number.isFinite(surfacedMs)) continue;
    if (since !== null && item.surfaced_at < since) continue;
    const endMs = item.cleared_at ? Date.parse(item.cleared_at) : nowMs;
    const minutes = Math.max(0, (endMs - surfacedMs) / 60_000);
    if (item.cleared_at) cleared += minutes;
    else open += minutes;
  }
  return {
    cleared_minutes: cleared,
    open_minutes: open,
    total_minutes: cleared + open,
  };
}
