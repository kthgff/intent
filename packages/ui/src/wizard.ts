/**
 * Q&A wizard state machine (S-04, UI-INVENTORY WF-03).
 *
 * One question per card. `skip = accept` — skipping applies the
 * question's default/recommended answer (SCHEMAS §5 `auto`). Accept-all
 * fills every remaining open question with its default. Pure module —
 * screens render it, tests drive it directly.
 */
import type { TriageQuestion } from '@veto/core';

export interface WizardState {
  questions: TriageQuestion[];
  /** answers collected this session, keyed by question id */
  answers: Record<string, string | string[]>;
  /** ids resolved this session (answered or skipped) */
  resolved: string[];
}

export function initWizard(questions: TriageQuestion[]): WizardState {
  return { questions, answers: {}, resolved: [] };
}

export function isOpen(q: TriageQuestion): boolean {
  return q.status === 'open';
}

export function openQuestions(state: WizardState): TriageQuestion[] {
  return state.questions.filter(
    (q) => isOpen(q) && !state.resolved.includes(q.id),
  );
}

export function currentQuestion(state: WizardState): TriageQuestion | null {
  return openQuestions(state)[0] ?? null;
}

export function progress(state: WizardState): { done: number; total: number } {
  const total = state.questions.length;
  const done = total - openQuestions(state).length;
  return { done, total };
}

/** The answer `skip` applies — recommended option, explicit default,
 *  or the first option (SCHEMAS §5 semantics). */
export function defaultAnswer(q: TriageQuestion): string {
  const recommended = q.options.find((o) => o.recommended);
  if (recommended) return recommended.key;
  if (q.default !== null && q.default !== undefined) return q.default;
  const first = q.options[0];
  if (first) return first.key;
  if (q.format === 'yesno') return 'yes';
  return '';
}

function resolve(
  state: WizardState,
  id: string,
  answer: string | string[],
): WizardState {
  if (state.resolved.includes(id)) return state;
  return {
    ...state,
    answers: { ...state.answers, [id]: answer },
    resolved: [...state.resolved, id],
  };
}

export function answer(
  state: WizardState,
  id: string,
  value: string | string[],
): WizardState {
  return resolve(state, id, value);
}

/** skip = accept: resolves with the default answer. */
export function skip(state: WizardState, id: string): WizardState {
  const q = state.questions.find((x) => x.id === id);
  if (!q) return state;
  return resolve(state, id, defaultAnswer(q));
}

/** Fill every remaining open question with its default answer. */
export function acceptAll(state: WizardState): WizardState {
  let next = state;
  for (const q of openQuestions(state)) {
    next = resolve(next, q.id, defaultAnswer(q));
  }
  return next;
}

/** Payload for POST /tickets/<ref>/answers ({answers} batch). */
export function answersPayload(
  state: WizardState,
): Record<string, string | string[]> {
  return state.answers;
}
