import type { BoardItem } from '@veto/core';
/**
 * S-20 — Project Tray (s-19-capture-tray.md). The untriaged
 * (`board: null`) inbox: search/filter, an inspector with type
 * correction + move-to-board + park + delete (OCC-fenced — stale
 * writes conflict, never silently merge), and a link to the boards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type IdeaBoardRow, client } from '../api';
import { ConfirmDialog, Empty, ErrorBox, Loading, fmtAge } from '../components';
import { DictationField } from '../dictation';
import { noteKindMeta } from '../discovery';
import { useBoardItemRefresh, useEscapeKey, useStreamRefresh } from '../hooks';
import { useProject } from '../project';

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
  const workspace = useProject();
  const [boards, setBoards] = useState<IdeaBoardRow[]>([]);
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<BoardItem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  useEscapeKey(selected !== null, () => setSelected(null));

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

  // Selection tracks the full item list — a filter change never
  // silently closes the inspector (audit T4).
  const selectedItem = items?.find((i) => i.id === selected) ?? null;

  // Focus the inspector when it opens so keyboard/SR users land in it.
  useEffect(() => {
    if (selectedItem) inspectorRef.current?.focus();
  }, [selectedItem]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const patch = async (
    item: BoardItem,
    p: Record<string, unknown>,
    successNote?: string,
  ) => {
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
      if (successNote) setNote(successNote);
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
    <section className="tray-screen">
      <h1 className="page-title">Tray</h1>
      <p className="page-sub">
        Untriaged captures — route, refine, or sweep into a board (S-20).
      </p>
      <div className="row screen-toolbar tray-toolbar">
        <DictationField style={{ width: 240, flex: '0 0 auto' }}>
          <input
            aria-label="search"
            placeholder="search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </DictationField>
        <select
          aria-label="kind filter"
          className="auto"
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
      </div>

      {error != null && <ErrorBox error={error} onRetry={load} />}
      {toast && <output className="warn-banner">{toast}</output>}
      {note && <output className="save-banner">{note}</output>}
      {loading && !items && <Loading />}

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
          <aside
            className="inspector card"
            aria-label="tray inspector"
            ref={inspectorRef}
            tabIndex={-1}
          >
            <div className="row">
              <strong>{selectedItem.title ?? '(untitled)'}</strong>
              <span className="spacer" />
              <button
                type="button"
                className="small"
                aria-label="close inspector"
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
                className="auto"
                value={selectedItem.note_kind ?? ''}
                disabled={busy}
                onChange={(e) =>
                  void patch(
                    selectedItem,
                    { note_kind: e.target.value },
                    'Saved.',
                  )
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
                className="auto"
                value={selectedItem.importance ?? 'undecided'}
                disabled={busy}
                onChange={(e) =>
                  void patch(
                    selectedItem,
                    { importance: e.target.value },
                    'Saved.',
                  )
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
                className="auto"
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
                onClick={() => {
                  const dest = moveTarget;
                  setMoveTarget('');
                  void patch(
                    selectedItem,
                    { board: dest, status: 'active' },
                    `Moved to ${dest}.`,
                  );
                }}
              >
                Move
              </button>
              <button
                type="button"
                className="small"
                disabled={busy}
                onClick={() =>
                  void patch(selectedItem, { status: 'icebox' }, 'Parked.')
                }
              >
                Park
              </button>
              <button
                type="button"
                className="small danger"
                disabled={busy}
                onClick={() => setConfirmDelete(selectedItem)}
              >
                Delete
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

      {confirmDelete && (
        <ConfirmDialog
          title="Delete tray item"
          body={`"${confirmDelete.title ?? '(untitled)'}" — this can't be undone.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => {
            void remove(confirmDelete);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </section>
  );
}
