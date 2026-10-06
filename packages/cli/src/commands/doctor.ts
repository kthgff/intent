/**
 * `doctor` — dependency detection report (wp-099). Extends init's
 * probe: the `docker` check respects the effective container runtime
 * (D30 — `runtime: container` backends hard-require a live daemon),
 * and `storage` probes `storage_url` reachability. Works pre-init:
 * a missing/malformed config is reported as a check row, not a crash.
 *
 * Exit 1 when any REQUIRED dep is missing — named remediation printed.
 */
import {
  ConfigError,
  type PartialConfig,
  defaultGlobalConfigPath,
  loadGlobalConfig,
} from '@veto/config';
import { ConfigSchema } from '@veto/core';
import {
  type DepCheck,
  checkStorage,
  containerRuntimeFor,
  formatDepsReport,
  missingRequired,
  probeDeps,
} from '../deps.js';

const DEFAULTS = ConfigSchema.parse({ schema: 1 });

export interface DoctorOptions {
  configPath?: string;
  json?: boolean;
  io: { out(s: string): void; err(s: string): void };
  /** Injectable probes (tests). */
  probe?: typeof probeDeps;
  storage?: typeof checkStorage;
}

export async function cmdDoctor(opts: DoctorOptions): Promise<number> {
  const { io } = opts;
  const configPath = opts.configPath ?? defaultGlobalConfigPath();

  // Config row — doctor reports loadability instead of dying.
  let partial: PartialConfig = {};
  let storageUrl = DEFAULTS.storage_url;
  const configErrors: string[] = [];
  try {
    const loaded = loadGlobalConfig(configPath);
    partial = loaded.config;
    storageUrl = partial.storage_url ?? DEFAULTS.storage_url;
  } catch (e) {
    configErrors.push(
      e instanceof ConfigError ? e.message : (e as Error).message,
    );
  }

  const backend = partial.backend ?? 'devin';
  const runtime = containerRuntimeFor({
    backend,
    // `containers.*` is not yet in the config schema (wp-095 wave) —
    // honor it defensively if a future config carries it.
    ...(((partial as Record<string, unknown>).containers as
      | { runtime?: string }
      | undefined) !== undefined
      ? {
          containers: (partial as Record<string, unknown>).containers as {
            runtime?: string;
          },
        }
      : {}),
  });

  const checks: DepCheck[] = (opts.probe ?? probeDeps)({
    backend,
    scanOnCommit: partial.security?.scan_on_commit ?? true,
    containersRuntime: runtime,
  });
  // Config itself is a required check — daemon/tick fail without it.
  checks.unshift({
    name: 'config',
    ok: configErrors.length === 0,
    required: true,
    why: 'config.yaml parses + actor is set',
    ...(configErrors.length === 0
      ? { detail: configPath }
      : {
          detail: configErrors.join('; '),
          remediation: 'run `veto init` to scaffold, or fix config.yaml',
        }),
  });
  checks.push(await (opts.storage ?? checkStorage)(storageUrl));

  if (opts.json) {
    io.out(JSON.stringify({ checks }, null, 2));
  } else {
    io.out('doctor — dependency report');
    io.out('');
    io.out(formatDepsReport(checks));
  }

  const missing = missingRequired(checks);
  if (missing.length > 0) {
    if (!opts.json) {
      io.out('');
      for (const c of missing) {
        io.out(`MISSING: ${c.name} — ${c.remediation ?? 'install it'}`);
      }
    }
    return 1;
  }
  if (!opts.json) {
    io.out('');
    io.out('all required dependencies present');
  }
  return 0;
}
