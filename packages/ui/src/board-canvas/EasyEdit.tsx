/**
 * EasyEdit.tsx — the non-spatial board-object view (D62,
 * EASY-EDIT-PRD).
 *
 * A dense table projection over the same durable `board_items` the
 * canvas renders — sortable, filterable, checkbox multi-select, bulk
 * OCC-fenced operations, a collapsible tray section with one-click
 * promotion, and a write-first edit drawer. Geometry and connectors
 * never appear here; discarded items stay visible but muted.
 */
import type { BoardItem, StatementRow } from '@veto/core';
import {
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Lock,
  Pencil,
  Plus,
  Search,
} from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StatusBadge, fmtAge } from '../components';
import { noteKindMeta } from '../discovery';
import { EditDrawer } from './EditDrawer';
import {
  type BoardCommand,
  CommandHistory,
  EASY_EDIT_FIELDS,
  type ItemMutation,
  makeCommand,
} from './history';
import {
  DEFAULT_FILTER,
  ROW_CAP,
  type SortDir,
  type SortKey,
  type TableRow,
  type ViewFilter,
  applyView,
  projectRows,
} from './table';

const UNDO_TOAST_MS = 8000;

export interface EasyEditProps {
  surfaces: { item: BoardItem; statements: StatementRow[] }[];
  tray: BoardItem[];
  ws: string;
  board: string;
  taxonomy: string[];
  /** Single-item OCC write (drawer fields, promote, discard). */
  patchItem: (item: BoardItem, patch: Record<string, unknown>) => void;
  /** Atomic batch OCC write — bulk ops only. */
  mutate: (mutations: ItemMutation[]) => Promise<BoardItem[]>;
  /** Tray → board promotion (engine path, no geometry). */
  promote: (item: BoardItem) => Promise<unknown>;
  /** Create a board item (no geometry sent). */
  add: (input: { kind?: string; note_kind?: string }) => Promise<BoardItem>;
  /** Create a tray item via capture. */
  capture: (title: string) => Promise<unknown>;
  notice: (msg: string) => void;
  /** Route-level write in flight (drawer disables alongside it). */
  busy: boolean;
}

function storageKey(ws: string, board: string): string {
  return `veto.easyedit.${ws}/${board}`;
}

interface PersistedView {
  sort: SortKey;
  dir: SortDir;
  filter: Partial<ViewFilter>;
}

function loadView(ws: string, board: string): PersistedView | null {
  try {
    const raw = localStorage.getItem(storageKey(ws, board));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PersistedView>;
    return {
      sort: typeof v.sort === 'string' ? (v.sort as SortKey) : 'updated_at',
      dir: v.dir === 'asc' ? 'asc' : 'desc',
      filter: typeof v.filter === 'object' && v.filter ? v.filter : {},
    };
  } catch {
    return null;
  }
}

function saveView(ws: string, board: string, v: PersistedView): void {
  try {
    localStorage.setItem(storageKey(ws, board), JSON.stringify(v));
  } catch {
    // quota / private mode — persistence is best-effort only
  }
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
}

