/**
 * nodes.tsx — Veto's custom React Flow node renderers.
 *
 * Content nodes share stable source/target handle ids (`out`/`in`) so
 * connectors survive re-layouts. Everything semantic (type chip,
 * provenance, importance, statement count, produced-artifact link)
 * renders on the card itself — color is never the only signal.
 *
 * Mutations route through `CanvasActions` context: nodes stay
 * memoizable (their `data` holds only durable row + presentation
 * state) while edits flow to the canvas's OCC-fenced persistence.
 */
import {
  Handle,
  type NodeProps,
  NodeResizer,
  NodeToolbar,
  Position,
} from '@xyflow/react';
import { ExternalLink, ImageOff, Lock } from 'lucide-react';
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { isConsumedItem, noteKindMeta } from '../discovery';
import { type CanvasColor, type CanvasNode, ZONE_MIN_SIZE } from './model';

export type TextField = 'title' | 'body';

/** Actions nodes invoke — stable functions provided by the canvas. */
export interface CanvasActions {
  /** Small-screen / flag-off mode: hide all mutation controls. */
  editable: boolean;
  /** Enter text editing for a node (double-click / Enter). */
  startEdit(id: string): void;
  /** Debounced text autosave while editing (500 ms). */
  saveDraft(id: string, field: TextField, text: string): void;
  /** Blur/commit — flush pending save and leave editing. `baseline`
   *  is the text the editor was seeded with, so an unchanged edit
   *  issues no write (display fallbacks like `title ?? body` must not
   *  become spurious cross-field writes). */
  commitText(id: string, field: TextField, text: string, baseline: string): void;
  /** Explicit color override; null restores the type-derived color. */
  setColor(id: string, color: CanvasColor | null): void;
  /** Create a copy of the item offset beside the original. */
  duplicate(id: string): void;
  /** Open the semantic inspector for this item. */
  inspect(id: string): void;
  /** NodeResizer gesture end — persist bounded geometry. */
  endResize(
    id: string,
    rect: { x: number; y: number; w: number; h: number },
  ): void;
}

const ActionsContext = createContext<CanvasActions | null>(null);
export const CanvasActionsProvider = ActionsContext.Provider;

export function useCanvasActions(): CanvasActions {
  const a = useContext(ActionsContext);
  if (!a) throw new Error('canvas actions outside provider');
  return a;
}

export const CANVAS_COLORS: { id: CanvasColor; label: string }[] = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'pink', label: 'Pink' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
  { id: 'orange', label: 'Orange' },
  { id: 'purple', label: 'Purple' },
  { id: 'gray', label: 'Gray' },
];

function Handles({ locked }: { locked: boolean }) {
  const actions = useCanvasActions();
  if (locked || !actions.editable) return null;
  return (
    <>
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        aria-label="connector target"
      />
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        aria-label="connector source"
      />
    </>
  );
}

/** Single-selection floating toolbar (spec: 10 px above selection,
 *  unscaled by zoom — NodeToolbar gives us both). */
function SelectionToolbar({
  id,
  data,
}: { id: string; data: CanvasNode['data'] }) {
  const actions = useCanvasActions();
  const item = data.item;
  const meta = noteKindMeta(item.note_kind);
  return (
    <NodeToolbar
      isVisible
      position={Position.Top}
      offset={10}
      className="canvas-selection-toolbar"
      aria-label="Selected item actions"
    >
      <span className="toolbar-type" title="Item type">
        {meta.icon} {meta.label}
      </span>
      {item.kind === 'note' && actions.editable && !data.locked && (
        <span className="toolbar-colors" aria-label="sticky color">
          {CANVAS_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-label={`Set color to ${c.label}`}
              aria-pressed={data.color === c.id}
              title={`Set color to ${c.label}`}
              className={`swatch swatch-${c.id}${
                data.color === c.id ? ' active' : ''
              }`}
              onClick={() => actions.setColor(id, c.id)}
            />
          ))}
          {item.color != null && (
            <button
              type="button"
              className="toolbar-btn"
              title="Reset to type color"
              onClick={() => actions.setColor(id, null)}
            >
              Auto
            </button>
          )}
        </span>
      )}
      {!data.locked && actions.editable && (
        <>
          <button
            type="button"
            className="toolbar-btn"
            title="Edit item"
            onClick={() => actions.startEdit(id)}
          >
            Edit
          </button>
          <button
            type="button"
            className="toolbar-btn"
            title="Duplicate item"
            onClick={() => actions.duplicate(id)}
          >
            Duplicate
          </button>
        </>
      )}
      {data.locked && (
        <span className="toolbar-type" title={`Status: ${item.status}`}>
          <Lock size={12} aria-hidden /> Locked
        </span>
      )}
      <button
        type="button"
        className="toolbar-btn"
        title="Open item details"
        onClick={() => actions.inspect(id)}
      >
        Details
      </button>
    </NodeToolbar>
  );
}

