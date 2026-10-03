/**
 * file-plan-vs-diff — SCHEMAS §3 file plan vs `git diff --name-only`.
 * Feeds the spec-compliance review pass (CONDUCTOR runner tasks):
 * unplanned = diffed but not planned (spec-deviation signal);
 * missing   = planned but absent from the diff.
 * Fail-closed: an unparseable file plan sets `error` and returns the
 * diff unfiltered so nothing silently passes.
 */
import { filePlanRows } from './coverage.js';

export interface FilePlanDiffResult {
  /** Files in the diff that are not in the TDD file plan. */
  unplanned: string[];
  /** Planned files absent from the diff. */
  missing: string[];
  /** Set when the file plan could not be parsed (fail-closed). */
  error?: string;
}

const normalizePath = (p: string): string =>
  p.trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');

export function filePlanVsDiff(
  tddMd: string,
  diffFiles: string[],
): FilePlanDiffResult {
  const diff = diffFiles.map(normalizePath).filter((p) => p.length > 0);
  const plan = filePlanRows(tddMd);
  if (plan.rows === null) {
    return {
      unplanned: diff,
      missing: [],
      error: plan.violation?.message ?? 'file plan unparseable',
    };
  }
  const planned = new Set(plan.rows.map((r) => normalizePath(r.file)));
  const diffSet = new Set(diff);
  return {
    unplanned: diff.filter((f) => !planned.has(f)),
    missing: [...planned].filter((f) => !diffSet.has(f)),
  };
}
