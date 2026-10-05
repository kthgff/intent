/**
 * wp-081 board derivation tests — the pure display rules in
 * `src/board.ts`: snoozed cards leave the board, in-column sort is
 * attention-first → priority → age, Done caps at ~20 recent, and
 * `dropTargetFor` only ever returns a server-declared target.
 */
import { describe, expect, it } from 'vitest';
import type { BoardAttention, BoardCard, BoardPhase } from '../src/api';
import {
  DONE_CAP,
  columnsFor,
  dropTargetFor,
  hasAttention,
  isLoudKind,
  sortCards,
} from '../src/board';

const NOW = '2026-10-05T12:00:00Z';

const attention = (over: Partial<BoardAttention> = {}): BoardAttention =>
  ({
    workspace: 'ws',
    subject: 'SR-0001',
    gate: 'triage',
    kind: 'question',
    surfaced_at: '2026-10-01T00:00:00Z',
    cleared_at: null,
    blocked_agent: false,
    priority: null,
    snoozed_until: null,
    claim: null,
    ...over,
  }) as BoardAttention;

const card = (over: Partial<BoardCard> = {}): BoardCard =>
  ({
    ticket: {
      workspace: 'ws',
      ticket_id: 'SR-0001',
      title: 't',
      status: 'triage',
      priority: 'medium',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    },
    ref: 'ws/SR-0001',
    phase: 'spec',
    flagged: null,
    snoozed: false,
    snoozed_until: null,
    attention: [],
    live_run: null,
    drop_targets: [],
    ...over,
  }) as BoardCard;

describe('S-01 board derivation (wp-081)', () => {
  it('groups cards into the five phase columns; snoozed cards leave', () => {
    const cols = columnsFor([
      card({ ref: 'a', phase: 'backlog' }),
      card({ ref: 'b', phase: 'build' }),
      card({ ref: 'c', phase: 'build', snoozed: true }),
      card({ ref: 'd', phase: 'done' }),
    ]);
    const byPhase = Object.fromEntries(
      cols.map((c) => [c.phase, c.cards.map((x) => x.ref)]),
    ) as Record<BoardPhase, string[]>;
    expect(byPhase.backlog).toEqual(['a']);
    expect(byPhase.build).toEqual(['b']);
    expect(byPhase.done).toEqual(['d']);
    expect(byPhase.spec).toEqual([]);
    expect(byPhase.review).toEqual([]);
  });

  it('in-column sort: attention-first → priority → age', () => {
    const quiet = card({
      ref: 'quiet',
      ticket: { ...card().ticket, priority: 'high' },
    });
    const loud = card({
      ref: 'loud',
      attention: [attention({ kind: 'failure' })],
      ticket: { ...card().ticket, priority: 'low' },
    });
    const sorted = sortCards([quiet, loud], NOW);
    expect(sorted.map((c) => c.ref)).toEqual(['loud', 'quiet']);
  });

  it('a snoozed-until-future gate does not count as live attention', () => {
    const c = card({
      attention: [attention({ snoozed_until: '2026-10-06T00:00:00Z' })],
    });
    expect(hasAttention(c, NOW)).toBe(false);
  });

  it('Done caps at DONE_CAP most-recent, remainder in overflow', () => {
    const cards = Array.from({ length: DONE_CAP + 5 }, (_, i) =>
      card({
        ref: `done-${i}`,
        phase: 'done',
        ticket: {
          ...card().ticket,
          updated_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        },
      }),
    );
    const done = columnsFor(cards).find((c) => c.phase === 'done');
    expect(done?.cards).toHaveLength(DONE_CAP);
    expect(done?.overflow).toHaveLength(5);
    expect(done?.total).toBe(DONE_CAP + 5);
  });

  it('dropTargetFor returns only a server-declared target', () => {
    const c = card({
      phase: 'build',
      flagged: 'failed',
      drop_targets: [
        {
          column: 'build',
          action: 'retry',
          confirm: true,
          label: 'Retry',
        },
      ],
    });
    // Self-column retry is allowed for a failed card…
    expect(dropTargetFor(c, 'build')?.action).toBe('retry');
    // …but no inferred drops anywhere else.
    for (const phase of ['backlog', 'spec', 'review', 'done'] as const) {
      expect(dropTargetFor(c, phase)).toBeUndefined();
    }
  });

  it('failure/escalation badges are the loud kinds (D21 emphasis)', () => {
    expect(isLoudKind('failure')).toBe(true);
    expect(isLoudKind('escalation')).toBe(true);
    expect(isLoudKind('question')).toBe(false);
    expect(isLoudKind('review')).toBe(false);
  });
});
