/**
 * Model routing registry (PRD §15.12, SCHEMAS §21 — wp-155).
 *
 * Every AI interaction resolves a {@link RouteDecision} through here —
 * no stage or adapter hardcodes a model id. Registry keys ("kinds")
 * are free-form: pipeline launches resolve kind = stage name
 * (`implement`, `review`, `triage`…); non-stage consumers name their
 * own kinds (sticky-note tagging, extraction, multimodal…).
 *
 * Reserved keys:
 *   `default`    — base layer every kind inherits field-wise.
 *   `escalation` — the retry ladder's step-up tier; resolved ONLY by
 *                  {@link escalationModelFor} — it never inherits
 *                  `default`/`main_model` (an unset escalation tier
 *                  means "the backend's own step-up", not the same
 *                  model again).
 *
 * Precedence for the pinned model (highest wins):
 *   runs.request.model  (per-run pin — retry escalations, API callers)
 *   > ticket row model  (per-ticket pin, SETTINGS precedence rules)
 *   > models.<kind>.primary
 *   > models.default.primary
 *   > legacy per-kind knob (review → review_model; escalation →
 *     escalation_model — kept working for pre-registry configs)
 *   > main_model
 *   > null → the backend's own default
 *
 * Latency classes (SCHEMAS §21): `instant` = no LLM on path (runner
 * tasks), `interactive` = streamed ~1s TTFT conversational path,
 * `background` = quality-adjusted cost. The class rides the
 * RouteDecision into PrepareContext so adapters can shape streaming
 * and enforce `providers` allowlists; per-run pinning lands on
 * `runs.model` + `runs.request.route`.
 */
import type {
  LatencyClass,
  ModelRouteEntry,
  RouteDecision,
} from '@sprint-runner/core';

/** The base-layer registry key every kind inherits. */
export const ROUTE_KIND_DEFAULT = 'default';
/** The retry-ladder step-up registry key (escalationModelFor). */
export const ROUTE_KIND_ESCALATION = 'escalation';

/** The minimal config slice the router reads — `EffectiveConfig`
 *  satisfies it structurally; tests pass partial literals. */
export interface RouteConfig {
  models?: Record<string, ModelRouteEntry | undefined>;
  main_model?: string | null | undefined;
  review_model?: string | null | undefined;
  escalation_model?: string | null | undefined;
}

/** Raised when a resolved route can't be honored — fail-closed
 *  (AGENTS.md): a provider allowlist miss stops the launch rather
 *  than silently falling back to an unlisted provider. */
export class RouteError extends Error {
  readonly kind?: string;
  constructor(message: string, opts: { kind?: string } = {}) {
    super(message);
    this.name = 'RouteError';
    if (opts.kind !== undefined) this.kind = opts.kind;
  }
}

/** Latency-class + shape defaults by kind — `verify`/`import` run as
 *  conductor-side tasks with no LLM (`instant`); `interview`/`discuss`
 *  are the streamed conversational paths (`interactive`); everything
 *  else is `background`. */
const KIND_LATENCY_DEFAULT: Record<string, LatencyClass> = {
  verify: 'instant',
  import: 'instant',
  interview: 'interactive',
  discuss: 'interactive',
};

/** Legacy per-kind settings that predate the registry — kept live so
 *  an install with only `review_model:`/`escalation_model:` configured
 *  routes identically to before (SETTINGS backport, wp-155). */
const LEGACY_KIND_KEYS = {
  review: 'review_model',
  escalation: 'escalation_model',
} as const satisfies Record<string, keyof RouteConfig>;

/**
 * Resolve `kind` through the registry → a complete RouteDecision.
 * `model`/`primary` here is the REGISTRY pick (no request/ticket pins
 * folded in — {@link resolveRunRoute} layers those on top).
 */
