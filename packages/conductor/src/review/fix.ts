/**
 * review/fix.ts — FIXES-COMPLETE application + the dismissal cap
 * (wp-050; CONDUCTOR fix row, PRD §7.3, SETTINGS budgets.fix_dismissal_cap).
 *
 * A fix run reports `FIXES-COMPLETE: <f>/<t>` and may self-dismiss
 * findings it claims are not-real — logged in DEVIATIONS.md as
 * `| finding f-xxxx | not fixed | not a real issue: <evidence> |`
 * (fix.md template rule 2).
 *
 * The cap: at most `fix_dismissal_cap` self-dismissals are honored per
 * fix run. Beyond the cap ALL remaining findings escalate to the human
 * — an agent being corrected can't overrule the corrector wholesale.
 * Over-cap dismissal claims stay `open` (never silently dismissed).
 */
import type { ReviewDocument, ReviewFinding } from './types.js';

/** `<f>/<t>` — FIXES-COMPLETE payload (also tolerates prose padding). */
export function parseFixesPayload(
  payload: string,
): { fixed: number; total: number } | null {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(payload);
  if (!m) return null;
  return { fixed: Number(m[1]), total: Number(m[2]) };
}

/** DEVIATIONS.md rows that claim a finding is not-real (fix.md rule 2). */
const DISMISSAL_ROW =
  /\|\s*finding\s+(f-[\w-]+)\s*\|\s*not fixed\s*\|\s*not a real issue/gi;

/** thread_ids the fix run self-dismissed via DEVIATIONS.md. */
export function dismissalClaimsFromDeviations(md: string): string[] {
  return [...md.matchAll(DISMISSAL_ROW)].map((m) => m[1] as string);
}

export interface FixReport {
  /** Raw sentinel payload ("3/5") — recorded for observability. */
  payload?: string;
  /** thread_ids the run claims to have fixed (defaults: every open
   *  finding when `payload` parses and fixed === total… callers that
   *  know better pass explicit ids). */
  fixed_thread_ids?: string[];
  /** thread_ids the run self-dismissed as not-real. */
  dismissed_thread_ids?: string[];
}

export interface FixApplyResult {
  review: ReviewDocument;
  /** Threads marked fixed by this application. */
  fixed: number;
  /** Self-dismissals honored (≤ cap). */
  dismissed: number;
  /** Dismissal claims over the cap — these stay open + escalate. */
  overCap: string[];
  /** True when dismissed claims exceeded the cap → surface an
   *  escalation gate item for the whole batch. */
  escalated: boolean;
}

export function applyFixResults(
  report: FixReport,
  review: ReviewDocument,
  config: { fix_dismissal_cap: number },
  opts: { ts?: string } = {},
): FixApplyResult {
  const out: ReviewDocument = structuredClone(review);
  const byThread = new Map(out.findings.map((f) => [f.thread_id, f]));
  const counts = report.payload ? parseFixesPayload(report.payload) : null;

  // Fixed claims — explicit thread ids win; absent a list, a complete
  // "<f>/<t>" with f===t marks every live finding fixed (except ones
  // the same report claims as dismissals — a dismissal is a rejection
  // of the finding, not a fix).
  const claims = report.dismissed_thread_ids ?? [];
  const claimSet = new Set(claims);
  let fixedIds = report.fixed_thread_ids;
  if (!fixedIds && counts && counts.fixed === counts.total) {
    fixedIds = out.findings
      .filter(
        (f) =>
          (f.status === 'open' || f.status === 'reopened') &&
          !claimSet.has(f.thread_id),
      )
      .map((f) => f.thread_id);
  }
  let fixed = 0;
  for (const id of fixedIds ?? []) {
    const f = byThread.get(id) as ReviewFinding | undefined;
    if (!f) continue;
    if (f.status === 'open' || f.status === 'reopened') {
      f.status = 'fixed';
      fixed += 1;
    }
  }

  // Self-dismissals — honor up to the cap, in claim order.
  const honored = claims.slice(0, Math.max(config.fix_dismissal_cap, 0));
  const overCap = claims.slice(Math.max(config.fix_dismissal_cap, 0));
  const ts = opts.ts ?? '';
  for (const id of honored) {
    const f = byThread.get(id) as ReviewFinding | undefined;
    if (!f) continue;
    if (f.status === 'open' || f.status === 'reopened') {
      f.status = 'dismissed';
      f.replies.push({
        actor: 'fix',
        body: 'self-dismissed: claimed not-real (see DEVIATIONS.md)',
        ts,
      });
    }
  }
  return {
    review: out,
    fixed,
    dismissed: honored.length,
    overCap,
    escalated: overCap.length > 0,
  };
}
