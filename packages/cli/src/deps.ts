/**
 * deps.ts — PATH dependency detection for `doctor`/`init` (wp-099).
 *
 * AGENTS.md "External dependencies": git, gitleaks (fail-closed
 * sanitizer), gh (PR/shepherd ops), docker (D30 container runtime —
 * absent daemon = hard error for `runtime: container` backends) are
 * required at runtime; backend CLIs `devin`/`aider` are per-config.
 *
 * Every check is injectable (`run` / `finders`) so tests never depend
 * on this machine's actual toolchain.
 */
import { spawnSync } from 'node:child_process';
import { findAiderBinary, findDevinBinary } from '@sprint-runner/adapters';
import type { EffectiveConfig } from '@sprint-runner/config';
import { createClient } from '@sprint-runner/store';

export interface DepCheck {
  /** Binary/dep name (`git`, `gitleaks`, `gh`, `docker`, `devin`, …). */
  name: string;
  /** Resolved — binary present and, where relevant, daemon reachable. */
  ok: boolean;
  /** A missing required dep = nonzero exit + named remediation. */
  required: boolean;
  /** Why this dep is required (shown in the report). */
  why: string;
  version?: string;
  detail?: string;
  remediation?: string;
}

/** One `<bin> <args>` probe — injectable. `ok` = spawned AND exit 0. */
export type ProbeRun = (
  bin: string,
  args: string[],
) => { ok: boolean; stdout: string };

const defaultRun: ProbeRun = (bin, args) => {
  const res = spawnSync(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return {
    ok: res.error == null && res.status === 0,
    stdout: (res.stdout ?? '').toString(),
  };
};

/** First version-looking token in a `--version` line. */
function versionOf(stdout: string): string | undefined {
  const line = stdout
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim();
  return line && line.length > 0 ? line.slice(0, 80) : undefined;
}

function onPath(
  run: ProbeRun,
  bin: string,
  versionArgs: string[] = ['--version'],
): { ok: boolean; version?: string } {
  const r = run(bin, versionArgs);
  const v = versionOf(r.stdout);
  return r.ok
    ? { ok: true, ...(v !== undefined ? { version: v } : {}) }
    : { ok: false };
}

/**
 * The container runtime that applies to the configured backend (D30).
 * `containers.runtime` is not yet in the config schema (container wave
 * wp-095+) — read it defensively so the check honors the setting the
 * moment the schema lands; until then `aider` defaults to `container`
 * and everything else to `process` (CONDUCTOR.md / SETTINGS.md).
 */
export function containerRuntimeFor(
  config: Pick<EffectiveConfig, 'backend'> & {
    containers?: { runtime?: string };
  },
): 'container' | 'process' {
  const runtime = config.containers?.runtime;
  if (runtime === 'container' || runtime === 'process') return runtime;
  return config.backend === 'aider' ? 'container' : 'process';
}

export interface ProbeOptions {
  /** Effective or partial config — `backend`, `security.scan_on_commit`,
   *  `containers.runtime` drive the `required` flags. */
  backend?: string;
  scanOnCommit?: boolean;
  containersRuntime?: 'container' | 'process';
  run?: ProbeRun;
  /** Backend-binary resolvers — injectable for tests. Default: the
   *  adapters' finders (PATH → env → bundled fallbacks). */
  finders?: {
    devin?: () => string;
    aider?: () => unknown;
  };
}

/**
 * Detect every external dependency. Pure probe — no state changes.
 * `required` reflects the configured backend + fail-closed sanitizer.
 */
export function probeDeps(opts: ProbeOptions = {}): DepCheck[] {
  const run = opts.run ?? defaultRun;
  const backend = opts.backend ?? 'devin';
  const scanOnCommit = opts.scanOnCommit ?? true;
  const runtime =
    opts.containersRuntime ?? (backend === 'aider' ? 'container' : 'process');
  const finders = opts.finders ?? {};
  const checks: DepCheck[] = [];

  // --- node (engines: >=22) ---
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0);
  checks.push({
    name: 'node',
    ok: nodeMajor >= 22,
    required: true,
    why: 'engines: >=22',
    version: process.version,
    ...(nodeMajor >= 22
      ? {}
      : { remediation: 'upgrade Node to >=22 (see package.json engines)' }),
  });

  // --- git ---
  const git = onPath(run, 'git');
  checks.push({
    name: 'git',
    ok: git.ok,
    required: true,
    why: 'worktrees + code-repo commits (shell out, AGENTS.md)',
    ...(git.version ? { version: git.version } : {}),
    ...(git.ok
      ? {}
      : { remediation: 'install git (xcode CLT / apt / brew install git)' }),
  });

  // --- gitleaks — fail-closed sanitizer (security.scan_on_commit) ---
  const gitleaks = onPath(run, 'gitleaks', ['version']);
  checks.push({
    name: 'gitleaks',
    ok: gitleaks.ok,
    required: scanOnCommit,
    why: 'secret sanitizer — security.scan_on_commit is FAIL-CLOSED',
    ...(gitleaks.version ? { version: gitleaks.version } : {}),
    ...(gitleaks.ok || !scanOnCommit
      ? {}
      : {
          remediation:
            'install gitleaks (brew install gitleaks / https://github.com/gitleaks/gitleaks) ' +
            'or set security.scan_on_commit: false (NOT recommended)',
        }),
    ...(!gitleaks.ok && !scanOnCommit
      ? { detail: 'scan_on_commit=false — commit scans disabled' }
      : {}),
  });

  // --- gh — shepherd + PR ops ---
  const gh = onPath(run, 'gh');
  checks.push({
    name: 'gh',
    ok: gh.ok,
    required: true,
    why: 'PR/shepherd ops (gh pr create/checks/comments)',
    ...(gh.version ? { version: gh.version } : {}),
    ...(gh.ok
      ? {}
      : {
          remediation: 'install GitHub CLI (brew install gh) + gh auth login',
        }),
  });

  // --- docker — binary + daemon; required for runtime: container ---
  const dockerBin = onPath(run, 'docker');
  if (!dockerBin.ok) {
    checks.push({
      name: 'docker',
      ok: false,
      required: runtime === 'container',
      why: 'D30 container runtime (containers.runtime=container)',
      remediation:
        'install Docker and start the daemon (required for ' +
        '`runtime: container` backends — absent daemon is a hard error)',
    });
  } else {
    const info = run('docker', ['info', '--format', '{{.ServerVersion}}']);
    const daemon = info.ok;
    checks.push({
      name: 'docker',
      ok: daemon,
      required: runtime === 'container',
      why:
        runtime === 'container'
          ? 'D30 container runtime (backend default)'
          : 'D30 container runtime (not configured — informational)',
      ...(dockerBin.version ? { version: dockerBin.version } : {}),
      ...(daemon
        ? {}
        : {
            detail: 'docker binary present but daemon is not reachable',
            remediation:
              runtime === 'container'
                ? 'start the Docker daemon (docker desktop / systemctl start docker) ' +
                  'or set containers.runtime: process'
                : 'start the Docker daemon only if you switch to runtime: container',
          }),
    });
  }

  // --- backend CLIs — per-config (required only when configured) ---
  const findDevin = finders.devin ?? (() => findDevinBinary());
  const findAider = finders.aider ?? (() => findAiderBinary());
  const backends: {
    name: 'devin' | 'aider';
    find: () => unknown;
    remediation: string;
  }[] = [
    {
      name: 'devin',
      find: findDevin,
      remediation:
        'install Devin.app (bundled CLI) or put `devin` on PATH / set DEVIN_BIN',
    },
    {
      name: 'aider',
      find: findAider,
      remediation:
        'install aider-chat (pipx install aider-chat / uvx) or put `aider` on PATH / set AIDER_BIN',
    },
  ];
  for (const b of backends) {
    const required = backend === b.name;
    try {
      const resolved = b.find();
      checks.push({
        name: b.name,
        ok: true,
        required,
        why: required
          ? `configured backend (backend: ${b.name})`
          : 'backend CLI — available, not configured',
        detail:
          typeof resolved === 'string' ? resolved : JSON.stringify(resolved),
      });
    } catch (e) {
      checks.push({
        name: b.name,
        ok: false,
        required,
        why: required
          ? `configured backend (backend: ${b.name})`
          : 'backend CLI — not configured',
        detail: (e as Error).message.split('\n')[0] ?? 'unknown error',
        remediation: b.remediation,
      });
    }
  }
  return checks;
}

