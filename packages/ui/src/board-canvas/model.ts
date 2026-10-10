/**
 * model.ts — project durable board rows onto React Flow nodes/edges.
 *
 * React Flow arrays are a *projection*, never a second source of truth
 * (BOARD-CANVAS-TDD "Durable and transient state"): server responses
 * replace them after every committed mutation.
 *
 * Zone membership: `board_items.zone` holding a zone item's id renders
 * as a real React Flow `parentId` for *mutable* items, with persisted
 * absolute coordinates converted to parent-relative in one pure pass.
 * Locked (consumed/frozen) items keep absolute positions and no parent
 * so a zone move can never teleport them. A `zone` value that matches
 * no zone item is a legacy string label — surfaced as a virtual grouping
 * hint, never written back implicitly.
 */
import type { BoardConnector, BoardItem, BoardProposalRow } from '@veto/core';
import type { Edge, Node, XYPosition } from '@xyflow/react';
import { noteKindMeta } from '../discovery';
import { legacyPositions } from './layout';
import { commentThreads, openComments, threadKeyOf } from './tools/comment';

export type CanvasColor = NonNullable<BoardItem['color']>;
export type CanvasTool =
  | 'select'
  | 'pan'
  | 'sticky'
  | 'text'
  | 'zone'
  | 'connector'
  | 'link'
  | 'image'
  // BOARD-CANVAS-TOOLS-TDD §2.1 — collaboration + drawing tools.
  | 'comment'
  | 'vote'
  | 'draw';

/** The draw tool's active shape (spec §2.6 annotation kinds). */
export type DrawKind = 'stroke' | 'rect' | 'ellipse' | 'arrow' | 'highlight';

export interface CanvasNodeData extends Record<string, unknown> {
  item: BoardItem;
  statementCount: number;
  color: CanvasColor;
  locked: boolean;
  /** Legacy string-zone grouping hint (never a persisted zone id). */
  virtualZone: string | null;
  editing: boolean;
  /** Vote tallies for the visible session — null when badges hide
   *  (no open session and `?votes=show` unset). */
  votes: { up: number; down: number; question: number } | null;
  /** Open (unresolved) comment count on this item's thread. */
  commentCount: number;
  /** This comment node's thread size (its own comments share a key). */
  threadSize: number;
  /** BOARD-CHAT-TDD: set when this node projects a pending
   *  `board_proposals` row instead of standing alone — the row is
   *  truth, the ghost vanishes on resolve. */
  ghost?: GhostProjection;
}

export type CanvasNodeType =
  | 'sticky'
  | 'text'
  | 'zone'
  | 'link'
  | 'image'
  | 'comment'
  | 'ghost';
export type CanvasNode = Node<CanvasNodeData, CanvasNodeType>;

export interface ConnectorEdgeData extends Record<string, unknown> {
  connector: BoardConnector;
  /** Pending-proposal ghost edge (serve/connect/connector-remove). */
  ghost?: GhostProjection;
}
export type CanvasEdge = Edge<ConnectorEdgeData, 'connector'>;

/** A pending `board_proposals` row projected onto the canvas
 *  (BOARD-CHAT-TDD UI). `treatment` derives from the op:
 *  `add` create-item, `change` patch-item, `move` move-item,
 *  `remove` delete-item/connector-remove, `edge` serve/connect. */
export interface GhostProjection {
  proposal: BoardProposalRow;
  treatment: 'add' | 'change' | 'move' | 'remove' | 'edge';
}

export const STICKY_DEFAULT_SIZE = { w: 220, h: 180 } as const;
export const TEXT_DEFAULT_SIZE = { w: 280, h: 80 } as const;
export const ZONE_DEFAULT_SIZE = { w: 720, h: 480 } as const;
export const ZONE_MIN_SIZE = { w: 320, h: 220 } as const;
export const LINK_DEFAULT_SIZE = { w: 320, h: 120 } as const;
export const IMAGE_DEFAULT_SIZE = { w: 320, h: 240 } as const;
export const COMMENT_PIN_SIZE = { w: 44, h: 44 } as const;

