/**
 * wp-155 — model routing registry (PRD §15.12, SCHEMAS §21).
 * Resolution precedence, legacy-knob bridge, latency classes,
 * provider allowlist, escalation tier.
 */
import { describe, expect, it } from 'vitest';
import {
  type RouteConfig,
  RouteError,
  assertRouteProvider,
  escalationModelFor,
  isInteractiveRoute,
  resolveModelRoute,
  resolveRunRoute,
  routeChain,
} from '../src/index.js';

const cfg = (over: RouteConfig = {}): RouteConfig => over;

describe('resolveModelRoute — precedence', () => {
  it('resolves to null/backend when nothing is configured', () => {
    const r = resolveModelRoute(cfg(), 'implement');
    expect(r.model).toBeNull();
    expect(r.primary).toBeNull();
    expect(r.source).toBe('backend');
    expect(r.latency_class).toBe('background');
    expect(r.schema_required).toBe(false);
    expect(r.fallback).toEqual([]);
  });

  it('falls back to main_model when no registry entry exists', () => {
    const r = resolveModelRoute(cfg({ main_model: 'or/main' }), 'triage');
    expect(r.model).toBe('or/main');
    expect(r.source).toBe('legacy');
  });

  it('kind entry beats default entry beats legacy knob', () => {
    const c = cfg({
      main_model: 'or/main',
      models: {
        default: { primary: 'or/default' },
        implement: { primary: 'or/coder' },
      },
    });
    expect(resolveModelRoute(c, 'implement').primary).toBe('or/coder');
    expect(resolveModelRoute(c, 'triage').primary).toBe('or/default');
    expect(resolveModelRoute(c, 'triage').source).toBe('default');
  });

  it('review bridges to review_model when no registry entry exists', () => {
    const c = cfg({ main_model: 'or/main', review_model: 'or/reviewer' });
    expect(resolveModelRoute(c, 'review').model).toBe('or/reviewer');
    expect(resolveModelRoute(c, 'fix').model).toBe('or/main');
  });

  it('models.default beats the legacy kind knob', () => {
    const c = cfg({
      review_model: 'or/reviewer',
      models: { default: { primary: 'or/default' } },
    });
    expect(resolveModelRoute(c, 'review').model).toBe('or/default');
  });
});

describe('resolveModelRoute — field inheritance from default', () => {
  const c = cfg({
    models: {
      default: {
        primary: 'or/base',
        fallback: ['or/fallback-1'],
        max_output_tokens: 4096,
        providers: ['openrouter'],
        eval_threshold: 0.7,
        latency_class: 'background',
      },
      triage: { latency_class: 'interactive' },
      implement: { primary: 'or/coder', fallback: ['or/big-coder'] },
    },
  });

  it('kind entries inherit unset fields from models.default', () => {
    const r = resolveModelRoute(c, 'triage');
    expect(r.primary).toBe('or/base');
    expect(r.fallback).toEqual(['or/fallback-1']);
    expect(r.max_output_tokens).toBe(4096);
    expect(r.providers).toEqual(['openrouter']);
    expect(r.eval_threshold).toBe(0.7);
    expect(r.latency_class).toBe('interactive'); // own field wins
    expect(r.schema_required).toBe(false);
  });

  it('a kind-level list replaces the default list (no concat)', () => {
    const r = resolveModelRoute(c, 'implement');
    expect(r.fallback).toEqual(['or/big-coder']);
    expect(r.providers).toEqual(['openrouter']); // unset → inherits
  });
});

describe('latency classes', () => {
  it('kind defaults: instant runner tasks, interactive conversation', () => {
    const c = cfg();
    expect(resolveModelRoute(c, 'verify').latency_class).toBe('instant');
    expect(resolveModelRoute(c, 'import').latency_class).toBe('instant');
    expect(resolveModelRoute(c, 'interview').latency_class).toBe('interactive');
    expect(resolveModelRoute(c, 'discuss').latency_class).toBe('interactive');
    expect(resolveModelRoute(c, 'implement').latency_class).toBe('background');
  });

  it('isInteractiveRoute mirrors the resolved class', () => {
    expect(isInteractiveRoute(resolveModelRoute(cfg(), 'interview'))).toBe(
      true,
    );
    expect(isInteractiveRoute(resolveModelRoute(cfg(), 'triage'))).toBe(false);
  });
});

describe('resolveRunRoute — per-run pinning', () => {
  const c = cfg({
    main_model: 'or/main',
    models: { triage: { primary: 'or/triage' } },
  });

  it('request pin > ticket pin > registry primary', () => {
    expect(resolveRunRoute({ config: c, kind: 'triage' }).model).toBe(
      'or/triage',
    );
    expect(
      resolveRunRoute({ config: c, kind: 'triage', ticketModel: 'or/tix' })
        .model,
    ).toBe('or/tix');
    const pinned = resolveRunRoute({
      config: c,
      kind: 'triage',
      ticketModel: 'or/tix',
      requestModel: 'or/req',
    });
    expect(pinned.model).toBe('or/req');
    expect(pinned.source).toBe('request');
    // the registry pick stays visible for audit
    expect(pinned.primary).toBe('or/triage');
  });

  it('records the pin source', () => {
    expect(
      resolveRunRoute({ config: c, kind: 'triage', ticketModel: 'x' }).source,
    ).toBe('ticket');
    expect(resolveRunRoute({ config: c, kind: 'triage' }).source).toBe(
      'registry',
    );
  });
});

describe('escalation tier', () => {
  it('escalationModelFor: registry escalation > escalation_model > null', () => {
    expect(escalationModelFor(cfg())).toBeNull();
    expect(escalationModelFor(cfg({ escalation_model: 'or/esc' }))).toBe(
      'or/esc',
    );
    expect(
      escalationModelFor(
        cfg({
          escalation_model: 'or/esc',
          models: { escalation: { primary: 'or/big' } },
        }),
      ),
    ).toBe('or/big');
  });

  it('never inherits default/main — unset tier is backend step-up', () => {
    const c = cfg({
      main_model: 'or/main',
      models: { default: { primary: 'or/def' } },
    });
    expect(escalationModelFor(c)).toBeNull();
  });
});

describe('providers allowlist + chain', () => {
  it('empty providers = unconstrained', () => {
    expect(() =>
      assertRouteProvider(resolveModelRoute(cfg(), 'triage'), 'openrouter'),
    ).not.toThrow();
  });

  it('non-empty allowlist rejects a non-member provider', () => {
    const route = resolveModelRoute(
      cfg({ models: { triage: { providers: ['anthropic'] } } }),
      'triage',
    );
    expect(() => assertRouteProvider(route, 'openrouter')).toThrow(RouteError);
    expect(() => assertRouteProvider(route, 'anthropic')).not.toThrow();
  });

  it('routeChain orders pinned model first, then fallbacks', () => {
    const r = resolveRunRoute({
      config: cfg({ models: { triage: { fallback: ['b', 'c'] } } }),
      kind: 'triage',
      requestModel: 'a',
    });
    expect(routeChain(r)).toEqual(['a', 'b', 'c']);
    expect(routeChain(resolveModelRoute(cfg(), 'triage'))).toEqual([]);
  });
});
