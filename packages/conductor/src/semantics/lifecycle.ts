/**
 * Statement lifecycle (wp-143, PRD §15.3/§15.9) — the write paths for
 * everything after extraction: propose, confirm, reject, dispute,
 * supersede, clarify, decide, link.
 *
 * The standing rules:
 *  - "AI proposes, humans confirm" — only `actor.type === 'human'` may
 *    move a statement to `confirmed`/`rejected` or decide a decision
 *    item. `inferred` never auto-approves: agent/system writes always
 *    land `proposed`.
 *  - every write is a new statement_versions entry via
 *    `store.upsertStatement` (head + append-only history).
 *  - disagreements are decision items, never silent merges.
 *  - supersession applies only when the superseding statement is
 *    `confirmed` — a draft never retires confirmed truth.
 */
import { randomUUID } from 'node:crypto';
import { locateQuote } from '@sprint-runner/lints';
import type {
  StatementDecisionRow,
  StatementIntent,
  StatementPolarity,
  StatementRow,
  StatementScope,
  StatementSourceRef,
  StatementStatus,
  StatementStrength,
  Store,
} from '@sprint-runner/core';
import { StatementError, type StatementActor } from './types.js';

type HeadWrite = Omit<StatementRow, 'version'>;

function stripVersion(row: StatementRow): HeadWrite {
  const { version: _v, ...rest } = row;
  return rest;
}

async function head(
  store: Store,
  workspace: string,
  statement_id: string,
): Promise<StatementRow> {
  const row = await store.getStatement({ workspace, statement_id });
  if (!row) {
    throw new StatementError(
      `no semantic_statements row for ${workspace}/${statement_id}`,
    );
  }
  return row;
}

function requireHuman(actor: StatementActor, what: string): void {
  if (actor.type !== 'human') {
    throw new StatementError(
      `${what}: requires a human actor (AI proposes, humans confirm — §15.3), got ${actor.type}`,
    );
  }
}

// ---------------------------------------------------------------------------
// propose — direct (non-extraction) statement authoring
// ---------------------------------------------------------------------------

export interface ProposeStatementArgs {
  workspace: string;
  org?: string | null;
  /** Caller-assigned id — default `st-man-<uuid8>`. */
  statement_id?: string;
  text: string;
  /** Verbatim evidence quote — when `source_ref` is given it is
   *  verified against `evidence` (if also given). */
  source_text?: string | null;
  source_ref?: StatementSourceRef | null;
  /** The evidence document the quote must appear in verbatim —
   *  fail-closed when the quote isn't found. */
  evidence?: string;
  intent?: StatementIntent | null;
  polarity?: StatementPolarity | null;
  subject?: string | null;
  strength?: StatementStrength | null;
  scope?: StatementScope | null;
  scope_ref?: string | null;
  confidence?: number | null;
  /** Humans may author directly `confirmed` (stakeholder-verified);
   *  agents may not — the flag is ignored for non-humans. */
  confirm?: boolean;
  actor: StatementActor;
  now?: () => Date;
}

/** Author one statement outside an extraction run (a human's direct
 *  assertion, an agent's derived claim). Provenance is derived —
 *  `stakeholder-verified` only ever comes from a human. */
