/**
 * assistant/placement.ts — `computePlacement` (TDD "Placement").
 *
 * Pure + deterministic: same inputs → same coordinates, no LLM
 * participation. Ordering per the TDD:
 *   1. `zone` → first free 32px-grid cell inside the zone's rect;
 *   2. `anchors` → right of the anchor cluster bbox (+24px), top edge;
 *   3. else → below the content bbox (+24px), column-flowed.
 * Collision-avoid nudges along the grid until the candidate overlaps
 * neither items nor already-placed pending-proposal rects.
 */
import type { BoardItem } from '@veto/core';

export const PLACE = { grid: 32, gap: 24, w: 240, h: 120 } as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacementArgs {
  /** Board items — tray rows (null x/y) and non-positioned kinds are
   *  ignored; `zone`/`anchor` values resolve against this list. */
  items: Pick<
    BoardItem,
    'id' | 'x' | 'y' | 'w' | 'h' | 'zone' | 'kind' | 'status'
  >[];
  /** Rects claimed by pending proposals drafted earlier in the turn —
   *  the collision set grows as a batch places. */
  placed?: Rect[];
  /** Target zone item id (op.zone). */
  zone?: string | null;
  /** Anchor item ids (op.anchor / the expand selection). */
  anchors?: string[];
  /** Proposed card size (defaults to the standard sticky). */
  w?: number;
  h?: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function itemRect(i: PlacementArgs['items'][number]): Rect | null {
  if (i.x == null || i.y == null || i.status !== 'active') return null;
  return { x: i.x, y: i.y, w: i.w ?? PLACE.w, h: i.h ?? PLACE.h };
}

const bbox = (rects: Rect[]): Rect | null => {
  if (rects.length === 0) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
};

/**
 * Compute a non-overlapping placement. Throws nothing — a pathological
 * board falls back to a far-right column rather than looping forever.
 */
export function computePlacement(args: PlacementArgs): {
  x: number;
  y: number;
} {
  const w = args.w ?? PLACE.w;
  const h = args.h ?? PLACE.h;
  // Zones are containers, not obstacles — a zone's own rect can never
  // block a cell inside it (or skew the content bbox).
  const rects = args.items
    .filter((i) => i.kind !== 'zone')
    .map(itemRect)
    .filter((r): r is Rect => r !== null);
  const occupied = [...rects, ...(args.placed ?? [])];
  const free = (r: Rect) => !occupied.some((o) => overlaps(r, o));
  const snap = (v: number) => Math.round(v / PLACE.grid) * PLACE.grid;

  // 1. Inside the target zone — first free grid cell, row-major.
  const zone = args.zone
    ? args.items.find((i) => i.id === args.zone && i.kind === 'zone')
    : null;
  const zr = zone ? itemRect(zone) : null;
  if (zr) {
    for (let y = zr.y; y + h <= zr.y + zr.h; y += PLACE.grid) {
      for (let x = zr.x; x + w <= zr.x + zr.w; x += PLACE.grid) {
        if (free({ x, y, w, h })) return { x, y };
      }
    }
    // Zone full → fall through to the anchor/fallback rules.
  }

  // 2. Right of the anchor cluster, top-aligned.
  const anchorRects = (args.anchors ?? [])
    .map((id) => args.items.find((i) => i.id === id))
    .filter((i): i is PlacementArgs['items'][number] => i !== undefined)
    .map(itemRect)
    .filter((r): r is Rect => r !== null);
  const ab = bbox(anchorRects);
  if (ab) {
    const x = snap(ab.x + ab.w + PLACE.gap);
    for (let y = ab.y, n = 0; n < 5000; y += PLACE.grid, n++) {
      if (free({ x, y, w, h })) return { x, y };
    }
  }

  // 3. Below the content bbox, column-flowed from the left edge.
  const cb = bbox(rects);
  const x = cb ? snap(cb.x) : 0;
  const startY = cb ? cb.y + cb.h + PLACE.gap : 0;
  for (let y = startY, n = 0; n < 5000; y += PLACE.grid, n++) {
    if (free({ x, y, w, h })) return { x, y };
  }
  return { x: (cb?.x ?? 0) + (cb?.w ?? 0) + PLACE.gap, y: startY };
}
