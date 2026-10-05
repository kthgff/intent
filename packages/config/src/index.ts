/**
 * @sprint-runner/config — layered config loading per SETTINGS.md.
 *
 * Precedence (highest wins):
 *   ticket frontmatter > <tickets-repo>/.sprint-runner/config.yaml
 *   > ~/.config/sprint-runner/config.yaml > defaults.
 *
 * Secrets live ONLY in .env files / env vars — parsed into a secrets
 * map and never surfaced in warnings or error messages.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Config, ConfigSchema } from '@sprint-runner/core';
import YAML from 'yaml';
import { parseEnv } from './env.js';
import { type PlainObject, deepMerge, isPlainObject } from './merge.js';
import {
  ConfigError,
  type PartialConfig,
  formatZodIssues,
  parsePartialConfig,
} from './validate.js';

export {
  DEFAULT_EVAL_THRESHOLD,
  EVAL_FAMILIES,
  type EvalFamily,
  STRICT_EVAL_FAMILIES,
  STRICT_EVAL_FLOOR,
  effectiveEvalThreshold,
  evalThresholdsFromRegistry,
  isStrictEvalFamily,
} from './eval.js';
export { parseEnv } from './env.js';
export { deepMerge, isPlainObject } from './merge.js';
export {
  ConfigError,
  PartialConfigSchema,
  assertNoUnknownKeys,
  formatZodIssues,
  parsePartialConfig,
  validConfigPaths,
} from './validate.js';
export { mergeConfigFile } from './write.js';
export type { PartialConfig } from './validate.js';

/** Result of loading one or more config/env layers. */
export interface LoadedConfig {
  /** Merged, partially-validated config (defaults not yet applied). */
  config: PartialConfig;
  warnings: string[];
  /** Secrets from `.env` files — never log these values. */
  secrets: Record<string, string>;
  /** Absolute paths of files that were read. */
  files: string[];
}

/** Fully-resolved config: defaults applied + diagnostics attached. */
export type EffectiveConfig = Config & {
  warnings: string[];
  /** Secrets from `.env` files — never log these values. */
  secrets: Record<string, string>;
};

export function defaultGlobalConfigPath(): string {
  return join(homedir(), '.config', 'sprint-runner', 'config.yaml');
}

export function workspaceConfigPath(rootPath: string): string {
  return join(rootPath, '.sprint-runner', 'config.yaml');
}

function readYamlFile(path: string): PlainObject {
  const text = readFileSync(path, 'utf8');
  const raw: unknown = YAML.parse(text);
  if (raw === null || raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new ConfigError(`Config file ${path} must contain a YAML mapping`);
  }
  return raw;
}

function readEnvFile(path: string): Record<string, string> {
  return parseEnv(readFileSync(path, 'utf8'));
}

/**
 * Load the global layer: `config.yaml` + `.env` in the same directory.
 * Missing config file → empty layer (spec defaults apply downstream).
 */
export function loadGlobalConfig(
  configPath: string = defaultGlobalConfigPath(),
): LoadedConfig {
  const files: string[] = [];
  const warnings: string[] = [];
  let raw: PlainObject = {};
  if (existsSync(configPath)) {
    raw = readYamlFile(configPath);
    files.push(configPath);
  }
  const config = parsePartialConfig(raw, configPath);

  const secrets: Record<string, string> = {};
  const envPath = join(dirname(configPath), '.env');
  if (existsSync(envPath)) {
    Object.assign(secrets, readEnvFile(envPath));
    files.push(envPath);
  }
  return { config, warnings, secrets, files };
}

/**
 * Load the workspace layer on top of the global layer:
 * `<rootPath>/.sprint-runner/config.yaml` + sibling `.env`. Workspace
 * values override global values (deep merge); workspace secrets win.
 * (D29: the workspace root is a plain dir — there is no tickets repo.)
 */
export function loadWorkspaceConfig(
  rootPath: string,
  global: LoadedConfig = loadGlobalConfig(),
): LoadedConfig {
  const configPath = workspaceConfigPath(rootPath);
  const files = [...global.files];
  const warnings = [...global.warnings];

  let merged = global.config;
  if (existsSync(configPath)) {
    const raw = readYamlFile(configPath);
    // validate the layer alone, then validate the merged result
    const layer = parsePartialConfig(raw, configPath);
    merged = parsePartialConfig(
      deepMerge(global.config as PlainObject, layer as PlainObject),
      `${configPath} (merged over global)`,
    );
    files.push(configPath);
  }

  const secrets = { ...global.secrets };
  const envPath = join(rootPath, '.sprint-runner', '.env');
  if (existsSync(envPath)) {
    Object.assign(secrets, readEnvFile(envPath));
    files.push(envPath);
  }
  return { config: merged, warnings, secrets, files };
}

