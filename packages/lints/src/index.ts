/**
 * @sprint-runner/lints — wp-032 doc lints.
 * Cheap mechanical checks the conductor runs inline in the tick
 * (CONDUCTOR "Runner tasks"). All pure functions: doc text in →
 * violations/score out. Fail-closed: unparseable structured sections
 * produce violations, never guesses (AGENTS.md, SCHEMAS closing rule).
 */
export {
  CASES_COLUMNS,
  COVERAGE_COLUMNS,
  FILE_PLAN_COLUMNS,
  type FilePlanRow,
  type LintViolation,
  coverageLint,
  filePlanRows,
  pinnedTable,
} from './coverage.js';
export { structuredDocLint } from './doc-lint.js';
export * from './eval/index.js';
export { type FilePlanDiffResult, filePlanVsDiff } from './file-plan.js';
export {
  type FindingInput,
  type Fingerprint,
  LINE_TOLERANCE,
  type Thread,
  fingerprint,
  fingerprintTextHash,
  matchThread,
  normalizeFindingText,
  threadIdFor,
} from './fingerprint.js';
export { type SpecLintResult, renderSpecLint, specLint } from './spec-lint.js';
