/**
 * Verify tasks — runner-side re-runs of a repo card's test/lint/build
 * commands (CONDUCTOR "Runner tasks": heavy executions are DETACHED
 * `verify` tasks with their own `timeouts.verify`, no agent involved).
 *
 * This module executes and reports only — callers register the `runs`
 * row (subject `verify:<ticket>:<repo>`) and own kill/status
 * transitions. Produces `test-report.json` (SCHEMAS §10) including
 * `case:`-marker greps for `implemented` booleans.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  type RepoCard,
  type TestReport,
  type TestReportCase,
  TestReportSchema,
} from '@sprint-runner/core';

export interface VerifyCommandResult {
  name: string;
  command: string;
  exitCode: number | null;
  logPath: string;
  durationMs: number;
  timedOut: boolean;
}

export interface VerifyResult {
  /** First non-zero command exit code, or 124 on timeout, else 0. */
  exitCode: number;
  timedOut: boolean;
  commands: VerifyCommandResult[];
  report: TestReport;
  reportPath: string;
}

export interface VerifyTaskOptions {
  /** Repo the card belongs to (used to resolve relative worktree). */
  repoPath: string;
  /** Directory the commands run in — defaults to repoPath. */
  worktree?: string;
  runId: string;
  /** Absolute runs dir — logs + test-report.json land here. */
  runDir: string;
  card: RepoCard;
  /** Ticket id for the report (defaults to runId). */
  ticket?: string;
  /** Shared budget across all commands (ms). Default 3600s
   *  (SETTINGS `timeouts.verify`). */
  timeoutMs?: number;
  /** Glob patterns (worktree-relative) for files grepped for `case:`
   *  markers. Configurable; sensible defaults below. */
  testFileGlobs?: string[];
  /** Case ids planned in vs.md — when provided, `implemented` is
   *  verified per id and `planned` reflects the plan, not the grep. */
  plannedCases?: string[];
  env?: Record<string, string>;
}

export const DEFAULT_TIMEOUT_MS = 3_600_000;

/** Common test-file shapes across ecosystems (configurable via
 *  `testFileGlobs`). */
export const DEFAULT_TEST_FILE_GLOBS = [
  'test/**',
  'tests/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test_*.py',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.sprint-runner',
  'dist',
  'build',
  'vendor',
  '.venv',
  '__pycache__',
]);

