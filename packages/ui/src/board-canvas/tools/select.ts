/**
 * tools/select.ts — lasso hit-test math (BOARD-CANVAS-TOOLS-TDD §2.2).
 *
 * React Flow already draws the marquee (`selectionOnDrag` +
 * `SelectionMode.Partial`); these pure helpers are the testable half —
 * rect intersection under a pan/zoom transform, node hit-testing in
 * flow coordinates, and the point-drop lookup the comment pin uses.
 * Everything works in *flow* coords: callers convert screen geometry
 * through the viewport transform once, here.
 */
import type { CanvasNode, Rect } from '../model';
import { absoluteRect } from '../model';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Partial-intersection hit-test — a node joins the marquee when any
 *  part of its bounds crosses the rect (RF's `SelectionMode.Partial`
 *  semantics). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Screen-space marquee rect → flow-space rect under the current
 *  pan/zoom (`screenToFlowPosition` applied to both corners). */
export function screenRectToFlow(
  rect: { x1: number; y1: number; x2: number; y2: number },
  vp: Viewport,
): Rect {
  const fx1 = (Math.min(rect.x1, rect.x2) - vp.x) / vp.zoom;
  const fy1 = (Math.min(rect.y1, rect.y2) - vp.y) / vp.zoom;
  const fx2 = (Math.max(rect.x1, rect.x2) - vp.x) / vp.zoom;
  const fy2 = (Math.max(rect.y1, rect.y2) - vp.y) / vp.zoom;
  return { x: fx1, y: fy1, w: fx2 - fx1, h: fy2 - fy1 };
}

/** Ids of nodes whose absolute bounds intersect `rect`. Locked nodes
 *  join the selection on purpose — callers exclude them from writes
 *  and announce the exclusion (TOOLS-TDD §2.2). An empty rect hits
 *  nothing (empty-rect deselect). */
export function nodesInRect(rect: Rect, nodes: CanvasNode[]): string[] {
  if (rect.w <= 0 || rect.h <= 0) return [];
  return nodes
    .filter((n) => rectsIntersect(rect, absoluteRect(n, nodes)))
    .map((n) => n.id);
}

/** The topmost *non-zone* node containing a flow point — the comment
 *  pin's drop target. Zones are containers: a pin inside a frame
 *  attaches to the smallest containing content node, else to the
 *  frame itself, else free-standing. */
export function nodeAtPoint(
  p: { x: number; y: number },
  nodes: CanvasNode[],
): CanvasNode | null {
  const hit = (n: CanvasNode) => {
    const r = absoluteRect(n, nodes);
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  };
  const content = nodes.filter((n) => n.type !== 'zone' && hit(n));
  if (content.length) return content[content.length - 1] ?? null;
  const zones = nodes.filter((n) => n.type === 'zone' && hit(n));
  // Deepest/smallest zone wins (same rule as containingZone).
  let best: { n: CanvasNode; area: number; z: number } | null = null;
  for (const n of zones) {
    const r = absoluteRect(n, nodes);
    const area = r.w * r.h;
    const z = n.data.item.z_index ?? 0;
    if (!best || z > best.z || (z === best.z && area < best.area)) {
      best = { n, area, z };
    }
  }
  return best?.n ?? null;
}
