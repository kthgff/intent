import type {
  BoardAnnotation,
  BoardItem,
  BoardVoteSession,
} from '@veto/core';
/**
 * overlays.tsx — the floating chrome around the React Flow surface
 * (BOARD-CANVAS-TDD "Component topology" + BOARD-CANVAS-TOOLS-TDD):
 * the generalized rail lives in `tools/rail.tsx`; this file owns
 * zoom controls, the multi-select bulk bar (D62 verb parity with
 * Easy Edit), the off-canvas "Board objects" list, save/conflict
 * state, comment threads, vote chrome, the timer chip, and the
 * capture-tray dock.
 *
 * Chrome floats *above* the canvas — it never consumes layout space
 * from the work surface.
 */
import { useReactFlow, useViewport } from '@xyflow/react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  CloudOff,
  LoaderCircle,
  Maximize,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Timer,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DictationField } from '../dictation';
import { isConsumedItem, noteKindMeta } from '../discovery';
import type { CanvasNode, DrawKind } from './model';

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const dur = () => (prefersReducedMotion() ? 0 : 160);
  return (
    <div className="canvas-zoom-controls" role="toolbar" aria-label="zoom">
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => void zoomOut({ duration: dur() })}
      >
        <Minus size={15} />
      </button>
      <span aria-live="off">{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => void zoomIn({ duration: dur() })}
      >
        <Plus size={15} />
      </button>
      <button
        type="button"
        aria-label="Fit view"
        title="Fit view"
        onClick={() => void fitView({ padding: 0.25, duration: dur() })}
      >
        <Maximize size={14} />
      </button>
    </div>
  );
}

export type SaveState = 'saved' | 'saving' | 'offline' | 'conflict' | 'idle';

