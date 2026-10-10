// @vitest-environment jsdom
/**
 * Easy Edit view — component tests over stubbed route handlers.
 *
 * case:easy-edit-02 (sort/filter), case:easy-edit-03 (item-page write),
 * case:easy-edit-04 (locked), case:easy-edit-05 (tray section +
 * promote), case:easy-edit-06 (bulk batch + confirm), case:easy-edit-07
 * (create), case:easy-edit-08 (keyboard), case:easy-edit-10 (no
 * geometry in payloads), case:easy-edit-11 (embedded capture form).
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
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '../src/api';
import EasyEdit, { type EasyEditProps } from '../src/board-canvas/EasyEdit';

// The embedded CaptureForm owns its own API calls — stub just the
// methods it touches; everything else keeps the real implementation.
// Implementations live in beforeEach: restoreAllMocks wipes them.
vi.mock('../src/api', async (importActual) => {
  const actual = await importActual<typeof import('../src/api')>();
  return {
    ...actual,
    client: {
      ...actual.client,
      ideaBoards: vi.fn(),
      capture: vi.fn(),
      addBoardItem: vi.fn(),
      patchBoardItem: vi.fn(),
    },
  };
});

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
    patchItem: vi.fn(async () => ({ ok: true, conflict: false })),
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
    refresh: vi.fn(),
    notice: vi.fn(),
    busy: false,
    editorId: null,
    boardName: 'Ideas',
    openEditor: vi.fn(),
    closeEditor: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  const c = client as unknown as {
    ideaBoards: ReturnType<typeof vi.fn>;
    capture: ReturnType<typeof vi.fn>;
    addBoardItem: ReturnType<typeof vi.fn>;
    patchBoardItem: ReturnType<typeof vi.fn>;
  };
  c.ideaBoards.mockResolvedValue({
    boards: [
      { workspace: 'ws', board: 'ideas', name: 'Ideas' },
      { workspace: 'ws', board: 'other', name: 'Other board' },
    ],
  });
  c.capture.mockResolvedValue({
    item: { id: 'cap-1', board: null, updated_at: '2026-10-10T00:00:00Z' },
  });
  c.addBoardItem.mockResolvedValue({
    item: { id: 'cap-2', board: 'ideas' },
  });
  c.patchBoardItem.mockImplementation(async (id: string) => ({
    item: { id },
  }));
});

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

  it('full-page editor changes a property with one PATCH — case:easy-edit-03', async () => {
    const p = props({ editorId: 'i-1' });
    render(<EasyEdit {...p} />);
    expect(screen.getByRole('main', { name: 'Item editor' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Back to Easy Edit' }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Importance'), {
      target: { value: 'must' },
    });
    await waitFor(() => expect(p.patchItem).toHaveBeenCalledTimes(1));
    const [it, patch] = (p.patchItem as ReturnType<typeof vi.fn>).mock
      .calls[0] as [BoardItem, Record<string, unknown>];
    expect(it.id).toBe('i-1');
    expect(patch).toEqual({ importance: 'must' });
  });

  it('locked rows open the same full page read-only — case:easy-edit-04', () => {
    render(<EasyEdit {...props({ editorId: 'i-3' })} />);
    expect(screen.getByRole('main', { name: 'Item editor' })).toBeTruthy();
    expect(screen.getByText(/read-only because it is consumed/i)).toBeTruthy();
    expect(
      (screen.getByLabelText('Item title') as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('locked list rows cannot be selected and use a lock affordance', () => {
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

  it('j focuses a row and Enter navigates to its editor — case:easy-edit-08', () => {
    const p = props();
    render(<EasyEdit {...p} />);
    fireEvent.keyDown(document.querySelector('.ee-root') as Element, {
      key: 'j',
    });
    fireEvent.keyDown(document.querySelector('.ee-root') as Element, {
      key: 'Enter',
    });
    expect(p.openEditor).toHaveBeenCalledWith(expect.any(String));
  });

  it('hosts the capture form scoped to this board — case:easy-edit-11', async () => {
    render(
      <MemoryRouter>
        <EasyEdit {...props()} />
      </MemoryRouter>,
    );
    // The compact affordance expands to the complete shared form and
    // the destination defaults to the
    // current board once the board list settles (never another
    // workspace's boards — the form refetches per workspace).
    fireEvent.click(screen.getByRole('button', { name: /Capture an idea/ }));
    expect(screen.getByLabelText('capture text')).toBeTruthy();
    await screen.findByRole('option', { name: 'Ideas' });
    expect((screen.getByLabelText('to') as HTMLSelectElement).value).toBe(
      'ideas',
    );
    // The collapse toggle hides the form without unmounting the view.
    fireEvent.click(screen.getByRole('button', { name: /Capture an idea/ }));
    expect(screen.queryByLabelText('capture text')).toBeNull();
  });

  it('board save posts addBoardItem with no geometry then refreshes — case:easy-edit-11/10', async () => {
    const p = props();
    render(
      <MemoryRouter>
        <EasyEdit {...p} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture an idea/ }));
    await screen.findByRole('option', { name: 'Ideas' });
    fireEvent.change(screen.getByLabelText('capture text'), {
      target: { value: 'Ship the thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.addBoardItem).toHaveBeenCalledTimes(1));
    const [slug, body] = (client.addBoardItem as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, Record<string, unknown>];
    expect(slug).toBe('ideas');
    expect(body).toMatchObject({
      workspace: 'ws',
      title: 'Ship the thing',
      note_kind: 'idea',
    });
    expect(JSON.stringify(body)).not.toMatch(/"[xywh]":|"z_index"|"zone"/);
    await waitFor(() => expect(p.refresh).toHaveBeenCalledTimes(1));
    expect(p.notice).toHaveBeenCalledWith('captured → ideas');
    // The save-banner link stays wired for cross-destination hops.
    expect(screen.getByRole('link', { name: /open destination/ })).toBeTruthy();
  });

  it('tray destination rides /capture + the OCC-fenced kind patch — case:easy-edit-11', async () => {
    const p = props();
    render(
      <MemoryRouter>
        <EasyEdit {...p} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture an idea/ }));
    fireEvent.change(screen.getByLabelText('capture text'), {
      target: { value: 'a stray thought' },
    });
    fireEvent.change(screen.getByLabelText('to'), {
      target: { value: 'tray' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.capture).toHaveBeenCalledTimes(1));
    expect(
      (client.capture as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    ).toMatchObject({ workspace: 'ws', title: 'a stray thought' });
    // note_kind lands via a fenced patch on the created item.
    await waitFor(() =>
      expect(client.patchBoardItem).toHaveBeenCalledWith(
        'cap-1',
        expect.objectContaining({
          expected_updated_at: '2026-10-10T00:00:00Z',
        }),
      ),
    );
    await waitFor(() => expect(p.refresh).toHaveBeenCalledTimes(1));
    expect(p.notice).toHaveBeenCalledWith('captured → tray');
  });

  it('editor is a dedicated surface with dictation-ready prose fields — case:easy-edit-12', () => {
    const p = props({ editorId: 'i-1' });
    render(<EasyEdit {...p} />);
    const editor = screen.getByRole('main', { name: 'Item editor' });
    expect(editor.querySelectorAll('.dict-field')).toHaveLength(2);
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Easy Edit' }));
    expect(p.closeEditor).toHaveBeenCalledTimes(1);
  });

  it('reports a failed OCC write as a review conflict — case:easy-edit-03', async () => {
    const p = props({
      editorId: 'i-1',
      patchItem: vi.fn(async () => ({ ok: false, conflict: true })),
    });
    render(<EasyEdit {...p} />);
    fireEvent.change(screen.getByLabelText('Importance'), {
      target: { value: 'must' },
    });
    expect(await screen.findByText('Review conflict')).toBeTruthy();
  });

  it('unknown deep links notice and fail closed to the list — case:easy-edit-12', async () => {
    const p = props({ editorId: 'missing' });
    render(<EasyEdit {...p} />);
    await waitFor(() => expect(p.closeEditor).toHaveBeenCalledTimes(1));
    expect(p.notice).toHaveBeenCalledWith(
      expect.stringMatching(/no longer available/i),
    );
  });

  it('restores focus to the originating row after the editor closes — case:easy-edit-12', async () => {
    const p = props({ editorId: 'i-1' });
    const view = render(<EasyEdit {...p} />);
    view.rerender(<EasyEdit {...p} editorId={null} />);
    await waitFor(() =>
      expect((document.activeElement as HTMLElement).dataset.rowId).toBe('i-1'),
    );
  });

  it('landing starts with compact capture and grouped item tools — case:easy-edit-13', () => {
    render(<EasyEdit {...props()} />);
    expect(screen.queryByLabelText('capture text')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Items' })).toBeTruthy();
    expect(screen.getByLabelText('Item tools')).toBeTruthy();
  });
});
