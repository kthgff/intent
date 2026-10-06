/**
 * decompose/readiness.ts — `tickets.execution_readiness` (PRD §15.10,
 * wp-154): the decomposition verdict over slots + statements + deps.
 *
 *   - deps: an undelivered `depends_on` ticket → `incomplete`; a dep
 *     that can never deliver (failed/blocked/abandoned terminal) →
 *     `blocked`.
 *   - contracts: a declared `contract:` consumer whose `contract.json`
 *     doc is absent → `blocked` (the contract-first invariant).
 *   - slots: knowledge slots on the ticket's interview sessions in
 *     `missing|conflicted` → `incomplete`.
 *   - statements: ticket-scoped statements `disputed`, or with open
 *     decisions / unanswered clarifications → `incomplete`.
 *
 * `unassessed` is the column default for rows that never went through
 * decomposition — this function always returns a computed verdict.
 * The fuller per-type DoR checklist (wp-153) composes on top of this.
 */
import type { ExecutionReadiness } from '@veto/core';
import type { TransitionContext } from '../contracts.js';

/** Dep statuses that mean the dependency has delivered. */
const DELIVERED = ['merged', 'verifying', 'released'] as const;
/** Dep statuses that mean it can never deliver without human action. */
const DEAD = [
  'failed',
  'blocked',
  'aborted',
  'discarded',
  'wont-do',
  'reverted',
] as const;

export interface ReadinessResult {
  readiness: ExecutionReadiness;
  /** Human-readable named checks that failed (empty when `ready`). */
  reasons: string[];
}

export async function computeExecutionReadiness(args: {
  ctx: TransitionContext;
  /** The ticket being assessed — a persisted row or a not-yet-inserted
   *  child (materialization computes before the row exists). */
  ticket: { ticket_id: string; depends_on: readonly string[] };
  /** Contract names the ticket consumes (frontmatter `contract:`). */
  contracts?: readonly string[];
}): Promise<ReadinessResult> {
  const { ctx, ticket } = args;
  const reasons: string[] = [];
  let blocked = false;

  // --- deps ---
  for (const dep of ticket.depends_on) {
    const row = await ctx.store.getTicket({
      workspace: ctx.workspace,
      ticket_id: dep,
    });
    if (!row) {
      reasons.push(`depends_on ${dep}: ticket not found`);
      blocked = true;
      continue;
    }
    if ((DEAD as readonly string[]).includes(row.status)) {
      reasons.push(`depends_on ${dep}: cannot deliver (${row.status})`);
      blocked = true;
    } else if (!(DELIVERED as readonly string[]).includes(row.status)) {
      reasons.push(`depends_on ${dep}: not delivered (${row.status})`);
    }
  }

  // --- contract-first: a declared contract must be a pinned doc ---
  for (const name of args.contracts ?? []) {
    const doc = await ctx.store.getDoc({
      workspace: ctx.workspace,
      subject: ticket.ticket_id,
      doc: 'contract.json',
    });
    if (!doc) {
      reasons.push(`contract '${name}': no contract.json doc pinned`);
      blocked = true;
    }
  }

  // --- knowledge slots (interview sessions bound to the ticket) ---
  const sessions = await ctx.store.listInterviewSessions({
    workspace: ctx.workspace,
    subject: ticket.ticket_id,
  });
  for (const s of sessions) {
    const slots = await ctx.store.listKnowledgeSlots({
      workspace: ctx.workspace,
      session_id: s.session_id,
    });
    for (const slot of slots) {
      if (slot.state === 'missing' || slot.state === 'conflicted') {
        reasons.push(`knowledge slot '${slot.slot}' is ${slot.state}`);
      }
    }
  }

  // --- statements scoped to the ticket ---
  const statements = await ctx.store.listStatements({
    workspace: ctx.workspace,
    scope: 'ticket',
    scope_ref: ticket.ticket_id,
  });
  for (const st of statements) {
    if (st.status === 'disputed') {
      reasons.push(`statement ${st.statement_id} is disputed`);
    }
    const decisions = await ctx.store.listStatementDecisions({
      workspace: ctx.workspace,
      statement_id: st.statement_id,
      status: 'open',
    });
    if (decisions.length > 0) {
      reasons.push(`statement ${st.statement_id} has an open decision`);
    }
    const clarifications = await ctx.store.listStatementClarifications({
      workspace: ctx.workspace,
      statement_id: st.statement_id,
    });
    if (clarifications.some((c) => c.answer == null)) {
      reasons.push(
        `statement ${st.statement_id} has an unanswered clarification`,
      );
    }
  }

  const readiness: ExecutionReadiness = blocked
    ? 'blocked'
    : reasons.length > 0
      ? 'incomplete'
      : 'ready';
  return { readiness, reasons };
}
