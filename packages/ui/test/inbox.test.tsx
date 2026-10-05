// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/api';
import { groupByKind, rankInbox } from '../src/screens/Inbox';
import InboxCard from './helpers/InboxCard';

const item = (over: Partial<InboxItem>): InboxItem => ({
  workspace: 'ws',
  subject: 'SR-1',
  gate: 'needs-info',
  kind: 'question',
  surfaced_at: '2026-10-01T00:00:00Z',
  cleared_at: null,
  blocked_agent: false,
  priority: 'medium',
  claim: null,
  ...over,
});

describe('S-01 inbox ordering', () => {
  it('ranks blocking-first → priority → age', () => {
    const ranked = rankInbox([
      item({ subject: 'old-low', priority: 'low', blocked_agent: true }),
      item({ subject: 'hi', priority: 'high' }),
      item({ subject: 'new-block', blocked_agent: true, priority: 'high' }),
      item({
        subject: 'old-block',
        blocked_agent: true,
        priority: 'high',
        surfaced_at: '2026-09-01T00:00:00Z',
      }),
    ]);
    expect(ranked.map((i) => i.subject)).toEqual([
      'old-block', // blocking + high + oldest
      'new-block', // blocking + high + newer
      'old-low', // blocking + low
      'hi', // not blocking
    ]);
  });

  it('groups by kind for sectioned render (anxiety-first: failures on top)', () => {
    const groups = groupByKind([
      item({ kind: 'failure', subject: 'f' }),
      item({ kind: 'question', subject: 'q' }),
    ]);
    expect(groups[0]?.[0]).toBe('failure');
    expect(groups[1]?.[0]).toBe('question');
  });

  it('ranks failures/escalations above routine questions (D21)', () => {
    const ranked = rankInbox([
      item({ subject: 'q', kind: 'question', priority: 'high' }),
      item({ subject: 'f', kind: 'failure', priority: 'low' }),
      item({ subject: 'e', kind: 'escalation' }),
    ]);
    expect(ranked.map((i) => i.subject)).toEqual(['f', 'e', 'q']);
  });

  it('renders blocking items before non-blocking', () => {
    render(
      <MemoryRouter>
        <div>
          {rankInbox([
            item({ subject: 'WAITING' }),
            item({ subject: 'BLOCKING', blocked_agent: true }),
          ]).map((i) => (
            <InboxCard key={i.subject} item={i} />
          ))}
        </div>
      </MemoryRouter>,
    );
    const links = screen.getAllByRole('link').map((l) => l.textContent);
    expect(links[0]).toContain('BLOCKING');
    expect(links[1]).toContain('WAITING');
  });
});

afterEach(cleanup);
