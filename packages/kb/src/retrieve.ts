/**
 * Permission-filtered hybrid retrieval → `retrieval-evidence.json`
 * (INTELLIGENCE §4.2, SCHEMAS §17, D37, wp-110).
 *
 * Authorization is applied BEFORE any strategy runs and again on every
 * candidate row (defense in depth): the caller supplies the authorized
 * repo list, the request's `repos` are intersected with it, and only
 * resolved `current` (or explicitly `allow-stale`) index heads are
 * queried. A candidate whose (workspace, repo, commit_sha) is outside
 * the authorized head set is dropped, never leaked.
 *
 * Strategies merged into ONE bounded result set:
 * - `explicit`  — verified workflow links (`code_edges` whose subject
 *   is the request subject);
 * - `exact`     — identifier/path match on `code_units`;
 * - `fts`       — Postgres full-text search, `ts_rank` normalized;
 * - `semantic`  — content-addressed embeddings mapped back through
 *   `findCodeUnitsByHash` (skipped cleanly when the embedder is
 *   `off`/null — `semantic.embeddings: off` never errors);
 * - `structural`— depth-1 neighbor expansion over `code_edges`
 *   (imports / tested-by / references).
 *
 * Per-strategy contributions are recorded on each result (`scores.*`,
 * `why`) so the rerank is explainable. `final` is a probabilistic OR:
 * `1 - Π(1 - s_i)` — bounded in [0,1] and rewarding corroboration.
 *
 * Fail-closed: the emitted bundle is validated against
 * `RetrievalEvidenceSchema` before returning — malformed or uncited
 * code results throw `EvidenceError` rather than ship. Zero results is
 * a valid explicit outcome (`zero_result_reason` set), never an error.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  type CodeUnitRow,
  type EvidenceFreshness,
  type RetrievalEvidence,
  type RetrievalEvidenceResult,
  type RetrievalRequest,
  RetrievalRequestSchema,
  type RetrievalScores,
  type Store,
  validateRetrievalEvidence,
} from '@veto/core';
import { resolveCodeHeads } from './code-index.js';
import type { Embedder } from './embeddings.js';

/** Retrieval engine identity stamped in `why` strings. */
export const RETRIEVAL_ENGINE_VERSION = 'wp-110/1';

/** Per-strategy candidate cap (bounded work per query). */
export const STRATEGY_CANDIDATE_CAP = 200;
/** Depth-1 structural expansion cap — neighbors per query. */
export const STRUCTURAL_NEIGHBOR_CAP = 100;
/** Per-result excerpt bound (chars); the bundle's `token_limit`
 *  additionally caps the total. */
export const EXCERPT_MAX_CHARS = 1600;
/** Rough chars-per-token for the `token_limit` budget. */
export const CHARS_PER_TOKEN = 4;

/** Flat structural-neighbor contribution score. */
export const STRUCTURAL_SCORE = 0.5;

const CODECONTENT_PREFIX = 'codecontent:';

const SOURCE_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.java',
  '.kt',
  '.kts',
  '.cs',
  '.php',
  '.swift',
  '.scala',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.sh',
  '.sql',
];

const IDENT_TOKEN = /^[A-Za-z_$][\w$]*$/;
const PATH_TOKEN =
  /[/.]|\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|kts|cs|php|swift|scala|c|h|cc|cpp|hpp|sh|sql|md|json|ya?ml|toml|sql)$/i;

export interface QueryEvidenceOptions {
  /**
   * The repos this caller is AUTHORIZED to read (INTELLIGENCE §2.4 —
   * permission filtering precedes retrieval). Intersected with
   * `request.repos` before any strategy runs; `[]` serves nothing.
   */
  authorizedRepos: string[];
  /**
   * Live embedder for the semantic strategy. `null`, `undefined`, or an
   * `off`-mode embedder (`dims === 0`, `embed()` → null) degrades
   * cleanly to exact/FTS/explicit/structural — never an error.
   */
  embedder?: Embedder | null;
  /** Per-strategy candidate cap override (bounded). */
  strategyLimit?: number;
  now?: () => string;
}