export default function EasyEdit({
  surfaces,
  tray,
  ws,
  board,
  taxonomy,
  patchItem,
  mutate,
  promote,
  add,
  capture,
  notice,
  busy: routeBusy,
}: EasyEditProps) {
  const persisted = useMemo(() => loadView(ws, board), [ws, board]);
  const [sort, setSort] = useState<SortKey>(persisted?.sort ?? 'updated_at');
  const [dir, setDir] = useState<SortDir>(persisted?.dir ?? 'desc');
  const [filter, setFilter] = useState<ViewFilter>(() => ({
    ...DEFAULT_FILTER,
    ...persisted?.filter,
  }));
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [trayOpen, setTrayOpen] = useState(true);
  const [hintOpen, setHintOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [opBusy, setOpBusy] = useState(false);
  const busy = routeBusy || opBusy;
  const [undo, setUndo] = useState<{ label: string; cmd: BoardCommand } | null>(
    null,
  );
  const history = useRef(new CommandHistory());
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rows = useMemo(() => projectRows(surfaces, tray), [surfaces, tray]);
  const view = useMemo(
    () => applyView(rows, filter, sort, dir),
    [rows, filter, sort, dir],
  );
  const boardRows = view.filter((r) => r.section === 'board');
  const trayRows = view.filter((r) => r.section === 'tray');
  const capped = boardRows.length > ROW_CAP;
  const shownBoard = capped ? boardRows.slice(0, ROW_CAP) : boardRows;
  const visibleRows = [...shownBoard, ...(trayOpen ? trayRows : [])];
  const moveFocus = (id: string | null) => {
    setFocusId(id);
    const target = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? []).find((el) => el.dataset.rowId === id);
    target?.focus();
  };

  // Persist view state (fail-soft).
  useEffect(() => {
    saveView(ws, board, { sort, dir, filter });
  }, [ws, board, sort, dir, filter]);

  // SSE refresh lands new durable rows — prune view-state ids that no
  // longer exist; the drawer follows the refreshed row automatically.
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.item.id));
    setChecked((c) => {
      const next = new Set([...c].filter((id) => ids.has(id)));
      return next.size === c.size ? c : next;
    });
    if (focusId && !ids.has(focusId)) setFocusId(null);
    if (drawerId && !ids.has(drawerId)) setDrawerId(null);
  }, [rows, focusId, drawerId]);

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  const itemById = useMemo(() => {
    const m = new Map<string, BoardItem>();
    for (const r of rows) m.set(r.item.id, r.item);
    return m;
  }, [rows]);

  const showUndo = useCallback((label: string, cmd: BoardCommand) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ label, cmd });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_TOAST_MS);
  }, []);

  const runUndo = useCallback(async () => {
    const cmd = undo?.cmd;
    if (!cmd) return;
    setUndo(null);
    const plan = history.current.planUndo(itemById);
    if (!plan.ok) {
      notice(
        `Couldn't undo ${cmd.label}: the item changed since — refresh and try again`,
      );
      return;
    }
    try {
      const updated = await mutate(plan.mutations);
      history.current.commitUndo(updated);
      notice(`Undid ${cmd.label}`);
    } catch (e) {
      notice(`Undo failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [undo, itemById, mutate, notice]);

  const toggleSort = (key: SortKey) => {
    if (sort === key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(key);
      setDir(key === 'updated_at' ? 'desc' : 'asc');
    }
  };

  const toggleCheck = (row: TableRow) => {
    if (row.locked || row.section === 'tray' || busy) return;
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(row.item.id)) next.delete(row.item.id);
      else next.add(row.item.id);
      return next;
    });
  };

  const checkableRows = shownBoard.filter((r) => !r.locked);
  const allChecked =
    checkableRows.length > 0 &&
    checkableRows.every((r) => checked.has(r.item.id));

  const toggleAll = () => {
    setChecked((c) => {
      if (allChecked) return new Set<string>();
      const next = new Set(c);
      for (const r of checkableRows) next.add(r.item.id);
      return next;
    });
  };

  /** Bulk OCC batch — one request for every checked mutable row. */
  const bulk = async (patch: ItemMutation['patch'], label: string) => {
    if (busy) return;
    const targets = shownBoard.filter((r) => checked.has(r.item.id) && !r.locked);
    if (targets.length === 0) return;
    const mutations: ItemMutation[] = [];
    for (const r of targets) {
      if (r.item.updated_at == null) {
        notice(`Nothing changed: ${r.item.id} has no saved version. Refresh before trying again.`);
        return;
      }
      mutations.push({
        id: r.item.id,
        expected_updated_at: r.item.updated_at,
        patch,
      });
    }
    if (mutations.length === 0) return;
    setOpBusy(true);
    try {
      const before = mutations
        .map((m) => itemById.get(m.id))
        .filter((i): i is BoardItem => i != null);
      const updated = await mutate(mutations);
      const cmd = makeCommand(label, before, updated, [
        ...EASY_EDIT_FIELDS,
        'status',
        'title',
        'body',
      ] as const);
      history.current.push(cmd);
      showUndo(label, cmd);
      setChecked(new Set());
    } catch (e) {
      notice(
        `Bulk ${label} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setOpBusy(false);
    }
  };

  const bulkDiscard = () => {
    if (
      checked.size >= 10 &&
      !window.confirm(
        `Discard ${checked.size} items? They'll move to Discarded status.`,
      )
    ) {
      return;
    }
    void bulk({ status: 'discarded' }, `discard ${checked.size} items`);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || (e.target instanceof HTMLElement && e.target.closest('button, .ee-drawer'))) return;
    const ids = visibleRows.map((r) => r.item.id);
    const idx = focusId ? ids.indexOf(focusId) : -1;
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(ids[Math.min(idx + 1, ids.length - 1)] ?? null);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(ids[Math.max(idx - 1, 0)] ?? null);
        break;
      case 'Enter':
      case 'e': {
        const row = view.find((r) => r.item.id === focusId);
        if (row) setDrawerId(row.item.id);
        break;
      }
      case 'x': {
        const row = view.find((r) => r.item.id === focusId);
        if (row) toggleCheck(row);
        break;
      }
      case '/':
        e.preventDefault();
        searchRef.current?.focus();
        break;
      case 'Escape':
        if (drawerId) setDrawerId(null);
        else if (hintOpen) setHintOpen(false);
        else setChecked(new Set());
        break;
      case '?':
        setHintOpen((h) => !h);
        break;
    }
  };

  const kinds = useMemo(
    () => [...new Set(rows.map((r) => r.item.kind))].sort(),
    [rows],
  );
  const statuses = useMemo(
    () => [...new Set(rows.map((r) => r.item.status))].sort(),
    [rows],
  );
  const importances = useMemo(
    () =>
      [
        ...new Set(rows.map((r) => r.item.importance).filter(Boolean)),
      ].sort() as string[],
    [rows],
  );

  const drawerRow = drawerId
    ? rows.find((r) => r.item.id === drawerId)
    : undefined;

  const kindLabel = (row: TableRow) =>
    row.item.kind === 'note'
      ? 'Note'
      : row.item.kind === 'zone'
        ? 'frame'
        : row.item.kind;

  const renderRow = (row: TableRow) => {
    const { item } = row;
    const focused = focusId === item.id;
    const cls = [
      'ee-row',
      item.status === 'discarded' ? 'discarded' : '',
      focused ? 'focused' : '',
      row.locked ? 'locked' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <tr
        key={item.id}
        data-row-id={item.id}
        className={cls}
        tabIndex={focused || (!focusId && visibleRows[0]?.item.id === item.id) ? 0 : -1}
        aria-selected={checked.has(item.id)}
        onClick={() => moveFocus(item.id)}
        onFocus={() => setFocusId(item.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            setFocusId(item.id);
            if (e.key === 'Enter') setDrawerId(item.id);
          }
        }}
        onDoubleClick={() => setDrawerId(item.id)}
      >
        <td className="ee-check">
          <input
            type="checkbox"
            aria-label={`Select ${item.title || item.body || item.id}`}
            checked={checked.has(item.id)}
            disabled={row.locked}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleCheck(row)}
          />
        </td>
        <td className="ee-kind">
          <span className="ee-kind-label">
            {noteKindMeta(item.note_kind).icon} {kindLabel(row)}
          </span>
        </td>
        <td className="ee-text" title={item.title ?? item.body ?? ''}>
          {item.title || item.body || item.ref || 'Untitled'}
        </td>
        <td className="ee-type">{item.kind === 'note' ? noteKindMeta(item.note_kind).label : '—'}</td>
        <td>
          <StatusBadge status={item.status} />
        </td>
        <td className="ee-imp">{item.importance ?? '—'}</td>
        <td className="ee-updated muted">
          {fmtAge(item.updated_at ?? item.created_at ?? '')}
        </td>
        <td className="ee-act">
          {row.locked ? (
            <button type="button"
              className="ee-lock"
              title={`Locked — ${item.status}`}
              aria-label={`Locked — ${item.status}`}
              onClick={(e) => { e.stopPropagation(); setDrawerId(item.id); }}
            >
              <Lock size={14} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="canvas-icon-button"
              aria-label={`Edit ${item.title || item.body || item.id}`}
              title="Edit"
              onClick={(e) => {
                e.stopPropagation();
                setDrawerId(item.id);
              }}
            >
              <Pencil size={14} aria-hidden />
            </button>
          )}
        </td>
      </tr>
    );
  };

  const th = (label: string, key: SortKey, cls = '') => (
    <th
      className={cls || undefined}
      aria-sort={
        sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button type="button" className="ee-th" onClick={() => toggleSort(key)}>
        {label}
        {sort === key && <span aria-hidden>{dir === 'asc' ? ' ▲' : ' ▼'}</span>}
      </button>
    </th>
  );

  return (
    <div className="ee-root" onKeyDown={onKeyDown}>
      <div className="ee-toolbar">
        <label className="ee-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search items…  ( / )"
            aria-label="Search items"
            value={filter.search}
            onChange={(e) =>
              setFilter((f) => ({ ...f, search: e.target.value }))
            }
          />
        </label>
        <select
          aria-label="Filter by kind"
          value={filter.kind ?? ''}
          onChange={(e) =>
            setFilter((f) => ({ ...f, kind: e.target.value || null }))
          }
        >
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k === 'zone' ? 'frame' : k}
            </option>
          ))}
          <option value="tray">tray only</option>
        </select>
        <select
          aria-label="Filter by type"
          value={filter.note_kind ?? ''}
          onChange={(e) =>
            setFilter((f) => ({ ...f, note_kind: e.target.value || null }))
          }
        >
          <option value="">All types</option>
          {taxonomy.map((k) => (
            <option key={k} value={k}>
              {noteKindMeta(k).label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={filter.status ?? ''}
          onChange={(e) =>
            setFilter((f) => ({ ...f, status: e.target.value || null }))
          }
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by importance"
          value={filter.importance ?? ''}
          onChange={(e) =>
            setFilter((f) => ({
              ...f,
              importance: e.target.value || null,
            }))
          }
        >
          <option value="">All importance</option>
          {importances.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <label className="muted ee-tray-toggle">
          <input
            type="checkbox"
            checked={filter.showTray}
            onChange={(e) =>
              setFilter((f) => ({ ...f, showTray: e.target.checked }))
            }
          />
          Tray
        </label>
        <span className="spacer" />
        <div className="ee-new">
          <button
            type="button"
            className="primary small"
            onClick={() => {
              setOpBusy(true);
              add({ kind: 'note', note_kind: 'idea' })
                .then((item) => setFocusId(item.id))
                .catch((e) =>
                  notice(
                    `Create failed: ${e instanceof Error ? e.message : String(e)}`,
                  ),
                )
                .finally(() => setOpBusy(false));
            }}
            disabled={busy}
          >
            <Plus size={14} aria-hidden /> New
          </button>
          <button
            type="button"
            className="small"
            aria-label="More create options"
            title="More create options"
            onClick={() => setNewOpen((o) => !o)}
          >
            <ChevronDown size={14} aria-hidden />
          </button>
          {newOpen && (
            <div className="ee-new-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNewOpen(false);
                  setOpBusy(true);
                  add({ kind: 'text' })
                    .then((item) => setFocusId(item.id))
                    .catch((e) =>
                      notice(
                        `Create failed: ${e instanceof Error ? e.message : String(e)}`,
                      ),
                    )
                    .finally(() => setOpBusy(false));
                }}
              >
                Text block
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNewOpen(false);
                  setOpBusy(true);
                  capture('New note')
                    .catch((e) =>
                      notice(
                        `Capture failed: ${e instanceof Error ? e.message : String(e)}`,
                      ),
                    )
                    .finally(() => setOpBusy(false));
                }}
              >
                Note to tray
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="canvas-icon-button"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          onClick={() => setHintOpen((h) => !h)}
        >
          <CircleHelp size={15} aria-hidden />
        </button>
      </div>

      {hintOpen && (
        <div className="ee-hint" role="note">
          <strong>Keyboard</strong> — j/k or ↑/↓ move · Enter/e edit · x select
          · / search · Esc close · ? this hint
        </div>
      )}

      {checked.size > 0 && (
        <div
          className="canvas-multibar ee-bulk"
          role="toolbar"
          aria-label="bulk actions"
        >
          <span className="canvas-selection-count">
            {checked.size} selected
          </span>
          <label className="muted">
            Status{' '}
            <select
              aria-label="bulk status"
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'active' || v === 'icebox')
                  void bulk({ status: v }, `status → ${v}`);
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
              aria-label="bulk type"
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) void bulk({ note_kind: v }, `type → ${v}`);
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
              aria-label="bulk importance"
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) void bulk({ importance: v }, `importance → ${v}`);
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
            disabled={busy}
            onClick={() => void bulk({ board: null }, 'move to tray')}
          >
            Move to tray
          </button>
          <button
            type="button"
            className="toolbar-btn danger"
            disabled={busy}
            onClick={bulkDiscard}
          >
            Discard
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => setChecked(new Set())}
          >
            Clear
          </button>
        </div>
      )}

      {undo && (
        <output className="ee-undo" aria-live="polite">
          {undo.label}
          <button
            type="button"
            className="small"
            onClick={() => void runUndo()}
          >
            Undo
          </button>
        </output>
      )}

      <div className="ee-table-wrap">
        <table className="ee-table">
          <thead>
            <tr>
              <th className="ee-check">
                <input
                  type="checkbox"
                  aria-label="Select all visible items"
                  checked={allChecked}
                  onChange={toggleAll}
                />
              </th>
              {th('Kind', 'kind')}
              {th('Text', 'text')}
              {th('Type', 'note_kind', 'ee-type')}
              {th('Status', 'status')}
              {th('Importance', 'importance', 'ee-imp')}
              {th('Updated', 'updated_at', 'ee-updated')}
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {shownBoard.length === 0 && trayRows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted ee-empty">
                  Nothing matches — adjust filters or create an item.
                </td>
              </tr>
            )}
            {shownBoard.map(renderRow)}
            {trayRows.length > 0 && (
              <tr className="ee-tray-head">
                <td colSpan={8}>
                  <button
                    type="button"
                    className="ee-tray-toggle-row"
                    aria-expanded={trayOpen}
                    onClick={() => setTrayOpen((o) => !o)}
                  >
                    {trayOpen ? (
                      <ChevronDown size={14} aria-hidden />
                    ) : (
                      <ChevronUp size={14} aria-hidden />
                    )}
                    Capture tray ({trayRows.length})
                  </button>
                </td>
              </tr>
            )}
            {trayOpen &&
              trayRows.map((row) => (
                <TrayRowView
                  key={row.item.id}
                  row={row}
                  checked={checked.has(row.item.id)}
                  focused={focusId === row.item.id}
                  onFocus={() => setFocusId(row.item.id)}
                  onCheck={() => toggleCheck(row)}
                  onEdit={() => setDrawerId(row.item.id)}
                  onPromote={() => {
                    setOpBusy(true);
                    promote(row.item)
                      .catch((e) =>
                        notice(
                          `Add to board failed: ${e instanceof Error ? e.message : String(e)}`,
                        ),
                      )
                      .finally(() => setOpBusy(false));
                  }}
                />
              ))}
          </tbody>
        </table>
        {capped && (
          <p className="muted ee-cap">
            Showing {shownBoard.length} of {boardRows.length} — narrow with
            filters.
          </p>
        )}
      </div>

      {drawerRow && (
        <EditDrawer
          key={drawerRow.item.id}
          row={drawerRow}
          taxonomy={taxonomy}
          busy={busy}
          onPatch={(patch) => patchItem(drawerRow.item, patch)}
          onClose={() => setDrawerId(null)}
        />
      )}
    </div>
  );
}

