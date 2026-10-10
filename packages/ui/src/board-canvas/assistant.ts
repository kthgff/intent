/**
 * assistant.ts — BOARD-CHAT pure helpers (wp-166).
 *
 * `projectProposals(proposals, items)` maps `status='pending'`
 * `board_proposals` rows onto ghost `CanvasNode`s/`CanvasEdge`s
 * flagged `data.ghost` (PRD R3, TDD "UI"). Ghosts are a projection —
 * the rows are truth; they are never draggable/selectable/focusable
 * and never enter history, marquee, or undo. Resolving a row removes
 * it from `pending`, so the next projection drops the ghost — no
 * stale ghosts are possible.
 *
 * Per-op rendering: create-item → ghost card at the stored x/y/w/h;
 * patch-item → ghost carrying the proposed fields over the target's
 * slot; move-item → ghost at the target position (incl. zone
 * re-parenting); serve/connect → ghost connector edge; delete-item →
 * ghost with the `discarded` treatment; connector-remove → ghost
 * edge with the `remove` treatment (needs the connector row — pass
 * `connectors` when available).
 *
 * O(items + pending): rows are indexed once, each proposal resolves
 * its targets in O(1). Callers memoize on `(proposals, items)` per
 * the TDD perf budget.
 */
import type { BoardConnector, BoardItem, BoardProposalRow } from '@veto/core';
import { legacyPositions } from './layout';
import {
  type CanvasEdge,
  type CanvasNode,
  type GhostProjection,
  type SurfaceLike,
  canvasColor,
  defaultSizeFor,
  nodeTypeFor,
} from './model';

/** Ghost ids are namespaced so they can never collide with item or
 *  connector ids — a ghost is not addressable as a durable row. */
export const ghostId = (proposalId: string) => `ghost:${proposalId}`;

export interface GhostProjectionResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const positioned = (item: BoardItem): boolean =>
  Number.isFinite(item.x) && Number.isFinite(item.y);

/**
 * Project pending proposals to ghost nodes/edges. Non-pending rows
 * are ignored; ops whose target row is missing (or already
 * `discarded`) project nothing — the canvas never invents a base.
 */
