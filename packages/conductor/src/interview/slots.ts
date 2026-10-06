/**
 * interview/slots.ts — the knowledge-slot state machine (PRD §15.9).
 *
 * A slot's state is *derived* from the semantic statements bound to it
 * (wp-143) plus explicit user actions:
 *
 *   missing      — no bound statements yet (a required area is open)
 *   inferred     — bound statements are AI-proposed / not yet confirmed
 *   known        — every bound statement is human-confirmed
 *   conflicted   — a bound statement is disputed, or an open decision
 *                  item sits on it (disagreement → decision, §15.9)
 *   not-applicable — the user said the area doesn't apply here
 *   deferred     — deliberately deferred / "user can't answer"
 *
 * Dead truth (rejected/superseded) is ignored — it never backs a slot.
 * The transition is application-owned: the LLM never sets a slot state.
 */
import type { KnowledgeSlotRow, StatementRow, Store } from '@veto/core';
import { confirmStatement } from '../semantics/index.js';
import type { InterviewCtx, SlotState, WizardConfig } from './types.js';
import { invalid, notFound } from './types.js';
import { slotSpec } from './wizard.js';

/** Slot states that are terminal for planning (no question is asked). */
export const TERMINAL_SLOT_STATES: ReadonlySet<SlotState> = new Set([
  'known',
  'not-applicable',
  'deferred',
  'conflicted',
]);

/** Statements that still count as live evidence for a slot. */
export function isLiveStatement(s: StatementRow): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

export async function listSlots(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<KnowledgeSlotRow[]> {
  return ctx.store.listKnowledgeSlots({
    workspace: ctx.workspace,
    session_id: sessionId,
  });
}

export async function getSlot(
  ctx: InterviewCtx,
  sessionId: string,
  slot: string,
): Promise<KnowledgeSlotRow | null> {
  return ctx.store.getKnowledgeSlot({
    workspace: ctx.workspace,
    session_id: sessionId,
    slot,
  });
}

/**
 * Derive a slot state from its live bound statements + open decisions.
 * `conflicted` wins over everything but explicit user actions (the
 * caller applies not-applicable/deferred before calling this).
 */
export function deriveSlotState(
  statements: StatementRow[],
  openDecisionStatementIds: ReadonlySet<string>,
): SlotState {
  const live = statements.filter(isLiveStatement);
  if (live.length === 0) return 'missing';
  if (
    live.some(
      (s) =>
        s.status === 'disputed' || openDecisionStatementIds.has(s.statement_id),
    )
  ) {
    return 'conflicted';
  }
  if (live.every((s) => s.status === 'confirmed')) return 'known';
  return 'inferred';
}

/** Load the live statements bound to a slot (by statement_refs). */
async function boundStatements(
  store: Store,
  workspace: string,
  refs: string[],
): Promise<StatementRow[]> {
  const out: StatementRow[] = [];
  for (const id of refs) {
    const s = await store.getStatement({ workspace, statement_id: id });
    if (s) out.push(s);
  }
  return out;
}

/** Open decision ids bound to any of `refs`. */
async function openDecisions(
  store: Store,
  workspace: string,
  refs: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const id of refs) {
    const ds = await store.listStatementDecisions({
      workspace,
      statement_id: id,
      status: 'open',
    });
    for (const d of ds) ids.push(d.decision_id);
  }
  return ids;
}

/** The statement_ids among `refs` that carry an open decision item. */
async function openDecisionStatementIds(
  store: Store,
  workspace: string,
  refs: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of refs) {
    const ds = await store.listStatementDecisions({
      workspace,
      statement_id: id,
      status: 'open',
    });
    if (ds.length > 0) out.add(id);
  }
  return out;
}

/** Open decision ids across every statement bound to the given slots. */
export async function openDecisionsForSlots(
  ctx: InterviewCtx,
  rows: KnowledgeSlotRow[],
): Promise<string[]> {
  const refs = new Set<string>();
  for (const row of rows) {
    for (const r of row.statement_refs ?? []) refs.add(r);
  }
  return openDecisions(ctx.store, ctx.workspace, [...refs]);
}

/**
 * Recompute + persist a slot from its bound statements. Explicit
 * user-set states (`not-applicable`/`deferred`) are preserved — a
 * later answer can still add statements, but the user's ruling stands
 * until they change it.
 */
export async function refreshSlot(
  ctx: InterviewCtx,
  sessionId: string,
  slot: string,
): Promise<KnowledgeSlotRow> {
  const row = await getSlot(ctx, sessionId, slot);
  if (!row) throw notFound(`no slot '${slot}' on session ${sessionId}`);
  if (row.state === 'not-applicable' || row.state === 'deferred') return row;

  const refs = row.statement_refs ?? [];
  const statements = await boundStatements(ctx.store, ctx.workspace, refs);
  const open = await openDecisionStatementIds(ctx.store, ctx.workspace, refs);
  const state = deriveSlotState(statements, open);
  const confidence =
    statements.length === 0
      ? null
      : statements.reduce((acc, s) => acc + (s.confidence ?? 0.5), 0) /
        statements.length;

  const next: KnowledgeSlotRow = {
    ...row,
    state,
    value: row.value ?? bestValue(statements),
    confidence,
    updated_at: ctx.now().toISOString(),
  };
  await ctx.store.upsertKnowledgeSlot(next);
  return next;
}

