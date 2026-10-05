/**
 * merge — the Merge Center (DELIVERY §2, wp-133).
 *
 * Readiness checklist + Veto-executed `gh pr merge` + post-merge
 * bookkeeping. Runs at the tail of the shepherd poll.
 */
export {
  IMPLEMENTATION_NOTE_DOC,
  mergeNoteSection,
  recalcFeatureEvidence,
  recordMerged,
  type RecordMergedArgs,
} from './bookkeeping.js';
export {
  type MergeCenterOptions,
  type MergeCenterReport,
  evaluateMergeCenter,
  runMergeCenter,
} from './center.js';
export {
  countCaseRows,
  evaluateReadiness,
  type ReadinessOptions,
} from './checklist.js';
export {
  type ConflictProbe,
  type ExecuteMergeArgs,
  type GitRunner,
  defaultGitRun,
  executeMerge,
  probeConflict,
} from './exec.js';
export type {
  ChecklistItem,
  MergeCtx,
  MergeReadiness,
  MergeRowOutcome,
} from './types.js';
