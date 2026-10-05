/**
 * Board derivation helpers (S-01 pipeline board, s-01-board.md).
 *
 * Pure module — screens render the result, tests drive it directly.
 * The server payload already carries `phase`, `attention`, and
 * `drop_targets` per card; this module owns the *display* rules:
 * snoozed cards leave the board, in-column sort is attention-first →
 * priority → age, and Done shows only the ~20 most recent terminal
 * cards behind an expander.
 */
import type { BoardCard, BoardPhase, DropTarget } from './api';

export const BOARD_PHASES: readonly BoardPhase[] = [
  'backlog',
  'spec',
  'build',
  'review',
  'done',
];

export const PHASE_LABEL: Record<BoardPhase, string> = {
  backlog: 'Backlog',
  spec: 'Spec',
  build: 'Build',
  review: 'Review',
  done: 'Done',
};

/** s-01: "Done capped at ~20 recent cards" (D22). */
export const DONE_CAP = 20;

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const prank = (p: string | null | undefined) =>
  PRIORITY_RANK[p ?? 'medium'] ?? 1;

/** Loud badge kinds — failure/escalation emphasis (human-anxiety-first). */
export const LOUD_KINDS = new Set(['failure', 'escalation']);

export function isLoudKind(kind: string): boolean {
  return LOUD_KINDS.has(kind);
}

/** Attention items actually calling now (not snoozed into the future). */
export function liveAttention(
  card: BoardCard,
  nowIso?: string,
): BoardCard['attention'] {
  const now = nowIso ?? new Date().toISOString();
  return card.attention.filter(
    (g) => !g.cleared_at && (!g.snoozed_until || g.snoozed_until <= now),
  );
}

export function hasAttention(card: BoardCard, nowIso?: string): boolean {
  return liveAttention(card, nowIso).length > 0;
}

/**
 * In-column order — attention-first → priority → age (s-01 §4).
 * Mirrors the server's baseline order; kept explicit + testable.
 */
export function sortCards(cards: BoardCard[], nowIso?: string): BoardCard[] {
  return [...cards].sort(
    (a, b) =>
      Number(hasAttention(b, nowIso)) - Number(hasAttention(a, nowIso)) ||
      prank(a.ticket.priority) - prank(b.ticket.priority) ||
      (a.ticket.created_at ?? '').localeCompare(b.ticket.created_at ?? ''),
  );
}

export interface BoardColumn {
  phase: BoardPhase;
  label: string;
  /** Cards to render (sorted; Done is capped). */
  cards: BoardCard[];
  /** Done-column cards hidden behind the "and N more" expander. */
  overflow: BoardCard[];
  /** Total cards in the column before the Done cap. */
  total: number;
}

/**
 * Group cards into the five phase columns. Snoozed cards leave the
 * board entirely (stronger than the inbox tab — D22). Done keeps only
 * the `doneCap` most recently updated cards; `total - cards.length`
 * is the "and N more" expander count.
 */
export function columnsFor(
  cards: BoardCard[],
  opts: { doneCap?: number; nowIso?: string } = {},
): BoardColumn[] {
  const doneCap = opts.doneCap ?? DONE_CAP;
  const visible = cards.filter((c) => !c.snoozed);
  return BOARD_PHASES.map((phase) => {
    const inColumn = visible.filter((c) => c.phase === phase);
    let shown = inColumn;
    let overflow: BoardCard[] = [];
    if (phase === 'done') {
      // Cap selects by recency (terminal cards have no "age in column"
      // pressure); display order still uses the attention-first sort.
      const recent = [...inColumn].sort((a, b) =>
        (b.ticket.updated_at ?? '').localeCompare(a.ticket.updated_at ?? ''),
      );
      shown = recent.slice(0, doneCap);
      overflow = recent.slice(doneCap);
    }
    return {
      phase,
      label: PHASE_LABEL[phase],
      cards: sortCards(shown, opts.nowIso),
      overflow,
      total: inColumn.length,
    };
  });
}

/** The drop target matching a column, if the server allows the drop. */
export function dropTargetFor(
  card: BoardCard,
  column: BoardPhase,
): DropTarget | undefined {
  return card.drop_targets.find((t) => t.column === column);
}

/** Amber WIP warning when a column exceeds its configured soft limit. */
export function wipExceeded(
  phase: BoardPhase,
  count: number,
  limits: Partial<Record<BoardPhase, number>>,
): boolean {
  const limit = limits[phase];
  return limit !== undefined && count > limit;
}

/** Initials for a claim badge (`claimed→K` — s-01 card anatomy). */
export function claimInitials(claimedBy: string): string {
  const parts = claimedBy.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const s =
    parts.length > 1 ? parts.map((p) => p[0]).join('') : claimedBy.slice(0, 2);
  return s.toUpperCase();
}