/** Hybrid color: explicit override wins; otherwise derive from note type. */
const typeDefaultColor: Record<string, CanvasColor> = {
  idea: 'yellow',
  want: 'blue',
  avoid: 'pink',
  problem: 'orange',
  constraint: 'purple',
  question: 'pink',
  decision: 'green',
  feedback: 'blue',
};

export function canvasColor(item: BoardItem): CanvasColor {
  return item.color ?? typeDefaultColor[item.note_kind ?? ''] ?? 'yellow';
}

export function isLocked(item: BoardItem): boolean {
  return item.status === 'consumed' || item.status === 'frozen';
}

export function nodeTypeFor(item: BoardItem): CanvasNodeType {
  // Comment pins are `kind='feedback'` + `note_kind='comment'`
  // (TOOLS-TDD §2.3) — a dedicated compact node type.
  if (item.kind === 'feedback' && item.note_kind === 'comment') {
    return 'comment';
  }
  switch (item.kind) {
    case 'text':
      return 'text';
    case 'zone':
      return 'zone';
    case 'link':
      return 'link';
    case 'image':
      return 'image';
    default:
      return 'sticky';
  }
}

export function defaultSizeFor(type: CanvasNodeType): {
  w: number;
  h: number;
} {
  switch (type) {
    case 'zone':
      return ZONE_DEFAULT_SIZE;
    case 'text':
      return TEXT_DEFAULT_SIZE;
    case 'link':
      return LINK_DEFAULT_SIZE;
    case 'image':
      return IMAGE_DEFAULT_SIZE;
    case 'comment':
      return COMMENT_PIN_SIZE;
    default:
      return STICKY_DEFAULT_SIZE;
  }
}

export interface SurfaceLike {
  item: BoardItem;
  statements: unknown[];
}

function hasPosition(item: BoardItem): boolean {
  return Number.isFinite(item.x) && Number.isFinite(item.y);
}

/**
 * Durable rows → React Flow nodes.
 *
 * Zones are emitted before children (React Flow requires parents first).
 * Items lacking persisted geometry receive deterministic *transient*
 * positions from `layout.ts` — projection itself performs no writes.
 */
export interface ProjectOptions {
  /** Per-item vote tallies for the visible session — null/absent
   *  hides every vote badge (TOOLS-TDD §2.4 gating). */
  votes?: Map<string, { up: number; down: number; question: number }> | null;
}

