/**
 * repos.ts — connect a code repo from GitHub (Settings → Code Repos).
 *
 * `POST /repos/clone` takes a GitHub URL, clones it into the managed
 * data dir (`~/.local/share/veto/repos/<name>`), and registers
 * `repos.<name>.{path,url}` in config.yaml — one click = connect +
 * download + register.
 *
 * Auth: the configured `importers.github.token_env` secret (default
 * GITHUB_TOKEN, written via Backends & Keys → .env) is fed to git
 * through an env-var credential helper — the token never appears on
 * argv, in `.git/config`, or in the process list. Public repos clone
 * fine without it. The same helper is persisted repo-locally so later
 * `git fetch` authenticates wherever the env var is injected.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GitError, git } from '@veto/gitops';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, parseBody } from './server.js';

const CLONE_TIMEOUT_MS = 300_000;

/** `owner/repo` out of the accepted GitHub URL forms; null otherwise. */
export function parseGithubRepo(url: string): {
  owner: string;
  repo: string;
} | null {
  const trimmed = url.trim();
  const patterns = [
    // https://github.com/owner/repo[.git][/tree/...]
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#].*)?$/i,
    // ssh://git@github.com/owner/repo[.git]
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    // git@github.com:owner/repo[.git]
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(trimmed);
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] };
  }
  return null;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

const CloneBody = z.object({
  url: z.string().min(1),
  name: z.string().optional(),
});

export interface RepoRoutesDeps {
  /** Resolved config — read for `repos` collisions + github token. */
  config: {
    repos?: Record<string, { path?: string }>;
    secrets?: Record<string, string>;
    importers?: {
      github?: { token_env?: string | undefined } | undefined;
    };
  };
  /** Where managed clones land (default `~/.local/share/veto/repos`). */
  reposDir?: string;
  /** Config persistence seam (default: mergeConfigFile at boot path). */
  persist?: (patch: Record<string, unknown>) => void;
  /** Git seam for tests — defaults to @veto/gitops real-git execFile.
   *  Used for the clone and the repo-local credential-helper write. */
  runGit?: (
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
  ) => Promise<void>;
}

const defaultRunGit: NonNullable<RepoRoutesDeps['runGit']> = async (
  args,
  env,
  timeoutMs,
) => {
  await git(args, { env, timeoutMs });
};

export function registerRepoRoutes(
  app: FastifyInstance,
  deps: RepoRoutesDeps,
): void {
  const reposDir =
    deps.reposDir ?? join(homedir(), '.local', 'share', 'veto', 'repos');
  const persist = deps.persist ?? (() => {});
  const runGit = deps.runGit ?? defaultRunGit;

  app.post('/api/v1/repos/clone', async (req, reply) => {
    const body = parseBody(CloneBody, req.body, 'repo clone');
    const gh = parseGithubRepo(body.url);
    if (!gh) {
      throw new ApiError(
        400,
        'bad_request',
        'expected a GitHub URL — https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>',
      );
    }
    const name = body.name ?? gh.repo;
    if (!NAME_RE.test(name)) {
      throw new ApiError(
        400,
        'bad_request',
        `repo name '${name}' must match [A-Za-z0-9._-] (≤64 chars, no leading separator)`,
      );
    }
    if (deps.config.repos?.[name]) {
      throw new ApiError(
        409,
        'conflict',
        `repo '${name}' is already configured`,
      );
    }

    const canonical = `https://github.com/${gh.owner}/${gh.repo}`;
    const dest = join(reposDir, name);
    // Non-empty dir OR a plain file at the dest → conflict, never touch.
    const occupied =
      existsSync(dest) &&
      (!statSync(dest).isDirectory() || readdirSync(dest).length > 0);
    if (occupied) {
      throw new ApiError(
        409,
        'conflict',
        `destination '${dest}' already exists and is not empty`,
      );
    }

    const tokenEnv = deps.config.importers?.github?.token_env ?? 'GITHUB_TOKEN';
    const token =
      ENV_NAME_RE.test(tokenEnv) && deps.config.secrets
        ? deps.config.secrets[tokenEnv]
        : undefined;
    // Token reaches git only through the env-fed credential helper —
    // never in argv (visible in `ps`), the URL, or .git/config.
    const helper = `!f() { echo "username=x-access-token"; echo "password=$${tokenEnv}"; }; f`;
    const args = token
      ? [
          '-c',
          'credential.helper=',
          '-c',
          `credential.helper=${helper}`,
          'clone',
          `${canonical}.git`,
          dest,
        ]
      : ['clone', `${canonical}.git`, dest];
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: '0', // fail fast instead of blocking on a tty prompt
      ...(token && tokenEnv ? { [tokenEnv]: token } : {}),
    };

    const madeDest = !existsSync(dest);
    try {
      mkdirSync(dest, { recursive: true });
      await runGit(args, env, CLONE_TIMEOUT_MS);
      if (token) {
        // Repo-local helper so later `git fetch`/`pull` authenticate
        // wherever the configured env var is injected — stores the
        // mechanism, not the secret.
        await runGit(
          ['-C', dest, 'config', 'credential.helper', helper],
          {},
          10_000,
        );
      }
    } catch (e) {
      if (madeDest && existsSync(dest))
        rmSync(dest, { recursive: true, force: true });
      const stderr = e instanceof GitError ? e.stderr : String(e);
      const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      throw new ApiError(
        502,
        'clone_failed',
        `git clone failed: ${tail || 'unknown error'}${
          token
            ? ''
            : ' — if the repo is private, set GITHUB_TOKEN under Backends & Keys'
        }`,
      );
    }

    persist({ repos: { [name]: { path: dest, url: canonical } } });
    return reply.status(201).send({
      repo: { name, path: dest, url: canonical },
    });
  });
}
