/**
 * shepherd — the post-PR loop (CONDUCTOR "Shepherd loop", wp-051).
 * See poll.ts for the behavior contract.
 */
export {
  type DodAttestation,
  type DodRow,
  type DodRowClassified,
  DOD_ATTESTATIONS_DOC,
  manualRowsAttested,
  parseDodRows,
  readDodAttestations,
} from './dod.js';
export {
  GhError,
  type GhClient,
  type PrCheck,
  type PrComment,
  type PrCreateOptions,
  type PrInfo,
  type PrMergeOptions,
  ShellGhClient,
  parsePrUrl,
} from './gh.js';
export { type ShepherdCtx, type ShepherdReport, pollOpenPrs } from './poll.js';
export {
  type PrShepherdState,
  SHEPHERD_STATE_DIR,
  type ShepherdFile,
  emptyShepherdFile,
  loadShepherdFile,
  prState,
  saveShepherdFile,
  shepherdStatePath,
} from './state.js';
