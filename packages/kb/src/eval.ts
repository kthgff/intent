/**
 * Golden-set retrieval evaluation (INTELLIGENCE §7, wp-110).
 *
 * A declared golden set — `(query → relevant files/symbols)` — is run
 * through {@link queryEvidence} and scored into a
 * `retrieval_evaluations` row (DB-SCHEMA). Metrics:
 *
 * - `relevant_file_recall_at_k` / `relevant_symbol_recall_at_k` —
 *   fraction of declared relevant items surfaced in the top-k;
 * - `recall_at_k` — mean per-case recall over all declared items;
 * - `exact_recall` — fraction of declared relevant *symbols* surfaced
 *   with an `exact` score contribution (exact-identifier recall);
 * - `citation_valid` — fraction of emitted results carrying every
 *   required citation field (repo/commit/path/line-range/content_hash/
 *   freshness);
 * - `citation_fresh` — fraction of emitted results labeled `current`;
 * - `unauthorized_count` — results outside the authorized repo set or
 *   a non-resolved commit head. **Must be zero.**
 * - `unsupported_claim_proxy` — fraction of emitted results with no
 *   recorded strategy contribution (`why` empty or `final <= 0`);
 * - `latency_ms` — avg/max per-query wall time;
 * - `zero_result` — queries that returned the explicit empty artifact.
 *
 * The harness never fabricates relevance: a case with no declared
 * `relevant_*` items only contributes latency/authorization/citation
 * measurements (a zero-result outcome is valid, not an error).
 */
import { createHash } from 'node:crypto';
import type {
  CommitPolicy,
  RetrievalEvidence,
  RetrievalEvaluationRow,
  RetrievalRequest,
  RetrievalTask,
  Store,
} from '@sprint-runner/core';
import { queryEvidence } from './retrieve.js';
import type { Embedder } from './embeddings.js';

/** One declared golden query. */
export interface GoldenCase {
  id: string;
  query: string;
  /** Optional retrieval subject (explicit-link queries). */
  subject?: string;
  /** Repo-relative paths that MUST surface. */
  relevant_paths?: string[];
  /** Symbols that MUST surface. */
  relevant_symbols?: string[];
}

/** A versioned golden set. */
export interface GoldenSuite {
  suite_version: string;
  /** The retrieval task label stamped on the evaluation row. */
  task: RetrievalTask;
  /** Recall cutoff; defaults to the request limit. */
  k?: number;
  cases: GoldenCase[];
}

export interface GoldenEvalOptions {
  workspace: string;
  /** The caller-authorized repo list — the ACL under evaluation. */
  authorizedRepos: string[];
  /** Optional request-level repo filter forwarded to every case. */
  repos?: string[];
  /** Embedder for the semantic strategy; null/'off' degrades cleanly. */
  embedder?: Embedder | null;
  commit_policy?: CommitPolicy;
  /** Per-query result cap (default 20, per SCHEMAS §17). */
  limit?: number;
  token_limit?: number;
  now?: () => string;
}

export interface GoldenCaseReport {
  id: string;
  hits: number;
  relevant: number;
  recall_at_k: number | null;
  exact_recall: number | null;
  results: number;
  latency_ms: number;
  unauthorized: number;
}

export interface GoldenEvalMetrics extends Record<string, unknown> {
  queries: number;
  k: number;
  recall_at_k: number | null;
  relevant_file_recall_at_k: number | null;
  relevant_symbol_recall_at_k: number | null;
  exact_recall: number | null;
  citation_valid: number;
  citation_fresh: number;
  unauthorized_count: number;
  unsupported_claim_proxy: number;
  zero_result: number;
  latency_ms: { avg: number; max: number };
}

export interface GoldenEvalResult {
  row: RetrievalEvaluationRow;
  metrics: GoldenEvalMetrics;
  cases: GoldenCaseReport[];
  bundles: RetrievalEvidence[];
}

const REQUIRED_CITATION = [
  'repo',
  'commit_sha',
  'path',
  'start_line',
  'end_line',
  'content_hash',
] as const;

/**
 * Score a golden suite against the live index and persist the metrics
 * as a `retrieval_evaluations` row (`insertRetrievalEvaluation` —
 * idempotent on `id`). Returns the row + full per-case breakdown.
 */
