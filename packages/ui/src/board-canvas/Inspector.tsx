/**
 * Inspector.tsx — the right-side semantic inspector (S-16).
 *
 * Common formatting lives on the selection toolbar; this panel owns
 * Veto-only semantics: taxonomy (note kind), importance, provenance,
 * lifecycle moves (park / defer / tray / discard), extracted statements
 * with confirm/dispute/correct, and produced-artifact links. Corrections
 * write a new statement + supersedes edge — never a silent overwrite.
 */
import type { BoardItem, StatementRow } from '@veto/core';
import { Lock, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { client } from '../api';
import { StatusBadge, fmtAge } from '../components';
import {
  isConsumedItem,
  noteKindMeta,
  statementProvenance,
} from '../discovery';

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
      {ro && (
        <p className="canvas-inspector-lock">
          <Lock size={14} aria-hidden />
          {readOnly
            ? 'Read-only view on this screen size.'
            : `This item is locked because it is ${item.status}.`}
        </p>
      )}
      {item.body && <p className="inspector-body">{item.body}</p>}
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

      {!readOnly && (
        <>
          <div className="row">
            <label className="muted" htmlFor="note-kind">
              Type
            </label>
            <select
              id="note-kind"
              style={{ width: 'auto' }}
              value={item.note_kind ?? ''}
              disabled={ro || busy}
              onChange={(e) => onPatch({ note_kind: e.target.value || null })}
            >
              <option value="">Untyped</option>
              {taxonomy.map((k) => (
                <option key={k} value={k}>
                  {noteKindMeta(k).label}
                </option>
              ))}
            </select>
            <label className="muted" htmlFor="note-imp">
              Importance
            </label>
            <select
              id="note-imp"
              style={{ width: 'auto' }}
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
          </div>
          <div className="row">
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
        </>
      )}

      <h3>Statements</h3>
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
                <div className="row">
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
      {consumed && item.consumed_by && (
        <p className="muted">Produced work: {item.consumed_by}</p>
      )}
    </aside>
  );
}
