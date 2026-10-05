/**
 * shepherd/checks.ts — PR-check classification shared by the poll loop
 * (wp-051) and the Merge Center readiness checklist (wp-133).
 *
 * `gh pr checks` rows carry both a `bucket` rollup (pass|fail|pending|
 * skipping|cancel) and the raw `state` (SUCCESS|FAILURE|PENDING|…).
 * The two helpers below collapse both spellings so the poll and the
 * checklist agree on what "green" means — a disagreement here would
 * let the Merge Center merge on checks the poll considered failing.
 */
import type { PrCheck } from './gh.js';

/** A check that is red (fail/cancel/error/timeout). */
export function isFailing(c: PrCheck): boolean {
  const b = c.bucket?.toLowerCase();
  const s = c.state?.toUpperCase();
  return (
    b === 'fail' ||
    b === 'cancel' ||
    s === 'FAILURE' ||
    s === 'ERROR' ||
    s === 'CANCELLED' ||
    s === 'TIMED_OUT'
  );
}

/** A check that has not settled yet (pending/queued/in-progress). */
export function isPending(c: PrCheck): boolean {
  const b = c.bucket?.toLowerCase();
  const s = c.state?.toUpperCase();
  return (
    b === 'pending' ||
    s === 'PENDING' ||
    s === 'QUEUED' ||
    s === 'IN_PROGRESS' ||
    s === 'EXPECTED' ||
    s === 'WAITING' ||
    s === 'REQUESTED'
  );
}

/** Green = at least one check, none failing, none pending. */
export function checksGreen(checks: PrCheck[]): boolean {
  return (
    checks.length > 0 && !checks.some(isFailing) && !checks.some(isPending)
  );
}
