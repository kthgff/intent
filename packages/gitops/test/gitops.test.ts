import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitError,
  NonFastForwardError,
  commitAll,
  createWorktree,
  git,
  pullRebase,
  push,
  removeWorktree,
  worktreePath,
} from '../src/index.js';

let root: string;
let remote: string;
let seed: string;

const ACTOR = { name: 'Agent Wp012', email: 'wp012@example.com' };

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function cloneRepo(name: string): Promise<string> {
  const dest = join(root, name);
  await git(['clone', `file://${remote}`, dest]);
  // Push/checkouts inside tests commit via commitAll (-c identity), but
  // set a local identity anyway for direct plumbing we do in helpers.
  sh(['config', 'user.name', 'test'], dest);
  sh(['config', 'user.email', 'test@example.com'], dest);
  return dest;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp012-'));
  remote = join(root, 'remote.git');
  seed = join(root, 'seed');
  sh(['init', '--bare', '-b', 'main', remote], root);
  sh(['init', '-b', 'main', seed], root);
  sh(['config', 'user.name', 'seed'], seed);
  sh(['config', 'user.email', 'seed@example.com'], seed);
  await writeFile(join(seed, 'README.md'), '# seed\n');
  sh(['add', '-A'], seed);
  sh(['commit', '-m', 'seed'], seed);
  sh(['remote', 'add', 'origin', `file://${remote}`], seed);
  sh(['push', 'origin', 'main'], seed);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('git()', () => {
  it('returns stdout and throws GitError on failure', async () => {
    const { stdout } = await git(['--version']);
    expect(stdout).toContain('git version');
    await expect(
      git(['rev-parse', 'HEAD'], { cwd: root }),
    ).rejects.toBeInstanceOf(GitError);
  });
});

describe('commitAll / push', () => {
  it('commits with actor identity without mutating git config', async () => {
    const repo = await cloneRepo('a');
    sh(['config', '--unset', 'user.name'], repo);
    sh(['config', '--unset', 'user.email'], repo);
    await writeFile(join(repo, 'x.txt'), 'hi\n');
    const sha = await commitAll(repo, 'agent commit', ACTOR);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(['log', '-1', '--format=%an <%ae>'], repo)).toBe(
      'Agent Wp012 <wp012@example.com>',
    );
    // repo-local config still has no identity — -c never persisted
    // (global ~/.gitconfig may legitimately provide one)
    expect(() => sh(['config', '--local', 'user.name'], repo)).toThrow();
    expect(() => sh(['config', '--local', 'user.email'], repo)).toThrow();
  });

  it('surfaces non-fast-forward rejection as NonFastForwardError', async () => {
    const a = await cloneRepo('a');
    const b = await cloneRepo('b');
    await writeFile(join(a, 'a.txt'), 'a\n');
    await commitAll(a, 'a', ACTOR);
    await push(a);
    await writeFile(join(b, 'b.txt'), 'b\n');
    await commitAll(b, 'b', ACTOR);
    await expect(push(b)).rejects.toBeInstanceOf(NonFastForwardError);
  });
});

describe('pullRebase', () => {
  it('recovers a rejected push via pull-rebase-retry (non-conflicting)', async () => {
    const a = await cloneRepo('a');
    const b = await cloneRepo('b');
    await writeFile(join(a, 'a.txt'), 'a\n');
    await commitAll(a, 'a', ACTOR);
    await push(a);

    await writeFile(join(b, 'b.txt'), 'b\n');
    await commitAll(b, 'b', ACTOR);
    await expect(push(b)).rejects.toBeInstanceOf(NonFastForwardError);
    await pullRebase(b);
    await push(b); // now succeeds
    expect(sh(['ls-remote', 'origin', 'main'], b).split(/\s/)[0]).toBe(
      sh(['rev-parse', 'HEAD'], b),
    );
  });

  it('surfaces real merge conflicts instead of swallowing them', async () => {
    const a = await cloneRepo('a');
    const b = await cloneRepo('b');
    await writeFile(join(a, 'same.txt'), 'from-a\n');
    await commitAll(a, 'a', ACTOR);
    await push(a);
    await writeFile(join(b, 'same.txt'), 'from-b\n');
    await commitAll(b, 'b', ACTOR);
    await expect(pullRebase(b)).rejects.toBeInstanceOf(GitError);
  });
});

// D29: ref-CAS locks, expired-lock sweeps, and ref-based next-id
// reservation are gone — leases are DB rows and ticket ids come from
// projects.next_ticket_seq inside a transaction.

describe('worktrees', () => {
  it('create → dir+branch+gitignore injection; remove → cleans both', async () => {
    const repo = await cloneRepo('a');
    const dir = await createWorktree(repo, 'run-1', 'wp-999');
    expect(dir).toBe(worktreePath(repo, 'run-1'));
    expect(dir).toBe(join(`${repo}.worktrees`, 'run-1'));
    expect(existsSync(dir)).toBe(true);
    // .sprint-runner/ injected into the worktree's .gitignore
    const gi = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(gi.split('\n').map((l) => l.trim())).toContain('.sprint-runner/');
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).toBe('wp-999');
    sh(['show-ref', '--verify', '--quiet', 'refs/heads/wp-999'], repo);

    await removeWorktree(repo, 'run-1');
    expect(existsSync(dir)).toBe(false);
    await expect(
      git(['show-ref', '--verify', '--quiet', 'refs/heads/wp-999'], {
        cwd: repo,
      }),
    ).rejects.toBeInstanceOf(GitError);
  });

  it('appends .sprint-runner/ to an existing .gitignore once', async () => {
    const repo = await cloneRepo('a');
    await writeFile(join(repo, '.gitignore'), 'node_modules\n');
    await commitAll(repo, 'gi', ACTOR);
    const dir = await createWorktree(repo, 'run-2', 'wp-998');
    const gi = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(gi).toContain('node_modules');
    expect(
      gi.split('\n').filter((l) => l.trim() === '.sprint-runner/'),
    ).toHaveLength(1);
    await removeWorktree(repo, 'run-2');
  });
});
