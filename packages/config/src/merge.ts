/**
 * Deep-merge for config layers — SETTINGS.md precedence.
 * Later (higher-precedence) layers win. Objects merge recursively;
 * arrays and scalars replace wholesale. `undefined` never overrides;
 * explicit `null` does (it is a meaningful "unset" in SETTINGS).
 */

export type PlainObject = Record<string, unknown>;

export function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge(
  base: PlainObject,
  override: PlainObject,
): PlainObject {
  const out: PlainObject = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}
