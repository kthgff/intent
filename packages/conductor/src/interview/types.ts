/**
 * interview/types.ts — shared shapes for the Interview Orchestrator
 * (PRD §15.9, wp-145).
 *
 * The orchestrator is the deterministic control plane over the wp-131
 * interview tables: permissions, session state, slot states, required
 * confirmations, schema validation and stopping conditions are
 * application-owned; the LLM only interprets answers (→ statements via
 * wp-143) and proposes the next question. `InterviewCtx` mirrors the
 * `StudioCtx` shape — both the conductor's `TransitionContext` and the
 * API's session context satisfy it structurally.
 */
import type {
  InterviewMessageRow,
  KnowledgeSlotState,
  StatementIntent,
  StatementPolarity,
  StatementScope,
  Store,
} from '@sprint-runner/core';

/** Everything the orchestrator needs — a subset of TransitionContext. */
export interface InterviewCtx {
  store: Store;
  workspace: string;
  /** `actor:` identity stamped on rows/events the engine writes. */
  actor: string;
  now: () => Date;
}

/** knowledge_slots.state (wp-131) — the six-state slot machine. */
export type SlotState = KnowledgeSlotState;

/**
 * Fail-closed orchestrator error. `code` maps to an HTTP status in the
 * API layer — callers get a typed reason, never a silent no-op.
 */
export class InterviewError extends Error {
  readonly code:
    | 'not-found'
    | 'invalid'
    | 'conflict'
    | 'bad-request'
    | 'answer-order';
  readonly statusCode: number;

  constructor(
    code: InterviewError['code'],
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'InterviewError';
    this.code = code;
    this.statusCode = {
      'not-found': 404,
      invalid: 400,
      conflict: 409,
      'bad-request': 400,
      'answer-order': 409,
    }[code];
  }
}

export const notFound = (m: string) => new InterviewError('not-found', m);
export const invalid = (m: string, detail?: unknown) =>
  new InterviewError('invalid', m, detail);
export const badRequest = (m: string) => new InterviewError('bad-request', m);
export const conflict = (m: string) => new InterviewError('conflict', m);

// ---------------------------------------------------------------------------
// versioned wizard config (wizard_definitions / wizard_versions)
// ---------------------------------------------------------------------------

/**
 * One declared knowledge area. The slot is *config, not code* — the
 * wizard definition declares required areas, the orchestrator reasons
 * about them.
 */
export interface WizardSlotSpec {
  /** Slot name (knowledge_slots.slot). */
  slot: string;
  /** Human label for the Understanding Panel. */
  label?: string | undefined;
  /** Required slots gate the readiness thresholds; optional ones don't. */
  required?: boolean | undefined;
  /** Scoped-knowledge level the area belongs to (§15.9). */
  scope?: StatementScope | undefined;
  /** Deterministic question used when no LLM proposer is injected. */
  question?: string | undefined;
  /** Statement intents this slot accepts (planner relevance hint). */
  accepts?: StatementIntent[] | undefined;
  /** Materiality weight 0..1 — the `impact` half of the score. */
  impact?: number | undefined;
}

/**
 * The two readiness gates as *allowed-state sets* (§15.9 "two
 * thresholds are separate gates"). A required slot satisfies a gate
 * when its state is a member of the set.
 *
 * Defaults: draft accepts inferred/deferred (a draft may rest on
 * unconfirmed or deliberately-deferred knowledge); approval accepts
 * only known/not-applicable — `inferred` never auto-approves.
 */
export interface WizardThresholds {
  draft: SlotState[];
  approval: SlotState[];
}

export const DEFAULT_THRESHOLDS: WizardThresholds = {
  draft: ['known', 'inferred', 'not-applicable', 'deferred'],
  approval: ['known', 'not-applicable'],
};

