/**
 * changes/analysis.ts — the deterministic half of `analyzing`
 * (PRD §15.5, wp-140).
 *
 * "Affected-artifact analysis" is computed from what the store can
 * prove, never guessed:
 *   - the ChangeSet's own items + pinned baseline subject,
 *   - `relations` edges in BOTH directions (subject→object),
 *   - `semantic_statements` scoped to the same subjects (wp-143
 *     back-fills richer rows — the iface already exists),
 *   - release membership (`release_items` on open releases),
 *   - conflicting OPEN changesets on the same baseline/docs.
 *
 * The result is recorded verbatim on `changesets.analysis` — it is the
 * evidence the decider sees, not an opaque score.
 */
import type { Store } from '@veto/core';
import type { ChangesetItemRow, ChangesetRow } from '@veto/core';

/** Open = still capable of landing — terminal/side states excluded. */
export const OPEN_CHANGESET_STATUSES = new Set([
  'draft',
  'analyzing',
  'awaiting-decision',
  'approved',
  'applying',
  'apply-failed',
]);

export interface AffectedSubject {
  subject: string;
  /** How the artifact entered the blast radius. */
  via: 'item' | 'baseline' | 'relation' | 'statement';
  /** Relation predicate / statement id carrying the edge, when known. */
  evidence?: string;
}

export interface AffectedRelease {
  release_id: string;
  status: string;
  item_kind: string;
  item_id: string;
}

export interface ChangesetConflict {
  changeset_id: string;
  status: string;
  /** Which artifacts overlap — `baseline` or `item:<subject>[:doc]`. */
  overlap: string[];
}

export interface ChangesetAnalysis {
  computed_at: string;
  /** Artifact subjects the change touches (deduped, evidential). */
  affected_subjects: AffectedSubject[];
  /** Open releases whose items overlap affected subjects (wp-134). */
  affected_releases: AffectedRelease[];
  /** Ticket rows directly hit (spec_hash/baseline consumers, wp-141). */
  affected_tickets: string[];
  /** Owners of affected features/initiatives — notification fan-out. */
  owners: string[];
  /** Statements scoped to affected subjects (wp-143 evidence). */
  statements: string[];
  /** Conflicting open changesets (same baseline/docs) — serialized. */
  conflicts: ChangesetConflict[];
  /** Free-form extras merged from the caller (agent-produced evidence). */
  [extra: string]: unknown;
}

/** Does changeset `b` touch the same baseline/docs as `a`? */
export function baselineOverlap(a: ChangesetRow, b: ChangesetRow): boolean {
  const ba = a.baseline;
  const bb = b.baseline;
  if (ba && bb) {
    return (
      ba.subject === bb.subject && (!ba.doc || !bb.doc || ba.doc === bb.doc)
    );
  }
  return false;
}

/** (subject,doc) pairs a changeset applies to — items + baseline doc. */
export function itemFootprint(
  cs: ChangesetRow,
  items: ChangesetItemRow[],
): Set<string> {
  const set = new Set<string>();
  for (const i of items) set.add(`${i.subject}:${i.doc ?? ''}`);
  if (cs.baseline?.subject && cs.baseline.doc) {
    set.add(`${cs.baseline.subject}:${cs.baseline.doc}`);
  }
  return set;
}

/** Other OPEN changesets overlapping `cs`'s baseline or item docs. */
export async function detectConflicts(
  store: Store,
  cs: ChangesetRow,
  items?: ChangesetItemRow[],
): Promise<ChangesetConflict[]> {
  const footprint = itemFootprint(
    cs,
    items ??
      (await store.listChangesetItems({
        workspace: cs.workspace,
        changeset_id: cs.changeset_id,
      })),
  );
  const conflicts: ChangesetConflict[] = [];
  for (const other of await store.listChangesets({
    workspace: cs.workspace,
  })) {
    if (other.changeset_id === cs.changeset_id) continue;
    if (!OPEN_CHANGESET_STATUSES.has(other.status ?? '')) continue;
    const overlap: string[] = [];
    if (baselineOverlap(cs, other)) overlap.push('baseline');
    const otherItems = await store.listChangesetItems({
      workspace: other.workspace,
      changeset_id: other.changeset_id,
    });
    for (const pair of itemFootprint(other, otherItems)) {
      if (footprint.has(pair) && !overlap.includes(`item:${pair}`)) {
        overlap.push(`item:${pair}`);
      }
    }
    if (overlap.length > 0) {
      conflicts.push({
        changeset_id: other.changeset_id,
        status: other.status,
        overlap,
      });
    }
  }
  return conflicts;
}

