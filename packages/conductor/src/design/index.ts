/**
 * design/ — the wp-149 design-artifact engine (PRD §15.4).
 *
 * Structured mockups as the source of truth: the `mockup.json`
 * component-tree contract (parse/lint/structural-diff/render),
 * design approvals bound to a mockup revision with PARTIAL invalidation
 * on material change, the deterministic screen-state generator,
 * design-system ingestion, and advisory post-merge `design-drift`
 * findings. The prompt stages (`mockup`, `design-ingest`) render through
 * `@veto/prompts`; this engine owns the rules over the rows.
 */
export {
  checklistComplete,
  type DesignApprovalState,
  designApprovalState,
  type InvalidateResult,
  invalidateAffectedApprovals,
  listDesignApprovals,
  loadMockup,
  type RecordDesignApprovalResult,
  recordDesignApproval,
  syncDesignApprovals,
} from './approvals.js';
export {
  describeDrift,
  type DesignDriftInput,
  DRIFT_HUMAN_VERDICTS,
  recordDesignDrift,
} from './drift.js';
export {
  type DesignSystemMerge,
  designSystemContext,
  mergeDesignSystems,
  parseDesignSystem,
} from './ingest.js';
export {
  affectedAcs,
  componentIndex,
  diffMockups,
  lintMockup,
  MOCKUP_DOC,
  mockupAcs,
  type MockupDiff,
  parseMockup,
  type RenderNode,
  type RequirementCoverage,
  requirementCoverage,
  screenTree,
  visualAcEdges,
} from './mockup.js';
export {
  expandScreenStates,
  screenStates,
  stateSuffix,
} from './states.js';
export {
  badRequest,
  conflict,
  type DesignCtx,
  DesignError,
  designApprovalId,
  driftFindingId,
  forbidden,
  invalid,
  notFound,
  stableJson,
} from './types.js';
