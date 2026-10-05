/**
 * interview/ — the wp-145 Interview Orchestrator (PRD §15.9).
 *
 * One orchestrator powers every wizard. The split is deliberate:
 * deterministic control (permissions, session state, slot states,
 * required confirmations, schema validation, stopping conditions) is
 * application-owned; the LLM only interprets answers (→ statements via
 * the wp-143 ledger) and proposes the next question.
 *
 *   wizard_definitions/versions ──► registerWizard / loadWizardConfig
 *   interview_sessions          ──► startSession / setMode / setStatus
 *   knowledge_slots             ──► slot state machine (slots.ts)
 *   question_candidates         ──► planner (eligibility + scored proposal)
 *   interview_messages          ──► durable transcript (append-only seq)
 *   interview_branches          ──► multi-stakeholder merge w/ attribution
 *   session_snapshots           ──► resume + knowledge-diff briefing
 *   two thresholds              ──► draft_ready ≠ approval_ready
 */
export {
  MVP_WIZARDS,
  REQUIREMENTS_DISCOVERY,
  SOLUTION_DISCOVERY,
  TDD_DISCOVERY,
  WizardConfigSchema,
  initialSlots,
  loadWizardConfig,
  parseWizardConfig,
  registerWizard,
  seedMvpWizards,
  slotSpec,
  thresholdsOf,
} from './wizard.js';
export type { RegisterWizardResult } from './wizard.js';

export {
  TERMINAL_SLOT_STATES,
  bindStatementsToSlots,
  deriveSlotState,
  getSlot,
  isLiveStatement,
  listSlots,
  markSlot,
  openDecisionsForSlots,
  polarityConflicts,
  refreshSlot,
  requireSlotSpec,
} from './slots.js';

export {
  assertAnswerOrder,
  askQuestion,
  computeEligibility,
  getQuestion,
  listQuestions,
  pendingQuestion,
  planNextQuestion,
  resolveQuestion,
  scoreCandidate,
  scoresOf,
  slotStates,
  topProposal,
} from './planner.js';
export type {
  PlanNextQuestionArgs,
  ResolveQuestionStatus,
} from './planner.js';

export {
  appendMessage,
  computeReadiness,
  evaluateReadiness,
  getSession,
  newSessionId,
  pauseSession,
  refreshReadiness,
  requireSession,
  resume,
  resumeSession,
  sessionWizard,
  setMode,
  setStatus,
  snapshot,
  startSession,
  transcript,
} from './session.js';
export type { StartSessionArgs } from './session.js';

export {
  submitAnswer,
  submitPendingAnswer,
} from './answer.js';
export type { SubmitAnswerArgs, SubmitAnswerResult } from './answer.js';

export {
  abandonBranch,
  branchStatements,
  createBranch,
  listBranches,
  mergeBranch,
} from './branches.js';

export {
  INTERVIEW_PROMPT_VERSION,
  QuestionOutputSchema,
  buildQuestionPrompt,
  parseQuestionOutput,
} from './prompt.js';
export type {
  BuildQuestionPromptArgs,
  EligibleSlotForPrompt,
  QuestionOutput,
} from './prompt.js';

export {
  DEFAULT_THRESHOLDS,
  InterviewError,
  asSlotState,
  badRequest,
  conflict,
  invalid,
  notFound,
  questionIdFor,
  sessionIdFor,
  slug,
} from './types.js';
export type {
  BranchAttribution,
  InterviewCtx,
  MergeConflict,
  MergeResult,
  QuestionPurpose,
  QuestionScores,
  ReadinessBlocker,
  ReadinessReport,
  ResumeBriefing,
  SlotState,
  WizardConfig,
  WizardSlotSpec,
  WizardThresholds,
} from './types.js';
