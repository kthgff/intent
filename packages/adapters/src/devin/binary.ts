/**
 * devin binary discovery (ADAPTERS.md "Backend specifics" + wp-022).
 * Order: `devin` on PATH → `DEVIN_BIN` env → Devin.app bundled path
 * (macOS) → clean error at adapter init, never mid-run.
 */
import { spawnSync } from 'node:child_process';
import { constants, accessSync } from 'node:fs';

/** Devin.app bundled CLI (AGENTS.md "External dependencies"). */
export const DEVIN_APP_BUNDLE_PATH =
  '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin';

export class DevinBinaryNotFoundError extends Error {
  constructor(checked: string[]) {
    super(
      `devin binary not found — checked: ${checked.join(', ')}. Install Devin.app, put devin on PATH, or set DEVIN_BIN.`,
    );
    this.name = 'DevinBinaryNotFoundError';
  }
}

export interface FindDevinBinaryOptions {
  /** Environment to inspect (defaults to process.env — injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /** Devin.app bundle path to fall back to (injectable for tests). */
  appBundlePath?: string;
  /** PATH lookup — injectable for tests; default probes `devin --version`. */
  onPath?: (env: NodeJS.ProcessEnv) => boolean;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultOnPath(env: NodeJS.ProcessEnv): boolean {
  const res = spawnSync('devin', ['--version'], {
    env,
    stdio: 'ignore',
  });
  return res.error === undefined || res.error === null;
}

/**
 * Resolve the devin binary. Returns `'devin'` (PATH lookup deferred to
 * spawn) or an absolute path. Throws {@link DevinBinaryNotFoundError}
 * when nothing resolves — call at adapter init so a missing binary is
 * a startup error, not a mid-run surprise.
 */
export function findDevinBinary(opts: FindDevinBinaryOptions = {}): string {
  const env = opts.env ?? process.env;
  const appBundlePath = opts.appBundlePath ?? DEVIN_APP_BUNDLE_PATH;
  const onPath = opts.onPath ?? defaultOnPath;
  const checked: string[] = [];

  checked.push('devin on PATH');
  if (onPath(env)) return 'devin';

  const devinBin = env.DEVIN_BIN;
  if (devinBin !== undefined && devinBin !== '') {
    checked.push(`DEVIN_BIN=${devinBin}`);
    if (isExecutable(devinBin)) return devinBin;
  } else {
    checked.push('DEVIN_BIN (unset)');
  }

  checked.push(`Devin.app bundle ${appBundlePath}`);
  if (isExecutable(appBundlePath)) return appBundlePath;

  throw new DevinBinaryNotFoundError(checked);
}
