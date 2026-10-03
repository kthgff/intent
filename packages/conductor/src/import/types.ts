/**
 * Importer contract types (PRD "Importing": tracker → []NormalizedTicket →
 * MD emitter). v1 ships the `github` source only — the contract seam
 * (`ImportSource`, `RawIssue`) leaves room for jira/linear without
 * changing materialize/preview.
 */

/** Raw issue as returned by a tracker adapter, pre-normalization. */
export interface RawIssue {
  /** Tracker key number — the ticket id preserves it (`GH-<number>`). */
  number: number;
  title: string;
  body: string;
  /** Label names (already flattened from gh's [{name}] shape). */
  labels: string[];
  url: string;
  /** Milestone title, if any. */
  milestone: string | null;
  state: string;
  /** `owner/repo` the issue was fetched from. */
  repo: string;
}

export type ImportSource = 'github';

/** Structured fetch failure — never a throw (fail-closed, IMPORT-FAILED
 *  carries `reason` verbatim). */
export type FetchFailureReason =
  | 'gh-missing'
  | 'token-missing'
  | 'auth-failed'
  | 'fetch-failed';

export interface FetchError {
  reason: FetchFailureReason;
  detail: string;
}

export type FetchIssuesResult =
  | { ok: true; issues: RawIssue[] }
  | { ok: false; error: FetchError };

/** The two sentinels an `import:<source>` run can emit (CONDUCTOR
 *  sentinel→transition table). */
export type ImportOutcome =
  | { sentinel: 'IMPORTED'; arg: string; imported: string[] }
  | { sentinel: 'IMPORT-FAILED'; arg: string };