/** Best-effort human-readable summary — the first live statement text. */
function bestValue(statements: StatementRow[]): string | null {
  const live = statements.filter(isLiveStatement);
  return live[0]?.text ?? null;
}

/**
 * Bind statements produced from an answer to one or more slots, then
 * recompute each slot. Returns the updated slot rows.
 */
export async function bindStatementsToSlots(
  ctx: InterviewCtx,
  sessionId: string,
  slots: string[],
  statements: StatementRow[],
): Promise<KnowledgeSlotRow[]> {
  const ts = ctx.now().toISOString();
  const updated: KnowledgeSlotRow[] = [];
  for (const slot of slots) {
    const row = await getSlot(ctx, sessionId, slot);
    if (!row) {
      throw invalid(`answer targets unknown slot '${slot}' on ${sessionId}`);
    }
    const merged = new Set([
      ...(row.statement_refs ?? []),
      ...statements.map((s) => s.statement_id),
    ]);
    await ctx.store.upsertKnowledgeSlot({
      ...row,
      statement_refs: [...merged],
      updated_at: ts,
    });
    updated.push(await refreshSlot(ctx, sessionId, slot));
  }
  return updated;
}

/** Explicit user action: mark a slot not-applicable / deferred. */
export async function markSlot(
  ctx: InterviewCtx,
  args: {
    sessionId: string;
    slot: string;
    state: Extract<SlotState, 'not-applicable' | 'deferred' | 'known'>;
    value?: string | null;
  },
): Promise<KnowledgeSlotRow> {
  const row = await getSlot(ctx, args.sessionId, args.slot);
  if (!row) {
    throw notFound(`no slot '${args.slot}' on session ${args.sessionId}`);
  }
  const next: KnowledgeSlotRow = {
    ...row,
    state: args.state,
    value: args.value ?? row.value,
    updated_at: ctx.now().toISOString(),
  };
  await ctx.store.upsertKnowledgeSlot(next);
  return next;
}

/**
 * Deterministic polarity conflicts among live statements: two live
 * statements sharing a `subject` (case-insensitive) with opposite
 * polarity. Returns the conflicting statement_id pairs.
 */
export function polarityConflicts(
  statements: StatementRow[],
): [StatementRow, StatementRow][] {
  const live = statements.filter(isLiveStatement);
  const out: [StatementRow, StatementRow][] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i] as StatementRow;
      const b = live[j] as StatementRow;
      if (!a.subject || !b.subject) continue;
      if (a.subject.toLowerCase() !== b.subject.toLowerCase()) continue;
      if (a.polarity === b.polarity) continue;
      if (a.polarity === null || b.polarity === null) continue;
      out.push([a, b]);
    }
  }
  return out;
}

/** Slots declared by a wizard that have no row yet (defensive). */
export function missingSlotRows(
  cfg: WizardConfig,
  rows: KnowledgeSlotRow[],
): string[] {
  const have = new Set(rows.map((r) => r.slot));
  return cfg.slots.filter((s) => !have.has(s.slot)).map((s) => s.slot);
}

/** Validate that a slot is declared by the wizard. */
export function requireSlotSpec(cfg: WizardConfig, slot: string) {
  const spec = slotSpec(cfg, slot);
  if (!spec) {
    throw invalid(
      `slot '${slot}' is not declared by wizard '${cfg.wizard_id}'`,
    );
  }
  return spec;
}

/**
 * Human confirmation of a slot — confirms every live *proposed*
 * statement bound to it (the "required confirmation" step, §15.9). An
 * AI-only slot therefore never reaches `known`/approval-ready without
 * a human: `inferred` never auto-approves. Returns the refreshed slot.
 */
export async function confirmSlot(
  ctx: InterviewCtx,
  args: { sessionId: string; slot: string },
): Promise<KnowledgeSlotRow> {
  const row = await getSlot(ctx, args.sessionId, args.slot);
  if (!row) {
    throw notFound(`no slot '${args.slot}' on session ${args.sessionId}`);
  }
  const refs = row.statement_refs ?? [];
  const statements = await boundStatements(ctx.store, ctx.workspace, refs);
  for (const s of statements) {
    if (s.status === 'proposed' || s.status === 'disputed') {
      await confirmStatement(ctx.store, {
        workspace: ctx.workspace,
        statement_id: s.statement_id,
        actor: { id: ctx.actor, type: 'human' },
        now: ctx.now,
      });
    }
  }
  return refreshSlot(ctx, args.sessionId, args.slot);
}
