/**
 * shepherd/gh.ts — the `gh` CLI boundary for the shepherd loop
 * (CONDUCTOR "Shepherd loop", wp-051).
 *
 * `GhClient` is the injectable seam: the poll logic never shells out
 * directly — tests stub it with fixture JSON, production uses
 * {@link ShellGhClient}. We shell to `gh` rather than use octokit: gh
 * is a required PATH dependency (AGENTS.md) and carries the user's
 * auth, matching the importer (import/github.ts).
 */
import { execFile } from 'node:child_process';
import type { MergeStrategy } from '@veto/core';

/** One check row from `gh pr checks --json`. `bucket` is gh's rollup
 *  (pass|fail|pending|skipping|cancel); `state` is the raw check state
 *  (SUCCESS|FAILURE|PENDING|ERROR|SKIPPED|…). */
export interface PrCheck {
  name: string;
  state?: string;
  bucket?: string;
  link?: string;
  description?: string;
}

/** `gh pr view --json state,mergeCommit,mergedAt,…`. `state` is
 *  OPEN|MERGED|CLOSED (uppercase in gh's JSON). The Merge Center
 *  (wp-133) reads the extra fields to evaluate branch protection and
 *  the head SHA the approval must be bound to. */
export interface PrInfo {
  state: string;
  mergeCommit?: { oid?: string } | null;
  mergedAt?: string | null;
  /** Head commit the PR currently points at (approval binding). */
  headRefOid?: string | null;
  /** Base branch the PR targets (`main`) — merge-tree conflict probe. */
  baseRefName?: string | null;
  /** GitHub mergeability: MERGEABLE|CONFLICTING|UNKNOWN. */
  mergeable?: string | null;
  /** Protection/CI rollup: CLEAN|BLOCKED|BEHIND|DIRTY|DRAFT|UNSTABLE|
   *  HAS_HOOKS|UNKNOWN. BLOCKED/DIRTY mean protection blocks the merge. */
  mergeStateStatus?: string | null;
  /** REVIEW_REQUIRED|APPROVED|CHANGES_REQUESTED|''. */
  reviewDecision?: string | null;
  /** Non-null when auto-merge is armed (`--auto` enqueue). */
  autoMergeRequest?: { enabledAt?: string | null } | null;
  /** Base commit of the merge queue entry, when the PR is queued. */
  mergeQueueEntry?: { state?: string | null } | null;
}

/** Options for {@link GhClient.prMerge}. */
export interface PrMergeOptions {
  /** `--squash` | `--merge` | `--rebase` (SETTINGS `merge_strategy`). */
  strategy?: MergeStrategy;
  /** `--auto` — enqueue on a merge-queue repo instead of merging now. */
  auto?: boolean;
  /** `--delete-branch` (default false — the worktree owns the branch). */
  deleteBranch?: boolean;
}

/** A review comment or issue comment on the PR. */
export interface PrComment {
  id: number | string;
  body: string;
  author?: string;
  path?: string;
  created_at?: string;
  /** `review` = pull review thread comment; `issue` = conversation. */
  kind: 'review' | 'issue';
}

export interface PrCreateOptions {
  /** Worktree/repo dir the PR is created from (gh resolves the remote). */
  cwd: string;
  /** Head branch (e.g. `ticket/SR-0001`). */
  head: string;
  title: string;
  body: string;
  base?: string;
}