export function resolveModelRoute(
  config: RouteConfig,
  kind: string,
): RouteDecision {
  const models = config.models ?? {};
  const isDefault = kind === ROUTE_KIND_DEFAULT;
  const entry = isDefault ? models[ROUTE_KIND_DEFAULT] : models[kind];
  const dflt = isDefault ? undefined : models[ROUTE_KIND_DEFAULT];

  const legacyKey = (
    LEGACY_KIND_KEYS as Record<string, keyof RouteConfig | undefined>
  )[kind];
  const legacyModel = legacyKey
    ? ((config[legacyKey] as string | null | undefined) ?? null)
    : null;

  const primary =
    entry?.primary ?? dflt?.primary ?? legacyModel ?? config.main_model ?? null;
  const source: RouteDecision['source'] =
    entry?.primary !== undefined
      ? 'registry'
      : dflt?.primary !== undefined
        ? 'default'
        : legacyModel !== null || config.main_model != null
          ? 'legacy'
          : 'backend';

  const firstNonEmpty = (
    ...lists: (readonly string[] | undefined)[]
  ): string[] => {
    for (const l of lists) if (l !== undefined && l.length > 0) return [...l];
    return [];
  };

  return {
    kind,
    model: primary,
    primary,
    fallback: firstNonEmpty(entry?.fallback, dflt?.fallback),
    max_output_tokens:
      entry?.max_output_tokens ?? dflt?.max_output_tokens ?? null,
    schema_required: entry?.schema_required ?? dflt?.schema_required ?? false,
    providers: firstNonEmpty(entry?.providers, dflt?.providers),
    eval_threshold: entry?.eval_threshold ?? dflt?.eval_threshold ?? null,
    latency_class:
      entry?.latency_class ??
      dflt?.latency_class ??
      KIND_LATENCY_DEFAULT[kind] ??
      'background',
    source,
  };
}

/**
 * Resolve the model pinned for one RUN — registry route folded with
 * the per-request pin (`runs.request.model`, e.g. an escalation retry)
 * and the per-ticket pin (`tickets.model`). Persist the result on
 * `runs.request.route` so a queued row's launch resolves identically.
 */
export function resolveRunRoute(opts: {
  config: RouteConfig;
  /** Registry kind — stage name for pipeline launches. */
  kind: string;
  /** `runs.request.model` — explicit per-request pin (escalation). */
  requestModel?: string | null;
  /** `tickets.model` — per-ticket pin (frontmatter `model:`). */
  ticketModel?: string | null;
}): RouteDecision {
  const route = resolveModelRoute(opts.config, opts.kind);
  if (opts.requestModel) {
    return { ...route, model: opts.requestModel, source: 'request' };
  }
  if (opts.ticketModel) {
    return { ...route, model: opts.ticketModel, source: 'ticket' };
  }
  return route;
}

/**
 * The retry ladder's step-up tier (CONDUCTOR "implement failure → 1
 * stronger-model retry"; SETTINGS `escalation_model`). Deliberately
 * does NOT inherit `models.default`/`main_model` — an unset escalation
 * tier is `null` = the backend's own step-up, never an accidental
 * same-tier retry dressed as escalation.
 */
export function escalationModelFor(config: RouteConfig): string | null {
  return (
    config.models?.[ROUTE_KIND_ESCALATION]?.primary ??
    config.escalation_model ??
    null
  );
}

/**
 * Ordered candidate chain for a route: pinned/primary first, then the
 * configured fallbacks (provider-level failover order). Consumers that
 * can pick among several endpoints iterate this list; the conductor's
 * single-spawn path uses index 0.
 */
export function routeChain(route: RouteDecision): string[] {
  return [...(route.model ? [route.model] : []), ...route.fallback];
}

/**
 * Provider allowlist check — fail-closed (AGENTS.md). A route whose
 * `providers` list is non-empty may only be served by one of those
 * providers; a backend bound to a different provider errors at
 * prepare() rather than silently serving an unlisted provider.
 */
export function assertRouteProvider(
  route: RouteDecision | undefined,
  provider: string,
): void {
  if (!route || route.providers.length === 0) return;
  if (route.providers.includes(provider)) return;
  throw new RouteError(
    `route '${route.kind}' allowlists providers ` +
      `[${route.providers.join(', ')}] — backend bound to ` +
      `'${provider}' cannot serve it (SCHEMAS §21 providers allowlist)`,
    { kind: route.kind },
  );
}

/** True for the streamed conversational path (`interactive` class —
 *  ~1s TTFT, never JSON-only). */
export function isInteractiveRoute(route: RouteDecision): boolean {
  return route.latency_class === 'interactive';
}
