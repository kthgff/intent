/**
 * Authority-rule resolution (wp-143, PRD §15.3 + INTELLIGENCE §5):
 * "vector similarity retrieves; the structured model decides
 * authority" — an approved `prohibits` beats a brainstormed `want`
 * every time.
 *
 * Pure functions over statement rows + typed relations. Resolution is
 * a lexicographic order on (status, provenance, intent, strength):
 * human-confirmed truth outranks AI proposals, binding intents
 * (prohibits/requires/constraint) outrank preferences (want/avoid).
 * Ties between live contradicting statements are FAIL-CLOSED —
 * reported `unresolved`, never settled by a coin flip; the caller
 * surfaces a statement_decisions item.
 */
import type {
  ProvenanceState,
  StatementIntent,
  StatementRelation,
  StatementRelationRow,
  StatementRow,
  StatementStatus,
  StatementStrength,
  Store,
} from '@veto/core';

// ---------------------------------------------------------------------------
// Authority ranks (higher = more authoritative)
// ---------------------------------------------------------------------------

/** Status axis — the human-confirmation axis. `confirmed` is the only
 *  rank a human can produce; `superseded`/`rejected` are dead. */
export const STATUS_AUTHORITY: Record<StatementStatus, number> = {
  confirmed: 4,
  proposed: 3,
  disputed: 2,
  superseded: 1,
  rejected: 0,
};

/** Provenance axis — `stakeholder-verified` > `source-backed` >
 *  `inferred` > absent. `inferred` never beats real evidence. */
export const PROVENANCE_AUTHORITY: Record<ProvenanceState, number> = {
  'stakeholder-verified': 3,
  'source-backed': 2,
  inferred: 1,
};

/** Intent axis — binding intents outrank preferences, which outrank
 *  informational ones. `prohibits` sits at the top: "an approved
 *  prohibition beats a brainstormed preference" (§15.3). */
export const INTENT_AUTHORITY: Record<StatementIntent, number> = {
  prohibits: 6,
  requires: 5,
  constraint: 4,
  decision: 3,
  want: 2,
  avoid: 2,
  problem: 1,
  assumption: 1,
  observation: 1,
  question: 0,
};

/** Strength axis — `must` > `should` > `nice` > `undecided`. */
export const STRENGTH_AUTHORITY: Record<StatementStrength, number> = {
  must: 3,
  should: 2,
  nice: 1,
  undecided: 0,
};

/** The authority tuple — lexicographic: status → provenance → intent →
 *  strength. Absent dimensions score 0 (never charitable defaults).
 *  Note: wp-131 row fields widen to `string` (enumOf) — rank lookups
 *  index through `Record<string, number>` and score unknowns 0. */
export function authorityKey(
  s: Pick<StatementRow, 'status' | 'provenance' | 'intent' | 'strength'>,
): readonly [number, number, number, number] {
  const status = STATUS_AUTHORITY as Record<string, number>;
  const prov = PROVENANCE_AUTHORITY as Record<string, number>;
  const intent = INTENT_AUTHORITY as Record<string, number>;
  const strength = STRENGTH_AUTHORITY as Record<string, number>;
  return [
    status[s.status] ?? 0,
    s.provenance ? (prov[s.provenance] ?? 0) : 0,
    s.intent ? (intent[s.intent] ?? 0) : 0,
    s.strength ? (strength[s.strength] ?? 0) : 0,
  ];
}

/** Lexicographic authority comparison: >0 when `a` outranks `b`,
 *  <0 when outranked, 0 on a true tie (fail-closed — callers treat 0
 *  as unresolved, never pick arbitrarily). */
