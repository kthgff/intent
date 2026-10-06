/**
 * merge/checklist.ts — the deterministic readiness evaluator
 * (DELIVERY §2 "Readiness checklist", wp-133).
 *
 * Computed per `ticket_repos` row, with no agent involved:
 *
 *   - `approval`          — commit-bound approval freshness (a stale
 *                           approve — one whose head SHA no longer
 *                           matches the PR head — blocks);
 *   - `scope`             — no unresolved spec-deviations;
 *   - `ac-evidence`       — a verification spec with cases, or a
 *                           verify `test-report.json`;
 *   - `checks`            — CI checks green;
 *   - `security`          — security findings resolved / risk-accepted;
 *   - `depends-on`        — every dependency is merged|verifying|released;
 *   - `conflict`          — `git merge-tree` probe against the target
 *                           branch is clean;
 *   - `branch-protection` — GitHub protection does not block the merge
 *                           (`gh pr view` mergeStateStatus / mergeable);
 *   - `dod`               — the DoD merge flag (merge.json) is enabled
 *                           when the ticket declares DoD rows.
 *
 * The evaluator is pure-ish: it reads store rows, the `gh` client, and
 * the git worktree; it writes nothing. `evaluateReadiness` is called by
 * the poll wiring before any merge is attempted.
 */
import type {
  ReviewDecisionRow,
  ReviewFindingRow,
  TicketRepoRow,
  TicketRow,
} from '@veto/core';
import { checksGreen } from '../shepherd/checks.js';
import { dodCheckStatuses, parseDodRows } from '../shepherd/dod.js';
import type { PrCheck, PrInfo } from '../shepherd/gh.js';
import { type GitRunner, probeConflict } from './exec.js';
import type { ChecklistItem, MergeCtx, MergeReadiness } from './types.js';

/** Finding statuses that count as settled (no longer block a merge). */
const SETTLED_FINDING_STATUSES = new Set([
  'resolved',
  'accepted-risk',
  'not-applicable',
  'duplicate',
  'deferred-with-approval',
]);

/** Ticket statuses that satisfy a `depends_on` edge (DELIVERY §2 —
 *  `merged|verifying|released`; D27 post-merge lifecycle). */
const DELIVERED_STATUSES = new Set(['merged', 'verifying', 'released']);

/** Merge flag doc kind (the DoD "merge button" — poll.ts MERGE_FLAG). */
const MERGE_FLAG = 'merge.json';

/** Count `case:` rows in a `## Cases` table of a vs.md doc. */
export function countCaseRows(vsMd: string): number {
  const lines = vsMd.split(/\r?\n/);
  let inCases = false;
  let count = 0;
  for (const line of lines) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      inCases = (h[1] ?? '').trim().toLowerCase() === 'cases';
      continue;
    }
    if (!inCases) continue;
    if (/^\|\s*case[:.]/i.test(line)) count += 1;
  }
  return count;
}

/** One reviewer's latest verdict → approval currency (mirrors the
 *  studio's approvalState without requiring a session row). */
function approvalVerdict(
  decisions: ReviewDecisionRow[],
  headSha: string | null,
): ChecklistItem {
  const label = 'Commit-bound approval';
  if (decisions.length === 0) {
    // No recorded review verdict — GitHub branch protection is the
    // authority (nothing to be stale).
    return { id: 'approval', label, ok: true, detail: 'no review verdict' };
  }
  const byReviewer = new Map<string, ReviewDecisionRow>();
  for (const d of decisions) byReviewer.set(d.reviewer, d);
  const latest = [...byReviewer.values()];
  const requested = latest.some(
    (d) => d.action === 'request-changes' || d.action === 'request-fix',
  );
  const current = latest.some(
    (d) =>
      d.action === 'approve' && (headSha === null || d.head_sha === headSha),
  );
  const stale = latest.filter((d) => d.action === 'approve');
  if (requested) {
    return {
      id: 'approval',
      label,
      ok: false,
      detail: 'changes requested on the current revision',
    };
  }
  if (current) {
    return { id: 'approval', label, ok: true, detail: 'approval current' };
  }
  if (stale.length > 0) {
    const bound = stale.map((d) => d.head_sha).join(', ');
    return {
      id: 'approval',
      label,
      ok: false,
      detail: `stale approval — bound to ${bound}, PR head ${headSha ?? 'unknown'}`,
    };
  }
  // Only comment / send-to-board verdicts — nothing binding, nothing stale.
  return { id: 'approval', label, ok: true, detail: 'no binding approval' };
}

function findingsItem(
  id: 'scope' | 'security',
  label: string,
  findings: ReviewFindingRow[],
): ChecklistItem {
  const relevant = findings.filter((f) =>
    id === 'scope'
      ? f.category === 'spec-deviation'
      : f.category === 'security' || f.security_category != null,
  );
  const unresolved = relevant.filter(
    (f) => !SETTLED_FINDING_STATUSES.has(f.status),
  );
  if (unresolved.length === 0) {
    return { id, label, ok: true, detail: `${relevant.length} settled` };
  }
  return {
    id,
    label,
    ok: false,
    detail: `${unresolved.length} unresolved (${unresolved
      .slice(0, 3)
      .map((f) => f.thread_id ?? f.finding_id)
      .join(', ')})`,
  };
}

