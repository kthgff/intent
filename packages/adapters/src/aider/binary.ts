/**
 * aider binary discovery (ADAPTERS.md "Backend specifics" + wp-052).
 * Order: `aider` on PATH → `AIDER_BIN` env → `pipx run aider-chat` /
 * `uvx aider-chat` launcher shims → clean error at adapter init, never
 * mid-run.
 *
 * A shim resolves to an invocation prefix (`pipx run aider-chat …`)
 * rather than a bare binary — {@link AiderInvocation} carries both so
 * run() can prepend the launcher args.
 */
import { spawnSync } from 'node:child_process';
import { constants, accessSync } from 'node:fs';

/** Resolved aider invocation: binary plus any launcher prefix args. */
export interface AiderInvocation {
  /** Executable to spawn (`aider`, an absolute path, `pipx`, `uvx`). */
  bin: string;
  /** Args prepended before the aider flags (e.g. ['run','aider-chat']). */
  prefixArgs: string[];
  /** How the binary was resolved — for diagnostics/errors. */
  source: string;
}

export class AiderBinaryNotFoundError extends Error {
  constructor(checked: string[]) {
    super(
      `aider binary not found — checked: ${checked.join(', ')}. Install aider-chat (pipx/uvx), put aider on PATH, or set AIDER_BIN.`,
    );
    this.name = 'AiderBinaryNotFoundError';
  }
}

export interface FindAiderBinaryOptions {
  /** Environment to inspect (defaults to process.env — injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /** Probe whether `aider` runs on PATH — injectable for tests. */
  onPath?: (env: NodeJS.ProcessEnv) => boolean;
  /** Probe whether `pipx run aider-chat` works — injectable for tests. */
  pipx?: (env: NodeJS.ProcessEnv) => boolean;
  /** Probe whether `uvx aider-chat` works — injectable for tests. */
  uvx?: (env: NodeJS.ProcessEnv) => boolean;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probe(argv: string[], env: NodeJS.ProcessEnv): boolean {
  const res = spawnSync(argv[0] as string, [...argv.slice(1), '--version'], {
    env,
    stdio: 'ignore',
  });
  return res.error === undefined || res.error === null;
}

const defaultOnPath = (env: NodeJS.ProcessEnv): boolean =>
  probe(['aider'], env);
const defaultPipx = (env: NodeJS.ProcessEnv): boolean =>
  probe(['pipx', 'run', 'aider-chat'], env);
const defaultUvx = (env: NodeJS.ProcessEnv): boolean =>
  probe(['uvx', 'aider-chat'], env);

/**
 * Resolve the aider invocation. Throws {@link AiderBinaryNotFoundError}
 * when nothing resolves — call at adapter init so a missing backend is
 * a startup error, not a mid-run surprise.
 */
export function findAiderBinary(
  opts: FindAiderBinaryOptions = {},
): AiderInvocation {
  const env = opts.env ?? process.env;
  const onPath = opts.onPath ?? defaultOnPath;
  const pipx = opts.pipx ?? defaultPipx;
  const uvx = opts.uvx ?? defaultUvx;
  const checked: string[] = [];

  checked.push('aider on PATH');
  if (onPath(env)) {
    return { bin: 'aider', prefixArgs: [], source: 'PATH' };
  }

  const aiderBin = env.AIDER_BIN;
  if (aiderBin !== undefined && aiderBin !== '') {
    checked.push(`AIDER_BIN=${aiderBin}`);
    if (isExecutable(aiderBin)) {
      return { bin: aiderBin, prefixArgs: [], source: 'AIDER_BIN' };
    }
  } else {
    checked.push('AIDER_BIN (unset)');
  }

  checked.push('pipx run aider-chat');
  if (pipx(env)) {
    return {
      bin: 'pipx',
      prefixArgs: ['run', 'aider-chat'],
      source: 'pipx run aider-chat',
    };
  }

  checked.push('uvx aider-chat');
  if (uvx(env)) {
    return {
      bin: 'uvx',
      prefixArgs: ['aider-chat'],
      source: 'uvx aider-chat',
    };
  }

  throw new AiderBinaryNotFoundError(checked);
}
