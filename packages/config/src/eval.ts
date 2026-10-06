/**
 * AI Evaluation Lab — config surface (PRD §15.12, SCHEMAS §21, wp-156).
 *
 * The lab's knobs are deliberately thin: the registry entry for a task
 * family already carries `eval_threshold` (SCHEMAS §21), so the only
 * config-layer decision is the *effective* gate threshold for a family.
 * Security/requirements families carry a raised quality floor — a false
 * pass there is expensive, so a lax per-route threshold can never lower
 * the bar below {@link STRICT_EVAL_FLOOR}.
 *
 * Pure module: no fs, no env — safe to import from the lints engine.
 */
import type { ModelRouteEntry } from '@veto/core';

/** Task families the lab scores (PRD §15.12). Storage keeps `family`
 *  free-form; these are the seeded corpus families. */
export const EVAL_FAMILIES = [
  'extraction',
  'questions',
  'rs-draft',
  'review',
  'coverage',
] as const;
export type EvalFamily = (typeof EVAL_FAMILIES)[number];

/** Gate threshold used when neither the route nor config sets one. */
export const DEFAULT_EVAL_THRESHOLD = 0.8;

/** Families where a false pass is dangerous — the quality floor is
 *  raised regardless of a laxer per-route `eval_threshold`. */
export const STRICT_EVAL_FAMILIES = ['security', 'requirements'] as const;

/** Minimum pass-rate a strict-family candidate must clear. */
export const STRICT_EVAL_FLOOR = 0.95;

/** True for the families that carry the raised quality floor. */
export function isStrictEvalFamily(family: string): boolean {
  return (STRICT_EVAL_FAMILIES as readonly string[]).includes(family);
}

/**
 * Effective promotion-gate threshold for `family`: the route's own
 * `eval_threshold` (or {@link DEFAULT_EVAL_THRESHOLD}), clamped up to
 * {@link STRICT_EVAL_FLOOR} for strict families.
 */
export function effectiveEvalThreshold(
  family: string,
  routeThreshold?: number | null,
): number {
  const base =
    typeof routeThreshold === 'number'
      ? routeThreshold
      : DEFAULT_EVAL_THRESHOLD;
  return isStrictEvalFamily(family) ? Math.max(base, STRICT_EVAL_FLOOR) : base;
}

/** The per-family thresholds declared in the `models:` registry
 *  (`models.<family>.eval_threshold`) — the config the lab reads. */
export function evalThresholdsFromRegistry(
  models?: Record<string, ModelRouteEntry | undefined> | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [kind, entry] of Object.entries(models ?? {})) {
    if (entry && typeof entry.eval_threshold === 'number') {
      out[kind] = entry.eval_threshold;
    }
  }
  return out;
}
