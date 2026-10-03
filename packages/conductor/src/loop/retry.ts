/**
 * Retry ladder policy (CONDUCTOR "Run lifecycle", wp-030).
 *
 * Pure decision function — wp-031 calls it when a sentinel maps to a
 * failure row (`PASS-FAILED`, `PROBE-FAILED`, missing sentinel, etc.)
 * and the conductor calls it on its own `run_failed` path.
 *
 *   transient failure → 1 auto-retry, same config
 *   implement failure → 1 stronger-model retry (`escalation_model`;
 *                       null = the backend's own step-up — SETTINGS)
 *   then → `failed`
 */

export type RetryVerdict =
  | { kind: 'retry'; model: null } // same-config retry
  | { kind: 'retry'; model: string | null; escalation: true } // stronger model
  | { kind: 'exhausted' }; // ladder complete → the ticket goes `failed`

export interface RetryInput {
  stage: string;
  /**
   * True when the failure is plausibly transient (missing/garbage
   * sentinel, nonzero exit, killed, adapter error) — a hard spec
   * failure (`PASS-FAILED` etc.) is NOT transient and skips the
   * same-config step straight to escalation/failed.
   */
  transient: boolean;
  /**
   * Count of FAILED/KILLED runs for the same (subject, stage),
   * INCLUDING the one that just failed.
   */
  failures: number;
  /** SETTINGS `escalation_model` — null → the backend's own step-up. */
  escalationModel?: string | null;
}

/** Stages eligible for the escalation rung (CONDUCTOR: "implement
 *  failure → 1 stronger-model retry"). */
const ESCALATION_STAGES = new Set(['implement']);

/**
 * Ladder:
 *   transient && failures=1 → retry same config
 *   escalation stage && failures=(transient ? 2 : 1) → retry with
 *     escalation_model (null = backend's own step-up)
 *   otherwise → exhausted
 */
export function retryDecision(input: RetryInput): RetryVerdict {
  if (input.failures <= 0) return { kind: 'exhausted' };
  if (input.transient && input.failures === 1) {
    return { kind: 'retry', model: null };
  }
  if (ESCALATION_STAGES.has(input.stage)) {
    // The escalation rung fires after the same-config rung (transient)
    // or immediately (hard failure) — but only once.
    const escalationAt = input.transient ? 2 : 1;
    if (input.failures === escalationAt) {
      return {
        kind: 'retry',
        model: input.escalationModel ?? null,
        escalation: true,
      };
    }
  }
  return { kind: 'exhausted' };
}