/** Options threaded through the evaluator (pre-fetched PR info avoids
 *  a second `gh pr view` per row). */
export interface ReadinessOptions {
  /** repo → `gh pr view` result (already fetched by the poll). */
  prInfos?: Map<string, PrInfo>;
  /** repo → `gh pr checks` result (already fetched by the poll). */
  checksByRepo?: Map<string, PrCheck[]>;
  /** Injectable git runner (tests) — defaults to the real `git`. */
  gitRun?: GitRunner;
}

/**
 * Evaluate the readiness checklist for one ticket. `ready` is true only
 * when every item passes.
 */
export async function evaluateReadiness(
  ctx: MergeCtx,
  ticket: TicketRow,
  rows: TicketRepoRow[],
  opts: ReadinessOptions = {},
): Promise<MergeReadiness> {
  const { deps, ws } = ctx;
  const store = deps.store;
  const id = ticket.ticket_id;
  const at = (deps.now?.() ?? new Date()).toISOString();
  const items: ChecklistItem[] = [];
  const openRows = rows.filter((r) => r.pr_url);

  // ---- fetch `gh pr view` once per open row ----
  const prInfos = new Map(opts.prInfos ?? []);
  const heads: Record<string, string | null> = {};
  const protectionDetails: string[] = [];
  for (const row of openRows) {
    let info: PrInfo | undefined = prInfos.get(row.repo);
    if (!info) {
      try {
        info = await ctx.gh.prView(row.pr_url as string);
        prInfos.set(row.repo, info);
      } catch (e) {
        protectionDetails.push(`${row.repo}: ${(e as Error).message}`);
        info = undefined;
      }
    }
    heads[row.repo] = info?.headRefOid ?? null;
  }

  // ---- approval (commit-bound freshness) ----
  const reviewId = `rv-${id}`;
  const session = await store.getReviewSession({
    workspace: ws.name,
    review_id: reviewId,
  });
  if (session) {
    const decisions = await store.listReviewDecisions({
      workspace: ws.name,
      review_id: reviewId,
    });
    const revision = await store.getReviewRevision({
      workspace: ws.name,
      review_id: reviewId,
    });
    // Prefer the live PR head (a pushed commit staleness signal);
    // fall back to the reviewable head the decisions bound to.
    const firstRow = openRows[0];
    const prHead = firstRow ? (heads[firstRow.repo] ?? null) : null;
    const headSha = prHead ?? revision?.head_sha ?? null;
    items.push(approvalVerdict(decisions, headSha));
  } else {
    items.push({
      id: 'approval',
      label: 'Commit-bound approval',
      ok: true,
      detail: 'no review session',
    });
  }

  // ---- findings: unresolved deviations + security ----
  const findings = session
    ? await store.listReviewFindings({
        workspace: ws.name,
        review_id: reviewId,
      })
    : [];
  items.push(findingsItem('scope', 'No unresolved deviations', findings));
  items.push(findingsItem('security', 'Security findings resolved', findings));

  // ---- AC evidence (vs.md cases or a verify test-report) ----
  const vsDoc = await store.getDoc({
    workspace: ws.name,
    subject: id,
    doc: 'vs.md',
  });
  const caseRows = vsDoc ? countCaseRows(vsDoc.content) : 0;
  const verifyRuns = (
    await store.listRuns({ workspace: ws.name, ticket_id: id })
  ).filter((r) => r.stage === 'verify');
  let reportEvidence = false;
  for (const r of verifyRuns) {
    const art = await store.getArtifact(r.id, 'test-report.json');
    if (art) {
      reportEvidence = true;
      break;
    }
  }
  items.push({
    id: 'ac-evidence',
    label: 'AC evidence present',
    ok: caseRows > 0 || reportEvidence,
    detail:
      caseRows > 0
        ? `${caseRows} verification cases`
        : reportEvidence
          ? 'verify test-report.json'
          : 'no vs.md cases and no verify report',
  });

  // ---- CI checks + branch protection (per row, aggregated) ----
  let checksOk = openRows.length > 0;
  const checkDetails: string[] = [];
  let protectionOk = protectionDetails.length === 0;
  const prefetchedChecks = opts.checksByRepo ?? new Map<string, PrCheck[]>();
  for (const row of openRows) {
    const info = prInfos.get(row.repo);
    try {
      const checks =
        prefetchedChecks.get(row.repo) ??
        (await ctx.gh.prChecks(row.pr_url as string));
      if (!checksGreen(checks)) {
        checksOk = false;
        checkDetails.push(
          `${row.repo}: ${checks.length === 0 ? 'no checks' : 'not green'}`,
        );
      }
    } catch (e) {
      checksOk = false;
      checkDetails.push(`${row.repo}: ${(e as Error).message}`);
    }
    if (info) {
      const status = (info.mergeStateStatus ?? '').toUpperCase();
      const mergeable = (info.mergeable ?? '').toUpperCase();
      if (
        status === 'BLOCKED' ||
        status === 'DIRTY' ||
        mergeable === 'CONFLICTING'
      ) {
        protectionOk = false;
        protectionDetails.push(
          `${row.repo}: ${status || mergeable} (protection blocks merge)`,
        );
      }
    }
  }
  items.push({
    id: 'checks',
    label: 'Checks green',
    ok: checksOk,
    detail: checksOk
      ? `${openRows.length} PR(s) green`
      : checkDetails.join('; '),
  });
  items.push({
    id: 'branch-protection',
    label: 'Branch protection clear',
    ok: protectionOk,
    ...(protectionOk ? {} : { gate: 'merge' as const }),
    detail: protectionOk
      ? 'protection does not block'
      : protectionDetails.join('; '),
  });

  // ---- depends_on satisfied ----
  const unmet: string[] = [];
  for (const dep of ticket.depends_on) {
    const depRow = await store.getTicket({
      workspace: ws.name,
      ticket_id: dep,
    });
    if (!depRow || !DELIVERED_STATUSES.has(depRow.status)) {
      unmet.push(`${dep}:${depRow?.status ?? 'missing'}`);
    }
  }
  items.push({
    id: 'depends-on',
    label: 'Dependencies delivered',
    ok: unmet.length === 0,
    detail:
      unmet.length === 0 ? 'all delivered' : `waiting on ${unmet.join(', ')}`,
  });

  // ---- git merge-tree conflict probe ----
  let conflict = false;
  const conflictDetails: string[] = [];
  for (const row of openRows) {
    if (!row.worktree) continue;
    const base = prInfos.get(row.repo)?.baseRefName ?? 'main';
    const res = await probeConflict(row.worktree, base, opts.gitRun);
    if (res.conflict) {
      conflict = true;
      conflictDetails.push(`${row.repo}: ${res.detail ?? 'conflict'}`);
    }
  }
  items.push({
    id: 'conflict',
    label: 'No merge conflicts',
    ok: !conflict,
    ...(conflict ? { gate: 'merge_conflict' as const } : {}),
    detail: conflict ? conflictDetails.join('; ') : 'merge-tree clean',
  });

  // ---- DoD merge flag + per-check detail (wp-153 DoD engine) ----
  const dodRows = vsDoc ? parseDodRows(vsDoc.content) : [];
  let dodOk = dodRows.length === 0;
  let dodDetail = 'no DoD rows';
  if (dodRows.length > 0) {
    const flagDoc = await store.getDoc({
      workspace: ws.name,
      subject: id,
      doc: MERGE_FLAG,
    });
    dodOk = false;
    let flagDod: { criterion: string; status?: string }[] = [];
    if (flagDoc) {
      try {
        const flag = JSON.parse(flagDoc.content) as {
          enabled?: boolean;
          dod?: { criterion: string; status?: string }[];
        };
        dodOk = flag.enabled === true;
        flagDod = flag.dod ?? [];
      } catch {
        dodOk = false;
      }
    }
    if (dodOk) {
      dodDetail = 'DoD verified/attested';
    } else {
      // Per-check readiness from the attestations doc + the flag's
      // recorded cmd verdicts — unmet checks are NAMED, never a bare
      // "not done" (fail-closed: unattested manual + unverified cmd +
      // unknown verified_by all count as unmet).
      const attestations = await store.getDoc({
        workspace: ws.name,
        subject: id,
        doc: 'dod-attestations.json',
      });
      let attestedCriteria = new Set<string>();
      if (attestations) {
        try {
          const parsed = JSON.parse(attestations.content) as {
            attested?: { criterion?: string }[];
          };
          attestedCriteria = new Set(
            (parsed.attested ?? [])
              .map((a) => a.criterion)
              .filter((c): c is string => typeof c === 'string'),
          );
        } catch {
          attestedCriteria = new Set(); // malformed → nobody attested
        }
      }
      const cmdStatus = new Map(
        flagDod.map((d) => [d.criterion, d.status ?? 'unverified']),
      );
      const checks = dodCheckStatuses(dodRows, {}, []);
      const unmet = checks
        .filter((c) => {
          if (c.kind === 'manual') return !attestedCriteria.has(c.criterion);
          if (c.kind === 'cmd')
            return cmdStatus.get(c.criterion) !== 'verified';
          return true; // unknown verified_by — fail-closed unmet
        })
        .map((c) => c.criterion);
      dodDetail =
        unmet.length === 0
          ? 'checks clear — merge flag not yet enabled'
          : `unmet: ${unmet.slice(0, 4).join(', ')}${unmet.length > 4 ? ` (+${unmet.length - 4})` : ''}`;
    }
  }
  items.push({
    id: 'dod',
    label: 'Definition of Done',
    ok: dodOk,
    detail: dodDetail,
  });

  const blockers = items.filter((i) => !i.ok);
  return {
    ticket_id: id,
    ready: blockers.length === 0,
    items,
    blockers,
    heads,
    at,
  };
}