/** Ticket-frontmatter keys that map onto config paths (SETTINGS:
 *  `model:` in frontmatter overrides `main_model`). */
const FRONTMATTER_KEY_MAP: Record<string, string> = {
  model: 'main_model',
  backend: 'backend',
  depth: 'spec_depth',
};

/** Frontmatter keys that are ticket metadata, not config overrides. */
const TICKET_META_KEYS = new Set([
  'schema',
  'id',
  'title',
  'status',
  'priority',
  'repos',
  'depth',
  'backend',
  'model',
  'source',
  'parent',
  'depends_on',
  'forced',
  'blocked_reason',
]);

const TOP_LEVEL_KEYS = new Set(Object.keys(ConfigSchema.shape));

function frontmatterOverrides(frontmatter: PlainObject): PlainObject {
  const overrides: PlainObject = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    const mapped = FRONTMATTER_KEY_MAP[key];
    if (mapped) {
      if (value !== null) overrides[mapped] = value;
      continue;
    }
    if (TICKET_META_KEYS.has(key)) continue;
    // any other key is treated as a direct config path override —
    // unknown ones are rejected by parsePartialConfig (fail-closed)
    if (isPlainObject(value) || TOP_LEVEL_KEYS.has(key)) {
      overrides[key] = value;
    }
  }
  return overrides;
}

/** SETTINGS.md literal timeouts (seconds per run type). Applied as the
 *  default layer beneath user `timeouts` entries. */
export const DEFAULT_TIMEOUTS: Record<string, number> = {
  interview: 900,
  import: 600,
  probe: 600,
  triage: 900,
  split: 900,
  prd: 1800,
  design: 1800,
  testplan: 1200,
  implement: 7200,
  review: 1800,
  fix: 1800,
  doc_repair: 600,
  discuss: 600,
  escalate: 900,
  ci_fix: 1800,
  comment_fix: 1800,
  rebase: 900,
  revert: 1800,
  verify: 3600,
};

/** SETTINGS.md literal per-backend capability defaults. */
export const DEFAULT_CAPABILITIES: Record<
  string,
  { can_exec: boolean; can_write_outside_tree: boolean; has_gh: boolean }
> = {
  devin: { can_exec: true, can_write_outside_tree: true, has_gh: true },
  aider: { can_exec: true, can_write_outside_tree: false, has_gh: false },
};

export const ACTOR_HELP =
  "config.actor is required — this install's identity for machine " +
  'commits, claims, and event attribution (SETTINGS.md). Set it via ' +
  "'actor: <name>' in ~/.config/sprint-runner/config.yaml, in the " +
  "tickets-repo's .sprint-runner/config.yaml, or per ticket in " +
  'frontmatter.';

/**
 * Resolve the effective config for a run: frontmatter overrides over
 * the loaded workspace config, with SETTINGS defaults filled in.
 * Throws ConfigError on invalid values or missing `actor`.
 */
export function resolveConfig(
  ticketFrontmatter?: PlainObject | null,
  workspaceConfig?: LoadedConfig | null,
): EffectiveConfig {
  const warnings = [...(workspaceConfig?.warnings ?? [])];
  const secrets = { ...(workspaceConfig?.secrets ?? {}) };

  let merged: PlainObject = deepMerge(
    {},
    (workspaceConfig?.config ?? {}) as PlainObject,
  );
  if (ticketFrontmatter) {
    merged = deepMerge(merged, frontmatterOverrides(ticketFrontmatter));
  }

  merged.schema ??= 1; // config schema version, not a user setting
  const parsed = parsePartialConfig(merged, 'merged config');
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Invalid resolved config: ${formatZodIssues(result.error)}`,
      result.error.issues.map((i) => i.path.join('.')),
    );
  }
  const config = result.data;

  // SETTINGS-literal defaults beneath user values
  config.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  config.capabilities = deepMerge(
    DEFAULT_CAPABILITIES as PlainObject,
    config.capabilities as PlainObject,
  ) as Config['capabilities'];
  config.ui.token_file ??= join(
    homedir(),
    '.config',
    'sprint-runner',
    'ui-token',
  );
  if (config.importers.github)
    config.importers.github.token_env ??= 'GITHUB_TOKEN';
  else config.importers.github = { token_env: 'GITHUB_TOKEN' };
  if (config.importers.jira) config.importers.jira.token_env ??= 'JIRA_TOKEN';

  if (
    config.actor === null ||
    config.actor === undefined ||
    config.actor === ''
  ) {
    throw new ConfigError(ACTOR_HELP, ['actor']);
  }

  if (config.ui.remote_access) {
    warnings.push(
      'ui.remote_access is true — the UI will bind beyond loopback. ' +
        'Token is still required on every request; prefer a tunnel for ' +
        'remote use (SETTINGS.md).',
    );
  }

  return { ...config, warnings, secrets };
}
