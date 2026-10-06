/**
 * Artifact collection — ADAPTERS scratch-dir contract:
 *
 * - `can_write_outside_tree: true`  → artifacts were written to the
 *   absolute `runs/<id>/` dir directly; nothing to move.
 * - `can_write_outside_tree: false` → artifacts live in the gitignored
 *   worktree scratch dir `.veto/<run-id>/`; the runner moves
 *   them into `runs/<id>/` post-exit and purges the scratch dir so the
 *   diff never sees them.
 *
 * After collection we verify via `git status` that no scratch residue
 * remains in the worktree.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export const SCRATCH_DIR = '.veto';

export interface CollectOptions {
  /** Worktree the run executed in. */
  worktree: string;
  runId: string;
  /** Absolute runs dir — final artifact destination. */
  runDir: string;
  /** Backend capability flag (SETTINGS `capabilities:`). */
  canWriteOutsideTree: boolean;
}

export interface CollectResult {
  /** true = scratch purged AND `git status` shows no residue. */
  ok: boolean;
  /** Paths moved into runDir, relative to runDir. */
  moved: string[];
  /** Offending residue paths (non-empty → ok: false). */
  residue: string[];
  runDir: string;
}

export function scratchPath(worktree: string, runId: string): string {
  return join(worktree, SCRATCH_DIR, runId);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Move a file/dir, falling back to copy+unlink across devices. */
async function move(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

async function moveContents(
  srcDir: string,
  destDir: string,
): Promise<string[]> {
  const moved: string[] = [];
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const src = join(srcDir, e.name);
    const dest = join(destDir, e.name);
    if (e.isDirectory()) {
      await mkdir(dest, { recursive: true });
      const nested = await moveContents(src, dest);
      moved.push(...nested.map((n) => join(e.name, n)));
      await rm(src, { recursive: true, force: true });
    } else {
      await move(src, dest);
      moved.push(e.name);
    }
  }
  return moved;
}

function gitStatus(worktree: string, pathspec: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      'git',
      ['status', '--porcelain', '--', pathspec],
      { cwd: worktree, timeout: 30_000 },
      (err, stdout) => (err ? rej(err) : res(stdout)),
    );
  });
}

/**
 * Collect run artifacts into `runDir` and purge the worktree scratch
 * dir. Returns residue so callers can fail closed (a polluted diff is
 * a repair-gate problem, not a silent shrug).
 */
export async function collectArtifacts(
  opts: CollectOptions,
): Promise<CollectResult> {
  const { worktree, runId, runDir } = opts;
  await mkdir(runDir, { recursive: true });

  const scratch = scratchPath(worktree, runId);
  // Defense-in-depth (run-id path traversal): the scratch MUST resolve
  // strictly inside `<worktree>/.veto/` — a crafted run id
  // (`../../x`) must never reach the rm/copy calls below.
  const scratchRoot = resolve(join(worktree, SCRATCH_DIR));
  const resolvedScratch = resolve(scratch);
  if (!resolvedScratch.startsWith(scratchRoot + sep)) {
    throw new Error(
      `collect: run id '${runId}' resolves outside ${SCRATCH_DIR}/ — refused (fail-closed)`,
    );
  }
  const moved: string[] = [];

  // Even for outside-tree backends we purge a stray scratch dir if one
  // was created — the contract is "the diff never sees them".
  if (await exists(scratch)) {
    moved.push(...(await moveContents(scratch, runDir)));
    await rm(scratch, { recursive: true, force: true });
  }
  // Run ids are multi-segment (`<ws>/<subject>/<attempt>-<stage>`), so
  // removing the leaf leaves `.veto/<ws>/<subject>/` shells —
  // prune every emptied ancestor up to (and incl.) `.veto/`.
  // `parent + sep` — a `.veto-evil` sibling must not match; `rmdir`
  // (not rm -rf) fails on a non-empty dir instead of racing a sibling
  // run that just wrote into it (TOCTOU).
  const parent = join(worktree, SCRATCH_DIR);
  for (
    let dir = dirname(scratch);
    (dir === parent || dir.startsWith(parent + sep)) && dir !== worktree;
    dir = dirname(dir)
  ) {
    try {
      await rmdir(dir); // fails non-empty — that's the stop condition
    } catch {
      break;
    }
    if (dir === parent) break;
  }

  // Residue is scoped to THIS run — a sibling live run's own
  // `.veto/<other-run>/` scratch leaf is not this run's failure.
  const residue: string[] = [];
  if (await exists(scratch)) residue.push(scratch);
  // `.veto/` is gitignored, so a clean check is belt-and-
  // suspenders: any porcelain line under it means untracked residue
  // (e.g. an ignore rule was lost) that WILL land in the diff.
  try {
    const status = await gitStatus(worktree, `${SCRATCH_DIR}/`);
    for (const line of status.split('\n').filter(Boolean)) {
      residue.push(`${SCRATCH_DIR}: ${line.trim()}`);
    }
  } catch {
    /* not a git worktree — filesystem checks above still apply */
  }

  return { ok: residue.length === 0, moved, residue, runDir };
}
