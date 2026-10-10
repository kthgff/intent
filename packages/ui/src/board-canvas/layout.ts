/**
 * layout.ts — deterministic placement helpers for the canvas.
 *
 * Two pure jobs (BOARD-CANVAS-TDD "Legacy layout" + "Arrange"):
 *   1. `legacyPositions` — items with null x/y get a repeatable
 *      projected position, grouped by zone then note type, sorted by
 *      stable id. Positions stay transient: reading a board performs
 *      zero writes.
 *   2. `arrange` — the explicit, previewable "Arrange by…" command
 *      computes target positions without mutating anything; the caller
 *      confirms, then issues one atomic batch mutation.
 */
import type { BoardItem } from '@veto/core';

const COLS = 4;
const STEP_X = 260;
const STEP_Y = 220;
const ORIGIN_X = 120;
const ORIGIN_Y = 120;
const GROUP_GAP_X = 120; // horizontal gap between arrange-by groups
const GROUP_HEADER = 60; // y offset inside an arrange group block

function isPositioned(item: BoardItem): boolean {
  return Number.isFinite(item.x) && Number.isFinite(item.y);
}

/** Stable grouping key: real zone membership (a zone item's id) or the
 *  legacy string label — both are just grouping hints here. */
function zoneKey(item: BoardItem): string {
  return item.zone ?? '';
}

/**
 * Projected positions for every unpositioned item, as `id → {x,y}`.
 * Zones sort first (they may be parents); within each zone group items
 * order by note kind then id — the same inputs always produce the same
 * layout, across renders and reloads.
 */
export function legacyPositions(
  items: BoardItem[],
): Map<string, { x: number; y: number }> {
  const pending = items
    .filter((i) => !isPositioned(i))
    .sort((a, b) => {
      if ((a.kind === 'zone') !== (b.kind === 'zone'))
        return a.kind === 'zone' ? -1 : 1;
      const z = zoneKey(a).localeCompare(zoneKey(b));
      if (z !== 0) return z;
      const k = (a.note_kind ?? '').localeCompare(b.note_kind ?? '');
      if (k !== 0) return k;
      return a.id.localeCompare(b.id);
    });

  const out = new Map<string, { x: number; y: number }>();
  pending.forEach((item, i) => {
    out.set(item.id, {
      x: ORIGIN_X + (i % COLS) * STEP_X,
      y: ORIGIN_Y + Math.floor(i / COLS) * STEP_Y,
    });
  });
  return out;
}

export type ArrangeBy = 'type' | 'status' | 'zone';

function arrangeKey(item: BoardItem, by: ArrangeBy): string {
  switch (by) {
    case 'type':
      return item.note_kind ?? item.kind ?? 'untyped';
    case 'status':
      return item.status ?? 'unknown';
    case 'zone':
      return zoneKey(item) || 'no zone';
  }
}

/**
 * Preview positions for an "Arrange by" pass: group blocks laid out
 * horizontally, items gridded inside each block. Positions for locked
 * (consumed/frozen) items are still computed — the caller decides which
 * mutations are legal — but zones keep their own id-keyed spot so
 * membership stays stable.
 */
export function arrange(
  items: BoardItem[],
  by: ArrangeBy,
): Map<string, { x: number; y: number }> {
  const visible = items.filter((i) => i.status !== 'discarded');
  const groups = new Map<string, BoardItem[]>();
  for (const item of visible) {
    const key = arrangeKey(item, by);
    const g = groups.get(key) ?? [];
    g.push(item);
    groups.set(key, g);
  }
  const keys = [...groups.keys()].sort();

  const out = new Map<string, { x: number; y: number }>();
  let blockX = ORIGIN_X;
  for (const key of keys) {
    const members = (groups.get(key) ?? []).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    members.forEach((item, i) => {
      out.set(item.id, {
        x: blockX + (i % COLS) * STEP_X,
        y: ORIGIN_Y + GROUP_HEADER + Math.floor(i / COLS) * STEP_Y,
      });
    });
    const blockW = Math.min(members.length, COLS) * STEP_X;
    blockX += blockW + GROUP_GAP_X;
  }
  return out;
}
