/**
 * merge/exec.ts — merge execution (DELIVERY §2 "Execution", wp-133).
 *
 * Once the readiness checklist is green the Merge Center executes the
 * merge itself: `gh pr merge --<merge_strategy>` — and `--auto` when
 * the repo runs a merge queue (enqueue counts as execution; the
 * confirmation arrives on a later shepherd poll). Two hard rules:
 *
 *   1. NEVER bypass branch protection. `gh pr merge` is called without
 *      any `--admin`/bypass flag; when protection blocks the merge
 *      (mergeStateStatus BLOCKED/DIRTY, mergeable CONFLICTING) the
 *      executor surfaces a gate item and stops.
 *   2. A git conflict → a `merge_conflict` gate item + a `rebase` run.
 *      The rebase run is the ONLY path that rewrites the branch (it
 *      owns the force-push policy); the Merge Center never force-pushes.
 */
import type { MergeStrategy, TicketRepoRow, TicketRow } from '@sprint-runner/core';
import { GitError, git } from '@sprint-runner/gitops';
import type { TransitionTools } from '../contracts.js';
import type { MergeCtx, MergeRowOutcome } from './types.js';

/** Injectable git runner — the "existing exec seam" for tests. */
export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }>;

/** Default git runner — shells the real `git` (AGENTS.md: never
 *  isomorphic-git); a failure is returned, not thrown. */