/** The shepherd's gh surface — every method is one shell-out. */
export interface GhClient {
  prChecks(prUrl: string): Promise<PrCheck[]>;
  prView(prUrl: string): Promise<PrInfo>;
  /** All review + conversation comments on the PR (oldest first). */
  reviewComments(prUrl: string): Promise<PrComment[]>;
  /** `gh pr create` → the new PR url. */
  prCreate(opts: PrCreateOptions): Promise<string>;
  /** `gh pr list --head` → url of an already-open PR for the branch. */
  prUrlForHead(cwd: string, head: string): Promise<string | null>;
  /**
   * `gh pr merge` (wp-133 Merge Center — Veto executes the merge).
   * `auto: true` adds `--auto` (merge-queue repos: enqueue counts as
   *  execution). Never passes a bypass flag — branch protection is
   *  GitHub-authoritative (D38).
   */
  prMerge(prUrl: string, opts?: PrMergeOptions): Promise<void>;
  /**
   * Whether the PR's target branch runs a merge queue (wp-133) — a
   * `true` result makes the Merge Center use `gh pr merge --auto`.
   * Fail-closed: an undetectable/absent queue returns `false` (a plain
   * `gh pr merge` still respects protection).
   */
  mergeQueue(prUrl: string): Promise<boolean>;
}

export class GhError extends Error {}

/** `{owner}/{repo}` + PR number out of a web URL
 *  (`https://<host>/<owner>/<repo>/pull/<n>`). Null on anything else. */
export function parsePrUrl(
  url: string,
): { host: string; owner: string; repo: string; number: number } | null {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  return {
    host: m[1] as string,
    owner: m[2] as string,
    repo: m[3] as string,
    number: Number(m[4]),
  };
}

interface GhRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Real {@link GhClient} — shells `gh` (PATH dep; AGENTS.md). */
export class ShellGhClient implements GhClient {
  readonly #ghPath: string;
  readonly #env?: Record<string, string>;

  constructor(opts: { ghPath?: string; env?: Record<string, string> } = {}) {
    this.#ghPath = opts.ghPath ?? 'gh';
    if (opts.env) this.#env = opts.env;
  }