export async function proposeStatement(
  store: Store,
  args: ProposeStatementArgs,
): Promise<StatementRow> {
  const ts = (args.now?.() ?? new Date()).toISOString();
  const id =
    args.statement_id ?? `st-man-${randomUUID().slice(0, 8)}`;
  const humanConfirm = args.actor.type === 'human' && args.confirm === true;

  let sourceRef: StatementSourceRef | null = args.source_ref ?? null;
  if (args.evidence !== undefined && args.source_text) {
    // Same verbatim guarantee as extraction — verify and pin the span.
    const span = locateQuote(args.evidence, args.source_text);
    if (span === null) {
      throw new StatementError(
        'proposeStatement: source_text is not a verbatim substring of the evidence',
      );
    }
    sourceRef = { ...(sourceRef ?? { kind: 'manual', id: 'evidence' }), span };
  }

  const provenance = humanConfirm
    ? 'stakeholder-verified'
    : args.source_text || sourceRef
      ? 'source-backed'
      : 'inferred';

  return store.upsertStatement({
    workspace: args.workspace,
    org: args.org ?? null,
    statement_id: id,
    text: args.text,
    source_text: args.source_text ?? null,
    source_ref: sourceRef,
    intent: args.intent ?? null,
    polarity: args.polarity ?? null,
    subject: args.subject ?? null,
    strength: args.strength ?? null,
    scope: args.scope ?? null,
    scope_ref: args.scope_ref ?? null,
    status: humanConfirm ? 'confirmed' : 'proposed',
    confidence: args.confidence ?? null,
    provenance,
    extraction_run: null,
    created_by: args.actor.id,
    created_at: ts,
    updated_at: ts,
  });
}

// ---------------------------------------------------------------------------
// status transitions
// ---------------------------------------------------------------------------

export interface TransitionArgs {
  workspace: string;
  statement_id: string;
  actor: StatementActor;
  now?: () => Date;
}

/** Rewrite the head with a new status (+ optional fields) as a new
 *  version. Returns the new head row. */
async function writeStatus(
  store: Store,
  row: StatementRow,
  status: StatementStatus,
  args: TransitionArgs,
  extra?: Partial<HeadWrite>,
): Promise<StatementRow> {
  const ts = (args.now?.() ?? new Date()).toISOString();
  return store.upsertStatement({
    ...stripVersion(row),
    ...extra,
    status,
    created_by: args.actor.id, // version.edited_by
    updated_at: ts,
  });
}

/**
 * Human confirmation — `proposed`/`disputed` → `confirmed` and the
 * provenance upgrades to `stakeholder-verified` (a human just
 * verified it). Then pending `supersedes` edges where this statement
 * is the source are APPLIED: the target goes `superseded` and its open
 * supersede-decision is auto-decided with the audit note.
 *
 * Fail-closed: confirming a `rejected`/`superseded` statement throws —
 * resurrect it explicitly via a new proposal, never silently.
 */
export async function confirmStatement(
  store: Store,
  args: TransitionArgs,
): Promise<StatementRow> {
  requireHuman(args.actor, 'confirmStatement');
  return store.transaction(async (s) => {
    const row = await head(s, args.workspace, args.statement_id);
    if (row.status === 'confirmed') return row; // idempotent
    if (row.status === 'superseded' || row.status === 'rejected') {
      throw new StatementError(
        `confirmStatement: ${args.statement_id} is ${row.status} — cannot confirm dead truth`,
      );
    }
    const next = await writeStatus(s, row, 'confirmed', args, {
      provenance: 'stakeholder-verified',
    });
    await applySupersedes(s, next, args);
    return next;
  });
}

/** Human rejection — `proposed`/`disputed`/`confirmed` → `rejected`. */
export async function rejectStatement(
  store: Store,
  args: TransitionArgs & { rationale?: string | null },
): Promise<StatementRow> {
  requireHuman(args.actor, 'rejectStatement');
  const row = await head(store, args.workspace, args.statement_id);
  if (row.status === 'rejected') return row;
  if (row.status === 'superseded') {
    throw new StatementError(
      `rejectStatement: ${args.statement_id} is superseded — history is kept, not re-rejected`,
    );
  }
  return writeStatus(store, row, 'rejected', args);
}

/**
 * Contest a live statement — any actor may dispute (an AI finding a
 * contradiction raises the flag; it never decides). Sets `disputed`
 * and opens a decision item when none is open yet (idempotent).
 */
