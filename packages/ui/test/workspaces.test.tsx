// @vitest-environment jsdom
/**
 * /projects picker — card grid fed by the aggregate
 * GET /api/v1/projects/summary, pinned-first + MRU ordering, search
 * filter, and the header Add-project form.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../src/api';

vi.mock('../src/sse', () => ({ subscribeStream: () => () => {} }));
const mocks = vi.hoisted(() => ({
  projectSummaries: vi.fn(),
  addWorkspace: vi.fn(),
}));
vi.mock('../src/api', async () => {
  const actual = await vi.importActual('../src/api');
  return { ...actual, client: mocks };
});

import Workspaces, { orderProjects } from '../src/screens/Workspaces';

const summary = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  workspace: 'ws',
  boards: 2,
  open_gate_items: 3,
  queue_depth: 1,
  live_runs: 2,
  last_active_at: '2026-10-06T12:00:00Z',
  totals: { cost_usd: 1.5, tokens: 42000, human_minutes: 38 },
  counts: { tickets: 8, features: 3, initiatives: 2 },
  ...over,
});

const renderPicker = () =>
  render(
    <MemoryRouter>
      <Workspaces />
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  mocks.projectSummaries.mockReset();
  mocks.addWorkspace.mockReset();
  localStorage.clear();
});

describe('orderProjects — pinned → MRU → alpha', () => {
  it('sorts pinned first, then MRU recency, then alpha', () => {
    const ordered = orderProjects(
      [
        summary({ workspace: 'zebra' }),
        summary({ workspace: 'alpha' }),
        summary({ workspace: 'recent' }),
        summary({ workspace: 'pinned' }),
      ],
      {
        pinned: new Set(['zebra']),
        mru: { recent: 200, alpha: 100 },
        filter: '',
      },
    );
    expect(ordered.map((p) => p.workspace)).toEqual([
      'zebra', // pinned beats MRU
      'recent', // most recently used
      'alpha', // older visit
      'pinned', // never visited → alpha tail
    ]);
  });

  it('filters on workspace and display name, case-insensitive', () => {
    const rows = [
      summary({ workspace: 'intent', name: 'Veto' }),
      summary({ workspace: 'other' }),
    ];
    expect(
      orderProjects(rows, {
        pinned: new Set(),
        mru: {},
        filter: 'veto',
      }).map((p) => p.workspace),
    ).toEqual(['intent']);
    expect(
      orderProjects(rows, {
        pinned: new Set(),
        mru: {},
        filter: 'OTH',
      }).map((p) => p.workspace),
    ).toEqual(['other']);
  });
});

describe('picker render', () => {
  it('renders rich cards — headline stats, counts, spend, links', async () => {
    mocks.projectSummaries.mockResolvedValue({
      projects: [summary({ workspace: 'intent' })],
    });
    renderPicker();
    await waitFor(() => expect(screen.getByText('intent')).toBeTruthy());
    const card = screen.getByRole('link', { name: /intent/ });
    expect(card.getAttribute('href')).toBe('/projects/intent');
    // headline stats
    expect(screen.getByText('boards')).toBeTruthy();
    expect(screen.getByText('open items')).toBeTruthy();
    expect(screen.getByText('runs')).toBeTruthy();
    expect(screen.getByText('last active')).toBeTruthy();
    // attention badges
    expect(screen.getByText('3 open')).toBeTruthy();
    expect(screen.getByText('2 active')).toBeTruthy();
    // secondary meta — counts + spend
    expect(
      screen.getByText(/8 tickets · 3 features · 2 initiatives/),
    ).toBeTruthy();
    expect(screen.getByText(/\$1\.50 · 42\.0k tok · 38m human/)).toBeTruthy();
  });

  it('empty state + Add project reveals the registration form', async () => {
    mocks.projectSummaries.mockResolvedValue({ projects: [] });
    renderPicker();
    await waitFor(() =>
      expect(screen.getByText(/No projects yet/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByText('Add project'));
    expect(screen.getByText('Tickets repo URL')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Tickets repo URL')).toBeNull();
  });

  it('pin toggle persists and reorders', async () => {
    mocks.projectSummaries.mockResolvedValue({
      projects: [summary({ workspace: 'a' }), summary({ workspace: 'b' })],
    });
    renderPicker();
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Pin b' }));
    expect(localStorage.getItem('veto_pinned_projects')).toContain('b');
    const cards = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.startsWith('/projects/'));
    expect(cards[0]?.getAttribute('href')).toBe('/projects/b');
  });
});
