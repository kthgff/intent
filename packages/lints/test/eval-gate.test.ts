import type { EvalRunRow } from '@sprint-runner/core';
import { describe, expect, it } from 'vitest';
import {
  evaluatePromotionGate,
  evaluateRegistryChange,
  needsRegressionRerun,
} from '../src/index.js';

function runRow(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    workspace: 'ws',
    eval_run_id: 'er-1',
    family: 'extraction',
    model: 'm1',
    status: 'completed',
    metrics: { pass_rate: 0.9 },
    created_at: '2026-10-05T00:00:00Z',
    ...overrides,
  };
}

describe('evaluatePromotionGate', () => {
  it('allows a candidate that clears its threshold', () => {
    const d = evaluatePromotionGate({
      family: 'extraction',
      route: { model: 'm1', eval_threshold: 0.8 },
      run: runRow(),
    });
    expect(d.allowed).toBe(true);
    expect(d.threshold).toBe(0.8);
    expect(d.reasons).toEqual([]);
  });

  it('blocks a failing candidate', () => {
    const d = evaluatePromotionGate({
      family: 'extraction',
      route: { model: 'm1', eval_threshold: 0.8 },
      run: runRow({ metrics: { pass_rate: 0.5 } }),
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/pass_rate 0\.500 < threshold 0\.800/);
  });

  it('fails closed with no run', () => {
    const d = evaluatePromotionGate({
      family: 'extraction',
      route: { model: 'm1' },
      run: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/no eval run/);
  });

  it('blocks a run for the wrong family or model', () => {
    const wrongFamily = evaluatePromotionGate({
      family: 'extraction',
      route: { model: 'm1' },
      run: runRow({ family: 'review' }),
    });
    expect(wrongFamily.allowed).toBe(false);
    expect(wrongFamily.reasons.join(' ')).toMatch(/family/);

    const wrongModel = evaluatePromotionGate({
      family: 'extraction',
      route: { model: 'm2' },
      run: runRow(),
    });
    expect(wrongModel.allowed).toBe(false);
    expect(wrongModel.reasons.join(' ')).toMatch(/model/);
  });

  it('blocks a run that is not completed', () => {
    const d = evaluatePromotionGate({
      family: 'extraction',
      route: { model: 'm1' },
      run: runRow({ status: 'running' }),
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/not completed/);
  });

  it('checks prompt and policy versions when supplied', () => {
    const d = evaluatePromotionGate({
      family: 'extraction',
      route: { model: 'm1' },
      run: runRow({ prompt_version: 'p1', policy_version: 'pol1' }),
      promptVersion: 'p2',
      policyVersion: 'pol1',
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/prompt_version/);
  });

  it('raises the floor for security/requirements families', () => {
    const d = evaluatePromotionGate({
      family: 'security',
      route: { model: 'm1', eval_threshold: 0.8 },
      run: runRow({ family: 'security', metrics: { pass_rate: 0.9 } }),
    });
    expect(d.threshold).toBe(0.95);
    expect(d.allowed).toBe(false);
  });

  it('accepts a summary in place of stored metrics', () => {
    const d = evaluatePromotionGate({
      family: 'extraction',
      route: { model: 'm1' },
      run: runRow({ metrics: null }),
      summary: {
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
        pass_rate: 1,
        score: 1,
      },
    });
    expect(d.allowed).toBe(true);
    expect(d.threshold).toBe(0.8);
  });
});

describe('needsRegressionRerun', () => {
  it('always reruns the first promotion', () => {
    expect(needsRegressionRerun(null, { primary: 'a' }).rerun).toBe(true);
  });

  it('is quiet when the revision is unchanged', () => {
    const d = needsRegressionRerun(
      { primary: 'a', fallback: ['b'], providers: ['x'] },
      { primary: 'a', fallback: ['b'], providers: ['x'] },
    );
    expect(d.rerun).toBe(false);
  });

  it('detects model, provider, prompt and policy changes', () => {
    expect(
      needsRegressionRerun({ primary: 'a' }, { primary: 'b' }).reasons,
    ).toContain('model-changed');
    expect(
      needsRegressionRerun(
        { primary: 'a', providers: ['x'] },
        { primary: 'a', providers: ['y'] },
      ).reasons,
    ).toContain('provider-changed');
    expect(
      needsRegressionRerun(
        { primary: 'a', prompt_version: 'v1' },
        { primary: 'a', prompt_version: 'v2' },
      ).reasons,
    ).toContain('prompt-version-changed');
    expect(
      needsRegressionRerun(
        { primary: 'a', policy_version: 'p1' },
        { primary: 'a', policy_version: 'p2' },
      ).reasons,
    ).toContain('policy-version-changed');
  });
});

describe('evaluateRegistryChange', () => {
  it('combines the gate with the rerun trigger', () => {
    const d = evaluateRegistryChange({
      kind: 'extraction',
      family: 'extraction',
      proposed: { primary: 'm2', fallback: [], providers: [] },
      route: { model: 'm2', eval_threshold: 0.8 },
      run: runRow({ model: 'm2' }),
    });
    expect(d.allowed).toBe(true);
    expect(d.rerun_required).toBe(true);
    expect(d.rerun_reasons).toContain('no previous revision — first promotion');
  });
});
