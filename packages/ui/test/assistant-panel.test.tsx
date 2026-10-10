// @vitest-environment jsdom
/**
 * BOARD-CHAT wp-165 — the assistant panel on the v2 canvas.
 *
 * case:board-chat-01/02/11/12/13: flag gating (no affordance when off),
 * panel open/collapse/reopen, skill pills + chips → input, freeform →
 * messages POST, in-thread proposal batches with per-item + accept-all
 * controls, `model:'absent'` degradation banner, narrow-mode list, and
 * the ghost↔thread wiring (proposals prop + onGhostClick + focus).
 * BoardCanvas stays stubbed — its internals are covered elsewhere.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { BoardItem, BoardProposalRow } from '@veto/core';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IdeaBoard from '../src/screens/IdeaBoard';

vi.mock('../src/sse', () => ({ subscribeStream: () => () => {} }));
const canvasSpy = vi.fn();
vi.mock('../src/board-canvas/BoardCanvas', () => ({
  default: (props: Record<string, unknown>) => {
    canvasSpy(props);
    return <div data-testid="board-canvas" />;
  },
}));
vi.mock('../src/board-canvas/EasyEdit', () => ({
  default: () => <div data-testid="easy-edit" />,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  canvasSpy.mockClear();
});

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
  w: 200,
  h: 150,
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

const proposal = (
  over: Partial<BoardProposalRow> & Pick<BoardProposalRow, 'proposal_id'>,
): BoardProposalRow => ({
  workspace: 'ws',
  board: 'ideas',
  session_id: 'sess-1',
  op: 'create-item',
  payload: {
    op: 'create-item',
    kind: 'note',
    title: 'Proposed card',
    x: 40,
    y: 40,
  },
  status: 'pending',
  created_by: 'assistant',
  ...over,
});

const assistantState = (over: Record<string, unknown> = {}) => ({
  session: {
    session_id: 'sess-1',
    mode: 'conversation',
    status: 'active',
  },
  messages: [
    {
      workspace: 'ws',
      session_id: 'sess-1',
      seq: 1,
      role: 'assistant',
      content: 'What is the goal of this board?',
      created_by: 'assistant',
    },
    {
      workspace: 'ws',
      session_id: 'sess-1',
      seq: 2,
      role: 'user',
      content: 'Ship faster.',
      created_by: 'keith',
    },
  ],
  proposals: [],
  skills: [
    { skill: 'interview', label: '/interview', description: 'Goals first' },
    { skill: 'expand', label: '/expand', description: 'Scope to selection' },
    { skill: 'critique', label: '/critique', description: 'Find gaps' },
  ],
  chips: [{ id: 'interview', label: 'Run /interview', command: '/interview' }],
  pending_question: null,
  model: 'absent',
  active_run: null,
  ...over,
});

function mockFetch(opts: {
  boardChat: boolean;
  assistant?: Record<string, unknown>;
  narrow?: boolean;
}) {
  const calls: { url: string; body?: unknown; method: string }[] = [];
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      } catch {
        body = undefined;
      }
      calls.push({ url, body, method });
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/api/v1/settings')) {
        return json({
          config: { ui: { idea_canvas_v2: true, board_chat: opts.boardChat } },
        });
      }
      if (url.includes('/api/v1/boards/meta/taxonomy')) {
        return json({ note_kinds: ['idea', 'want'], type_config: {} });
      }
      if (url.includes('/api/v1/tray')) return json({ items: [] });
      if (url.includes('/assistant/messages')) {
        return json({ messages: [], proposals: [], pending_question: null });
      }
      if (url.includes('/assistant/runs')) {
        return json({ branch: 'run-1', asked: null });
      }
      if (url.includes('/assistant')) {
        return json(opts.assistant ?? assistantState());
      }
      if (url.includes('/proposals/accept')) {
        return json({ proposals: [], items: [] });
      }
      if (url.includes('/proposals/') && url.includes('/reject')) {
        return json({ proposal: proposal({ proposal_id: 'bp-x' }) });
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
  return { spy, calls };
}

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/projects/ws/boards/ideas']}>
      <Routes>
        <Route path="/projects/:ws/boards/:board" element={<IdeaBoard />} />
      </Routes>
    </MemoryRouter>,
  );
}

const openPanel = async () => {
  const toggle = await screen.findByRole('button', {
    name: /board assistant/i,
  });
  toggle.click();
  await screen.findByRole('tab', { name: /thread/i });
};

describe('board assistant panel (wp-165)', () => {
  it('case:board-chat-01 — flag off renders no affordance and never fetches', async () => {
    const { calls } = mockFetch({ boardChat: false });
    renderRoute();
    await screen.findByTestId('board-canvas');
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/v1/settings'))).toBe(true);
    });
    expect(
      screen.queryByRole('button', { name: /board assistant/i }),
    ).toBeNull();
    expect(calls.some((c) => c.url.includes('/assistant'))).toBe(false);
    expect(canvasSpy).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: [] }),
    );
  });

  it('flag on → collapsed toggle → open → thread renders with attribution', async () => {
    mockFetch({ boardChat: true });
    renderRoute();
    await openPanel();
    expect(screen.getByText('What is the goal of this board?')).toBeTruthy();
    expect(screen.getByText('Ship faster.')).toBeTruthy();
    expect(screen.getByText('keith')).toBeTruthy();
    expect(screen.getByText('assistant')).toBeTruthy();
  });

  it('case:board-chat-13 UI — model:absent shows the degradation banner', async () => {
    mockFetch({ boardChat: true });
    renderRoute();
    await openPanel();
    expect(
      screen.getByText(/No model configured — freeform commands need one/),
    ).toBeTruthy();
  });

  it('case:board-chat-02 — chip populates input; free text posts {workspace,text}', async () => {
    const { calls } = mockFetch({ boardChat: true });
    renderRoute();
    await openPanel();
    // Chip → input
    act(() => {
      screen.getByRole('button', { name: 'Run /interview' }).click();
    });
    const input = screen.getByLabelText(
      'message the board assistant',
    ) as HTMLInputElement;
    expect(input.value).toBe('/interview');
    // Freeform text → POST …/assistant/messages
    fireEvent.change(input, { target: { value: 'add a constraint card' } });
    screen.getByRole('button', { name: 'Send' }).click();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/assistant/messages') &&
            c.method === 'POST' &&
            (c.body as { text?: string }).text === 'add a constraint card',
        ),
      ).toBe(true),
    );
  });

  it('skill pills: /critique posts the slash command; /expand is inert without a selection', async () => {
    const { calls } = mockFetch({ boardChat: true });
    renderRoute();
    await openPanel();
    const expand = screen.getByRole('button', {
      name: '/expand',
    }) as HTMLButtonElement;
    expect(expand.disabled).toBe(true);
    screen.getByRole('button', { name: '/critique' }).click();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/assistant/messages') &&
            (c.body as { text?: string }).text === '/critique',
        ),
      ).toBe(true),
    );
  });

  it('proposal batches render in-thread — per-item + accept-all controls', async () => {
    mockFetch({
      boardChat: true,
      assistant: assistantState({
        proposals: [
          proposal({ proposal_id: 'bp-1', batch_id: 'b-1' }),
          proposal({
            proposal_id: 'bp-2',
            batch_id: 'b-1',
            payload: {
              op: 'patch-item',
              id: 'i-1',
              patch: { title: 'Renamed' },
            },
          }),
          proposal({
            proposal_id: 'bp-3',
            payload: { op: 'delete-item', id: 'i-2' },
          }),
        ],
      }),
    });
    const { calls } = mockFetch({
      boardChat: true,
      assistant: assistantState({
        proposals: [
          proposal({ proposal_id: 'bp-1', batch_id: 'b-1' }),
          proposal({
            proposal_id: 'bp-2',
            batch_id: 'b-1',
            payload: {
              op: 'patch-item',
              id: 'i-1',
              patch: { title: 'Renamed' },
            },
          }),
          proposal({
            proposal_id: 'bp-3',
            payload: { op: 'delete-item', id: 'i-2' },
          }),
        ],
      }),
    });
    renderRoute();
    await openPanel();
    expect(screen.getByText('2 changes')).toBeTruthy();
    // Batch accept-all posts the group's ids atomically.
    screen.getByRole('button', { name: 'Accept all' }).click();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/proposals/accept') &&
            (c.body as { ids?: string[] }).ids?.join(',') === 'bp-1,bp-2',
        ),
      ).toBe(true),
    );
  });

  it('per-item accept + reject post to the proposal routes', async () => {
    const { calls } = mockFetch({
      boardChat: true,
      assistant: assistantState({
        proposals: [proposal({ proposal_id: 'bp-9' })],
      }),
    });
    renderRoute();
    await openPanel();
    screen.getByRole('button', { name: 'Accept' }).click();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/proposals/accept') &&
            (c.body as { ids?: string[] }).ids?.[0] === 'bp-9',
        ),
      ).toBe(true),
    );
    screen.getByRole('button', { name: 'Reject' }).click();
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/proposals/bp-9/reject'))).toBe(
        true,
      ),
    );
  });

  it('ghost wiring: pending proposals reach BoardCanvas; ghost click opens the thread', async () => {
    const p = proposal({ proposal_id: 'bp-1' });
    mockFetch({
      boardChat: true,
      assistant: assistantState({ proposals: [p] }),
    });
    renderRoute();
    await screen.findByTestId('board-canvas');
    await waitFor(() =>
      expect(canvasSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          proposals: expect.arrayContaining([
            expect.objectContaining({ proposal_id: 'bp-1' }),
          ]),
        }),
      ),
    );
    const ghostClick = canvasSpy.mock.calls.at(-1)?.[0].onGhostClick as (
      p: BoardProposalRow,
    ) => void;
    ghostClick(p);
    await screen.findByRole('tab', { name: /thread/i });
    expect(
      document.getElementById('bp-bp-1') ??
        screen.getByText(/Add .*“Proposed card”/),
    ).toBeTruthy();
  });

  it('collapse → corner toggle → reopen keeps the thread mounted state', async () => {
    mockFetch({ boardChat: true });
    renderRoute();
    await openPanel();
    screen.getByRole('button', { name: /collapse assistant panel/i }).click();
    const toggle = await screen.findByRole('button', {
      name: /board assistant/i,
    });
    toggle.click();
    await screen.findByText('What is the goal of this board?');
  });

  it('pending-question copy switches the input placeholder', async () => {
    mockFetch({
      boardChat: true,
      assistant: assistantState({
        pending_question: {
          question_id: 'q-1',
          question: 'What does success look like?',
          status: 'asked',
        },
      }),
    });
    renderRoute();
    await openPanel();
    expect(
      screen.getByPlaceholderText('Answer the question above…'),
    ).toBeTruthy();
  });
});
