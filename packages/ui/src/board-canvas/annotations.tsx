/**
 * annotations.tsx — the drawing layer (BOARD-CANVAS-TOOLS-TDD §2.6).
 *
 * Annotations are `board_annotations` rows rendered as ONE SVG layer
 * inside the flow viewport, *behind* nodes — they never join
 * selection/connect/fit semantics. The capture surface is a
 * transient overlay: pointer → polyline in flow coords, RDP-simplified
 * once at gesture end, then a single durable POST. No writes happen
 * per pointer-move.
 */
import type { BoardAnnotation } from '@veto/core';
import { useReactFlow, ViewportPortal } from '@xyflow/react';
import { useCallback, useRef, useState } from 'react';
import type { DrawKind } from './model';
import {
  finalizeShape,
  finalizeStroke,
  type Pt,
  pointsToPath,
} from './tools/draw/strokes';
import { annotationToPath, strokeAttrs } from './tools/draw/shapes';

/** Absolute bounds of an annotation's geometry — used by the Board
 *  objects list to locate drawings without spatial navigation. */
export function annotationBounds(
  a: Pick<BoardAnnotation, 'kind' | 'geometry'>,
): { x: number; y: number; w: number; h: number } | null {
  const g = a.geometry;
  if ('pts' in g && Array.isArray(g.pts)) {
    const pts = g.pts as { x: number; y: number }[];
    if (pts.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if ('x1' in g) {
    const x = Math.min(g.x1, g.x2);
    const y = Math.min(g.y1, g.y2);
    return { x, y, w: Math.abs(g.x2 - g.x1), h: Math.abs(g.y2 - g.y1) };
  }
  if ('x' in g && 'w' in g) {
    return { x: g.x, y: g.y, w: g.w, h: g.h };
  }
  return null;
}

const COLOR_CLASS: Record<string, string> = {
  yellow: 'ann-yellow',
  pink: 'ann-pink',
  blue: 'ann-blue',
  green: 'ann-green',
  orange: 'ann-orange',
  purple: 'ann-purple',
  gray: 'ann-gray',
};

/**
 * Saved annotations + the in-progress stroke, inside the transformed
 * viewport (flow coordinates), below the node layer.
 */
export function AnnotationLayer({
  annotations,
  selectedId,
  onSelect,
  livePath,
  liveKind,
}: {
  annotations: BoardAnnotation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  livePath?: string | null;
  liveKind?: DrawKind;
}) {
  return (
    <ViewportPortal>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <svg
        className="canvas-annotation-layer"
        data-testid="annotation-layer"
        aria-hidden={annotations.length === 0 ? true : undefined}
      >
        {annotations.map((a) => {
          const d = annotationToPath(a.kind, a.geometry);
          if (!d) return null;
          const attrs = strokeAttrs(a);
          const cls = `canvas-annotation ${
            COLOR_CLASS[a.color ?? ''] ?? 'ann-ink'
          }${a.kind === 'highlight' ? ' ann-highlight' : ''}`;
          return (
            <g
              key={a.id}
              className={selectedId === a.id ? 'ann-selected' : ''}
            >
              <path
                d={d}
                className={cls}
                strokeWidth={attrs.width}
                opacity={attrs.opacity}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* fat invisible hit path — thin strokes stay clickable */}
              <path
                d={d}
                className="canvas-annotation-hit"
                strokeWidth={Math.max(attrs.width, 16)}
                stroke="transparent"
                fill="none"
                onClick={() => onSelect(a.id)}
              />
            </g>
          );
        })}
        {livePath && (
          <path
            d={livePath}
            className={`canvas-annotation-live${
              liveKind === 'highlight' ? ' ann-highlight' : ''
            }`}
            strokeWidth={liveKind === 'highlight' ? 22 : 3}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </ViewportPortal>
  );
}

/**
 * Full-pane pointer-capture overlay — present only while the draw
 * tool is active. Converts client coords to flow coords, previews the
 * stroke/shape live, and commits one geometry object on pointer-up.
 */
export function DrawCapture({
  drawKind,
  onLive,
  onCommit,
}: {
  drawKind: DrawKind;
  /** Live preview path (null = clear). */
  onLive: (path: string | null) => void;
  onCommit: (geometry: BoardAnnotation['geometry']) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const drawing = useRef(false);
  const pts = useRef<Pt[]>([]);
  const [start, setStart] = useState<Pt | null>(null);
  const isStroke = drawKind === 'stroke' || drawKind === 'highlight';

  const flowPoint = useCallback(
    (e: { clientX: number; clientY: number }): Pt =>
      screenToFlowPosition({ x: e.clientX, y: e.clientY }),
    [screenToFlowPosition],
  );

  const preview = useCallback(
    (next: Pt) => {
      if (isStroke) {
        onLive(pointsToPath([...pts.current, next]));
      } else if (start) {
        const g = finalizeShape(drawKind, start, next);
        onLive(g ? previewPath(drawKind, g) : null);
      }
    },
    [drawKind, isStroke, onLive, start],
  );

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="canvas-draw-capture"
      aria-label="drawing surface — drag to draw"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drawing.current = true;
        const p = flowPoint(e);
        pts.current = [p];
        setStart(p);
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return;
        const p = flowPoint(e);
        // Skip sub-pixel noise so captures stay compact.
        const last = pts.current[pts.current.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
        pts.current.push(p);
        preview(p);
      }}
      onPointerUp={(e) => {
        if (!drawing.current) return;
        drawing.current = false;
        const p = flowPoint(e);
        pts.current.push(p);
        onLive(null);
        const geometry = isStroke
          ? finalizeStroke(pts.current)
          : start
            ? finalizeShape(drawKind, start, p)
            : null;
        pts.current = [];
        setStart(null);
        if (geometry) onCommit(geometry);
      }}
      onPointerCancel={() => {
        drawing.current = false;
        pts.current = [];
        setStart(null);
        onLive(null);
      }}
    />
  );
}

function previewPath(kind: DrawKind, g: BoardAnnotation['geometry']): string {
  if (kind === 'arrow' && 'x1' in g) {
    return `M ${g.x1} ${g.y1} L ${g.x2} ${g.y2}`;
  }
  if ((kind === 'rect' || kind === 'ellipse') && 'w' in g) {
    return `M ${g.x} ${g.y} h ${g.w} v ${g.h} h ${-g.w} Z`;
  }
  return '';
}
