/**
 * review/studio/ — the wp-148 Review Studio engine (PRD §15.8).
 *
 * Semantic layer over the wp-131 store contract: findings lifecycle
 * with permissioned terminal dispositions, semantic comments with
 * out-of-scope → ChangeSet routing, commit-bound append-only
 * decisions (stale-approval on new commits), the "Changes Since Your
 * Review" delta, requirement-first evidence views, and explicit
 * finding↔external mappings (GitHub stays authoritative).
 */
export {
  addComment,
  type AddCommentResult,
  listComments,
  reclassifyComment,
} from './comments.js';
export {
  type ApprovalCurrency,
  type ApprovalState,
  approvalState,
  ensureSession,
  type RecordRevisionResult,
  recordRevision,
  requireSession,
  rollupSessionStatus,
} from './session.js';
export {
  FINDING_MAIN_PATH,
  FINDING_TERMINAL_DISPOSITIONS,
  type FindingActorKind,
  findingHistory,
  transitionBlocked,
  transitionFinding,
  type TransitionResult,
  upsertFinding,
} from './findings.js';
export {
  listDecisions,
  recordDecision,
  type RecordDecisionResult,
} from './decisions.js';
export {
  baselineChanges,
  type ChangesDelta,
  changesSince,
  type RepoDiff,
} from './delta.js';
export {
  evidenceKind,
  linkEvidence,
  listEvidenceLinks,
  listExternalMappings,
  mapExternal,
  type RequirementView,
  requirementView,
  unlinkEvidence,
} from './requirements.js';
export {
  headShaForTicket,
  type StudioSyncReport,
  studioBaseline,
  syncReviewHead,
  syncReviewStudio,
} from './sync.js';
export {
  badRequest,
  baselineKey,
  changesetIdFor,
  conflict,
  forbidden,
  findingIdFor,
  invalid,
  notFound,
  ReviewStudioError,
  reviewIdFor,
  type StudioCtx,
} from './types.js';
