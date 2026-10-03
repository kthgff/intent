/**
 * shepherd — the post-PR loop (CONDUCTOR "Shepherd loop", wp-051).
 * See poll.ts for the behavior contract.
 */
export {
  type DodAttestation,
  type DodRow,
  type DodRowClassified,
  DOD_ATTESTATIONS_FILE,
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
  ShellGhClient,
  parsePrUrl,
} from './gh.js';
export { type ShepherdCtx, type ShepherdReport, pollOpenPrs } from './poll.js';
export {
  type PrShepherdState,
  SHEPHERD_FILE,
  type ShepherdFile,
  emptyShepherdFile,
  loadShepherdFile,
  prState,
  saveShepherdFile,
} from './state.js';
