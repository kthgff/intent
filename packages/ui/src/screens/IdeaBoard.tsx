import type { BoardItem, StatementRow } from '@veto/core';
/**
 * S-16 — Board canvas v2 (s-16-board-canvas.md, PRD §15.3, wp-147).
 *
 * Idea mode: typed sticky notes grouped into lanes (zone / type /
 * status), each card carrying its taxonomy chip, importance, provenance
 * chip, and a live statement surface — the extracted semantic
 * statements ride `boardSurface` and render under the inspector with
 * confirm/dispute/correct affordances routed through the statement
 * decide APIs (corrections write a new statement + supersedes edge —
 * never a silent overwrite).
 *
 * Delivery mode embeds the S-01 pipeline kanban scoped to this
 * workspace (the shared component per D21).
 *
 * The capture-tray dock pins to the bottom of the canvas: `board:null`
 * items promote onto the board via the OCC-fenced item mutation.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type IdeaBoardDetail, client } from '../api';
import { columnsFor } from '../board';
import { Empty, ErrorBox, Loading, StatusBadge, fmtAge } from '../components';
import {
  type CanvasGrouping,
  groupCanvasItems,
  isConsumedItem,
  noteKindMeta,
  statementProvenance,
} from '../discovery';
import { useStreamRefresh } from '../hooks';

const GROUPINGS: { id: CanvasGrouping; label: string }[] = [
  { id: 'zone', label: 'Zones' },
  { id: 'type', label: 'Type' },
  { id: 'status', label: 'Status' },
  { id: 'none', label: 'Canvas' },
];

export default function IdeaBoard() {
  const { ws = '', board = '' } = useParams();
  const [data, setData] = useState<IdeaBoardDetail | null>(null);
  const [tray, setTray] = useState<BoardItem[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<CanvasGrouping>('zone');
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'idea' | 'delivery'>('idea');
  const [delivery, setDelivery] = useState<Awaited<
    ReturnType<typeof client.board>
  > | null>(null);
  const [newNote, setNewNote] = useState({ title: '', note_kind: 'idea' });
  const [taxonomy, setTaxonomy] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!ws || !board) return;
    client
      .ideaBoard(ws, board)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
    client
      .tray(ws)
      .then((r) => setTray(r.items))
      .catch(() => {});
  }, [ws, board]);

  useEffect(() => {
    load();
    client
      .boardTaxonomy()
      .then((t) => setTaxonomy(t.note_kinds))
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    if (mode !== 'delivery' || !ws) return;
    client
      .board(ws)
      .then(setDelivery)
      .catch(() => {});
  }, [mode, ws]);

  useStreamRefresh(load, ['interview_updated', 'ticket_updated']);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const items = useMemo(() => (data?.items ?? []).map((s) => s.item), [data]);
  const statementsByItem = useMemo(() => {
    const m = new Map<string, StatementRow[]>();
    for (const s of data?.items ?? []) m.set(s.item.id, s.statements);
    return m;
  }, [data]);

  const lanes = useMemo(
    () => groupCanvasItems(items, grouping),
    [items, grouping],
  );

  const selectedSurface = data?.items.find((s) => s.item.id === selected);

  const patchItem = async (item: BoardItem, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await client.patchBoardItem(item.id, {
        workspace: ws,
        expected_updated_at: item.updated_at ?? '',
        ...patch,
      });
      load();
    } catch (e) {
      setToast(
        `Update rejected: ${e instanceof Error ? e.message : String(e)}`,
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  const promote = async (item: BoardItem) => {
    await patchItem(item, { board, status: 'active' });
  };

  const addSticky = async () => {
    if (!newNote.title.trim()) return;
    setBusy(true);
    try {
      await client.addBoardItem(board, {
        workspace: ws,
        title: newNote.title.trim(),
        note_kind: newNote.note_kind,
      });
      setNewNote({ title: '', note_kind: newNote.note_kind });
      load();
    } catch (e) {
      setToast(`Add failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Loading />;
  if (error != null && !data) return <ErrorBox error={error} />;
  if (!data) return <Empty />;

  return (
    <section>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          ◆ {data.board.name ?? board}
        </h1>
        <span className="muted">{ws}</span>
        {data.board.board_type && (
          <span className="badge">{data.board.board_type}</span>
        )}
        {data.board.status && <StatusBadge status={data.board.status} />}
        <span className="spacer" />
        <div className="mode-toggle" role="tablist" aria-label="board mode">
          {(['idea', 'delivery'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'primary small' : 'small'}
              onClick={() => setMode(m)}
            >
              {m === 'idea' ? 'Idea' : 'Delivery'}
            </button>
          ))}
        </div>
        <select
          aria-label="group by"
          style={{ width: 'auto' }}
          value={grouping}
          onChange={(e) => setGrouping(e.target.value as CanvasGrouping)}
        >
          {GROUPINGS.map((g) => (
            <option key={g.id} value={g.id}>
              group: {g.label}
            </option>
          ))}
        </select>
        <button type="button" className="small" onClick={load}>
          Refresh
        </button>
      </div>

      {toast && <output className="warn-banner">{toast}</output>}
      {error != null && <ErrorBox error={error} />}

      {mode === 'idea' ? (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <input
              aria-label="new sticky"
              placeholder="New sticky…"
              value={newNote.title}
              onChange={(e) =>
                setNewNote({ ...newNote, title: e.target.value })
              }
              onKeyDown={(e) => e.key === 'Enter' && void addSticky()}
            />
            <select
              aria-label="note type"
              style={{ width: 'auto' }}
              value={newNote.note_kind}
              onChange={(e) =>
                setNewNote({ ...newNote, note_kind: e.target.value })
              }
            >
              {taxonomy.map((k) => (
                <option key={k} value={k}>
                  {noteKindMeta(k).label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="primary small"
              disabled={busy || !newNote.title.trim()}
              onClick={() => void addSticky()}
            >
              Add
            </button>
          </div>

          {lanes.every((l) => l.items.length === 0) && (
            <Empty label="Empty canvas — drop a sticky or promote from the tray below." />
          )}

          <div className={`canvas canvas-${grouping}`} aria-label="idea canvas">
            {lanes.map((lane) => (
              <div key={lane.key} className="canvas-lane">
                <div className="canvas-lane-head">
                  {lane.label}
                  <span className="badge">{lane.items.length}</span>
                </div>
                {lane.items.map((item) => {
                  const meta = noteKindMeta(item.note_kind);
                  const statements = statementsByItem.get(item.id) ?? [];
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className={`sticky note-${meta.color}${
                        isConsumedItem(item) ? ' dim' : ''
                      }${selected === item.id ? ' selected' : ''}`}
                      onClick={() =>
                        setSelected((s) => (s === item.id ? null : item.id))
                      }
                    >
                      <span className="sticky-chip">
                        {meta.icon} {meta.label}
                      </span>
                      {item.importance && item.importance !== 'undecided' && (
                        <span className="badge">{item.importance}</span>
                      )}
                      {item.provenance === 'inferred' && (
                        <span
                          className="badge attn"
                          title="AI-inferred — confirm needed"
                        >
                          ~ai
                        </span>
                      )}
                      <span className="sticky-text">
                        {item.title ?? item.body ?? '(untitled)'}
                      </span>
                      {statements.length > 0 && (
                        <span className="muted">
                          {statements.length} statement
                          {statements.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {isConsumedItem(item) && item.consumed_by && (
                        <span className="muted">→{item.consumed_by}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {selectedSurface && (
            <ItemInspector
              surface={selectedSurface}
              busy={busy}
              ws={ws}
              taxonomy={taxonomy}
              onPatch={(patch) => void patchItem(selectedSurface.item, patch)}
              onClose={() => setSelected(null)}
              onChanged={load}
              onError={(m) => setToast(m)}
            />
          )}

          {tray.length > 0 && (
            <div className="tray-dock" aria-label="capture tray">
              <span className="muted">Tray ({tray.length}):</span>
              {tray.slice(0, 12).map((i) => (
                <button
                  type="button"
                  key={i.id}
                  className="small"
                  disabled={busy}
                  title={i.body ?? i.title ?? ''}
                  onClick={() => void promote(i)}
                >
                  ↑ {(i.title ?? i.body ?? i.id).slice(0, 40)}
                </button>
              ))}
              <Link className="small" to="/tray">
                open tray →
              </Link>
            </div>
          )}
        </>
      ) : (
        <DeliveryView data={delivery} />
      )}
    </section>
  );
}

/** Delivery mode — the S-01 pipeline kanban scoped to this workspace
 *  (D21: two boards, one component). Read-only mirror here; the full
 *  action surface lives on Home. */
