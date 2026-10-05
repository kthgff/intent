import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVAL_THRESHOLD,
  effectiveEvalThreshold,
  evalThresholdsFromRegistry,
  isStrictEvalFamily,
  STRICT_EVAL_FLOOR,
} from '../src/index.js';

describe('effectiveEvalThreshold', () => {
  it('defaults when the route sets none', () => {
    expect(effectiveEvalThreshold('extraction')).toBe(DEFAULT_EVAL_THRESHOLD);
    expect(effectiveEvalThreshold('extraction', null)).toBe(
      DEFAULT_EVAL_THRESHOLD,
    );
  });

  it('honors a per-route threshold', () => {
    expect(effectiveEvalThreshold('extraction', 0.6)).toBe(0.6);
  });

  it('raises the floor for security/requirements families', () => {
    expect(isStrictEvalFamily('security')).toBe(true);
    expect(isStrictEvalFamily('requirements')).toBe(true);
    expect(isStrictEvalFamily('extraction')).toBe(false);
    expect(effectiveEvalThreshold('security', 0.5)).toBe(STRICT_EVAL_FLOOR);
    // a stricter route threshold still wins
    expect(effectiveEvalThreshold('requirements', 0.99)).toBe(0.99);
  });
});

describe('evalThresholdsFromRegistry', () => {
  it('reads eval_threshold from the models registry', () => {
    expect(
      evalThresholdsFromRegistry({
        extraction: { primary: 'm', eval_threshold: 0.7 },
        review: { primary: 'm' },
        security: { primary: 'm', eval_threshold: 0.9 },
      }),
    ).toEqual({ extraction: 0.7, security: 0.9 });
  });

  it('is empty without a registry', () => {
    expect(evalThresholdsFromRegistry()).toEqual({});
  });
});
