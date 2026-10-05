/**
 * @sprint-runner/lints — AI Evaluation Lab (PRD §15.12, wp-156).
 *
 * Golden sets, the offline bake-off runner, scoring, and the promotion
 * gate that lets a model/prompt change ship only after passing its eval
 * threshold. Pure functions + a pluggable executor seam; the caller
 * persists through `Store` (`eval_runs`/`eval_cases`/`eval_results`).
 */
export {
  type EvalRunOptions,
  type EvalRunOutcome,
  type EvalStore,
  createEvalRun,
  deriveEvalRunId,
  executeCase,
  passRateOf,
  persistEvalOutcome,
  runEval,
  summarizeResults,
  summaryToMetrics,
  verdictCounts,
} from './engine.js';
export {
  mutatingExecutor,
  recordedExecutor,
  staticExecutor,
} from './executors.js';
export {
  type RegistryChangeInput,
  type RegistryGateDecision,
  type PromotionDecision,
  type PromotionGateInput,
  type RerunDecision,
  type RouteRevision,
  evaluatePromotionGate,
  evaluateRegistryChange,
  needsRegressionRerun,
} from './gate.js';
export {
  GoldenSetError,
  goldenSetFromCases,
  goldenSetToCases,
  loadGoldenCorpus,
  loadGoldenSet,
  parseGoldenSet,
} from './golden.js';
export {
  FAMILY_SCORERS,
  type SubsetMatch,
  defaultScorer,
  extractionScorer,
  matchRatio,
  matchSubset,
  questionsScorer,
  repeatQuestionRate,
  reviewScorer,
  scoreCase,
  scorerFor,
} from './scoring.js';
export type {
  Awaitable,
  CaseScore,
  EvalCandidate,
  EvalExecutor,
  EvalSummary,
  GoldenCase,
  GoldenSet,
} from './types.js';
export {
  type WizardMetrics,
  type WizardQuestion,
  type WizardSession,
  aggregateWizardMetrics,
  wizardSessionMetrics,
} from './wizard.js';
