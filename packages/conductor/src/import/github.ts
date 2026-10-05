/**
 * GitHub issue fetch via the `gh` CLI (PRD "Importer adapters": `github`
 * (`--repo --milestone`); SETTINGS `importers.github.token_env`).
 *
 * We shell out rather than use octokit: `gh` is already a required PATH
 * dependency (AGENTS.md) and carries the user's auth. Never throws —
 * every failure mode is a structured {@link FetchError} that the import
 * run turns into `IMPORT-FAILED: <reason>`.
 */
import { execFile } from 'node:child_process';
import { issueKind } from './source-ref.js';
import type { FetchError, FetchIssuesResult, RawIssue } from './types.js';

export interface FetchIssuesOptions {
  /** `owner/repo` (or `[HOST/]OWNER/REPO`) — passed to `gh -R`. */
  repo: string;
  /** Milestone number or title (`gh -m`). */
  milestone?: string;
  /** Label filters (`gh -l`, repeatable). */
  labels?: string[];
  /** `open | closed | all` (`gh -s`, default `open`). */
  state?: 'open' | 'closed' | 'all';
  /** Max issues (`gh -L`, default 100 — gh's own default is 30, too low
   *  for a batch import). */
  limit?: number;
  /** SETTINGS `importers.github.token_env` — the env var NAME holding
   *  the token. When set and the var is absent → `token-missing`
   *  (auth-missing is a structured error, not a gh failure). */
  tokenEnv?: string;
  /** `gh` binary override (tests stub it); default `gh` on PATH. */
  ghPath?: string;
  /** Extra env merged over process.env for the gh child. */
  env?: Record<string, string>;
  /** Per-invocation timeout (ms). Default 60s. */
  timeoutMs?: number;
}

const GH_JSON_FIELDS = 'number,title,body,labels,url,milestone,state';
const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 60_000;

interface GhIssueJson {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  url: string;
  milestone: { title: string } | null;
  state: string;
}

function classifyGhError(stderr: string): FetchError['reason'] {
  return /auth|login|token|credential|403|401/i.test(stderr)
    ? 'auth-failed'
    : 'fetch-failed';
}

/**
 * `gh issue list --repo <repo> --json number,title,body,labels,url,
 * milestone,state` (+ `--milestone`/`--label`/`--state` filters) →
 * normalized {@link RawIssue} rows.
 */
export async function fetchIssues(
  opts: FetchIssuesOptions,
): Promise<FetchIssuesResult> {
  const tokenEnv = opts.tokenEnv;
  if (tokenEnv && !(opts.env?.[tokenEnv] ?? process.env[tokenEnv])) {
    return {
      ok: false,
      error: {
        reason: 'token-missing',
        detail: `env var ${tokenEnv} (importers.github.token_env) is not set`,
      },
    };
  }

  const args = [
    'issue',
    'list',
    '--repo',
    opts.repo,
    '--json',
    GH_JSON_FIELDS,
    '--state',
    opts.state ?? 'open',
    '--limit',
    String(opts.limit ?? DEFAULT_LIMIT),
  ];
  if (opts.milestone) args.push('--milestone', opts.milestone);
  for (const l of opts.labels ?? []) args.push('--label', l);

  const env = { ...process.env, ...opts.env };
  if (tokenEnv && env[tokenEnv]) {
    // gh reads GH_TOKEN/GITHUB_TOKEN; map the configured var onto both
    // so non-standard token_env names still authenticate.
    env.GH_TOKEN = env[tokenEnv];
    env.GITHUB_TOKEN = env[tokenEnv];
  }

  return new Promise<FetchIssuesResult>((resolvePromise) => {
    execFile(
      opts.ghPath ?? 'gh',
      args,
      {
        env,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            resolvePromise({
              ok: false,
              error: {
                reason: 'gh-missing',
                detail: `gh binary not found: ${opts.ghPath ?? 'gh'}`,
              },
            });
            return;
          }
          resolvePromise({
            ok: false,
            error: {
              reason: error.killed
                ? 'fetch-failed'
                : classifyGhError(stderr ?? ''),
              detail: (stderr ?? error.message).trim().split('\n')[0] ?? '',
            },
          });
          return;
        }
        let rows: GhIssueJson[];
        try {
          const parsed = JSON.parse(stdout) as unknown;
          if (!Array.isArray(parsed)) throw new Error('not an array');
          rows = parsed as GhIssueJson[];
        } catch (e) {
          resolvePromise({
            ok: false,
            error: {
              reason: 'fetch-failed',
              detail: `gh returned unparseable JSON: ${(e as Error).message}`,
            },
          });
          return;
        }
        resolvePromise({
          ok: true,
          issues: rows.map((r) => {
            const issue: RawIssue = {
              number: r.number,
              title: r.title ?? '',
              body: r.body ?? '',
              labels: (r.labels ?? []).map((l) => l.name),
              url: r.url ?? '',
              milestone: r.milestone?.title ?? null,
              state: r.state ?? '',
              repo: opts.repo,
            };
            // wp-139: distinguish issues from PRs (a `/pull/<n>` URL).
            issue.kind = issueKind(issue);
            return issue;
          }),
        });
      },
    );
  });
}