export function projectProposals(
  proposals: BoardProposalRow[],
  items: SurfaceLike[],
  connectors: BoardConnector[] = [],
): GhostProjectionResult {
  const pending = proposals.filter((p) => p.status === 'pending');
  if (pending.length === 0) return { nodes: [], edges: [] };

  const visible = items
    .map((s) => s.item)
    .filter((i) => i.status !== 'discarded');
  const byId = new Map(visible.map((i) => [i.id, i]));
  const connectorsById = new Map(connectors.map((c) => [c.id, c]));

  // Ghost zones a create proposes this pass join the real zone ids —
  // other pending creates may target them. Fabricate every create
  // first so ordering inside the batch never matters. Same-batch
  // `temp_id` aliases map onto the ghost id so zone/connect refs
  // resolve (D69).
  const creates = new Map<string, BoardItem>();
  const tempToGhost = new Map<string, string>();
  for (const proposal of pending) {
    const p = proposal.payload;
    if (p.op === 'create-item' && p.temp_id) {
      tempToGhost.set(p.temp_id, ghostId(proposal.proposal_id));
    }
  }
  /** temp_id alias → ghost id; real item ids pass through. */
  const ref = (v: string | null | undefined) =>
    v == null ? v : (tempToGhost.get(v) ?? v);
  const zoneIds = new Set(
    visible.filter((i) => i.kind === 'zone').map((i) => i.id),
  );
  for (const proposal of pending) {
    const p = proposal.payload;
    if (p.op !== 'create-item') continue;
    const gid = ghostId(proposal.proposal_id);
    const item: BoardItem = {
      id: gid,
      workspace: proposal.workspace,
      org: proposal.org ?? null,
      board: proposal.board,
      kind: p.kind ?? 'note',
      note_kind: p.note_kind ?? null,
      topic: p.topic ?? null,
      importance: p.importance ?? null,
      applies_to: p.applies_to ?? null,
      note_status: 'open',
      rationale: p.rationale ?? null,
      provenance: 'inferred',
      ref: p.ref ?? null,
      title: p.title ?? null,
      body: p.body ?? null,
      x: p.x,
      y: p.y,
      w: p.w ?? null,
      h: p.h ?? null,
      color: p.color ?? null,
      z_index: null,
      presentation_order: null,
      zone: ref(p.zone) ?? null,
      serves: null,
      status: 'active',
      consumed_by: null,
      created_at: proposal.created_at ?? null,
      updated_at: null,
    };
    creates.set(proposal.proposal_id, item);
    byId.set(item.id, item);
    if (item.kind === 'zone') zoneIds.add(item.id);
  }

  // Transient positions mirror projectItems: overlays (patch/move/
  // delete ghosts) must land exactly on their target's slot even
  // when the target lacks persisted geometry. Computed lazily —
  // most targets carry coordinates.
  let transient: Map<string, { x: number; y: number }> | null = null;
  const posOf = (item: BoardItem): { x: number; y: number } => {
    if (positioned(item)) return { x: item.x as number, y: item.y as number };
    if (!transient) transient = legacyPositions(visible);
    return transient.get(item.id) ?? { x: 120, y: 120 };
  };

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const nodeFor = (
    item: BoardItem,
    proposal: BoardProposalRow,
    treatment: GhostProjection['treatment'],
  ): CanvasNode => {
    const size = defaultSizeFor(nodeTypeFor(item));
    const abs = posOf(item);
    const zone = item.zone ?? null;
    const parentItem =
      zone != null && zoneIds.has(zone) ? (byId.get(zone) ?? null) : null;
    // Zone children store parent-relative coordinates, mirroring
    // projectItems — a zone member's ghost stays inside its frame.
    const parentPos = parentItem ? posOf(parentItem) : { x: 0, y: 0 };
    return {
      id: item.id,
      type: 'ghost',
      position: parentItem
        ? { x: abs.x - parentPos.x, y: abs.y - parentPos.y }
        : abs,
      width: item.w ?? size.w,
      height: item.h ?? size.h,
      ...(parentItem ? { parentId: zone as string } : {}),
      draggable: false,
      selectable: false,
      focusable: false,
      deletable: false,
      connectable: false,
      zIndex: 10,
      ariaLabel: `Proposed ${proposal.op}: ${
        item.title ?? item.body ?? 'untitled'
      }`,
      data: {
        item,
        statementCount: 0,
        color: canvasColor(item),
        locked: true,
        virtualZone: zone != null && !zoneIds.has(zone) ? zone : null,
        editing: false,
        votes: null,
        commentCount: 0,
        threadSize: 0,
        ghost: { proposal, treatment },
      },
    };
  };

  const edgeFor = (
    proposal: BoardProposalRow,
    source: string,
    target: string,
    label: string | null,
    treatment: 'edge' | 'remove',
  ): CanvasEdge => ({
    id: ghostId(proposal.proposal_id),
    source,
    target,
    type: 'connector',
    ariaLabel: `Proposed ${proposal.op} from ${source} to ${target}`,
    selectable: false,
    focusable: false,
    deletable: false,
    markerEnd: { type: 'arrowclosed' as const },
    data: {
      connector: {
        id: ghostId(proposal.proposal_id),
        workspace: proposal.workspace,
        board: proposal.board,
        source_item_id: source,
        target_item_id: target,
        label,
        status: 'active',
        created_at: null,
        updated_at: null,
      },
      ghost: { proposal, treatment },
    },
  });

  for (const proposal of pending) {
    const p = proposal.payload;
    const gid = ghostId(proposal.proposal_id);
    switch (p.op) {
      case 'create-item': {
        const item = creates.get(proposal.proposal_id);
        if (item) nodes.push(nodeFor(item, proposal, 'add'));
        break;
      }
      case 'patch-item': {
        const target = byId.get(ref(p.id) ?? '');
        if (!target) break;
        const item: BoardItem = { ...target, id: gid };
        for (const [key, value] of Object.entries(p.patch)) {
          if (value !== undefined) {
            (item as unknown as Record<string, unknown>)[key] = value;
          }
        }
        nodes.push(nodeFor(item, proposal, 'change'));
        break;
      }
      case 'move-item': {
        const target = byId.get(ref(p.id) ?? '');
        if (!target) break;
        const pos = posOf(target);
        const zone =
          p.zone !== undefined ? (ref(p.zone) ?? null) : (target.zone ?? null);
        const item: BoardItem = {
          ...target,
          id: gid,
          x: p.x ?? pos.x,
          y: p.y ?? pos.y,
          zone,
        };
        nodes.push(nodeFor(item, proposal, 'move'));
        break;
      }
      case 'delete-item': {
        const target = byId.get(ref(p.id) ?? '');
        if (!target) break;
        nodes.push(
          nodeFor(
            { ...target, id: gid, status: 'discarded' },
            proposal,
            'remove',
          ),
        );
        break;
      }
      case 'serve': {
        const src = ref(p.id) ?? '';
        const dst = ref(p.goal_item_id) ?? '';
        if (!byId.has(src) || !byId.has(dst)) break;
        edges.push(edgeFor(proposal, src, dst, 'serves', 'edge'));
        break;
      }
      case 'connect': {
        const src = ref(p.source_item_id) ?? '';
        const dst = ref(p.target_item_id) ?? '';
        if (!byId.has(src) || !byId.has(dst)) break;
        edges.push(edgeFor(proposal, src, dst, p.label ?? null, 'edge'));
        break;
      }
      case 'connector-remove': {
        const conn = connectorsById.get(p.id);
        if (!conn || conn.status !== 'active') break;
        if (!byId.has(conn.source_item_id) || !byId.has(conn.target_item_id)) {
          break;
        }
        edges.push(
          edgeFor(
            proposal,
            conn.source_item_id,
            conn.target_item_id,
            conn.label ?? null,
            'remove',
          ),
        );
        break;
      }
    }
  }

  // React Flow renders parents before children — ghost zones lead.
  nodes.sort((a, b) => {
    const za = a.data.item.kind === 'zone' ? -1 : 0;
    const zb = b.data.item.kind === 'zone' ? -1 : 0;
    return za - zb;
  });
  return { nodes, edges };
}

