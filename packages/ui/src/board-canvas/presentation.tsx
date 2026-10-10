/**
 * presentation.tsx — frame-presentation chrome (TOOLS-TDD §2.5).
 *
 * The canvas drives `fitView` stepping; this bar is the accessible
 * control surface — position readout, prev/next, exit. Esc and arrow
 * keys are handled by the canvas keyboard model.
 */
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export function PresentationBar({
  index,
  total,
  title,
  onPrev,
  onNext,
  onExit,
}: {
  index: number;
  total: number;
  title: string;
  onPrev: () => void;
  onNext: () => void;
  onExit: () => void;
}) {
  return (
    <div
      className="canvas-present-bar"
      role="toolbar"
      aria-label="presentation controls"
    >
      <output aria-live="polite" className="canvas-present-count">
        {index + 1} / {total}
      </output>
      <span className="canvas-present-title" title={title}>
        {title || 'Untitled frame'}
      </span>
      <button
        type="button"
        className="toolbar-btn"
        aria-label="Previous frame"
        disabled={index <= 0}
        onClick={onPrev}
      >
        <ChevronLeft size={15} aria-hidden /> Prev
      </button>
      <button
        type="button"
        className="toolbar-btn"
        aria-label="Next frame"
        disabled={index >= total - 1}
        onClick={onNext}
      >
        Next <ChevronRight size={15} aria-hidden />
      </button>
      <button
        type="button"
        className="toolbar-btn"
        aria-label="Exit presentation"
        onClick={onExit}
      >
        <X size={15} aria-hidden /> Exit
      </button>
    </div>
  );
}
