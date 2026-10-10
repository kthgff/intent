/**
 * wp-144 tests — Board v2 (PRD §15.3).
 *
 * Real PostgresStore on PGlite; the board engine functions run
 * directly. Covers:
 *   - board types as config (one engine, per-type capabilities);
 *   - typed sticky notes (closed taxonomy, fail-closed);
 *   - board lifecycle + deferred boards resurfacing as proposals;
 *   - multiple boards + org-level boards with spawn provenance;
 *   - the board → statements extraction handoff (source_ref links back
 *     to the card) and statement-derived board surfaces;
 *   - referencing approved items never mutates them (ChangeSet path).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardItem } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOARD_TYPE_CONFIG,
  BoardError,
  acceptResurface,
  archiveBoard,
  boardSupports,
  boardSurface,
  boardTypeConfig,
  changeRequestForApprovedItem,
  createBoard,
  createTypedNote,
  deferBoard,
  deferNote,
  extractBoard,
  getSpawnProvenance,
  listOrgBoards,
  listWorkspaceBoards,
  promoteTrayItem,
  proposeResurface,
  referenceApprovedItem,
  setBoardStatus,
  setNoteStatus,
  spawnWorkspaceFromBoard,
  statementsForItem,
} from '../src/semantics/index.js';
import type { StatementActor } from '../src/semantics/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let store: PostgresStore;
let clock: number;

const human: StatementActor = { id: 'keith', type: 'human' };
const agent: StatementActor = { id: 'board-agent', type: 'agent' };
const now = () => new Date(clock);
const tick = (ms = 60_000) => {
  clock += ms;
};

beforeEach(async () => {
  store = await PostgresStore.connect('pglite:');
  clock = T0;
});

afterEach(async () => {
  await store.close();
});

// A fully-formed board item — tests that need deterministic ordering
// seed rows directly (listBoardItems orders by id).
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

// ---------------------------------------------------------------------------
// board types as config
// ---------------------------------------------------------------------------

describe('board types as config', () => {
  it('configures every board type (one engine, per-type config)', () => {
    for (const type of Object.keys(BOARD_TYPE_CONFIG)) {
      const cfg = boardTypeConfig(type as keyof typeof BOARD_TYPE_CONFIG);
      expect(cfg.board_type).toBe(type);
      expect(cfg.inputs.length).toBeGreaterThan(0);
      expect(cfg.capabilities.length).toBeGreaterThan(0);
      expect(cfg.outputs.length).toBeGreaterThan(0);
    }
  });

  it('defaults an unset type to exploration (never config-less)', () => {
    expect(boardTypeConfig(null).board_type).toBe('exploration');
    expect(boardTypeConfig(undefined).board_type).toBe('exploration');
  });

  it('capabilities differ per type — not one pipeline', () => {
    expect(boardSupports('release-planning', 'release-plan')).toBe(true);
    expect(boardSupports('import', 'release-plan')).toBe(false);
    expect(boardSupports('feedback', 'resurface')).toBe(true);
    expect(boardSupports('new-project', 'resurface')).toBe(false);
    // Enhancement changes arrive as ChangeSets.
    expect(boardTypeConfig('enhancement').approval).toBe(
      'human-gate+changeset',
    );
  });
});

// ---------------------------------------------------------------------------
// typed notes
// ---------------------------------------------------------------------------

describe('typed sticky notes', () => {
  it('creates a typed note with the full taxonomy', async () => {
    const note = await createTypedNote(store, {
      workspace: WS,
      board: 'ideas',
      note_kind: 'constraint',
      topic: 'auth',
      importance: 'must',
      applies_to: ['SR-0001'],
      note_status: 'open',
      rationale: 'SSO is required by the customer',
      title: 'SSO must be optional',
      actor: human,
      now,
    });
    expect(note.note_kind).toBe('constraint');
    expect(note.importance).toBe('must');
    expect(note.applies_to).toEqual(['SR-0001']);
    expect(note.note_status).toBe('open');
    expect(note.provenance).toBe('stakeholder-verified');
    const read = await store.getBoardItem(note.id);
    expect(read?.note_kind).toBe('constraint');
  });

  it('is fail-closed on an unknown note_kind / importance / status', async () => {
    await expect(
      createTypedNote(store, {
        workspace: WS,
        board: 'ideas',
        note_kind: 'vibe' as never,
        actor: human,
        now,
      }),
    ).rejects.toThrow(BoardError);
    await expect(
      createTypedNote(store, {
        workspace: WS,
        board: 'ideas',
        importance: 'urgent' as never,
        actor: human,
        now,
      }),
    ).rejects.toThrow(BoardError);
    await expect(
      createTypedNote(store, {
        workspace: WS,
        board: 'ideas',
        note_status: 'dead' as never,
        actor: human,
        now,
      }),
    ).rejects.toThrow(BoardError);
  });

  it('defer / resurface a note without losing it', async () => {
    const note = await createTypedNote(store, {
      workspace: WS,
      board: 'ideas',
      title: 'Maybe later',
      actor: human,
      now,
    });
    tick();
    const deferred = await deferNote(store, { id: note.id, actor: human, now });
    expect(deferred.note_status).toBe('deferred');
    tick();
    const back = await setNoteStatus(store, {
      id: note.id,
      note_status: 'resurfaced',
      actor: human,
      now,
    });
    expect(back.note_status).toBe('resurfaced');
    expect((await store.getBoardItem(note.id))?.title).toBe('Maybe later');
  });

  it('promotes a capture-tray card onto a board', async () => {
    const tray = await createTypedNote(store, {
      workspace: WS,
      board: null,
      note_kind: 'feedback',
      title: 'tray item',
      actor: human,
      now,
    });
    expect(tray.board).toBeNull();
    const promoted = await promoteTrayItem(store, {
      id: tray.id,
      board: 'ideas',
      actor: human,
      now,
    });
    expect(promoted.board).toBe('ideas');
    await expect(
      promoteTrayItem(store, {
        id: tray.id,
        board: 'ideas',
        actor: human,
        now,
      }),
    ).rejects.toThrow(/already on board/);
  });
});

// ---------------------------------------------------------------------------
// board lifecycle
// ---------------------------------------------------------------------------

describe('board lifecycle', () => {
  it('creates a board with validated type + status', async () => {
    const b = await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      name: 'Q1 ideas',
      board_type: 'new-project',
      status: 'discovery',
      actor: human,
      now,
    });
    expect(b.board_type).toBe('new-project');
    expect(b.status).toBe('discovery');

    await expect(
      createBoard(store, {
        workspace: WS,
        board: 'bad',
        board_type: 'pipeline' as never,
        actor: human,
        now,
      }),
    ).rejects.toThrow(BoardError);
    await expect(
      createBoard(store, {
        workspace: WS,
        board: 'bad',
        status: 'maybe' as never,
        actor: human,
        now,
      }),
    ).rejects.toThrow(BoardError);
  });

  it('moves through statuses and archives', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      board_type: 'exploration',
      actor: human,
      now,
    });
    await setBoardStatus(store, {
      workspace: WS,
      board: 'ideas',
      status: 'proposal-ready',
      actor: human,
      now,
    });
    expect((await store.getBoard(WS, 'ideas'))?.status).toBe('proposal-ready');
    await archiveBoard(store, {
      workspace: WS,
      board: 'ideas',
      actor: human,
      now,
    });
    expect((await store.getBoard(WS, 'ideas'))?.status).toBe('archived');
  });

  it('records a status_changed audit event with the actor — none on a no-op', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      board_type: 'exploration',
      actor: human,
      now,
    });
    await setBoardStatus(store, {
      workspace: WS,
      board: 'ideas',
      status: 'approved',
      actor: human,
      now,
    });
    const events = await store.listEvents({
      workspace: WS,
      event: 'status_changed',
    });
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBe('keith');
    expect(events[0].refs).toEqual(['board:ideas']);
    expect(events[0].data).toMatchObject({
      kind: 'board-status',
      board: 'ideas',
      from: 'draft',
      to: 'approved',
    });
    // A no-op transition writes no audit row.
    await setBoardStatus(store, {
      workspace: WS,
      board: 'ideas',
      status: 'approved',
      actor: agent,
      now,
    });
    expect(
      await store.listEvents({ workspace: WS, event: 'status_changed' }),
    ).toHaveLength(1);
  });

  it('deferred boards resurface as proposals — AI proposes, humans accept', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      board_type: 'enhancement',
      status: 'discovery',
      actor: human,
      now,
    });
    await store.upsertBoardItem(
      item({ id: 'a1', board: 'ideas', title: 'Cheap now' }),
    );
    await deferBoard(store, {
      workspace: WS,
      board: 'ideas',
      actor: human,
      now,
    });

    // A live board can't resurface.
    await createBoard(store, {
      workspace: WS,
      board: 'other',
      actor: human,
      now,
    });
    await expect(
      proposeResurface(store, {
        workspace: WS,
        board: 'other',
        reason: 'x',
        actor: agent,
      }),
    ).rejects.toThrow(/only deferred/);

    const proposal = await proposeResurface(store, {
      workspace: WS,
      board: 'ideas',
      reason: 'an existing component makes this cheap now',
      actor: agent,
    });
    expect(proposal.requires_approval).toBe(true);
    expect(proposal.proposed_by).toBe('agent');
    expect(proposal.retained_items).toBe(1);
    expect(proposal.board_type).toBe('enhancement');
    // Read-only — still deferred.
    expect((await store.getBoard(WS, 'ideas'))?.status).toBe('deferred');

    await expect(
      acceptResurface(store, {
        workspace: WS,
        board: 'ideas',
        actor: agent,
        now,
      }),
    ).rejects.toThrow(/human/);
    await acceptResurface(store, {
      workspace: WS,
      board: 'ideas',
      actor: human,
      now,
    });
    expect((await store.getBoard(WS, 'ideas'))?.status).toBe('discovery');
  });
});

// ---------------------------------------------------------------------------
// multi-board + org-level boards + spawn provenance
// ---------------------------------------------------------------------------

describe('multiple + org-level boards', () => {
  it('lists workspace boards and separates org-level boards', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      board_type: 'new-project',
      actor: human,
      now,
    });
    await createBoard(store, {
      workspace: WS,
      board: 'org-inbox',
      board_type: 'exploration',
      org: 'acme',
      actor: human,
      now,
    });
    expect((await listWorkspaceBoards(store, WS)).length).toBe(2);
    const org = await listOrgBoards(store, WS);
    expect(org.map((b) => b.board)).toEqual(['org-inbox']);
  });

  it('an org board spawns a workspace and keeps provenance', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'org-inbox',
      name: 'Org inbox',
      board_type: 'new-project',
      org: 'acme',
      actor: human,
      now,
    });
    const spawned = await spawnWorkspaceFromBoard(store, {
      originWorkspace: WS,
      originBoard: 'org-inbox',
      newWorkspace: 'myapp',
      actor: human,
      now,
    });
    expect(spawned.workspace).toBe('myapp');
    expect(spawned.board.board_type).toBe('new-project');
    expect(spawned.provenance.ref).toBe('board:ws/org-inbox');
    // The new project row exists.
    expect(await store.getProject('myapp')).not.toBeNull();

    const provenance = await getSpawnProvenance(store, {
      workspace: 'myapp',
      board: 'main',
    });
    expect(provenance?.ref).toBe('board:ws/org-inbox');
    const body = JSON.parse(provenance?.body ?? '{}');
    expect(body.origin_board).toBe('org-inbox');
    expect(body.spawned_workspace).toBe('myapp');

    await expect(
      spawnWorkspaceFromBoard(store, {
        originWorkspace: WS,
        originBoard: 'nope',
        newWorkspace: 'x',
        actor: human,
        now,
      }),
    ).rejects.toThrow(/no boards row/);
  });
});

// ---------------------------------------------------------------------------
// board → statements handoff + statement-derived surfaces
// ---------------------------------------------------------------------------

describe('board → statements handoff', () => {
  async function seedBoard() {
    await createBoard(store, {
      workspace: WS,
      board: 'ideas',
      board_type: 'new-project',
      actor: human,
      now,
    });
    await store.upsertBoardItem(
      item({
        id: 'a1',
        board: 'ideas',
        title: 'Password resets take 3 days',
        body: 'We must cut that to under an hour.',
      }),
    );
    await store.upsertBoardItem(
      item({
        id: 'a2',
        board: 'ideas',
        title: 'Admins need an audit log',
        note_kind: 'want',
      }),
    );
    await store.upsertBoardItem(
      item({
        id: 'a3',
        board: 'ideas',
        title: 'discarded idea',
        status: 'discarded',
      }),
    );
  }

  const statementsJson = JSON.stringify({
    schema: 1,
    statements: [
      {
        key: 'problem',
        text: 'Password resets take 3 days',
        source: 0,
        source_text: 'Password resets take 3 days',
        intent: 'problem',
      },
      {
        key: 'requirement',
        text: 'Resets complete in under an hour',
        source: 0,
        source_text: 'We must cut that to under an hour.',
        intent: 'requires',
      },
      {
        key: 'want',
        text: 'Admins need an audit log',
        source: 1,
        source_text: 'Admins need an audit log',
        intent: 'want',
      },
    ],
  });

  it('extracts statements and links each back to its card', async () => {
    await seedBoard();
    const res = await extractBoard(store, {
      workspace: WS,
      board: 'ideas',
      extract: async () => statementsJson,
      actor: 'extractor',
      now,
    });
    // a3 is discarded — excluded from evidence.
    expect(res.itemIds).toEqual(['a1', 'a2']);
    expect(res.statements).toHaveLength(3);
    expect(res.byItem.a1).toHaveLength(2);
    expect(res.byItem.a2).toHaveLength(1);

    const forA1 = await statementsForItem(store, {
      workspace: WS,
      itemId: 'a1',
    });
    expect(forA1.map((s) => s.intent).sort()).toEqual(['problem', 'requires']);
    expect(forA1[0]?.source_ref).toMatchObject({
      kind: 'board-item',
      id: 'a1',
    });
  });

  it('fails closed when there is nothing to extract', async () => {
    await createBoard(store, {
      workspace: WS,
      board: 'empty',
      actor: human,
      now,
    });
    await expect(
      extractBoard(store, {
        workspace: WS,
        board: 'empty',
        extract: async () => statementsJson,
        actor: 'extractor',
        now,
      }),
    ).rejects.toThrow(/no extractable items/);
  });

  it('boardSurface shows the statements derived from each card', async () => {
    await seedBoard();
    await extractBoard(store, {
      workspace: WS,
      board: 'ideas',
      extract: async () => statementsJson,
      actor: 'extractor',
      now,
    });
    const surface = await boardSurface(store, {
      workspace: WS,
      board: 'ideas',
    });
    const a1 = surface.find((s) => s.item.id === 'a1');
    const a2 = surface.find((s) => s.item.id === 'a2');
    const a3 = surface.find((s) => s.item.id === 'a3');
    expect(a1?.statements).toHaveLength(2);
    expect(a2?.statements).toHaveLength(1);
    expect(a3?.statements).toHaveLength(0);
  });

  it('restricts extraction to the requested items', async () => {
    await seedBoard();
    const res = await extractBoard(store, {
      workspace: WS,
      board: 'ideas',
      itemIds: ['a2'],
      extract: async () =>
        JSON.stringify({
          schema: 1,
          statements: [
            {
              key: 'want',
              text: 'Admins need an audit log',
              source: 0,
              source_text: 'Admins need an audit log',
            },
          ],
        }),
      actor: 'extractor',
      now,
    });
    expect(res.itemIds).toEqual(['a2']);
    expect(res.byItem.a1).toBeUndefined();
    expect(res.byItem.a2).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// referencing approved items — never mutate (ChangeSet path)
// ---------------------------------------------------------------------------

describe('referencing approved items', () => {
  async function seedApproved() {
    await createBoard(store, {
      workspace: WS,
      board: 'enhance',
      board_type: 'enhancement',
      actor: human,
      now,
    });
    await store.upsertProject({ workspace: WS });
    await store.appendDocVersion(
      { workspace: WS, subject: 'I-0001', doc: 'rs.md' },
      '# RS v1',
      'human',
    );
  }

  it('a reference card pins the approved version without a doc write', async () => {
    await seedApproved();
    const ref = await referenceApprovedItem(store, {
      workspace: WS,
      board: 'enhance',
      subject: 'I-0001',
      doc: 'rs.md',
      actor: human,
      now,
    });
    expect(ref.baseline).toEqual({
      subject: 'I-0001',
      doc: 'rs.md',
      version: 1,
    });
    expect(ref.item.ref).toBe('I-0001:rs.md@v1');
    // Read-only — still exactly one version of rs.md.
    expect(
      await store.listDocVersions({
        workspace: WS,
        subject: 'I-0001',
        doc: 'rs.md',
      }),
    ).toHaveLength(1);
  });

  it('a change to an approved item arrives as a ChangeSet', async () => {
    await seedApproved();
    const cs = await changeRequestForApprovedItem(store, {
      workspace: WS,
      board: 'enhance',
      subject: 'I-0001',
      doc: 'rs.md',
      request: 'SSO must be optional for admins',
      actor: human,
      now,
    });
    expect(cs.changeset_id).toMatch(/^CS-\d{4}$/);
    expect(cs.baseline).toMatchObject({
      subject: 'I-0001',
      doc: 'rs.md',
      version: 1,
    });
    expect(cs.status).toBe('draft');
    // The board never mutated the approved doc.
    expect(
      await store.listDocVersions({
        workspace: WS,
        subject: 'I-0001',
        doc: 'rs.md',
      }),
    ).toHaveLength(1);
  });
});
