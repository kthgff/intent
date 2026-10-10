// @vitest-environment jsdom
/**
 * Board-item editing fixes —
 *  1. `board_item_updated` SSE refresh hints never become toasts —
 *     they carry no `subject` (D52: re-read hints, not user-facing
 *     notification rows).
 *  2. `editFieldOf` picks the persisted field backing the node's
 *     displayed text so the canvas editor never forks a hidden
 *     sibling field (a body-only captured sticky edits `body`).
 *  3. The inspector exposes editable Title/Body fields committing
 *     through the fenced `onPatch`.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BoardItem } from '@veto/core';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardInspector } from '../src/board-canvas/Inspector';
import type { CanvasNode } from '../src/board-canvas/model';
import { editFieldOf } from '../src/board-canvas/nodes';
import { notificationToastText } from '../src/sse';

vi.mock('../src/api', () => ({
  client: {
    decideStatement: vi.fn(),
    correctStatement: vi.fn(),
  },
}));

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

const data = (i: BoardItem) => ({ item: i }) as CanvasNode['data'];

describe('notificationToastText', () => {
  it('returns null for board_item_updated refresh hints', () => {
    expect(
      notificationToastText({
        kind: 'board_item_updated',
        workspace: 'ws',
        item_id: 'i1',
        board: 'ideas',
      }),
    ).toBeNull();
    // board-assistant's itemsTouched emits the same kind without
    // item_id.
    expect(
      notificationToastText({
        kind: 'board_item_updated',
        workspace: 'ws',
        board: 'ideas',
      }),
    ).toBeNull();
  });

  it('formats durable notification rows for toasting', () => {
    expect(
      notificationToastText({
        workspace: 'ws',
        subject: 'cs-123',
        kind: 'changes_applied',
        created_at: '2026-10-05T00:00:00Z',
      }),
    ).toBe('changes_applied: cs-123');
  });
});

describe('editFieldOf', () => {
  it('edits body on a body-only note (display falls back to body)', () => {
    const i = item({ id: 'n1', body: 'captured text' });
    expect(editFieldOf(data(i), 'title')).toBe('body');
  });

  it('edits title when the note has one', () => {
    const i = item({ id: 'n2', title: 'My idea' });
    expect(editFieldOf(data(i), 'title')).toBe('title');
    // Title wins even when a body also exists — it is what renders.
    const both = item({ id: 'n3', title: 'T', body: 'B' });
    expect(editFieldOf(data(both), 'title')).toBe('title');
  });

  it('edits body on a fresh text node (title is the "" placeholder)', () => {
    const i = item({ id: 't1', kind: 'text', title: '', body: null });
    expect(editFieldOf(data(i), 'body')).toBe('body');
  });

  it('edits title on a title-only text node', () => {
    const i = item({ id: 't2', kind: 'text', title: 'heading', body: null });
    expect(editFieldOf(data(i), 'body')).toBe('title');
  });
});

const inspectorProps = (i: BoardItem, patch = vi.fn()) => ({
  surface: { item: i, statements: [] },
  busy: false,
  ws: 'ws',
  taxonomy: ['idea'],
  onPatch: patch,
  onClose: vi.fn(),
  onChanged: vi.fn(),
  onError: vi.fn(),
});

describe('BoardInspector text fields', () => {
  it('renders Title input and Body textarea seeded from the item', () => {
    render(
      <BoardInspector
        {...inspectorProps(item({ id: 'i1', title: 'Hello', body: 'World' }))}
      />,
    );
    expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Hello');
    expect(screen.getByLabelText('Body')).toHaveProperty('value', 'World');
  });

  it('commits an edited title on blur via onPatch', () => {
    const patch = vi.fn();
    render(<BoardInspector {...inspectorProps(item({ id: 'i2' }), patch)} />);
    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'New title' } });
    fireEvent.blur(title);
    expect(patch).toHaveBeenCalledWith({ title: 'New title' });
  });

  it('patches null when a field is cleared', () => {
    const patch = vi.fn();
    render(
      <BoardInspector
        {...inspectorProps(item({ id: 'i3', title: 'T' }), patch)}
      />,
    );
    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: '   ' } });
    fireEvent.blur(title);
    expect(patch).toHaveBeenCalledWith({ title: null });
  });

  it('commits an edited body and skips unchanged drafts', () => {
    const patch = vi.fn();
    render(
      <BoardInspector
        {...inspectorProps(item({ id: 'i4', body: 'old' }), patch)}
      />,
    );
    const body = screen.getByLabelText('Body');
    fireEvent.change(body, { target: { value: 'new body' } });
    fireEvent.blur(body);
    expect(patch).toHaveBeenCalledWith({ body: 'new body' });
    patch.mockClear();
    // Blurring with no edit issues no write.
    fireEvent.blur(screen.getByLabelText('Title'));
    expect(patch).not.toHaveBeenCalled();
  });

  it('commits on ⌘Enter inside the body textarea', () => {
    const patch = vi.fn();
    render(<BoardInspector {...inspectorProps(item({ id: 'i5' }), patch)} />);
    const body = screen.getByLabelText('Body');
    fireEvent.change(body, { target: { value: 'via keyboard' } });
    fireEvent.keyDown(body, { key: 'Enter', metaKey: true });
    expect(patch).toHaveBeenCalledWith({ body: 'via keyboard' });
  });

  it('disables the fields for locked items and hides them read-only', () => {
    render(
      <BoardInspector
        {...inspectorProps(item({ id: 'i6', status: 'frozen', title: 'T' }))}
      />,
    );
    expect(screen.getByLabelText('Title')).toHaveProperty('disabled', true);
    cleanup();
    render(
      <BoardInspector
        {...inspectorProps(item({ id: 'i7', body: 'B' }))}
        readOnly
      />,
    );
    expect(screen.queryByLabelText('Title')).toBeNull();
    // Read-only still shows the static body preview.
    expect(screen.getByText('B')).toBeTruthy();
  });
});
