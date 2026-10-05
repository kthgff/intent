/**
 * AI Evaluation Lab — scoring (PRD §15.12, wp-156).
 *
 * Every scorer compares a candidate output against the golden
 * `expected` value and returns a {@link CaseScore}. The default is a
 * recall-oriented subset match: every leaf in `expected` must be
 * present and equal in the candidate, but the candidate may carry
 * extra fields (models routinely emit more than the golden slice).
 * Family scorers add the sub-metrics the ticket names — negation
 * preservation, review precision/recall, question repetition.
 */
import type { CaseScore, GoldenCase } from './types.js';

/** A subset-match result: how many expected leaves matched, of how many. */
export interface SubsetMatch {
  matched: number;
  total: number;
  mismatches: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // NaN never matches; JSON scalars otherwise compare by value.
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  return false;
}

function fullMatch(expected: unknown, actual: unknown, path: string): boolean {
  return matchSubset(expected, actual, path).mismatches.length === 0;
}

/**
 * Recall-oriented subset match. Arrays match when every expected item
 * matches some actual item (order-independent); objects recurse per
 * key; scalars compare by value. `mismatches` lists the leaf paths that
 * did not match — empty means a full pass.
 */
export function matchSubset(
  expected: unknown,
  actual: unknown,
  path = '$',
): SubsetMatch {
  if (Array.isArray(expected)) {
    const mismatches: string[] = [];
    const actualArr = Array.isArray(actual) ? actual : [];
    let matched = 0;
    for (let i = 0; i < expected.length; i++) {
      const itemPath = `${path}[${i}]`;
      if (actualArr.some((a) => fullMatch(expected[i], a, itemPath))) {
        matched++;
      } else {
        mismatches.push(itemPath);
      }
    }
    return { matched, total: expected.length, mismatches };
  }
  if (isPlainObject(expected)) {
    const mismatches: string[] = [];
    let matched = 0;
    let total = 0;
    const actualObj = isPlainObject(actual) ? actual : {};
    for (const [key, exp] of Object.entries(expected)) {
      const child = matchSubset(exp, actualObj[key], `${path}.${key}`);
      matched += child.matched;
      total += child.total;
      mismatches.push(...child.mismatches);
    }
    return { matched, total, mismatches };
  }
  const ok = scalarEqual(expected, actual);
  return { matched: ok ? 1 : 0, total: 1, mismatches: ok ? [] : [path] };
}

/** Ratio of matched leaves; vacuously 1 when `expected` has no leaves. */
export function matchRatio(m: SubsetMatch): number {
  return m.total === 0 ? 1 : m.matched / m.total;
}

function withDetail(score: CaseScore, detail: string | undefined): CaseScore {
  return detail ? { ...score, detail } : score;
}

/** Default scorer: a full subset match passes. */
export function defaultScorer(golden: GoldenCase, output: unknown): CaseScore {
  const m = matchSubset(golden.expected, output);
  const ratio = matchRatio(m);
  return withDetail(
    {
      verdict: m.mismatches.length === 0 ? 'pass' : 'fail',
      score: ratio,
      scores: { match: ratio, matched: m.matched, total: m.total },
    },
    m.mismatches.length > 0 ? `mismatch: ${m.mismatches.join(', ')}` : undefined,
  );
}

/**
 * Extraction scorer — the default match plus a hard negation check:
 * a golden `polarity: 'negated'` must survive into the candidate
 * (§15.9 "negations/qualifiers must survive").
 */
export function extractionScorer(
  golden: GoldenCase,
  output: unknown,
): CaseScore {
  const base = defaultScorer(golden, output);
  const expectedPolarity = golden.expected['polarity'];
  const actualPolarity = isPlainObject(output) ? output['polarity'] : undefined;
  const negationExpected = expectedPolarity === 'negated';
  const negationPreserved =
    !negationExpected || actualPolarity === 'negated' ? 1 : 0;
  const scores = { ...base.scores, negation_preserved: negationPreserved };
  const verdict =
    base.verdict === 'pass' && negationPreserved === 1 ? 'pass' : 'fail';
  const detail =
    negationExpected && negationPreserved === 0
      ? 'negation not preserved'
      : base.detail;
  return withDetail({ ...base, verdict, scores }, detail);
}

interface Findings {
  findings?: unknown;
}

function findingsOf(value: unknown): unknown[] {
  const obj = value as Findings | null | undefined;
  const list = obj && typeof obj === 'object' ? obj.findings : undefined;
  return Array.isArray(list) ? list : [];
}

/**
 * Review scorer — true/false-positive rates over the finding set:
 * `recall` = expected findings surfaced, `precision` = surfaced
 * findings that were expected. A perfect (precision & recall = 1)
 * candidate passes.
 */
export function reviewScorer(golden: GoldenCase, output: unknown): CaseScore {
  const expected = findingsOf(golden.expected);
  const actual = findingsOf(output);
  let matchedExpected = 0;
  for (let i = 0; i < expected.length; i++) {
    if (actual.some((a) => fullMatch(expected[i], a, `$.findings[${i}]`))) {
      matchedExpected++;
    }
  }
  const matchedActual = actual.filter((a) =>
    expected.some((e, i) => fullMatch(e, a, `$.findings[${i}]`)),
  ).length;
  const recall = expected.length === 0 ? 1 : matchedExpected / expected.length;
  const precision = actual.length === 0 ? 1 : matchedActual / actual.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const verdict = precision === 1 && recall === 1 ? 'pass' : 'fail';
  const detail =
    verdict === 'pass'
      ? undefined
      : `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`;
  return withDetail(
    { verdict, score: f1, scores: { precision, recall, f1 } },
    detail,
  );
}

function normalizeQuestion(q: unknown): string {
  const text = isPlainObject(q) ? q.text : q;
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Fraction of emitted questions that are duplicates of an earlier one. */
export function repeatQuestionRate(questions: unknown): number {
  if (!Array.isArray(questions) || questions.length === 0) return 0;
  const seen = new Set<string>();
  let repeats = 0;
  for (const q of questions) {
    const key = normalizeQuestion(q);
    if (seen.has(key)) repeats++;
    else seen.add(key);
  }
  return repeats / questions.length;
}

/**
 * Questions scorer — the default match plus the repeat-question rate
 * over the candidate's question list (a repeated question is never
 * useful; §15.9).
 */
export function questionsScorer(
  golden: GoldenCase,
  output: unknown,
): CaseScore {
  const base = defaultScorer(golden, output);
  const questions = isPlainObject(output) ? output['questions'] : undefined;
  const repeat_rate = repeatQuestionRate(questions);
  return {
    ...base,
    scores: { ...base.scores, repeat_question_rate: repeat_rate },
  };
}

/** Scorer registry — `rs-draft`/`coverage` use the default fidelity match. */
export const FAMILY_SCORERS: Record<
  string,
  (golden: GoldenCase, output: unknown) => CaseScore
> = {
  extraction: extractionScorer,
  questions: questionsScorer,
  review: reviewScorer,
};

/** Resolve the scorer for a family, defaulting to the subset match. */
export function scorerFor(
  family: string,
): (golden: GoldenCase, output: unknown) => CaseScore {
  return FAMILY_SCORERS[family] ?? defaultScorer;
}

/** Score one case under its family's scorer. */
export function scoreCase(
  family: string,
  golden: GoldenCase,
  output: unknown,
): CaseScore {
  return scorerFor(family)(golden, output);
}
