// @vitest-environment jsdom
/**
 * wp-137 Merge Center — ready tickets lead the queue (FIFO by
 * evaluation), checklist rows render green/blocked, and the conflict
 * card names the merge_conflict gate (never a silent force-push).
 */
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { MergeReadiness } from '../src/api';
import MergeCenter, {
  ReadinessCard,
  orderedItems,
  queueOrder,
} from '../src/screens/MergeCenter';

afterEach(cleanup);

const readiness = (over: Partial<MergeReadiness> = {}): MergeReadiness => ({
  ticket_id: 'SR-0001',
  ready: true,
  items: [
    { id: 'checks', label: 'Checks green', ok: true },
    { id: 'approval', label: 'Approval bound to head SHA', ok: true },
  ],
  blockers: [],
  heads: { app: 'abcdef123456' },
  at: '2026-10-05T10:00:00Z',
  ...over,
});

describe('Merge Center queue order (wp-137)', () => {
  it('puts ready tickets first, FIFO by evaluation time', () => {
    const blocked = readiness({
      ticket_id: 'SR-1',
      ready: false,
      at: '2026-10-05T09:00:00Z',
    });
    const late = readiness({
      ticket_id: 'SR-2',
      ready: true,
      at: '2026-10-05T11:00:00Z',
    });
    const early = readiness({
      ticket_id: 'SR-3',
      ready: true,
      at: '2026-10-05T08:00:00Z',
    });
    expect(queueOrder([blocked, late, early]).map((r) => r.ticket_id)).toEqual([
      'SR-3',
      'SR-2',
      'SR-1',
    ]);
  });

  it('orders checklist items by the DELIVERY §2 sequence', () => {
    const r = readiness({
      items: [
        { id: 'dod', label: 'DoD', ok: true },
        { id: 'approval', label: 'Approval', ok: true },
        { id: 'checks', label: 'Checks', ok: true },
      ],
    });
    expect(orderedItems(r).map((i) => i.id)).toEqual([
      'approval',
      'checks',
      'dod',
    ]);
  });
});

describe('Merge Center readiness card (wp-137)', () => {
  it('renders blockers + the conflict card when blocked', () => {
    render(
      <MemoryRouter>
        <ReadinessCard
          ws="ws"
          onDone={() => {}}
          r={readiness({
            ready: false,
            items: [
              {
                id: 'conflict',
                label: 'No git conflict',
                ok: false,
                detail: 'app: rebase needed',
                gate: 'merge_conflict',
              },
              { id: 'branch-protection', label: 'Branch protection', ok: true },
            ],
            blockers: [
              {
                id: 'conflict',
                label: 'No git conflict',
                ok: false,
                detail: 'app: rebase needed',
                gate: 'merge_conflict',
              },
            ],
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/blocked — 1 gate/)).toBeTruthy();
    expect(screen.getByText('merge_conflict')).toBeTruthy();
    expect(screen.getByText(/rebase.*run owns the rewrite/)).toBeTruthy();
    // No execute-merge affordance while blocked.
    expect(screen.queryByText('Merge now')).toBeNull();
  });

  it('offers Merge now when ready; revert lives on the PR panel', () => {
    render(
      <MemoryRouter>
        <ReadinessCard ws="ws" onDone={() => {}} r={readiness()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Merge now')).toBeTruthy();
    // The merge-center payload only ever carries ci-watch tickets —
    // revert is a merged-work action on the PR panel, never here.
    expect(screen.queryByText('Revert…')).toBeNull();
    expect(screen.getByText(/app@abcdef12/)).toBeTruthy();
    cleanup();
    render(
      <MemoryRouter>
        <ReadinessCard
          ws="ws"
          onDone={() => {}}
          r={readiness({ status: 'merged' })}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Revert…')).toBeNull();
  });
});
