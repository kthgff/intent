import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GitError,
  type GitOptions,
  NonFastForwardError,
  git,
  isNonFastForward,
} from './git.js';

export interface Actor {
  name: string;
  email: string;
}

export const DEFAULT_ACTOR: Actor = {
  name: 'sprint-runner',
  email: 'sprint-runner@localhost',
};

/** Bounded retries for pull-rebase-retry loops. */
export const MAX_RETRIES = 5;

export async function clone(
  url: string,
  dest: string,
  opts: GitOptions = {},
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await git(['clone', url, dest], opts);
}

async function currentBranch(repo: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repo,
  });
  return stdout.trim();
}

/**
 * `git pull --rebase` against origin/<current-branch>, then sweep expired
 * `refs/locks/*` (CONDUCTOR: every pull sweeps refs past expires_at — the
 * expiry field IS the TTL since refs don't age out on their own).
 * Sweep failures are non-fatal: a missing/unreachable remote must not
 * break a plain pull.
 */
export async function pullRebase(
  repo: string,
  opts: GitOptions = {},
): Promise<void> {
  const branch = await currentBranch(repo);
  // fetch <branch> + rebase FETCH_HEAD — equivalent to `git pull --rebase`
  // but immune to stale FETCH_HEAD entries ("Cannot rebase onto multiple
  // branches") when the remote advertises extra refs.
  await git(['fetch', 'origin', branch], { ...opts, cwd: repo });
  await git(['rebase', 'FETCH_HEAD'], { ...opts, cwd: repo });
  await sweepExpiredLocks(repo, opts).catch(() => {});
}

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
 * then inject `.sprint-runner/` into the worktree's .gitignore
 * (ADAPTERS: scratch dir `.sprint-runner/<run-id>/` must be gitignored).
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
    .some((line) => line.trim() === '.sprint-runner/');
  if (!hasEntry) {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(gitignorePath, `${prefix}.sprint-runner/\n`, 'utf8');
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

// ---------------------------------------------------------------------------
// Ref CAS locks — refs/locks/<subject>-<stage>, refs/locks/claims/<subject>-<gate>
// ---------------------------------------------------------------------------

export interface LockContent {
  holder: string;
  acquired_at: string;
  expires_at: string;
}

export type LockResult =
  | { status: 'acquired'; ref: string; content: LockContent }
  | { status: 'contested'; ref: string; holder: LockContent | null };

const LOCK_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'sprint-runner',
  GIT_AUTHOR_EMAIL: 'sprint-runner@localhost',
  GIT_COMMITTER_NAME: 'sprint-runner',
  GIT_COMMITTER_EMAIL: 'sprint-runner@localhost',
};

/**
 * Build a commit carrying `lock.json` without touching the worktree:
 * hash-object -w (blob) → mktree → commit-tree. The returned sha is a
 * normal commit object in `repo`'s object store, safe to push to a ref.
 */
async function buildLockCommit(
  repo: string,
  content: LockContent,
  opts: GitOptions,
): Promise<string> {
  const { stdout: blob } = await git(['hash-object', '-w', '--stdin'], {
    ...opts,
    cwd: repo,
    input: JSON.stringify(content, null, 2),
  });
  const { stdout: tree } = await git(['mktree'], {
    ...opts,
    cwd: repo,
    input: `100644 blob ${blob.trim()}\tlock.json\n`,
  });
  const { stdout: commit } = await git(
    ['commit-tree', tree.trim(), '-m', `lock ${content.holder}`],
    { ...opts, cwd: repo, env: { ...opts.env, ...LOCK_IDENTITY_ENV } },
  );
  return commit.trim();
}

async function readRemoteLock(
  repo: string,
  ref: string,
  opts: GitOptions,
): Promise<LockContent | null> {
  // Fetch the remote ref into FETCH_HEAD so its objects are local, then
  // read lock.json out of the commit without checking anything out.
  // (Fetch by ref name — fetching a raw sha needs allowTipSHA1InWant.)
  try {
    const { stdout: sha } = await git(['ls-remote', 'origin', ref], {
      ...opts,
      cwd: repo,
    });
    const remoteSha = sha.split(/\s/)[0]?.trim();
    if (!remoteSha) return null;
    await git(['fetch', 'origin', ref], { ...opts, cwd: repo });
    const { stdout: json } = await git(['show', 'FETCH_HEAD:lock.json'], {
      ...opts,
      cwd: repo,
    });
    return JSON.parse(json) as LockContent;
  } catch {
    return null;
  }
}

