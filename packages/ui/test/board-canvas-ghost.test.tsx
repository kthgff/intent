// @vitest-environment jsdom
/**
 * BOARD-CHAT wp-166 — ghost projection tests.
 *
 * case:board-chat-03/09: pending `board_proposals` project as ghost
 * nodes/edges per op kind; ghosts are never draggable/selectable and
 * vanish on resolve. Pure-projection coverage plus a GhostNode
 * chrome render.
 */
import { cleanup, render, screen } from '@testing-library/react';
import type {
  BoardConnector,
  BoardItem,
  BoardProposalRow,
  ProposalOp,
} from '@veto/core';
import type { NodeProps } from '@xyflow/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ghostId, projectProposals } from '../src/board-canvas/assistant';
import type { CanvasNode } from '../src/board-canvas/model';
import { GhostNode } from '../src/board-canvas/nodes';

afterEach(cleanup);

const item = (over: Partial<BoardItem> & Pick<BoardItem, 'id'>): BoardItem => ({
  workspace: 'ws',
  board: 'ideas',
  kind: 'note',
  ref: null,
  title: null,
  body: null,
  x: 10,
  y: 10,
  w: null,
  h: null,
  zone: null,
  serves: null,
  status: 'active',
  consumed_by: null,
  note_kind: 'idea',
  topic: null,
  importance: null,
  applies_to: null,
  note_status: 'open',
  rationale: null,
  provenance: 'stakeholder-verified',
  created_at: '2026-10-05T00:00:00Z',
  updated_at: '2026-10-05T00:00:00Z',
  ...over,
});

const surface = (i: BoardItem) => ({ item: i, statements: [] });

const proposal = (
  id: string,
  payload: ProposalOp,
  over: Partial<BoardProposalRow> = {},
): BoardProposalRow => ({
  workspace: 'ws',
  org: null,
  proposal_id: id,
  board: 'ideas',
  session_id: 'sess-1',
  batch_id: null,
  seq: null,
  op: payload.op,
  payload,
  base_updated_at: null,
  anchor: null,
  provenance: null,
  status: 'pending',
  created_by: 'keith',
  decided_by: null,
  decided_at: null,
  created_at: '2026-10-05T00:00:00Z',
  updated_at: '2026-10-05T00:00:00Z',
  ...over,
});

const connector = (
  over: Partial<BoardConnector> & Pick<BoardConnector, 'id'>,
): BoardConnector => ({
  workspace: 'ws',
  board: 'ideas',
  source_item_id: 'a',
  target_item_id: 'b',
  label: null,
  status: 'active',
  created_at: '2026-10-05T00:00:00Z',
  updated_at: '2026-10-05T00:00:00Z',
  ...over,
});

// ---------------------------------------------------------------------------
// projectProposals — pending filter + ghost invariants
// ---------------------------------------------------------------------------

