/**
 * assistant/types.ts — the Board Assistant context + shared helpers
 * (BOARD-CHAT-PRD, TDD "turn pipeline").
 *
 * `AssistantCtx` extends the interview orchestrator's ctx with the two
 * model seams. The provider is the ONLY LLM surface (TDD contract
 * amendment 4): absent → every consumer degrades deterministically
 * (verbatim extraction, deterministic planner + critique, command mode
 * reports a configured model is required) and the panel's `model`
 * field reads `absent` — fail-loud, never silent (PRD R10).
 */
import type { BoardItem, CompletionProvider } from '@veto/core';
import type { InterviewCtx } from '../interview/index.js';

export interface AssistantCtx extends InterviewCtx {
  /** Route-resolved completion provider; `undefined` = deterministic
   *  mode (all extraction/planner/converse paths still function). */
  provider?: CompletionProvider | undefined;
  /** Resolved model label echoed on the panel payload (`model`). */
  model?: string | undefined;
  /**
   * Extraction seam — the wp-143 `extract(prompt)` signature. wp-164
   * wires `provider.converse` through a prompt adapter; omit → the
   * verbatim one-statement fallback.
   */
  extract?: ((prompt: string) => Promise<string>) | undefined;
  /**
   * Planner seam — model-proposed next question (`propose(prompt)`).
   * Omit → deterministic proposals from eligibility + slot impact.
   */
  propose?: ((prompt: string) => Promise<string>) | undefined;
}

/** Active board items are the canvas's truth — proposals read them. */
export function activeItems(items: BoardItem[]): BoardItem[] {
  return items.filter((i) => i.status === 'active');
}

/** Goal-ness derives (TDD spec-gap note): an item is a goal iff some
 *  other item's `serves` array names it. */
export function servesTargetIds(items: BoardItem[]): Set<string> {
  const out = new Set<string>();
  for (const i of items) for (const g of i.serves ?? []) out.add(g);
  return out;
}
