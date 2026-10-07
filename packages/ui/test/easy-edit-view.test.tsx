// @vitest-environment jsdom
/**
 * Easy Edit view — component tests over stubbed route handlers.
 *
 * case:easy-edit-02 (sort/filter), case:easy-edit-03 (drawer write),
 * case:easy-edit-04 (locked), case:easy-edit-05 (tray section +
 * promote), case:easy-edit-06 (bulk batch + confirm), case:easy-edit-07
 * (create), case:easy-edit-08 (keyboard), case:easy-edit-10 (no
 * geometry in payloads).
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { BoardItem } from '@veto/core';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EasyEdit, { type EasyEditProps } from '../src/board-canvas/EasyEdit';

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

function props(over: Partial<EasyEditProps> = {}): EasyEditProps {
  return {
    surfaces: [
      surface(item({ id: 'i-1', title: 'Alpha' })),
      surface(item({ id: 'i-2', title: 'Beta', status: 'discarded' })),
      surface(item({ id: 'i-3', title: 'Locked', status: 'consumed' })),
    ],
    tray: [item({ id: 't-1', board: null, title: 'Tray item' })],
    ws: 'ws',
    board: 'ideas',
    taxonomy: ['idea', 'want'],
    patchItem: vi.fn(),
    mutate: vi.fn(async (ms: { id: string; patch: object }[]) =>
      ms.map((m) => ({
        ...item({ id: m.id }),
        ...m.patch,
        updated_at: '2026-10-10T00:00:00Z',
      })),
    ),
    promote: vi.fn(async () => {}),
    add: vi.fn(async () => item({ id: 'new-1', title: 'New' })),
    capture: vi.fn(async () => {}),
    notice: vi.fn(),
    busy: false,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('EasyEdit view', () => {
  it('renders board rows incl. discarded + a tray section — case:easy-edit-01', () => {
    render(<EasyEdit {...props()} />);
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText(/Capture tray/)).toBeTruthy();
    expect(screen.getByText('Tray item')).toBeTruthy();
  });

  it('searches and narrows rows — case:easy-edit-02', () => {
    render(<EasyEdit {...props()} />);
    fireEvent.change(screen.getByLabelText('Search items'), {
      target: { value: 'alpha' },
    });
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('pencil opens the drawer; a select change PATCHes once — case:easy-edit-03', async () => {
    const p = props();
    render(<EasyEdit {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }));
    const drawer = await screen.findByRole('dialog');
    expect(drawer).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Importance'), {
      target: { value: 'must' },
    });
    expect(p.patchItem).toHaveBeenCalledTimes(1);
    const [it, patch] = (p.patchItem as ReturnType<typeof vi.fn>).mock
      .calls[0] as [BoardItem, Record<string, unknown>];
    expect(it.id).toBe('i-1');
    expect(patch).toEqual({ importance: 'must' });
  });

  it('locked rows are read-only — no checkbox, lock icon — case:easy-edit-04', () => {
    render(<EasyEdit {...props()} />);
    expect(
      screen.getByLabelText('Select Locked').hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByLabelText('Locked — consumed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Locked' })).toBeNull();
  });

  it('tray rows promote with no geometry — case:easy-edit-05/10', async () => {
    const p = props();
    render(<EasyEdit {...p} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add Tray item to board' }),
    );
    await waitFor(() => expect(p.promote).toHaveBeenCalledTimes(1));
    const arg = (p.promote as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    // The row itself — geometry exclusion happens in the route handler's
    // patch (asserted on the bulk/create payloads below).
    expect(arg).toMatchObject({ id: 't-1', board: null });
  });

  it('bulk discard = one batch mutation per checked row — case:easy-edit-06/10', async () => {
    const p = props();
    render(<EasyEdit {...p} />);
    fireEvent.click(screen.getByLabelText('Select Alpha'));
    fireEvent.click(screen.getByLabelText('Select Beta'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(p.mutate).toHaveBeenCalledTimes(1));
    const mutations = (p.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      id: string;
      expected_updated_at: string;
      patch: object;
    }[];
    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.patch).toEqual({ status: 'discarded' });
    expect(mutations[0]?.expected_updated_at).toBe('2026-10-05T00:00:00Z');
    expect(JSON.stringify(mutations)).not.toMatch(/"[xywh]":|"z_index"|"zone"/);
  });

  it('≥10 selected asks before discard — case:easy-edit-06', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      surface(item({ id: `m-${i}`, title: `Item ${i}` })),
    );
    const p = props({ surfaces: many });
    render(<EasyEdit {...p} />);
    fireEvent.click(screen.getByLabelText('Select all visible items'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // The confirm dialog names the count; cancelling keeps everything.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Discard 12 items?');
    expect(p.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Confirming issues exactly one batch mutation for all 12 rows.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog2 = await screen.findByRole('dialog');
    fireEvent.click(within(dialog2).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(p.mutate).toHaveBeenCalledTimes(1));
    const mutations = (p.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { id: string }[];
    expect(mutations).toHaveLength(12);
  });

  it('+ New creates a positionless item — case:easy-edit-07/10', async () => {
    const p = props();
    render(<EasyEdit {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await waitFor(() => expect(p.add).toHaveBeenCalledTimes(1));
    expect(
      JSON.stringify((p.add as ReturnType<typeof vi.fn>).mock.calls[0]),
    ).not.toMatch(/"[xywh]":|"z_index"|"zone"/);
  });

  it('j focuses a row and Enter opens its drawer — case:easy-edit-08', async () => {
    render(<EasyEdit {...props()} />);
    fireEvent.keyDown(document.querySelector('.ee-root') as Element, {
      key: 'j',
    });
    fireEvent.keyDown(document.querySelector('.ee-root') as Element, {
      key: 'Enter',
    });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
