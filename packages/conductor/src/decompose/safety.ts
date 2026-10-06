/**
 * decompose/safety.ts — `tickets.parallel_safety` (PRD §15.10, wp-154):
 * the merge-conflict / concurrency verdict computed from the
 * decomposition table.
 *
 *   - `exclusive` — security-sensitive work OR a predicted shared-file
 *     overlap with a sibling (never runs alongside other executions).
 *   - `caution`   — shares a repo with a sibling, disjoint file sets.
 *   - `safe`      — disjoint repos and disjoint file sets.
 *   - `unknown`   — no `## Decomposition` row for the child (the plan
 *     didn't say; conservative claim behavior still applies).
 *
 * Conservative default (ticket text): one AI execution per ticket —
 * the verdict only ever RESTRICTS parallel claims, never widens them.
 */
import type { ParallelSafety } from '@veto/core';
import type { DecompositionRow, SplitChild } from './plan.js';

export function computeParallelSafety(args: {
  children: SplitChild[];
  decomposition: DecompositionRow[];
}): Map<string, ParallelSafety> {
  const { children, decomposition } = args;
  const rows = new Map(decomposition.map((r) => [r.child, r]));
  const out = new Map<string, ParallelSafety>();

  for (const child of children) {
    const row = rows.get(child.label);
    if (!row) {
      out.set(child.label, 'unknown');
      continue;
    }
    if (row.security === 'sensitive') {
      out.set(child.label, 'exclusive');
      continue;
    }
    // Predicted merge conflict: this child's declared shared files
    // intersect a sibling's declared set (same repo+path or a bare
    // path both sides claim).
    const mine = new Set(row.sharedFiles);
    let sharedRepo = false;
    let sharedFile = false;
    for (const sib of children) {
      if (sib.label === child.label) continue;
      if (sib.repos.some((r) => child.repos.includes(r))) sharedRepo = true;
      const theirs = rows.get(sib.label);
      if (theirs?.sharedFiles.some((f) => mine.has(f))) sharedFile = true;
    }
    out.set(
      child.label,
      sharedFile ? 'exclusive' : sharedRepo ? 'caution' : 'safe',
    );
  }
  return out;
}