export async function disputeStatement(
  store: Store,
  args: TransitionArgs & { reason: string },
): Promise<{ statement: StatementRow; decision_id: string }> {
  return store.transaction(async (s) => {
    const row = await head(s, args.workspace, args.statement_id);
    if (row.status === 'superseded' || row.status === 'rejected') {
      throw new StatementError(
        `disputeStatement: ${args.statement_id} is ${row.status} — nothing live to dispute`,
      );
    }
    const ts = (args.now?.() ?? new Date()).toISOString();
    const decisionId = `sd-${args.statement_id}-dispute`;
    const existing = await s.listStatementDecisions({
      workspace: args.workspace,
      statement_id: args.statement_id,
      status: 'open',
    });
    if (existing.length === 0) {
      await s.upsertStatementDecision({
        workspace: args.workspace,
        org: row.org ?? null,
        decision_id: decisionId,
        statement_id: args.statement_id,
        decision: null,
        status: 'open',
        rationale: args.reason,
        decided_by: null,
        decided_at: null,
        created_by: args.actor.id,
        created_at: ts,
      });
    }
    const next =
      row.status === 'disputed'
        ? row
        : await writeStatus(s, row, 'disputed', args);
    return { statement: next, decision_id: decisionId };
  });
}

/**
 * `src` supersedes `dst` — the typed edge plus its authority
 * side-effect. Applies immediately only when `src` is already
 * `confirmed` (the supersession was human-ratified); otherwise records
 * the edge and, when `dst` is confirmed, opens a decision item —
 * a draft never silently retires confirmed truth.
 */
export async function supersedeStatement(
  store: Store,
  args: {
    workspace: string;
    src: string;
    dst: string;
    actor: StatementActor;
    now?: () => Date;
  },
): Promise<{ applied: boolean; decision_id?: string }> {
  return store.transaction(async (s) => {
    const ts = (args.now?.() ?? new Date()).toISOString();
    const src = await head(s, args.workspace, args.src);
    const dst = await head(s, args.workspace, args.dst);
    if (args.src === args.dst) {
      throw new StatementError('supersedeStatement: self-edge');
    }
    await s.upsertStatementRelation({
      workspace: args.workspace,
      org: dst.org ?? src.org ?? null,
      src: src.statement_id,
      predicate: 'supersedes',
      dst: dst.statement_id,
      created_by: args.actor.id,
      created_at: ts,
    });
    if (src.status === 'confirmed' && dst.status !== 'superseded') {
      await writeStatus(s, dst, 'superseded', {
        workspace: args.workspace,
        statement_id: dst.statement_id,
        actor: args.actor,
        ...(args.now ? { now: args.now } : {}),
      });
      await decideSupersedeDecisions(s, dst.statement_id, src.statement_id, args, ts);
      return { applied: true };
    }
    if (dst.status === 'confirmed') {
      const decisionId = `sd-${dst.statement_id}-supersede-${src.statement_id}`;
      const open = await s.listStatementDecisions({
        workspace: args.workspace,
        statement_id: dst.statement_id,
        status: 'open',
      });
      if (!open.some((d) => d.decision_id === decisionId)) {
        await s.upsertStatementDecision({
          workspace: args.workspace,
          org: dst.org ?? null,
          decision_id: decisionId,
          statement_id: dst.statement_id,
          decision: null,
          status: 'open',
          rationale: `${src.statement_id} (unconfirmed) claims to supersede — human ruling required`,
          decided_by: null,
          decided_at: null,
          created_by: args.actor.id,
          created_at: ts,
        });
      }
      return { applied: false, decision_id: decisionId };
    }
    return { applied: false };
  });
}

/** Apply `supersedes` edges where `src` just became confirmed — called
 *  from confirmStatement. */
async function applySupersedes(
  s: Store,
  src: StatementRow,
  args: TransitionArgs,
): Promise<void> {
  const ts = (args.now?.() ?? new Date()).toISOString();
  const edges = await s.listStatementRelations({
    workspace: args.workspace,
    src: src.statement_id,
    predicate: 'supersedes',
  });
  for (const rel of edges) {
    const dst = await s.getStatement({
      workspace: args.workspace,
      statement_id: rel.dst,
    });
    if (!dst || dst.status === 'superseded' || dst.status === 'rejected') {
      continue;
    }
    await writeStatus(s, dst, 'superseded', args);
    await decideSupersedeDecisions(s, dst.statement_id, src.statement_id, args, ts);
  }
}

