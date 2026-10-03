/**
 * review/discuss.ts — discuss sentinels on finding threads (wp-050;
 * CONDUCTOR discuss rows, SCHEMAS §6 `replies`).
 *
 *   - `REPLIED`       → append the agent's reply to the thread's
 *                       `replies` log (human↔agent discussion).
 *   - `NEEDS-FIX-RUN` → the discuss agent recommends a real code
 *                       change; the runner queues a fix run (the caller
 *                       dispatches `tools.requestRun`). The reply body,
 *                       if any, still lands on the thread.
 */
import type { ReviewDocument, ReviewFinding } from './types.js';

export interface DiscussArgs {
  sentinel: 'REPLIED' | 'NEEDS-FIX-RUN';
  thread_id?: string | undefined;
  body?: string | undefined;
  actor?: string | undefined;
  ts: string;
}

export type DiscussOutcome =
  | { kind: 'appended'; review: ReviewDocument; finding: ReviewFinding }
  | { kind: 'fix-run'; review: ReviewDocument; finding?: ReviewFinding }
  | { kind: 'missing-thread'; review: ReviewDocument };

export function discussReply(
  review: ReviewDocument,
  args: DiscussArgs,
): DiscussOutcome {
  const out: ReviewDocument = structuredClone(review);
  const finding = args.thread_id
    ? out.findings.find((f) => f.thread_id === args.thread_id)
    : undefined;

  if (args.sentinel === 'NEEDS-FIX-RUN') {
    if (finding && args.body) {
      finding.replies.push({
        actor: args.actor ?? 'agent',
        body: args.body,
        ts: args.ts,
      });
    }
    return { kind: 'fix-run', review: out, ...(finding ? { finding } : {}) };
  }

  if (!finding) return { kind: 'missing-thread', review: out };
  finding.replies.push({
    actor: args.actor ?? 'agent',
    body: args.body ?? '',
    ts: args.ts,
  });
  return { kind: 'appended', review: out, finding };
}
