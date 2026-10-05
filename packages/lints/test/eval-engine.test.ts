import { describe, expect, it } from 'vitest';
import type { EvalCaseRow, EvalResultRow, EvalRunRow } from '@sprint-runner/core';
import {
  createEvalRun,
  deriveEvalRunId,
  executeCase,
  passRateOf,
  persistEvalOutcome,
  recordedExecutor,
  runEval,
  staticExecutor,
  summarizeResults,
  summaryToMetrics,
  verdictCounts,
} from '../src/index.js';
import { route } from './eval-helpers.js';

const GOLDEN = {
  family: 'extraction',
  cases: [
    { case_id: 'c1', input: {}, expected: { a: 1 }, recorded: { a: 1, b: 2 } },
    { case_id: 'c2', input: {}, expected: { a: 1 }, recorded: { a: 9 } },
  ],
};

describe('createEvalRun', () => {
  it('builds a running row recording model + prompt + policy', () => {
    const run = createEvalRun({
      workspace: 'ws',
      family: 'extraction',
      route: route({ model: 'm1' }),
      golden: GOLDEN,
      executor: recordedExecutor('m2'),
      promptVersion: 'p1',
      policyVersion: 'pol1',
      createdBy: 'eval-lab',
      evalRunId: 'er-fixed',
      now: () => '2026-10-05T00:00:00Z',
    });
    expect(run.status).toBe('running');
    expect(run.model).toBe('m1');
    expect(run.prompt_version).toBe('p1');
    expect(run.policy_version).toBe('pol1');
    expect(run.created_at).toBe('2026-10-05T00:00:00Z');
    expect(run.completed_at).toBeNull();
  });

  it('falls back to the executor model when the route pins none', () => {
    const run = createEvalRun({
      workspace: 'ws',
      family: 'extraction',
      route: route({ model: null }),
      golden: GOLDEN,
      executor: recordedExecutor('backend-default'),
      evalRunId: 'er-fixed',
    });
    expect(run.model).toBe('backend-default');
  });

  it('derives a readable run id', () => {
    expect(deriveEvalRunId('extraction', 'anthropic/claude-sonnet-4')).toMatch(
      /^er-extraction-anthropic-claude-sonnet-4-[0-9a-f]{8}$/,
    );
    expect(deriveEvalRunId('review', null)).toMatch(/^er-review-default-/);
  });
});

describe('runEval', () => {
  it('executes every case, scores it, and completes the run', async () => {
    const outcome = await runEval({
      workspace: 'ws',
      family: 'extraction',
      route: route({ model: 'm1' }),
      golden: GOLDEN,
      executor: recordedExecutor('m1'),
      evalRunId: 'er-1',
      now: () => '2026-10-05T00:00:00Z',
    });
    expect(outcome.run.status).toBe('completed');
    expect(outcome.results).toHaveLength(2);
    expect(verdictCounts(outcome.results)).toEqual({ pass: 1, fail: 1, skip: 0 });
    expect(outcome.summary.pass_rate).toBe(0.5);
    expect(outcome.run.metrics?.['pass_rate']).toBe(0.5);
    expect(outcome.run.completed_at).toBe('2026-10-05T00:00:00Z');
  });

  it('records skipped cases and fails a run with nothing scoreable', async () => {
    const outcome = await runEval({
      workspace: 'ws',
      family: 'extraction',
      route: route({ model: 'm1' }),
      golden: { family: 'extraction', cases: [{ case_id: 'c1', input: {}, expected: {} }] },
      executor: recordedExecutor('m1'),
      evalRunId: 'er-skip',
    });
    expect(outcome.results[0]?.verdict).toBe('skip');
    expect(outcome.run.status).toBe('failed');
  });

  it('turns an executor error into a skip with detail', async () => {
    const outcome = await runEval({
      workspace: 'ws',
      family: 'extraction',
      route: route({ model: 'm1' }),
      golden: { family: 'extraction', cases: [{ case_id: 'c1', input: {}, expected: {} }] },
      executor: {
        execute() {
          throw new Error('boom');
        },
      },
      evalRunId: 'er-err',
    });
    expect(outcome.results[0]?.verdict).toBe('skip');
    expect(outcome.results[0]?.detail).toMatch(/executor-error: boom/);
  });

  it('excludes skips from the pass-rate denominator', () => {
    const rows = [
      resultRow('pass'),
      resultRow('pass'),
      resultRow('skip'),
    ];
    const summary = summarizeResults(rows);
    expect(summary.pass_rate).toBe(1);
    expect(summary.skipped).toBe(1);
  });
});

describe('helpers', () => {
  it('executeCase scores a static output', async () => {
    const scored = await executeCase(
      route(),
      staticExecutor({ c1: { a: 1 } }),
      'extraction',
      { case_id: 'c1', input: {}, expected: { a: 1 } },
    );
    expect(scored.verdict).toBe('pass');
    expect(scored.scores['score']).toBe(1);
  });

  it('passRateOf prefers the summary then the stored metrics', () => {
    expect(passRateOf({ metrics: { pass_rate: 0.7 } } as EvalRunRow)).toBe(0.7);
    expect(
      passRateOf(null, {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        pass_rate: 1,
        score: 1,
      }),
    ).toBe(1);
    expect(passRateOf(null)).toBeNull();
  });

  it('summaryToMetrics flattens the summary', () => {
    expect(
      summaryToMetrics({
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        pass_rate: 0.5,
        score: 0.5,
      }),
    ).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, pass_rate: 0.5, score: 0.5 });
  });

  it('persistEvalOutcome writes cases, the run, then results', async () => {
    const runs: EvalRunRow[] = [];
    const cases: EvalCaseRow[] = [];
    const results: EvalResultRow[] = [];
    const store = {
      async upsertEvalRun(row: EvalRunRow) {
        runs.push(row);
      },
      async upsertEvalCase(row: EvalCaseRow) {
        cases.push(row);
      },
      async appendEvalResult(row: EvalResultRow) {
        results.push(row);
      },
    };
    const outcome = await runEval({
      workspace: 'ws',
      family: 'extraction',
      route: route({ model: 'm1' }),
      golden: GOLDEN,
      executor: recordedExecutor('m1'),
      evalRunId: 'er-persist',
    });
    await persistEvalOutcome(store, {
      workspace: 'ws',
      golden: GOLDEN,
      outcome,
    });
    expect(cases).toHaveLength(2);
    expect(runs).toHaveLength(1);
    expect(results).toHaveLength(2);
  });
});

function resultRow(verdict: EvalResultRow['verdict']): EvalResultRow {
  return {
    workspace: 'ws',
    eval_run_id: 'er',
    family: 'extraction',
    case_id: `c-${verdict}`,
    verdict,
    scores: { score: 1 },
    created_at: null,
  };
}