/** Tray row — same columns plus an Add-to-board action instead of an
 *  empty actions cell. */
function TrayRowView({
  row,
  checked,
  focused,
  onFocus,
  onCheck,
  onEdit,
  onPromote,
}: {
  row: TableRow;
  checked: boolean;
  focused: boolean;
  onFocus: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onPromote: () => void;
}) {
  const { item } = row;
  return (
    <tr
      className={`ee-row tray${focused ? ' focused' : ''}${
        item.status === 'discarded' ? ' discarded' : ''
      }${row.locked ? ' locked' : ''}`}
      tabIndex={focused ? 0 : -1}
      aria-selected={checked}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onFocus();
          if (e.key === 'Enter') onEdit();
        }
      }}
      onDoubleClick={onEdit}
    >
      <td className="ee-check">
        <input
          type="checkbox"
          aria-label={`Select ${item.title ?? item.body ?? item.id}`}
          checked={checked}
          disabled={row.locked}
          onClick={(e) => e.stopPropagation()}
          onChange={onCheck}
        />
      </td>
      <td className="ee-kind">
        <span className="ee-kind-label muted">
          {noteKindMeta(item.note_kind).icon}{' '}
          {item.kind === 'zone' ? 'frame' : item.kind}
        </span>
      </td>
      <td className="ee-text" title={item.title ?? item.body ?? ''}>
        {item.title ?? item.body ?? item.ref ?? '(untitled)'}
      </td>
      <td className="ee-type">{item.note_kind ?? '—'}</td>
      <td>
        <StatusBadge status={item.status} />
      </td>
      <td className="ee-imp">{item.importance ?? '—'}</td>
      <td className="ee-updated muted">
        {fmtAge(item.updated_at ?? item.created_at ?? '')}
      </td>
      <td className="ee-act">
        {row.locked ? (
          <span className="ee-lock" title={`Locked — ${item.status}`}>
            <Lock size={14} aria-hidden />
          </span>
        ) : (
          <>
            <button
              type="button"
              className="canvas-icon-button"
              aria-label={`Add ${item.title ?? item.body ?? item.id} to board`}
              title="Add to board"
              onClick={(e) => {
                e.stopPropagation();
                onPromote();
              }}
            >
              <ArrowUpToLine size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="canvas-icon-button"
              aria-label={`Edit ${item.title ?? item.body ?? item.id}`}
              title="Edit"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              <Pencil size={14} aria-hidden />
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
