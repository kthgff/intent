// @vitest-environment jsdom
/**
 * s-16 idea board route — flag gating + coordinator behavior.
 *
 * case:canvas-theme/flag rollout: `ui.idea_canvas_v2` decides canvas vs
 * classic grouped view. BoardCanvas is stubbed (React Flow internals
 * aren't under test here — its units are covered in
 * board-canvas.test.ts / board-canvas-chrome.test.tsx).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { BoardItem } from '@veto/core';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IdeaBoard from '../src/screens/IdeaBoard';

// SSE singleton would construct EventSource (absent in jsdom).
vi.mock('../src/sse', () => ({ subscribeStream: () => () => {} }));
// React Flow internals aren't under test — record props instead.
const canvasSpy = vi.fn();
vi.mock('../src/board-canvas/BoardCanvas', () => ({
  default: (props: Record<string, unknown>) => {
    canvasSpy(props);
    return <div data-testid="board-canvas" />;
  },
}));
const easyEditSpy = vi.fn();
vi.mock('../src/board-canvas/EasyEdit', () => ({
  default: (props: Record<string, unknown>) => {
    easyEditSpy(props);
    return <div data-testid="easy-edit" />;
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  canvasSpy.mockClear();
  easyEditSpy.mockClear();
});

// jsdom lacks matchMedia — useNarrowScreen() needs it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }),
});

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
  zone: 'discovery',
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

function mockFetch(canvasV2: boolean) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/api/v1/settings')) {
      return json({ config: { ui: { idea_canvas_v2: canvasV2 } } });
    }
    if (url.includes('/api/v1/boards/meta/taxonomy')) {
      return json({ note_kinds: ['idea', 'want'], type_config: {} });
    }
    if (url.includes('/api/v1/tray')) {
      return json({ items: [] });
    }
    if (url.includes('/api/v1/boards/ideas')) {
      return json({
        board: { workspace: 'ws', board: 'ideas', name: 'Ideas' },
        type_config: null,
        items: [
          { item: item({ id: 'i-1', title: 'Alpha' }), statements: [] },
          { item: item({ id: 'i-2', title: 'Beta' }), statements: [] },
        ],
        connectors: [],
      });
    }
    return new Response('{}', { status: 404 });
  });
}

function renderRoute(entry = '/projects/ws/boards/ideas') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/projects/:ws/boards/:board" element={<IdeaBoard />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('idea board route — ui.idea_canvas_v2 gating', () => {
  it('flag on → the React Flow canvas mounts with the board data', async () => {
    mockFetch(true);
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId('board-canvas')).toBeTruthy(),
    );
    const props = canvasSpy.mock.calls[0]?.[0] as {
      ws: string;
      board: string;
      data: { items: { item: BoardItem }[] };
    };
    expect(props.ws).toBe('ws');
    expect(props.board).toBe('ideas');
    expect(props.data.items).toHaveLength(2);
    // The Idea/Delivery mode toggle survives on the canvas route.
    expect(screen.getByRole('tab', { name: 'Delivery' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Easy Edit' })).toBeTruthy();
  });

  it('?view=edit mounts Easy Edit over the same board data — case:easy-edit-01', async () => {
    mockFetch(true);
    renderRoute('/projects/ws/boards/ideas?view=edit');
    await waitFor(() => expect(screen.getByTestId('easy-edit')).toBeTruthy());
    const props = easyEditSpy.mock.calls[0]?.[0] as {
      ws: string;
      board: string;
      surfaces: { item: BoardItem }[];
      tray: BoardItem[];
      refresh: unknown;
      editorId: string | null;
    };
    expect(props.ws).toBe('ws');
    expect(props.surfaces).toHaveLength(2);
    // The embedded capture form re-reads durable state through this.
    expect(typeof props.refresh).toBe('function');
    expect(props.editorId).toBeNull();
    expect(screen.queryByTestId('board-canvas')).toBeNull();
    expect(
      screen
        .getByRole('tablist', { name: 'board mode' })
        .closest('header')
        ?.classList.contains('easy-edit-topbar'),
    ).toBe(true);
  });

  it('deep-links an item id into the full-page editor — case:easy-edit-12', async () => {
    mockFetch(true);
    renderRoute('/projects/ws/boards/ideas?view=edit&item=i-1');
    await waitFor(() => expect(screen.getByTestId('easy-edit')).toBeTruthy());
    const props = easyEditSpy.mock.calls.at(-1)?.[0] as {
      editorId: string | null;
      closeEditor: () => void;
    };
    expect(props.editorId).toBe('i-1');
    expect(typeof props.closeEditor).toBe('function');
  });

  it('flag off hides the Easy Edit tab — case:easy-edit-01', async () => {
    mockFetch(false);
    renderRoute();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByRole('tab', { name: 'Easy Edit' })).toBeNull();
    expect(screen.queryByTestId('easy-edit')).toBeNull();
  });

  it('flag off → the grouped classic view renders, no canvas', async () => {
    mockFetch(false);
    renderRoute();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByTestId('board-canvas')).toBeNull();
    // Legacy zone labels still group the classic lanes.
    expect(screen.getByText('discovery')).toBeTruthy();
  });
});
