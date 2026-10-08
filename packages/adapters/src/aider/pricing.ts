/**
 * OpenRouter price table → cost_usd (ADAPTERS usage accounting;
 * SCHEMAS §13: cost = tokens × backend price table where token-priced).
 *
 * Prices are USD per 1M tokens (input / output), keyed by OpenRouter
 * model id WITHOUT the `openrouter/` prefix.
 *
 * Source: https://openrouter.ai/models — spot-checked list prices,
 * 2026-10-03. Prices drift; update the table when models are added to
 * SETTINGS `main_model`. Unknown model → cost null + warning flag in
 * usage.notes (never a fabricated number).
 */
export interface ModelPrice {
  /** USD per 1M input/prompt tokens. */
  inputPer1M: number;
  /** USD per 1M output/completion tokens. */
  outputPer1M: number;
}

export const OPENROUTER_PRICES: Record<string, ModelPrice> = {
  // anthropic/claude-* (OpenRouter ids: anthropic/<model>)
  'anthropic/claude-opus-4': { inputPer1M: 15.0, outputPer1M: 75.0 },
  'anthropic/claude-opus-4.1': { inputPer1M: 15.0, outputPer1M: 75.0 },
  'anthropic/claude-sonnet-4': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'anthropic/claude-sonnet-4.5': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'anthropic/claude-3.7-sonnet': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'anthropic/claude-3.5-sonnet': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'anthropic/claude-3.5-haiku': { inputPer1M: 0.8, outputPer1M: 4.0 },
  // openai/gpt-* (OpenRouter ids: openai/<model>)
  'openai/gpt-4.1': { inputPer1M: 2.0, outputPer1M: 8.0 },
  'openai/gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'openai/gpt-4.1-nano': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'openai/gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'openai/gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'openai/o3': { inputPer1M: 2.0, outputPer1M: 8.0 },
  'openai/o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  'openai/gpt-5': { inputPer1M: 1.25, outputPer1M: 10.0 },
  'openai/gpt-5-mini': { inputPer1M: 0.25, outputPer1M: 2.0 },
  // google/gemini-* (OpenRouter ids: google/<model>)
  'google/gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0 },
  'google/gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'google/gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'google/gemini-2.0-flash-lite': { inputPer1M: 0.075, outputPer1M: 0.3 },
  // deepseek/* (OpenRouter ids: deepseek/<model>)
  'deepseek/deepseek-v4.1-flash': { inputPer1M: 0.05, outputPer1M: 1.2 },
  // moonshotai/* (OpenRouter ids: moonshotai/<model>)
  'moonshotai/kimi-k3': { inputPer1M: 0.62, outputPer1M: 15.0 },
};

/** Strip the `openrouter/` router prefix aider requires. */
export function normalizeModelId(model: string): string {
  return model.startsWith('openrouter/')
    ? model.slice('openrouter/'.length)
    : model;
}

/**
 * Look up the price row for a model. Accepts ids with or without the
 * `openrouter/` prefix. Unknown → null (caller warns, never guesses).
 */
export function priceFor(model: string): ModelPrice | null {
  return OPENROUTER_PRICES[normalizeModelId(model)] ?? null;
}

/**
 * cost_usd = input tokens × input price + output tokens × output
 * price (+ cached tokens billed at input rate — OpenRouter cache
 * discounts vary by model; the table doesn't carry a cache column so
 * cached tokens cost as plain input. Documented approximation).
 * Unknown model → null.
 */
export function costUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  tokensCached = 0,
): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const cost =
    ((tokensIn + tokensCached) * price.inputPer1M +
      tokensOut * price.outputPer1M) /
    1_000_000;
  // Round to cents-of-a-cent — ledger stays readable, never negative.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