/** Stable `object_ref` for a code unit (SCHEMAS §17 example shape). */
export function evidenceObjectRef(u: CodeUnitRow): string {
  const tail = u.symbol ?? `L${u.start_line}-${u.end_line}`;
  return `code:${u.repo}:${u.commit_sha}:${u.path}:${tail}`;
}

/** Deterministic evidence id — one per cited object. */
export function evidenceId(objectRef: string): string {
  return `ev_${createHash('sha256').update(objectRef).digest('hex').slice(0, 20)}`;
}

/**
 * Pull identifier-ish and path-ish tokens out of a query for the
 * `exact` strategy. Words with no identifier/path shape are ignored —
 * they only serve FTS.
 */
export function extractQueryIdentifiers(query: string): {
  symbols: string[];
  paths: string[];
} {
  const symbols = new Set<string>();
  const paths = new Set<string>();
  for (const raw of query.split(/[^A-Za-z0-9_$/.\-]+/)) {
    let tok = raw;
    if (tok.length === 0) continue;
    // `path/file.ts:18` → `path/file.ts`
    const colon = tok.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(tok.slice(colon + 1))) {
      tok = tok.slice(0, colon);
    }
    tok = tok.replace(/^\.?\//, '').replace(/[.,;]+$/, '');
    if (tok.length === 0) continue;
    if (PATH_TOKEN.test(tok)) {
      paths.add(tok);
      // A bare filename may also be a path tail — kept for the
      // store's exact `path IN` match only; callers pass the full
      // repo-relative form.
    } else if (IDENT_TOKEN.test(tok) && tok.length >= 2) {
      symbols.add(tok);
    }
  }
  return { symbols: [...symbols], paths: [...paths] };
}

/**
 * Resolve a `module:` spec to repo-relative path candidates. Relative
 * specs resolve against the importing file's dir; bare specs with a
 * path separator are tried verbatim + with source extensions.
 * Unresolvable specs (package names like `react`) return [].
 */
