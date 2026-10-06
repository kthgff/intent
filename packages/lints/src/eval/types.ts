/**
 * AI Evaluation Lab — shared types (PRD §15.12, wp-156).
 *
 * The lab is deliberately offline: a {@link EvalExecutor} is the seam
 * where a real model call would happen, so golden sets run against a
 * mock or a recorded fixture with no network. Everything else — run
 * rows, scoring, the promotion gate — is pure and deterministic.
 */
import type { EvalRunRow, RouteDecision, TestResult } from '@veto/core';

/** A value that may or may not be wrapped in a promise. */
export type Awaitable<T> = T | Promise<T>;

/**
 * One golden case. `expected` is the golden output; `recorded` (when
 * present) is the recorded model output for the offline runner — the
 * two are compared by the family scorer.
 */
export interface GoldenCase {
  case_id: string;
  /** The task input the candidate model sees. */
  input: Record<string, unknown>;
  /** The golden/expected output the candidate is scored against. */
  expected: Record<string, unknown>;
  /** Optional eval slices — e.g. `negation` | `qualifier` (§15.9). */
  tags?: string[];
  /** Recorded candidate output (offline fixtures); absent = derive. */
  recorded?: unknown;
}

/** A named corpus of golden cases for one task family. */
export interface GoldenSet {
  family: string;
  cases: GoldenCase[];
}

/** What an executor produces for one case — compared against `expected`. */
export interface EvalCandidate {
  /** The candidate output the scorer inspects. */
  output: unknown;
  /** Free-form provenance, recorded on the result row's `detail`. */
  detail?: string;
  /** The case could not be executed (→ verdict `skip`). */
  skipped?: boolean;
}

/**
 * Pluggable case runner. Production binds a model + prompt version and
 * calls the provider; tests and offline corpus runs use a recorded or
 * deterministic mock.
 */
export interface EvalExecutor {
  /** Model id the executor is bound to (recorded on the run). */
  readonly model?: string | null;
  execute(route: RouteDecision, golden: GoldenCase): Awaitable<EvalCandidate>;
}

/** The per-case score produced by a family scorer. */
export interface CaseScore {
  verdict: TestResult;
  /** Normalized 0..1 score (1 = perfect). */
  score: number;
  /** Named sub-scores (match, precision, recall, negation_preserved…). */
  scores: Record<string, number>;
  detail?: string;
}

/** Aggregated metrics over one eval run. */
export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** passed / (passed + failed); `0` when nothing was scored. */
  pass_rate: number;
  /** Mean case score over scored cases (skips excluded). */
  score: number;
}

/** Convenience alias for the run row the engine produces. */
export type EvalRun = EvalRunRow;
