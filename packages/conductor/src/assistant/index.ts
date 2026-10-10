/**
 * assistant/ — the Board Assistant engine (BOARD-CHAT-PRD/TDD,
 * wp-162).
 *
 * Deterministic control plane over the shared board thread: session
 * get-or-create, run branches, the proposal lifecycle, placement,
 * coverage, and the converse seam. The ONLY LLM surface is the
 * injected `CompletionProvider` on `AssistantCtx` — absent provider →
 * deterministic fallbacks everywhere (verbatim extraction,
 * deterministic planner + critique, fail-loud command mode).
 *
 *   thread.ts     ──► shared session + attributed turns + panel state
 *   runs.ts       ──► /interview + /expand branches → merge + summary
 *   proposals.ts  ──► draft → pending → accept/reject/stale/supersede
 *   placement.ts  ──► computePlacement (pure)
 *   coverage.ts   ──► boardCoverage + critiqueChecks (pure)
 *   skills.ts     ──► skill registry + suggestion chips (pure)
 *   converse.ts   ──► command-mode turn via the provider seam
 *   turn.ts       ──► the message router (pipeline order is contract)
 */
export type { AssistantCtx } from './types.js';
export { activeItems, servesTargetIds } from './types.js';

export {
  appendThreadMessage,
  boardWizardId,
  ensureThread,
  panelState,
  threadSessionId,
} from './thread.js';
export type { AssistantPanelState } from './thread.js';

export {
  activeRunBranch,
  activeRunPending,
  endRun,
  startRun,
} from './runs.js';
export type { RunEnded, RunStarted } from './runs.js';

export {
  acceptProposal,
  acceptProposals,
  applyProposalOp,
  draftProposals,
  parseProposalRow,
  proposalTargetId,
  rejectProposal,
  supersedeForDecision,
} from './proposals.js';
export type { DraftResult } from './proposals.js';

export { PLACE, computePlacement } from './placement.js';
export type { PlacementArgs, Rect } from './placement.js';

export { boardCoverage, critiqueChecks } from './coverage.js';
export type {
  CoverageReport,
  CritiqueFinding,
  CritiqueKind,
} from './coverage.js';

export {
  ASSISTANT_SKILLS_INFO,
  parseSkillCommand,
  suggestChips,
} from './skills.js';
export type { AssistantChip } from './skills.js';

export {
  MALFORMED_REPLY,
  NO_PROVIDER_REPLY,
  converse,
  llmCritiqueFindings,
} from './converse.js';
export type { ConverseResult } from './converse.js';

export { INTENT_TO_NOTE_KIND, postMessage, statementsToOps } from './turn.js';
export type { TurnResult } from './turn.js';