/** `**`, `*`, `?` glob → RegExp matched against a posix relative path. */
function globToRegex(glob: string): RegExp {
  const src = glob
    .split('/')
    .map((seg) => {
      if (seg === '**') return '(?:[^/]+/)*[^/]*';
      return seg
        .split('')
        .map((ch) => {
          if (ch === '*') return '[^/]*';
          if (ch === '?') return '[^/]';
          return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
    })
    .join('/');
  return new RegExp(`^${src}$`);
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/** Find test files under `root` matching any of the globs. */
export async function findTestFiles(
  root: string,
  globs: string[] = DEFAULT_TEST_FILE_GLOBS,
): Promise<string[]> {
  const regexes = globs.map(globToRegex);
  const out: string[] = [];
  for await (const f of walk(root)) {
    const rel = relative(root, f).split('\\').join('/');
    if (regexes.some((r) => r.test(rel))) out.push(rel);
  }
  return out.sort();
}

const CASE_MARKER = /case:([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const CASE_RESULT =
  /case:([A-Za-z0-9][A-Za-z0-9_-]*)[^\n]*?\b(pass(?:ed)?|fail(?:ed)?|skip(?:ped)?|not ok|ok)\b/gi;

/** Grep test files for `case:<id>` markers (SCHEMAS §4 linkage). */
export async function grepCaseMarkers(
  root: string,
  files: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const rel of files) {
    const text = await readFile(join(root, rel), 'utf8').catch(() => '');
    for (const m of text.matchAll(CASE_MARKER)) {
      const id = m[1];
      if (id && !found.has(id)) found.set(id, rel);
    }
  }
  return found;
}

/** Best-effort per-case results parsed from command logs — lines like
 *  `case:c1 ... ok` / `ok ... case:c1`. Optional; absent → undefined. */
async function parseCaseResults(
  logPaths: string[],
): Promise<Map<string, 'pass' | 'fail' | 'skip'>> {
  const results = new Map<string, 'pass' | 'fail' | 'skip'>();
  for (const lp of logPaths) {
    const text = await readFile(lp, 'utf8').catch(() => '');
    for (const m of text.matchAll(CASE_RESULT)) {
      const id = m[1];
      const word = (m[2] ?? '').toLowerCase();
      if (!id || results.has(id)) continue;
      if (word === 'not ok' || word.startsWith('fail')) results.set(id, 'fail');
      else if (word.startsWith('skip')) results.set(id, 'skip');
      else if (word.startsWith('pass') || word === 'ok')
        results.set(id, 'pass');
    }
  }
  return results;
}

interface SpawnOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** Spawn `command` detached (own process group, unref'd), stream
 *  stdout+stderr to `logPath`, resolve on exit. On timeout the whole
 *  process group gets SIGTERM → SIGKILL after a grace period. */
function runDetached(
  command: string,
  cwd: string,
  logPath: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<SpawnOutcome> {
  return new Promise((res) => {
    const started = Date.now();
    const log = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    child.unref();

    let timedOut = false;
    let settled = false;
    const finish = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.end();
      res(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5_000).unref();
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err) => {
      log.write(`spawn error: ${err.message}\n`);
      finish({ exitCode: null, timedOut, durationMs: Date.now() - started });
    });
    child.on('exit', (code) => {
      finish({ exitCode: code, timedOut, durationMs: Date.now() - started });
    });
  });
}

/**
 * Execute the repo card's `test`/`lint`/`build` sequentially as a
 * detached verify task; write per-command logs + `test-report.json`
 * into `runDir`. Always writes a report — even on failure or timeout —
 * because the report IS the ground truth (SCHEMAS §10).
 */
export async function runVerifyTask(
  opts: VerifyTaskOptions,
): Promise<VerifyResult> {
  const cwd = opts.worktree ?? opts.repoPath;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env ?? {};
  await mkdir(join(opts.runDir, 'logs'), { recursive: true });

  const commands: Array<[string, string]> = (
    [
      ['test', opts.card.test],
      ['lint', opts.card.lint],
      ['build', opts.card.build],
    ] as Array<[string, string | undefined]>
  ).filter((c): c is [string, string] => typeof c[1] === 'string');

  const results: VerifyCommandResult[] = [];
  let remaining = timeoutMs;
  const deadline = Date.now() + timeoutMs;

  for (const [name, command] of commands) {
    const logPath = join(opts.runDir, 'logs', `${name}.log`);
    const outcome = await runDetached(
      command,
      cwd,
      logPath,
      Math.max(1, remaining),
      env,
    );
    results.push({
      name,
      command,
      exitCode: outcome.timedOut ? 124 : outcome.exitCode,
      logPath,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
    });
    remaining = deadline - Date.now();
    if (outcome.timedOut || remaining <= 0) break;
  }

  const failed = results.find((r) => r.exitCode !== 0);
  const exitCode = failed?.exitCode ?? 0;
  const timedOut = results.some((r) => r.timedOut);

  // case:-marker linkage (SCHEMAS §4/§10)
  const testFiles = await findTestFiles(cwd, opts.testFileGlobs);
  const markers = await grepCaseMarkers(cwd, testFiles);
  const caseResults = await parseCaseResults(results.map((r) => r.logPath));

  const plannedIds = opts.plannedCases ?? [...new Set([...markers.keys()])];
  const cases: TestReportCase[] = plannedIds.map((id) => {
    const file = markers.get(id);
    const result = caseResults.get(id);
    return {
      case_id: id,
      implemented: file !== undefined,
      ...(file !== undefined ? { file } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  });
  const implemented = cases.filter((c) => c.implemented).length;
  const withResults = cases.filter((c) => c.result !== undefined);
  const passPct =
    withResults.length > 0
      ? Math.round(
          (withResults.filter((c) => c.result === 'pass').length /
            withResults.length) *
            1000,
        ) / 10
      : exitCode === 0
        ? 100
        : 0;

  const report: TestReport = TestReportSchema.parse({
    schema: 1,
    ticket: opts.ticket ?? opts.runId,
    ts: new Date().toISOString(),
    command: commands.map((c) => c[1]).join(' && '),
    cases,
    pass_pct: passPct,
    planned: plannedIds.length,
    implemented,
    risks: [
      ...(timedOut ? ['verify task timed out — killed by runner'] : []),
      ...(existsSync(cwd) ? [] : [`worktree missing: ${cwd}`]),
    ],
  });

  const reportPath = join(opts.runDir, 'test-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return { exitCode, timedOut, commands: results, report, reportPath };
}