/** Storage reachability — `postgres://…` connect + `SELECT 1`.
 *  `pglite:`/`:memory:` are embedded → always reachable. Fail-closed:
 *  an unreachable DB means daemon/tick/status cannot run at all. */
export async function checkStorage(
  storageUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<DepCheck> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const base: Omit<DepCheck, 'ok' | 'detail'> = {
    name: 'storage',
    required: true,
    why: 'Postgres is the system of record (D29 — storage_url)',
  };
  if (storageUrl === ':memory:' || storageUrl.startsWith('pglite:')) {
    return { ...base, ok: true, detail: 'embedded PGlite (test/dev mode)' };
  }
  try {
    const client = await createClient(storageUrl);
    try {
      await Promise.race([
        client.query('SELECT 1'),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('connect timeout')), timeoutMs),
        ),
      ]);
    } finally {
      await client.close().catch(() => {});
    }
    return { ...base, ok: true, detail: storageUrl };
  } catch (e) {
    return {
      ...base,
      ok: false,
      detail: `${storageUrl} — ${(e as Error).message}`,
      remediation:
        'start Postgres (managed-docker provisioning lands with its wave) ' +
        'or set storage_url: in config.yaml',
    };
  }
}

/** Names of required checks that failed — drives exit codes. */
export function missingRequired(checks: DepCheck[]): DepCheck[] {
  return checks.filter((c) => c.required && !c.ok);
}

/** Human-readable dep report (init + doctor share it). */
export function formatDepsReport(checks: DepCheck[]): string {
  const lines: string[] = [];
  const width = Math.max(...checks.map((c) => c.name.length), 4);
  for (const c of checks) {
    const state = c.ok
      ? 'ok'
      : c.required
        ? 'MISSING (required)'
        : 'missing (optional)';
    const head = `  ${c.name.padEnd(width)}  ${(c.version ?? '').padEnd(22)} ${state}`;
    lines.push(head);
    const notes = [c.why, c.detail, !c.ok ? c.remediation : undefined].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    for (const n of notes) {
      lines.push(`${' '.repeat(width + 6)}${n}`);
    }
  }
  return lines.join('\n');
}
