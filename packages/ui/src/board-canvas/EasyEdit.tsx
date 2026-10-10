/**
 * EasyEdit.tsx — the non-spatial board-object view (D62,
 * EASY-EDIT-PRD).
 *
 * A dense table projection over the same durable `board_items` the
 * canvas renders — sortable, filterable, checkbox multi-select, bulk
 * OCC-fenced operations, a collapsible tray section with one-click
 * promotion, and a full-page item editor. Geometry and connectors
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
import { CaptureForm } from '../CaptureForm';
import { type IdeaBoardRow, client } from '../api';
import { ConfirmDialog, StatusBadge, fmtAge } from '../components';
import { DictationField } from '../dictation';
import { noteKindMeta } from '../discovery';
import { ItemEditorPage, type SaveOutcome } from './ItemEditorPage';
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
  SORT_KEYS,
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
  /** Single-item OCC write (item-page fields, promote, discard). */
  patchItem: (
    item: BoardItem,
    patch: Record<string, unknown>,
  ) => Promise<SaveOutcome>;
  /** Atomic batch OCC write — bulk ops only. */
  mutate: (mutations: ItemMutation[]) => Promise<BoardItem[]>;
  /** Tray → board promotion (engine path, no geometry). */
  promote: (item: BoardItem) => Promise<unknown>;
  /** Create a board item (no geometry sent). */
  add: (input: { kind?: string; note_kind?: string }) => Promise<BoardItem>;
  /** Create a tray item via capture. */
  capture: (title: string) => Promise<unknown>;
  /** Reload durable state after the capture form writes — the form owns
   *  its own save path; the view re-reads, never merges. */
  refresh: () => void;
  notice: (msg: string) => void;
  /** Route-level write in flight (the editor disables alongside it). */
  busy: boolean;
  editorId: string | null;
  boardName: string;
  openEditor: (id: string) => void;
  closeEditor: () => void;
}

function storageKey(ws: string, board: string): string {
  return `veto.easyedit.${ws}/${board}`;
}

interface PersistedView {
  sort: SortKey;
  dir: SortDir;
  filter: Partial<ViewFilter>;
}

const SORT_KEY_SET = new Set<string>(SORT_KEYS);
const FILTER_KEYS = [
  'search',
  'kind',
  'note_kind',
  'status',
  'importance',
  'showTray',
] as const;

/** Guarded parse — a corrupt entry falls back to defaults per key,
 *  never to a comparator that breaks on an unknown sort. */
