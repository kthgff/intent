/**
 * BoardCanvas.tsx — the React Flow surface + persistence bridge
 * (BOARD-CANVAS-TDD "Component topology").
 *
 * React Flow owns viewport transforms, hit testing, marquee selection,
 * drag/resize gestures, and edge drawing. This layer owns:
 *   - the durable→node projection (model.ts) and one-mutation-per-
 *     gesture persistence through the OCC-fenced batch endpoint;
 *   - zone membership recomputed at gesture end (never `extent:
 *     'parent'` — dragging out of a frame must be able to clear it);
 *   - explicit tool modes, double-click/paste/rail creation, Space
 *     temporary pan, and keyboard-only operation;
 *   - 500 ms text autosave, save-state surface, and 409 conflict
 *     recovery that restores durable state and keeps drafts;
 *   - session undo/redo as *new fenced writes* (history.ts).
 */
import type {
  BoardAnnotation,
  BoardConnector,
  BoardItem,
  BoardProposalRow,
  BoardVote,
  BoardVoteSession,
} from '@veto/core';
import {
  Background,
  BackgroundVariant,
  type Connection,
  type EdgeChange,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type IdeaBoardDetail } from '../api';
import { ConnectorEdge } from './ConnectorEdge';
import { AnnotationLayer, DrawCapture, annotationBounds } from './annotations';
import { projectProposals } from './assistant';
import {
  BULK_FIELDS,
  CommandHistory,
  type ItemMutation,
  type ItemPatch,
  PATCHABLE_FIELDS,
  type PatchableField,
  makeCommand,
  makeCreateCommand,
} from './history';
import { arrange } from './layout';
import { BoardMinimap } from './minimap';
import {
  type CanvasEdge,
  type CanvasNode,
  type CanvasTool,
  type DrawKind,
  absoluteRect,
  containingZone,
  defaultSizeFor,
  projectConnectors,
  projectItems,
} from './model';
import {
  type CanvasActions,
  CanvasActionsProvider,
  CommentPinNode,
  GhostNode,
  ImageNode,
  LinkNode,
  StickyNode,
  type TextField,
  TextNode,
  ZoneNode,
} from './nodes';
import {
  ArrangePreviewBar,
  CommentThread,
  ConflictNotice,
  ConnectorBar,
  DrawBar,
  MultiSelectBar,
  ObjectsPanel,
  SaveBadge,
  type SaveState,
  TimerChip,
  TrayDock,
  VoteSessionChip,
  VoteStampBar,
  ZoomControls,
} from './overlays';
import { PresentationBar } from './presentation';
import { commentThreads, threadKeyOf } from './tools/comment';
import { orderedZones } from './tools/presentation';
import { ToolRail } from './tools/rail';
import { nodeAtPoint } from './tools/select';
import { openSession, visibleTallies } from './tools/vote';

const nodeTypes = {
  sticky: StickyNode,
  text: TextNode,
  zone: ZoneNode,
  link: LinkNode,
  image: ImageNode,
  comment: CommentPinNode,
  ghost: GhostNode,
};
const edgeTypes = { connector: ConnectorEdge };
const defaultEdgeOptions = { type: 'connector' as const };

/** Create tools that place an object on a pane click. */
const CREATE_TOOLS = new Set<CanvasTool>(['sticky', 'text', 'zone', 'link']);

const viewportKey = (ws: string, board: string) =>
  `veto.canvas.viewport.${ws}.${board}`;

function readViewport(ws: string, board: string) {
  try {
    const raw = localStorage.getItem(viewportKey(ws, board));
    if (!raw) return null;
    const v = JSON.parse(raw) as { x?: number; y?: number; zoom?: number };
    return Number.isFinite(v.x) &&
      Number.isFinite(v.y) &&
      Number.isFinite(v.zoom)
      ? { x: v.x as number, y: v.y as number, zoom: v.zoom as number }
      : null;
  } catch {
    return null;
  }
}

export interface BoardCanvasHandlers {
  /** Create an item at a flow coordinate; resolves to the row. */
  add(input: {
    kind: string;
    note_kind?: string;
    title: string;
    body?: string;
    ref?: string | null;
    x: number;
    y: number;
    w?: number;
    h?: number;
  }): Promise<BoardItem>;
  /** Atomic OCC-fenced batch mutation; resolves to updated rows. */
  mutate(mutations: ItemMutation[]): Promise<BoardItem[]>;
  connect(source: string, target: string): Promise<BoardConnector>;
  /** OCC-fenced connector update (label). */
  patchConnector(
    id: string,
    patch: { label?: string | null },
    expectedUpdatedAt: string,
  ): Promise<BoardConnector | null>;
  /** Supersede a connector — soft-delete, no hard delete. */
  removeConnector(id: string): Promise<void>;
  /** Promote a tray item onto the board at an optional drop point. */
  promote(item: BoardItem, pos?: { x: number; y: number }): Promise<void>;
  /** Drawing layer — one durable POST per completed stroke/shape. */
  addAnnotation(input: {
    kind: BoardAnnotation['kind'];
    geometry: BoardAnnotation['geometry'];
  }): Promise<BoardAnnotation>;
  /** Drawings are not governed artifacts — a real delete is legal. */
  removeAnnotation(id: string): Promise<void>;
  /** Vote stamps — upsert the caller's row in the open session. */
  castVote(input: {
    session_id: string;
    item_id: string;
    stamp: BoardVote['stamp'];
  }): Promise<BoardVote>;
  openVoteSession(): Promise<BoardVoteSession>;
  closeVoteSession(session: BoardVoteSession): Promise<BoardVoteSession>;
  /** Durable re-read (SSE invalidation, conflict recovery). */
  refresh(): void;
  /** Non-blocking notice surface (toasts). */
  notice(msg: string): void;
}

export interface BoardCanvasProps {
  data: IdeaBoardDetail;
  ws: string;
  board: string;
  tray: BoardItem[];
  /** Below-900px read mode: no editing gestures, inspector read-only. */
  readOnly: boolean;
  /** Note-kind options for the bulk bar's type verb (Easy Edit parity). */
  taxonomy: string[];
  /** `ui.canvas_draw` — the draw group + layer render behind this flag. */
  drawEnabled: boolean;
  /** `?votes=show` — surface the latest session's tallies while closed. */
  showVotes: boolean;
  selected: string | null;
  onSelect(id: string | null): void;
  handlers: BoardCanvasHandlers;
  /** BOARD-CHAT-TDD (wp-166): pending `board_proposals` rows projected
   *  as ghost nodes/edges. Dormant until wp-165 wires IdeaBoard —
   *  absent/empty renders exactly the unmodified canvas. */
  proposals?: BoardProposalRow[];
  /** Ghost click surfaces the source proposal (wp-165 → thread
   *  scroll). Optional: ghosts stay inert without it. */
  onGhostClick?: (proposal: BoardProposalRow) => void;
  /** BOARD-CHAT deep-link (wp-165): pan/zoom to a flow-coordinate
   *  center point. `seq` retriggers identical coordinates (clicking
   *  the same proposal twice). */
  focus?: { x: number; y: number; seq: number } | null;
}

interface ConflictState {
  itemId: string;
  draft: { field: TextField; text: string } | null;
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    el.isContentEditable === true
  );
}

