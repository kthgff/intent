/**
 * Sanitizer — runner-owned secret scan of artifacts before every
 * tickets-repo commit (CONDUCTOR reconcile step 1, SETTINGS
 * `security.scanner`, `security.scan_on_commit`).
 *
 * FAIL-CLOSED: any non-clean result — missing binary, scan error, or
 * findings — must be treated by callers as a block that surfaces a
 * `repair` gate item. This module never throws on scan failures; it
 * returns a ScanResult.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** A single scanner finding — kept as the scanner's raw record shape
 *  (gitleaks JSON array entries; trufflehog JSONL objects). */
export type ScanFinding = Record<string, unknown>;

export type ScanResult =
  | { ok: true; scanner: string; findings: ScanFinding[] }
  | {
      ok: false;
      scanner: string;
      reason: 'scanner-missing' | 'scan-error' | 'findings';
      findings: ScanFinding[];
      detail?: string;
    };

export interface ScanOptions {
  /** `security.scanner` — default `gitleaks`. */
  scanner?: string;
  /** Per-invocation timeout (ms). Default 120s. */
  timeoutMs?: number;
  /** Extra env merged over process.env (e.g. PATH overrides in tests). */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Resolve a scanner binary: absolute paths are checked directly,
 *  bare names are searched on PATH (`which`-equivalent). */
export async function findScanner(
  name: string,
  env: Record<string, string> = {},
): Promise<string | null> {
  const candidates: string[] = [];
  if (name.includes('/') || isAbsolute(name)) {
    candidates.push(name);
  } else {
    const pathEnv = env.PATH ?? process.env.PATH ?? '';
    for (const dir of pathEnv.split(':')) {
      if (dir) candidates.push(join(dir, name));
    }
  }
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

interface RawScan {
  exitCode: number;
  findings: ScanFinding[];
  detail?: string;
}

/** gitleaks v8: `gitleaks dir <path> --report-format json
 *  --report-path <file>`. Exit 0 = clean, exit 1 = leaks found,
 *  anything else = error. Report file holds a JSON array. */
async function scanPathGitleaks(
  binary: string,
  target: string,
  reportPath: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<RawScan> {
  return new Promise((res) => {
    execFile(
      binary,
      ['dir', target, '--report-format', 'json', '--report-path', reportPath],
      {
        timeout: timeoutMs,
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
      },
      async (error, _stdout, stderr) => {
        let findings: ScanFinding[] = [];
        try {
          const raw = await readFile(reportPath, 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) findings = parsed as ScanFinding[];
        } catch {
          /* no/invalid report file — handled via exit code below */
        }
        if (!error) {
          res({ exitCode: 0, findings });
          return;
        }
        const code = (error as { code?: number | string }).code;
        if (error.killed) {
          res({ exitCode: -1, findings, detail: 'scanner timed out' });
        } else if (code === 1 || findings.length > 0) {
          res({ exitCode: 1, findings, detail: stderr?.trim() });
        } else {
          res({
            exitCode: typeof code === 'number' ? code : -1,
            findings,
            detail: stderr?.trim() || error.message,
          });
        }
      },
    );
  });
}

/** trufflehog: `trufflehog filesystem <path> --json` — findings are
 *  JSONL on stdout, exit code stays 0; findings are detected by output. */
async function scanPathTrufflehog(
  binary: string,
  target: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<RawScan> {
  return new Promise((res) => {
    execFile(
      binary,
      ['filesystem', target, '--json', '--no-update'],
      {
        timeout: timeoutMs,
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const findings: ScanFinding[] = (stdout ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as ScanFinding];
            } catch {
              return [];
            }
          });
        if (error) {
          res({
            exitCode:
              typeof (error as { code?: number }).code === 'number'
                ? ((error as { code?: number }).code as number)
                : -1,
            findings,
            detail: error.killed
              ? 'scanner timed out'
              : stderr?.trim() || error.message,
          });
          return;
        }
        res({ exitCode: findings.length > 0 ? 1 : 0, findings });
      },
    );
  });
}

/**
 * Scan the given files/dirs with `security.scanner` (default gitleaks).
 * Fail-closed contract: callers must treat ANY result with `ok: false`
 * as a commit block — `scanner-missing` (binary absent), `scan-error`
 * (scanner failed), or `findings` (secrets detected).
 */
export async function scanArtifacts(
  paths: string[],
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const scanner = opts.scanner ?? 'gitleaks';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env ?? {};

  const binary = await findScanner(scanner, env);
  if (!binary) {
    return { ok: false, scanner, reason: 'scanner-missing', findings: [] };
  }

  const reportDir = await mkdtemp(join(tmpdir(), 'sr-scan-'));
  const all: ScanFinding[] = [];
  try {
    for (const p of paths) {
      const target = resolve(p);
      const raw =
        scanner === 'trufflehog'
          ? await scanPathTrufflehog(binary, target, timeoutMs, env)
          : await scanPathGitleaks(
              binary,
              target,
              join(reportDir, `report-${all.length}-${Date.now()}.json`),
              timeoutMs,
              env,
            );
      all.push(...raw.findings);
      if (raw.exitCode === 1 || raw.findings.length > 0) {
        return {
          ok: false,
          scanner,
          reason: 'findings',
          findings: all,
          ...(raw.detail ? { detail: raw.detail } : {}),
        };
      }
      if (raw.exitCode !== 0) {
        return {
          ok: false,
          scanner,
          reason: 'scan-error',
          findings: all,
          ...(raw.detail ? { detail: raw.detail } : {}),
        };
      }
    }
    return { ok: true, scanner, findings: all };
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

/**
 * Convenience: scan the staged files of a repo before commit
 * (CONDUCTOR reconcile: sanitizer scan blocks the commit).
 * `stagedFiles` are repo-relative paths; only existing files are scanned.
 */
export async function scanForCommit(
  repoPath: string,
  stagedFiles: string[],
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const { access: accessFile } = await import('node:fs/promises');
  const existing: string[] = [];
  for (const f of stagedFiles) {
    const abs = resolve(repoPath, f);
    try {
      await accessFile(abs);
      existing.push(abs);
    } catch {
      /* staged-then-deleted — nothing to scan */
    }
  }
  if (existing.length === 0) {
    return { ok: true, scanner: opts.scanner ?? 'gitleaks', findings: [] };
  }
  return scanArtifacts(existing, opts);
}
