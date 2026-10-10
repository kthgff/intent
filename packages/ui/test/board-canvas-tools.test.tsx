import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
// @vitest-environment jsdom
/**
 * BOARD-CANVAS-TOOLS-TDD — pure-module unit tests for the tool
 * extensions. The interactive wiring lives in BoardCanvas; the
 * hit-testing, comment threading, tally derivation, presentation
 * ordering, and stroke simplification the spec calls out as
 * "testable pure modules" are covered here.
 */
import type {
  BoardAnnotation,
  BoardItem,
  BoardVote,
  BoardVoteSession,
} from '@veto/core';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeTypeFor, projectItems } from '../src/board-canvas/model';
import {
  ArrangePreviewBar,
  MultiSelectBar,
  TimerChip,
} from '../src/board-canvas/overlays';
import {
  commentThreads,
  isCommentItem,
  openComments,
  threadKeyOf,
} from '../src/board-canvas/tools/comment';
import {
  finalizeShape,
  finalizeStroke,
  pointsToPath,
  simplifyRDP,
} from '../src/board-canvas/tools/draw/strokes';
import { orderedZones } from '../src/board-canvas/tools/presentation';
import {
  nodeAtPoint,
  nodesInRect,
  rectsIntersect,
  screenRectToFlow,
} from '../src/board-canvas/tools/select';
import {
  openSession,
  tallyByItem,
  visibleTallies,
} from '../src/board-canvas/tools/vote';

afterEach(cleanup);

