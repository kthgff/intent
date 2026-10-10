/**
 * tools/draw/strokes.ts — pointer → polyline capture math
 * (BOARD-CANVAS-TOOLS-TDD §2.6).
 *
 * Strokes are collected at pointer resolution, then simplified with
 * Ramer–Douglas–Peucker (ε = 1.5 px) before persist. The 2 000-point
 * bound is enforced twice: capture refuses to grow past it, and the
 * API's zod schema hard-rejects oversized payloads.
 */
import type { AnnotationGeometry, StrokeGeometry } from '@veto/core';

export const MAX_STROKE_POINTS = 2000;
export const RDP_EPSILON = 1.5;

export interface Pt {
  x: number;
  y: number;
}

function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // |cross(a→b, a→p)| / |a→b| — distance from p to the line through ab.
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / Math.sqrt(len2);
}

/**
 * Ramer–Douglas–Peucker simplification — keeps endpoints, drops points
 * within `epsilon` of the simplified chord. Iterative (explicit stack)
 * so long strokes can't overflow the call stack.
 */
export function simplifyRDP(pts: Pt[], epsilon = RDP_EPSILON): Pt[] {
  if (pts.length <= 2) return [...pts];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    const a = pts[first] as Pt;
    const b = pts[last] as Pt;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(pts[i] as Pt, a, b);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/** Fail-closed finalize: >MAX points or a degenerate (<2 pts) capture
 *  is rejected rather than persisted as a malformed stroke. */
export function finalizeStroke(pts: Pt[]): StrokeGeometry | null {
  if (pts.length > MAX_STROKE_POINTS || pts.length < 2) return null;
  return { pts: simplifyRDP(pts) };
}

/** Shape-drag finalize: pointer-down + pointer-up → kind geometry.
 *  Degenerate drags (a click, ~zero area) return null. */
export function finalizeShape(
  kind: 'rect' | 'ellipse' | 'arrow',
  start: Pt,
  end: Pt,
): AnnotationGeometry | null {
  if (kind === 'arrow') {
    if (Math.hypot(end.x - start.x, end.y - start.y) < 4) return null;
    return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
  }
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  if (w < 4 || h < 4) return null;
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w,
    h,
  };
}

/** SVG path `d` for a point list (rounded polyline). */
export function pointsToPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  const [first, ...rest] = pts as [Pt, ...Pt[]];
  return `M ${first.x} ${first.y} ` + rest.map((p) => `L ${p.x} ${p.y}`).join(' ');
}
