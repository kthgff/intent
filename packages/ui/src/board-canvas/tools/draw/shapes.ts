/**
 * tools/draw/shapes.ts — annotation geometry → SVG rendering
 * (BOARD-CANVAS-TOOLS-TDD §2.6).
 *
 * Every annotation kind reduces to a single SVG `<path>` `d` string —
 * one renderer handles strokes, highlights, rects, ellipses, and
 * arrows uniformly. Arrows get a small computed arrowhead appended to
 * the shaft path so no marker defs are needed.
 */
import type { AnnotationGeometry, BoardAnnotation } from '@veto/core';
import { pointsToPath } from './strokes';

const HEAD = 12; // arrowhead arm length in flow px
const HEAD_ANGLE = Math.PI / 7; // ~25° off the shaft

function arrowPath(g: { x1: number; y1: number; x2: number; y2: number }): string {
  const angle = Math.atan2(g.y2 - g.y1, g.x2 - g.x1);
  const wing = (sign: 1 | -1) => {
    const a = angle + sign * HEAD_ANGLE;
    return `L ${g.x2 - HEAD * Math.cos(a)} ${g.y2 - HEAD * Math.sin(a)}`;
  };
  return (
    `M ${g.x1} ${g.y1} L ${g.x2} ${g.y2} ` +
    `${wing(1)} M ${g.x2} ${g.y2} ${wing(-1)}`
  );
}

function ellipsePath(g: { x: number; y: number; w: number; h: number }): string {
  const rx = g.w / 2;
  const ry = g.h / 2;
  const cx = g.x + rx;
  const cy = g.y + ry;
  return (
    `M ${cx - rx} ${cy} ` +
    `A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} ` +
    `A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
  );
}

function rectPath(g: { x: number; y: number; w: number; h: number }): string {
  return `M ${g.x} ${g.y} h ${g.w} v ${g.h} h ${-g.w} Z`;
}

/** Geometry → SVG path `d`. Unknown kind/geometry pairings return
 *  null — the layer skips malformed rows instead of mis-drawing them. */
export function annotationToPath(
  kind: BoardAnnotation['kind'],
  geometry: AnnotationGeometry,
): string | null {
  if ('pts' in geometry) {
    return kind === 'stroke' || kind === 'highlight'
      ? pointsToPath(geometry.pts)
      : null;
  }
  if ('x1' in geometry) {
    return kind === 'arrow' ? arrowPath(geometry) : null;
  }
  if (kind === 'rect') return rectPath(geometry);
  if (kind === 'ellipse') return ellipsePath(geometry);
  return null;
}

/** Presentation attributes per kind — highlighter strokes render wide
 *  and translucent behind content. */
export function strokeAttrs(ann: Pick<BoardAnnotation, 'kind'>): {
  width: number;
  opacity: number;
} {
  switch (ann.kind) {
    case 'highlight':
      return { width: 22, opacity: 0.35 };
    case 'stroke':
      return { width: 3, opacity: 0.9 };
    default:
      return { width: 3, opacity: 1 };
  }
}