const item = (over: Partial<BoardItem> & Pick<BoardItem, 'id'>): BoardItem => ({
  workspace: 'ws',
  board: 'ideas',
  kind: 'note',
  ref: null,
  title: null,
  body: null,
  x: 0,
  y: 0,
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

const nodesOf = (items: BoardItem[]) =>
  projectItems(items.map((i) => ({ item: i, statements: [] })));

// ---------------------------------------------------------------------------
// case:canvas-tools-01 — lasso hit-testing
// ---------------------------------------------------------------------------

describe('lasso — case:canvas-tools-01', () => {
  it('rectsIntersect reports partial overlap, containment, disjoint', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectsIntersect(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 10, w: 20, h: 20 })).toBe(true);
    expect(rectsIntersect(a, { x: 200, y: 200, w: 10, h: 10 })).toBe(false);
    // Edge-touching is not intersection (strict inequality).
    expect(rectsIntersect(a, { x: 100, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('screenRectToFlow converts a screen marquee under pan/zoom', () => {
    // zoom=2, pan=(100,50): screen point (300,250) → flow (100,100).
    const r = screenRectToFlow(
      { x1: 300, y1: 250, x2: 500, y2: 450 },
      { x: 100, y: 50, zoom: 2 },
    );
    expect(r).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });

  it('nodesInRect selects intersecting nodes incl. locked; empty → []', () => {
    const nodes = nodesOf([
      item({ id: 'inside', x: 100, y: 100, w: 200, h: 100 }),
      item({ id: 'edge', x: 290, y: 100, w: 200, h: 100 }),
      item({ id: 'outside', x: 900, y: 900 }),
      item({ id: 'locked', x: 120, y: 120, status: 'consumed' }),
    ]);
    const hit = nodesInRect({ x: 0, y: 0, w: 300, h: 300 }, nodes);
    expect(hit).toContain('inside');
    expect(hit).toContain('edge');
    expect(hit).toContain('locked'); // locked joins; writes exclude it
    expect(hit).not.toContain('outside');
    expect(nodesInRect({ x: 0, y: 0, w: 0, h: 0 }, nodes)).toEqual([]);
  });

  it('nodeAtPoint prefers a content node over its containing zone', () => {
    const nodes = nodesOf([
      item({ id: 'z', kind: 'zone', x: 0, y: 0, w: 400, h: 400 }),
      item({ id: 'n', x: 50, y: 50, w: 100, h: 80 }),
    ]);
    expect(nodeAtPoint({ x: 60, y: 60 }, nodes)?.id).toBe('n');
    expect(nodeAtPoint({ x: 350, y: 350 }, nodes)?.id).toBe('z');
    expect(nodeAtPoint({ x: 900, y: 900 }, nodes)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// case:canvas-tools-02 — bulk-bar verb parity + locked reporting
// ---------------------------------------------------------------------------

describe('bulk bar — case:canvas-tools-02', () => {
  const verbs = (over: Record<string, unknown> = {}) => (
    <MultiSelectBar
      count={4}
      lockedCount={0}
      taxonomy={['idea', 'problem']}
      onSetStatus={() => {}}
      onSetType={() => {}}
      onSetImportance={() => {}}
      onMoveTray={() => {}}
      onDiscard={() => {}}
      onArrange={() => {}}
      onClear={() => {}}
      {...over}
    />
  );

  it('exposes the full Easy Edit verb set', () => {
    render(verbs());
    for (const label of [
      'set status',
      'set type',
      'set importance',
      'arrange by',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    for (const name of ['Move to tray', 'Discard', 'Clear']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('announces locked members and disables verbs when all locked', () => {
    render(verbs({ count: 3, lockedCount: 2 }));
    expect(screen.getByText(/2 locked unaffected/)).toBeTruthy();
    // One mutable member remains — verbs still enabled.
    expect(
      (screen.getByLabelText('set status') as HTMLSelectElement).disabled,
    ).toBe(false);

    cleanup();
    render(verbs({ count: 2, lockedCount: 2 }));
    expect(
      (screen.getByLabelText('set status') as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// case:canvas-tools-03 — comment pins
// ---------------------------------------------------------------------------

describe('comment pins — case:canvas-tools-03', () => {
  const comment = (over: Partial<BoardItem> & Pick<BoardItem, 'id'>) =>
    item({ kind: 'feedback', note_kind: 'comment', ...over });

  it('identifies comment items and groups threads by target', () => {
    const pin = comment({ id: 'c1', ref: 'n1' });
    const free = comment({ id: 'c2' });
    const other = item({ id: 'n1', kind: 'note' });
    expect(isCommentItem(pin)).toBe(true);
    expect(isCommentItem(other)).toBe(false);
    expect(isCommentItem(comment({ id: 'c3', status: 'discarded' }))).toBe(
      false,
    );

    const threads = commentThreads([
      pin,
      free,
      other,
      comment({ id: 'c4', ref: 'n1' }),
    ]);
    expect(threads.get('n1')?.map((c) => c.id)).toEqual(['c1', 'c4']);
    expect(threads.get('c2')?.map((c) => c.id)).toEqual(['c2']);
    expect(threadKeyOf(free)).toBe('c2');
  });

  it('openComments filters resolved; resolve keeps the row', () => {
    const thread = [
      comment({ id: 'a', ref: 'n', created_at: '2026-10-01T00:00:00Z' }),
      comment({
        id: 'b',
        ref: 'n',
        note_status: 'resolved',
        created_at: '2026-10-02T00:00:00Z',
      }),
    ];
    expect(openComments(thread).map((c) => c.id)).toEqual(['a']);
    expect(thread).toHaveLength(2); // resolved comments are archived, not deleted
  });

  it('projects comment items as compact pin nodes with thread size', () => {
    const nodes = nodesOf([
      item({ id: 'target', x: 0, y: 0 }),
      item({ id: 'c1', kind: 'feedback', note_kind: 'comment', ref: 'target' }),
      item({ id: 'c2', kind: 'feedback', note_kind: 'comment', ref: 'target' }),
      item({
        id: 'c3',
        kind: 'feedback',
        note_kind: 'comment',
        ref: 'target',
        note_status: 'resolved',
      }),
    ]);
    const commentNode = nodes.find((n) => n.id === 'c1');
    if (!commentNode) throw new Error('comment pin missing from projection');
    expect(nodeTypeFor(commentNode.data.item)).toBe('comment');
    const target = nodes.find((n) => n.id === 'target');
    const pin = commentNode;
    expect(target?.data.commentCount).toBe(2); // open only
    expect(pin?.data.threadSize).toBe(3); // whole thread incl. resolved
    expect(pin?.type).toBe('comment');
  });
});

// ---------------------------------------------------------------------------
// case:canvas-tools-04 — vote sessions + tallies
// ---------------------------------------------------------------------------

describe('votes — case:canvas-tools-04', () => {
  const session = (
    over: Partial<BoardVoteSession> & Pick<BoardVoteSession, 'id'>,
  ): BoardVoteSession => ({
    workspace: 'ws',
    board: 'ideas',
    opened_by: 'tester',
    closes_at: null,
    status: 'open',
    created_at: '2026-10-05T00:00:00Z',
    updated_at: '2026-10-05T00:00:00Z',
    ...over,
  });
  const vote = (
    over: Partial<BoardVote> & Pick<BoardVote, 'item_id' | 'session_id'>,
  ): BoardVote => ({
    workspace: 'ws',
    board: 'ideas',
    voter: 'tester',
    stamp: 'up',
    created_at: null,
    updated_at: null,
    ...over,
  });

  it('tallyByItem counts stamps per item', () => {
    const t = tallyByItem([
      vote({ item_id: 'a', session_id: 's', stamp: 'up' }),
      vote({ item_id: 'a', session_id: 's', stamp: 'up', voter: 'b' }),
      vote({ item_id: 'a', session_id: 's', stamp: 'question', voter: 'c' }),
      vote({ item_id: 'b', session_id: 's', stamp: 'down' }),
    ]);
    expect(t.get('a')).toEqual({ up: 2, down: 0, question: 1 });
    expect(t.get('b')).toEqual({ up: 0, down: 1, question: 0 });
  });

  it('badges show only while a session is open or ?votes=show', () => {
    const open = session({ id: 's1', created_at: '2026-10-01T00:00:00Z' });
    const closed = session({
      id: 's0',
      status: 'closed',
      created_at: '2026-09-01T00:00:00Z',
    });
    const votes = [
      vote({ item_id: 'a', session_id: 's0' }),
      vote({ item_id: 'b', session_id: 's1' }),
    ];
    // Open session → only its votes tally (closed-session rows excluded).
    expect(visibleTallies(votes, [open, closed], false)?.get('b')).toEqual({
      up: 1,
      down: 0,
      question: 0,
    });
    expect(visibleTallies(votes, [open, closed], false)?.has('a')).toBe(false);
    // All closed → hidden unless showAll.
    const allClosed = [{ ...open, status: 'closed' as const }, closed];
    expect(visibleTallies(votes, allClosed, false)).toBeNull();
    // showAll surfaces the latest (created_at) session's results.
    expect(visibleTallies(votes, allClosed, true)?.get('b')).toEqual({
      up: 1,
      down: 0,
      question: 0,
    });
    expect(openSession([open, closed])?.id).toBe('s1');
    expect(openSession(allClosed)).toBeNull();
  });

  it('tallies land on projected node data', () => {
    const tallies = new Map([['a', { up: 3, down: 1, question: 0 }]]);
    const nodes = projectItems(
      [{ item: item({ id: 'a' }), statements: [] }],
      null,
      { votes: tallies },
    );
    expect(nodes[0]?.data.votes).toEqual({ up: 3, down: 1, question: 0 });
  });
});

// ---------------------------------------------------------------------------
// case:canvas-tools-05 — presentation ordering + timer chrome
// ---------------------------------------------------------------------------

describe('presentation — case:canvas-tools-05', () => {
  it('orderedZones traverses ordered zones only, deterministically', () => {
    const zones = orderedZones([
      item({ id: 'b', kind: 'zone', presentation_order: 2 }),
      item({ id: 'a', kind: 'zone', presentation_order: 1 }),
      item({ id: 'c', kind: 'zone' }), // unordered → skipped
      item({
        id: 'd',
        kind: 'zone',
        presentation_order: 0,
        status: 'discarded',
      }),
      item({ id: 'e', presentation_order: 1 }), // non-zone → skipped
      item({ id: 'f', kind: 'zone', presentation_order: 2 }),
    ]);
    expect(zones.map((z) => z.id)).toEqual(['a', 'b', 'f']);
  });
});

describe('timer — case:canvas-tools-05', () => {
  it('starts, pauses, and resets with polite announcements', () => {
    vi.useFakeTimers();
    render(<TimerChip />);
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Start timer'));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('0:03')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Pause timer'));
    act(() => {
      vi.runAllTimers();
    });
    expect(region?.textContent).toContain('paused');

    fireEvent.click(screen.getByLabelText('Reset timer'));
    act(() => {
      vi.runAllTimers();
    });
    expect(region?.textContent).toContain('reset');
    expect(screen.getByText('0:00')).toBeTruthy();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// case:canvas-tools-06 — stroke capture + simplification
// ---------------------------------------------------------------------------

describe('drawing — case:canvas-tools-06', () => {
  const line = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ x: i, y: 0 }));

  it('RDP drops collinear interior points, keeps endpoints', () => {
    const pts = simplifyRDP(line(50));
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 49, y: 0 },
    ]);
  });

  it('RDP keeps a bend beyond epsilon', () => {
    const pts = simplifyRDP([
      { x: 0, y: 0 },
      { x: 50, y: 10 }, // 10px off the chord > ε=1.5
      { x: 100, y: 0 },
    ]);
    expect(pts).toHaveLength(3);
  });

  it('finalizeStroke rejects degenerate and oversized captures', () => {
    expect(finalizeStroke([{ x: 0, y: 0 }])).toBeNull();
    expect(finalizeStroke([])).toBeNull();
    expect(finalizeStroke(line(2001))).toBeNull();
    expect(finalizeStroke(line(2000))).not.toBeNull();
  });

  it('finalizeShape rejects ~zero-area drags', () => {
    expect(finalizeShape('rect', { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
    expect(finalizeShape('arrow', { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
    expect(finalizeShape('rect', { x: 10, y: 10 }, { x: 0, y: 0 })).toEqual({
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    });
    expect(finalizeShape('ellipse', { x: 0, y: 0 }, { x: 20, y: 10 })).toEqual({
      x: 0,
      y: 0,
      w: 20,
      h: 10,
    });
  });

  it('pointsToPath emits a move + line path', () => {
    expect(
      pointsToPath([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]),
    ).toBe('M 1 2 L 3 4');
  });
});

// ---------------------------------------------------------------------------
// case:canvas-tools-08 — arrange preview reporting
// ---------------------------------------------------------------------------

describe('arrange preview — case:canvas-tools-08', () => {
  it('reports locked exclusions in the preview bar', () => {
    render(
      <ArrangePreviewBar
        count={5}
        lockedSkipped={2}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/2 locked stay put/)).toBeTruthy();
    expect(screen.getByText(/arrange 5 items/)).toBeTruthy();
  });
});