// ---- panel helpers (wp-165) — pure display/position logic for the
// thread's proposal cards; no canvas or React dependency. ----

const clip = (s: string, n = 60) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const titleOf = (item: BoardItem | undefined, fallback: string) =>
  clip(item?.title ?? item?.body ?? fallback);

/** One-line human label for a proposal op (thread card + aria).
 *  Pass the pending set as `siblings` so same-batch `temp_id`
 *  references render as their create's title, not a raw alias. */
export function proposalLabel(
  proposal: BoardProposalRow,
  items: BoardItem[] = [],
  siblings: BoardProposalRow[] = [],
): string {
  const p = proposal.payload;
  const byId = new Map(items.map((i) => [i.id, i]));
  const tempTitles = new Map<string, string>();
  for (const s of siblings) {
    const sp = s.payload;
    if (sp.op === 'create-item' && sp.temp_id) {
      tempTitles.set(
        sp.temp_id,
        titleOf(undefined, sp.title ?? sp.body ?? 'untitled'),
      );
    }
  }
  const nameOf = (id: string) =>
    titleOf(byId.get(id), tempTitles.get(id) ?? id);
  const zoneName = (id: string) =>
    tempTitles.get(id) ?? byId.get(id)?.title ?? id;
  switch (p.op) {
    case 'create-item': {
      const what = p.kind === 'zone' ? 'zone' : (p.note_kind ?? 'note');
      const where = p.zone ? ` into “${zoneName(p.zone)}”` : '';
      return `Add ${what} “${titleOf(undefined, p.title ?? p.body ?? 'untitled')}”${where}`;
    }
    case 'patch-item':
      return `Edit “${nameOf(p.id)}”`;
    case 'move-item':
      return `Move “${nameOf(p.id)}”${p.zone ? ` into “${zoneName(p.zone)}”` : ''}`;
    case 'delete-item':
      return `Remove “${nameOf(p.id)}”`;
    case 'serve':
      return `Wire “${nameOf(p.id)}” → goal “${nameOf(p.goal_item_id)}”`;
    case 'connect':
      return `Connect “${nameOf(p.source_item_id)}” → “${nameOf(p.target_item_id)}”`;
    case 'connector-remove':
      return `Remove connector ${p.id}`;
  }
}

