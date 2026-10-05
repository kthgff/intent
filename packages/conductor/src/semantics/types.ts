/**
 * Statement Ledger — shared types (wp-143, PRD §15.3/§15.9).
 *
 * The ledger separates *evidence* (a board note, an interview answer,
 * imported text) from *meaning* (atomic semantic_statements). Every
 * statement keeps its verbatim source (`source_text` + `source_ref`
 * span) — never paraphrased away.
 */
import type { ActorType, StatementSourceRef } from '@sprint-runner/core';

/** One evidence document an extraction pass reads — the verbatim text
 *  plus the ref stored on every statement it yields. */
export interface ExtractionSource {
  ref: StatementSourceRef;
  /** The full source text spans index into. */
  text: string;
}

/** Who is performing a ledger mutation — drives the "AI proposes,
 *  humans confirm" rule (only `human` may confirm/reject/decide). */
export interface StatementActor {
  id: string;
  type: ActorType;
}

/** Fail-closed extraction/lifecycle error — malformed output aborts
 *  the batch rather than guessing (AGENTS.md). */
export class StatementError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'StatementError';
  }
}
