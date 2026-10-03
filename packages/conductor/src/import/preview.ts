/**
 * Preview + normalization heuristics shared by the import run.
 *
 * **Label → priority heuristic** (documented here per wp-061 — first
 *  matching rule wins, default `medium`):
 *   - high:   `p0`, `p1`, `priority:high`, `high`, `critical`, `urgent`,
 *             `blocker`, `sev1`, `sev2`
 *   - low:    `p3`, `p4`, `priority:low`, `low`, `minor`, `trivial`,
 *             `nice-to-have`
 *   - medium: everything else (incl. `p2`, `priority:medium`, no labels)
 *
 * **Label → repo map** (SETTINGS `importers.default_repo_map`): each
 *  issue label is looked up in the map; mapped values populate
 *  `repos[]` (deduped, first-seen order). An issue with NO mapped label
 *  gets `repos: []` + a `repo-map-unmapped` flag — the importer never
 *  guesses a repo (import.md rule 3's "best guess" is an agent-side
 *  behavior; the deterministic importer flags for triage instead).
 */
import type { TicketPriority } from '@sprint-runner/core';
import type { RawIssue } from './types.js';

const HIGH_LABELS = new Set([
  'p0',
  'p1',
  'priority:high',
  'priority/high',
  'high',
  'critical',
  'urgent',
  'blocker',
  'sev1',
  'sev2',
]);
const LOW_LABELS = new Set([
  'p3',
  'p4',
  'priority:low',
  'priority/low',
  'low',
  'minor',
  'trivial',
  'nice-to-have',
]);

export function priorityFromLabels(labels: string[]): TicketPriority {
  const lower = labels.map((l) => l.trim().toLowerCase());
  if (lower.some((l) => HIGH_LABELS.has(l))) return 'high';
  if (lower.some((l) => LOW_LABELS.has(l))) return 'low';
  return 'medium';
}

/** `GH-<number>` — imported tickets keep tracker keys (CONDUCTOR
 *  "Imported tickets keep tracker keys"). */
export function ticketIdFor(issue: RawIssue): string {
  return `GH-${issue.number}`;
}

/** `github:<owner>/<repo>#<n>` source key (PRD source: frontmatter). */
export function sourceFor(issue: RawIssue): string {
  return `github:${issue.repo}#${issue.number}`;
}

export function reposFor(
  issue: RawIssue,
  repoMap: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const label of issue.labels) {
    const repo = repoMap[label];
    if (repo && !out.includes(repo)) out.push(repo);
  }
  return out;
}

/** Flags surfaced in `## Notes` and the preview table. */
export function flagsFor(issue: RawIssue, repos: string[]): string[] {
  const flags: string[] = [];
  if (issue.labels.length > 0 && repos.length === 0) {
    flags.push('repo-map-unmapped');
  }
  if (issue.labels.length === 0) flags.push('no-labels');
  if (issue.body.trim().length === 0) flags.push('empty-body');
  return flags;
}

/** One preview-table row (UI/API shows these before confirming a run). */
export interface PreviewRow {
  id: string;
  title: string;
  source: string;
  url: string;
  labels: string[];
  milestone: string | null;
  priority: TicketPriority;
  repos: string[];
  flags: string[];
}

export function preview(
  issues: RawIssue[],
  repoMap: Record<string, string> = {},
): PreviewRow[] {
  return issues.map((issue) => {
    const repos = reposFor(issue, repoMap);
    return {
      id: ticketIdFor(issue),
      title: issue.title,
      source: sourceFor(issue),
      url: issue.url,
      labels: issue.labels,
      milestone: issue.milestone,
      priority: priorityFromLabels(issue.labels),
      repos,
      flags: flagsFor(issue, repos),
    };
  });
}