/**
 * CAS-acquire `refs/.../lock` ref on origin.
 *
 * Approach: build the lock payload as a real commit via temp plumbing
 * (hash-object → mktree → commit-tree), then push
 * `<commit>:<ref>` — ref creation is atomic on the remote, so exactly one
 * contender wins; the loser gets a non-fast-forward / already-exists
 * rejection. We never force-push a live lock: contested → return the
 * winner's {holder, acquired_at, expires_at} payload.
 *
 * `ref` is the full ref name (e.g. `refs/locks/<subject>-<stage>` or
 * `refs/locks/claims/<subject>-<gate>`); callers pass it verbatim.
 */
export async function acquireRefLock(
  repo: string,
  ref: string,
  lock: { holder: string; ttlS: number },
  opts: GitOptions = {},
): Promise<LockResult> {
  const now = Date.now();
  const content: LockContent = {
    holder: lock.holder,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + lock.ttlS * 1000).toISOString(),
  };
  const commit = await buildLockCommit(repo, content, opts);
  try {
    await git(['push', 'origin', `${commit}:${ref}`], {
      ...opts,
      cwd: repo,
    });
    return { status: 'acquired', ref, content };
  } catch (err) {
    if (err instanceof GitError && !isNonFastForward(err)) throw err;
    const holder = await readRemoteLock(repo, ref, opts);
    return { status: 'contested', ref, holder };
  }
}

/**
 * Force-delete `refs/locks/**` (incl. `refs/locks/claims/**`) on origin
 * whose expires_at is in the past — a crashed install can't hold a lock
 * forever, so expiry overrides the no-force rule for live locks.
 */
export async function sweepExpiredLocks(
  repo: string,
  opts: GitOptions & { now?: Date } = {},
): Promise<string[]> {
  const now = (opts.now ?? new Date()).getTime();
  const { stdout } = await git(['ls-remote', 'origin', 'refs/locks/*'], {
    ...opts,
    cwd: repo,
  });
  const entries = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha = '', ref = ''] = l.split(/\s+/);
      return { sha, ref };
    });
  if (entries.length === 0) return [];

  // Pull all lock objects into the local object store in one fetch
  // (by ref name — raw sha fetch needs allowTipSHA1InWant).
  await git(['fetch', 'origin', ...entries.map((e) => e.ref)], {
    ...opts,
    cwd: repo,
  }).catch(() => {});

  const deleted: string[] = [];
  for (const { sha, ref } of entries) {
    let content: LockContent;
    try {
      const { stdout: json } = await git(['show', `${sha}:lock.json`], {
        ...opts,
        cwd: repo,
      });
      content = JSON.parse(json) as LockContent;
    } catch {
      continue; // unreadable lock — leave it for a human
    }
    if (Date.parse(content.expires_at) <= now) {
      await git(['push', 'origin', '--delete', ref], {
        ...opts,
        cwd: repo,
      });
      deleted.push(ref);
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// next-id — `.sprint-runner/next-id` commit+push CAS, collision → pull-rebase-retry
// ---------------------------------------------------------------------------

const NEXT_ID_PATH = join('.sprint-runner', 'next-id');

/**
 * Reserve the next `<prefix>-NNNN` id by committing an incremented
 * `.sprint-runner/next-id` counter and pushing it. The push is the CAS:
 * on non-fast-forward rejection we pull --rebase and retry (bounded —
 * MAX_RETRIES, then throw). Returns e.g. `SR-0007`.
 */
export async function reserveNextId(
  repo: string,
  prefix = 'SR',
  actor: Actor = DEFAULT_ACTOR,
  opts: GitOptions = {},
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await pullRebase(repo, opts);
    const file = join(repo, NEXT_ID_PATH);
    const current = existsSync(file)
      ? Number.parseInt((await readFile(file, 'utf8')).trim(), 10) || 0
      : 0;
    const next = current + 1;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${next}\n`, 'utf8');
    await commitAll(repo, `reserve ${prefix}-${next}`, actor, opts);
    try {
      await push(repo, 'origin', 'HEAD', opts);
      return `${prefix}-${String(next).padStart(4, '0')}`;
    } catch (err) {
      if (!isNonFastForward(err)) throw err;
      lastErr = err; // collision → pull-rebase-retry
    }
  }
  throw new NonFastForwardError(
    ['push', 'origin', 'HEAD'],
    { cwd: repo },
    {
      message: `reserveNextId: exceeded ${MAX_RETRIES} CAS retries`,
      stdout: '',
      stderr: `next-id reservation still contested after ${MAX_RETRIES} retries`,
      code: null,
      ...(lastErr instanceof GitError ? {} : {}),
    },
  );
}
