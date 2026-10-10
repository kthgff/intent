/**
 * minimap.tsx — the isolated RF MiniMap wrapper (TOOLS-TDD §2.5).
 *
 * Pure chrome: viewport state stays transient, styled through the
 * existing `--canvas-*` tokens, hidden below 900 px by the caller
 * (read mode keeps chrome minimal per D59).
 */
import { MiniMap } from '@xyflow/react';

export function BoardMinimap() {
  return (
    <MiniMap
      className="canvas-minimap"
      position="bottom-left"
      pannable
      zoomable
      aria-label="board minimap"
    />
  );
}
