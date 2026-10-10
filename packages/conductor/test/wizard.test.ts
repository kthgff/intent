/**
 * wp-163 tests — Board wizard catalog (BOARD-CHAT-TDD "Board wizard
 * configs").
 *
 * Real PostgresStore on PGlite; the engine functions run directly.
 * Covers:
 *   - one versioned wizard per BOARD_TYPES value + board-generic
 *     (NULL board_type), seeded lazily + idempotently;
 *   - the shared slot shape (required goals/problems/wants/constraints,
 *     optional avoids/open-questions/decisions) + per-type extras;
 *   - goals-first: goals is the highest-impact required slot and the
 *     planner asks it first;
 *   - seedBoardSlots coverage — goals via the serves-target rule (D33,
 *     no `goal` note_kind), every other slot via note_kind presence;
 *     missing → inferred only;
 *   - wizard version pinning — an in-flight session keeps its version.
 */
import { BOARD_TYPES, type BoardItem } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOARD_WIZARDS,
  InterviewError,
  boardSlotCoverage,
  boardWizardId,
  goalItemIds,
  isGoalItem,
  listSlots,
  loadWizardConfig,
  markSlot,
  parseWizardConfig,
  planNextQuestion,
  registerWizard,
  seedBoardSlots,
  seedBoardWizards,
  sessionWizard,
  startSession,
} from '../src/interview/index.js';
import type { InterviewCtx } from '../src/interview/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-07T00:00:00Z');

let store: PostgresStore;
let clock: number;

function ctx(): InterviewCtx {
  return {
    store,
    workspace: WS,
    actor: 'keith',
    now: () => new Date(clock),
  };
}

beforeEach(async () => {
  store = await PostgresStore.connect('pglite:');
  clock = T0;
});

afterEach(async () => {
  await store.close();
});

/** A fully-formed board item on board 'ideas'. */
function item(over: Partial<BoardItem> & Pick<BoardItem, 'id'>): BoardItem {
  return {
    workspace: WS,
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
    note_kind: null,
    topic: null,
    importance: null,
    applies_to: null,
    note_status: 'open',
    rationale: null,
    provenance: 'stakeholder-verified',
    created_at: new Date(T0).toISOString(),
    updated_at: new Date(T0).toISOString(),
    ...over,
  };
}

