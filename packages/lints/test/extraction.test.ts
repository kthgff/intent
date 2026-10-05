/**
 * wp-143 tests — extraction preservation lint (PRD §15.3/§15.9).
 *
 * The lint is the safety net under the extraction pipeline: a negation
 * or scope qualifier present in the source must survive into the
 * covering statement's polarity/intent or its verbatim quote. A dropped
 * "not" silently inverts a requirement — that is the failure mode this
 * catches.
 */
import { describe, expect, it } from 'vitest';
import {
  extractionPreservationLint,
  locateQuote,
  sourceSentences,
} from '../src/extraction.js';

describe('sourceSentences', () => {
  it('splits on sentence punctuation and newlines, tracking spans', () => {
    const text = 'Resets take 3 days. Users must not share passwords.\n';
    const sentences = sourceSentences(text);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    for (const s of sentences) {
      expect(text.slice(s.start, s.end)).toBe(s.sentence);
    }
  });
});

describe('locateQuote', () => {
  it('finds a verbatim quote and returns its span', () => {
    const text = 'Password resets currently take 3 days.';
    const span = locateQuote(text, 'resets currently take 3 days');
    expect(span).not.toBeNull();
    expect(text.slice(span?.[0] ?? 0, span?.[1] ?? 0)).toBe(
      'resets currently take 3 days',
    );
  });

  it('returns null for a paraphrase', () => {
    expect(locateQuote('Password resets take 3 days.', 'resets are slow')).toBe(
      null,
    );
  });
});

describe('extractionPreservationLint', () => {
  it('flags a dropped negation — the requirement was silently inverted', () => {
    // The quote itself lost the "not": neither the normalized text nor
    // the evidence carries the cue, so the inversion would ship.
    const source = 'Users must not share passwords with support.';
    const violations = extractionPreservationLint(source, [
      {
        key: 'k1',
        text: 'Users share passwords with support',
        source_text: 'Users share passwords with support',
      },
    ]);
    expect(violations.map((v) => v.rule)).toContain(
      'extraction.negation-dropped',
    );
  });

  it('accepts a preserved negation via polarity', () => {
    const source = 'Users must not share passwords with support.';
    const violations = extractionPreservationLint(source, [
      {
        key: 'k1',
        text: 'Users must not share passwords with support',
        source_text: 'Users must not share passwords with support.',
        polarity: 'negate',
      },
    ]);
    expect(violations).toHaveLength(0);
  });

  it('accepts a preserved negation via a negating intent', () => {
    const source = 'Users must not share passwords with support.';
    const violations = extractionPreservationLint(source, [
      {
        key: 'k1',
        text: 'Sharing passwords with support is prohibited',
        source_text: 'Users must not share passwords with support.',
        intent: 'prohibits',
      },
    ]);
    expect(violations).toHaveLength(0);
  });

  it('flags a dropped scope qualifier — the claim silently widened', () => {
    const source = 'Audit logs are retained for at most 30 days.';
    const violations = extractionPreservationLint(source, [
      {
        key: 'k1',
        text: 'Audit logs are retained',
        source_text: 'Audit logs are retained',
      },
    ]);
    expect(violations.map((v) => v.rule)).toContain(
      'extraction.qualifier-dropped',
    );
  });

  it('flags an uncovered cue — nothing extracted covers the sentence', () => {
    const source =
      'Password resets take 3 days. Nothing may bypass the audit log.';
    const violations = extractionPreservationLint(source, [
      {
        key: 'k1',
        text: 'Password resets take 3 days',
        source_text: 'Password resets take 3 days.',
      },
    ]);
    const uncovered = violations.find((v) =>
      v.message.includes('not covered by any extracted statement'),
    );
    expect(uncovered).toBeDefined();
  });

  it('names the covering statement on a dropped-cue violation', () => {
    const source = 'Users must not share passwords with support.';
    const violations = extractionPreservationLint(source, [
      {
        key: 'share-passwords',
        text: 'Users share passwords with support',
        source_text: 'Users share passwords with support',
      },
    ]);
    expect(violations[0]?.statement).toBe('share-passwords');
  });

  it('a clean batch produces no violations', () => {
    const source =
      'Password resets currently take 3 days. We must cut that to under an hour.';
    const violations = extractionPreservationLint(source, [
      {
        key: 'problem',
        text: 'Password resets take 3 days',
        source_text: 'Password resets currently take 3 days.',
      },
      {
        key: 'requirement',
        text: 'Resets complete in under an hour',
        source_text: 'We must cut that to under an hour.',
      },
    ]);
    expect(violations).toHaveLength(0);
  });
});
