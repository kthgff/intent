/**
 * Inspector.tsx — the right-side semantic inspector (S-16).
 *
 * Common formatting lives on the selection toolbar; this panel owns
 * Veto-only semantics, organized into four sections: Properties
 * (taxonomy + importance), Lifecycle (park / defer / tray / discard),
 * Details (id, status, provenance, frame, age), and Statements with
 * confirm/dispute/correct. Corrections write a new statement +
 * supersedes edge — never a silent overwrite.
 */
import type { BoardItem, StatementRow } from '@veto/core';
import { Lock, X } from 'lucide-react';
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { client } from '../api';
import { StatusBadge, fmtAge } from '../components';
import { DictationField } from '../dictation';
import {
  isConsumedItem,
  noteKindMeta,
  statementProvenance,
} from '../discovery';

/** Editable text property — label + control as one inspector field.
 *  Commits on blur (Enter for single-line, ⌘/Ctrl+Enter for the
 *  textarea, Escape like the canvas editor) through the fenced
 *  `onPatch`. The draft is local so mid-typing SSE refreshes and the
 *  post-patch re-render don't clobber it; a clean field re-syncs to
 *  the item's latest value. `lastCommitted` dedupes commit→blur and
 *  skips unchanged drafts; the re-sync effect resets it so a failed
 *  patch (field reverts on reload) can be re-committed. Remounts per
 *  item via `key` at the call site. */
function InspectorTextField({
  label,
  value,
  placeholder,
  multiline,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  disabled: boolean;
  onCommit: (text: string) => void;
}) {
  const controlId = useId();
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  const lastCommitted = useRef(value);
  useEffect(() => {
    if (!dirty) {
      setDraft(value);
      lastCommitted.current = value;
    }
  }, [value, dirty]);
  const commit = () => {
    setDirty(false);
    if (draft !== lastCommitted.current) {
      lastCommitted.current = draft;
      onCommit(draft);
    }
  };
  const shared = {
    id: controlId,
    value: draft,
    disabled,
    placeholder,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      setDirty(true);
    },
    onBlur: commit,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (
        e.key === 'Escape' ||
        (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey))
      ) {
        e.preventDefault();
        e.stopPropagation();
        commit();
        e.currentTarget.blur();
      }
    },
  };
  return (
    <label htmlFor={controlId} className="inspector-field inspector-field-wide">
      <span>{label}</span>
      {multiline ? (
        <DictationField>
          <textarea rows={3} {...shared} />
        </DictationField>
      ) : (
        <DictationField>
          <input type="text" {...shared} />
        </DictationField>
      )}
    </label>
  );
}

