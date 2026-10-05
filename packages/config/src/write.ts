/**
 * write.ts — the config package's YAML write path (wp-160).
 *
 * `loadGlobalConfig`/`loadWorkspaceConfig` read layers; this module is
 * the matching durable write. Callers (PUT /settings, CLI init) merge a
 * validated patch into an existing `config.yaml` while keeping comments
 * and key order — the document is parsed with `YAML.parseDocument` and
 * mutated via `doc.setIn`, never re-stringified from a plain object.
 *
 * Scope note (D29): projects/workspaces are NOT a config.yaml concern —
 * they persist as DB `projects` rows (SETTINGS.md). This helper exists
 * for the genuine config layers (global + workspace config.yaml).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';
import type { PlainObject } from './merge.js';
import { isPlainObject } from './merge.js';
import { ConfigError, parsePartialConfig } from './validate.js';

/**
 * Recursively set `patch` keys into a YAML Document's root map —
 * objects merge key-by-key, scalars/arrays replace. Unknown top-level
 * or nested keys are rejected by the caller's parsePartialConfig pass,
 * never here (setIn itself is schema-blind).
 */
function setDeep(
  doc: YAML.Document,
  path: (string | number)[],
  value: unknown,
) {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      setDeep(doc, [...path, k], v);
    }
    return;
  }
  doc.setIn(path, value);
}

/**
 * Merge `patch` into the YAML config file at `configPath`, creating the
 * file (and parent dir) when absent. The merged document is validated
 * with `parsePartialConfig` BEFORE writing — fail-closed, a bad patch
 * leaves the file untouched. Comments in the existing file survive;
 * a missing file starts from an empty mapping.
 *
 * Returns the merged plain-object config (the same shape
 * `loadGlobalConfig` would read back).
 */
export function mergeConfigFile(
  configPath: string,
  patch: PlainObject,
): PlainObject {
  let doc: YAML.Document;
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8');
    doc = YAML.parseDocument(text);
    const contents = doc.contents;
    if (
      contents !== null &&
      !(YAML.isMap(contents) || isPlainObject(doc.toJS()))
    ) {
      throw new ConfigError(
        `Config file ${configPath} must contain a YAML mapping`,
      );
    }
  } else {
    doc = new YAML.Document({});
  }
  for (const [k, v] of Object.entries(patch)) {
    setDeep(doc, [k], v);
  }
  const merged = (doc.toJS() ?? {}) as PlainObject;
  // Fail-closed: validate the merged document before it hits disk.
  parsePartialConfig(merged, configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, doc.toString(), 'utf8');
  return merged;
}
