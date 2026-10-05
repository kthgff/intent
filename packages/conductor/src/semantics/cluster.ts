/**
 * Import-item clustering (wp-139, PRD §15.3). Imported items are
 * clustered by three independent signals so duplicates / conflicts
 * surface on the import board instead of being auto-merged:
 *
 *   1. **metadata** — token Jaccard over normalized titles (+ a small
 *      body/repo overlap contribution).
 *   2. **explicit relations** — `depends_on` / `parent` edges the
 *      tracker or triage already declared (never guessed).
 *   3. **embeddings** — cosine similarity when vectors are present
 *      (`Store.getEmbedding`, object_ref `ticket:<ws>:<id>`).
 *
 * "Vector similarity retrieves; the structured model decides authority"
 * (§15.3) — clustering only proposes groups; the human resolves them.
 * Pure functions, no I/O, so the reconciliation layer stays testable.
 */

/** One item fed to the clusterer. */
export interface ClusterItem {
  id: string;
  title: string;
  body?: string | null;
  repos?: string[];
  /** Explicit related item ids (parent/depends_on) — undirected. */
  relations?: string[];
  /** Optional embedding vector (same model across items). */
  embedding?: number[] | null;
}

export interface Cluster {
  /** Deterministic id — sorted member ids joined. */
  id: string;
  /** Member ids, sorted. */
  members: string[];
  /** Strongest signal that joined the cluster. */
  reason: 'metadata' | 'relation' | 'embedding' | 'mixed';
  /** Max pairwise similarity inside the cluster (0 for relation-only). */
  similarity: number;
  /** True when two members look like the same work (>= dupThreshold). */
  duplicate: boolean;
}

export interface ClusterOptions {
  /** Pairwise similarity override (defaults to {@link defaultSimilarity}). */
  similarity?: (a: ClusterItem, b: ClusterItem) => number;
  /** Edge threshold — pairs at/above join a cluster (default 0.6). */
  threshold?: number;
  /** Duplicate threshold — pairs at/above are flagged duplicates (0.85). */
  dupThreshold?: number;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'for',
  'and',
  'or',
  'is',
  'are',
  'be',
  'with',
  'when',
  'not',
  'it',
  'this',
  'that',
  'as',
  'at',
  'by',
  'from',
  'into',
  'we',
  'should',
]);

/** Normalize a title/body into comparable tokens (lowercased, deduped,
 *  stopword-free, length > 1). */
export function tokenize(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 1 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Cosine similarity of two equal-length vectors (0 when degenerate). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Default similarity: title token Jaccard dominates; body overlap and a
 * shared-repo bonus nudge near-ties. Explicit relations are handled
 * separately (they are edges, not a score).
 */
export function defaultSimilarity(a: ClusterItem, b: ClusterItem): number {
  const title = jaccard(tokenize(a.title), tokenize(b.title));
  const hasBody =
    (a.body?.trim().length ?? 0) > 0 || (b.body?.trim().length ?? 0) > 0;
  let score = title;
  if (hasBody) {
    const body = jaccard(tokenize(a.body), tokenize(b.body));
    score = title * 0.8 + body * 0.2;
  }
  const ra = new Set(a.repos ?? []);
  if (ra.size > 0 && (b.repos ?? []).some((r) => ra.has(r))) {
    score = Math.min(1, score + 0.05);
  }
  return score;
}

interface Edge {
  reason: Cluster['reason'];
  score: number;
}

/**
 * Cluster items into connected components. Edges come from explicit
 * relations (always) and from pairwise similarity (>= threshold).
 */
export function clusterItems(
  items: ClusterItem[],
  opts: ClusterOptions = {},
): Cluster[] {
  const threshold = opts.threshold ?? 0.6;
  const dupThreshold = opts.dupThreshold ?? 0.85;
  const sim = opts.similarity ?? defaultSimilarity;
  const byId = new Map(items.map((i) => [i.id, i]));
  const parent = new Map<string, string>();
  for (const i of items) parent.set(i.id, i.id);

  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    // path compression
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c) as string;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (x: string, y: string) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  // score[findRoot] aggregates the strongest signal per pair; kept in a
  // map keyed by the sorted pair for determinism.
  const pairEdges = new Map<string, Edge>();

  // 1. explicit relations (undirected).
  for (const item of items) {
    for (const rel of item.relations ?? []) {
      if (!byId.has(rel) || rel === item.id) continue;
      union(item.id, rel);
      const key = [item.id, rel].sort().join('\u0000');
      if (!pairEdges.has(key))
        pairEdges.set(key, { reason: 'relation', score: 0 });
    }
  }

  // 2. similarity edges.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i] as ClusterItem;
      const b = items[j] as ClusterItem;
      const meta = sim(a, b);
      const emb =
        a.embedding && b.embedding ? cosine(a.embedding, b.embedding) : 0;
      const score = Math.max(meta, emb);
      if (score < threshold) continue;
      union(a.id, b.id);
      const key = [a.id, b.id].sort().join('\u0000');
      const reason: Cluster['reason'] =
        emb >= threshold && meta >= threshold
          ? 'mixed'
          : emb >= threshold
            ? 'embedding'
            : 'metadata';
      const prev = pairEdges.get(key);
      if (!prev || prev.score < score) {
        pairEdges.set(key, { reason, score });
      } else if (prev.reason !== reason) {
        pairEdges.set(key, { reason: 'mixed', score: prev.score });
      }
    }
  }

  // group by root.
  const groups = new Map<string, ClusterItem[]>();
  for (const item of items) {
    const root = find(item.id);
    const arr = groups.get(root);
    if (arr) arr.push(item);
    else groups.set(root, [item]);
  }

  const clusters: Cluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ids = members.map((m) => m.id).sort();
    let similarity = 0;
    const reasons = new Set<Cluster['reason']>();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = [ids[i] as string, ids[j] as string].join('\u0000');
        const edge = pairEdges.get(key);
        if (!edge) continue;
        reasons.add(edge.reason);
        if (edge.score > similarity) similarity = edge.score;
      }
    }
    const reason: Cluster['reason'] =
      reasons.size > 1 ? 'mixed' : ([...reasons][0] ?? 'metadata');
    clusters.push({
      id: ids.join('+'),
      members: ids,
      reason,
      similarity,
      duplicate: similarity >= dupThreshold,
    });
  }
  return clusters.sort((a, b) => a.id.localeCompare(b.id));
}
