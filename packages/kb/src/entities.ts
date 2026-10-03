/**
 * Entities + relations (SCHEMAS §12) — ontology-lite typed-edge rows.
 * Upsert helpers with alias merge: when an incoming entity resolves to
 * an existing row (same canonical name or an overlapping alias within
 * the same product), it merges INTO that row rather than forking a
 * duplicate — the canonical spine stays canonical.
 *
 * Merge precedence on `source`: a human-confirmed entity is never
 * demoted by an agent `inferred` re-survey (same ethic as dossier
 * edited_by-wins).
 */
import type {
  Entity,
  EntitySource,
  Relation,
  Store,
} from '@sprint-runner/core';

export const norm = (s: string): string => s.trim().toLowerCase();

const SOURCE_RANK: Record<string, number> = {
  inferred: 0,
  imported: 1,
  confirmed: 2,
};

/** Stable entity id from product + canonical name. */
export function entityId(product: string, canonical: string): string {
  const slug = norm(canonical)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${product}:${slug}`;
}

/**
 * Find an existing entity this input merges into: same canonical name,
 * or any overlapping alias/name, within the same product.
 */
export async function findEntityMatch(
  store: Store,
  product: string,
  e: Pick<Entity, 'name' | 'canonical'> & { aliases?: string[] },
): Promise<Entity | null> {
  const terms = new Set(
    [e.name, e.canonical, ...(e.aliases ?? [])].map(norm).filter(Boolean),
  );
  const byId = await store.getEntity(entityId(product, e.canonical));
  if (byId) return byId;
  for (const existing of await store.listEntities({ product })) {
    const hay = new Set(
      [existing.name, existing.canonical, ...existing.aliases]
        .map(norm)
        .filter(Boolean),
    );
    for (const t of terms) if (hay.has(t)) return existing;
  }
  return null;
}

/**
 * Upsert an entity with alias merge. Returns the winning row's id —
 * either a fresh id or the pre-existing entity it merged into. A
 * `confirmed` existing row keeps its `source`; otherwise the higher-
 * rank source wins.
 */
export async function upsertEntity(store: Store, e: Entity): Promise<string> {
  const match = await findEntityMatch(store, e.product, e);
  if (!match) {
    const id = e.id || entityId(e.product, e.canonical);
    await store.upsertEntity({ ...e, id });
    return id;
  }
  const merged: Entity = {
    ...match,
    name: match.name,
    aliases: [
      ...new Set(
        [...match.aliases, ...e.aliases, e.name, e.canonical]
          .map((a) => a.trim())
          .filter((a) => a && norm(a) !== norm(match.name)),
      ),
    ],
    source:
      (SOURCE_RANK[e.source] ?? 0) > (SOURCE_RANK[match.source] ?? 0)
        ? e.source
        : match.source,
    evidence: e.evidence ?? match.evidence,
  };
  await store.upsertEntity(merged);
  return match.id;
}

/**
 * Alias merge: fold `from` entity into `to` — union aliases, keep the
 * higher-rank source, re-point relations, delete `from`.
 */
export async function mergeEntityAlias(
  store: Store,
  fromId: string,
  toId: string,
): Promise<void> {
  if (fromId === toId) return;
  const from = await store.getEntity(fromId);
  const to = await store.getEntity(toId);
  if (!from || !to) return;
  await store.upsertEntity({
    ...to,
    aliases: [
      ...new Set(
        [...to.aliases, ...from.aliases, from.name, from.canonical].filter(
          (a) => norm(a) !== norm(to.name),
        ),
      ),
    ],
    source:
      (SOURCE_RANK[from.source] ?? 0) > (SOURCE_RANK[to.source] ?? 0)
        ? from.source
        : to.source,
  });
  // Re-point edges that referenced the merged-away entity.
  const edges: Relation[] = [
    ...(await store.listRelations({ subject: fromId })),
    ...(await store.listRelations({ object: fromId })),
  ];
  for (const r of edges) {
    const moved: Relation = {
      ...r,
      subject: r.subject === fromId ? toId : r.subject,
      object: r.object === fromId ? toId : r.object,
    };
    if (moved.subject !== moved.object) await store.upsertRelation(moved);
    await store.deleteRelation(r);
  }
  // synonym-of records the merge for later inspection.
  await store.upsertRelation({
    subject: from.canonical,
    predicate: 'synonym-of',
    object: to.canonical,
    source: 'alias-merge',
  });
  await store.deleteEntity(fromId);
}
