import { execFile } from 'node:child_process';

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Working directory for the git invocation. */
  cwd?: string;
  /** Milliseconds before the process is killed. Defaults to 30s. */
  timeoutMs?: number;
  /** Extra environment variables merged over process.env. */
  env?: Record<string, string>;
  /** Input piped to the child's stdin. */
  input?: string;
}

export class GitError extends Error {
  readonly args: string[];
  readonly cwd?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;

  constructor(args: string[], opts: GitOptions, cause: ExecFailure) {
    const timedOut = cause.killed === true || cause.signal === 'SIGTERM';
    const detail = cause.stderr.trim() || cause.message;
    super(
      `git ${args.join(' ')} failed${timedOut ? ' (timeout)' : ''}` +
        `${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'GitError';
    this.args = args;
    this.stdout = cause.stdout;
    this.stderr = cause.stderr;
    this.exitCode = typeof cause.code === 'number' ? cause.code : null;
    this.timedOut = timedOut;
    if (opts.cwd !== undefined) this.cwd = opts.cwd;
  }
}

/** Push rejected because the remote ref moved — caller should pull-rebase-retry. */
export class NonFastForwardError extends GitError {
  constructor(args: string[], opts: GitOptions, cause: ExecFailure) {
    super(args, opts, cause);
    this.name = 'NonFastForwardError';
  }
}

interface ExecFailure {
  message: string;
  stdout: string;
  stderr: string;
  code: number | string | null;
  killed?: boolean | undefined;
  signal?: string | null | undefined;
}

const NON_FF_PATTERN =
  /non-fast-forward|fetch first|stale info|already exists| rejected/i;

export function isNonFastForward(err: unknown): boolean {
  return (
    err instanceof GitError &&
    (err instanceof NonFastForwardError || NON_FF_PATTERN.test(err.stderr))
  );
}

/**
 * Shell out to the real `git` binary via execFile (no isomorphic-git).
 * Throws GitError (or NonFastForwardError for rejected pushes) on failure.
 */
export function git(args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...opts.env },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const result = {
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        };
        if (error) {
          const failure: ExecFailure = {
            message: error.message,
            stdout: result.stdout,
            stderr: result.stderr,
            code: (error as { code?: number | string }).code ?? null,
            killed: error.killed,
            signal: error.signal,
          };
          if (args[0] === 'push' && NON_FF_PATTERN.test(result.stderr)) {
            reject(new NonFastForwardError(args, opts, failure));
          } else {
            reject(new GitError(args, opts, failure));
          }
          return;
        }
        resolve(result);
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
