import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  matchThread,
  normalizeFindingText,
  threadIdFor,
} from '../src/index.js';

const FINDING = {
  file: 'src/runner.ts',
  category: 'correctness',
  body: 'Retry loop ignores   the\ncircuit-breaker flag',
  line_range: [40, 52] as [number, number],
};

const thread = (f = FINDING) => ({
  thread_id: threadIdFor(f),
  fingerprint: fingerprint(f),
});

describe('fingerprint (SCHEMAS §6)', () => {
  it('normalizes whitespace before hashing', () => {
    expect(normalizeFindingText('  a  b\n\tc ')).toBe('a b c');
    const a = fingerprint({
      ...FINDING,
      body: 'Retry loop ignores the circuit-breaker flag',
    });
    expect(a.text_hash).toBe(fingerprint(FINDING).text_hash);
    expect(a.text_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hash changes with file or category', () => {
    const base = fingerprint(FINDING).text_hash;
    expect(fingerprint({ ...FINDING, file: 'other.ts' }).text_hash).not.toBe(
      base,
    );
    expect(
      fingerprint({ ...FINDING, category: 'security' }).text_hash,
    ).not.toBe(base);
  });

  it('thread_id is f-<4 hex>', () => {
    expect(threadIdFor(FINDING)).toMatch(/^f-[0-9a-f]{4}$/);
  });
});

describe('matchThread — reopened detection (§6)', () => {
  it('matches the same finding at shifted line numbers via text_hash', () => {
    const shifted = { ...FINDING, line_range: [90, 102] as [number, number] };
    expect(matchThread(shifted, [thread()])).toBe(thread().thread_id);
  });

  it('matches a reworded finding at a nearby line range', () => {
    const reworded = {
      ...FINDING,
      body: 'completely different wording about the breaker',
      line_range: [55, 60] as [number, number],
    };
    expect(matchThread(reworded, [thread()])).toBe(thread().thread_id);
  });

  it('rejects a reworded finding far away', () => {
    const far = {
      ...FINDING,
      body: 'different wording',
      line_range: [200, 210] as [number, number],
    };
    expect(matchThread(far, [thread()])).toBeNull();
  });

  it('rejects different file or category even with same text', () => {
    expect(
      matchThread({ ...FINDING, file: 'other.ts' }, [thread()]),
    ).toBeNull();
    expect(
      matchThread({ ...FINDING, category: 'style' }, [thread()]),
    ).toBeNull();
  });

  it('does not match when both findings lack line info and text differs', () => {
    const noLines = { ...FINDING, line_range: null, body: 'other text' };
    const t = thread({ ...FINDING, line_range: null });
    expect(matchThread(noLines, [t])).toBeNull();
  });
});
