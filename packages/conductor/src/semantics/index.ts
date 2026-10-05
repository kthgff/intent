/**
 * Statement Ledger (wp-143, PRD §15.3/§15.9) — the extraction engine +
 * statement lifecycle on top of the wp-131 store tables.
 *
 *   sources (evidence) ──► ingestExtraction ──► statements (proposed,
 *     verbatim spans) + extraction_runs (model/prompt provenance) +
 *     relations + clarifications + decision items
 *
 *   lifecycle: humans confirm/reject/decide; AI proposes/disputes.
 *   authority: resolveAuthority decides conflicts — fail-closed ties
 *   become decision items via openConflictDecisions.
 */
export {
  AUTHORITY_PREDICATES,
  INTENT_AUTHORITY,
  PROVENANCE_AUTHORITY,
  STATUS_AUTHORITY,
  STRENGTH_AUTHORITY,
  type AuthorityReport,
  type ConflictOutcome,
  type ConflictVerdict,
  authorityKey,
  compareAuthority,
  isLive,
  loadStatementGraph,
  openConflictDecisions,
  resolveAuthority,
  resolveEdge,
  resolveScopeAuthority,
} from './authority.js';
export {
  BOARD_TYPE_CONFIG,
  BoardError,
  SPAWN_REF_PREFIX,
  acceptResurface,
  archiveBoard,
  boardSupports,
  boardSurface,
  boardSources,
  boardTypeConfig,
  changeRequestForApprovedItem,
  createBoard,
  createTypedNote,
  deferBoard,
  deferNote,
  extractBoard,
  getSpawnProvenance,
  listOrgBoards,
  listWorkspaceBoards,
  promoteTrayItem,
  proposeResurface,
  referenceApprovedItem,
  resurfaceNote,
  setBoardStatus,
  setNoteStatus,
  spawnWorkspaceFromBoard,
  statementsForItem,
  statementsForItems,
  statementsByItem,
  type ApprovedReference,
  type BoardApproval,
  type BoardCapability,
  type BoardInput,
  type BoardItemSurface,
  type BoardOutput,
  type BoardResurfaceProposal,
  type BoardTypeConfig,
  type ChangeRequestArgs,
  type CreateBoardArgs,
  type ExtractBoardArgs,
  type ExtractBoardResult,
  type ReferenceApprovedArgs,
  type SpawnResult,
  type SpawnWorkspaceArgs,
  type TypedNoteInput,
} from './board.js';
export {
  CONSEQUENTIAL_INTENTS,
  type IngestExtractionArgs,
  type IngestExtractionResult,
  type RunExtractionArgs,
  type SourceSpan,
  ingestExtraction,
  ingestStatementsArtifact,
  isConsequential,
  parseExtractionOutput,
  runExtraction,
  verifySourceSpan,
} from './extract.js';
export {
  answerStatementClarification,
  askStatementClarification,
  confirmStatement,
  decideStatementDecision,
  dismissStatementDecision,
  disputeStatement,
  linkStatementArtifact,
  proposeStatement,
  rejectStatement,
  supersedeStatement,
  unlinkStatementArtifact,
  type DecideStatementArgs,
  type ProposeStatementArgs,
  type TransitionArgs,
} from './lifecycle.js';
export {
  EXTRACT_PROMPT_VERSION,
  type BuildExtractionPromptArgs,
  buildExtractionPrompt,
} from './prompt.js';
export {
  sourceFromBoardItem,
  sourceFromDoc,
  sourceFromImport,
  sourceFromInterviewMessage,
} from './sources.js';
export {
  type ExtractionSource,
  StatementError,
  type StatementActor,
} from './types.js';
