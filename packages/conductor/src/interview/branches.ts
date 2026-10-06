/**
 * interview/branches.ts — multi-stakeholder specialist branches
 * (PRD §15.9).
 *
 * One discovery workspace, specialist interview branches routed by
 * role. Merging a branch folds its statements into the session while
 * PRESERVING attribution — every statement keeps its verbatim
 * `source_ref` (who-said-what), and the merge report names the branch
 * and role behind each statement. A disagreement between statements
 * bound to the same slot opens a decision item (a `contradicts` edge +
 * an open `statement_decisions` row) and flags the slot `conflicted` —
 * never a silent merge.
 */
import type {
  InterviewBranchRow,
  StatementPolarity,
  StatementRow,
} from '@veto/core';
import { appendMessage, requireSession, transcript } from './session.js';
import { listSlots, polarityConflicts, refreshSlot } from './slots.js';
import {
  type BranchAttribution,
  type InterviewCtx,
  type MergeConflict,
  type MergeResult,
  conflict,
  notFound,
  slug,
} from './types.js';

export async function listBranches(
  ctx: InterviewCtx,
  sessionId: string,
): Promise<InterviewBranchRow[]> {
  return ctx.store.listInterviewBranches({
    workspace: ctx.workspace,
    session_id: sessionId,
  });
}

/** Get-or-create a specialist branch (idempotent on the PK). */
export async function createBranch(
  ctx: InterviewCtx,
  args: { sessionId: string; branch: string; role?: string | null },
): Promise<InterviewBranchRow> {
  await requireSession(ctx, args.sessionId);
  const existing = (await listBranches(ctx, args.sessionId)).find(
    (b) => b.branch === args.branch,
  );
  if (existing) return existing;
  const ts = ctx.now().toISOString();
  const row: InterviewBranchRow = {
    workspace: ctx.workspace,
    org: null,
    session_id: args.sessionId,
    branch: args.branch,
    role: args.role ?? null,
    status: 'active',
    created_at: ts,
    merged_at: null,
  };
  await ctx.store.upsertInterviewBranch(row);
  await appendMessage(ctx, {
    sessionId: args.sessionId,
    role: 'system',
    content: `[branch opened] ${args.branch}${
      args.role ? ` (role: ${args.role})` : ''
    }`,
    branch: args.branch,
  });
  return row;
}

async function requireBranch(
  ctx: InterviewCtx,
  sessionId: string,
  branch: string,
): Promise<InterviewBranchRow> {
  const row = (await listBranches(ctx, sessionId)).find(
    (b) => b.branch === branch,
  );
  if (!row) throw notFound(`no branch '${branch}' on session ${sessionId}`);
  return row;
}

/** Statement source_ref read as an object. */
function sourceRefOf(s: StatementRow): {
  kind?: string;
  id?: string;
} {
  return (s.source_ref ?? {}) as { kind?: string; id?: string };
}

/**
 * Statements produced from a branch's answers — resolved through the
 * durable transcript (`source_ref.id` = `<session>#<seq>`).
 */
export async function branchStatements(
  ctx: InterviewCtx,
  sessionId: string,
  branch: string,
): Promise<StatementRow[]> {
  const messages = await transcript(ctx, sessionId);
  const refs = new Set(
    messages
      .filter((m) => (m.branch ?? null) === branch)
      .map((m) => `${sessionId}#${m.seq}`),
  );
  const all = await ctx.store.listStatements({ workspace: ctx.workspace });
  return all.filter((s) => {
    const ref = sourceRefOf(s);
    return (
      ref.kind === 'interview-message' &&
      ref.id !== undefined &&
      refs.has(ref.id)
    );
  });
}

/**
 * Merge a specialist branch: mark it `merged`, preserve attribution,
 * and open decision items for any disagreement the merge surfaces.
 */
