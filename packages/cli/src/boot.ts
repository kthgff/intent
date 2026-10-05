/**
 * boot.ts — shared runtime assembly for `daemon`/`tick` (wp-099).
 *
 * One process boots the same embedded engine the app embeds:
 *   config (SETTINGS.md layers) → PostgresStore (migrations apply at
 *   connect, fail-closed) → workspaces from `projects` rows → lazy
 *   adapters per `backend:` → Conductor + RealTransitionHandler.
 */
import { mkdir } from 'node:fs/promises';
import {
  AiderAdapter,
  DevinAdapter,
  MockAdapter,
} from '@sprint-runner/adapters';
import {
  Conductor,
  type ConductorWorkspace,
  RealTransitionHandler,
} from '@sprint-runner/conductor';
import {
  type EffectiveConfig,
  type LoadedConfig,
  defaultGlobalConfigPath,
  loadGlobalConfig,
  resolveConfig,
} from '@sprint-runner/config';
import type { Adapter } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { overlayRepoCards } from './cards.js';
import { runsDir as defaultRunsDir, defaultWorkspaceRoot } from './paths.js';

export interface BootOptions {
  /** `--config <path>` override — defaults to
   *  `~/.config/sprint-runner/config.yaml`. */
  configPath?: string;
  /** Run-dir root override (tests). */
  runsDir?: string;
  /** Sink for async conductor-path errors. */
  onError?: (error: unknown) => void;
}

export interface BootedRuntime {
  configPath: string;
  loaded: LoadedConfig;
  config: EffectiveConfig;
  store: PostgresStore;
  workspaces: ConductorWorkspace[];
  conductor: Conductor;
  /** Repo-card overlay + config warnings surfaced at boot. */
  warnings: string[];
}

/**
 * Load + resolve the effective config (global layer; the workspace
 * `.sprint-runner/config.yaml` and `projects.settings` precedence
 * layers are not wired into ConductorDeps yet — see TRACKER wp-099
 * decision log). Throws ConfigError — callers fail closed.
 */
export function loadRuntimeConfig(configPath?: string): {
  configPath: string;
  loaded: LoadedConfig;
  config: EffectiveConfig;
} {
  const path = configPath ?? defaultGlobalConfigPath();
  const loaded = loadGlobalConfig(path);
  const config = resolveConfig(null, loaded);
  return { configPath: path, loaded, config };
}

/**
 * Workspaces from `projects` rows (D29). The row's
 * `settings.path` is the persisted root (written by `veto init` and
 * POST /workspaces); absent → the default workspaces dir — the same
 * derivation the API uses for `POST /workspaces` without a `path`.
 */
export async function workspacesFromProjects(
  store: PostgresStore,
): Promise<ConductorWorkspace[]> {
  const projects = await store.listProjects();
  return projects.map((p) => {
    const stored = (p.settings as Record<string, unknown> | undefined)?.path;
    return {
      name: p.workspace,
      rootPath:
        typeof stored === 'string' && stored.length > 0
          ? stored
          : defaultWorkspaceRoot(p.workspace),
    };
  });
}

/**
 * The configured backend's adapter is constructed EAGERLY (a missing
 * binary is a clean startup error — AGENTS.md); every other known
 * backend resolves lazily on first use so a per-ticket `backend:`
 * override errors in the launch path, not at boot. Unknown backend
 * names surface `adapterFor`'s own error.
 */
export function makeAdapters(config: EffectiveConfig): Record<string, Adapter> {
  const cache = new Map<string, Adapter>();
  const construct = (name: string): Adapter => {
    const hit = cache.get(name);
    if (hit) return hit;
    let adapter: Adapter;
    switch (name) {
      case 'devin':
        adapter = new DevinAdapter({
          permissionMode: config.permission_mode,
          ...(config.main_model != null ? { model: config.main_model } : {}),
        });
        break;
      case 'aider':
        adapter = new AiderAdapter({
          ...(config.main_model != null ? { model: config.main_model } : {}),
          env: config.secrets,
        });
        break;
      case 'mock':
        // Test backend (D18) — registered so `backend: mock` works for
        // local dry-runs against a seeded fixture.
        adapter = new MockAdapter();
        break;
      default:
        throw new Error(
          `no adapter registered for backend '${name}' (SETTINGS capabilities:)`,
        );
    }
    cache.set(name, adapter);
    return adapter;
  };
  // Eager: the configured backend missing its binary is a startup
  // error (fail closed), never a mid-run surprise.
  construct(config.backend);
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (typeof key !== 'string') return undefined;
        if (!['devin', 'aider', 'mock'].includes(key)) return undefined;
        return construct(key);
      },
      has: (_t, key) =>
        typeof key === 'string' && ['devin', 'aider', 'mock'].includes(key),
      ownKeys: () => [...cache.keys()],
      getOwnPropertyDescriptor: () => ({
        enumerable: true,
        configurable: true,
      }),
    },
  ) as Record<string, Adapter>;
}

/**
 * Light boot for read-only commands (`status`): config + store +
 * workspaces — no adapters, no conductor.
 */
export async function bootConfigAndStore(opts: BootOptions = {}): Promise<{
  configPath: string;
  config: EffectiveConfig;
  store: PostgresStore;
  workspaces: ConductorWorkspace[];
}> {
  const { configPath, config } = loadRuntimeConfig(opts.configPath);
  const store = await PostgresStore.connect(config.storage_url);
  const workspaces = await workspacesFromProjects(store);
  return { configPath, config, store, workspaces };
}

/**
 * Full boot: config → store (migrations) → workspaces → conductor.
 * `deps.workspaces` is the same array the API mutates on
 * POST /workspaces — keep the reference stable.
 */
export async function bootRuntime(
  opts: BootOptions = {},
): Promise<BootedRuntime> {
  const { configPath, loaded, config } = loadRuntimeConfig(opts.configPath);
  const warnings = [...config.warnings];

  const store = await PostgresStore.connect(config.storage_url);

  const workspaces = await workspacesFromProjects(store);
  for (const ws of workspaces) {
    await mkdir(ws.rootPath, { recursive: true });
  }

  // Repo cards live in each repo's .sprint-runner/card.json — overlay
  // them onto the effective config so probes' `verified` lands.
  const cards = await overlayRepoCards(config, workspaces);
  warnings.push(...cards.warnings);

  const conductor = new Conductor({
    store,
    adapters: makeAdapters(config),
    config,
    workspaces,
    runsDir: opts.runsDir ?? defaultRunsDir(),
    transitions: new RealTransitionHandler(config),
    ...(opts.onError ? { onError: opts.onError } : {}),
  });

  return { configPath, loaded, config, store, workspaces, conductor, warnings };
}
