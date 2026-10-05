/**
 * AI Evaluation Lab — wizard session metrics (PRD §15.12/§15.9, wp-156).
 *
 * The interview wizard emits per-session quality signals: how often it
 * repeats itself, how often the user corrects an answer, how many
 * questions were unnecessary, and how faithful the produced artifact is
 * to the confirmed statements. "Target zero unsupported binding
 * requirements" → artifact fidelity 1.0.
 *
 * Pure: the caller supplies the session summary (from the interview
 * orchestrator, wp-145) and this returns the normalized rates.
 */
import { repeatQuestionRate } from './scoring.js';

/** One question the wizard asked. */
export interface WizardQuestion {
  /** Stable id when available (used for repeat detection). */
  id?: string;
  text: string;
  /** Knowledge slot the question targeted, when known. */
  knowledge_slot?: string;
  /** The slot was already known/inferred — the question was avoidable. */
  unnecessary?: boolean;
}

/** Per-session inputs for the wizard metrics. */
export interface WizardSession {
  /** Questions asked this session, in order. */
  questions: WizardQuestion[];
  /** Answers the user provided. */
  answers: number;
  /** Answers the user later corrected/replaced. */
  corrections: number;
  /** Binding requirements the produced artifact asserts. */
  binding_requirements?: number;
  /** Of those, how many are supported by confirmed statements/evidence. */
  supported_requirements?: number;
}

/** The per-session quality metrics (all normalized 0..1). */
export interface WizardMetrics {
  repeat_question_rate: number;
  correction_rate: number;
  unnecessary_question_rate: number;
  artifact_fidelity: number;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Compute the four wizard metrics for one session. */
export function wizardSessionMetrics(session: WizardSession): WizardMetrics {
  const questions = session.questions;
  const repeat = repeatQuestionRate(
    questions.map((q) => q.id ?? q.text),
  );
  const unnecessary = questions.filter((q) => q.unnecessary === true).length;
  const unnecessaryRate = safeRatio(unnecessary, questions.length);
  const correctionRate = safeRatio(
    Math.max(session.corrections, 0),
    Math.max(session.answers, 0),
  );
  const total = session.binding_requirements ?? 0;
  const supported = session.supported_requirements ?? 0;
  const artifactFidelity = total === 0 ? 1 : Math.min(supported / total, 1);
  return {
    repeat_question_rate: repeat,
    correction_rate: correctionRate,
    unnecessary_question_rate: unnecessaryRate,
    artifact_fidelity: artifactFidelity,
  };
}

/** Aggregate metrics over many sessions — rates are weighted by the
 *  underlying counts so a long session is not diluted by a short one. */
export function aggregateWizardMetrics(
  sessions: WizardSession[],
): WizardMetrics {
  const questionCount = sessions.reduce((n, s) => n + s.questions.length, 0);
  const answers = sessions.reduce((n, s) => n + Math.max(s.answers, 0), 0);
  const corrections = sessions.reduce(
    (n, s) => n + Math.max(s.corrections, 0),
    0,
  );
  const binding = sessions.reduce(
    (n, s) => n + (s.binding_requirements ?? 0),
    0,
  );
  const supported = sessions.reduce(
    (n, s) => n + (s.supported_requirements ?? 0),
    0,
  );

  let repeats = 0;
  let unnecessary = 0;
  for (const s of sessions) {
    const ids = s.questions.map((q) => q.id ?? q.text);
    const unique = new Set(ids.map((x) => x.trim().toLowerCase()));
    repeats += ids.length - unique.size;
    unnecessary += s.questions.filter((q) => q.unnecessary === true).length;
  }

  return {
    repeat_question_rate: safeRatio(repeats, questionCount),
    correction_rate: safeRatio(corrections, answers),
    unnecessary_question_rate: safeRatio(unnecessary, questionCount),
    artifact_fidelity: binding === 0 ? 1 : Math.min(supported / binding, 1),
  };
}