/** Shared text surface: read-only paragraph or autosaving textarea. */
export function EditableText({
  id,
  field,
  text,
  editing,
  locked,
  placeholder,
}: {
  id: string;
  field: TextField;
  text: string;
  editing: boolean;
  locked: boolean;
  placeholder: string;
}) {
  const actions = useCanvasActions();
  const [draft, setDraft] = useState(text);
  /** The text the editor was seeded with — the commit baseline. */
  const baseline = useRef(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const wasEditing = useRef(false);
  const canEdit = editing && !locked && actions.editable;
  useEffect(() => {
    if (canEdit && !wasEditing.current && ref.current) {
      setDraft(text);
      baseline.current = text;
      ref.current.focus();
      ref.current.select();
    }
    wasEditing.current = canEdit;
  }, [canEdit, text]);
  if (!canEdit) {
    return (
      <p
        className={`canvas-node-text${text ? '' : ' is-empty'}`}
        onDoubleClick={locked || !actions.editable ? undefined : () => actions.startEdit(id)}
      >
        {text || placeholder}
      </p>
    );
  }
  return (
    <textarea
      ref={ref}
      className="canvas-node-editor nodrag"
      value={draft}
      aria-label={field === 'title' ? 'Item title' : 'Item text'}
      onChange={(e) => {
        setDraft(e.target.value);
        actions.saveDraft(id, field, e.target.value);
      }}
      onBlur={() => actions.commitText(id, field, draft, baseline.current)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          actions.commitText(id, field, draft, baseline.current);
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          actions.commitText(id, field, draft, baseline.current);
        }
      }}
    />
  );
}

function titleOf(data: CanvasNode['data']): string {
  return data.item.title ?? data.item.body ?? '';
}