async function slotState(sessionId: string, slot: string) {
  const rows = await listSlots(ctx(), sessionId);
  return rows.find((r) => r.slot === slot)?.state;
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

describe('board wizard catalog', () => {
  it('registers one versioned wizard per BOARD_TYPES value + board-generic', async () => {
    const c = ctx();
    const first = await seedBoardWizards(c);
    const ids = first.map((r) => r.version.wizard_id).sort();
    expect(ids).toEqual(
      [...BOARD_TYPES.map((t) => `board-${t}`), 'board-generic'].sort(),
    );
    for (const t of BOARD_TYPES) {
      const cfg = await loadWizardConfig(c, boardWizardId(t));
      expect(cfg.version).toBe(1);
    }
    expect(boardWizardId(null)).toBe('board-generic');
    expect(boardWizardId(undefined)).toBe('board-generic');
    const generic = await loadWizardConfig(c, 'board-generic');
    expect(generic.wizard_id).toBe('board-generic');
  });

  it('seeds lazily + idempotently — re-seeding creates nothing', async () => {
    const c = ctx();
    await seedBoardWizards(c);
    const again = await seedBoardWizards(c);
    expect(again.every((r) => r.created === false)).toBe(true);
  });

  it('shares the slot shape — goals required + first + impact 1.0', () => {
    for (const cfg of BOARD_WIZARDS) {
      expect(() => parseWizardConfig(cfg)).not.toThrow();
      const bySlot = new Map(cfg.slots.map((s) => [s.slot, s]));
      expect(cfg.slots[0]?.slot).toBe('goals');
      const goals = bySlot.get('goals');
      expect(goals?.required).toBe(true);
      expect(goals?.impact).toBe(1);
      expect(goals?.accepts).toEqual(['want', 'requires']);
      for (const name of ['problems', 'wants', 'constraints']) {
        expect(bySlot.get(name)?.required).toBe(true);
      }
      for (const name of ['avoids', 'open-questions', 'decisions']) {
        expect(bySlot.get(name)?.required).not.toBe(true);
      }
      expect(bySlot.get('problems')?.accepts).toEqual([
        'problem',
        'observation',
      ]);
      expect(bySlot.get('constraints')?.accepts).toEqual([
        'constraint',
        'prohibits',
      ]);
    }
  });

  it('puts the per-type extras on the right wizards only', () => {
    const extraNames = new Set([
      'themes',
      'severity',
      'source-fidelity',
      'targets',
      'cut-criteria',
    ]);
    const expected: Record<string, string[]> = {
      'board-feedback': ['severity', 'themes'],
      'board-import': ['source-fidelity'],
      'board-release-planning': ['cut-criteria', 'targets'],
    };
    for (const cfg of BOARD_WIZARDS) {
      const extras = cfg.slots
        .map((s) => s.slot)
        .filter((s) => extraNames.has(s))
        .sort();
      expect(extras).toEqual(expected[cfg.wizard_id] ?? []);
      for (const s of cfg.slots.filter((s) => extraNames.has(s.slot))) {
        expect(s.required).toBe(true);
      }
    }
  });

  it('pins the wizard version an in-flight session started on', async () => {
    const c = ctx();
    await seedBoardWizards(c);
    const session = await startSession(c, {
      wizardId: 'board-generic',
      subject: 'board:ideas',
    });
    expect(session.wizard_version).toBe(1);
    await registerWizard(c, {
      wizard_id: 'board-generic',
      version: 2,
      slots: [{ slot: 'goals', required: true }],
    });
    const cfg = await sessionWizard(c, session);
    expect(cfg.version).toBe(1);
    expect(cfg.slots.map((s) => s.slot)).toContain('problems');
  });
});

// ---------------------------------------------------------------------------
// coverage seeding
// ---------------------------------------------------------------------------

describe('goal derivation (D33)', () => {
  it('goal-ness = being a serves target — no goal note_kind', () => {
    const items = [
      item({ id: 'bi-goal' }),
      item({ id: 'bi-a', serves: ['bi-goal'] }),
      item({ id: 'bi-b', serves: ['bi-goal', 'bi-dangling'] }),
    ];
    expect(goalItemIds(items)).toEqual(new Set(['bi-goal']));
    expect(isGoalItem('bi-goal', items)).toBe(true);
    expect(isGoalItem('bi-a', items)).toBe(false);
    expect(isGoalItem('bi-dangling', items)).toBe(false);
  });
});

describe('seedBoardSlots', () => {
  async function boardSession(
    wizardId = 'board-generic',
    subject: string | null = 'board:ideas',
  ) {
    const c = ctx();
    await seedBoardWizards(c);
    return startSession(c, { wizardId, subject });
  }

  it('leaves every required slot missing on an empty board', async () => {
    const c = ctx();
    const session = await boardSession();
    const seeded = await seedBoardSlots(c, { sessionId: session.session_id });
    expect(seeded).toEqual([]);
    for (const s of ['goals', 'problems', 'wants', 'constraints']) {
      expect(await slotState(session.session_id, s)).toBe('missing');
    }
  });

  it('marks goals inferred when ≥1 item is a serves target', async () => {
    const c = ctx();
    const session = await boardSession();
    await store.upsertBoardItem(item({ id: 'bi-goal', kind: 'idea' }));
    await store.upsertBoardItem(
      item({ id: 'bi-a', kind: 'idea', serves: ['bi-goal'] }),
    );
    const seeded = await seedBoardSlots(c, { sessionId: session.session_id });
    expect(seeded.map((r) => r.slot)).toEqual(['goals']);
    expect(await slotState(session.session_id, 'goals')).toBe('inferred');
    expect(await slotState(session.session_id, 'problems')).toBe('missing');
  });

  it('ignores serves targets that are not on the board', async () => {
    const c = ctx();
    const session = await boardSession();
    await store.upsertBoardItem(item({ id: 'bi-a', serves: ['bi-elsewhere'] }));
    const seeded = await seedBoardSlots(c, { sessionId: session.session_id });
    expect(seeded).toEqual([]);
    expect(await slotState(session.session_id, 'goals')).toBe('missing');
  });

  it('covers the other slots by note_kind presence', async () => {
    const c = ctx();
    const session = await boardSession();
    await store.upsertBoardItem(item({ id: 'bi-p', note_kind: 'problem' }));
    await store.upsertBoardItem(item({ id: 'bi-c', note_kind: 'constraint' }));
    const seeded = await seedBoardSlots(c, { sessionId: session.session_id });
    expect(seeded.map((r) => r.slot).sort()).toEqual([
      'constraints',
      'problems',
    ]);
    expect(await slotState(session.session_id, 'problems')).toBe('inferred');
    expect(await slotState(session.session_id, 'constraints')).toBe('inferred');
    expect(await slotState(session.session_id, 'goals')).toBe('missing');
    expect(await slotState(session.session_id, 'wants')).toBe('missing');
  });

  it('only upgrades missing → inferred — user-set and optional states stand', async () => {
    const c = ctx();
    const session = await boardSession();
    await markSlot(c, {
      sessionId: session.session_id,
      slot: 'wants',
      state: 'deferred',
    });
    await store.upsertBoardItem(item({ id: 'bi-w', note_kind: 'want' }));
    await store.upsertBoardItem(item({ id: 'bi-d', note_kind: 'decision' }));
    const seeded = await seedBoardSlots(c, { sessionId: session.session_id });
    expect(seeded).toEqual([]);
    expect(await slotState(session.session_id, 'wants')).toBe('deferred');
    // `decisions` is optional — it starts not-applicable, never missing.
    expect(await slotState(session.session_id, 'decisions')).toBe(
      'not-applicable',
    );
  });

  it('discarded items cover nothing', async () => {
    const c = ctx();
    const session = await boardSession();
    await store.upsertBoardItem(
      item({ id: 'bi-p', note_kind: 'problem', status: 'discarded' }),
    );
    const seeded = await seedBoardSlots(c, { sessionId: session.session_id });
    expect(seeded).toEqual([]);
    expect(await slotState(session.session_id, 'problems')).toBe('missing');
  });

  it('is idempotent — a second seed upgrades nothing', async () => {
    const c = ctx();
    const session = await boardSession();
    await store.upsertBoardItem(item({ id: 'bi-p', note_kind: 'problem' }));
    const first = await seedBoardSlots(c, { sessionId: session.session_id });
    expect(first.map((r) => r.slot)).toEqual(['problems']);
    const second = await seedBoardSlots(c, { sessionId: session.session_id });
    expect(second).toEqual([]);
  });

  it('takes an explicit board when the session has no board:<slug> subject', async () => {
    const c = ctx();
    const session = await boardSession('board-generic', null);
    await store.upsertBoardItem(item({ id: 'bi-w', note_kind: 'want' }));
    const seeded = await seedBoardSlots(c, {
      sessionId: session.session_id,
      board: 'ideas',
    });
    expect(seeded.map((r) => r.slot)).toEqual(['wants']);
  });

  it('fails closed — unknown session 404s, missing board errors', async () => {
    const c = ctx();
    await expect(
      seedBoardSlots(c, { sessionId: 'iv-nope' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    const session = await boardSession('board-generic', null);
    await expect(
      seedBoardSlots(c, { sessionId: session.session_id }),
    ).rejects.toBeInstanceOf(InterviewError);
  });
});

// ---------------------------------------------------------------------------
// goals-first planning on seeded coverage
// ---------------------------------------------------------------------------

describe('goals-first planning', () => {
  it('asks goals first on an empty board (highest impact)', async () => {
    const c = ctx();
    await seedBoardWizards(c);
    const session = await startSession(c, {
      wizardId: 'board-generic',
      subject: 'board:ideas',
    });
    const q = await planNextQuestion(c, { sessionId: session.session_id });
    expect(q?.slot).toBe('goals');
  });

  it('skips a covered goals slot — the run pursues the next missing required slot', async () => {
    const c = ctx();
    await seedBoardWizards(c);
    const session = await startSession(c, {
      wizardId: 'board-feedback',
      subject: 'board:ideas',
    });
    await store.upsertBoardItem(item({ id: 'bi-goal', kind: 'idea' }));
    await store.upsertBoardItem(
      item({ id: 'bi-a', kind: 'idea', serves: ['bi-goal'] }),
    );
    await store.upsertBoardItem(item({ id: 'bi-p', note_kind: 'problem' }));
    await seedBoardSlots(c, { sessionId: session.session_id });
    const q = await planNextQuestion(c, { sessionId: session.session_id });
    expect(q?.slot).toBe('wants');
  });
});

// ---------------------------------------------------------------------------
// pure coverage helper
// ---------------------------------------------------------------------------

describe('boardSlotCoverage', () => {
  it('maps the full slot set', () => {
    const items = [
      item({ id: 'bi-goal' }),
      item({ id: 'bi-a', serves: ['bi-goal'] }),
      item({ id: 'bi-p', note_kind: 'problem' }),
      item({ id: 'bi-w', note_kind: 'want' }),
      item({ id: 'bi-c', note_kind: 'constraint' }),
      item({ id: 'bi-av', note_kind: 'avoid' }),
      item({ id: 'bi-q', note_kind: 'question' }),
      item({ id: 'bi-d', note_kind: 'decision' }),
    ];
    expect(boardSlotCoverage(items)).toEqual(
      new Set([
        'goals',
        'problems',
        'wants',
        'constraints',
        'avoids',
        'open-questions',
        'decisions',
      ]),
    );
  });
});