/** Close open supersede decision items on `dstId` — the human's
 *  confirmation of `srcId` is the ruling. */
async function decideSupersedeDecisions(
  s: Store,
  dstId: string,
  srcId: string,
  args: Pick<TransitionArgs, 'workspace' | 'actor'>,
  ts: string,
): Promise<void> {
  const open = await s.listStatementDecisions({
    workspace: args.workspace,
    statement_id: dstId,
    status: 'open',
  });
  for (const d of open) {
    if (!d.decision_id.includes('-supersede-')) continue;
    await s.upsertStatementDecision({
      ...d,
      decision: `superseded by ${srcId} (confirmed by ${args.actor.id})`,
      status: 'decided',
      decided_by: args.actor.id,
      decided_at: ts,
    });
  }
}

// ---------------------------------------------------------------------------
// clarifications
// ---------------------------------------------------------------------------

/** Open a clarification question on a statement. */
export async function askStatementClarification(
  store: Store,
  args: {
    workspace: string;
    org?: string | null;
    statement_id: string;
    question: string;
    actor: StatementActor;
    clarification_id?: string;
    now?: () => Date;
  },
): Promise<string> {
  await head(store, args.workspace, args.statement_id);
  const ts = (args.now?.() ?? new Date()).toISOString();
  const id =
    args.clarification_id ?? `cl-${args.statement_id}-${randomUUID().slice(0, 8)}`;
  await store.upsertStatementClarification({
    workspace: args.workspace,
    org: args.org ?? null,
    clarification_id: id,
    statement_id: args.statement_id,
    question: args.question,
    answer: null,
    asked_by: args.actor.id,
    answered_by: null,
    created_at: ts,
    answered_at: null,
  });
  return id;
}

/** Answer a clarification — human answers may optionally confirm the
 *  bound statement in the same motion (`confirm: true`). */
