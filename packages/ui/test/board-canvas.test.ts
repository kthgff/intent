/**
 * s-16 board canvas — pure-module tests for the durable→node
 * projection, deterministic layout, and OCC-aware history
 * (BOARD-CANVAS-TDD "Durable and transient state").
 *
 * case:canvas-legacy-layout, case:canvas-hybrid-color,
 * case:canvas-locked, case:canvas-zone, case:canvas-undo,
 * case:canvas-batch-atomic (fence semantics).
 */
import type { BoardConnector, BoardItem } from '@veto/core';
import { describe, expect, it } from 'vitest';
import {
  CommandHistory,
  makeCommand,
  makeCreateCommand,
} from '../src/board-canvas/history';
import { arrange, legacyPositions } from '../src/board-canvas/layout';
import {
  absoluteRect,
  canvasColor,
  containingZone,
  projectConnectors,
  projectItems,
} from '../src/board-canvas/model';

const item = (over: Partial<BoardItem> & Pick<BoardItem, 'id'>): BoardItem => ({
  workspace: 'ws',
  board: 'ideas',
  kind: 'note',
  ref: null,
  title: null,
  body: null,
  x: null,
  y: null,
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

// ---------------------------------------------------------------------------
// layout.ts
// ---------------------------------------------------------------------------

describe('legacyPositions — case:canvas-legacy-layout', () => {
  it('is deterministic and ignores already-positioned items', () => {
    const items = [
      item({ id: 'b-2' }),
      item({ id: 'a-1' }),
      item({ id: 'placed', x: 999, y: 999 }),
    ];
    const first = legacyPositions(items);
    const second = legacyPositions([...items].reverse());
    expect(first).toEqual(second);
    expect(first.has('placed')).toBe(false);
    // Sorted by id: a-1 takes slot 0, b-2 slot 1.
    expect(first.get('a-1')).toEqual({ x: 120, y: 120 });
    expect(first.get('b-2')).toEqual({ x: 380, y: 120 });
  });

  it('groups zones first, then zone key, then note kind', () => {
    const items = [
      item({ id: 'n-1', zone: 'z-9' }),
      item({ id: 'z-9', kind: 'zone' }),
      item({ id: 'n-2' }),
    ];
    const pos = legacyPositions(items);
    const order = [...pos.keys()];
    expect(order[0]).toBe('z-9'); // zones first
    expect(order[1]).toBe('n-2'); // unzoned ('') sorts before 'z-9'
    expect(order[2]).toBe('n-1');
  });
});

describe('arrange', () => {
  it('groups by type with a deterministic grid and skips discarded', () => {
    const items = [
      item({ id: 'c', note_kind: 'want' }),
      item({ id: 'a', note_kind: 'avoid' }),
      item({ id: 'b', note_kind: 'want' }),
      item({ id: 'gone', status: 'discarded' }),
    ];
    const pos = arrange(items, 'type');
    expect(pos.has('gone')).toBe(false);
    const px = (id: string) => pos.get(id)?.x ?? Number.NaN;
    const py = (id: string) => pos.get(id)?.y ?? Number.NaN;
    // 'avoid' group sorts first → 'a' lands in the first block.
    expect(px('a')).toBeLessThan(px('b'));
    // Same group tiles horizontally — 'c' sits one column right of 'b'.
    expect(px('c') - px('b')).toBe(260);
    expect(py('b')).toBe(py('c'));
  });
});

// ---------------------------------------------------------------------------
// model.ts
// ---------------------------------------------------------------------------

describe('projectItems', () => {
  it('filters discarded and projects null coords transiently', () => {
    const nodes = projectItems([
      surface(item({ id: 'live' })),
      surface(item({ id: 'dead', status: 'discarded' })),
    ]);
    expect(nodes.map((n) => n.id)).toEqual(['live']);
    expect(nodes[0]?.position).toEqual({ x: 120, y: 120 });
  });

  it('hybrid color: explicit override wins, else note_kind, else yellow — case:canvas-hybrid-color', () => {
    expect(canvasColor(item({ id: 'x', color: 'blue' }))).toBe('blue');
    expect(canvasColor(item({ id: 'x', note_kind: 'avoid' }))).toBe('pink');
    expect(canvasColor(item({ id: 'x', note_kind: null }))).toBe('yellow');
  });

  it('locked items stay absolute and undraggable — case:canvas-locked', () => {
    const nodes = projectItems([
      surface(item({ id: 'z', kind: 'zone', x: 0, y: 0, w: 500, h: 400 })),
      surface(
        item({ id: 'locked', status: 'consumed', zone: 'z', x: 50, y: 50 }),
      ),
    ]);
    const locked = nodes.find((n) => n.id === 'locked');
    expect(locked?.data.locked).toBe(true);
    expect(locked?.draggable).toBe(false);
    expect(locked?.parentId).toBeUndefined();
    expect(locked?.position).toEqual({ x: 50, y: 50 });
  });

  it('zone membership → parentId with parent-relative coords — case:canvas-zone', () => {
    const nodes = projectItems([
      surface(item({ id: 'z', kind: 'zone', x: 100, y: 100, w: 600, h: 400 })),
      surface(item({ id: 'child', zone: 'z', x: 150, y: 180 })),
    ]);
    const child = nodes.find((n) => n.id === 'child');
    expect(child?.parentId).toBe('z');
    expect(child?.position).toEqual({ x: 50, y: 80 });
    // absoluteRect resolves back to the durable absolute position.
    expect(child && absoluteRect(child, nodes)).toMatchObject({
      x: 150,
      y: 180,
    });
  });

  it('legacy string zone becomes a grouping hint, never a parent', () => {
    const nodes = projectItems([
      surface(item({ id: 'n', zone: 'discovery-pile', x: 10, y: 10 })),
    ]);
    expect(nodes[0]?.parentId).toBeUndefined();
    expect(nodes[0]?.data.virtualZone).toBe('discovery-pile');
  });

  it('zones sort before children regardless of input order', () => {
    const nodes = projectItems([
      surface(item({ id: 'child', zone: 'z', x: 10, y: 10 })),
      surface(item({ id: 'z', kind: 'zone', x: 0, y: 0 })),
    ]);
    expect(nodes[0]?.id).toBe('z');
  });
});

describe('containingZone', () => {
  it('picks the deepest overlapping zone by z_index then area', () => {
    const nodes = projectItems([
      surface(item({ id: 'outer', kind: 'zone', x: 0, y: 0, w: 800, h: 800 })),
      surface(
        item({
          id: 'inner',
          kind: 'zone',
          x: 10,
          y: 10,
          w: 200,
          h: 200,
          z_index: 1,
        }),
      ),
      surface(item({ id: 'n', x: 50, y: 50, w: 40, h: 40 })),
    ]);
    const n = nodes.find((x) => x.id === 'n');
    expect(n && containingZone(n, nodes)).toBe('inner');
  });
});

describe('projectConnectors', () => {
  const conn = (over: Partial<BoardConnector>): BoardConnector => ({
    id: 'c-1',
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

  it('only active connectors become edges', () => {
    const edges = projectConnectors([
      conn({ id: 'c-1' }),
      conn({ id: 'c-2', status: 'superseded' }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.id).toBe('c-1');
  });
});

// ---------------------------------------------------------------------------
// history.ts
// ---------------------------------------------------------------------------

describe('CommandHistory — case:canvas-undo', () => {
  const at = (i: BoardItem, ts: string): BoardItem => ({
    ...i,
    updated_at: ts,
  });

  it('undo applies the before-state fenced on the after-ts; redo reverses', () => {
    const h = new CommandHistory();
    const before = item({ id: 'i-1', x: 0, y: 0 });
    const after = at({ ...before, x: 100, y: 100 }, '2026-10-05T00:00:01Z');
    h.push(makeCommand('move', [before], [after]));

    const current = new Map([[after.id, after]]);
    const undo = h.planUndo(current);
    expect(undo.ok).toBe(true);
    if (undo.ok) {
      expect(undo.mutations[0]?.expected_updated_at).toBe(
        '2026-10-05T00:00:01Z',
      );
      expect(undo.mutations[0]?.patch.x).toBe(0);
    }

    const undone = at(before, '2026-10-05T00:00:02Z');
    h.commitUndo([undone]);
    expect(h.canRedo).toBe(true);

    const redo = h.planRedo(new Map([[undone.id, undone]]));
    expect(redo.ok).toBe(true);
    if (redo.ok) {
      // Fence is the post-undo timestamp, not the original command's.
      expect(redo.mutations[0]?.expected_updated_at).toBe(
        '2026-10-05T00:00:02Z',
      );
      expect(redo.mutations[0]?.patch.x).toBe(100);
    }
  });

  it('planning fails when the row moved remotely — no silent merge', () => {
    const h = new CommandHistory();
    const before = item({ id: 'i-1', x: 0 });
    const after = at({ ...before, x: 5 }, 't2');
    h.push(makeCommand('move', [before], [after]));

    const remoteMoved = at(after, 't3-remote');
    const plan = h.planUndo(new Map([['i-1', remoteMoved]]));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.conflictId).toBe('i-1');
  });

  it('refuses to write an unfenced row', () => {
    const h = new CommandHistory();
    const before = item({ id: 'i-1', x: 0 });
    const after = at({ ...before, x: 5 }, 't2');
    h.push(makeCommand('move', [before], [after]));
    const noTs = { ...after, updated_at: null };
    expect(h.planUndo(new Map([['i-1', noTs]])).ok).toBe(false);
  });

  it('undo of a create discards; redo restores — soft-delete only', () => {
    const h = new CommandHistory();
    const created = at(item({ id: 'new' }), 't1');
    h.push(makeCreateCommand(created));
    const undo = h.planUndo(new Map([['new', created]]));
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(undo.mutations[0]?.patch.status).toBe('discarded');
  });

  it('a new push clears the redo stack', () => {
    const h = new CommandHistory();
    const b = item({ id: 'i-1', x: 0 });
    const a = at({ ...b, x: 5 }, 't2');
    h.push(makeCommand('m', [b], [a]));
    h.commitUndo([at(b, 't3')]);
    expect(h.canRedo).toBe(true);
    h.push(makeCommand('m2', [b], [a]));
    expect(h.canRedo).toBe(false);
  });

  it('dropReferences forgets commands for remotely-removed rows', () => {
    const h = new CommandHistory();
    const b = item({ id: 'i-1', x: 0 });
    h.push(makeCommand('m', [b], [at({ ...b, x: 5 }, 't2')]));
    h.dropReferences(new Set(['i-1']));
    expect(h.canUndo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// perf fixture — TDD budget: 300 nodes / 40 zones / 300 connectors
// ---------------------------------------------------------------------------

describe('perf fixture (300 nodes / 40 zones / 300 connectors)', () => {
  it('projects the full board well inside the frame budget', () => {
    const surfaces = [];
    for (let z = 0; z < 40; z++) {
      surfaces.push(
        surface(
          item({
            id: `zone-${z}`,
            kind: 'zone',
            x: z * 40,
            y: z * 40,
            w: 900,
            h: 700,
          }),
        ),
      );
    }
    for (let i = 0; i < 300; i++) {
      surfaces.push(
        surface(
          item({
            id: `n-${i}`,
            x: (i % 20) * 260,
            y: Math.floor(i / 20) * 220,
            zone: i % 3 === 0 ? `zone-${i % 40}` : null,
          }),
        ),
      );
    }
    const connectors = Array.from({ length: 300 }, (_, i) => ({
      id: `c-${i}`,
      workspace: 'ws',
      board: 'ideas',
      source_item_id: `n-${i}`,
      target_item_id: `n-${(i + 1) % 300}`,
      label: null,
      status: 'active' as const,
      created_at: null,
      updated_at: null,
    }));

    const t0 = performance.now();
    const nodes = projectItems(surfaces);
    const edges = projectConnectors(connectors);
    // containingZone is the hot path at gesture end — sweep it once.
    for (const n of nodes) containingZone(n, nodes);
    const ms = performance.now() - t0;

    expect(nodes).toHaveLength(340);
    expect(edges).toHaveLength(300);
    // Generous CI bound — the real budget is one animation frame.
    expect(ms).toBeLessThan(2000);
  });
});