export function projectItems(
  surfaces: SurfaceLike[],
  editingId: string | null = null,
  opts?: ProjectOptions,
): CanvasNode[] {
  const visible = surfaces
    .map((s) => s.item)
    .filter((item) => item.status !== 'discarded');
  const statementsCount = new Map<string, number>();
  for (const s of surfaces) statementsCount.set(s.item.id, s.statements.length);

  // Comment threads derive from the same rows (TOOLS-TDD §2.3) —
  // open comments count on their target's badge; each pin carries its
  // own thread size.
  const threads = commentThreads(visible);
  const openByTarget = new Map<string, number>();
  for (const [key, list] of threads) {
    openByTarget.set(key, openComments(list).length);
  }

  const zoneIds = new Set(
    visible.filter((i) => i.kind === 'zone').map((i) => i.id),
  );
  // Deterministic transient placement for legacy null-coordinate items.
  const projectedPos = legacyPositions(visible);

  // Pass 1 — absolute position + size for every visible item.
  const abs = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const item of visible) {
    const type = nodeTypeFor(item);
    const size = defaultSizeFor(type);
    const pos = hasPosition(item)
      ? { x: item.x as number, y: item.y as number }
      : (projectedPos.get(item.id) ?? { x: 120, y: 120 });
    abs.set(item.id, {
      x: pos.x,
      y: pos.y,
      w: item.w ?? size.w,
      h: item.h ?? size.h,
    });
  }

  // Zones first so `parentId` references resolve.
  const ordered = [...visible].sort((a, b) => {
    const za = a.kind === 'zone' ? -1 : 0;
    const zb = b.kind === 'zone' ? -1 : 0;
    if (za !== zb) return za - zb;
    return (a.z_index ?? 0) - (b.z_index ?? 0) || a.id.localeCompare(b.id);
  });

  return ordered.map((item) => {
    const type = nodeTypeFor(item);
    const locked = isLocked(item);
    const geo = abs.get(item.id) as {
      x: number;
      y: number;
      w: number;
      h: number;
    };
    const isZoneMember = !locked && !!item.zone && zoneIds.has(item.zone);
    const parent = isZoneMember ? abs.get(item.zone as string) : undefined;
    const position: XYPosition = parent
      ? { x: geo.x - parent.x, y: geo.y - parent.y }
      : { x: geo.x, y: geo.y };
    const virtualZone = item.zone && !zoneIds.has(item.zone) ? item.zone : null;
    const node: CanvasNode = {
      id: item.id,
      type,
      position,
      width: geo.w,
      height: geo.h,
      ...(isZoneMember ? { parentId: item.zone as string } : {}),
      draggable: !locked,
      selectable: true,
      zIndex: type === 'zone' ? -1 : 0,
      ariaLabel: `${noteKindMeta(item.note_kind).label}: ${
        item.title ?? item.body ?? 'untitled'
      }; ${item.status}${locked ? '; locked' : ''}`,
      data: {
        item,
        statementCount: statementsCount.get(item.id) ?? 0,
        color: canvasColor(item),
        locked,
        virtualZone,
        editing: editingId === item.id,
        votes: opts?.votes?.get(item.id) ?? null,
        commentCount: type === 'comment' ? 0 : (openByTarget.get(item.id) ?? 0),
        threadSize:
          type === 'comment'
            ? (threads.get(threadKeyOf(item))?.length ?? 1)
            : 0,
      },
    };
    return node;
  });
}

/** Connector rows → custom edges. Superseded connectors stay hidden. */
export function projectConnectors(connectors: BoardConnector[]): CanvasEdge[] {
  return connectors
    .filter((c) => c.status === 'active')
    .map((connector) => ({
      id: connector.id,
      source: connector.source_item_id,
      target: connector.target_item_id,
      type: 'connector' as const,
      label: connector.label ?? undefined,
      ariaLabel: `Connector from ${connector.source_item_id} to ${connector.target_item_id}${
        connector.label ? `: ${connector.label}` : ''
      }`,
      markerEnd: { type: 'arrowclosed' as const },
      data: { connector },
    }));
}

// ---------------------------------------------------------------------------
// Geometry helpers — zone membership at gesture end (pure + testable)
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Absolute canvas rect for a projected node (parent-relative
 *  coordinates resolved through `nodes`). */
export function absoluteRect(node: CanvasNode, nodes: CanvasNode[]): Rect {
  let x = node.position.x;
  let y = node.position.y;
  if (node.parentId) {
    const parent = nodes.find((n) => n.id === node.parentId);
    if (parent) {
      x += parent.position.x;
      y += parent.position.y;
    }
  }
  return {
    x,
    y,
    w: node.width ?? defaultSizeFor('sticky').w,
    h: node.height ?? defaultSizeFor('sticky').h,
  };
}

function centerOf(r: Rect): XYPosition {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function containsPoint(r: Rect, p: XYPosition): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** The zone whose rect contains the node's center — deepest match wins
 *  when zones overlap (largest `z_index`, then smallest area). */
export function containingZone(
  node: CanvasNode,
  nodes: CanvasNode[],
): string | null {
  if (node.type === 'zone') return null;
  const c = centerOf(absoluteRect(node, nodes));
  let best: { id: string; area: number; z: number } | null = null;
  for (const n of nodes) {
    if (n.type !== 'zone' || n.id === node.id) continue;
    const r = absoluteRect(n, nodes);
    if (!containsPoint(r, c)) continue;
    const area = r.w * r.h;
    const z = n.data.item.z_index ?? 0;
    if (!best || z > best.z || (z === best.z && area < best.area)) {
      best = { id: n.id, area, z };
    }
  }
  return best?.id ?? null;
}