export const defaultGitRun: GitRunner = async (args, cwd) => {
  try {
    const r = await git(args, { cwd });
    return { ok: true, stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const g = e as GitError;
    return {
      ok: false,
      stdout: g.stdout ?? '',
      stderr: g.stderr ?? (e as Error).message,
      exitCode: g.exitCode ?? null,
    };
  }
};

/** Result of a `git merge-tree` conflict probe. */
export interface ConflictProbe {
  conflict: boolean;
  detail?: string;
}

/**
 * Probe whether the worktree's HEAD merges cleanly into `base` using
 * `git merge-tree --write-tree` (no working-tree mutation, no merge
 * commit — a pure in-memory three-way merge). `origin/<base>` is
 * preferred when present; a probe that cannot run (missing ref, old
 * git) is reported as clean — GitHub's own `mergeable` state is the
 * authoritative backstop (the `branch-protection` checklist item).
 */
export async function probeConflict(
  worktree: string,
  base: string,
  gitRun: GitRunner = defaultGitRun,
): Promise<ConflictProbe> {
  const hasOrigin = await gitRun(
    ['rev-parse', '--verify', '--quiet', `origin/${base}`],
    worktree,
  );
  const baseRef = hasOrigin.ok ? `origin/${base}` : base;
  const r = await gitRun(
    ['merge-tree', '--write-tree', baseRef, 'HEAD'],
    worktree,
  );
  if (r.ok) return { conflict: false };
  if (r.exitCode === 1) {
    const detail = [...r.stdout.split('\n'), ...r.stderr.split('\n')]
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(' | ');
    return { conflict: true, detail: detail || 'merge-tree reports conflicts' };
  }
  // Probe could not run (bad ref / old git) — report clean; the
  // branch-protection item still gates a genuinely conflicting PR.
  return { conflict: false, detail: `probe skipped: ${r.stderr.trim()}` };
}

export interface ExecuteMergeArgs {
  ctx: MergeCtx;
  ticket: TicketRow;
  rows: TicketRepoRow[];
  tools: TransitionTools;
  /** `--squash` | `--merge` | `--rebase` (SETTINGS merge_strategy). */
  strategy: MergeStrategy;
  /** Injectable git runner for the conflict probe (tests). */
  gitRun?: GitRunner;
}

/**
 * Execute the merge for every not-yet-merged `ticket_repos` row.
 * Returns the per-row outcome. Never throws for a merge that GitHub
 * rejects — the block is surfaced as a gate item + outcome.
 */
export async function executeMerge(
  args: ExecuteMergeArgs,
): Promise<MergeRowOutcome[]> {
  const { ctx, ticket, rows, tools, strategy } = args;
  const { deps, ws, gh } = ctx;
  const id = ticket.ticket_id;
  const outcomes: MergeRowOutcome[] = [];

  for (const row of rows) {
    if (!row.pr_url || row.pr_state === 'merged' || row.pr_state === 'closed')
      continue;

    let info: Awaited<ReturnType<typeof gh.prView>> | undefined;
    try {
      info = await gh.prView(row.pr_url);
    } catch {
      info = undefined;
    }

    // ---- git conflict probe → merge_conflict gate + rebase run ----
    if (row.worktree) {
      const base = info?.baseRefName ?? 'main';
      const probe = await probeConflict(row.worktree, base, args.gitRun);
      if (probe.conflict) {
        await tools.appendEvent({
          ticketId: id,
          event: 'merge_conflict',
          data: {
            repo: row.repo,
            pr_url: row.pr_url,
            base,
            detail: probe.detail ?? null,
          },
        });
        await tools.surfaceGateItem({
          subject: id,
          gate: 'merge_conflict',
          kind: 'escalation',
          blockedAgent: true,
          payload: {
            repo: row.repo,
            pr_url: row.pr_url,
            base,
            detail: probe.detail ?? null,
          },
        });
        // The rebase run owns the branch rewrite (force-push policy) —
        // the Merge Center never force-pushes (DELIVERY §2).
        await tools.requestRun({
          workspace: ws.name,
          subject: id,
          stage: 'rebase',
          ticketId: id,
          tokens: { MERGE_CONFLICT_BASE: base },
        });
        outcomes.push({
          repo: row.repo,
          kind: 'conflict',
          detail: probe.detail ?? 'merge conflict',
        });
        continue;
      }
    }

    // ---- branch protection (never bypass) ----
    const status = (info?.mergeStateStatus ?? '').toUpperCase();
    const mergeable = (info?.mergeable ?? '').toUpperCase();
    if (status === 'BLOCKED' || status === 'DIRTY' || mergeable === 'CONFLICTING') {
      await tools.surfaceGateItem({
        subject: id,
        gate: 'merge',
        kind: 'escalation',
        blockedAgent: true,
        payload: {
          repo: row.repo,
          pr_url: row.pr_url,
          merge_state_status: status || null,
          mergeable: mergeable || null,
          reason: 'branch protection blocks the merge',
        },
      });
      outcomes.push({
        repo: row.repo,
        kind: 'blocked',
        detail: `branch protection: ${status || mergeable}`,
      });
      // Protection is authoritative — do not attempt, do not bypass.
      break;
    }

    // ---- execute ----
    let auto = false;
    try {
      auto = await gh.mergeQueue(row.pr_url);
    } catch {
      auto = false;
    }
    try {
      await gh.prMerge(row.pr_url, { strategy, auto });
    } catch (e) {
      await tools.surfaceGateItem({
        subject: id,
        gate: 'merge',
        kind: 'escalation',
        blockedAgent: true,
        payload: {
          repo: row.repo,
          pr_url: row.pr_url,
          reason: `gh pr merge failed: ${(e as Error).message}`,
        },
      });
      outcomes.push({
        repo: row.repo,
        kind: 'blocked',
        detail: (e as Error).message,
      });
      break;
    }
    await tools.appendEvent({
      ticketId: id,
      event: 'merge_attempted',
      data: {
        repo: row.repo,
        pr_url: row.pr_url,
        strategy,
        auto,
        head_sha: info?.headRefOid ?? null,
      },
    });

    // ---- confirm (non-queue merges synchronously; --auto enqueues) ----
    if (auto) {
      outcomes.push({ repo: row.repo, kind: 'queued', pr_url: row.pr_url });
      continue;
    }
    let mergedSha: string | null = null;
    try {
      const after = await gh.prView(row.pr_url);
      if (after.state.toUpperCase() === 'MERGED') {
        mergedSha = after.mergeCommit?.oid ?? null;
      }
    } catch {
      /* confirmation deferred to the next shepherd poll */
    }
    if (mergedSha !== null) {
      await deps.store.upsertTicketRepo({
        ...row,
        pr_state: 'merged',
        merged_sha: mergedSha,
      });
      outcomes.push({ repo: row.repo, kind: 'merged', sha: mergedSha });
    } else {
      outcomes.push({ repo: row.repo, kind: 'queued', pr_url: row.pr_url });
    }
  }

  return outcomes;
}