export function compareAuthority(
  a: Pick<StatementRow, 'status' | 'provenance' | 'intent' | 'strength'>,
  b: Pick<StatementRow, 'status' | 'provenance' | 'intent' | 'strength'>,
): number {
  const ka = authorityKey(a);
  const kb = authorityKey(b);
  for (let i = 0; i < 4; i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A statement is *live* — still a candidate for governing — while it
 *  hasn't been rejected or superseded. `disputed` stays live: a
 *  contested truth still governs until the decision lands. */
export function isLive(s: Pick<StatementRow, 'status'>): boolean {
  return (
    s.status === 'confirmed' ||
    s.status === 'proposed' ||
    s.status === 'disputed'
  );
}

// ---------------------------------------------------------------------------
// Conflict verdicts
// ---------------------------------------------------------------------------

export type ConflictOutcome =
  | 'src' // the edge's source wins
  | 'dst' // the edge's target wins
  | 'unresolved' // authority tie or unratified supersession — FAIL-CLOSED
  | 'moot'; // at least one endpoint already dead

/** The predicates that decide authority (§15.3). `supports`/`clarifies`/
 *  `depends-on`/`derived-from` carry no winner. */
export const AUTHORITY_PREDICATES: ReadonlySet<string> = new Set([
  'contradicts',
  'supersedes',
  'duplicates',
]);

export interface ConflictVerdict {
  src: string;
  predicate: StatementRelation;
  dst: string;
  outcome: ConflictOutcome;
  /** Human-readable rule that produced the verdict. */
  rule: string;
}

/**
 * Resolve one edge's authority question.
 *
 * - `supersedes`: a *confirmed* superseding statement defeats its
 *   target; an unconfirmed one can never silently retire a confirmed
 *   target → `unresolved` when the target is confirmed, `src` when the
 *   target is itself unconfirmed (both are drafts — the newer claim is
 *   provisional authority pending confirmation).
 * - `contradicts`/`duplicates`: pure `compareAuthority`; a tie is
 *   `unresolved` (fail-closed → decision item, never a silent merge).
 * - Dead endpoints make the question moot.
 */
export function resolveEdge(
  rel: Pick<StatementRelationRow, 'src' | 'predicate' | 'dst'>,
  byId: Map<string, StatementRow>,
): ConflictVerdict {
  const pred = rel.predicate as StatementRelation;
  const src = byId.get(rel.src);
  const dst = byId.get(rel.dst);
  if (!src || !dst) {
    return {
      src: rel.src,
      predicate: pred,
      dst: rel.dst,
      outcome: 'moot',
      rule: 'endpoint not in the statement set',
    };
  }
  if (!isLive(src) || !isLive(dst)) {
    return {
      src: rel.src,
      predicate: pred,
      dst: rel.dst,
      outcome: 'moot',
      rule: 'endpoint already superseded/rejected',
    };
  }

  if (rel.predicate === 'supersedes') {
    if (src.status === 'confirmed') {
      return {
        src: rel.src,
        predicate: pred,
        dst: rel.dst,
        outcome: 'src',
        rule: 'confirmed supersedes — human ratified the replacement',
      };
    }
    if (dst.status === 'confirmed') {
      return {
        src: rel.src,
        predicate: pred,
        dst: rel.dst,
        outcome: 'unresolved',
        rule: 'unconfirmed statement cannot supersede a confirmed one',
      };
    }
    return {
      src: rel.src,
      predicate: pred,
      dst: rel.dst,
      outcome: 'src',
      rule: 'superseding draft outranks the draft it replaces',
    };
  }

  const cmp = compareAuthority(src, dst);
  if (cmp > 0) {
    return {
      src: rel.src,
      predicate: pred,
      dst: rel.dst,
      outcome: 'src',
      rule: 'higher authority (status → provenance → intent → strength)',
    };
  }
  if (cmp < 0) {
    return {
      src: rel.src,
      predicate: pred,
      dst: rel.dst,
      outcome: 'dst',
      rule: 'higher authority (status → provenance → intent → strength)',
    };
  }
  return {
    src: rel.src,
    predicate: pred,
    dst: rel.dst,
    outcome: 'unresolved',
    rule: 'authority tie — fail-closed, needs a decision item',
  };
}

export interface AuthorityReport {
  /** Live statements that lost no verdict — the governing set, sorted
   *  by authority (statement_id breaks exact ties deterministically). */
  governing: StatementRow[];
  /** Statements knocked out — by dead status or a resolved verdict. */
  defeated: { statement_id: string; reason: string }[];
  /** Resolved verdicts (every authority edge examined). */
  verdicts: ConflictVerdict[];
  /** Fail-closed residue — unresolved conflicts needing
   *  statement_decisions items (never silently merged). */
  unresolved: ConflictVerdict[];
}

/**
 * The authority rule over a statement set + its typed edges. Edges
 * that touch statements outside `statements` are ignored (callers pass
 * the full scope they're resolving).
 */
export function resolveAuthority(
  statements: StatementRow[],
  relations: StatementRelationRow[],
): AuthorityReport {
  const byId = new Map(statements.map((s) => [s.statement_id, s]));
  const verdicts: ConflictVerdict[] = [];
  const defeated = new Map<string, string>();

  for (const s of statements) {
    if (!isLive(s)) {
      defeated.set(s.statement_id, `status ${s.status}`);
    }
  }
  for (const rel of relations) {
    if (!AUTHORITY_PREDICATES.has(rel.predicate)) continue;
    const verdict = resolveEdge(rel, byId);
    verdicts.push(verdict);
    if (verdict.outcome === 'src') {
      defeated.set(
        verdict.dst,
        `${verdict.predicate} by ${verdict.src} (${verdict.rule})`,
      );
    } else if (verdict.outcome === 'dst') {
      defeated.set(
        verdict.src,
        `${verdict.predicate} by ${verdict.dst} (${verdict.rule})`,
      );
    }
    // 'unresolved' defeats nobody — fail-closed keeps both live.
  }

  const governing = statements
    .filter((s) => !defeated.has(s.statement_id))
    .sort((a, b) => {
      const d = compareAuthority(b, a); // descending
      return d !== 0 ? d : a.statement_id.localeCompare(b.statement_id);
    });

  return {
    governing,
    defeated: [...defeated.entries()].map(([statement_id, reason]) => ({
      statement_id,
      reason,
    })),
    verdicts,
    unresolved: verdicts.filter((v) => v.outcome === 'unresolved'),
  };
}

// ---------------------------------------------------------------------------
// Store-backed helpers
// ---------------------------------------------------------------------------

/** Statements + their typed edges for a scope — the set the authority
 *  rule resolves over. Relations are fetched per statement (the schema
 *  has no bulk list), deduped by (src, predicate, dst). */
export async function loadStatementGraph(
  store: Store,
  args: {
    workspace: string;
    scope?: string;
    scope_ref?: string;
  },
): Promise<{ statements: StatementRow[]; relations: StatementRelationRow[] }> {
  const statements = await store.listStatements({
    workspace: args.workspace,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.scope_ref !== undefined ? { scope_ref: args.scope_ref } : {}),
  });
  const seen = new Set<string>();
  const relations: StatementRelationRow[] = [];
  for (const s of statements) {
    for (const rel of await store.listStatementRelations({
      workspace: args.workspace,
      src: s.statement_id,
    })) {
      const key = `${rel.src}${rel.predicate}${rel.dst}`;
      if (!seen.has(key)) {
        seen.add(key);
        relations.push(rel);
      }
    }
  }
  return { statements, relations };
}

/** Authority rule over a scope (or the whole workspace) — retrieval
 *  found the candidates; the structured model decides. */
export async function resolveScopeAuthority(
  store: Store,
  args: { workspace: string; scope?: string; scope_ref?: string },
): Promise<AuthorityReport> {
  const { statements, relations } = await loadStatementGraph(store, args);
  return resolveAuthority(statements, relations);
}

/**
 * Fail-closed residue → decision items: every unresolved verdict opens
 * a `statement_decisions` row (idempotent on the deterministic id).
 * Returns the decision ids now open.
 */
export async function openConflictDecisions(
  store: Store,
  args: {
    workspace: string;
    org?: string | null;
    report: AuthorityReport;
    actor: string;
    now?: () => Date;
  },
): Promise<string[]> {
  const ts = (args.now?.() ?? new Date()).toISOString();
  const opened: string[] = [];
  for (const v of args.report.unresolved) {
    const decisionId = `sd-${v.dst}-conflict-${v.src}`;
    const existing = await store.getStatementDecision({
      workspace: args.workspace,
      decision_id: decisionId,
    });
    if (existing && existing.status !== 'open') continue;
    if (!existing) {
      await store.upsertStatementDecision({
        workspace: args.workspace,
        org: args.org ?? null,
        decision_id: decisionId,
        statement_id: v.dst,
        decision: null,
        status: 'open',
        rationale: `unresolved ${v.predicate} with ${v.src} — ${v.rule} (authority tie; never a silent merge, §15.9)`,
        decided_by: null,
        decided_at: null,
        created_by: args.actor,
        created_at: ts,
      });
    }
    opened.push(decisionId);
  }
  return opened;
}