export async function evaluateGoldenSet(
  store: Store,
  suite: GoldenSuite,
  opts: GoldenEvalOptions,
): Promise<GoldenEvalResult> {
  const nowIso = opts.now ?? (() => new Date().toISOString());
  const limit = opts.limit ?? 20;
  const k = suite.k ?? limit;
  const authorized = new Set(opts.authorizedRepos);
  const authorizedHeads = new Set<string>();
  const bundles: RetrievalEvidence[] = [];
  const reports: GoldenCaseReport[] = [];

  const latencies: number[] = [];
  let totalResults = 0;
  let validCitations = 0;
  let freshCitations = 0;
  let unauthorized = 0;
  let unsupported = 0;
  let zeroResults = 0;
  const recallSamples: number[] = [];
  const fileRecallSamples: number[] = [];
  const symbolRecallSamples: number[] = [];
  const exactSamples: number[] = [];

  for (const c of suite.cases) {
    const request: RetrievalRequest = {
      workspace: opts.workspace,
      subject: c.subject ?? null,
      task: suite.task,
      query: c.query,
      repos: opts.repos ?? [],
      source_types: ['code'],
      commit_policy: opts.commit_policy ?? 'current',
      limit,
      token_limit: opts.token_limit ?? 8000,
    };
    const t0 = Date.now();
    const bundle = await queryEvidence(store, request, {
      authorizedRepos: opts.authorizedRepos,
      embedder: opts.embedder ?? null,
      now: nowIso,
    });
    const latency = Date.now() - t0;
    latencies.push(latency);
    bundles.push(bundle);

    for (const h of bundle.index_heads) {
      authorizedHeads.add(`${h.repo}@${h.commit_sha}`);
    }
    const top = bundle.results.slice(0, k);
    if (bundle.results.length === 0) zeroResults += 1;

    let caseUnauthorized = 0;
    for (const r of bundle.results) {
      totalResults += 1;
      const cited = REQUIRED_CITATION.every(
        (f) => r[f] !== null && r[f] !== undefined && r[f] !== '',
      );
      if (cited) validCitations += 1;
      if (r.freshness === 'current') freshCitations += 1;
      if (
        !authorized.has(r.repo ?? '') ||
        !authorizedHeads.has(`${r.repo}@${r.commit_sha}`)
      ) {
        unauthorized += 1;
        caseUnauthorized += 1;
      }
      if (r.why.length === 0 || r.scores.final <= 0) unsupported += 1;
    }

    // Relevance scoring — a declared path is "hit" when any top-k
    // result carries it; likewise for a declared symbol.
    const relPaths = c.relevant_paths ?? [];
    const relSymbols = c.relevant_symbols ?? [];
    const hitPaths = relPaths.filter((p) => top.some((r) => r.path === p));
    const hitSymbols = relSymbols.filter((s) =>
      top.some((r) => r.symbol === s),
    );
    const declared = relPaths.length + relSymbols.length;
    const hits = hitPaths.length + hitSymbols.length;
    const recall = declared > 0 ? hits / declared : null;
    if (recall !== null) recallSamples.push(recall);
    if (relPaths.length > 0)
      fileRecallSamples.push(hitPaths.length / relPaths.length);
    if (relSymbols.length > 0)
      symbolRecallSamples.push(hitSymbols.length / relSymbols.length);

    // Exact-identifier recall — of the relevant symbols, how many were
    // surfaced via the `exact` strategy contribution.
    let exactRecall: number | null = null;
    if (relSymbols.length > 0) {
      const exactHit = relSymbols.filter((s) =>
        top.some((r) => r.symbol === s && r.scores.exact !== undefined),
      );
      exactRecall = exactHit.length / relSymbols.length;
      exactSamples.push(exactRecall);
    }

    reports.push({
      id: c.id,
      hits,
      relevant: declared,
      recall_at_k: recall,
      exact_recall: exactRecall,
      results: bundle.results.length,
      latency_ms: latency,
      unauthorized: caseUnauthorized,
    });
  }

  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  const metrics: GoldenEvalMetrics = {
    queries: suite.cases.length,
    k,
    recall_at_k: mean(recallSamples),
    relevant_file_recall_at_k: mean(fileRecallSamples),
    relevant_symbol_recall_at_k: mean(symbolRecallSamples),
    exact_recall: mean(exactSamples),
    citation_valid: totalResults === 0 ? 1 : validCitations / totalResults,
    citation_fresh: totalResults === 0 ? 1 : freshCitations / totalResults,
    unauthorized_count: unauthorized,
    unsupported_claim_proxy:
      totalResults === 0 ? 0 : unsupported / totalResults,
    zero_result: zeroResults,
    latency_ms: {
      avg:
        latencies.length === 0
          ? 0
          : latencies.reduce((a, b) => a + b, 0) / latencies.length,
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
  };

  const indexHeads = [...authorizedHeads].map((key) => {
    const at = key.lastIndexOf('@');
    return { repo: key.slice(0, at), commit_sha: key.slice(at + 1) };
  });
  const row: RetrievalEvaluationRow = {
    id: `re_${createHash('sha256')
      .update(`${suite.suite_version}:${opts.workspace}:${nowIso()}`)
      .digest('hex')
      .slice(0, 20)}`,
    suite_version: suite.suite_version,
    task: suite.task,
    index_heads: indexHeads,
    metrics,
    created_at: nowIso(),
  };
  await store.insertRetrievalEvaluation(row);
  return { row, metrics, cases: reports, bundles };
}