/**
 * Compute the affected-artifact analysis. Pure reads — callers own the
 * row write. `extras` (e.g. agent-produced classification rationale)
 * merges last so caller evidence survives verbatim.
 */
export async function analyzeImpact(
  store: Store,
  cs: ChangesetRow,
  items: ChangesetItemRow[],
  computedAt: string,
  extras: Record<string, unknown> = {},
): Promise<ChangesetAnalysis> {
  const affected = new Map<string, AffectedSubject>();
  const add = (a: AffectedSubject) => {
    const prev = affected.get(a.subject);
    // First-listed provenance wins — 'item'/'baseline' outrank
    // 'relation'/'statement' (directly touched beats transitively hit).
    if (!prev) affected.set(a.subject, a);
  };
  for (const i of items) add({ subject: i.subject, via: 'item' });
  if (cs.baseline?.subject)
    add({ subject: cs.baseline.subject, via: 'baseline' });

  // relations: edges in both directions — a change to a subject affects
  // things it points at AND things that point at it.
  for (const s of [...affected.keys()]) {
    for (const r of await store.listRelations({ subject: s })) {
      if (!affected.has(r.object)) {
        add({ subject: r.object, via: 'relation', evidence: r.predicate });
      }
    }
    for (const r of await store.listRelations({ object: s })) {
      if (!affected.has(r.subject)) {
        add({ subject: r.subject, via: 'relation', evidence: r.predicate });
      }
    }
  }

  // Statements scoped to affected subjects (§15.3 ledger — wp-143
  // enriches; a proposed/confirmed statement still counts as evidence).
  const statements = new Set<string>();
  for (const s of [...affected.keys()]) {
    for (const st of await store.listStatements({
      workspace: cs.workspace,
      scope_ref: s,
    })) {
      statements.add(st.statement_id);
    }
  }
  // Free-text `subject` matches too (the ledger keeps topic text).
  for (const st of await store.listStatements({
    workspace: cs.workspace,
  })) {
    if (st.subject && affected.has(st.subject)) {
      statements.add(st.statement_id);
    }
  }

  // Release membership: which open releases contain affected
  // feature/ticket items (consequence surface for decision options).
  const affectedReleases: AffectedRelease[] = [];
  const subjects = new Set(affected.keys());
  for (const rel of await store.listReleases({
    workspace: cs.workspace,
  })) {
    if (!rel.status || !['draft', 'ready', 'approved'].includes(rel.status)) {
      continue;
    }
    for (const it of await store.listReleaseItems({
      workspace: cs.workspace,
      release_id: rel.release_id,
    })) {
      if (subjects.has(it.item_id)) {
        affectedReleases.push({
          release_id: rel.release_id,
          status: rel.status,
          item_kind: it.item_kind,
          item_id: it.item_id,
        });
      }
    }
  }

  // Tickets directly hit: item subjects that are ticket rows, plus
  // member tickets of affected features (feature.md changes land on
  // member spec packages).
  const tickets = new Set<string>();
  const allTickets = await store.listTickets({ workspace: cs.workspace });
  const ticketIds = new Set(allTickets.map((t) => t.ticket_id));
  const featureIds = new Set(
    (await store.listFeatures({ workspace: cs.workspace })).map(
      (f) => f.feature,
    ),
  );
  for (const s of subjects) {
    if (ticketIds.has(s)) tickets.add(s);
    if (featureIds.has(s)) {
      for (const t of allTickets.filter((t) => t.feature === s)) {
        tickets.add(t.ticket_id);
      }
    }
  }

  // Owner fan-out: features + initiatives carry `owner` (D33/D43).
  const owners = new Set<string>();
  for (const f of await store.listFeatures({ workspace: cs.workspace })) {
    if (subjects.has(f.feature) && f.owner) owners.add(f.owner);
    // member ticket hit → feature owner is accountable too
    if (
      f.owner &&
      allTickets.some(
        (t) => t.feature === f.feature && subjects.has(t.ticket_id),
      )
    ) {
      owners.add(f.owner);
    }
  }
  for (const i of await store.listInitiatives({
    workspace: cs.workspace,
  })) {
    if (subjects.has(i.initiative) && i.owner) owners.add(i.owner);
  }

  const conflicts = await detectConflicts(store, cs, items);

  return {
    computed_at: computedAt,
    affected_subjects: [...affected.values()],
    affected_releases: affectedReleases,
    affected_tickets: [...tickets].sort(),
    owners: [...owners].sort(),
    statements: [...statements].sort(),
    conflicts,
    ...extras,
  };
}
