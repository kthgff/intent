/**
 * AI Evaluation Lab — promotion gate (PRD §15.12, wp-156).
 *
 * A registry change (new model, prompt version, provider) may ship
 * only after passing the eval threshold for its task family. The gate
 * is fail-closed: a missing/incomplete run, a run for the wrong family
 * or model, or a pass-rate below the effective threshold all block the
 * candidate. Security/requirements families carry a raised floor
 * ({@link effectiveEvalThreshold}).
 *
 * `needsRegressionRerun` is the complementary trigger: a model, prompt,
 * provider, or policy change forces a re-run even when the last run
 * passed — the passing evidence is for the *previous* candidate.
 */
import type { EvalRunRow, ModelRoute } from '@sprint-runner/core';
import { effectiveEvalThreshold } from '@sprint-runner/config';
import { passRateOf } from './engine.js';
import type { EvalSummary } from './types.js';

/** Inputs to a promotion-gate evaluation. */
export interface PromotionGateInput {
  family: string;
  /** Candidate route (its `eval_threshold` is the route-side floor). */
  route: { model?: string | null; eval_threshold?: number | null };
  /** The eval run offered as evidence (may be null/undefined). */
  run?: EvalRunRow | null;
  /** Expected candidate prompt/policy versions (checked when provided). */
  promptVersion?: string | null;
  policyVersion?: string | null;
  /** Optional pre-computed summary (avoids re-deriving from metrics). */
  summary?: EvalSummary | null;
}

/** A promotion decision — `allowed` false means the candidate is blocked. */
export interface PromotionDecision {
  allowed: boolean;
  family: string;
  model: string | null;
  pass_rate: number;
  threshold: number;
  reasons: string[];
}

function blocked(
  input: PromotionGateInput,
  threshold: number,
  pass_rate: number,
  reasons: string[],
): PromotionDecision {
  return {
    allowed: false,
    family: input.family,
    model: input.route.model ?? null,
    pass_rate,
    threshold,
    reasons,
  };
}

/**
 * Evaluate whether the candidate may be promoted. Fails closed on any
 * missing/mismatched evidence or a pass-rate below the effective
 * threshold.
 */
export function evaluatePromotionGate(
  input: PromotionGateInput,
): PromotionDecision {
  const threshold = effectiveEvalThreshold(
    input.family,
    input.route.eval_threshold,
  );
  const pass_rate = passRateOf(input.run, input.summary) ?? 0;
  const run = input.run;

  if (!run) {
    return blocked(input, threshold, pass_rate, [
      `no eval run recorded for family '${input.family}'`,
    ]);
  }

  const reasons: string[] = [];
  if (run.status !== 'completed') {
    reasons.push(`eval run ${run.eval_run_id} is '${run.status}', not completed`);
  }
  if (run.family !== input.family) {
    reasons.push(
      `eval run family '${run.family}' ≠ candidate family '${input.family}'`,
    );
  }
  const candidateModel = input.route.model ?? null;
  if ((run.model ?? null) !== candidateModel) {
    reasons.push(
      `eval run model '${run.model ?? '(default)'}' ≠ candidate ` +
        `'${candidateModel ?? '(default)'}'`,
    );
  }
  if (input.promptVersion != null && run.prompt_version !== input.promptVersion) {
    reasons.push(
      `eval run prompt_version '${run.prompt_version ?? '(none)'}' ≠ ` +
        `candidate '${input.promptVersion}'`,
    );
  }
  if (input.policyVersion != null && run.policy_version !== input.policyVersion) {
    reasons.push(
      `eval run policy_version '${run.policy_version ?? '(none)'}' ≠ ` +
        `candidate '${input.policyVersion}'`,
    );
  }
  if (pass_rate < threshold) {
    reasons.push(
      `pass_rate ${pass_rate.toFixed(3)} < threshold ${threshold.toFixed(3)}`,
    );
  }

  return {
    allowed: reasons.length === 0,
    family: input.family,
    model: candidateModel,
    pass_rate,
    threshold,
    reasons,
  };
}

/** A registry revision identity used for the rerun comparison. */
export interface RouteRevision {
  primary?: string | null;
  fallback?: string[] | null;
  providers?: string[] | null;
  prompt_version?: string | null;
  policy_version?: string | null;
}

/** Whether a change forces a fresh eval run. */
export interface RerunDecision {
  rerun: boolean;
  reasons: string[];
}

function sameList(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

/**
 * Regression rerun trigger: a model / provider / prompt / policy change
 * invalidates prior passing evidence, so the candidate must be re-run
 * before it can be promoted (PRD §15.12 "regression rerun triggers on
 * model/prompt/provider change").
 */
export function needsRegressionRerun(
  previous: RouteRevision | null | undefined,
  next: RouteRevision,
): RerunDecision {
  if (!previous) {
    return { rerun: true, reasons: ['no previous revision — first promotion'] };
  }
  const reasons: string[] = [];
  if ((previous.primary ?? null) !== (next.primary ?? null)) {
    reasons.push('model-changed');
  }
  if (!sameList(previous.fallback, next.fallback)) {
    reasons.push('fallback-changed');
  }
  if (!sameList(previous.providers, next.providers)) {
    reasons.push('provider-changed');
  }
  if (
    (previous.prompt_version ?? null) !== (next.prompt_version ?? null)
  ) {
    reasons.push('prompt-version-changed');
  }
  if (
    (previous.policy_version ?? null) !== (next.policy_version ?? null)
  ) {
    reasons.push('policy-version-changed');
  }
  return { rerun: reasons.length > 0, reasons };
}

/** Inputs to a whole registry-change decision. */
export interface RegistryChangeInput {
  /** Registry key being changed (`models.<kind>`). */
  kind: string;
  family: string;
  /** The entry before the change (absent = first promotion). */
  previous?: ModelRoute | null;
  /** The proposed entry. */
  proposed: ModelRoute;
  /** The resolved proposed route (SCHEMAS §21). */
  route: { model?: string | null; eval_threshold?: number | null };
  run?: EvalRunRow | null;
  promptVersion?: string | null;
  policyVersion?: string | null;
  summary?: EvalSummary | null;
}

/** A registry decision = promotion verdict + rerun trigger. */
export interface RegistryGateDecision extends PromotionDecision {
  kind: string;
  rerun_required: boolean;
  rerun_reasons: string[];
}

function revisionOf(route: ModelRoute | null | undefined): RouteRevision | null {
  if (!route) return null;
  return {
    primary: route.primary ?? null,
    fallback: route.fallback ?? [],
    providers: route.providers ?? [],
  };
}

/**
 * Decide whether a proposed `models.<kind>` change may land: it must
 * (a) pass the family's promotion gate and (b) not silently reuse
 * evidence from a different candidate (rerun required on change).
 */
export function evaluateRegistryChange(
  input: RegistryChangeInput,
): RegistryGateDecision {
  const decision = evaluatePromotionGate({
    family: input.family,
    route: input.route,
    ...(input.run !== undefined ? { run: input.run } : {}),
    ...(input.promptVersion !== undefined
      ? { promptVersion: input.promptVersion }
      : {}),
    ...(input.policyVersion !== undefined
      ? { policyVersion: input.policyVersion }
      : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  });
  const rerun = needsRegressionRerun(
    revisionOf(input.previous),
    revisionOf(input.proposed) ?? {},
  );
  return {
    ...decision,
    kind: input.kind,
    rerun_required: rerun.rerun,
    rerun_reasons: rerun.reasons,
  };
}