/** The `definition` json on wizard_versions. */
export interface WizardConfig {
  wizard_id: string;
  name?: string | undefined;
  description?: string | undefined;
  version: number;
  slots: WizardSlotSpec[];
  thresholds?: WizardThresholds | undefined;
  /** Planner prompt override (prompt policy lives in config). */
  prompts?: { planner?: string | undefined } | undefined;
}

/** Read a `knowledge_slots.state` string back as the enum union. */
export function asSlotState(state: string): SlotState {
  return state as SlotState;
}

// ---------------------------------------------------------------------------
// scoring + readiness
// ---------------------------------------------------------------------------

/**
 * Planner score inputs (§15.9). The AI estimates the components; the
 * runner owns the deterministic composite (`scoreCandidate`).
 */
export interface QuestionScores {
  /** How much the answer changes the outcome. */
  impact: number;
  /** How much we don't yet know. */
  uncertainty: number;
  /** How central to the wizard's required areas. */
  relevance: number;
  /** Can the user actually answer this? (0 = no → unanswerable). */
  answerability: number;
  /** Cost to the user (0 = cheap). */
  effort: number;
  /** Runner-computed composite — never trusted from the model. */
  score?: number;
}

export interface ReadinessBlocker {
  slot: string;
  state: SlotState;
  reason: string;
}

/**
 * Explainable readiness report (§15.9/§15.3) — indicators, not an
 * opaque percentage. `draft_ready ≠ approval_ready` by construction:
 * the approval set is a strict subset of the draft set.
 */
export interface ReadinessReport {
  draft_ready: boolean;
  approval_ready: boolean;
  required_total: number;
  /** Required-slot state histogram. */
  states: Record<SlotState, number>;
  draft_blockers: ReadinessBlocker[];
  approval_blockers: ReadinessBlocker[];
  /** Open statement decisions bound to the session's slots. */
  open_decisions: string[];
  summary: string;
}

/** Resume diff briefing — "what changed since you left" (§15.9). */
export interface ResumeBriefing {
  session_id: string;
  from_version: number | null;
  to_version: number;
  changed_slots: {
    slot: string;
    from: SlotState | null;
    to: SlotState;
  }[];
  new_messages: InterviewMessageRow[];
  readiness_before: ReadinessReport | null;
  readiness_after: ReadinessReport;
  summary: string;
}

// ---------------------------------------------------------------------------
// multi-stakeholder branches
// ---------------------------------------------------------------------------

/** Who-said-what survives the merge (§15.9). */
export interface BranchAttribution {
  statement_id: string;
  branch: string;
  role: string | null;
  text: string;
  polarity: StatementPolarity | null;
}

export interface MergeConflict {
  slot: string;
  /** The two conflicting statement_ids. */
  statements: [string, string];
  /** Open decision item opened for the disagreement. */
  decision_id: string;
}

export interface MergeResult {
  branch: string;
  role: string | null;
  attribution: BranchAttribution[];
  merged_statements: string[];
  conflicts: MergeConflict[];
}

// ---------------------------------------------------------------------------
// deterministic id helpers
// ---------------------------------------------------------------------------

/** Lowercase, dash-separated, non-empty. */
export function slug(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'x';
}

/** Deterministic session id — one session per (wizard, subject). */
export function sessionIdFor(
  wizardId: string,
  subject?: string | null,
): string {
  const w = slug(wizardId);
  return subject
    ? `iv-${w}-${slug(subject)}`
    : `iv-${w}-${Date.now().toString(36)}`;
}

/** Deterministic question id — `<session>:q:<slot>:<suffix>` where the
 *  suffix is the planning purpose (`fill`|`confirm`). Stable across
 *  re-planning so a re-proposal upserts the same candidate. */
export function questionIdFor(
  sessionId: string,
  slot: string,
  suffix: string,
): string {
  return `${sessionId}:q:${slug(slot)}:${slug(suffix)}`;
}

/** The planning purpose carried in a candidate's `scores.purpose`. */
export type QuestionPurpose = 'fill' | 'confirm';