describe('projectProposals — pending filter', () => {
  it('projects only pending rows; resolved rows produce no ghosts', () => {
    const p = proposal('p1', { op: 'create-item', x: 5, y: 5, title: 'new' });
    const out = projectProposals([p], []);
    expect(out.nodes).toHaveLength(1);
    // Resolve the row → the projection drops the ghost entirely.
    for (const status of [
      'accepted',
      'rejected',
      'stale',
      'superseded',
    ] as const) {
      const resolved = projectProposals([{ ...p, status }], []);
      expect(resolved.nodes).toHaveLength(0);
      expect(resolved.edges).toHaveLength(0);
    }
  });

  it('empty input → empty projection (dormant path)', () => {
    expect(projectProposals([], [surface(item({ id: 'a' }))])).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

describe('projectProposals — per-op ghosts (case:board-chat-09)', () => {
  it('create-item → ghost card at stored x/y/w/h, inferred provenance', () => {
    const p = proposal('p-create', {
      op: 'create-item',
      note_kind: 'problem',
      title: 'Auth constraint',
      importance: 'must',
      x: 400,
      y: 260,
      w: 240,
      h: 200,
    });
    const { nodes, edges } = projectProposals([p], []);
    expect(edges).toHaveLength(0);
    const n = nodes[0] as CanvasNode;
    expect(n.id).toBe(ghostId('p-create'));
    expect(n.type).toBe('ghost');
    expect(n.position).toEqual({ x: 400, y: 260 });
    expect(n.width).toBe(240);
    expect(n.height).toBe(200);
    expect(n.draggable).toBe(false);
    expect(n.selectable).toBe(false);
    expect(n.focusable).toBe(false);
    expect(n.deletable).toBe(false);
    expect(n.data.ghost?.proposal).toBe(p);
    expect(n.data.ghost?.treatment).toBe('add');
    expect(n.data.item.title).toBe('Auth constraint');
    expect(n.data.item.note_kind).toBe('problem');
    expect(n.data.item.provenance).toBe('inferred');
  });

  it('create-item inside a real zone → parent-relative position', () => {
    const zone = item({ id: 'z1', kind: 'zone', x: 100, y: 100 });
    const p = proposal('p-zone-create', {
      op: 'create-item',
      title: 'zoned',
      x: 160,
      y: 190,
      zone: 'z1',
    });
    const { nodes } = projectProposals([p], [surface(zone)]);
    const n = nodes[0] as CanvasNode;
    expect(n.parentId).toBe('z1');
    expect(n.position).toEqual({ x: 60, y: 90 });
  });

  it('create-item with a legacy zone label → virtualZone, no parent', () => {
    const p = proposal('p-label', {
      op: 'create-item',
      title: 'labeled',
      x: 0,
      y: 0,
      zone: 'risks',
    });
    const { nodes } = projectProposals([p], []);
    expect(nodes[0]?.parentId).toBeUndefined();
    expect(nodes[0]?.data.virtualZone).toBe('risks');
  });

  it('patch-item → ghost overlays the target slot with patched fields', () => {
    const target = item({ id: 't1', x: 50, y: 60, title: 'old title' });
    const p = proposal('p-patch', {
      op: 'patch-item',
      id: 't1',
      patch: { title: 'sharper title', importance: 'must' },
    });
    const { nodes } = projectProposals([p], [surface(target)]);
    const n = nodes[0] as CanvasNode;
    expect(n.id).toBe(ghostId('p-patch'));
    expect(n.position).toEqual({ x: 50, y: 60 });
    expect(n.data.ghost?.treatment).toBe('change');
    expect(n.data.item.title).toBe('sharper title');
    expect(n.data.item.importance).toBe('must');
    expect(n.data.item.body).toBeNull(); // untouched fields survive
  });

  it('patch-item on a missing/discarded target projects nothing', () => {
    const gone = item({ id: 't2', status: 'discarded' });
    const p = proposal('p-patch-gone', {
      op: 'patch-item',
      id: 't2',
      patch: { title: 'x' },
    });
    expect(projectProposals([p], []).nodes).toHaveLength(0);
    expect(projectProposals([p], [surface(gone)]).nodes).toHaveLength(0);
  });

  it('move-item → ghost at the target position', () => {
    const target = item({ id: 't3', x: 10, y: 10 });
    const p = proposal('p-move', { op: 'move-item', id: 't3', x: 300, y: 220 });
    const { nodes } = projectProposals([p], [surface(target)]);
    const n = nodes[0] as CanvasNode;
    expect(n.position).toEqual({ x: 300, y: 220 });
    expect(n.data.ghost?.treatment).toBe('move');
  });

  it('move-item into a zone → ghost re-parents with relative coords', () => {
    const zone = item({ id: 'z2', kind: 'zone', x: 500, y: 400 });
    const target = item({ id: 't4', x: 10, y: 10 });
    const p = proposal('p-move-zone', {
      op: 'move-item',
      id: 't4',
      x: 560,
      y: 450,
      zone: 'z2',
    });
    const { nodes } = projectProposals([p], [surface(zone), surface(target)]);
    const n = nodes[0] as CanvasNode;
    expect(n.parentId).toBe('z2');
    expect(n.position).toEqual({ x: 60, y: 50 });
    expect(n.data.item.zone).toBe('z2');
  });

  it('serve → ghost edge item → goal labelled serves', () => {
    const items = [
      surface(item({ id: 'feat' })),
      surface(item({ id: 'goal' })),
    ];
    const p = proposal('p-serve', {
      op: 'serve',
      id: 'feat',
      goal_item_id: 'goal',
    });
    const { nodes, edges } = projectProposals([p], items);
    expect(nodes).toHaveLength(0);
    const e = edges[0];
    expect(e?.id).toBe(ghostId('p-serve'));
    expect(e?.source).toBe('feat');
    expect(e?.target).toBe('goal');
    expect(e?.selectable).toBe(false);
    expect(e?.data?.connector.label).toBe('serves');
    expect(e?.data?.ghost?.treatment).toBe('edge');
  });

  it('connect → ghost edge with payload label; missing endpoint skipped', () => {
    const items = [surface(item({ id: 'a' })), surface(item({ id: 'b' }))];
    const p = proposal('p-connect', {
      op: 'connect',
      source_item_id: 'a',
      target_item_id: 'b',
      label: 'related',
    });
    const { edges } = projectProposals([p], items);
    expect(edges[0]?.data?.connector.label).toBe('related');
    expect(edges[0]?.data?.ghost?.proposal).toBe(p);
    // One endpoint not on the board → no edge.
    const dangling = proposal('p-connect-dangle', {
      op: 'connect',
      source_item_id: 'a',
      target_item_id: 'zzz',
    });
    expect(projectProposals([dangling], items).edges).toHaveLength(0);
  });

  it('connector-remove → ghost edge clones the connector endpoints', () => {
    const items = [surface(item({ id: 'a' })), surface(item({ id: 'b' }))];
    const conn = connector({ id: 'c1', label: 'old link' });
    const p = proposal('p-cr', { op: 'connector-remove', id: 'c1' });
    const { edges } = projectProposals([p], items, [conn]);
    const e = edges[0];
    expect(e?.source).toBe('a');
    expect(e?.target).toBe('b');
    expect(e?.data?.connector.label).toBe('old link');
    expect(e?.data?.ghost?.treatment).toBe('remove');
    // Unknown connector → nothing.
    const unknown = proposal('p-cr-x', { op: 'connector-remove', id: 'zzz' });
    expect(projectProposals([unknown], items, [conn]).edges).toHaveLength(0);
  });

  it('delete-item → ghost over the target with discarded treatment', () => {
    const target = item({ id: 't5', x: 30, y: 40, title: 'drop me' });
    const p = proposal('p-del', { op: 'delete-item', id: 't5' });
    const { nodes } = projectProposals([p], [surface(target)]);
    const n = nodes[0] as CanvasNode;
    expect(n.position).toEqual({ x: 30, y: 40 });
    expect(n.data.ghost?.treatment).toBe('remove');
    expect(n.data.item.status).toBe('discarded');
    expect(n.data.item.title).toBe('drop me');
  });

  it('temp_id batch: notes parent under the proposed frame; connect edges resolve (D69)', () => {
    const proposals = [
      proposal('f1', {
        op: 'create-item',
        kind: 'zone',
        title: 'frame',
        temp_id: 'f',
        x: 0,
        y: 0,
        w: 900,
        h: 400,
      }),
      proposal('n1', {
        op: 'create-item',
        title: 'one',
        temp_id: 'n1',
        zone: 'f',
        x: 32,
        y: 32,
      }),
      proposal('n2', {
        op: 'create-item',
        title: 'two',
        temp_id: 'n2',
        zone: 'f',
        x: 288,
        y: 32,
      }),
      proposal('c1', {
        op: 'connect',
        source_item_id: 'n1',
        target_item_id: 'n2',
        label: 'rel',
      }),
    ];
    const { nodes, edges } = projectProposals(proposals, []);
    expect(nodes).toHaveLength(3);
    const note = nodes.find((n) => n.id === ghostId('n1'));
    expect(note?.parentId).toBe(ghostId('f1'));
    const edge = edges[0];
    expect(edge?.source).toBe(ghostId('n1'));
    expect(edge?.target).toBe(ghostId('n2'));
    expect(edge?.data?.connector.label).toBe('rel');
  });

  it('a pending batch projects every op together, zones before children', () => {
    const proposals = [
      proposal('b1', {
        op: 'create-item',
        x: 0,
        y: 0,
        title: 'child',
        zone: ghostId('b0'),
      }),
      proposal('b0', {
        op: 'create-item',
        kind: 'zone',
        x: 0,
        y: 0,
        title: 'frame',
      }),
      proposal('b2', { op: 'delete-item', id: 't6' }),
    ];
    const { nodes } = projectProposals(proposals, [
      surface(item({ id: 't6' })),
    ]);
    expect(nodes.map((n) => n.id)).toEqual([
      ghostId('b0'),
      ghostId('b1'),
      ghostId('b2'),
    ]);
    // The child ghosts into the proposed zone — parentId relative.
    expect(nodes[1]?.parentId).toBe(ghostId('b0'));
  });
});

// ---------------------------------------------------------------------------
// GhostNode chrome — proposed chip + assistant attribution
// ---------------------------------------------------------------------------

describe('GhostNode — ghost chrome', () => {
  const data = (
    over: Partial<CanvasNode['data']> = {},
  ): CanvasNode['data'] => ({
    item: item({ id: 'g', title: 'Ghost card' }),
    statementCount: 0,
    color: 'yellow',
    locked: true,
    virtualZone: null,
    editing: false,
    votes: null,
    commentCount: 0,
    threadSize: 0,
    ghost: {
      proposal: proposal('gp', { op: 'create-item', x: 0, y: 0 }),
      treatment: 'add',
    },
    ...over,
  });

  const renderGhost = (d: CanvasNode['data']) =>
    render(
      <GhostNode
        {...({ id: 'g', data: d } as unknown as NodeProps<CanvasNode>)}
      />,
    );

  it('renders the proposed chip, attribution, and ghost classes', () => {
    const { container } = renderGhost(data());
    const card = container.querySelector('.canvas-ghost') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.className).toContain('is-ghost-add');
    expect(screen.getByText('proposed')).toBeTruthy();
    expect(card.textContent).toContain('assistant · keith');
    expect(card.textContent).toContain('Ghost card');
  });

  it('remove treatment marks the card discarded-styled', () => {
    const { container } = renderGhost(
      data({
        item: item({ id: 'g', title: 'doomed', status: 'discarded' }),
        ghost: {
          proposal: proposal('gd', { op: 'delete-item', id: 't' }),
          treatment: 'remove',
        },
      }),
    );
    const card = container.querySelector('.canvas-ghost') as HTMLElement;
    expect(card.className).toContain('is-ghost-remove');
  });
});