export function BoardInspector({
  surface,
  busy,
  ws,
  taxonomy,
  onPatch,
  onClose,
  onChanged,
  onError,
  readOnly,
}: {
  surface: { item: BoardItem; statements: StatementRow[] };
  busy: boolean;
  ws: string;
  taxonomy: string[];
  onPatch: (patch: Record<string, unknown>) => void;
  onClose: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
  readOnly?: boolean;
}) {
  const { item, statements } = surface;
  const [editing, setEditing] = useState<string | null>(null);
  const [correction, setCorrection] = useState('');
  const correctionRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) correctionRef.current?.focus();
  }, [editing]);

  const decide = async (s: StatementRow, action: 'confirm' | 'reject') => {
    try {
      await client.decideStatement(s.statement_id, {
        workspace: ws,
        action,
      });
      onChanged();
    } catch (e) {
      onError(`Decide failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const dispute = async (s: StatementRow) => {
    const reason = window.prompt('Dispute reason?');
    if (!reason) return;
    try {
      await client.decideStatement(s.statement_id, {
        workspace: ws,
        action: 'dispute',
        reason,
      });
      onChanged();
    } catch (e) {
      onError(`Dispute failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const correct = async (s: StatementRow) => {
    if (!correction.trim()) return;
    try {
      await client.correctStatement(s.statement_id, {
        workspace: ws,
        text: correction.trim(),
      });
      setEditing(null);
      setCorrection('');
      onChanged();
    } catch (e) {
      onError(`Correct failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const consumed = isConsumedItem(item);
  const frozen = item.status === 'frozen';
  const ro = readOnly || consumed || frozen;
  const meta = noteKindMeta(item.note_kind);
  const kindLabel =
    item.kind === 'note'
      ? meta.label
      : item.kind === 'zone'
        ? 'Frame'
        : item.kind.charAt(0).toUpperCase() + item.kind.slice(1);
  const kindIcon = item.kind === 'note' ? meta.icon : '◦';
  return (
    <aside
      className="canvas-inspector"
      aria-label="Item details"
      aria-busy={busy}
    >
      <div className="row">
        <strong className="canvas-inspector-title" title={item.title ?? ''}>
          {item.title ?? '(Untitled)'}
        </strong>
        <span className="spacer" />
        <button
          type="button"
          className="canvas-icon-button"
          aria-label="Close item details"
          title="Close item details"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="inspector-subtitle">
        <span className="inspector-kind-chip">
          {kindIcon} {kindLabel}
        </span>
        <StatusBadge status={item.status} />
      </div>
      {ro && (
        <p className="canvas-inspector-lock">
          <Lock size={14} aria-hidden />
          {readOnly
            ? 'Read-only view on this screen size.'
            : `This item is locked because it is ${item.status}.`}
        </p>
      )}
      {readOnly && item.body && <p className="inspector-body">{item.body}</p>}

      {!readOnly && (
        <>
          <section className="inspector-section">
            <h3 className="inspector-section-title">Properties</h3>
            <div className="inspector-grid">
              <InspectorTextField
                key={`title-${item.id}`}
                label="Title"
                value={item.title ?? ''}
                placeholder="Untitled"
                disabled={ro || busy}
                onCommit={(t) => onPatch({ title: t.trim() || null })}
              />
              <label className="inspector-field">
                <span>Type</span>
                <select
                  value={item.note_kind ?? ''}
                  disabled={ro || busy}
                  onChange={(e) =>
                    onPatch({ note_kind: e.target.value || null })
                  }
                >
                  <option value="">Untyped</option>
                  {taxonomy.map((k) => (
                    <option key={k} value={k}>
                      {noteKindMeta(k).label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inspector-field">
                <span>Importance</span>
                <select
                  value={item.importance ?? 'undecided'}
                  disabled={ro || busy}
                  onChange={(e) => onPatch({ importance: e.target.value })}
                >
                  {['must', 'should', 'nice', 'undecided'].map((i) => (
                    <option key={i} value={i}>
                      {i.charAt(0).toUpperCase() + i.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              {/* Frame presentation order (TOOLS-TDD §2.5) — zone
                  items only; empty = excluded from present mode. */}
              {item.kind === 'zone' && (
                <label className="inspector-field">
                  <span>Slide order</span>
                  <DictationField>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      placeholder="—"
                      value={item.presentation_order ?? ''}
                      disabled={ro || busy}
                      onChange={(e) => {
                        const v = e.target.value;
                        onPatch({
                          presentation_order:
                            v === '' ? null : Math.max(0, Number(v) || 0),
                        });
                      }}
                    />
                  </DictationField>
                </label>
              )}
              <InspectorTextField
                key={`body-${item.id}`}
                label="Body"
                value={item.body ?? ''}
                placeholder="Add details…"
                multiline
                disabled={ro || busy}
                onCommit={(t) => onPatch({ body: t || null })}
              />
            </div>
          </section>

          <section className="inspector-section">
            <h3 className="inspector-section-title">Lifecycle</h3>
            <div className="inspector-actions">
              <button
                type="button"
                className="small"
                disabled={busy || ro}
                onClick={() => onPatch({ status: 'icebox' })}
              >
                Park
              </button>
              {item.note_status === 'deferred' ? (
                <button
                  type="button"
                  className="small"
                  disabled={busy || ro}
                  onClick={() => onPatch({ note_status: 'resurfaced' })}
                >
                  Resurface
                </button>
              ) : (
                <button
                  type="button"
                  className="small"
                  disabled={busy || ro}
                  onClick={() => onPatch({ note_status: 'deferred' })}
                >
                  Defer
                </button>
              )}
              {item.board !== null && (
                <button
                  type="button"
                  className="small"
                  disabled={busy || ro}
                  onClick={() => onPatch({ board: null })}
                >
                  Move to tray
                </button>
              )}
              {!ro && item.status !== 'discarded' && (
                <button
                  type="button"
                  className="small danger"
                  disabled={busy}
                  onClick={() => {
                    onPatch({ status: 'discarded' });
                    onClose();
                  }}
                >
                  Discard
                </button>
              )}
            </div>
          </section>
        </>
      )}

      <section className="inspector-section">
        <h3 className="inspector-section-title">Details</h3>
        <dl className="inspector-meta">
          <dt>ID</dt>
          <dd className="mono">{item.id}</dd>
          <dt>Status</dt>
          <dd>
            {item.status}
            {consumed && item.consumed_by && (
              <>
                {' '}
                → <span className="mono">{item.consumed_by}</span>
              </>
            )}
          </dd>
          {item.provenance && (
            <>
              <dt>Provenance</dt>
              <dd>{item.provenance}</dd>
            </>
          )}
          {item.zone && (
            <>
              <dt>Frame</dt>
              <dd>{item.zone}</dd>
            </>
          )}
          <dt>Updated</dt>
          <dd>{fmtAge(item.updated_at ?? item.created_at ?? '')}</dd>
        </dl>
      </section>

      <section className="inspector-section">
        <h3 className="inspector-section-title">Statements</h3>
        {statements.length === 0 && (
          <p className="muted">No statements extracted from this item yet.</p>
        )}
        <ul className="list">
          {statements.map((s) => (
            <li key={s.statement_id} className="statement-row">
              <StatusBadge status={s.status} /> {s.text}
              <div
                className="muted"
                title={statementProvenance(s)}
                style={{ fontSize: '0.85em' }}
              >
                {statementProvenance(s)}
              </div>
              {!readOnly &&
                (editing === s.statement_id ? (
                  <div className="row">
                    <DictationField onError={onError}>
                      <input
                        ref={correctionRef}
                        aria-label="correction"
                        value={correction}
                        onChange={(e) => setCorrection(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setEditing(null);
                            setCorrection('');
                          }
                        }}
                      />
                    </DictationField>
                    <button
                      type="button"
                      className="small primary"
                      onClick={() => void correct(s)}
                    >
                      Save correction
                    </button>
                    <button
                      type="button"
                      className="small"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="row actions">
                    {s.status !== 'confirmed' && (
                      <button
                        type="button"
                        className="small"
                        onClick={() => void decide(s, 'confirm')}
                      >
                        Confirm
                      </button>
                    )}
                    <button
                      type="button"
                      className="small"
                      onClick={() => {
                        setEditing(s.statement_id);
                        setCorrection(s.text);
                      }}
                    >
                      Correct
                    </button>
                    <button
                      type="button"
                      className="small"
                      onClick={() => void dispute(s)}
                    >
                      Dispute
                    </button>
                    <button
                      type="button"
                      className="small danger"
                      onClick={() => void decide(s, 'reject')}
                    >
                      Reject
                    </button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
