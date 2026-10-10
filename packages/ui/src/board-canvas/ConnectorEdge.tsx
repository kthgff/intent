/**
 * ConnectorEdge.tsx — drawn connector rendering.
 *
 * A connector is a topology *hint* (BOARD-CANVAS-TDD): it never writes
 * to `BoardItem.serves`, the governed goal relation. Rendered as a
 * smooth bezier with an arrow marker and an optional midpoint label;
 * selecting it exposes edit/supersede controls via the canvas-level
 * connector toolbar.
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from '@xyflow/react';
import { memo } from 'react';
import type { CanvasEdge } from './model';

export const ConnectorEdge = memo(function ConnectorEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const label = data?.connector.label;
  const ghost = data?.ghost;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        className={`canvas-connector${selected ? ' selected' : ''}${
          ghost ? ` is-ghost is-ghost-${ghost.treatment}` : ''
        }`}
        style={ghost ? { strokeDasharray: '6 4' } : undefined}
      />
      {(label || ghost) && (
        <EdgeLabelRenderer>
          <div
            className="canvas-connector-label-position"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            <span
              className={`canvas-connector-label${ghost ? ' is-ghost' : ''}`}
              title={
                ghost
                  ? `Proposed ${ghost.proposal.op} — assistant · ${ghost.proposal.created_by}`
                  : (label ?? '')
              }
            >
              {ghost && <span className="badge ghost-proposed">proposed</span>}
              {ghost ? ` ${label ?? ghost.proposal.op}` : label}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
