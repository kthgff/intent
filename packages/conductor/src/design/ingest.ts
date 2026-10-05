/**
 * design/ingest.ts — design-system ingestion (PRD §15.4, wp-149).
 *
 * The `design-ingest` stage mines the app's UI library into a
 * `design-system.json` bundle (component inventory + tokens) that the
 * mockup generator consumes so generated screens look native, not
 * generic-AI. This module owns parse/merge so the bundle is always a
 * valid artifact and incremental refreshes are deterministic.
 */
import { type DesignSystem, DesignSystemSchema } from '@sprint-runner/core';
import { badRequest, invalid, stableJson } from './types.js';

/** Parse + validate a design-system.json bundle. Fail-closed. */
export function parseDesignSystem(content: string): DesignSystem {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw badRequest(
      `design-system.json: invalid JSON — ${(e as Error).message}`,
    );
  }
  const parsed = DesignSystemSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(
      `design-system.json: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export interface DesignSystemMerge {
  merged: DesignSystem;
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * Merge an incremental ingest into an existing bundle: components are
 * keyed by `name` (added/updated), tokens are shallow-merged per group
 * (incoming wins), and components the repo no longer has are dropped.
 * Deterministic (sorted component list).
 */
export function mergeDesignSystems(
  existing: DesignSystem | null,
  incoming: DesignSystem,
): DesignSystemMerge {
  const before = new Map((existing?.components ?? []).map((c) => [c.name, c]));
  const after = new Map(incoming.components.map((c) => [c.name, c]));
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const name of after.keys()) {
    if (!before.has(name)) added.push(name);
  }
  for (const [name, c] of before) {
    const next = after.get(name);
    if (!next) removed.push(name);
    else if (stableJson(c) !== stableJson(next)) updated.push(name);
  }
  const tokens: Record<string, unknown> = { ...(existing?.tokens ?? {}) };
  for (const [group, value] of Object.entries(incoming.tokens)) {
    const prior = tokens[group];
    tokens[group] =
      prior &&
      typeof prior === 'object' &&
      !Array.isArray(prior) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
        ? {
            ...(prior as Record<string, unknown>),
            ...(value as Record<string, unknown>),
          }
        : value;
  }
  const merged: DesignSystem = {
    ...incoming,
    tokens,
    components: [...after.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
  return {
    merged,
    added: added.sort(),
    updated: updated.sort(),
    removed: removed.sort(),
  };
}

/** Compact design-system context handed to the mockup generator prompt
 *  (`{{DESIGN_SYSTEM_JSON}}`). */
export function designSystemContext(
  bundle: DesignSystem | null,
  opts: { maxComponents?: number } = {},
): string {
  if (!bundle) return '';
  const max = opts.maxComponents ?? 40;
  const components = bundle.components.slice(0, max).map((c) => ({
    name: c.name,
    import: c.import,
    props: Object.keys(c.props),
    variants: c.variants,
  }));
  return JSON.stringify(
    {
      source: bundle.source,
      styling: bundle.styling ?? null,
      tokens: bundle.tokens,
      components,
    },
    null,
    2,
  );
}