export async function mergeBranch(
  ctx: InterviewCtx,
  args: { sessionId: string; branch: string },
): Promise<MergeResult> {
  const session = await requireSession(ctx, args.sessionId);
  const branch = await requireBranch(ctx, args.sessionId, args.branch);
  if (branch.status === 'merged') {
    throw conflict(`branch '${args.branch}' is already merged`);
  }
  if (branch.status === 'abandoned') {
    throw conflict(`branch '${args.branch}' was abandoned — nothing to merge`);
  }
  const ts = ctx.now().toISOString();

  const statements = await branchStatements(ctx, args.sessionId, args.branch);
  const attribution: BranchAttribution[] = statements.map((s) => ({
    statement_id: s.statement_id,
    branch: args.branch,
    role: branch.role ?? null,
    text: s.text,
    polarity: (s.polarity as StatementPolarity | null) ?? null,
  }));

  // Disagreement detection: any slot binding two live statements with
  // opposite polarity is a conflict → decision item, not a merge.
  const conflicts: MergeConflict[] = [];
  const slots = await listSlots(ctx, args.sessionId);
  for (const slot of slots) {
    const refs = slot.statement_refs ?? [];
    const bound: StatementRow[] = [];
    for (const id of refs) {
      const s = await ctx.store.getStatement({
        workspace: ctx.workspace,
        statement_id: id,
      });
      if (s) bound.push(s);
    }
    for (const [a, b] of polarityConflicts(bound)) {
      const decisionId = `sd-${a.statement_id}-branchconflict-${slug(b.statement_id)}`;
      const open = await ctx.store.listStatementDecisions({
        workspace: ctx.workspace,
        statement_id: a.statement_id,
        status: 'open',
      });
      if (!open.some((d) => d.decision_id === decisionId)) {
        await ctx.store.upsertStatementRelation({
          workspace: ctx.workspace,
          org: null,
          src: a.statement_id,
          predicate: 'contradicts',
          dst: b.statement_id,
          created_by: ctx.actor,
          created_at: ts,
        });
        await ctx.store.upsertStatementDecision({
          workspace: ctx.workspace,
          org: null,
          decision_id: decisionId,
          statement_id: a.statement_id,
          decision: null,
          status: 'open',
          rationale: `branch merge conflict on slot '${slot.slot}': ${a.statement_id} (${attributionOf(
            a,
            args.branch,
            branch.role ?? null,
          )}) contradicts ${b.statement_id} (${attributionOf(
            b,
            args.branch,
            branch.role ?? null,
          )})`,
          decided_by: null,
          decided_at: null,
          created_by: ctx.actor,
          created_at: ts,
        });
      }
      await refreshSlot(ctx, args.sessionId, slot.slot);
      conflicts.push({
        slot: slot.slot,
        statements: [a.statement_id, b.statement_id],
        decision_id: decisionId,
      });
    }
  }

  const merged: InterviewBranchRow = {
    ...branch,
    status: 'merged',
    merged_at: ts,
  };
  await ctx.store.upsertInterviewBranch(merged);
  await appendMessage(ctx, {
    sessionId: args.sessionId,
    role: 'system',
    content: `[branch merged] ${args.branch}${branch.role ? ` (role: ${branch.role})` : ''}: ${statements.length} statement(s) merged with attribution${conflicts.length > 0 ? `; ${conflicts.length} disagreement(s) routed to decision items` : ''}`,
    branch: args.branch,
  });

  return {
    branch: args.branch,
    role: branch.role ?? null,
    attribution,
    merged_statements: statements.map((s) => s.statement_id),
    conflicts,
  };
}

function attributionOf(
  s: StatementRow,
  branch: string,
  role: string | null,
): string {
  const ref = sourceRefOf(s);
  return `${branch}${role ? `/${role}` : ''} @${ref.id ?? s.statement_id}`;
}

/** Abandon a branch — its statements stay in the ledger, untouched. */
export async function abandonBranch(
  ctx: InterviewCtx,
  args: { sessionId: string; branch: string },
): Promise<InterviewBranchRow> {
  const branch = await requireBranch(ctx, args.sessionId, args.branch);
  if (branch.status === 'merged') {
    throw conflict(`branch '${args.branch}' is merged — cannot abandon`);
  }
  const next: InterviewBranchRow = { ...branch, status: 'abandoned' };
  await ctx.store.upsertInterviewBranch(next);
  return next;
}