/**
 * Deep-link target for a proposal (TDD: message clicks pan/zoom to the
 * canvas position). Returns the CENTER point — create/move use the
 * stored position; item-targeting ops resolve the target's slot (with
 * the same transient-layout fallback the projection uses); connector
 * ops focus the source member; `anchor[]` is the last resort. Null =
 * nothing on the canvas to point at.
 */
export function proposalFocusPos(
  proposal: BoardProposalRow,
  items: BoardItem[],
): { x: number; y: number } | null {
  const visible = items.filter((i) => i.status !== 'discarded');
  const byId = new Map(visible.map((i) => [i.id, i]));
  let transient: Map<string, { x: number; y: number }> | null = null;
  const posOf = (id: string | null | undefined) => {
    if (!id) return null;
    const item = byId.get(id);
    if (!item) return null;
    if (!transient) transient = legacyPositions(visible);
    const pos =
      Number.isFinite(item.x) && Number.isFinite(item.y)
        ? { x: item.x as number, y: item.y as number }
        : transient.get(id);
    if (!pos) return null;
    return { x: pos.x + (item.w ?? 200) / 2, y: pos.y + (item.h ?? 150) / 2 };
  };
  const p = proposal.payload;
  switch (p.op) {
    case 'create-item': {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        return {
          x: (p.x as number) + (p.w ?? 200) / 2,
          y: (p.y as number) + (p.h ?? 150) / 2,
        };
      }
      return posOf(proposal.anchor?.[0] ?? null);
    }
    case 'move-item': {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        return { x: p.x as number, y: p.y as number };
      }
      return posOf(p.id) ?? posOf(proposal.anchor?.[0] ?? null);
    }
    case 'patch-item':
    case 'delete-item':
      return posOf(p.id);
    case 'serve':
      return posOf(p.goal_item_id) ?? posOf(p.id);
    case 'connect':
      return posOf(p.target_item_id) ?? posOf(p.source_item_id);
    case 'connector-remove':
      return posOf(proposal.anchor?.[0] ?? null);
  }
}

/** A pending proposal group — the thread's accept-all unit. Rows
 *  without a `batch_id` are singleton groups keyed by proposal id. */
export interface ProposalGroup {
  key: string;
  batchId: string | null;
  rows: BoardProposalRow[];
}

/** Group pending proposals by `batch_id`, preserving draft order —
 *  one card per checkpoint (TDD: structural ops batch at checkpoints). */
export function groupPendingProposals(
  proposals: BoardProposalRow[],
): ProposalGroup[] {
  const groups = new Map<string, ProposalGroup>();
  for (const p of proposals) {
    if (p.status !== 'pending') continue;
    const key = p.batch_id ?? `solo:${p.proposal_id}`;
    const g = groups.get(key) ?? {
      key,
      batchId: p.batch_id ?? null,
      rows: [],
    };
    g.rows.push(p);
    groups.set(key, g);
  }
  return [...groups.values()];
}
