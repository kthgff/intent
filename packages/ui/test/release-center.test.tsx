import type { ReleaseNoteRow } from '@sprint-runner/core';
// @vitest-environment jsdom
/**
 * wp-137 Release Center — gate verdicts and note states are honest:
 * an unchecked gate is never green, and a draft newer than the pinned
 * approved doc_version reads as a stale approval (invariant 6).
 */
import { describe, expect, it } from 'vitest';
import { gateTone, noteState } from '../src/screens/ReleaseCenter';

const note = (over: Partial<ReleaseNoteRow> = {}): ReleaseNoteRow => ({
  workspace: 'ws',
  release_id: 'REL-0001',
  audience: 'customer',
  doc_version: null,
  approved_by: null,
  approved_at: null,
  published_at: null,
  ...over,
});

describe('release gate display (wp-137)', () => {
  it('maps pass/fail/waived to distinct tones; unchecked is warn', () => {
    expect(gateTone('pass')).toBe('spec-good');
    expect(gateTone('fail')).toBe('spec-bad');
    expect(gateTone('waived')).toBe('spec-warn');
    expect(gateTone(undefined)).toBe('spec-warn');
  });
});

describe('release note state (wp-137, DELIVERY invariant 6)', () => {
  it('published beats everything', () => {
    expect(
      noteState(note({ doc_version: 1, published_at: 'x' }), { version: 5 }),
    ).toBe('published');
  });
  it('no draft and no row → none', () => {
    expect(noteState(undefined, null)).toBe('none');
    expect(noteState(note(), null)).toBe('none');
  });
  it('draft without approval → draft', () => {
    expect(noteState(undefined, { version: 1 })).toBe('draft');
    expect(noteState(note(), { version: 1 })).toBe('draft');
  });
  it('draft pinned at the approved version → approved', () => {
    expect(noteState(note({ doc_version: 2 }), { version: 2 })).toBe(
      'approved',
    );
  });
  it('a newer draft than the approved pin → unapproved-draft (stale approval)', () => {
    expect(noteState(note({ doc_version: 2 }), { version: 3 })).toBe(
      'unapproved-draft',
    );
  });
});
