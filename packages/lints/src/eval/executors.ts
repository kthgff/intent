/**
 * AI Evaluation Lab — offline executors (PRD §15.12, wp-156).
 *
 * The lab must run golden sets offline (acceptance criterion). These
 * executors are the offline stand-ins for a live model call: a recorded
 * fixture replay, a fixed output map, and a wrapper that lets a test
 * simulate a regressed candidate without touching the corpus.
 */
import type { EvalCandidate, EvalExecutor, GoldenCase } from './types.js';

/** Replay the `recorded` output carried on each golden case. Cases
 *  without a recording are skipped rather than guessed (fail-closed). */
export function recordedExecutor(model?: string | null): EvalExecutor {
  return {
    model: model ?? null,
    execute(_route, golden: GoldenCase): EvalCandidate {
      if (golden.recorded === undefined) {
        return {
          output: null,
          skipped: true,
          detail: `no recorded output for ${golden.case_id}`,
        };
      }
      return { output: golden.recorded };
    },
  };
}

/** A fixed case_id → output map (handy for unit tests). */
export function staticExecutor(
  outputs: Record<string, unknown>,
  model?: string | null,
): EvalExecutor {
  return {
    model: model ?? null,
    execute(_route, golden: GoldenCase): EvalCandidate {
      if (!(golden.case_id in outputs)) {
        return {
          output: null,
          skipped: true,
          detail: `no output for ${golden.case_id}`,
        };
      }
      return { output: outputs[golden.case_id] };
    },
  };
}

/** Transform a candidate output — simulate a regression/improvement
 *  against the same recorded corpus. `mutate` returning `undefined`
 *  means "unchanged". */
export function mutatingExecutor(
  base: EvalExecutor,
  mutate: (output: unknown, golden: GoldenCase) => unknown,
): EvalExecutor {
  return {
    model: base.model ?? null,
    async execute(route, golden: GoldenCase): Promise<EvalCandidate> {
      const candidate = await base.execute(route, golden);
      if (candidate.skipped) return candidate;
      const next = mutate(candidate.output, golden);
      return next === undefined ? candidate : { ...candidate, output: next };
    },
  };
}