export const StickyNode = memo(function StickyNode({
  id,
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const { item } = data;
  const meta = noteKindMeta(item.note_kind);
  const consumed = isConsumedItem(item);
  const actions = useCanvasActions();
  return (
    <>
      <NodeResizer
        isVisible={selected && !data.locked && actions.editable}
        minWidth={160}
        minHeight={100}
        onResizeEnd={(_e, p) =>
          actions.endResize(id, { x: p.x, y: p.y, w: p.width, h: p.height })
        }
      />
      {selected && <SelectionToolbar id={id} data={data} />}
      <article
        className={`canvas-note canvas-note-${data.color}${
          data.locked ? ' is-locked' : ''
        }`}
      >
        <span className="canvas-note-kind">
          {meta.icon} {meta.label}
          {item.importance && item.importance !== 'undecided' && (
            <span className="badge">{item.importance}</span>
          )}
          {item.provenance === 'inferred' && (
            <span className="badge attn" title="AI-inferred — confirm needed">
              ~ai
            </span>
          )}
        </span>
        <EditableText
          id={id}
          field="title"
          text={titleOf(data)}
          editing={data.editing}
          locked={data.locked}
          placeholder="Untitled idea"
        />
        <footer className="canvas-note-foot">
          {data.statementCount > 0 &&
            `${data.statementCount} statement${data.statementCount === 1 ? '' : 's'}`}
          {consumed && item.consumed_by && ` · →${item.consumed_by}`}
          {data.virtualZone && ` · ${data.virtualZone}`}
        </footer>
        <Handles locked={data.locked} />
      </article>
    </>
  );
});

export const TextNode = memo(function TextNode({
  id,
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const actions = useCanvasActions();
  return (
    <div className={`canvas-text-node${data.locked ? ' is-locked' : ''}`}>
      <NodeResizer
        isVisible={selected && !data.locked && actions.editable}
        minWidth={120}
        minHeight={48}
        onResizeEnd={(_e, p) =>
          actions.endResize(id, { x: p.x, y: p.y, w: p.width, h: p.height })
        }
      />
      {selected && <SelectionToolbar id={id} data={data} />}
      <EditableText
        id={id}
        field="body"
        text={data.item.body ?? data.item.title ?? ''}
        editing={data.editing}
        locked={data.locked}
        placeholder="Start typing…"
      />
      <Handles locked={data.locked} />
    </div>
  );
});

export const ZoneNode = memo(function ZoneNode({
  id,
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const actions = useCanvasActions();
  return (
    <div className={`canvas-zone-node${data.locked ? ' is-locked' : ''}`}>
      <NodeResizer
        isVisible={selected && !data.locked && actions.editable}
        minWidth={ZONE_MIN_SIZE.w}
        minHeight={ZONE_MIN_SIZE.h}
        onResizeEnd={(_e, p) =>
          actions.endResize(id, { x: p.x, y: p.y, w: p.width, h: p.height })
        }
      />
      {selected && <SelectionToolbar id={id} data={data} />}
      <EditableText
        id={id}
        field="title"
        text={titleOf(data)}
        editing={data.editing}
        locked={data.locked}
        placeholder="Frame"
      />
      <Handles locked={data.locked} />
    </div>
  );
});

function safeHostname(ref: string | null | undefined): string | null {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? u.hostname
      : null;
  } catch {
    return null;
  }
}

export const LinkNode = memo(function LinkNode({
  id,
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const host = safeHostname(data.item.ref);
  const actions = useCanvasActions();
  return (
    <article className={`canvas-link-node${data.locked ? ' is-locked' : ''}`}>
      <NodeResizer
        isVisible={selected && !data.locked && actions.editable}
        minWidth={220}
        minHeight={90}
        onResizeEnd={(_e, p) =>
          actions.endResize(id, { x: p.x, y: p.y, w: p.width, h: p.height })
        }
      />
      {selected && <SelectionToolbar id={id} data={data} />}
      <strong>{data.item.title ?? host ?? 'Link'}</strong>
      {host && <span className="muted">{host}</span>}
      {data.item.ref && host && (
        <a
          href={data.item.ref}
          target="_blank"
          rel="noopener noreferrer"
          className="canvas-link-open nodrag"
          aria-label="Open link in a new tab"
          title="Open link in a new tab"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={14} aria-hidden /> Open
        </a>
      )}
      <EditableText
        id={id}
        field="body"
        text={data.item.body ?? ''}
        editing={data.editing}
        locked={data.locked}
        placeholder="Add a description"
      />
      <Handles locked={data.locked} />
    </article>
  );
});

/** Image uploads are disabled while no patched multipart plugin is
 *  compatible with Fastify 4 (GHSA-vmph-573x-85f6) — the node renders
 *  its caption/title as a placeholder card. */
export const ImageNode = memo(function ImageNode({
  id,
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const actions = useCanvasActions();
  return (
    <article className={`canvas-image-node${data.locked ? ' is-locked' : ''}`}>
      <NodeResizer
        isVisible={selected && !data.locked && actions.editable}
        minWidth={160}
        minHeight={120}
        onResizeEnd={(_e, p) =>
          actions.endResize(id, { x: p.x, y: p.y, w: p.width, h: p.height })
        }
      />
      {selected && <SelectionToolbar id={id} data={data} />}
      <ImageOff size={20} aria-hidden />
      <span>{data.item.title ?? 'Image unavailable'}</span>
      {data.item.body && <span className="muted">{data.item.body}</span>}
      <Handles locked={data.locked} />
    </article>
  );
});
