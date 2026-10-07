/**
 * table.ts — Easy Edit's pure row projection (D62, EASY-EDIT-TDD
 * "Row contract").
 *
 * Rows derive from durable `board_items` — this module reads no
 * geometry, never writes, and holds no state. Unlike the canvas
 * projection it keeps `discarded` items (the audit surface must not
 * hide them) and splits rows into board vs tray sections.
 */
import type { BoardItem } from '@veto/core';
import { isConsumedItem } from '../discovery';

export interface TableRow {
  item: BoardItem;
  /** consumed | frozen — supersede-only, never editable here. */
  locked: boolean;
  section: 'board' | 'tray';
}

export type SortKey =
  | 'kind'
  | 'text'
  | 'note_kind'
  | 'status'
  | 'importance'
  | 'updated_at';

export type SortDir = 'asc' | 'desc';

export interface ViewFilter {
  search: string;
  /** A `board_items.kind` value, `'tray'` (tray-only view), or null. */
  kind: string | null;
  note_kind: string | null;
  status: string | null;
  importance: string | null;
  /** Whether the tray section renders at all. */
  showTray: boolean;
}

export const DEFAULT_FILTER: ViewFilter = {
  search: '',
  kind: null,
  note_kind: null,
  status: null,
  importance: null,
  showTray: true,
};

export interface SurfaceLike {
  item: BoardItem;
  statements: unknown[];
}

/** Display text for a row — title, else body, else link target. */
export function rowText(item: BoardItem): string {
  return item.title ?? item.body ?? item.ref ?? '';
}

export function projectRows(
  surfaces: SurfaceLike[],
  tray: BoardItem[],
): TableRow[] {
  const rows: TableRow[] = surfaces.map((s) => ({
    item: s.item,
    locked: isConsumedItem(s.item),
    section: 'board' as const,
  }));
  for (const item of tray) {
    rows.push({ item, locked: isConsumedItem(item), section: 'tray' });
  }
  return rows;
}

function matchesSearch(item: BoardItem, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    (item.title ?? '').toLowerCase().includes(needle) ||
    (item.body ?? '').toLowerCase().includes(needle) ||
    (item.ref ?? '').toLowerCase().includes(needle)
  );
}

function visible(row: TableRow, f: ViewFilter): boolean {
  const { item } = row;
  if (f.kind === 'tray') {
    if (row.section !== 'tray') return false;
  } else {
    if (row.section === 'tray' && !f.showTray) return false;
    if (f.kind != null && item.kind !== f.kind) return false;
  }
  if (f.note_kind != null && item.note_kind !== f.note_kind) return false;
  if (f.status != null && item.status !== f.status) return false;
  if (f.importance != null && item.importance !== f.importance) {
    return false;
  }
  return matchesSearch(item, f.search);
}

const cmpStr = (a: string, b: string) => a.localeCompare(b);

/** Deterministic comparator — primary key, then row text, then id. */
function compare(key: SortKey): (a: TableRow, b: TableRow) => number {
  const tie = (a: TableRow, b: TableRow) =>
    cmpStr(rowText(a.item), rowText(b.item)) || cmpStr(a.item.id, b.item.id);
  const prim = (a: TableRow, b: TableRow): number => {
    const ia = a.item;
    const ib = b.item;
    switch (key) {
      case 'kind':
        return cmpStr(ia.kind, ib.kind);
      case 'text':
        return cmpStr(rowText(ia), rowText(ib));
      case 'note_kind':
        return cmpStr(ia.note_kind ?? '', ib.note_kind ?? '');
      case 'status':
        return cmpStr(ia.status, ib.status);
      case 'importance':
        return cmpStr(ia.importance ?? '', ib.importance ?? '');
      case 'updated_at':
        return cmpStr(ia.updated_at ?? '', ib.updated_at ?? '');
    }
  };
  return (a, b) => prim(a, b) || tie(a, b);
}

/** Filter + sort the projection. Section is preserved on each row —
 *  callers render board rows then the tray section. */
export function applyView(
  rows: TableRow[],
  filter: ViewFilter,
  sort: SortKey,
  dir: SortDir,
): TableRow[] {
  const out = rows.filter((r) => visible(r, filter)).sort(compare(sort));
  if (dir === 'desc') out.reverse();
  return out;
}

/** Largest row count rendered — a display guard, not a data limit. */
export const ROW_CAP = 500;
