/**
 * Import source identity (wp-139, PRD §15.3).
 *
 * Imported items keep the original tracker system + id. `tickets.source`
 * already carries the key (`github:<owner>/<repo>#<n>`); `source_ref`
 * extends it to a structured json — `{system, kind, url, imported_at,
 * original_status}` — so reconciliation can compare an imported artifact
 * against its source of record without guessing.
 *
 * "GitHub issues ≠ PRs distinguished": a GitHub pull-request URL is
 * `/pull/<n>` (issues are `/issues/<n>`); {@link issueKind} classifies
 * from the URL when the fetcher didn't already mark the kind.
 */
import type { SourceRef } from '@sprint-runner/core';
import type { RawIssue } from './types.js';

/** `issue | pull-request` for a raw tracker row. Explicit `kind` wins;
 *  otherwise a `/pull/` URL segment marks a pull request. */
export function issueKind(issue: RawIssue): 'issue' | 'pull-request' {
  if (issue.kind) return issue.kind;
  return /\/pull\/\d+/.test(issue.url) ? 'pull-request' : 'issue';
}

/** Build the structured `source_ref` persisted on the ticket row. */
export function sourceRefFor(issue: RawIssue, importedAt: string): SourceRef {
  return {
    system: 'github',
    kind: issueKind(issue),
    url: issue.url || null,
    imported_at: importedAt,
    original_status: issue.state || null,
  };
}