  async prChecks(prUrl: string): Promise<PrCheck[]> {
    // NOTE: `gh pr checks` exits non-zero when checks are pending or
    // failing — but --json output is still written, so parse stdout
    // even on error (fail-open toward the JSON, never toward green).
    const { stdout } = await this.#run(
      ['pr', 'checks', prUrl, '--json', 'name,state,bucket,link,description'],
      { tolerateExit: true },
    );
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) throw new GhError('gh pr checks: not an array');
    return parsed as PrCheck[];
  }

  async prView(prUrl: string): Promise<PrInfo> {
    const { stdout } = await this.#run([
      'pr',
      'view',
      prUrl,
      '--json',
      [
        'state',
        'mergeCommit',
        'mergedAt',
        'headRefOid',
        'baseRefName',
        'mergeable',
        'mergeStateStatus',
        'reviewDecision',
        'autoMergeRequest',
        'mergeQueueEntry',
      ].join(','),
    ]);
    return JSON.parse(stdout) as PrInfo;
  }

  /**
   * `gh pr merge` (wp-133). Deliberately NEVER adds `--admin`/bypass —
   * a protection-blocked merge fails and the Merge Center surfaces a
   * gate item instead (D38: never bypass branch protection).
   */
  async prMerge(prUrl: string, opts: PrMergeOptions = {}): Promise<void> {
    const args = ['pr', 'merge', prUrl, `--${opts.strategy ?? 'squash'}`];
    if (opts.auto) args.push('--auto');
    if (opts.deleteBranch) args.push('--delete-branch');
    await this.#run(args);
  }

  /**
   * Merge-queue detection (wp-133) via the branch-protection rule set —
   * `gh api repos/<owner>/<repo>/branches/<base>` reports the effective
   * branch protection; a merge queue is enabled by the repo's ruleset.
   * Fail-closed: any error (older gh, no permission, no network) →
   * `false`, so the caller does a plain `gh pr merge` (still protected).
   */
  async mergeQueue(prUrl: string): Promise<boolean> {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) return false;
    const hostArgs =
      parsed.host === 'github.com' ? [] : ['--hostname', parsed.host];
    try {
      const info = await this.prView(prUrl);
      const base = info.baseRefName;
      if (!base) return false;
      const protection = (await this.#api(
        `repos/${parsed.owner}/${parsed.repo}/branches/${base}/protection`,
        hostArgs,
      )) as {
        required_pull_request_reviews?: unknown;
        merge_queue?: unknown;
      } | null;
      if (protection && protection.merge_queue != null) return true;
      // Rulesets (newer API) carry `merge_queue` as a rule type.
      const rulesets = (await this.#api(
        `repos/${parsed.owner}/${parsed.repo}/rulesets?targets=branch`,
        hostArgs,
      )) as { rules?: { type?: string }[] }[];
      return rulesets.some((r) =>
        (r.rules ?? []).some((rule) => rule.type === 'merge_queue'),
      );
    } catch {
      return false;
    }
  }

  async reviewComments(prUrl: string): Promise<PrComment[]> {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) throw new GhError(`unparseable pr_url: ${prUrl}`);
    const hostArgs =
      parsed.host === 'github.com' ? [] : ['--hostname', parsed.host];
    const pullComments = (await this.#api(
      `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`,
      hostArgs,
    )) as {
      id: number;
      body?: string;
      user?: { login?: string };
      path?: string;
      created_at?: string;
    }[];
    const issueComments = (await this.#api(
      `repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments`,
      hostArgs,
    )) as {
      id: number;
      body?: string;
      user?: { login?: string };
      created_at?: string;
    }[];
    const out: PrComment[] = [
      ...pullComments.map((c) => ({
        id: `r${c.id}`,
        body: c.body ?? '',
        author: c.user?.login ?? '',
        path: c.path ?? '',
        created_at: c.created_at ?? '',
        kind: 'review' as const,
      })),
      ...issueComments.map((c) => ({
        id: `i${c.id}`,
        body: c.body ?? '',
        author: c.user?.login ?? '',
        created_at: c.created_at ?? '',
        kind: 'issue' as const,
      })),
    ];
    out.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
    return out;
  }

  async prCreate(opts: PrCreateOptions): Promise<string> {
    const args = [
      'pr',
      'create',
      '--head',
      opts.head,
      '--title',
      opts.title,
      '--body',
      opts.body,
    ];
    if (opts.base) args.push('--base', opts.base);
    try {
      const { stdout } = await this.#run(args, { cwd: opts.cwd });
      const url = /https?:\/\/\S+/.exec(stdout)?.[0];
      if (url) return url;
      throw new GhError(`gh pr create: no url in output: ${stdout.trim()}`);
    } catch (e) {
      // "a pull request for branch X already exists" → recover the url.
      const existing = await this.prUrlForHead(opts.cwd, opts.head);
      if (existing) return existing;
      throw e;
    }
  }

  async prUrlForHead(cwd: string, head: string): Promise<string | null> {
    const { stdout } = await this.#run(
      ['pr', 'list', '--head', head, '--json', 'url', '--limit', '1'],
      { cwd },
    );
    const rows = JSON.parse(stdout) as { url?: string }[];
    return rows[0]?.url ?? null;
  }

  #api(endpoint: string, extraArgs: string[]): Promise<unknown> {
    return this.#run(['api', endpoint, ...extraArgs]).then(({ stdout }) =>
      JSON.parse(stdout),
    );
  }

  #run(
    args: string[],
    opts: GhRunOptions & { tolerateExit?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        this.#ghPath,
        args,
        {
          cwd: opts.cwd,
          env: { ...process.env, ...this.#env },
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              reject(new GhError(`gh binary not found: ${this.#ghPath}`));
              return;
            }
            if (opts.tolerateExit && stdout?.trim()) {
              resolvePromise({ stdout, stderr: stderr ?? '' });
              return;
            }
            const detail =
              (stderr ?? error.message).trim().split('\n')[0] ?? '';
            reject(
              new GhError(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`),
            );
            return;
          }
          resolvePromise({ stdout, stderr: stderr ?? '' });
        },
      );
    });
  }
}
