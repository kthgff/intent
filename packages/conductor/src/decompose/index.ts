/**
 * decompose/ — the Work Decomposition Engine + Integration Coordinator
 * (PRD §15.7/§15.10, wp-154).
 *
 *   - `plan.ts`        — the split run's `split-plan.md` read as a
 *     decomposition output (`## Children` + optional `## Contracts` /
 *     `## Decomposition` tables; fail-closed parse).
 *   - `contracts.ts`   — contract-first: `contracts/<name>.json` run
 *     artifacts promoted to `contract.json` doc_versions on consuming
 *     children inside the materialization transaction.
 *   - `safety.ts`      — `tickets.parallel_safety` from the
 *     decomposition table (security-sensitive/shared-file → exclusive,
 *     shared repo → caution, disjoint → safe).
 *   - `readiness.ts`   — `tickets.execution_readiness` over deps +
 *     contracts + knowledge slots + statements.
 *   - `coordinator.ts` — claim-time coordination (exclusive fencing,
 *     shared-file conflict prediction, contract pinning) + post-merge
 *     dependent revalidation.
 */
export {
  CONTRACT_MISSING_GATE,
  type CoordinatorCtx,
  type RevalidationResult,
  coordinateClaim,
  revalidateDependents,
} from './coordinator.js';
export {
  type PromotedContract,
  parseContractArtifact,
  promoteContracts,
  renderContractDoc,
} from './contracts.js';
export {
  type DecompositionPlan,
  type DecompositionRow,
  type PlanContract,
  type SplitChild,
  parseDecompositionPlan,
} from './plan.js';
export {
  type ReadinessResult,
  computeExecutionReadiness,
} from './readiness.js';
export { computeParallelSafety } from './safety.js';