function DeliveryView({
  data,
}: {
  data: Awaited<ReturnType<typeof client.board>> | null;
}) {
  if (!data) return <Loading />;
  const columns = columnsFor(data.cards);
  return (
    <section className="board" aria-label="delivery board">
      {columns.map((col) => (
        <div key={col.phase} className="board-col">
          <div className="board-col-head">
            <span className="board-col-label">{col.label}</span>
            <span className="badge">{col.total}</span>
          </div>
          {col.cards.map((card) => (
            <article key={card.ref} className="board-card">
              <div className="board-card-head">
                <Link
                  to={`/tickets/${encodeURIComponent(
                    card.ticket.workspace,
                  )}/${encodeURIComponent(card.ticket.ticket_id)}`}
                  className="mono"
                >
                  {card.ticket.ticket_id}
                </Link>
                <StatusBadge status={card.ticket.status} />
              </div>
              <span className="board-card-title">{card.ticket.title}</span>
            </article>
          ))}
        </div>
      ))}
    </section>
  );
}

/** Item inspector — taxonomy correction (one click), provenance, the
 *  statement surface with confirm/dispute/correct affordances, and the
 *  park/supersede lifecycle moves. */
export function ItemInspector({
  surface,
  busy,
  ws,
  taxonomy,
  onPatch,
  onClose,
  onChanged,
  onError,
}: {
  surface: { item: BoardItem; statements: StatementRow[] };
  busy: boolean;
  ws: string;
  taxonomy: string[];
  onPatch: (patch: Record<string, unknown>) => void;
  onClose: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const { item, statements } = surface;
  const [editing, setEditing] = useState<string | null>(null);
  const [correction, setCorrection] = useState('');

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
  return (
    <aside className="inspector card" aria-label="item inspector">
      <div className="row">
        <strong>{item.title ?? '(untitled)'}</strong>
        <span className="spacer" />
        <button type="button" className="small" onClick={onClose}>
          ×
        </button>
      </div>
      {item.body && <p>{item.body}</p>}
      <div className="row">
        <label className="muted" htmlFor="note-kind">
          type
        </label>
        <select
          id="note-kind"
          style={{ width: 'auto' }}
          value={item.note_kind ?? ''}
          disabled={consumed || busy}
          onChange={(e) => onPatch({ note_kind: e.target.value })}
        >
          <option value="">(untyped)</option>
          {taxonomy.map((k) => (
            <option key={k} value={k}>
              {noteKindMeta(k).label}
            </option>
          ))}
        </select>
        <label className="muted" htmlFor="note-imp">
          importance
        </label>
        <select
          id="note-imp"
          style={{ width: 'auto' }}
          value={item.importance ?? 'undecided'}
          disabled={consumed || busy}
          onChange={(e) => onPatch({ importance: e.target.value })}
        >
          {['must', 'should', 'nice', 'undecided'].map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <button
          type="button"
          className="small"
          disabled={busy || consumed}
          onClick={() => onPatch({ status: 'icebox' })}
        >
          park (icebox)
        </button>
        {item.note_status === 'deferred' ? (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => onPatch({ note_status: 'resurfaced' })}
          >
            resurface
          </button>
        ) : (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => onPatch({ note_status: 'deferred' })}
          >
            defer
          </button>
        )}
        {item.board !== null && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => onPatch({ board: null })}
          >
            → tray
          </button>
        )}
        <span className="muted">
          {item.status} · {fmtAge(item.updated_at ?? item.created_at ?? '')}
        </span>
      </div>

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
            {editing === s.statement_id ? (
              <div className="row">
                <input
                  aria-label="correction"
                  value={correction}
                  onChange={(e) => setCorrection(e.target.value)}
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
                    confirm
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
                  correct
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={() => void dispute(s)}
                >
                  dispute
                </button>
                <button
                  type="button"
                  className="small danger"
                  onClick={() => void decide(s, 'reject')}
                >
                  reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