/** prefers-reduced-motion — viewport animations jump instead of
 *  animating (TDD: reduced motion disables animated viewport fitting). */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function InnerCanvas({
  data,
  ws,
  board,
  tray,
  readOnly,
  taxonomy,
  drawEnabled,
  showVotes,
  selected,
  onSelect,
  handlers,
  proposals,
  onGhostClick,
  focus,
}: BoardCanvasProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tool, setTool] = useState<CanvasTool>('select');
  const [spacePan, setSpacePan] = useState(false);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [selectedConnector, setSelectedConnector] = useState<string | null>(
    null,
  );
  const [objectsOpen, setObjectsOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [trayBusy, setTrayBusy] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  // TOOLS-TDD tool state — vote stamp, draw shape, thread popover,
  // presentation mode, and the annotation under delete-selection are
  // all transient (lost on reload by design, §1 durability table).
  const [voteStamp, setVoteStamp] = useState<'up' | 'down' | 'question'>('up');
  const [drawKind, setDrawKind] = useState<DrawKind>('stroke');
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [presentIndex, setPresentIndex] = useState(0);
  const [livePath, setLivePath] = useState<string | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(
    null,
  );
  const [sessionBusy, setSessionBusy] = useState(false);
  // Arrange preview — positions staged on the canvas, written only on
  // Apply (TOOLS-TDD §3 cluster/auto-layout: preview before write).
  const [arrangePreview, setArrangePreview] = useState<{
    label: string;
    mutations: ItemMutation[];
    before: BoardItem[];
    lockedSkipped: number;
  } | null>(null);

  const history = useRef(new CommandHistory());
  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastDraft = useRef(
    new Map<string, { field: TextField; text: string }>(),
  );
  const keyMove = useRef<{
    ids: Set<string>;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ ids: new Set(), timer: null });

  const itemsById = useMemo(() => {
    const m = new Map<string, BoardItem>();
    for (const s of data.items) m.set(s.item.id, s.item);
    return m;
  }, [data]);

  const connectorsById = useMemo(() => {
    const m = new Map<string, BoardConnector>();
    for (const c of data.connectors ?? []) m.set(c.id, c);
    return m;
  }, [data]);

  // Vote tallies the badges may show — an open session's live counts,
  // or the latest session under `?votes=show` (TOOLS-TDD §2.4).
  const tallies = useMemo(
    () => visibleTallies(data.votes ?? [], data.vote_sessions ?? [], showVotes),
    [data.votes, data.vote_sessions, showVotes],
  );
  const openVote = useMemo(
    () => openSession(data.vote_sessions ?? []),
    [data.vote_sessions],
  );

  const projected = useMemo(
    () => projectItems(data.items, editingId, { votes: tallies }),
    [data.items, editingId, tallies],
  );
  const [nodes, setNodes] = useState<CanvasNode[]>(projected);
  const [edges, setEdges] = useState<CanvasEdge[]>(() =>
    projectConnectors(data.connectors ?? []),
  );

  // BOARD-CHAT ghost projection (wp-166) — O(pending), memoized on
  // (proposals, items). Ghosts stay OUT of `nodes`/`edges` state so
  // they can never enter selection, marquee, history, or undo; they
  // are appended only at the React Flow boundary below.
  const ghosts = useMemo(
    () => projectProposals(proposals ?? [], data.items, data.connectors ?? []),
    [proposals, data.items, data.connectors],
  );
  const renderedNodes = useMemo(
    () => (ghosts.nodes.length ? [...nodes, ...ghosts.nodes] : nodes),
    [nodes, ghosts],
  );
  const renderedEdges = useMemo(
    () => (ghosts.edges.length ? [...edges, ...ghosts.edges] : edges),
    [edges, ghosts],
  );

  // Server state replaces the projection wholesale; keep the selection
  // flags that survive (ids still present) — TDD: refresh preserves
  // viewport and valid selection.
  useEffect(() => {
    setNodes((prev) => {
      const selectedIds = new Set(
        prev.filter((n) => n.selected).map((n) => n.id),
      );
      // Rows that vanished remotely can't be undone into — drop their
      // commands so history never references ghosts.
      const nextIds = new Set(projected.map((n) => n.id));
      const gone = prev.filter((n) => !nextIds.has(n.id)).map((n) => n.id);
      if (gone.length) history.current.dropReferences(new Set(gone));
      return projected.map((n) =>
        selectedIds.has(n.id) ? { ...n, selected: true } : n,
      );
    });
  }, [projected]);
  useEffect(() => {
    setEdges((prev) => {
      const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return projectConnectors(data.connectors ?? []).map((e) =>
        sel.has(e.id) ? { ...e, selected: true } : e,
      );
    });
  }, [data.connectors]);

  const selectedIds = useMemo(
    () => nodes.filter((n) => n.selected).map((n) => n.id),
    [nodes],
  );

  const { screenToFlowPosition, setCenter, getViewport, fitView, fitBounds } =
    useReactFlow();
  const savedViewport = useMemo(() => readViewport(ws, board), [ws, board]);
  const shellRef = useRef<HTMLDivElement>(null);

  // BOARD-CHAT deep-link (wp-165): clicking a proposal/message pans the
  // viewport to its position. seq-keyed — a repeated request re-centers.
  useEffect(() => {
    if (!focus) return;
    void setCenter(focus.x, focus.y, {
      zoom: Math.max(getViewport().zoom, 1),
      duration: prefersReducedMotion() ? 0 : 300,
    });
  }, [focus, setCenter, getViewport]);

  const focusNode = useCallback((id: string) => {
    requestAnimationFrame(() => {
      shellRef.current
        ?.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
        ?.focus();
    });
  }, []);

  // Keep successful acknowledgement visible long enough to register,
  // then return to the quiet idle state. The saving badge itself has a
  // short CSS reveal delay so fast writes do not flash.
  useEffect(() => {
    if (saveState !== 'saved') return;
    const timer = window.setTimeout(() => setSaveState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  useEffect(
    () => () => {
      for (const timer of draftTimers.current.values()) clearTimeout(timer);
      if (keyMove.current.timer) clearTimeout(keyMove.current.timer);
    },
    [],
  );

  const bumpHistory = useCallback(() => setHistoryTick((t) => t + 1), []);
  void historyTick; // re-render marker for undo/redo button state

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  /** Issue a fenced batch; on success record the undoable command and
   *  show save state. `before` = the durable rows the command can
   *  restore. */
  const applyMutations = useCallback(
    async (
      mutations: ItemMutation[],
      label: string,
      before: BoardItem[],
      fields: readonly PatchableField[] = PATCHABLE_FIELDS,
    ): Promise<BoardItem[] | null> => {
      if (mutations.length === 0) return [];
      setSaveState('saving');
      try {
        const rows = await handlers.mutate(mutations);
        history.current.push(makeCommand(label, before, rows, fields));
        bumpHistory();
        setSaveState('saved');
        setConflict(null);
        return rows;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setSaveState('conflict');
          handlers.refresh();
        } else {
          setSaveState('offline');
          handlers.notice(
            `Save failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return null;
      }
    },
    [handlers, bumpHistory],
  );

  const currentRow = useCallback(
    (id: string) => itemsById.get(id),
    [itemsById],
  );

  const fencedMutation = useCallback(
    (id: string, patch: ItemPatch): ItemMutation | null => {
      const item = currentRow(id);
      if (!item || item.updated_at == null) return null;
      return { id, expected_updated_at: item.updated_at, patch };
    },
    [currentRow],
  );

  // ------------------------------------------------------------------
  // Node/edge change application + selection tracking
  // ------------------------------------------------------------------

  const commitKeyboardMoves = useCallback(() => {
    const ids = [...keyMove.current.ids];
    keyMove.current.ids.clear();
    keyMove.current.timer = null;
    setNodes((latest) => {
      const moved = latest.filter((n) => ids.includes(n.id) && !n.data.locked);
      if (moved.length === 0) return latest;
      const mutations: ItemMutation[] = [];
      const before: BoardItem[] = [];
      for (const n of moved) {
        const item = n.data.item;
        if (item.updated_at == null) continue;
        const abs = absoluteRect(n, latest);
        const zone = containingZone(n, latest);
        const patch: ItemPatch = { x: abs.x, y: abs.y, w: abs.w, h: abs.h };
        // Only write membership when it changed; a legacy string label
        // survives until a real frame claims or releases the item.
        if (
          zone !== (item.zone ?? null) &&
          (zone !== null || isRealZoneId(item.zone ?? null, latest))
        ) {
          patch.zone = zone;
        }
        mutations.push({
          id: item.id,
          expected_updated_at: item.updated_at,
          patch,
        });
        before.push(item);
      }
      if (mutations.length) void applyMutations(mutations, 'move', before);
      return latest;
    });
  }, [applyMutations]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      for (const c of changes) {
        // Keyboard arrow moves land as position changes with
        // dragging:false — coalesce them into one fenced write.
        if (
          c.type === 'position' &&
          c.dragging === false &&
          c.position !== undefined
        ) {
          keyMove.current.ids.add(c.id);
          if (keyMove.current.timer) clearTimeout(keyMove.current.timer);
          keyMove.current.timer = setTimeout(commitKeyboardMoves, 400);
        }
      }
      setNodes((n) => applyNodeChanges(changes, n));
    },
    [commitKeyboardMoves],
  );

  // Selection → inspector + connector bar (kept out of the change
  // handlers so upstream state never updates inside a reducer).
  useEffect(() => {
    const sel = nodes.filter((n) => n.selected);
    onSelect(sel.length === 1 ? (sel[0]?.id ?? null) : null);
  }, [nodes, onSelect]);

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    setEdges((e) => applyEdgeChanges(changes, e));
  }, []);

  useEffect(() => {
    const sel = edges.filter((e) => e.selected);
    setSelectedConnector(sel.length === 1 ? (sel[0]?.id ?? null) : null);
  }, [edges]);

  // ------------------------------------------------------------------
  // Gesture-end persistence (drag / resize / zone membership)
  // ------------------------------------------------------------------

  const persistGesture = useCallback(
    (moved: CanvasNode[]) => {
      setNodes((latest) => {
        const mutations: ItemMutation[] = [];
        const before: BoardItem[] = [];
        const movingZone = moved.find((n) => n.type === 'zone');
        // Moving a zone carries its mutable children in the same batch;
        // locked children keep their absolute position untouched.
        const extra: CanvasNode[] = [];
        if (movingZone) {
          for (const n of latest) {
            if (
              n.parentId === movingZone.id &&
              !moved.includes(n) &&
              !n.data.locked
            ) {
              extra.push(n);
            }
          }
        }
        for (const n of [...moved, ...extra]) {
          const item = n.data.item;
          if (item.updated_at == null || n.data.locked) continue;
          const abs = absoluteRect(n, latest);
          const patch: ItemPatch = { x: abs.x, y: abs.y, w: abs.w, h: abs.h };
          if (n.type !== 'zone') {
            const zone = containingZone(n, latest);
            const zoneValue = zone ?? null;
            const current = item.zone ?? null;
            // Only write membership when it actually changed; a legacy
            // string label stays readable until a real frame claims it.
            if (
              zoneValue !== current &&
              (zone !== null || isRealZoneId(current, latest))
            ) {
              patch.zone = zoneValue;
            }
          }
          mutations.push({
            id: item.id,
            expected_updated_at: item.updated_at,
            patch,
          });
          before.push(item);
        }
        if (mutations.length) void applyMutations(mutations, 'move', before);
        return latest;
      });
    },
    [applyMutations],
  );

  const onNodeDragStop = useCallback(
    (_e: unknown, _node: CanvasNode, dragged: CanvasNode[]) => {
      persistGesture(dragged.length ? dragged : [_node]);
    },
    [persistGesture],
  );

  // ------------------------------------------------------------------
  // Comment pins (TOOLS-TDD §2.3) — durable `kind='feedback'` +
  // `note_kind='comment'` items; resolve archives, never deletes.
  // ------------------------------------------------------------------

  /** Drop a pin at a flow point. `refId` pins to a known node (the
   *  comment tool's node click); otherwise the topmost node under the
   *  point is the target, else the pin is free-standing. */
  const placeComment = useCallback(
    (pos: { x: number; y: number }, refId?: string) => {
      const target =
        refId !== undefined
          ? (nodes.find((n) => n.id === refId) ?? null)
          : nodeAtPoint(pos, nodes);
      void handlers
        .add({
          kind: 'feedback',
          note_kind: 'comment',
          title: '',
          ref: target?.id ?? null,
          x: pos.x,
          y: pos.y,
          ...defaultSizeFor('comment'),
        })
        .then((created) => {
          history.current.push(makeCreateCommand(created));
          bumpHistory();
          setOpenThread(threadKeyOf(created));
        })
        .catch((e) =>
          handlers.notice(
            `Comment failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    },
    [nodes, handlers, bumpHistory],
  );

  const commentThreadsByKey = useMemo(
    () => commentThreads(data.items.map((s) => s.item)),
    [data.items],
  );

  const openThreadList = useMemo(
    () => (openThread ? (commentThreadsByKey.get(openThread) ?? []) : []),
    [openThread, commentThreadsByKey],
  );

  /** The item a thread is anchored to — the popover's heading. */
  const openThreadTitle = useMemo(() => {
    if (!openThread) return '';
    const target = itemsById.get(openThread);
    if (target && target.note_kind !== 'comment') {
      return target.title ?? target.body ?? 'item';
    }
    return 'Free-standing pin';
  }, [openThread, itemsById]);

  const resolveComment = useCallback(
    (comment: BoardItem) => {
      const m = fencedMutation(comment.id, { note_status: 'resolved' });
      if (!m) return;
      void applyMutations([m], 'resolve comment', [comment], BULK_FIELDS);
    },
    [fencedMutation, applyMutations],
  );

  /** A reply fills the pin's empty body when one exists; otherwise it
   *  lands as a new comment row in the same thread. */
  const replyComment = useCallback(
    (text: string) => {
      if (!openThread) return;
      const empty = openThreadList.find(
        (c) => !(c.body ?? '').trim() && !(c.title ?? '').trim(),
      );
      if (empty) {
        const m = fencedMutation(empty.id, { body: text });
        if (!m) return;
        void applyMutations([m], 'comment', [empty], BULK_FIELDS);
        return;
      }
      const anchor = openThreadList[0] ?? itemsById.get(openThread) ?? null;
      const base = anchor
        ? { x: (anchor.x ?? 0) + 24, y: (anchor.y ?? 0) + 24 }
        : { x: 0, y: 0 };
      void handlers
        .add({
          kind: 'feedback',
          note_kind: 'comment',
          title: '',
          body: text,
          ref: openThread,
          x: base.x,
          y: base.y,
          ...defaultSizeFor('comment'),
        })
        .catch((e) =>
          handlers.notice(
            `Comment failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    },
    [
      openThread,
      openThreadList,
      itemsById,
      fencedMutation,
      applyMutations,
      handlers,
    ],
  );

  // ------------------------------------------------------------------
  // Vote stamps + sessions (TOOLS-TDD §2.4) — signal only; closed
  // sessions are enforced server-side (a 409 surfaces as a notice).
  // ------------------------------------------------------------------

  /** Shared write-failure surface (TOOLS-TDD §3): a 409 is a concurrent
   *  conflict — the save-state chip + a truth refresh, never a silent
   *  drop; anything else is a plain notice. */
  const surfaceWriteError = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof ApiError && e.status === 409) {
        setSaveState('conflict');
        handlers.refresh();
      } else {
        handlers.notice(
          `${fallback}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [handlers],
  );

  const castVote = useCallback(
    (node: CanvasNode) => {
      if (!openVote) {
        handlers.notice('No vote session is open — start one first');
        return;
      }
      void handlers
        .castVote({
          session_id: openVote.id,
          item_id: node.id,
          stamp: voteStamp,
        })
        .catch((e) => surfaceWriteError(e, 'Vote rejected'));
    },
    [openVote, voteStamp, handlers, surfaceWriteError],
  );

  const openVoteSession = useCallback(() => {
    setSessionBusy(true);
    void handlers
      .openVoteSession()
      .catch((e) => surfaceWriteError(e, 'Could not open session'))
      .finally(() => setSessionBusy(false));
  }, [handlers, surfaceWriteError]);

  const closeVoteSession = useCallback(
    (session: BoardVoteSession) => {
      setSessionBusy(true);
      void handlers
        .closeVoteSession(session)
        .catch((e) => surfaceWriteError(e, 'Could not close session'))
        .finally(() => setSessionBusy(false));
    },
    [handlers, surfaceWriteError],
  );

  // ------------------------------------------------------------------
  // Drawing layer (TOOLS-TDD §2.6) — one POST per completed gesture;
  // annotations are rows, never nodes.
  // ------------------------------------------------------------------

  const commitAnnotation = useCallback(
    (geometry: BoardAnnotation['geometry']) => {
      void handlers
        .addAnnotation({ kind: drawKind, geometry })
        .catch((e) => surfaceWriteError(e, 'Drawing failed'));
    },
    [drawKind, handlers, surfaceWriteError],
  );

  const deleteAnnotation = useCallback(() => {
    if (!selectedAnnotation) return;
    const id = selectedAnnotation;
    setSelectedAnnotation(null);
    void handlers
      .removeAnnotation(id)
      .catch((e) => surfaceWriteError(e, 'Drawing removal failed'));
  }, [selectedAnnotation, handlers, surfaceWriteError]);

  // ------------------------------------------------------------------
  // Presentation (TOOLS-TDD §2.5) — ordered zones only; Esc exits.
  // ------------------------------------------------------------------

  const slides = useMemo(
    () => orderedZones(data.items.map((s) => s.item)),
    [data.items],
  );

  const presentTo = useCallback(
    (index: number) => {
      const slide = slides[index];
      if (!slide) return;
      setPresentIndex(index);
      // fitView honors reduced motion — zero duration jumps (§3).
      const duration = prefersReducedMotion() ? 0 : 400;
      void fitView({ nodes: [{ id: slide.id }], duration, padding: 0.15 });
    },
    [slides, fitView],
  );

  const startPresentation = useCallback(() => {
    if (slides.length === 0) {
      handlers.notice('No ordered frames — set a slide order on a frame first');
      return;
    }
    setPresenting(true);
    presentTo(0);
    // Focus lands on the chrome once it mounts — keyboard flow (and
    // screen readers) move with the mode, not left on the canvas.
    requestAnimationFrame(() =>
      shellRef.current
        ?.querySelector<HTMLElement>('.canvas-present-bar button')
        ?.focus(),
    );
  }, [slides.length, presentTo, handlers]);

  const exitPresentation = useCallback(() => {
    setPresenting(false);
    shellRef.current?.focus();
  }, []);

  // ------------------------------------------------------------------
  // Creation
  // ------------------------------------------------------------------

  const createAt = useCallback(
    async (clientX: number, clientY: number, forTool: CanvasTool) => {
      if (readOnly) return;
      const p = screenToFlowPosition({ x: clientX, y: clientY });
      const kindMap: Partial<Record<CanvasTool, string>> = {
        sticky: 'note',
        text: 'text',
        zone: 'zone',
        link: 'link',
        image: 'image',
      };
      const kind = kindMap[forTool] ?? 'note';
      if (forTool === 'link') {
        const url = window.prompt('Link URL (https://…)');
        if (!url) return;
        try {
          const u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            handlers.notice('Only http(s) links are supported');
            return;
          }
          const item = await handlers.add({
            kind: 'link',
            title: u.hostname,
            ref: url,
            x: p.x,
            y: p.y,
            ...defaultSizeFor('link'),
          });
          history.current.push(makeCreateCommand(item));
          bumpHistory();
          setTool('select');
          focusNode(item.id);
          return;
        } catch {
          handlers.notice('That is not a valid URL');
          return;
        }
      }
      if (forTool === 'image') return; // tool disabled — see threat-model blocker
      const size = defaultSizeFor(
        kind === 'zone' ? 'zone' : kind === 'text' ? 'text' : 'sticky',
      );
      try {
        const item = await handlers.add({
          kind,
          title:
            kind === 'zone' ? 'New frame' : kind === 'text' ? '' : 'New idea',
          x: p.x,
          y: p.y,
          w: size.w,
          h: size.h,
        });
        history.current.push(makeCreateCommand(item));
        bumpHistory();
        if (kind === 'note' || kind === 'text') {
          setEditingId(item.id);
        } else {
          // Zones/links skip inline editing — focus the created node so
          // keyboard flow resumes on the object (TDD: focus is restored
          // to the canvas after creation).
          focusNode(item.id);
        }
        setTool('select');
      } catch (e) {
        handlers.notice(
          `Add failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [readOnly, screenToFlowPosition, handlers, bumpHistory, focusNode],
  );

  const onPaneClick = useCallback(
    (e: { clientX: number; clientY: number }) => {
      if (CREATE_TOOLS.has(tool)) {
        void createAt(e.clientX, e.clientY, tool);
        return;
      }
      // Comment pins stay placeable in read mode — participation, not
      // mutation chrome (TOOLS-TDD §2.3/§3).
      if (tool === 'comment') {
        placeComment(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        return;
      }
      if (tool === 'connector') setPendingSource(null);
      setOpenThread(null);
      setSelectedAnnotation(null);
      onSelect(null);
      setSelectedConnector(null);
    },
    [tool, createAt, onSelect, placeComment, screenToFlowPosition],
  );

  const onDoubleClickCapture = useCallback(
    (e: React.MouseEvent) => {
      // Double-click on empty canvas creates a sticky at that point
      // (zoom-on-double-click is disabled).
      const t = e.target as HTMLElement;
      if (readOnly || !t.classList.contains('react-flow__pane')) {
        return;
      }
      void createAt(e.clientX, e.clientY, 'sticky');
    },
    [readOnly, createAt],
  );

  // ------------------------------------------------------------------
  // Connectors
  // ------------------------------------------------------------------

  const onNodeClick = useCallback(
    (_e: unknown, node: CanvasNode) => {
      // Ghost click surfaces the source proposal (wp-165 wires this
      // to the thread scroll) — never a selection.
      const ghost = node.data.ghost;
      if (ghost) {
        onGhostClick?.(ghost.proposal);
        return;
      }
      if (tool === 'vote') {
        castVote(node);
        return;
      }
      if (tool === 'comment') {
        // Comment tool on a pin opens its thread; on any other node it
        // attaches a new pin beside that node (TOOLS-TDD §2.3).
        if (node.type === 'comment') {
          setOpenThread(threadKeyOf(node.data.item));
        } else {
          const r = absoluteRect(node, nodes);
          placeComment({ x: r.x + r.w + 12, y: r.y }, node.id);
        }
        return;
      }
      if (tool === 'connector' && !node.data.locked) {
        if (pendingSource && pendingSource !== node.id) {
          void handlers
            .connect(pendingSource, node.id)
            .then(() => setPendingSource(null))
            .catch((err) => {
              setPendingSource(null);
              handlers.notice(
                `Connect rejected: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        } else {
          setPendingSource(node.id);
        }
        return;
      }
      // Selecting a comment pin opens its thread popover (TOOLS-TDD
      // §2.3) — a second click on empty space closes it.
      if (node.type === 'comment') {
        setOpenThread(threadKeyOf(node.data.item));
      }
      onSelect(node.id);
    },
    [
      tool,
      pendingSource,
      handlers,
      onSelect,
      castVote,
      placeComment,
      onGhostClick,
      nodes,
    ],
  );

  const onEdgeClick = useCallback(
    (_e: unknown, edge: CanvasEdge) => {
      const ghost = edge.data?.ghost;
      if (ghost) onGhostClick?.(ghost.proposal);
    },
    [onGhostClick],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || readOnly) return;
      handlers
        .connect(c.source, c.target)
        .catch((err) =>
          handlers.notice(
            `Connect rejected: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
    [handlers, readOnly],
  );

  const patchConnector = useCallback(
    (patch: { label?: string | null }) => {
      if (!selectedConnector) return;
      const conn = connectorsById.get(selectedConnector);
      if (!conn?.updated_at) return;
      handlers
        .patchConnector(selectedConnector, patch, conn.updated_at)
        .then(() => setSelectedConnector(null))
        .catch((err) =>
          handlers.notice(
            `Connector update rejected: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
    [selectedConnector, connectorsById, handlers],
  );

  const supersedeConnector = useCallback(() => {
    if (!selectedConnector) return;
    const id = selectedConnector;
    handlers
      .removeConnector(id)
      .then(() => setSelectedConnector(null))
      .catch((err) =>
        handlers.notice(
          `Connector removal rejected: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }, [selectedConnector, handlers]);

  // ------------------------------------------------------------------
  // Text autosave — 500 ms idle or blur; 409 keeps the draft.
  // ------------------------------------------------------------------

  const saveText = useCallback(
    (id: string, field: TextField, text: string) => {
      const m = fencedMutation(id, { [field]: text } as ItemPatch);
      if (!m) return;
      const before = currentRow(id);
      void applyMutations([m], 'edit text', before ? [before] : []).then(
        (rows) => {
          if (rows === null) {
            // 409 — durable state was restored by refresh; the attempted
            // text survives as a recoverable draft.
            setConflict({ itemId: id, draft: { field, text } });
          }
        },
      );
    },
    [fencedMutation, currentRow, applyMutations],
  );

  const actions: CanvasActions = useMemo(
    () => ({
      editable: !readOnly,
      startEdit: (id) => {
        if (!readOnly) setEditingId(id);
      },
      saveDraft: (id, field, text) => {
        lastDraft.current.set(id, { field, text });
        const t = draftTimers.current.get(id);
        if (t) clearTimeout(t);
        draftTimers.current.set(
          id,
          setTimeout(() => saveText(id, field, text), 500),
        );
      },
      commitText: (id, field, text, baseline) => {
        const t = draftTimers.current.get(id);
        if (t) clearTimeout(t);
        draftTimers.current.delete(id);
        lastDraft.current.delete(id);
        setEditingId(null);
        // The editor passes the text it was seeded with (its display
        // fallback, e.g. title ?? body) — an unchanged draft issues no
        // write. Comparing against the raw field instead turned a
        // title-less sticky's untouched blur into a spurious
        // title = body write.
        if (baseline !== text) saveText(id, field, text);
      },
      setColor: (id, color) => {
        const m = fencedMutation(id, { color });
        if (!m) return;
        const before = currentRow(id);
        void applyMutations([m], 'color', before ? [before] : []);
      },
      duplicate: (id) => {
        const item = currentRow(id);
        if (!item) return;
        const pos =
          item.x != null && item.y != null
            ? { x: item.x + 24, y: item.y + 24 }
            : screenToFlowPosition({ x: 200, y: 200 });
        void handlers
          .add({
            kind: item.kind,
            title: item.title ?? item.body ?? '',
            ...(item.body ? { body: item.body } : {}),
            ...(item.ref ? { ref: item.ref } : {}),
            x: pos.x,
            y: pos.y,
            ...(item.w ? { w: item.w } : {}),
            ...(item.h ? { h: item.h } : {}),
          })
          .then((created) => {
            history.current.push(makeCreateCommand(created));
            bumpHistory();
          })
          .catch((e) =>
            handlers.notice(
              `Duplicate failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      },
      inspect: (id) => onSelect(id),
      endResize: (id, rect) => {
        setNodes((latest) => {
          const node = latest.find((n) => n.id === id);
          const item = currentRow(id);
          if (!node || !item || item.updated_at == null) return latest;
          // Rect arrives in parent-relative coords for zone children —
          // persist absolute geometry per the durable contract.
          const parent = node.parentId
            ? latest.find((n) => n.id === node.parentId)
            : undefined;
          const abs = {
            x: rect.x + (parent?.position.x ?? 0),
            y: rect.y + (parent?.position.y ?? 0),
            w: rect.w,
            h: rect.h,
          };
          const patch: ItemPatch = abs;
          const { parentId: _drop, ...rest } = node;
          const zone = containingZone(
            {
              ...rest,
              position: { x: abs.x, y: abs.y },
              width: abs.w,
              height: abs.h,
            },
            latest,
          );
          if (
            (zone ?? null) !== (item.zone ?? null) &&
            (zone !== null || isRealZoneId(item.zone ?? null, latest))
          ) {
            patch.zone = zone;
          }
          void applyMutations(
            [{ id, expected_updated_at: item.updated_at, patch }],
            'resize',
            [item],
          );
          return latest;
        });
      },
    }),
    [
      readOnly,
      fencedMutation,
      currentRow,
      applyMutations,
      saveText,
      handlers,
      screenToFlowPosition,
      bumpHistory,
      onSelect,
    ],
  );

  // ------------------------------------------------------------------
  // Undo / redo — new fenced writes via the same batch path.
  // ------------------------------------------------------------------

  const doUndo = useCallback(() => {
    const planResult = history.current.planUndo(itemsById);
    if (!planResult.ok) {
      handlers.notice(
        `Undo blocked — ${planResult.conflictId || 'an item'} changed remotely`,
      );
      handlers.refresh();
      return;
    }
    setSaveState('saving');
    handlers
      .mutate(planResult.mutations)
      .then((rows) => {
        history.current.commitUndo(rows);
        bumpHistory();
        setSaveState('saved');
      })
      .catch((e) => {
        setSaveState(
          e instanceof ApiError && e.status === 409 ? 'conflict' : 'offline',
        );
        handlers.refresh();
      });
  }, [handlers, itemsById, bumpHistory]);

  const doRedo = useCallback(() => {
    const planResult = history.current.planRedo(itemsById);
    if (!planResult.ok) {
      handlers.notice(
        `Redo blocked — ${planResult.conflictId || 'an item'} changed remotely`,
      );
      return;
    }
    setSaveState('saving');
    handlers
      .mutate(planResult.mutations)
      .then((rows) => {
        history.current.commitRedo(rows);
        bumpHistory();
        setSaveState('saved');
      })
      .catch((e) => {
        setSaveState(
          e instanceof ApiError && e.status === 409 ? 'conflict' : 'offline',
        );
        handlers.refresh();
      });
  }, [handlers, itemsById, bumpHistory]);

  // ------------------------------------------------------------------
  // Discard (soft-delete) + arrange
  // ------------------------------------------------------------------

  const discardSelection = useCallback(() => {
    const targets = nodes.filter((n) => n.selected && !n.data.locked);
    if (targets.length === 0) return;
    const material = targets.some(
      (n) =>
        n.data.item.title ||
        n.data.item.body ||
        n.data.statementCount > 0 ||
        (data.connectors ?? []).some(
          (c) =>
            c.status === 'active' &&
            (c.source_item_id === n.id || c.target_item_id === n.id),
        ),
    );
    // Confirm threshold (TOOLS-TDD §2.2): ≥10 rows always confirms;
    // any material content confirms too — empty throwaway stickies
    // under that bar discard without a prompt.
    if (
      (material || targets.length >= 10) &&
      !window.confirm(
        `Discard ${targets.length} item${targets.length === 1 ? '' : 's'}? They move to discarded status and can be restored.`,
      )
    ) {
      return;
    }
    const mutations: ItemMutation[] = [];
    const before: BoardItem[] = [];
    for (const n of targets) {
      const item = n.data.item;
      if (item.updated_at == null) continue;
      mutations.push({
        id: item.id,
        expected_updated_at: item.updated_at,
        patch: { status: 'discarded' },
      });
      before.push(item);
    }
    void applyMutations(mutations, 'discard', before).then((rows) => {
      if (rows) onSelect(null);
    });
  }, [nodes, data.connectors, applyMutations, onSelect]);

  /** Cluster/auto-layout — positions stage on the canvas first and
   *  only write on Apply (TOOLS-TDD §3: preview before write, locked
   *  items never move and are reported, one undoable OCC batch). */
  const arrangeBy = useCallback(
    (by: 'type' | 'status' | 'zone') => {
      const selectedSet = new Set(selectedIds);
      const scope =
        selectedSet.size > 1
          ? nodes.filter((n) => selectedSet.has(n.id))
          : nodes;
      const positions = arrange(
        scope.map((n) => n.data.item),
        by,
      );
      const moving = scope.filter((n) => !n.data.locked && positions.has(n.id));
      const lockedSkipped = scope.filter(
        (n) => n.data.locked && positions.has(n.id),
      ).length;
      const mutations: ItemMutation[] = [];
      const before: BoardItem[] = [];
      for (const n of moving) {
        const item = n.data.item;
        const pos = positions.get(n.id);
        if (!pos || item.updated_at == null) continue;
        // Only stage rows that actually move — an identical position
        // is not a write.
        if (
          Math.abs((item.x ?? 0) - pos.x) < 0.5 &&
          Math.abs((item.y ?? 0) - pos.y) < 0.5
        ) {
          continue;
        }
        mutations.push({
          id: item.id,
          expected_updated_at: item.updated_at,
          patch: { x: pos.x, y: pos.y },
        });
        before.push(item);
      }
      if (mutations.length === 0) {
        handlers.notice(
          lockedSkipped > 0
            ? `Nothing to arrange — ${lockedSkipped} locked item${lockedSkipped === 1 ? '' : 's'} stay put`
            : 'Already arranged',
        );
        return;
      }
      // Stage the preview: shift the nodes visually, write on Apply.
      const movedById = new Map(mutations.map((m) => [m.id, m.patch] as const));
      setNodes((ns) =>
        ns.map((n) => {
          const p = movedById.get(n.id);
          if (!p) return n;
          const parent = n.parentId
            ? ns.find((z) => z.id === n.parentId)
            : undefined;
          return {
            ...n,
            position: parent
              ? {
                  x: (p.x ?? 0) - parent.position.x,
                  y: (p.y ?? 0) - parent.position.y,
                }
              : { x: p.x ?? 0, y: p.y ?? 0 },
          };
        }),
      );
      setArrangePreview({
        label: `arrange by ${by}`,
        mutations,
        before,
        lockedSkipped,
      });
    },
    [nodes, selectedIds, handlers],
  );

  const confirmArrange = useCallback(() => {
    const preview = arrangePreview;
    setArrangePreview(null);
    if (!preview) return;
    void applyMutations(preview.mutations, preview.label, preview.before);
  }, [arrangePreview, applyMutations]);

  const cancelArrange = useCallback(() => {
    setArrangePreview(null);
    // Durable state never moved — restore the projection wholesale.
    setNodes(projected);
  }, [projected]);

  // ------------------------------------------------------------------
  // Tray promote / paste
  // ------------------------------------------------------------------

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const id = e.dataTransfer.getData('application/x-veto-board-item');
      if (!id || readOnly) return;
      e.preventDefault();
      const item = tray.find((i) => i.id === id);
      if (!item) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setTrayBusy(true);
      void handlers
        .promote(item, p)
        .catch((err) =>
          handlers.notice(
            `Could not add tray item: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        .finally(() => setTrayBusy(false));
    },
    [tray, readOnly, screenToFlowPosition, handlers],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (readOnly || isEditableTarget(e.target)) return;
      const text = e.clipboardData.getData('text/plain');
      if (!text.trim()) {
        // Image clipboard data has no route yet — uploads are disabled
        // pending a patched multipart plugin (see threat-model note).
        const hasImage = [...e.clipboardData.items].some((i) =>
          i.type.startsWith('image/'),
        );
        if (hasImage)
          handlers.notice('Image upload is disabled in this release');
        return;
      }
      const center = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      e.preventDefault();
      void handlers
        .add({
          kind: 'note',
          title: text.trim().slice(0, 500),
          x: center.x,
          y: center.y,
        })
        .then((created) => {
          history.current.push(makeCreateCommand(created));
          bumpHistory();
        })
        .catch((err) =>
          handlers.notice(
            `Paste failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
    [readOnly, handlers, screenToFlowPosition, bumpHistory],
  );

  // ------------------------------------------------------------------
  // Keyboard model
  // ------------------------------------------------------------------

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        if (readOnly) return;
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
        return;
      }
      if (e.key === ' ' && !e.repeat) {
        if ((e.target as HTMLElement)?.closest('button, a')) return;
        e.preventDefault();
        if (presenting) {
          presentTo(Math.min(presentIndex + 1, slides.length - 1));
          return;
        }
        setSpacePan(true);
        return;
      }
      // Presentation mode owns arrows while active (TOOLS-TDD §2.5).
      if (presenting) {
        if (e.key === 'Escape') {
          exitPresentation();
          return;
        }
        if (
          e.key === 'ArrowRight' ||
          e.key === 'ArrowDown' ||
          e.key === 'PageDown'
        ) {
          e.preventDefault();
          presentTo(Math.min(presentIndex + 1, slides.length - 1));
          return;
        }
        if (
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowUp' ||
          e.key === 'PageUp'
        ) {
          e.preventDefault();
          presentTo(Math.max(presentIndex - 1, 0));
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          presentTo(0);
          return;
        }
        if (e.key === 'End') {
          e.preventDefault();
          presentTo(slides.length - 1);
          return;
        }
        return;
      }
      if (e.key === 'Escape') {
        if (editingId) return; // textarea handles its own Escape
        if (openThread) {
          setOpenThread(null);
          return;
        }
        if (arrangePreview) {
          cancelArrange();
          return;
        }
        if (selectedAnnotation) {
          setSelectedAnnotation(null);
          return;
        }
        if (pendingSource) {
          setPendingSource(null);
          return;
        }
        if (tool !== 'select') {
          setTool('select');
          return;
        }
        setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
        setEdges((es) => es.map((x) => ({ ...x, selected: false })));
        setSelectedConnector(null);
        setObjectsOpen(false);
        onSelect(null);
        return;
      }
      if (readOnly) {
        // Read mode keeps read-adjacent participation tools reachable
        // by keyboard (TOOLS-TDD §3 — select/vote/comment only).
        const k = e.key.toLowerCase();
        const readTools: Record<string, CanvasTool> = {
          v: 'select',
          k: 'comment',
          o: 'vote',
        };
        if (readTools[k]) setTool(readTools[k] as CanvasTool);
        return;
      }
      if (e.key === 'Enter') {
        if ((e.target as HTMLElement)?.closest('button, a')) return;
        // Focused node → begin editing its primary text (the a11y hint
        // advertises this path; spatial navigation isn't required).
        const sel = nodes.filter((n) => n.selected && !n.data.locked);
        if (sel.length === 1) setEditingId(sel[0]?.id ?? null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedAnnotation) {
          deleteAnnotation();
          return;
        }
        if (selectedConnector) {
          supersedeConnector();
          return;
        }
        discardSelection();
        return;
      }
      const k = e.key.toLowerCase();
      const map: Record<string, CanvasTool> = {
        v: 'select',
        n: 'sticky',
        t: 'text',
        z: 'zone',
        c: 'connector',
        l: 'link',
        k: 'comment',
        o: 'vote',
        ...(drawEnabled ? { d: 'draw' as CanvasTool } : {}),
      };
      if (map[k]) setTool(map[k] as CanvasTool);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault();
        setSpacePan(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [
    doUndo,
    doRedo,
    editingId,
    pendingSource,
    tool,
    readOnly,
    selectedConnector,
    supersedeConnector,
    discardSelection,
    onSelect,
    nodes,
    presenting,
    presentIndex,
    slides.length,
    presentTo,
    exitPresentation,
    openThread,
    arrangePreview,
    cancelArrange,
    selectedAnnotation,
    deleteAnnotation,
    drawEnabled,
  ]);

  // ------------------------------------------------------------------
  // Viewport persistence + objects panel locate
  // ------------------------------------------------------------------

  const onMoveEnd = useCallback(
    (_e: unknown, viewport: { x: number; y: number; zoom: number }) => {
      try {
        localStorage.setItem(viewportKey(ws, board), JSON.stringify(viewport));
      } catch {
        /* storage unavailable */
      }
    },
    [ws, board],
  );

  const onMove = useCallback((_e: unknown, viewport: { zoom: number }) => {
    const inverse = Math.min(4, Math.max(0.5, 1 / viewport.zoom));
    shellRef.current?.style.setProperty(
      '--canvas-zoom-inverse',
      String(inverse),
    );
    shellRef.current?.style.setProperty(
      '--canvas-label-scale',
      String(Math.min(2, Math.max(1, inverse))),
    );
    // Minor grid holds full strength through working zooms (≥0.6×),
    // then fades linearly to invisible at 0.25× where 24px cells
    // densify into moiré.
    shellRef.current?.style.setProperty(
      '--canvas-grid-minor-opacity',
      String(Math.min(1, Math.max(0, (viewport.zoom - 0.25) / 0.35))),
    );
  }, []);

  useEffect(() => {
    onMove(null, { zoom: savedViewport?.zoom ?? 1 });
  }, [onMove, savedViewport]);

  const locate = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      const r = absoluteRect(node, nodes);
      // Reduced-motion: jump instead of animating the viewport fit.
      const duration = prefersReducedMotion() ? 0 : 300;
      setCenter(r.x + r.w / 2, r.y + r.h / 2, {
        zoom: Math.max(getViewport().zoom, 1),
        duration,
      });
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      onSelect(id);
    },
    [nodes, setCenter, getViewport, onSelect],
  );

  /** One fenced batch per bulk verb — the same `mutations → PATCH`
   *  path Easy Edit's bulk bar uses (selection parity, TOOLS-TDD §3).
   *  Locked members stay selected but are never written. */
  const bulkPatch = useCallback(
    (patch: ItemPatch, label: string) => {
      const targets = nodes.filter((n) => n.selected && !n.data.locked);
      const mutations: ItemMutation[] = [];
      const before: BoardItem[] = [];
      for (const n of targets) {
        const item = n.data.item;
        if (item.updated_at == null) continue;
        mutations.push({
          id: item.id,
          expected_updated_at: item.updated_at,
          patch,
        });
        before.push(item);
      }
      void applyMutations(mutations, label, before, BULK_FIELDS).then(
        (rows) => {
          if (rows) onSelect(null);
        },
      );
    },
    [nodes, applyMutations, onSelect],
  );

  const connSelected = selectedConnector
    ? connectorsById.get(selectedConnector)
    : undefined;

  const lockedSelected = nodes.filter(
    (n) => n.selected && n.data.locked,
  ).length;

  return (
    <CanvasActionsProvider value={actions}>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={shellRef}
        className={`veto-canvas-shell${readOnly ? ' read-only' : ''}`}
        data-tool={tool}
        onDoubleClick={onDoubleClickCapture}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onPaste={onPaste}
      >
        <ReactFlow<CanvasNode, CanvasEdge>
          nodes={renderedNodes}
          edges={renderedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          onMove={onMove}
          onMoveEnd={onMoveEnd}
          selectionOnDrag={tool === 'select' && !spacePan && !readOnly}
          selectionMode={SelectionMode.Partial}
          panOnDrag={readOnly || spacePan || tool === 'pan' ? true : [1, 2]}
          panOnScroll
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          nodesFocusable
          edgesFocusable
          autoPanOnNodeFocus
          minZoom={0.25}
          maxZoom={2}
          multiSelectionKeyCode="Shift"
          {...(savedViewport
            ? { defaultViewport: savedViewport }
            : { fitView: true, fitViewOptions: { padding: 0.25 } })}
          ariaLabelConfig={{
            'node.a11yDescription.default':
              'Press Enter to edit. Arrow keys move the item. Delete asks to discard it.',
            'edge.a11yDescription.default':
              'Press Enter to select this connector. Delete removes it.',
            'controls.ariaLabel': 'canvas controls',
            'handle.ariaLabel': 'connector endpoint',
          }}
        >
          <Background
            id="grid-minor"
            variant={BackgroundVariant.Lines}
            gap={24}
            lineWidth={1}
            color="var(--canvas-grid)"
            style={{ opacity: 'var(--canvas-grid-minor-opacity, 1)' }}
          />
          <Background
            id="grid-major"
            variant={BackgroundVariant.Lines}
            gap={96}
            lineWidth={1}
            color="var(--canvas-grid-major)"
          />
          {/* Drawing layer — durable `board_annotations` rendered as one
              SVG layer behind the node layer; never RF nodes (§2.6). */}
          {drawEnabled && (
            <AnnotationLayer
              annotations={data.annotations ?? []}
              selectedId={selectedAnnotation}
              onSelect={(id) => {
                setSelectedAnnotation(id);
                onSelect(null);
              }}
              livePath={livePath}
              liveKind={drawKind}
            />
          )}
          {/* Minimap is chrome-level/transient — hidden in read mode
              (<900 px) per §3. */}
          {!readOnly && <BoardMinimap />}
        </ReactFlow>

        {drawEnabled && !readOnly && tool === 'draw' && (
          <DrawCapture
            drawKind={drawKind}
            onLive={setLivePath}
            onCommit={commitAnnotation}
          />
        )}

        {presenting && (
          <>
            <div className="canvas-present-backdrop" aria-hidden />
            <PresentationBar
              index={presentIndex}
              total={slides.length}
              title={
                slides[presentIndex]?.title ?? slides[presentIndex]?.body ?? ''
              }
              onPrev={() => presentTo(Math.max(presentIndex - 1, 0))}
              onNext={() =>
                presentTo(Math.min(presentIndex + 1, slides.length - 1))
              }
              onExit={exitPresentation}
            />
          </>
        )}

        {nodes.length === 0 && ghosts.nodes.length === 0 && (
          <section className="canvas-empty" aria-label="Empty board">
            <div className="canvas-empty-mark" aria-hidden>
              ◆
            </div>
            <h2>{readOnly ? 'This board is empty' : 'Start with an idea'}</h2>
            <p>
              {readOnly
                ? 'Open this board on a wider screen to add and arrange ideas.'
                : 'Double-click anywhere, or create your first sticky note.'}
            </p>
            {!readOnly && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const rect = shellRef.current?.getBoundingClientRect();
                  if (rect) {
                    void createAt(
                      rect.left + rect.width / 2,
                      rect.top + rect.height / 2,
                      'sticky',
                    );
                  }
                }}
              >
                Add a sticky note
              </button>
            )}
            {!readOnly && (
              <span className="canvas-empty-shortcuts">
                N sticky · T text · Z frame · C connector
              </span>
            )}
          </section>
        )}

        {readOnly && (
          <output className="canvas-read-mode" aria-live="polite">
            Read-only view · Pan, zoom, comment, or vote
          </output>
        )}

        <ToolRail
          tool={tool}
          onTool={(t) => {
            setTool(t);
            setPendingSource(null);
            setSelectedAnnotation(null);
          }}
          objectsOpen={objectsOpen}
          onToggleObjects={() => setObjectsOpen((o) => !o)}
          readOnly={readOnly}
          drawEnabled={drawEnabled}
          canPresent={slides.length > 0}
          onPresent={startPresentation}
        />
        <div className="canvas-top-right">
          <TimerChip />
          {!readOnly && (
            <VoteSessionChip
              session={openVote}
              totalVotes={data.votes?.length ?? 0}
              busy={sessionBusy}
              onOpen={openVoteSession}
              onClose={closeVoteSession}
            />
          )}
        </div>
        <div className="canvas-history" role="toolbar" aria-label="history">
          <button
            type="button"
            className="toolbar-btn"
            disabled={!history.current.canUndo || readOnly}
            title={history.current.undoLabel ?? 'Nothing to undo'}
            onClick={doUndo}
          >
            Undo
          </button>
          <button
            type="button"
            className="toolbar-btn"
            disabled={!history.current.canRedo || readOnly}
            title={history.current.redoLabel ?? 'Nothing to redo'}
            onClick={doRedo}
          >
            Redo
          </button>
        </div>
        <ZoomControls />
        <SaveBadge state={saveState} />
        {arrangePreview && (
          <ArrangePreviewBar
            count={arrangePreview.mutations.length}
            lockedSkipped={arrangePreview.lockedSkipped}
            onConfirm={confirmArrange}
            onCancel={cancelArrange}
          />
        )}
        {!readOnly && !arrangePreview && (
          <MultiSelectBar
            count={selectedIds.length}
            lockedCount={lockedSelected}
            taxonomy={taxonomy}
            onSetStatus={(status) =>
              bulkPatch({ status }, `status → ${status}`)
            }
            onSetType={(note_kind) =>
              bulkPatch({ note_kind }, `type → ${note_kind}`)
            }
            onSetImportance={(importance) =>
              bulkPatch({ importance }, `importance → ${importance}`)
            }
            onMoveTray={() => bulkPatch({ board: null }, 'move to tray')}
            onDiscard={discardSelection}
            onArrange={arrangeBy}
            onClear={() => {
              setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
              onSelect(null);
            }}
          />
        )}
        {tool === 'vote' && (
          <VoteStampBar stamp={voteStamp} onStamp={setVoteStamp} />
        )}
        {tool === 'draw' && drawEnabled && !readOnly && (
          <DrawBar kind={drawKind} onKind={setDrawKind} />
        )}
        {openThread && (
          <CommentThread
            thread={openThreadList}
            targetTitle={openThreadTitle}
            busy={false}
            onResolve={resolveComment}
            onReply={replyComment}
            onClose={() => setOpenThread(null)}
          />
        )}
        {selectedAnnotation && !readOnly && (
          <div
            className="canvas-multibar"
            role="toolbar"
            aria-label="drawing actions"
          >
            <span className="canvas-selection-count">Drawing selected</span>
            <button
              type="button"
              className="toolbar-btn danger"
              onClick={deleteAnnotation}
            >
              Delete drawing
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setSelectedAnnotation(null)}
            >
              Cancel
            </button>
          </div>
        )}
        {connSelected && !readOnly && (
          <ConnectorBar
            label={connSelected.label}
            onRelabel={(label) => patchConnector({ label })}
            onSupersede={supersedeConnector}
          />
        )}
        {tool !== 'select' && tool !== 'pan' && CREATE_TOOLS.has(tool) && (
          <output className="canvas-place-hint">
            Click the canvas to place — Esc cancels
          </output>
        )}
        {tool === 'comment' && (
          <output className="canvas-place-hint">
            Click the canvas or an item to pin a comment — Esc cancels
          </output>
        )}
        {tool === 'vote' && (
          <output className="canvas-place-hint">
            {openVote
              ? `Click an item to stamp ${voteStamp === 'question' ? 'a question' : `a ${voteStamp}-vote`} — Esc cancels`
              : 'No vote session is open — start one to stamp'}
          </output>
        )}
        {tool === 'draw' && drawEnabled && !readOnly && (
          <output className="canvas-place-hint">
            Drag to draw — Esc cancels
          </output>
        )}
        {tool === 'connector' && (
          <output className="canvas-place-hint">
            {pendingSource
              ? 'Click a target item to connect — Esc cancels'
              : 'Click a source item — Esc cancels'}
          </output>
        )}
        {objectsOpen && (
          <ObjectsPanel
            nodes={nodes}
            annotations={drawEnabled ? (data.annotations ?? []) : []}
            onLocate={(id) => {
              locate(id);
              setObjectsOpen(false);
            }}
            onLocateAnnotation={(a) => {
              // Non-spatial access to a drawing: fit its bounds and
              // select it so the delete action is keyboard-reachable.
              const r = annotationBounds(a);
              const duration = prefersReducedMotion() ? 0 : 300;
              if (r) {
                void fitBounds(
                  { x: r.x, y: r.y, width: r.w, height: r.h },
                  { padding: 0.4, duration },
                );
              }
              setSelectedAnnotation(a.id);
              onSelect(null);
            }}
            onClose={() => setObjectsOpen(false)}
          />
        )}
        {conflict && (
          <ConflictNotice
            draft={conflict.draft?.text ?? null}
            failedSave={saveState === 'offline'}
            onRetry={() => {
              const d = conflict.draft;
              if (d) saveText(conflict.itemId, d.field, d.text);
              setConflict(null);
            }}
            onDismiss={() => setConflict(null)}
          />
        )}
        <TrayDock
          items={tray}
          open={trayOpen}
          onToggle={() => setTrayOpen((o) => !o)}
          onPromote={(item) => {
            setTrayBusy(true);
            void handlers
              .promote(item)
              .catch((err) =>
                handlers.notice(
                  `Could not add tray item: ${err instanceof Error ? err.message : String(err)}`,
                ),
              )
              .finally(() => setTrayBusy(false));
          }}
          busy={trayBusy}
          readOnly={readOnly}
        />
      </div>
    </CanvasActionsProvider>
  );
}

/** True when `zone` references a real zone item on this canvas (vs a
 *  legacy string label). */
function isRealZoneId(zone: string | null, nodes: CanvasNode[]): boolean {
  return zone != null && nodes.some((n) => n.id === zone && n.type === 'zone');
}

export default function BoardCanvas(props: BoardCanvasProps) {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  );
}
