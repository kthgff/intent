import { describe, expect, it } from 'vitest';
import {
  evaluatePromotionGate,
  GoldenSetError,
  goldenSetFromCases,
  goldenSetToCases,
  loadGoldenCorpus,
  loadGoldenSet,
  mutatingExecutor,
  parseGoldenSet,
  recordedExecutor,
  runEval,
} from '../src/index.js';
import { FIXTURE_DIR, route } from './eval-helpers.js';

describe('golden-set corpus', () => {
  it('loads every seeded family', () => {
    const corpus = loadGoldenCorpus(FIXTURE_DIR);
    expect(corpus.map((s) => s.family).sort()).toEqual([
      'coverage',
      'extraction',
      'questions',
      'review',
      'rs-draft',
    ]);
    for (const set of corpus) expect(set.cases.length).toBeGreaterThan(0);
  });

  it('carries the negation/qualifier slices the ticket names', () => {
    const extraction = loadGoldenSet('extraction', FIXTURE_DIR);
    const tags = extraction.cases.flatMap((c) => c.tags ?? []);
    expect(tags).toContain('negation');
    expect(tags).toContain('qualifier');
  });

  it('fails closed on a malformed set', () => {
    expect(() => parseGoldenSet({ family: 'x' })).toThrow(GoldenSetError);
    expect(() =>
      parseGoldenSet({ family: 'x', cases: [{ case_id: '' }] }),
    ).toThrow(GoldenSetError);
    expect(() =>
      parseGoldenSet({ family: 'x', cases: [{ case_id: 'c', input: {} }] }),
    ).toThrow(GoldenSetError);
  });

  it('round-trips cases through eval_cases rows', () => {
    const set = loadGoldenSet('extraction', FIXTURE_DIR);
    const rows = goldenSetToCases(set, 'ws');
    expect(rows[0]?.workspace).toBe('ws');
    const back = goldenSetFromCases('extraction', rows);
    expect(back.cases.map((c) => c.case_id)).toEqual(
      set.cases.map((c) => c.case_id),
    );
  });
});

describe('offline bake-off (acceptance: golden sets run offline)', () => {
  it('a recorded candidate passes every family and the gate promotes it', async () => {
    for (const set of loadGoldenCorpus(FIXTURE_DIR)) {
      const r = route({
        kind: set.family,
        model: 'candidate/model-a',
        eval_threshold: 0.8,
      });
      const outcome = await runEval({
        workspace: 'ws',
        family: set.family,
        route: r,
        golden: set,
        executor: recordedExecutor('candidate/model-a'),
        evalRunId: `er-${set.family}`,
      });
      expect(outcome.run.status).toBe('completed');
      expect(outcome.summary.pass_rate).toBe(1);
      expect(
        evaluatePromotionGate({ family: set.family, route: r, run: outcome.run })
          .allowed,
      ).toBe(true);
    }
  });

  it('blocks a regressed extraction candidate that drops negation', async () => {
    const set = loadGoldenSet('extraction', FIXTURE_DIR);
    const r = route({
      kind: 'extraction',
      model: 'candidate/model-b',
      eval_threshold: 0.8,
    });
    const regressed = mutatingExecutor(
      recordedExecutor('candidate/model-b'),
      (output) => {
        if (
          output &&
          typeof output === 'object' &&
          'polarity' in (output as Record<string, unknown>)
        ) {
          return { ...(output as Record<string, unknown>), polarity: 'affirmed' };
        }
        return undefined;
      },
    );
    const outcome = await runEval({
      workspace: 'ws',
      family: 'extraction',
      route: r,
      golden: set,
      executor: regressed,
      evalRunId: 'er-bad',
    });
    expect(outcome.summary.pass_rate).toBeLessThan(0.8);
    const decision = evaluatePromotionGate({
      family: 'extraction',
      route: r,
      run: outcome.run,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/pass_rate/);
  });
});
