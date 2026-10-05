import { describe, expect, it } from 'vitest';
import {
  defaultScorer,
  extractionScorer,
  type GoldenCase,
  matchRatio,
  matchSubset,
  questionsScorer,
  repeatQuestionRate,
  reviewScorer,
  scoreCase,
  scorerFor,
} from '../src/index.js';

function golden(
  expected: Record<string, unknown>,
  tags?: string[],
): GoldenCase {
  return {
    case_id: 'c',
    input: {},
    expected,
    ...(tags ? { tags } : {}),
  };
}

describe('matchSubset', () => {
  it('matches nested subsets and ignores extra candidate fields', () => {
    const m = matchSubset({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2, d: 3 }, e: 4 });
    expect(m.mismatches).toEqual([]);
    expect(matchRatio(m)).toBe(1);
  });

  it('reports mismatched leaf paths', () => {
    const m = matchSubset({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 9 } });
    expect(m.mismatches).toEqual(['$.b.c']);
    expect(matchRatio(m)).toBe(0.5);
  });

  it('matches array items order-independently (recall)', () => {
    const m = matchSubset({ xs: [1, 2] }, { xs: [2, 1, 3] });
    expect(m.mismatches).toEqual([]);
  });

  it('flags a missing expected array item', () => {
    const m = matchSubset({ xs: [1, 2] }, { xs: [1] });
    expect(m.mismatches).toEqual(['$.xs[1]']);
  });

  it('treats an empty expectation as vacuously true', () => {
    expect(matchRatio(matchSubset({}, { anything: true }))).toBe(1);
  });
});

describe('family scorers', () => {
  it('default scorer passes a full subset match', () => {
    expect(defaultScorer(golden({ a: 1 }), { a: 1, b: 2 }).verdict).toBe(
      'pass',
    );
    expect(defaultScorer(golden({ a: 1 }), { a: 2 }).verdict).toBe('fail');
  });

  it('extraction requires negation preservation', () => {
    const g = golden({ kind: 'constraint', polarity: 'negated' });
    expect(
      extractionScorer(g, { kind: 'constraint', polarity: 'negated' }).verdict,
    ).toBe('pass');
    const s = extractionScorer(g, { kind: 'constraint', polarity: 'affirmed' });
    expect(s.verdict).toBe('fail');
    expect(s.scores['negation_preserved']).toBe(0);
  });

  it('review computes precision and recall', () => {
    const g = golden({ findings: [{ file: 'a.ts', severity: 'blocker' }] });
    const perfect = reviewScorer(g, {
      findings: [{ file: 'a.ts', severity: 'blocker', line: 1 }],
    });
    expect(perfect.verdict).toBe('pass');

    const falseNegative = reviewScorer(g, { findings: [] });
    expect(falseNegative.scores['recall']).toBe(0);
    expect(falseNegative.verdict).toBe('fail');

    const falsePositive = reviewScorer(g, {
      findings: [
        { file: 'a.ts', severity: 'blocker' },
        { file: 'b.ts', severity: 'minor' },
      ],
    });
    expect(falsePositive.scores['precision']).toBe(0.5);
    expect(falsePositive.verdict).toBe('fail');
  });

  it('questions reports the repeat-question rate', () => {
    expect(
      repeatQuestionRate([{ text: 'a' }, { text: 'a' }, { text: 'b' }]),
    ).toBeCloseTo(1 / 3);
    const s = questionsScorer(
      golden({ questions: [{ knowledge_slot: 'x' }] }),
      {
        questions: [
          { knowledge_slot: 'x', text: 'a' },
          { knowledge_slot: 'x', text: 'a' },
        ],
      },
    );
    expect(s.scores['repeat_question_rate']).toBeCloseTo(0.5);
  });

  it('scorerFor falls back to the default scorer', () => {
    expect(scorerFor('coverage')).toBe(defaultScorer);
    expect(scoreCase('unknown-family', golden({ a: 1 }), { a: 1 }).verdict).toBe(
      'pass',
    );
  });
});
