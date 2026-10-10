/** Full-page Easy Edit item editor (D68, EASY-EDIT-PRD R2). */
import { BOARD_ITEM_COLORS, type BoardItem, NOTE_STATUSES } from '@veto/core';
import { ArrowLeft, ArrowUpToLine, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DictationField } from '../dictation';
import { noteKindMeta } from '../discovery';
import type { TableRow } from './table';

const SAVE_DEBOUNCE_MS = 500;

export type ItemEditorPatch = Record<string, unknown>;
export interface SaveOutcome {
  ok: boolean;
  conflict: boolean;
}
type SaveState = 'saved' | 'saving' | 'not-saved' | 'conflict';

const SAVE_COPY: Record<SaveState, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  'not-saved': 'Not saved',
  conflict: 'Review conflict',
};

export function ItemEditorPage({
  row,
  boardName,
  taxonomy,
  busy,
  onPatch,
  onPromote,
  onBack,
}: {
  row: TableRow;
  boardName: string;
  taxonomy: string[];
  busy: boolean;
  onPatch: (patch: ItemEditorPatch) => Promise<SaveOutcome>;
  onPromote: () => Promise<unknown>;
  onBack: () => void;
}) {
  const { item, locked } = row;
  const [title, setTitle] = useState(item.title ?? '');
  const [body, setBody] = useState(item.body ?? '');
  const [ref, setRef] = useState(item.ref ?? '');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<ItemEditorPatch>({});
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;

  const write = async (patch: ItemEditorPatch) => {
    if (locked || Object.keys(patch).length === 0) return;
    setSaveState('saving');
    const result = await patchRef.current(patch);
    setSaveState(
      result.ok ? 'saved' : result.conflict ? 'conflict' : 'not-saved',
    );
  };

  const flush = () => {
    if (debounce.current) clearTimeout(debounce.current);
    const patch = pending.current;
    pending.current = {};
    void write(patch);
  };

  const close = () => {
    flush();
    onBack();
  };

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stamp = `${item.id}:${item.updated_at ?? ''}`;
  const lastStamp = useRef(stamp);
  useEffect(() => {
    if (lastStamp.current === stamp || Object.keys(pending.current).length)
      return;
    lastStamp.current = stamp;
    setTitle(item.title ?? '');
    setBody(item.body ?? '');
    setRef(item.ref ?? '');
  }, [stamp, item.title, item.body, item.ref]);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const textPatch = (patch: ItemEditorPatch) => {
    pending.current = { ...pending.current, ...patch };
    setSaveState('saving');
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  const immediate = (patch: ItemEditorPatch) => {
    if (debounce.current) clearTimeout(debounce.current);
    const combined = { ...pending.current, ...patch };
    pending.current = {};
    void write(combined);
  };
  const ro = locked || busy;
  const isNote = item.kind === 'note';
  const isLink = item.kind === 'link';
  const inTray = item.board === null;
  const actionBusy = busy || saveState === 'saving';

  const promoteToBoard = async () => {
    setSaveState('saving');
    try {
      await onPromote();
      setSaveState('saved');
      onBack();
    } catch {
      setSaveState('not-saved');
    }
  };

  return (
    <main className="ee-editor" aria-label="Item editor" aria-busy={busy}>
      <header className="ee-editor-header">
        <button type="button" className="ee-editor-back" onClick={close}>
          <ArrowLeft size={16} aria-hidden /> Back to Easy Edit
        </button>
        <span className="ee-editor-context muted">
          {boardName} / {inTray ? 'Capture tray' : 'Board item'}
        </span>
        <output className={`ee-save-state ${saveState}`} aria-live="polite">
          {locked ? 'Read-only' : SAVE_COPY[saveState]}
        </output>
      </header>

      {locked && (
        <p className="canvas-inspector-lock ee-editor-lock">
          <Lock size={14} aria-hidden /> This item is read-only because it is{' '}
          {item.status}.
        </p>
      )}

      <div className="ee-editor-grid">
        <section className="ee-editor-main" aria-label="Content">
          <label className="sr-only" htmlFor="ee-title">
            Title
          </label>
          <DictationField className="ee-title-field">
            <input
              id="ee-title"
              aria-label="Item title"
              className="ee-title-input"
              value={title}
              disabled={ro}
              placeholder="Untitled item"
              onBlur={flush}
              onChange={(event) => {
                setTitle(event.target.value);
                textPatch({ title: event.target.value || null });
              }}
            />
          </DictationField>

          <div className="ee-field ee-body-field">
            <label htmlFor="ee-body">Description</label>
            <DictationField>
              <textarea
                id="ee-body"
                rows={14}
                value={body}
                disabled={ro}
                placeholder="Add context, decisions, or next steps…"
                onBlur={flush}
                onChange={(event) => {
                  setBody(event.target.value);
                  textPatch({ body: event.target.value || null });
                }}
              />
            </DictationField>
          </div>

          {isLink && (
            <div className="ee-field">
              <label htmlFor="ee-ref">Link URL</label>
              <DictationField>
                <input
                  id="ee-ref"
                  type="url"
                  value={ref}
                  disabled={ro}
                  placeholder="https://…"
                  onBlur={flush}
                  onChange={(event) => {
                    setRef(event.target.value);
                    textPatch({ ref: event.target.value || null });
                  }}
                />
              </DictationField>
            </div>
          )}
        </section>

        <aside className="ee-properties" aria-label="Item properties">
          <h2>Properties</h2>
          <div className="ee-field">
            <label htmlFor="ee-status">Status</label>
            <select
              id="ee-status"
              value={item.status}
              disabled={ro}
              onChange={(e) => immediate({ status: e.target.value })}
            >
              {!['active', 'icebox', 'discarded'].includes(item.status) && (
                <option value={item.status}>{item.status}</option>
              )}
              <option value="active">Active</option>
              <option value="icebox">Parked</option>
              <option value="discarded">Discarded</option>
            </select>
          </div>
          {isNote && (
            <div className="ee-field">
              <label htmlFor="ee-kind">Type</label>
              <select
                id="ee-kind"
                value={item.note_kind ?? ''}
                disabled={ro}
                onChange={(e) =>
                  immediate({ note_kind: e.target.value || null })
                }
              >
                <option value="">Untyped</option>
                {taxonomy.map((kind) => (
                  <option key={kind} value={kind}>
                    {noteKindMeta(kind).label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="ee-field">
            <label htmlFor="ee-imp">Importance</label>
            <select
              id="ee-imp"
              value={item.importance ?? 'undecided'}
              disabled={ro}
              onChange={(e) => immediate({ importance: e.target.value })}
            >
              {['must', 'should', 'nice', 'undecided'].map((importance) => (
                <option key={importance} value={importance}>
                  {importance.charAt(0).toUpperCase() + importance.slice(1)}
                </option>
              ))}
            </select>
          </div>
          {isNote && (
            <div className="ee-field">
              <label htmlFor="ee-notestatus">Note status</label>
              <select
                id="ee-notestatus"
                value={item.note_status ?? 'open'}
                disabled={ro}
                onChange={(e) => immediate({ note_status: e.target.value })}
              >
                {NOTE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {isNote && (
            <fieldset className="ee-field ee-color-field">
              <legend>Color</legend>
              <div className="ee-swatches">
                <button
                  type="button"
                  aria-pressed={item.color == null}
                  aria-label="Automatic color"
                  className={`ee-swatch auto${item.color == null ? ' on' : ''}`}
                  title="Auto (from type)"
                  disabled={ro}
                  onClick={() => immediate({ color: null })}
                />
                {BOARD_ITEM_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-pressed={item.color === color}
                    aria-label={`${color} color`}
                    className={`ee-swatch note-${color}${item.color === color ? ' on' : ''}`}
                    title={color}
                    disabled={ro}
                    onClick={() => immediate({ color })}
                  />
                ))}
              </div>
            </fieldset>
          )}

          {!locked && (
            <div className="ee-editor-actions">
              {inTray ? (
                <button
                  type="button"
                  className="primary small"
                  disabled={actionBusy}
                  onClick={() => void promoteToBoard()}
                >
                  <ArrowUpToLine size={14} aria-hidden /> Add to board
                </button>
              ) : (
                <button
                  type="button"
                  className="small"
                  disabled={actionBusy}
                  onClick={() => {
                    immediate({ board: null });
                    onBack();
                  }}
                >
                  Move to tray
                </button>
              )}
              {item.status !== 'discarded' && (
                <button
                  type="button"
                  className="small danger"
                  disabled={actionBusy}
                  onClick={() => immediate({ status: 'discarded' })}
                >
                  Discard
                </button>
              )}
            </div>
          )}

          <details className="ee-provenance">
            <summary>Provenance and details</summary>
            <dl className="inspector-meta">
              <dt>ID</dt>
              <dd className="mono">{item.id}</dd>
              <dt>Kind</dt>
              <dd>{item.kind === 'zone' ? 'frame' : item.kind}</dd>
              {item.provenance && (
                <>
                  <dt>Provenance</dt>
                  <dd>{item.provenance}</dd>
                </>
              )}
              {item.consumed_by && (
                <>
                  <dt>Produced work</dt>
                  <dd className="mono">{item.consumed_by}</dd>
                </>
              )}
            </dl>
          </details>
        </aside>
      </div>
    </main>
  );
}
