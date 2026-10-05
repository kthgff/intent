/**
 * launch/baseline.ts — run baseline pinning (PRD §15.5, wp-141).
 *
 * Every run records the concrete spec versions it works against on
 * `runs.request.baseline` (RunBaselineSchema): the rs/design/contract
 * `doc_versions` heads, the ticket revision, the AC set, and the base
 * commit. The launch path resolves doc HEADS to concrete versions at
 * pin time — a running agent NEVER re-resolves "latest" and never
 * silently adopts a newer spec. A queued pending row keeps its pin
 * across the queue→claim relaunch (no retro-edit of the pinned set);
 * `reconcile/baseline.ts` owns mid-run drift detection.
 */
import {
  type RunBaseline,
  RunBaselineSchema,
  type RunRow,
  type Store,
} from '@sprint-runner/core';
import { git } from '@sprint-runner/gitops';

/** AC tokens the baseline pins (`AC-1`, `ac:login-2` spellings) —
 *  best-effort extraction from the spec text (mirrors the review
 *  studio's pin so both surfaces agree). */
const AC_TOKEN_RE = /\b(?:AC-[\w.]+|ac:[\w.-]+)\b/g;

/** Doc precedence per pinned field — the first existing head wins.
 *  `prd.md` is the retired spelling of `rs.md` (wp-132) kept as a
 *  read-only fallback so pre-rename rows still resolve. */
export const RS_DOCS = ['rs.md', 'prd.md'] as const;
export const DESIGN_DOCS = ['tdd.md', 'mockup.json'] as const;
export const AC_DOCS = ['rs.md', 'prd.md', 'ac.md', 'ticket.md'] as const;
export const CONTRACT_DOC = 'contract.json';
export const TICKET_DOC = 'ticket.md';

export interface BaselineResolveArgs {
  store: Store;
  workspace: string;
  /** Subject the docs hang off — the ticket id when the run has one,
   *  else the run subject. */
  subject: string;
  /** Repo-executing worktree — resolves `base_sha` (`git rev-parse
   *  HEAD`). Null/absent for cardless stages (no checkout yet). */
  worktree?: string | null;
}

/** Version of the first existing doc across `docs`, or null. */
export async function firstDocHead(
  store: Store,
  workspace: string,
  subject: string,
  docs: readonly string[],
): Promise<number | null> {
  for (const doc of docs) {
    const v = await store.getDoc({ workspace, subject, doc });
    if (v) return v.version;
  }
  return null;
}

/** `git rev-parse HEAD` of a worktree — null when it is not a repo (or
 *  git is unavailable); base_sha is best-effort, never blocks launch. */
export async function gitHead(worktree: string): Promise<string | null> {
  try {
    const out = await git(['rev-parse', 'HEAD'], { cwd: worktree });
    return out.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the concrete spec baseline for a run — doc heads pinned to
 * versions NOW, never a "latest" pointer. `ac_ids` is the union of AC
 * tokens found across the spec docs; `base_sha` is the worktree HEAD
 * (null for cardless runs / non-repo roots).
 */
export async function resolveRunBaseline(
  args: BaselineResolveArgs,
): Promise<RunBaseline> {
  const { store, workspace, subject, worktree } = args;
  const acIds = new Set<string>();
  for (const doc of AC_DOCS) {
    const v = await store.getDoc({ workspace, subject, doc });
    for (const m of v?.content.matchAll(AC_TOKEN_RE) ?? []) acIds.add(m[0]);
  }
  return {
    rs_version: await firstDocHead(store, workspace, subject, RS_DOCS),
    ticket_rev: await firstDocHead(store, workspace, subject, [TICKET_DOC]),
    design_rev: await firstDocHead(store, workspace, subject, DESIGN_DOCS),
    ac_ids: [...acIds].sort(),
    base_sha: worktree ? await gitHead(worktree) : null,
    contract_ver: await firstDocHead(store, workspace, subject, [CONTRACT_DOC]),
  };
}

/** The pinned baseline carried on a run row's `runs.request`, or null
 *  (missing/malformed → null; a malformed pin never guesses). */
export function pinnedBaselineOf(
  row: RunRow | null | undefined,
): RunBaseline | null {
  const raw = row?.request?.baseline;
  if (!raw) return null;
  const parsed = RunBaselineSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Re-pin `base_sha` onto an existing pin WITHOUT touching the doc pins —
 * the branch point is a launch-time fact, the spec pins are immutable
 * (a re-launch must not re-resolve the doc heads).
 */
export function withBaseSha(
  baseline: RunBaseline,
  sha: string | null,
): RunBaseline {
  return { ...baseline, base_sha: sha ?? baseline.base_sha ?? null };
}
