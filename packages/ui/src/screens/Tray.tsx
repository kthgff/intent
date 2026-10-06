import type { BoardItem } from '@veto/core';
/**
 * S-20 — Project Tray (s-19-capture-tray.md). The untriaged
 * (`board: null`) inbox: search/filter, an inspector with type
 * correction + move-to-board + park + delete (OCC-fenced — stale
 * writes conflict, never silently merge), and a link to the boards.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type IdeaBoardRow, client } from '../api';
import { Empty, ErrorBox, Loading, fmtAge } from '../components';
import { noteKindMeta } from '../discovery';
import { useBoardItemRefresh, useStreamRefresh } from '../hooks';

const NOTE_KIND_KEYS = [
  'idea',
  'want',
  'avoid',
  'problem',
  'constraint',
  'question',
  'decision',
  'feedback',
] as const;

export default function Tray() {
  const [workspace, setWorkspace] = useState('');
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [boards, setBoards] = useState<IdeaBoardRow[]>([]);
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!workspace) {
      setItems([]);
      setLoading(false);
      return;
    }
    client
      .tray(workspace)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [workspace]);

  useEffect(() => {
    load();
    client
      .workspaces()
      .then((r) => {
        const names = r.workspaces.map((w) => w.name);
        setWorkspaces(names);
        setWorkspace((cur) => cur || names[0] || '');
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (!workspace) return;
    client
      .ideaBoards(workspace)
      .then((r) => setBoards(r.boards))
      .catch(() => {});
  }, [workspace]);

  useStreamRefresh(load, ['interview_updated']);
  useBoardItemRefresh(load);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    let out = items ?? [];
    if (kindFilter) {
      out = out.filter(
        (i) => i.note_kind === kindFilter || i.kind === kindFilter,
      );
    }
    if (search.trim()) {
      const n = search.trim().toLowerCase();
      out = out.filter(
        (i) =>
          (i.title ?? '').toLowerCase().includes(n) ||
          (i.body ?? '').toLowerCase().includes(n),
      );
    }
    return out;
  }, [items, kindFilter, search]);

  const selectedItem = filtered.find((i) => i.id === selected) ?? null;

  const patch = async (item: BoardItem, p: Record<string, unknown>) => {
    setBusy(true);
    try {
      await client.patchBoardItem(item.id, {
        workspace,
        // Send the fence only when we actually have a timestamp —
        // `''` is ambiguous, never a wildcard.
        ...(item.updated_at != null
          ? { expected_updated_at: item.updated_at }
          : {}),
        ...p,
      });
      load();
    } catch (e) {
      // Optimistic-conflict: the server 409s stale writes — surface and
      // re-sync, never a silent merge (s-19/S-20).
      setToast(
        `Update rejected: ${e instanceof Error ? e.message : String(e)}`,
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: BoardItem) => {
    setBusy(true);
    try {
      await client.deleteBoardItem(workspace, item.id);
      setSelected(null);
      load();
    } catch (e) {
      setToast(
        `Delete rejected: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1 className="page-title">Tray</h1>
      <p className="page-sub">
        Untriaged captures — route, refine, or sweep into a board (S-20).
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="muted" htmlFor="tray-ws">
          Workspace
        </label>
        <select
          id="tray-ws"
          style={{ width: 'auto' }}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <input
          aria-label="search"
          placeholder="search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="kind filter"
          style={{ width: 'auto' }}
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        >
          <option value="">all kinds</option>
          {NOTE_KIND_KEYS.map((k) => (
            <option key={k} value={k}>
              {noteKindMeta(k).label}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <Link className="btn" to="/capture">
          + Capture
        </Link>
      </div>

      {error != null && <ErrorBox error={error} />}
      {toast && <output className="warn-banner">{toast}</output>}
      {loading && <Loading />}

      {filtered.length === 0 && !loading && (
        <Empty
          label={
            search || kindFilter
              ? 'Nothing matches the filters.'
              : 'Tray is empty — captures land here.'
          }
        />
      )}

      <div className="tray-layout">
        <ul className="list tray-list" aria-label="tray items">
          {filtered.map((i) => {
            const meta = noteKindMeta(i.note_kind);
            return (
              <li key={i.id}>
                <button
                  type="button"
                  className={`tray-row${selected === i.id ? ' selected' : ''}`}
                  onClick={() => setSelected((s) => (s === i.id ? null : i.id))}
                >
                  <span className={`sticky-chip note-${meta.color}`}>
                    {meta.icon} {meta.label}
                  </span>
                  <span>{i.title ?? i.body ?? '(untitled)'}</span>
                  <span className="muted">
                    {fmtAge(i.created_at ?? i.updated_at ?? '')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {selectedItem && (
          <aside className="inspector card" aria-label="tray inspector">
            <div className="row">
              <strong>{selectedItem.title ?? '(untitled)'}</strong>
              <span className="spacer" />
              <button
                type="button"
                className="small"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
            {selectedItem.body && <p>{selectedItem.body}</p>}
            <div className="row">
              <label className="muted" htmlFor="tray-kind">
                type
              </label>
              <select
                id="tray-kind"
                style={{ width: 'auto' }}
                value={selectedItem.note_kind ?? ''}
                disabled={busy}
                onChange={(e) =>
                  void patch(selectedItem, { note_kind: e.target.value })
                }
              >
                <option value="">(untyped)</option>
                {NOTE_KIND_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {noteKindMeta(k).label}
                  </option>
                ))}
              </select>
              <label className="muted" htmlFor="tray-imp">
                importance
              </label>
              <select
                id="tray-imp"
                style={{ width: 'auto' }}
                value={selectedItem.importance ?? 'undecided'}
                disabled={busy}
                onChange={(e) =>
                  void patch(selectedItem, { importance: e.target.value })
                }
              >
                {['must', 'should', 'nice', 'undecided'].map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <select
                aria-label="move to board"
                style={{ width: 'auto' }}
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
              >
                <option value="">move to board…</option>
                {boards.map((b) => (
                  <option key={b.board} value={b.board}>
                    {b.name ?? b.board}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="small primary"
                disabled={busy || !moveTarget}
                onClick={() =>
                  void patch(selectedItem, {
                    board: moveTarget,
                    status: 'active',
                  })
                }
              >
                Move
              </button>
              <button
                type="button"
                className="small"
                disabled={busy}
                onClick={() => void patch(selectedItem, { status: 'icebox' })}
              >
                park
              </button>
              <button
                type="button"
                className="small danger"
                disabled={busy}
                onClick={() => void remove(selectedItem)}
              >
                delete
              </button>
            </div>
            <p className="muted">
              {selectedItem.id} · created{' '}
              {fmtAge(selectedItem.created_at ?? '')} · touched{' '}
              {fmtAge(selectedItem.updated_at ?? '')}
            </p>
          </aside>
        )}
      </div>
    </section>
  );
}
