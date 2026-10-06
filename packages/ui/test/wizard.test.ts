import type { TriageQuestion } from '@veto/core';
import { describe, expect, it } from 'vitest';
import {
  acceptAll,
  answer,
  answersPayload,
  currentQuestion,
  defaultAnswer,
  initWizard,
  openQuestions,
  progress,
  skip,
} from '../src/wizard';

const q = (over: Partial<TriageQuestion>): TriageQuestion => ({
  id: 'q1',
  question: 'Q?',
  why: 'because',
  format: 'single',
  options: [],
  default: null,
  allow_other: false,
  status: 'open',
  answer: null,
  answered_by: null,
  answered_at: null,
  auto: false,
  ...over,
});

describe('wizard state machine', () => {
  const questions = [
    q({
      id: 'a',
      options: [
        { key: 'x', label: 'X' },
        { key: 'y', label: 'Y', recommended: true },
      ],
    }),
    q({ id: 'b', format: 'yesno', default: 'no' }),
    q({ id: 'c', format: 'text' }),
  ];

  it('advances one question at a time', () => {
    let s = initWizard(questions);
    expect(currentQuestion(s)?.id).toBe('a');
    s = answer(s, 'a', 'x');
    expect(currentQuestion(s)?.id).toBe('b');
    expect(progress(s)).toEqual({ done: 1, total: 3 });
  });

  it('recommended option is the default answer', () => {
    expect(defaultAnswer(questions[0] as TriageQuestion)).toBe('y');
    expect(defaultAnswer(questions[1] as TriageQuestion)).toBe('no');
  });

  it('skip = accept (applies the default)', () => {
    const s = skip(initWizard(questions), 'a');
    expect(s.answers.a).toBe('y');
    expect(currentQuestion(s)?.id).toBe('b');
  });

  it('accept-all resolves every open question with defaults', () => {
    const s = acceptAll(initWizard(questions));
    expect(openQuestions(s)).toHaveLength(0);
    expect(s.answers).toEqual({ a: 'y', b: 'no', c: '' });
    expect(progress(s)).toEqual({ done: 3, total: 3 });
  });

  it('does not re-resolve already-resolved questions', () => {
    let s = answer(initWizard(questions), 'a', 'x');
    s = answer(s, 'a', 'y');
    expect(s.answers.a).toBe('x');
  });

  it('skips already-answered questions from the server', () => {
    const s = initWizard([q({ id: 'done', status: 'answered' }), ...questions]);
    expect(currentQuestion(s)?.id).toBe('a');
    expect(progress(s)).toEqual({ done: 1, total: 4 });
  });

  it('produces the {answers} POST payload', () => {
    const s = answer(initWizard(questions), 'a', 'x');
    expect(answersPayload(s)).toEqual({ a: 'x' });
  });
});
