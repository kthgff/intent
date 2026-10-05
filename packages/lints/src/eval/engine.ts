/**
 * AI Evaluation Lab — run engine (PRD §15.12, wp-156).
 *
 * A run is: resolve the configured route → execute every golden case
 * through an executor bound to that route → score against the golden
 * `expected` → aggregate. Results are append-only (`eval_results`); a
 * re-run is always a new `eval_run` (SCHEMAS §21, migration 0002).
 *
 * The engine is pure/persistence-free: it returns rows for the caller
 * (or {@link persistEvalOutcome}) to write through `Store`.
 */
import { randomUUID } from 'node:crypto';
import type {
  EvalResultRow,
  EvalRunRow,
  EvalRunStatus,
  RouteDecision,
  Store,
  TestResult,
} from '@sprint-runner/core';
import { goldenSetToCases } from './golden.js';
import { scoreCase } from './scoring.js';
import type {
  Awaitable,
  CaseScore,
  EvalExecutor,
  EvalSummary,
  GoldenCase,
  GoldenSet,
} from './types.js';

/** The subset of `Store` the lab writes through. */
export type EvalStore = Pick<
  Store,
  'upsertEvalRun' | 'upsertEvalCase' | 'appendEvalResult'
>;

/** Options for {@link runEval} / {@link createEvalRun}. */
export interface EvalRunOptions {
  workspace: string;
  org?: string | null;
  family: string;
  /** The configured route the candidate executes under (SCHEMAS §21). */
  route: RouteDecision;
  golden: GoldenSet;
  executor: EvalExecutor;
  promptVersion?: string | null;
  policyVersion?: string | null;
  createdBy?: string | null;
  /** Explicit run id (tests); otherwise derived. */
  evalRunId?: string;
  /** Clock injection (tests); defaults to `Date.now` ISO. */
  now?: () => string;
}

/** The outcome of one eval run. */
export interface EvalRunOutcome {
  run: EvalRunRow;
  results: EvalResultRow[];
  summary: EvalSummary;
}

function isoNow(): string {
  return new Date().toISOString();
}

function modelSlug(model: string | null | undefined): string {
  return (model ?? 'default')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Derive a readable, unique eval-run id. */
export function deriveEvalRunId(
  family: string,
  model: string | null | undefined,
): string {
  const slug = modelSlug(model);
  const suffix = randomUUID().slice(0, 8);
  return `er-${family}-${slug}-${suffix}`;
}

/** Build the `running` row for a new eval run (no execution yet). */
export function createEvalRun(opts: EvalRunOptions): EvalRunRow {
  const now = opts.now ?? isoNow;
  const model = opts.route.model ?? opts.executor.model ?? null;
  return {
    workspace: opts.workspace,
    org: opts.org ?? null,
    eval_run_id: opts.evalRunId ?? deriveEvalRunId(opts.family, model),
    family: opts.family,
    model,
    prompt_version: opts.promptVersion ?? null,
    policy_version: opts.policyVersion ?? null,
    status: 'running',
    metrics: null,
    created_by: opts.createdBy ?? null,
    created_at: now(),
    completed_at: null,
  };
}

/** Aggregate per-case results into run metrics. */
export function summarizeResults(results: EvalResultRow[]): EvalSummary {
  const total = results.length;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let scoreSum = 0;
  for (const r of results) {
    if (r.verdict === 'pass') passed++;
    else if (r.verdict === 'fail') failed++;
    else skipped++;
    const s = r.scores?.score;
    if (typeof s === 'number') scoreSum += s;
  }
  const scored = passed + failed;
  return {
    total,
    passed,
    failed,
    skipped,
    pass_rate: scored === 0 ? 0 : passed / scored,
    score: scored === 0 ? 0 : scoreSum / scored,
  };
}

/** Summary → the `metrics` JSON stored on the run row. */
export function summaryToMetrics(
  summary: EvalSummary,
): Record<string, unknown> {
  return {
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    pass_rate: summary.pass_rate,
    score: summary.score,
  };
}

/** Read a run's `pass_rate` from its stored metrics (or a summary). */
export function passRateOf(
  run: EvalRunRow | null | undefined,
  summary?: EvalSummary | null,
): number | null {
  if (summary) return summary.pass_rate;
  const value = run?.metrics?.pass_rate;
  return typeof value === 'number' ? value : null;
}

/** Execute + score a single golden case under the configured route. */
export async function executeCase(
  route: RouteDecision,
  executor: EvalExecutor,
  family: string,
  golden: GoldenCase,
): Promise<CaseScore> {
  let candidate: Awaited<ReturnType<EvalExecutor['execute']>>;
  try {
    candidate = await executor.execute(route, golden);
  } catch (err) {
    return {
      verdict: 'skip',
      score: 0,
      scores: { score: 0 },
      detail: `executor-error: ${(err as Error).message}`,
    };
  }
  if (candidate.skipped) {
    return {
      verdict: 'skip',
      score: 0,
      scores: { score: 0 },
      detail: candidate.detail ?? 'skipped',
    };
  }
  const scored = scoreCase(family, golden, candidate.output);
  const scores = { ...scored.scores, score: scored.score };
  const detail = [scored.detail, candidate.detail].filter(Boolean).join('; ');
  return detail ? { ...scored, scores, detail } : { ...scored, scores };
}

/**
 * Run one golden set through the executor and produce the run + result
 * rows. A run with nothing scoreable (all skipped) is `failed`;
 * otherwise `completed`.
 */
export async function runEval(opts: EvalRunOptions): Promise<EvalRunOutcome> {
  const now = opts.now ?? isoNow;
  const run = createEvalRun(opts);
  const results: EvalResultRow[] = [];
  for (const golden of opts.golden.cases) {
    const scored = await executeCase(
      opts.route,
      opts.executor,
      opts.family,
      golden,
    );
    results.push({
      workspace: opts.workspace,
      org: opts.org ?? null,
      eval_run_id: run.eval_run_id,
      family: opts.family,
      case_id: golden.case_id,
      verdict: scored.verdict,
      scores: scored.scores,
      detail: scored.detail ?? null,
      created_at: now(),
    });
  }
  const summary = summarizeResults(results);
  const status: EvalRunStatus =
    summary.total === 0 || summary.skipped === summary.total
      ? 'failed'
      : 'completed';
  run.status = status;
  run.metrics = summaryToMetrics(summary);
  run.completed_at = now();
  return { run, results, summary };
}

/**
 * Write a run's golden cases + run row + per-case results through a
 * `Store`. Cases are upserted (the corpus stays curatable); the run row
 * and results are the run of record.
 */
export async function persistEvalOutcome(
  store: EvalStore,
  opts: {
    workspace: string;
    org?: string | null;
    golden: GoldenSet;
    outcome: EvalRunOutcome;
  },
): Promise<void> {
  for (const row of goldenSetToCases(opts.golden, opts.workspace, opts.org)) {
    await store.upsertEvalCase(row);
  }
  await store.upsertEvalRun(opts.outcome.run);
  for (const row of opts.outcome.results) {
    await store.appendEvalResult(row);
  }
}

/** Count of cases by verdict — a small helper for reports/tests. */
export function verdictCounts(
  results: EvalResultRow[],
): Record<TestResult, number> {
  const counts: Record<TestResult, number> = { pass: 0, fail: 0, skip: 0 };
  for (const r of results) counts[r.verdict as TestResult]++;
  return counts;
}