function loadView(ws: string, board: string): PersistedView | null {
  try {
    const raw = localStorage.getItem(storageKey(ws, board));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PersistedView>;
    const filter: Partial<ViewFilter> = {};
    if (typeof v.filter === 'object' && v.filter) {
      for (const k of FILTER_KEYS) {
        const val = (v.filter as Record<string, unknown>)[k];
        if (k === 'showTray') {
          if (typeof val === 'boolean') filter.showTray = val;
        } else if (typeof val === 'string' || val === null) {
          (filter as Record<string, unknown>)[k] = val;
        }
      }
    }
    return {
      sort:
        typeof v.sort === 'string' && SORT_KEY_SET.has(v.sort)
          ? (v.sort as SortKey)
          : 'updated_at',
      dir: v.dir === 'asc' ? 'asc' : 'desc',
      filter,
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
  refresh,
  notice,
  busy: routeBusy,
  editorId,
  boardName,
  openEditor,
  closeEditor,
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
  const [trayOpen, setTrayOpen] = useState(true);
  const [hintOpen, setHintOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [capOpen, setCapOpen] = useState(false);
  const [capBoards, setCapBoards] = useState<IdeaBoardRow[]>([]);
  const [opBusy, setOpBusy] = useState(false);
  const busy = routeBusy || opBusy;
  const [undo, setUndo] = useState<{ label: string; cmd: BoardCommand } | null>(
    null,
  );
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);
  const history = useRef(new CommandHistory());
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A freshly created row to DOM-focus once it renders. */
  const pendingFocus = useRef<string | null>(null);

  const rows = useMemo(() => projectRows(surfaces, tray), [surfaces, tray]);
  const view = useMemo(
    () => applyView(rows, filter, sort, dir),
    [rows, filter, sort, dir],
  );
  const boardRows = useMemo(
    () => view.filter((r) => r.section === 'board'),
    [view],
  );
  const trayRows = useMemo(
    () => view.filter((r) => r.section === 'tray'),
    [view],
  );
  const capped = boardRows.length > ROW_CAP;
  const shownBoard = useMemo(
    () => (capped ? boardRows.slice(0, ROW_CAP) : boardRows),
    [boardRows, capped],
  );
  const visibleRows = useMemo(
    () => [...shownBoard, ...(trayOpen ? trayRows : [])],
    [shownBoard, trayOpen, trayRows],
  );
  const moveFocus = useCallback((id: string | null) => {
    setFocusId(id);
    const target = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [],
    ).find((el) => el.dataset.rowId === id);
    target?.focus();
  }, []);

  // A created row receives real DOM focus once it renders (EE-E).
  useEffect(() => {
    const id = pendingFocus.current;
    if (id && visibleRows.some((r) => r.item.id === id)) {
      pendingFocus.current = null;
      moveFocus(id);
    }
  }, [visibleRows, moveFocus]);

  // Persist view state (fail-soft).
  useEffect(() => {
    saveView(ws, board, { sort, dir, filter });
  }, [ws, board, sort, dir, filter]);

  // Seed the capture form's destination list; the form refetches
  // internally on workspace change, so a stale board is never offered.
  useEffect(() => {
    let live = true;
    client
      .ideaBoards(ws)
      .then((r) => {
        if (live) setCapBoards(r.boards);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ws]);

  // SSE refresh lands new durable rows — prune view-state ids that no
  // longer exist; the editor follows the refreshed row automatically.
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.item.id));
    setChecked((c) => {
      const next = new Set([...c].filter((id) => ids.has(id)));
      return next.size === c.size ? c : next;
    });
    if (focusId && !ids.has(focusId)) setFocusId(null);
    if (editorId && !ids.has(editorId)) {
      notice("That item is no longer available. You're back in Easy Edit.");
      closeEditor();
    }
  }, [rows, focusId, editorId, notice, closeEditor]);

  const previousEditorId = useRef<string | null>(editorId);
  useEffect(() => {
    const prior = previousEditorId.current;
    previousEditorId.current = editorId;
    if (prior && !editorId) requestAnimationFrame(() => moveFocus(prior));
  }, [editorId, moveFocus]);

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
    const targets = shownBoard.filter(
      (r) => checked.has(r.item.id) && !r.locked,
    );
    if (targets.length === 0) return;
    const mutations: ItemMutation[] = [];
    for (const r of targets) {
      if (r.item.updated_at == null) {
        notice(
          `Nothing changed: ${r.item.id} has no saved version. Refresh before trying again.`,
        );
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
    if (checked.size >= 10) {
      setConfirmDiscard(checked.size);
      return;
    }
    void bulk({ status: 'discarded' }, `discard ${checked.size} items`);
  };

  /** Capture save landed — re-read durable state, focus the new row
   *  once it renders (board rows land in the table, tray saves in the
   *  tray section; other-board saves navigate via the banner link). */
  const onCaptured = useCallback(
    (item: BoardItem, dest: string) => {
      if (dest === board || dest === 'tray') pendingFocus.current = item.id;
      refresh();
      notice(`captured → ${dest === 'tray' ? 'tray' : dest}`);
    },
    [board, refresh, notice],
  );

  const createNote = useCallback(() => {
    if (busy) return;
    setOpBusy(true);
    add({ kind: 'note', note_kind: 'idea' })
      .then((item) => {
        pendingFocus.current = item.id;
        setFocusId(item.id);
      })
      .catch((e) =>
        notice(`Create failed: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => setOpBusy(false));
  }, [add, notice, busy]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (
      isTypingTarget(e.target) ||
      (e.target instanceof HTMLElement && e.target.closest('button'))
    )
      return;
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
        if (row) openEditor(row.item.id);
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
        if (hintOpen) setHintOpen(false);
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

  const editorRow = editorId
    ? rows.find((r) => r.item.id === editorId)
    : undefined;

  const edit = (id: string) => {
    setFocusId(id);
    openEditor(id);
  };

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
        tabIndex={
          focused || (!focusId && visibleRows[0]?.item.id === item.id) ? 0 : -1
        }
        onClick={() => moveFocus(item.id)}
        onFocus={() => setFocusId(item.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            setFocusId(item.id);
            if (e.key === 'Enter') edit(item.id);
          }
        }}
        onDoubleClick={() => edit(item.id)}
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
          <span className="ee-mobile-kind" aria-hidden="true">
            {noteKindMeta(item.note_kind).icon}
          </span>
          <span className="ee-text-value">
            {item.title || item.body || item.ref || 'Untitled'}
          </span>
        </td>
        <td className="ee-type">
          {item.kind === 'note' ? noteKindMeta(item.note_kind).label : '—'}
        </td>
        <td className="ee-status">
          <StatusBadge status={item.status} />
        </td>
        <td className="ee-imp">{item.importance ?? '—'}</td>
        <td className="ee-updated muted">
          {fmtAge(item.updated_at ?? item.created_at ?? '')}
        </td>
        <td className="ee-act">
          {row.locked ? (
            <button
              type="button"
              className="ee-lock"
              title={`Locked — ${item.status}`}
              aria-label={`Locked — ${item.status}`}
              onClick={(e) => {
                e.stopPropagation();
                edit(item.id);
              }}
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
                edit(item.id);
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

  if (editorRow) {
    return (
      <div className="ee-root">
        <ItemEditorPage
          row={editorRow}
          boardName={boardName}
          taxonomy={taxonomy}
          busy={busy}
          onPatch={(patch) => patchItem(editorRow.item, patch)}
          onPromote={() => promote(editorRow.item)}
          onBack={closeEditor}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="ee-root" onKeyDown={onKeyDown}>
      <section
        className={`ee-capture${capOpen ? ' open' : ''}`}
        aria-label="Quick capture"
      >
        <button
          type="button"
          className="ee-capture-toggle"
          aria-expanded={capOpen}
          onClick={() => setCapOpen((open) => !open)}
        >
          <span className="ee-capture-mark">
            <Plus size={16} aria-hidden />
          </span>
          <span>
            <strong>Capture an idea</strong>
            <small>Add it to this board or send it to the tray.</small>
          </span>
          <span className="spacer" />
          {capOpen ? (
            <ChevronUp size={16} aria-hidden />
          ) : (
            <ChevronDown size={16} aria-hidden />
          )}
        </button>
        {capOpen && (
          <CaptureForm
            workspaces={[ws]}
            boards={capBoards}
            noteKinds={taxonomy}
            defaultWorkspace={ws}
            defaultDestination={board}
            onSaved={onCaptured}
          />
        )}
      </section>

      <div className="ee-list-heading">
        <div>
          <h1>Items</h1>
          <p>
            {view.length} {view.length === 1 ? 'item' : 'items'} in this view
          </p>
        </div>
      </div>
      <div className="ee-toolbar" aria-label="Item tools">
        <label className="ee-search">
          <Search size={14} aria-hidden />
          <DictationField>
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
          </DictationField>
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
            onClick={createNote}
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
                    .then((item) => {
                      pendingFocus.current = item.id;
                      setFocusId(item.id);
                    })
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

      {confirmDiscard !== null && (
        <ConfirmDialog
          title={`Discard ${confirmDiscard} items?`}
          body="They'll move to Discarded status — the undo bar can restore them right after."
          confirmLabel="Discard"
          danger
          busy={busy}
          onConfirm={() => {
            const n = confirmDiscard;
            setConfirmDiscard(null);
            void bulk({ status: 'discarded' }, `discard ${n} items`);
          }}
          onCancel={() => setConfirmDiscard(null)}
        />
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
              {th('Kind', 'kind', 'ee-kind')}
              {th('Text', 'text', 'ee-text')}
              {th('Type', 'note_kind', 'ee-type')}
              {th('Status', 'status', 'ee-status')}
              {th('Importance', 'importance', 'ee-imp')}
              {th('Updated', 'updated_at', 'ee-updated')}
              <th className="ee-act" aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {shownBoard.length === 0 && trayRows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted ee-empty">
                  {rows.length === 0 ? (
                    <>
                      <p>No items on this board yet.</p>
                      <button
                        type="button"
                        className="primary small"
                        onClick={createNote}
                        disabled={busy}
                      >
                        <Plus size={14} aria-hidden /> Add the first item
                      </button>
                    </>
                  ) : (
                    'Nothing matches — adjust filters or create an item.'
                  )}
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
                  onEdit={() => edit(row.item.id)}
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
      data-row-id={item.id}
      className={`ee-row tray${focused ? ' focused' : ''}${
        item.status === 'discarded' ? ' discarded' : ''
      }${row.locked ? ' locked' : ''}`}
      tabIndex={focused ? 0 : -1}
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
        <span className="ee-mobile-kind" aria-hidden="true">
          {noteKindMeta(item.note_kind).icon}
        </span>
        <span className="ee-text-value">
          {item.title ?? item.body ?? item.ref ?? '(untitled)'}
        </span>
      </td>
      <td className="ee-type">{item.note_kind ?? '—'}</td>
      <td className="ee-status">
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
