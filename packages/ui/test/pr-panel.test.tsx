// @vitest-environment jsdom
/**
 * PR panel (S-09) — merge unlocks on all-green CI; revert exists ONLY
 * when every repo row reports pr_state 'merged' (review S5: the
 * revert affordance lives here, never on the merge center).
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sse', () => ({ subscribeStream: () => () => {} }));
const mocks = vi.hoisted(() => ({ ticket: vi.fn(), action: vi.fn() }));
vi.mock('../src/api', () => ({ client: mocks }));

import PrPanel from '../src/screens/PrPanel';

afterEach(() => {
  cleanup();
  mocks.ticket.mockReset();
  mocks.action.mockReset();
});

const detail = (repos: unknown[], status = 'ci-watch') => ({
  ticket: { ticket_id: 'SR-0001', status, title: 't' },
  repos,
});

const renderPanel = () =>
  render(
    <MemoryRouter initialEntries={['/projects/ws/tickets/SR-0001/pr']}>
      <Routes>
        <Route path="/projects/:ws/tickets/:id/pr" element={<PrPanel />} />
      </Routes>
    </MemoryRouter>,
  );

describe('PrPanel revert affordance', () => {
  it('offers Revert only when every repo row is merged', async () => {
    mocks.ticket.mockResolvedValue(
      detail([
        {
          repo: 'app',
          pr_url: 'https://x/1',
          pr_state: 'merged',
          ci_state: 'green',
        },
        {
          repo: 'api',
          pr_url: 'https://x/2',
          pr_state: 'merged',
          ci_state: 'green',
        },
      ]),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText('Revert')).toBeTruthy());
    // merged work isn't mergeable again — the merge button is disabled.
    expect((screen.getByText('Merge') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('hides Revert while any repo is unmerged', async () => {
    mocks.ticket.mockResolvedValue(
      detail([
        {
          repo: 'app',
          pr_url: 'https://x/1',
          pr_state: 'merged',
          ci_state: 'green',
        },
        {
          repo: 'api',
          pr_url: 'https://x/2',
          pr_state: 'open',
          ci_state: 'green',
        },
      ]),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText('Merge')).toBeTruthy());
    expect(screen.queryByText('Revert')).toBeNull();
    // all-green non-merged work CAN merge.
    expect((screen.getByText('Merge') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('revert posts expected_status from the live ticket row', async () => {
    mocks.action.mockResolvedValue({});
    mocks.ticket.mockResolvedValue(
      detail(
        [
          {
            repo: 'app',
            pr_url: 'https://x/1',
            pr_state: 'merged',
            ci_state: 'green',
          },
        ],
        'merged',
      ),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText('Revert')).toBeTruthy());
    fireEvent.click(screen.getByText('Revert'));
    // Revert is destructive — it confirms via the dialog first.
    fireEvent.click(
      within(screen.getByLabelText('Revert merged PRs?')).getByText('Revert'),
    );
    await waitFor(() =>
      expect(mocks.action).toHaveBeenCalledWith('ws', 'SR-0001', {
        action: 'revert',
        expected_status: 'merged',
      }),
    );
  });
});
