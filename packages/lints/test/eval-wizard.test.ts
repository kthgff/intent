import { describe, expect, it } from 'vitest';
import {
  aggregateWizardMetrics,
  wizardSessionMetrics,
} from '../src/index.js';

describe('wizardSessionMetrics', () => {
  it('computes the four per-session rates', () => {
    const m = wizardSessionMetrics({
      questions: [
        { text: 'What outcome are you after?' },
        { text: 'What outcome are you after?' },
        { text: 'Who uses this?', unnecessary: true },
      ],
      answers: 4,
      corrections: 1,
      binding_requirements: 5,
      supported_requirements: 5,
    });
    expect(m.repeat_question_rate).toBeCloseTo(1 / 3);
    expect(m.unnecessary_question_rate).toBeCloseTo(1 / 3);
    expect(m.correction_rate).toBeCloseTo(0.25);
    expect(m.artifact_fidelity).toBe(1);
  });

  it('flags an unsupported binding requirement', () => {
    const m = wizardSessionMetrics({
      questions: [],
      answers: 1,
      corrections: 0,
      binding_requirements: 4,
      supported_requirements: 3,
    });
    expect(m.artifact_fidelity).toBeCloseTo(0.75);
  });

  it('is faithful when there are no binding requirements', () => {
    const m = wizardSessionMetrics({
      questions: [],
      answers: 0,
      corrections: 0,
    });
    expect(m.artifact_fidelity).toBe(1);
    expect(m.correction_rate).toBe(0);
  });
});

describe('aggregateWizardMetrics', () => {
  it('weights rates by the underlying counts', () => {
    const m = aggregateWizardMetrics([
      {
        questions: [{ text: 'a' }, { text: 'a' }],
        answers: 2,
        corrections: 1,
        binding_requirements: 2,
        supported_requirements: 1,
      },
      {
        questions: [{ text: 'b' }],
        answers: 1,
        corrections: 0,
        binding_requirements: 2,
        supported_requirements: 2,
      },
    ]);
    expect(m.repeat_question_rate).toBeCloseTo(1 / 3);
    expect(m.correction_rate).toBeCloseTo(1 / 3);
    expect(m.artifact_fidelity).toBeCloseTo(3 / 4);
  });
});
