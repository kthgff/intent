import { fileURLToPath } from 'node:url';
import type { RouteDecision } from '@sprint-runner/core';

/** Absolute path to the seed golden-set corpus. */
export const FIXTURE_DIR = fileURLToPath(
  new URL('../../../fixtures/eval/', import.meta.url),
);

/** A complete `RouteDecision` for tests (registry-resolved). */
export function route(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    kind: 'extraction',
    model: 'anthropic/claude-sonnet-4',
    primary: 'anthropic/claude-sonnet-4',
    fallback: [],
    max_output_tokens: 4096,
    schema_required: true,
    providers: [],
    eval_threshold: null,
    latency_class: 'background',
    source: 'registry',
    ...overrides,
  };
}