export function resolveModuleSpec(spec: string, fromDir: string): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (p.length === 0 || out.includes(p)) return;
    out.push(p);
    if (!SOURCE_EXTS.some((e) => p.endsWith(e))) {
      for (const e of SOURCE_EXTS) out.push(`${p}${e}`);
      for (const e of SOURCE_EXTS) out.push(`${p}/index${e}`);
    }
  };
  if (spec.startsWith('.')) {
    const norm = posix.normalize(posix.join(fromDir, spec));
    if (!norm.startsWith('..') && norm !== '..') push(norm);
  } else if (spec.includes('/')) {
    push(spec.replace(/^\/+/, ''));
  } else if (spec.includes('.')) {
    // Dotted module form (`app.prefs`) → path guess.
    push(spec.replace(/\./g, '/'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate accumulation
// ---------------------------------------------------------------------------

interface Candidate {
  unit: CodeUnitRow;
  freshness: EvidenceFreshness;
  scores: Partial<
    Pick<
      RetrievalScores,
      'explicit' | 'exact' | 'fts' | 'semantic' | 'structural'
    >
  >;
  why: Set<string>;
  relationPath?: string[];
}

function clip01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function addCandidate(
  map: Map<string, Candidate>,
  unit: CodeUnitRow,
  freshness: EvidenceFreshness,
  strategy: keyof Candidate['scores'],
  score: number,
  why: string,
  relationPath?: string[],
): void {
  const c = map.get(unit.id) ?? {
    unit,
    freshness,
    scores: {},
    why: new Set<string>(),
  };
  c.scores[strategy] = Math.max(c.scores[strategy] ?? 0, clip01(score));
  c.why.add(why);
  if (relationPath && !c.relationPath) c.relationPath = relationPath;
  map.set(unit.id, c);
}

/** Resolve an edge ref (`unit:`/`file:`/`symbol:`/`module:`) to units,
 *  scoped to the authorized head set. `fromDir` anchors `module:` specs. */
async function resolveRefUnits(
  store: Store,
  req: RetrievalRequest,
  heads: { repo: string; commit_sha: string }[],
  headKey: Set<string>,
  ref: string,
  fromDir: string,
  limit: number,
): Promise<CodeUnitRow[]> {
  const guard = (rows: CodeUnitRow[]): CodeUnitRow[] =>
    rows.filter(
      (u) =>
        u.workspace === req.workspace &&
        headKey.has(`${u.repo}@${u.commit_sha}`),
    );
  if (ref.startsWith('unit:')) {
    const u = await store.getCodeUnit(ref.slice('unit:'.length));
    return u ? guard([u]) : [];
  }
  if (ref.startsWith('file:')) {
    return guard(
      await store.findCodeUnitsExact({
        workspace: req.workspace,
        heads,
        paths: [ref.slice('file:'.length)],
        limit,
      }),
    );
  }
  if (ref.startsWith('symbol:')) {
    const rest = ref.slice('symbol:'.length);
    const idx = rest.lastIndexOf(':');
    if (idx <= 0) return [];
    const path = rest.slice(0, idx);
    const name = rest.slice(idx + 1);
    const rows = guard(
      await store.findCodeUnitsExact({
        workspace: req.workspace,
        heads,
        paths: [path],
        limit,
      }),
    );
    const named = rows.filter((u) => u.symbol === name);
    return named.length > 0 ? named : rows;
  }
  if (ref.startsWith('module:')) {
    const paths = resolveModuleSpec(ref.slice('module:'.length), fromDir);
    if (paths.length === 0) return [];
    return guard(
      await store.findCodeUnitsExact({
        workspace: req.workspace,
        heads,
        paths,
        limit,
      }),
    );
  }
  return [];
}

/**
 * Run one retrieval request and return the validated
 * `retrieval-evidence.json` bundle (SCHEMAS §17). See the file header
 * for the strategy list and the fail-closed contract.
 */
export async function queryEvidence(
  store: Store,
  request: RetrievalRequest,
  opts: QueryEvidenceOptions,
): Promise<RetrievalEvidence> {
  const nowIso = opts.now ?? (() => new Date().toISOString());
  const req = RetrievalRequestSchema.parse(request);
  const strategyLimit = Math.max(
    1,
    opts.strategyLimit ?? STRATEGY_CANDIDATE_CAP,
  );

  const zeroBundle = (
    reason: string,
    indexHeads: RetrievalEvidence['index_heads'],
  ): RetrievalEvidence =>
    validateRetrievalEvidence({
      schema: 1,
      request: req,
      index_heads: indexHeads,
      results: [],
      zero_result_reason: reason,
      generated_at: nowIso(),
    });

  // --- ACL before any strategy (INTELLIGENCE §2.4) ---
  const authorized = new Set(opts.authorizedRepos);
  const repos =
    req.repos.length > 0
      ? req.repos.filter((r) => authorized.has(r))
      : [...authorized];
  if (repos.length === 0) {
    return zeroBundle('no authorized repositories for this request', []);
  }
  if (!req.source_types.includes('code')) {
    return zeroBundle(
      'requested source types are not served by the code index',
      [],
    );
  }

  // --- Authorized commit heads only ---
  const resolved = await resolveCodeHeads(store, {
    workspace: req.workspace,
    repos,
    commitPolicy: req.commit_policy as 'current' | 'allow-stale',
  });
  const indexHeads = resolved.map((h) => ({
    repo: h.repo,
    commit_sha: h.commit_sha,
  }));
  if (resolved.length === 0) {
    return zeroBundle(
      `no ${req.commit_policy === 'current' ? 'current' : 'eligible'} index head for the authorized repositories`,
      [],
    );
  }
  const headKey = new Set(resolved.map((h) => `${h.repo}@${h.commit_sha}`));
  const freshnessOf = new Map<string, EvidenceFreshness>(
    resolved.map((h) => [h.repo, h.freshness]),
  );
  const heads = resolved.map((h) => ({
    repo: h.repo,
    commit_sha: h.commit_sha,
  }));
  const freshness = (u: CodeUnitRow): EvidenceFreshness =>
    freshnessOf.get(u.repo) ?? 'stale';

  const candidates = new Map<string, Candidate>();
  const addUnits = (
    units: CodeUnitRow[],
    strategy: keyof Candidate['scores'],
    score: number | ((u: CodeUnitRow) => number),
    why: string | ((u: CodeUnitRow) => string),
    relationPath?: string[],
  ): void => {
    for (const u of units) {
      // Defense in depth — never emit a row outside the authorized
      // head set even if a store impl regresses.
      if (u.workspace !== req.workspace) continue;
      if (!headKey.has(`${u.repo}@${u.commit_sha}`)) continue;
      addCandidate(
        candidates,
        u,
        freshness(u),
        strategy,
        typeof score === 'function' ? score(u) : score,
        typeof why === 'function' ? why(u) : why,
        relationPath,
      );
    }
  };

  // --- explicit: verified workflow links from the request subject ---
  if (req.subject) {
    const subjectRefs = [req.subject, `req:${req.subject}`];
    for (const head of heads) {
      for (const subjectRef of subjectRefs) {
        const edges = await store.listCodeEdges({
          workspace: req.workspace,
          repo: head.repo,
          commit_sha: head.commit_sha,
          subject_ref: subjectRef,
        });
        for (const e of edges.slice(0, strategyLimit)) {
          const units = await resolveRefUnits(
            store,
            req,
            heads,
            headKey,
            e.object_ref,
            '',
            strategyLimit,
          );
          for (const u of units) {
            addCandidate(
              candidates,
              u,
              freshness(u),
              'explicit',
              1,
              `explicit-link:${e.predicate}`,
              [e.subject_ref, e.predicate, e.object_ref],
            );
          }
        }
      }
    }
  }

  // --- exact: identifier/path match ---
  const { symbols, paths } = extractQueryIdentifiers(req.query);
  if (symbols.length > 0 || paths.length > 0) {
    const rows = await store.findCodeUnitsExact({
      workspace: req.workspace,
      heads,
      symbols,
      paths,
      limit: strategyLimit,
    });
    addUnits(rows, 'exact', 1, (u) =>
      u.symbol && symbols.includes(u.symbol) ? 'exact-symbol' : 'exact-path',
    );
  }

  // --- fts: Postgres full-text ---
  if (req.query.trim().length > 0) {
    const hits = await store.searchCodeUnitsFts({
      workspace: req.workspace,
      heads,
      query: req.query,
      limit: strategyLimit,
    });
    const maxRank = Math.max(...hits.map((h) => h.rank), 0);
    for (const h of hits) {
      addUnits([h.unit], 'fts', maxRank > 0 ? h.rank / maxRank : 0.5, 'fts');
    }
  }

  // --- semantic: content-addressed embeddings → authorized rows ---
  const embedder = opts.embedder ?? null;
  if (embedder && embedder.dims > 0) {
    const vec = await embedder.embed(req.query);
    if (vec !== null && vec.length > 0) {
      const nearest = await store.nearestEmbeddings({
        model: embedder.model,
        vector: Array.from(vec),
        limit: strategyLimit,
      });
      const distByHash = new Map<string, number>();
      for (const n of nearest) {
        if (!n.object_ref.startsWith(CODECONTENT_PREFIX)) continue;
        const hash = n.object_ref.slice(CODECONTENT_PREFIX.length);
        const prev = distByHash.get(hash);
        if (prev === undefined || n.distance < prev)
          distByHash.set(hash, n.distance);
      }
      if (distByHash.size > 0) {
        const rows = await store.findCodeUnitsByHash({
          workspace: req.workspace,
          heads,
          hashes: [...distByHash.keys()],
          limit: strategyLimit,
        });
        addUnits(
          rows,
          'semantic',
          (u) => 1 - (distByHash.get(u.content_hash) ?? 1),
          'semantic',
        );
      }
    }
  }

  // --- structural: depth-1 expansion over code_edges ---
  if (candidates.size > 0) {
    const seedPaths = new Map<string, CodeUnitRow[]>();
    for (const c of candidates.values()) {
      const key = `${c.unit.repo}@${c.unit.commit_sha}`;
      const list = seedPaths.get(key) ?? [];
      list.push(c.unit);
      seedPaths.set(key, list);
    }
    let expanded = 0;
    const expand = (units: CodeUnitRow[], why: string): void => {
      if (expanded >= STRUCTURAL_NEIGHBOR_CAP) return;
      expanded += units.length;
      addUnits(units, 'structural', STRUCTURAL_SCORE, why);
    };
    for (const [key, units] of seedPaths) {
      const [repo = '', commit_sha = ''] = key.split('@');
      const candPaths = new Set(units.map((u) => u.path));
      const head = { repo, commit_sha };
      // Incoming `tests`/`references` edges — a test file that imports a
      // candidate path is a structural neighbor (INTELLIGENCE §4.2).
      for (const predicate of ['tests', 'references'] as const) {
        const incoming = await store.listCodeEdges({
          workspace: req.workspace,
          repo,
          commit_sha,
          predicate,
        });
        for (const e of incoming) {
          if (expanded >= STRUCTURAL_NEIGHBOR_CAP) break;
          if (!e.subject_ref.startsWith('file:')) continue;
          const subjPath = e.subject_ref.slice('file:'.length);
          if (candPaths.has(subjPath)) continue;
          if (!e.object_ref.startsWith('module:')) continue;
          const resolvedPaths = resolveModuleSpec(
            e.object_ref.slice('module:'.length),
            posix.dirname(subjPath),
          );
          if (!resolvedPaths.some((p) => candPaths.has(p))) continue;
          const neighbors = await store.findCodeUnitsExact({
            workspace: req.workspace,
            heads: [head],
            paths: [subjPath],
            limit: strategyLimit,
          });
          expand(neighbors, `structural:${predicate}-by`);
        }
      }
      // Outgoing edges from each candidate file (imports → modules).
      for (const u of units) {
        if (expanded >= STRUCTURAL_NEIGHBOR_CAP) break;
        const out = await store.listCodeEdges({
          workspace: req.workspace,
          repo,
          commit_sha,
          subject_ref: `file:${u.path}`,
        });
        for (const e of out) {
          if (expanded >= STRUCTURAL_NEIGHBOR_CAP) break;
          const neighbors = await resolveRefUnits(
            store,
            req,
            heads,
            headKey,
            e.object_ref,
            posix.dirname(u.path),
            strategyLimit,
          );
          expand(neighbors, `structural:${e.predicate}`);
        }
      }
    }
  }

  // --- merge → one bounded, cited result set ---
  const merged = [...candidates.values()].map((c) => {
    const s = c.scores;
    let final = 1;
    for (const v of [s.explicit, s.exact, s.fts, s.semantic, s.structural]) {
      if (v !== undefined && v !== null) final *= 1 - v;
    }
    return { ...c, final: 1 - final };
  });
  merged.sort(
    (a, b) =>
      b.final - a.final ||
      a.unit.repo.localeCompare(b.unit.repo) ||
      a.unit.path.localeCompare(b.unit.path) ||
      a.unit.start_line - b.unit.start_line,
  );

  const results: RetrievalEvidenceResult[] = [];
  let tokenBudget = req.token_limit * CHARS_PER_TOKEN;
  for (const c of merged) {
    if (results.length >= req.limit) break;
    if (results.length > 0 && tokenBudget <= 0) break;
    const u = c.unit;
    const excerpt =
      u.content.length > EXCERPT_MAX_CHARS
        ? `${u.content.slice(0, EXCERPT_MAX_CHARS)}\n…`
        : u.content;
    const objectRef = evidenceObjectRef(u);
    results.push({
      evidence_id: evidenceId(objectRef),
      source_type: 'code',
      object_ref: objectRef,
      repo: u.repo,
      commit_sha: u.commit_sha,
      path: u.path,
      start_line: u.start_line,
      end_line: u.end_line,
      symbol: u.symbol ?? null,
      content_hash: u.content_hash,
      excerpt,
      freshness: c.freshness,
      scores: { ...c.scores, final: c.final },
      why: [...c.why].sort(),
      relation_path: c.relationPath ?? null,
    });
    tokenBudget -= excerpt.length;
  }

  // Fail-closed emission — malformed/uncited results throw.
  return validateRetrievalEvidence({
    schema: 1,
    request: req,
    index_heads: indexHeads,
    results,
    zero_result_reason:
      results.length === 0 ? 'no evidence matched the query' : null,
    generated_at: nowIso(),
  });
}
