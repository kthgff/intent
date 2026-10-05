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
export {
  type ExtractedStatementLike,
  type PreservationViolation,
  extractionPreservationLint,
  locateQuote,
  sourceSentences,
} from './extraction.js';
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
export { securityFindingLint } from './security-findings.js';
export {
  canonicalManifestItems,
  type CorrectionFact,
  evaluateReleaseGates,
  isMaterialCorrection,
  MATERIAL_CORRECTION_SEVERITIES,
  RELEASE_GATE_IDS,
  type ReleaseGateCheck,
  type ReleaseGateFacts,
  type ReleaseGateId,
  releaseGatesGreen,
  releaseManifestDigest,
} from './release-gates.js';
