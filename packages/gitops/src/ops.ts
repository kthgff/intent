import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type GitOptions, git } from './git.js';

export interface Actor {
  name: string;
  email: string;
}

export const DEFAULT_ACTOR: Actor = {
  name: 'veto',
  email: 'veto@localhost',
};

/**
 * Stage everything and commit as `actor` via per-invocation
 * `git -c user.name/-c user.email` — never mutates repo/global config.
 * Returns the new commit sha. Throws GitError("nothing to commit") is
 * NOT thrown: an empty tree is a no-op returning the current HEAD.
 */
export async function commitAll(
  repo: string,
  message: string,
  actor: Actor = DEFAULT_ACTOR,
  opts: GitOptions = {},
): Promise<string> {
  await git(['add', '-A'], { ...opts, cwd: repo });
  const { stdout: status } = await git(['status', '--porcelain'], {
    ...opts,
    cwd: repo,
  });
  if (status.trim().length > 0) {
    await git(
      [
        '-c',
        `user.name=${actor.name}`,
        '-c',
        `user.email=${actor.email}`,
        'commit',
        '-m',
        message,
      ],
      { ...opts, cwd: repo },
    );
  }
  const { stdout } = await git(['rev-parse', 'HEAD'], { ...opts, cwd: repo });
  return stdout.trim();
}

async function currentBranch(repo: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repo,
  });
  return stdout.trim();
}

/**
 * `git pull --rebase` against origin/<current-branch> — fetch <branch>
 * + rebase FETCH_HEAD, immune to stale FETCH_HEAD entries ("Cannot
 * rebase onto multiple branches") when the remote advertises extra
 * refs. Code-repo only (D29): no lock sweeping — leases live in the
 * DB now.
 */
export async function pullRebase(
  repo: string,
  opts: GitOptions = {},
): Promise<void> {
  const branch = await currentBranch(repo);
  await git(['fetch', 'origin', branch], { ...opts, cwd: repo });
  await git(['rebase', 'FETCH_HEAD'], { ...opts, cwd: repo });
}

/**
 * Push `refspec` to `remote`. Non-fast-forward / ref-exists rejections
 * surface as NonFastForwardError so callers can pull-rebase-retry.
 */
export async function push(
  repo: string,
  remote = 'origin',
  refspec = 'HEAD',
  opts: GitOptions = {},
): Promise<void> {
  await git(['push', remote, refspec], { ...opts, cwd: repo });
}

// ---------------------------------------------------------------------------
// Worktrees — SETTINGS `worktree_root: sibling` → `<repo>.worktrees/<id>`
// ---------------------------------------------------------------------------

export function worktreePath(repo: string, id: string): string {
  return join(`${repo}.worktrees`, id);
}

/**
 * Create `<repo>.worktrees/<id>` on `branch` (created via -b if missing),
 * then inject `.veto/` into the worktree's .gitignore
 * (ADAPTERS: scratch dir `.veto/<run-id>/` must be gitignored).
 */
export async function createWorktree(
  repo: string,
  id: string,
  branch: string,
  opts: GitOptions = {},
): Promise<string> {
  const dir = worktreePath(repo, id);
  await mkdir(dirname(dir), { recursive: true });

  const branchExists = await git(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { ...opts, cwd: repo },
  ).then(
    () => true,
    () => false,
  );

  const args = branchExists
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir];
  await git(args, { ...opts, cwd: repo });

  const gitignorePath = join(dir, '.gitignore');
  const existing = existsSync(gitignorePath)
    ? await readFile(gitignorePath, 'utf8')
    : '';
  const hasEntry = existing
    .split('\n')
    .some((line) => line.trim() === '.veto/');
  if (!hasEntry) {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(gitignorePath, `${prefix}.veto/\n`, 'utf8');
  }
  return dir;
}

/**
 * Remove `<repo>.worktrees/<id>` and delete the branch the worktree had
 * checked out (protected: main/master are never deleted).
 */
export async function removeWorktree(
  repo: string,
  id: string,
  opts: GitOptions = {},
): Promise<void> {
  const dir = worktreePath(repo, id);
  let branch = '';
  if (existsSync(dir)) {
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      ...opts,
      cwd: dir,
    })
      .then((r) => r.stdout.trim())
      .catch(() => '');
    await git(['worktree', 'remove', '--force', dir], {
      ...opts,
      cwd: repo,
    });
  } else {
    // Stale administrative data but missing dir.
    await git(['worktree', 'prune'], { ...opts, cwd: repo });
  }
  if (branch && branch !== 'main' && branch !== 'master' && branch !== 'HEAD') {
    await git(['branch', '-D', branch], { ...opts, cwd: repo }).catch(() => {});
  }
}
