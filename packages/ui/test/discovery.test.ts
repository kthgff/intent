/**
 * wp-147 — discovery surface helpers: canvas lane grouping, capture
 * type guessing, bulk-paste splitting, provenance/briefing lines.
 */
import type { BoardItem } from '@sprint-runner/core';
import { describe, expect, it } from 'vitest';
import {
  briefingLines,
  groupCanvasItems,
  guessCaptureKind,
  isConsumedItem,
  questionWhy,
  slotStateLabel,
  splitBulkAnswers,
} from '../src/discovery';

const item = (over: Partial<BoardItem>): BoardItem => ({
  id: 'bi-x',
  workspace: 'ws',
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
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

describe('canvas grouping (S-16)', () => {
  const items = [
    item({ id: 'a', zone: 'onboarding', note_kind: 'problem' }),
    item({ id: 'b', zone: 'onboarding', note_kind: 'idea' }),
    item({ id: 'c', zone: null, note_kind: 'want' }),
    item({ id: 'z', kind: 'zone', zone: null }),
  ];

  it('groups by zone, unzoned → loose; zone items are not cards', () => {
    const lanes = groupCanvasItems(items, 'zone');
    const keys = lanes.map((l) => l.key);
    expect(keys).toContain('onboarding');
    expect(keys).toContain('loose');
    expect(lanes.find((l) => l.key === 'onboarding')?.items.length).toBe(2);
    // kind=zone frames never render as sticky cards.
    expect(lanes.flatMap((l) => l.items).map((i) => i.id)).not.toContain('z');
  });

  it('groups by type in taxonomy order', () => {
    const lanes = groupCanvasItems(items, 'type');
    expect(lanes.map((l) => l.key)).toEqual(['problem', 'want', 'idea']);
  });

  it('consumed/frozen items are supersede-only', () => {
    expect(isConsumedItem(item({ status: 'consumed' }))).toBe(true);
    expect(isConsumedItem(item({ status: 'frozen' }))).toBe(true);
    expect(isConsumedItem(item({ status: 'active' }))).toBe(false);
  });
});

describe('capture type guess (S-19)', () => {
  it('guesses question / constraint / feedback / problem / want', () => {
    expect(guessCaptureKind('can we ship saml?')).toBe('question');
    expect(guessCaptureKind('password resets must complete in an hour')).toBe(
      'constraint',
    );
    expect(guessCaptureKind('the signup page is broken')).toBe('feedback');
    expect(guessCaptureKind('onboarding takes too long')).toBe('problem');
    expect(guessCaptureKind('users want dark mode')).toBe('want');
    expect(guessCaptureKind('consider a plugin API')).toBe('idea');
  });
});

describe('bulk answers (§15.9 — same session state)', () => {
  it('one non-empty line per answer; comments skipped', () => {
    const lines = splitBulkAnswers(
      'first answer\n\n  \n# comment\nsecond answer\n// note',
    );
    expect(lines).toEqual(['first answer', 'second answer']);
  });
});

describe('wizard surface helpers', () => {
  it('slot chips render state labels, never a percentage', () => {
    const slot = { state: 'not-applicable' };
    expect(slotStateLabel(slot as Parameters<typeof slotStateLabel>[0])).toBe(
      'n/a',
    );
  });

  it('question provenance carries slot + scores', () => {
    const why = questionWhy({
      slot: 'problem',
      scores: {
        purpose: 'fill',
        impact: 1,
        uncertainty: 1,
        relevance: 1,
        answerability: 1,
        effort: 0.3,
      },
    });
    expect(why).toContain("targets slot 'problem'");
    expect(why).toContain('impact 1.0');
  });

  it('resume briefing lists changed slots', () => {
    const lines = briefingLines({
      summary: '1 slot(s) changed',
      changed_slots: [{ slot: 'problem', from: 'missing', to: 'inferred' }],
      new_messages: [],
    });
    expect(lines.join(' ')).toContain('problem: missing → inferred');
  });
});
