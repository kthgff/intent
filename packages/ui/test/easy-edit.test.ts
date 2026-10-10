/**
 * Easy Edit — pure-module tests for the row projection + Easy Edit
 * command fields (EASY-EDIT-TDD "Row contract").
 *
 * case:easy-edit-01 (discarded visible), case:easy-edit-02 (sort/
 * filter/search), case:easy-edit-06 (undo fields).
 */
import type { BoardItem } from '@veto/core';
import { describe, expect, it } from 'vitest';
import {
  EASY_EDIT_FIELDS,
  PATCHABLE_FIELDS,
  makeCommand,
} from '../src/board-canvas/history';
import {
  DEFAULT_FILTER,
  applyView,
  projectRows,
} from '../src/board-canvas/table';

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

describe('projectRows — case:easy-edit-01', () => {
  it('keeps discarded items and tags board/tray sections + locks', () => {
    const rows = projectRows(
      [
        surface(item({ id: 'a', status: 'discarded' })),
        surface(item({ id: 'b', status: 'consumed' })),
      ],
      [item({ id: 't-1', board: null })],
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.item.id === 'a')?.section).toBe('board');
    expect(rows.find((r) => r.item.id === 'b')?.locked).toBe(true);
    expect(rows.find((r) => r.item.id === 't-1')?.section).toBe('tray');
  });
});

describe('applyView — case:easy-edit-02', () => {
  const rows = projectRows(
    [
      surface(
        item({
          id: 'a',
          title: 'Zebra',
          note_kind: 'want',
          importance: 'must',
        }),
      ),
      surface(
        item({
          id: 'b',
          title: 'Apple',
          note_kind: 'idea',
          importance: 'nice',
        }),
      ),
      surface(item({ id: 'c', title: 'Mango', status: 'icebox' })),
    ],
    [item({ id: 't', board: null, title: 'Tray thing' })],
  );

  it('sorts by text ascending with id tiebreak', () => {
    const v = applyView(rows, DEFAULT_FILTER, 'text', 'asc');
    expect(v.map((r) => r.item.id)).toEqual(['b', 'c', 't', 'a']);
  });

  it('sorts by updated_at descending by default', () => {
    const newer = projectRows(
      [
        surface(item({ id: 'old', updated_at: '2026-10-01T00:00:00Z' })),
        surface(item({ id: 'new', updated_at: '2026-10-09T00:00:00Z' })),
      ],
      [],
    );
    const v = applyView(newer, DEFAULT_FILTER, 'updated_at', 'desc');
    expect(v[0]?.item.id).toBe('new');
  });

  it('filters by kind, note_kind, status, importance', () => {
    expect(
      applyView(rows, { ...DEFAULT_FILTER, note_kind: 'want' }, 'text', 'asc'),
    ).toHaveLength(1);
    expect(
      applyView(
        rows,
        { ...DEFAULT_FILTER, status: 'icebox' },
        'text',
        'asc',
      ).map((r) => r.item.id),
    ).toEqual(['c']);
    expect(
      applyView(
        rows,
        { ...DEFAULT_FILTER, importance: 'must' },
        'text',
        'asc',
      ).map((r) => r.item.id),
    ).toEqual(['a']);
  });

  it('searches title/body/ref case-insensitively', () => {
    const v = applyView(
      rows,
      { ...DEFAULT_FILTER, search: 'MANGO' },
      'text',
      'asc',
    );
    expect(v.map((r) => r.item.id)).toEqual(['c']);
  });

  it("kind:'tray' shows only tray; showTray:false hides it", () => {
    expect(
      applyView(rows, { ...DEFAULT_FILTER, kind: 'tray' }, 'text', 'asc').map(
        (r) => r.item.id,
      ),
    ).toEqual(['t']);
    expect(
      applyView(rows, { ...DEFAULT_FILTER, showTray: false }, 'text', 'asc'),
    ).toHaveLength(3);
  });

  it('kind filter does not leak into the tray section', () => {
    const v = applyView(
      rows,
      { ...DEFAULT_FILTER, kind: 'text' },
      'text',
      'asc',
    );
    expect(v.every((r) => r.item.kind === 'text')).toBe(true);
  });
});

describe('history — Easy Edit command fields (case:easy-edit-06)', () => {
  it('makeCommand records EASY_EDIT_FIELDS when passed', () => {
    const before = item({ id: 'a', note_kind: 'idea', importance: null });
    const after = item({ ...before, note_kind: 'want', importance: 'must' });
    const cmd = makeCommand('type → want', [before], [after], EASY_EDIT_FIELDS);
    expect(cmd.undo[0]?.patch.note_kind).toBe('idea');
    expect(cmd.redo[0]?.patch.note_kind).toBe('want');
    expect(cmd.redo[0]?.patch.importance).toBe('must');
  });

  it('default commands still record only the canvas field set', () => {
    const before = item({ id: 'a', note_kind: 'idea' });
    const after = item({ ...before, note_kind: 'want' });
    const cmd = makeCommand('x', [before], [after]);
    expect(cmd.redo[0]?.patch).not.toHaveProperty('note_kind');
    expect(PATCHABLE_FIELDS).not.toContain('note_kind');
  });
});