export async function answerStatementClarification(
  store: Store,
  args: {
    workspace: string;
    clarification_id: string;
    answer: string;
    actor: StatementActor;
    /** Also confirm the bound statement (human only). */
    confirm?: boolean;
    now?: () => Date;
  },
): Promise<StatementRow | null> {
  const ts = (args.now?.() ?? new Date()).toISOString();
  return store.transaction(async (s) => {
    const rows = await s.listStatementClarifications({
      workspace: args.workspace,
    });
    const row = rows.find(
      (r) => r.clarification_id === args.clarification_id,
    );
    if (!row) {
      throw new StatementError(
        `answerStatementClarification: no clarification ${args.clarification_id} in ${args.workspace}`,
      );
    }
    await s.upsertStatementClarification({
      ...row,
      answer: args.answer,
      answered_by: args.actor.id,
      answered_at: ts,
    });
    if (args.confirm === true) {
      if (args.actor.type !== 'human') {
        throw new StatementError(
          'answerStatementClarification: confirm requires a human actor',
        );
      }
      const stmt = await head(s, args.workspace, row.statement_id);
      if (stmt.status === 'proposed' || stmt.status === 'disputed') {
        return writeStatus(
          s,
          stmt,
          'confirmed',
          {
            workspace: args.workspace,
            statement_id: stmt.statement_id,
            actor: args.actor,
            ...(args.now ? { now: args.now } : {}),
          },
          { provenance: 'stakeholder-verified' },
        );
      }
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

export interface DecideStatementArgs {
  workspace: string;
  decision_id: string;
  /** The human ruling (free text). */
  decision: string;
  rationale?: string | null;
  actor: StatementActor;
  /** Optional immediate effect on the bound statement — applied under
   *  the same transaction (all human-only statuses). */
  apply?: 'confirmed' | 'rejected' | 'superseded' | 'proposed';
  now?: () => Date;
}

/** Rule on a decision item — marks it `decided`, optionally applying
 *  the outcome to the bound statement in the same transaction. */
export async function decideStatementDecision(
  store: Store,
  args: DecideStatementArgs,
): Promise<StatementDecisionRow> {
  requireHuman(args.actor, 'decideStatementDecision');
  return store.transaction(async (s) => {
    const ts = (args.now?.() ?? new Date()).toISOString();
    const dec = await s.getStatementDecision({
      workspace: args.workspace,
      decision_id: args.decision_id,
    });
    if (!dec) {
      throw new StatementError(
        `decideStatementDecision: no decision ${args.decision_id} in ${args.workspace}`,
      );
    }
    if (dec.status !== 'open') {
      throw new StatementError(
        `decideStatementDecision: ${args.decision_id} is already ${dec.status}`,
      );
    }
    const decided: StatementDecisionRow = {
      ...dec,
      decision: args.decision,
      status: 'decided',
      rationale: args.rationale ?? dec.rationale,
      decided_by: args.actor.id,
      decided_at: ts,
    };
    await s.upsertStatementDecision(decided);

    if (args.apply !== undefined) {
      const stmt = await head(s, args.workspace, dec.statement_id);
      if (args.apply === 'confirmed') {
        if (stmt.status === 'proposed' || stmt.status === 'disputed') {
          await writeStatus(
            s,
            stmt,
            'confirmed',
            {
              workspace: args.workspace,
              statement_id: stmt.statement_id,
              actor: args.actor,
              ...(args.now ? { now: args.now } : {}),
            },
            { provenance: 'stakeholder-verified' },
          );
          await applySupersedes(
            s,
            { ...stmt, status: 'confirmed' },
            {
              workspace: args.workspace,
              statement_id: stmt.statement_id,
              actor: args.actor,
              ...(args.now ? { now: args.now } : {}),
            },
          );
        }
      } else {
        await writeStatus(s, stmt, args.apply, {
          workspace: args.workspace,
          statement_id: stmt.statement_id,
          actor: args.actor,
          ...(args.now ? { now: args.now } : {}),
        });
      }
    }
    return decided;
  });
}

/** Dismiss a decision item without acting on the statement. */
export async function dismissStatementDecision(
  store: Store,
  args: {
    workspace: string;
    decision_id: string;
    rationale?: string | null;
    actor: StatementActor;
    now?: () => Date;
  },
): Promise<void> {
  requireHuman(args.actor, 'dismissStatementDecision');
  const ts = (args.now?.() ?? new Date()).toISOString();
  const dec = await store.getStatementDecision({
    workspace: args.workspace,
    decision_id: args.decision_id,
  });
  if (!dec) {
    throw new StatementError(
      `dismissStatementDecision: no decision ${args.decision_id} in ${args.workspace}`,
    );
  }
  await store.upsertStatementDecision({
    ...dec,
    status: 'dismissed',
    rationale: args.rationale ?? dec.rationale,
    decided_by: args.actor.id,
    decided_at: ts,
  });
}

// ---------------------------------------------------------------------------
// artifact links
// ---------------------------------------------------------------------------

/** Link a statement to an artifact element — `artifact` is
 *  `subject:doc` or `doc:<subject>:<doc>:v<N>`; `element` e.g.
 *  `ac:AC-3` ('' = whole doc). Idempotent on the PK. */
export async function linkStatementArtifact(
  store: Store,
  args: {
    workspace: string;
    org?: string | null;
    statement_id: string;
    artifact: string;
    element?: string;
    actor: StatementActor;
    now?: () => Date;
  },
): Promise<void> {
  await head(store, args.workspace, args.statement_id);
  const ts = (args.now?.() ?? new Date()).toISOString();
  await store.upsertStatementArtifactLink({
    workspace: args.workspace,
    org: args.org ?? null,
    statement_id: args.statement_id,
    artifact: args.artifact,
    element: args.element ?? '',
    created_by: args.actor.id,
    created_at: ts,
  });
}

export async function unlinkStatementArtifact(
  store: Store,
  args: {
    workspace: string;
    statement_id: string;
    artifact: string;
    element?: string;
  },
): Promise<void> {
  await store.deleteStatementArtifactLink({
    workspace: args.workspace,
    statement_id: args.statement_id,
    artifact: args.artifact,
    element: args.element ?? '',
  });
}
