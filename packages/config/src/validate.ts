/**
 * Validation helpers — fail-closed per AGENTS.md: unknown keys and
 * malformed values are errors, never silently dropped.
 */
import { ConfigSchema } from '@sprint-runner/core';
import type { z } from 'zod';
import { type PlainObject, isPlainObject } from './merge.js';

/** Raised for any config-layer problem (parse, unknown key, missing
 *  actor). Messages must never include secret values. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

/** Per-layer schema: every field optional (deep), but anything present
 *  must be well-typed. Final resolution uses full `ConfigSchema`. */
export const PartialConfigSchema = ConfigSchema.deepPartial();
export type PartialConfig = z.infer<typeof PartialConfigSchema>;

const TOP_LEVEL_KEYS = Object.keys(ConfigSchema.shape);

/** Fixed-shape sub-objects: path → allowed child keys. `*` = a record
 *  entry name; `[]` = array items. */
const FIXED_KEYS: Record<string, readonly string[]> = {
  '': TOP_LEVEL_KEYS,
  concurrency: ['implement'],
  shepherd: ['poll_interval_s'],
  survey: ['refresh', 'timeout', 'budget_usd', 'sources'],
  budgets: [
    'spend_cap_usd_per_ticket',
    'tokens_cap_per_ticket',
    'shepherd_max_cycles',
    'fix_dismissal_cap',
    'split_max_children',
  ],
  semantic: ['embeddings', 'embedding_model', 'entity_linking', 'dedupe'],
  importers: ['github', 'jira', 'default_repo_map'],
  'importers.github': ['token_env'],
  'importers.jira': ['base_url', 'token_env'],
  security: ['scanner', 'scan_on_commit'],
  ui: ['bind', 'port', 'token_file', 'remote_access'],
  notifications: ['desktop', 'badge'],
  review: ['auto_fix_severities', 'auto_fix_rounds'],
  'capabilities.*': ['can_exec', 'can_write_outside_tree', 'has_gh'],
  'repos.*': ['path', 'card'],
  'repos.*.card': [
    'test',
    'lint',
    'build',
    'forbidden_paths',
    'probed_at',
    'verified',
  ],
  'products.*': ['repos', 'docs', 'screenshots', 'app_url', 'context_file'],
};

/** Paths whose children are named record entries with fixed shapes. */
const RECORD_PATHS = new Set(['capabilities', 'repos', 'products']);
/** Paths whose children are named scalars — any key allowed. */
const LEAF_RECORD_PATHS = new Set(['timeouts', 'importers.default_repo_map']);

function walkValue(value: unknown, path: string, unknown: string[]): void {
  if (Array.isArray(value)) {
    const itemKeys = FIXED_KEYS[`${path}[]`];
    if (itemKeys) {
      for (const item of value) {
        if (isPlainObject(item)) walkObject(item, `${path}[]`, unknown);
      }
    }
    return;
  }
  if (!isPlainObject(value)) return;
  if (RECORD_PATHS.has(path)) {
    for (const child of Object.values(value)) {
      if (isPlainObject(child)) walkObject(child, `${path}.*`, unknown);
    }
    return;
  }
  if (LEAF_RECORD_PATHS.has(path)) return;
  walkObject(value, path, unknown);
}

function walkObject(obj: PlainObject, path: string, unknown: string[]): void {
  const allowed = FIXED_KEYS[path];
  if (!allowed) return;
  for (const [key, value] of Object.entries(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!allowed.includes(key)) {
      unknown.push(childPath);
      continue;
    }
    walkValue(value, childPath, unknown);
  }
}

/** All valid dotted config paths, for error messages. */
export function validConfigPaths(): string[] {
  const paths: string[] = [];
  for (const [path, keys] of Object.entries(FIXED_KEYS)) {
    for (const key of keys) {
      paths.push(path ? `${path}.${key}` : key);
    }
  }
  return paths.sort();
}

/** Fail-closed: throw if the raw config object contains unknown keys. */
export function assertNoUnknownKeys(raw: unknown, source: string): void {
  if (!isPlainObject(raw)) return;
  const unknown: string[] = [];
  walkObject(raw, '', unknown);
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown config key(s) in ${source}: ${unknown.join(', ')}. ` +
        `Valid keys: ${validConfigPaths().join(', ')}`,
      unknown,
    );
  }
}

/** Parse a raw YAML object as a partial config layer. */
export function parsePartialConfig(
  raw: unknown,
  source: string,
): PartialConfig {
  assertNoUnknownKeys(raw, source);
  const result = PartialConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(
      `Invalid config in ${source}: ${formatZodIssues(result.error)}`,
      result.error.issues.map((i) => i.path.join('.')),
    );
  }
  return result.data;
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