export function SaveBadge({ state }: { state: SaveState }) {
  if (state === 'idle') return null;
  const text =
    state === 'saving'
      ? 'Saving…'
      : state === 'saved'
        ? 'Saved'
        : state === 'conflict'
          ? 'Review conflict'
          : 'Not saved';
  const Icon =
    state === 'saving'
      ? LoaderCircle
      : state === 'saved'
        ? CheckCircle2
        : state === 'conflict'
          ? AlertTriangle
          : CloudOff;
  return (
    <output
      className={`canvas-save canvas-save-${state}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <Icon size={14} aria-hidden />
      {text}
    </output>
  );
}

/** One selection-level toolbar for multi-select; single selections use
 *  the per-node NodeToolbar (stays readable at any zoom).
 *
 * The bulk verbs mirror Easy Edit's set exactly (TOOLS-TDD §2.2/§3
 *  selection parity): status, type, importance, move to tray, discard.
 *  Locked items stay in the lasso but are excluded from writes —
 *  counted and announced, never silently dropped. */
export function MultiSelectBar({
  count,
  lockedCount,
  taxonomy,
  onSetStatus,
  onSetType,
  onSetImportance,
  onMoveTray,
  onDiscard,
  onArrange,
  onClear,
}: {
  count: number;
  lockedCount: number;
  taxonomy: string[];
  onSetStatus: (status: 'active' | 'icebox') => void;
  onSetType: (noteKind: string) => void;
  onSetImportance: (
    importance: 'must' | 'should' | 'nice' | 'undecided',
  ) => void;
  onMoveTray: () => void;
  onDiscard: () => void;
  onArrange: (by: 'type' | 'status' | 'zone') => void;
  onClear: () => void;
}) {
  if (count < 2) return null;
  const mutable = count - lockedCount;
  return (
    <div
      className="canvas-multibar"
      role="toolbar"
      aria-label="selection actions"
    >
      <span className="canvas-selection-count">
        {count} selected
        {lockedCount > 0 && (
          <span className="canvas-locked-note" role="status">
            {' '}
            · {lockedCount} locked unaffected
          </span>
        )}
      </span>
      <label className="muted">
        Status{' '}
        <select
          aria-label="set status"
          defaultValue=""
          disabled={mutable === 0}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'active' || v === 'icebox') onSetStatus(v);
            e.target.value = '';
          }}
        >
          <option value="" disabled>
            Set…
          </option>
          <option value="active">Active</option>
          <option value="icebox">Parked</option>
        </select>
      </label>
      <label className="muted">
        Type{' '}
        <select
          aria-label="set type"
          defaultValue=""
          disabled={mutable === 0}
          onChange={(e) => {
            const v = e.target.value;
            if (v) onSetType(v);
            e.target.value = '';
          }}
        >
          <option value="" disabled>
            Set…
          </option>
          {taxonomy.map((k) => (
            <option key={k} value={k}>
              {noteKindMeta(k).label}
            </option>
          ))}
        </select>
      </label>
      <label className="muted">
        Importance{' '}
        <select
          aria-label="set importance"
          defaultValue=""
          disabled={mutable === 0}
          onChange={(e) => {
            const v = e.target.value;
            if (
              v === 'must' ||
              v === 'should' ||
              v === 'nice' ||
              v === 'undecided'
            ) {
              onSetImportance(v);
            }
            e.target.value = '';
          }}
        >
          <option value="" disabled>
            Set…
          </option>
          {['must', 'should', 'nice', 'undecided'].map((i) => (
            <option key={i} value={i}>
              {i.charAt(0).toUpperCase() + i.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="toolbar-btn"
        disabled={mutable === 0}
        onClick={onMoveTray}
      >
        Move to tray
      </button>
      <label className="muted">
        Arrange{' '}
        <select
          aria-label="arrange by"
          defaultValue=""
          disabled={mutable === 0}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'type' || v === 'status' || v === 'zone') onArrange(v);
            e.target.value = '';
          }}
        >
          <option value="" disabled>
            By…
          </option>
          <option value="type">Type</option>
          <option value="status">Status</option>
          <option value="zone">Frame</option>
        </select>
      </label>
      <button
        type="button"
        className="toolbar-btn danger"
        disabled={mutable === 0}
        onClick={onDiscard}
      >
        Discard
      </button>
      <button type="button" className="toolbar-btn" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

/** Arrange-preview confirmation — positions are staged on the canvas
 *  and only written when confirmed (TOOLS-TDD §3 cluster/auto-layout:
 *  preview before write, undoable, locked never moves). */
export function ArrangePreviewBar({
  count,
  lockedSkipped,
  onConfirm,
  onCancel,
}: {
  count: number;
  lockedSkipped: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="canvas-multibar canvas-arrange-preview"
      role="toolbar"
      aria-label="arrange preview"
    >
      <span className="canvas-selection-count">
        Preview: arrange {count} item{count === 1 ? '' : 's'}
        {lockedSkipped > 0 && (
          <span className="canvas-locked-note">
            {' '}
            · {lockedSkipped} locked stay put
          </span>
        )}
      </span>
      <button type="button" className="toolbar-btn primary" onClick={onConfirm}>
        Apply
      </button>
      <button type="button" className="toolbar-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** Timer chrome — pure client state, nothing persisted (TOOLS-TDD
 *  §2.5). Ticking is `aria-live="off"`; boundary transitions announce
 *  politely through a visually-hidden region. */
export function TimerChip() {
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, '0');
  const announce = (msg: string) => {
    setAnnouncement('');
    // Re-set on the next tick so identical messages still announce.
    requestAnimationFrame(() => setAnnouncement(msg));
  };
  return (
    <div className="canvas-timer" role="group" aria-label="session timer">
      <Timer size={14} aria-hidden />
      <span className="canvas-timer-time" aria-live="off">
        {mm}:{ss}
      </span>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      {running ? (
        <button
          type="button"
          aria-label="Pause timer"
          title="Pause timer"
          onClick={() => {
            setRunning(false);
            announce(`Timer paused at ${mm}:${ss}`);
          }}
        >
          <Pause size={12} aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          aria-label={elapsed > 0 ? 'Resume timer' : 'Start timer'}
          title={elapsed > 0 ? 'Resume timer' : 'Start timer'}
          onClick={() => {
            setRunning(true);
            announce(elapsed > 0 ? 'Timer resumed' : 'Timer started');
          }}
        >
          <Play size={12} aria-hidden />
        </button>
      )}
      <button
        type="button"
        aria-label="Reset timer"
        title="Reset timer"
        disabled={elapsed === 0 && !running}
        onClick={() => {
          setRunning(false);
          setElapsed(0);
          announce('Timer reset');
        }}
      >
        <RotateCcw size={12} aria-hidden />
      </button>
    </div>
  );
}

/** Vote-session chrome (TOOLS-TDD §2.4): open a counting window, or
 *  close the current one. Session control hides in read mode — vote
 *  stamping itself stays available when a session is already open. */
export function VoteSessionChip({
  session,
  totalVotes,
  busy,
  onOpen,
  onClose,
}: {
  session: BoardVoteSession | null;
  totalVotes: number;
  busy: boolean;
  onOpen: () => void;
  onClose: (session: BoardVoteSession) => void;
}) {
  if (!session) {
    return (
      <button
        type="button"
        className="canvas-vote-session"
        disabled={busy}
        onClick={onOpen}
      >
        Start vote session
      </button>
    );
  }
  return (
    <div className="canvas-vote-session open" role="status">
      <span aria-live="polite">Voting open · {totalVotes} votes</span>
      <button
        type="button"
        className="toolbar-btn"
        disabled={busy}
        onClick={() => onClose(session)}
      >
        Close session
      </button>
    </div>
  );
}

/** Stamp picker shown while the vote tool is active. */
export function VoteStampBar({
  stamp,
  onStamp,
}: {
  stamp: 'up' | 'down' | 'question';
  onStamp: (s: 'up' | 'down' | 'question') => void;
}) {
  return (
    <div
      className="canvas-multibar canvas-stamp-bar"
      role="toolbar"
      aria-label="vote stamp"
    >
      <span className="muted">Stamp:</span>
      {(
        [
          { id: 'up', label: 'Up', icon: ArrowUp },
          { id: 'down', label: 'Down', icon: ArrowDown },
          { id: 'question', label: 'Question', icon: CircleHelp },
        ] as const
      ).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={`toolbar-btn${stamp === id ? ' active' : ''}`}
          aria-pressed={stamp === id}
          onClick={() => onStamp(id)}
        >
          <Icon size={13} aria-hidden /> {label}
        </button>
      ))}
    </div>
  );
}

/** Shape picker shown while the draw tool is active. */
export function DrawBar({
  kind,
  onKind,
}: {
  kind: DrawKind;
  onKind: (k: DrawKind) => void;
}) {
  const kinds: { id: DrawKind; label: string }[] = [
    { id: 'stroke', label: 'Pen' },
    { id: 'highlight', label: 'Highlight' },
    { id: 'rect', label: 'Rect' },
    { id: 'ellipse', label: 'Ellipse' },
    { id: 'arrow', label: 'Arrow' },
  ];
  return (
    <div
      className="canvas-multibar canvas-draw-bar"
      role="toolbar"
      aria-label="drawing tool"
    >
      <span className="muted">Draw:</span>
      {kinds.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={`toolbar-btn${kind === id ? ' active' : ''}`}
          aria-pressed={kind === id}
          onClick={() => onKind(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Comment thread popover (TOOLS-TDD §2.3) — the durable comments on
 *  one target, resolve (archives via `note_status='resolved'`, never
 *  deletes), and reply-by-new-pin. */
export function CommentThread({
  thread,
  targetTitle,
  busy,
  onResolve,
  onReply,
  onClose,
}: {
  thread: BoardItem[];
  targetTitle: string;
  busy: boolean;
  onResolve: (comment: BoardItem) => void;
  onReply: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <section
      className="canvas-comment-thread"
      aria-label={`Comments on ${targetTitle}`}
    >
      <div className="row">
        <strong className="canvas-comment-title">
          Comments — {targetTitle}
        </strong>
        <span className="spacer" />
        <button
          type="button"
          className="canvas-icon-button"
          aria-label="Close comment thread"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      {thread.length === 0 && <p className="muted">No comments yet.</p>}
      <ul className="canvas-comment-list">
        {thread.map((c) => {
          const resolved = c.note_status === 'resolved';
          return (
            <li
              key={c.id}
              className={`canvas-comment${resolved ? ' resolved' : ''}`}
            >
              <p>{c.body ?? c.title ?? '(empty comment)'}</p>
              <div className="row">
                {resolved ? (
                  <span className="badge">resolved</span>
                ) : (
                  <button
                    type="button"
                    className="small"
                    disabled={busy}
                    onClick={() => onResolve(c)}
                  >
                    <Check size={12} aria-hidden /> Resolve
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <DictationField>
          <input
            ref={inputRef}
            aria-label="Write a comment"
            placeholder="Add a comment…"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                onReply(draft.trim());
                setDraft('');
              }
              if (e.key === 'Escape') onClose();
            }}
          />
        </DictationField>
        <button
          type="button"
          className="small primary"
          disabled={busy || !draft.trim()}
          onClick={() => {
            onReply(draft.trim());
            setDraft('');
          }}
        >
          Post
        </button>
      </div>
    </section>
  );
}

/** Connector selection controls — rename label or supersede. */
export function ConnectorBar({
  label,
  onRelabel,
  onSupersede,
}: {
  label: string | null | undefined;
  onRelabel: (label: string | null) => void;
  onSupersede: () => void;
}) {
  return (
    <div
      className="canvas-multibar"
      role="toolbar"
      aria-label="connector actions"
    >
      <span className="muted">Connector{label ? ` — ${label}` : ''}</span>
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => {
          const next = window.prompt('Connector label', label ?? '');
          if (next !== null) onRelabel(next.trim() || null);
        }}
      >
        Edit label
      </button>
      <button
        type="button"
        className="toolbar-btn danger"
        onClick={onSupersede}
      >
        Remove
      </button>
    </div>
  );
}

/** Off-canvas object list — the non-spatial access path (a11y):
 *  deterministic reading order, locate + select + edit per object.
 *  Comments and drawings are covered too (TOOLS-TDD §3 — every new
 *  object type needs a non-spatial route). */
export function ObjectsPanel({
  nodes,
  annotations = [],
  onLocate,
  onLocateAnnotation,
  onClose,
}: {
  nodes: CanvasNode[];
  annotations?: BoardAnnotation[];
  onLocate: (id: string) => void;
  onLocateAnnotation?: (a: BoardAnnotation) => void;
  onClose: () => void;
}) {
  const items = nodes.map((n) => n.data.item);
  const sorted = [...items].sort(
    (a, b) =>
      (a.zone ?? '').localeCompare(b.zone ?? '') ||
      (a.note_kind ?? a.kind).localeCompare(b.note_kind ?? b.kind) ||
      a.id.localeCompare(b.id),
  );
  return (
    <aside className="canvas-objects" aria-label="board objects">
      <div className="row">
        <strong>Board objects</strong>
        <span className="spacer" />
        <button
          type="button"
          className="canvas-icon-button"
          aria-label="Close Board objects"
          title="Close Board objects"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      {sorted.length === 0 && <p className="muted">The board is empty.</p>}
      <ul className="list">
        {sorted.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="object-row"
              onClick={() => onLocate(item.id)}
            >
              <span className="object-kind">
                {noteKindMeta(item.note_kind).icon}{' '}
                {item.kind === 'note'
                  ? noteKindMeta(item.note_kind).label
                  : item.kind === 'zone'
                    ? 'frame'
                    : item.kind}
              </span>
              <span className="object-title">
                {item.title ?? item.body ?? '(Untitled)'}
              </span>
              <span className="muted">
                {item.status}
                {isConsumedItem(item) ? ' · locked' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {annotations.length > 0 && onLocateAnnotation && (
        <>
          <div className="row objects-section-head">
            <strong className="muted">Drawings</strong>
          </div>
          <ul className="list">
            {annotations.map((a, i) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="object-row"
                  onClick={() => onLocateAnnotation(a)}
                >
                  <span className="object-kind">✎ {a.kind}</span>
                  <span className="object-title">Drawing {i + 1}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

/** 409 recovery — durable state was restored; an attempted text edit
 *  survives as a recoverable draft, never silently merged. */
export function ConflictNotice({
  draft,
  failedSave = false,
  onRetry,
  onDismiss,
}: {
  draft: string | null;
  failedSave?: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="canvas-conflict"
      role="alert"
      aria-label="edit conflict"
      aria-live="assertive"
    >
      <strong>
        {failedSave
          ? "We couldn't save this edit"
          : 'This item changed elsewhere'}
      </strong>
      <p>
        {failedSave
          ? 'Check your connection and try again.'
          : 'The latest saved version has been requested.'}
        {draft != null && ' Your text is safe below.'}
      </p>
      {draft != null && (
        <pre className="conflict-draft" aria-label="your draft">
          {draft}
        </pre>
      )}
      <div className="row">
        {draft != null && (
          <button type="button" className="small" onClick={onRetry}>
            Save my version
          </button>
        )}
        <button type="button" className="small" onClick={onDismiss}>
          {failedSave ? 'Dismiss' : 'Keep latest'}
        </button>
      </div>
    </div>
  );
}

/** Collapsible capture-tray dock — promote by click or drag onto the
 *  canvas (drop lands at the pointer coordinate, OCC-fenced). */
export function TrayDock({
  items,
  open,
  onToggle,
  onPromote,
  busy,
  readOnly,
}: {
  items: BoardItem[];
  open: boolean;
  onToggle: () => void;
  onPromote: (item: BoardItem) => void;
  busy: boolean;
  readOnly: boolean;
}) {
  return (
    <div
      className={`canvas-tray${open ? ' open' : ''}`}
      aria-label="capture tray"
      aria-busy={busy}
    >
      <button
        type="button"
        className="tray-toggle"
        aria-expanded={open}
        title={open ? 'Collapse capture tray' : 'Expand capture tray'}
        onClick={onToggle}
      >
        <span>Capture tray ({items.length})</span>
        {open ? (
          <ChevronDown size={15} aria-hidden />
        ) : (
          <ChevronUp size={15} aria-hidden />
        )}
      </button>
      {open && (
        <div className="tray-body">
          {items.length === 0 && <span className="muted">Tray is empty.</span>}
          {items.map((i) => (
            <button
              type="button"
              key={i.id}
              className="tray-item"
              disabled={busy || readOnly}
              title={`${i.title ?? i.body ?? i.id} — drag onto the canvas or click to add`}
              draggable={!readOnly}
              onDragStart={(e) =>
                e.dataTransfer.setData('application/x-veto-board-item', i.id)
              }
              onClick={() => onPromote(i)}
            >
              Add {(i.title ?? i.body ?? i.id).slice(0, 40)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
