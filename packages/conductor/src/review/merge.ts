/**
 * review/merge.ts — merge the 4 specialist `findings-<pass>.json`
 * fragments into one review.json document (wp-050; SCHEMAS §6).
 *
 *   - The runner computes `fingerprint` + `thread_id` — agents never
 *     emit either (formula lives in @veto/lints; do NOT
 *     reimplement).
 *   - Dedupe across passes uses the same rule as cross-round matching
 *     (`matchThread`): same file+category AND (identical text_hash OR
 *     overlapping/±5-line ranges) → ONE finding. A second pass joining
 *     a thread merges its evidence (tagged `[pass]`), grows the
 *     `passes` provenance list, and keeps the higher severity.
 *   - thread_id collisions (`f-xxxx` is only 4 hex chars) resolve with
 *     `-2`, `-3` suffixes per SCHEMAS §6.
 */
import { type AgentFinding, REVIEW_PASSES, type ReviewPass } from '@veto/core';
import {
  type FindingInput,
  fingerprint,
  matchThread,
  threadIdFor,
} from '@veto/lints';
import type { FindingsByPass, ReviewDocument, ReviewFinding } from './types.js';

/** Severity ordering — higher rank wins when two passes disagree on a
 *  deduped finding (a blocker flagged by one pass must not be
 *  downgraded by another pass's nit). */
export const SEVERITY_RANK: Record<string, number> = {
  blocker: 5,
  major: 4,
  minor: 3,
  nit: 2,
  question: 1,
};

const maxSeverity = (a: string, b: string): string =>
  (SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a;

/** Agent finding → lints FindingInput (agents emit `line`; `line_range`
 *  is runner-derived — a bare line becomes [line, line]). */
export function findingInput(f: AgentFinding): FindingInput {
  return {
    file: f.file,
    category: f.category,
    body: f.body,
    line: f.line ?? null,
    line_range: null,
  };
}

/** `f-xxxx` with `-2`/`-3` collision suffixes (SCHEMAS §6): the base id
 *  is reused only when it names this exact text_hash (same thread). */
export function freshThreadId(
  fp: ReturnType<typeof fingerprint>,
  findings: { thread_id: string; fingerprint: { text_hash: string } }[],
): string {
  const byId = new Map(
    findings.map((f) => [f.thread_id, f.fingerprint.text_hash]),
  );
  const base = threadIdFor(fp);
  if (!byId.has(base) || byId.get(base) === fp.text_hash) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${i}`;
    if (!byId.has(id)) return id;
  }
}

/** Build the stored finding row for a first-seen thread. */
export function createFinding(
  pass: string,
  f: AgentFinding,
  round: number,
  findings: ReviewFinding[],
): ReviewFinding {
  const fp = fingerprint(findingInput(f));
  return {
    thread_id: freshThreadId(fp, findings),
    status: 'open',
    fingerprint: { ...fp, symbol: null },
    severity: f.severity,
    category: f.category,
    kind: f.kind,
    file: f.file,
    line: f.line ?? 0,
    repo: f.repo ?? '',
    body: f.body,
    ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
    ...(f.suggested_fix !== undefined
      ? { suggested_fix: f.suggested_fix }
      : {}),
    ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
    rounds_seen: [round],
    author: f.author ?? 'review',
    replies: [],
    passes: [pass],
  };
}

/** Merge one agent finding into the findings list. Returns 'created' |
 *  'matched' (the matched thread_id list is updated in place). */
export function mergeOne(
  findings: ReviewFinding[],
  pass: string,
  f: AgentFinding,
  round: number,
): { result: 'created' | 'matched'; thread_id: string } {
  const input = findingInput(f);
  const hit = matchThread(
    input,
    findings.map((e) => ({
      thread_id: e.thread_id,
      fingerprint: e.fingerprint,
    })),
  );
  if (hit !== null) {
    const existing = findings.find((e) => e.thread_id === hit);
    if (existing) {
      const seen = existing.rounds_seen ?? [];
      if (!seen.includes(round)) seen.push(round);
      existing.rounds_seen = seen;
      if (!existing.passes.includes(pass)) existing.passes.push(pass);
      // Merged evidence: later passes' evidence joins tagged with the
      // pass name so provenance survives in the human-visible quote.
      if (f.evidence) {
        existing.evidence = existing.evidence
          ? `${existing.evidence}\n[${pass}] ${f.evidence}`
          : `[${pass}] ${f.evidence}`;
      }
      if (!existing.suggested_fix && f.suggested_fix) {
        existing.suggested_fix = f.suggested_fix;
      }
      existing.severity = maxSeverity(
        existing.severity,
        f.severity,
      ) as typeof existing.severity;
      if ((f.confidence ?? 0) > (existing.confidence ?? 0)) {
        existing.confidence = f.confidence;
      }
      return { result: 'matched', thread_id: hit };
    }
  }
  const created = createFinding(pass, f, round, findings);
  findings.push(created);
  return { result: 'created', thread_id: created.thread_id };
}

/** Pass iteration order — the four spec passes in REVIEW_PASSES order,
 *  then any custom keys in insertion order (deterministic merges). */
export function orderedPasses(byPass: FindingsByPass): string[] {
  const keys = Object.keys(byPass);
  const spec = REVIEW_PASSES.filter((p) => keys.includes(p));
  const extra = keys.filter((k) => !REVIEW_PASSES.includes(k as ReviewPass));
  return [...spec, ...extra];
}

/**
 * Merge every pass fragment into a fresh review.json document
 * (`mergePasses(findingsByPass) -> Review`). Round defaults to 1 —
 * re-review rounds go through `reReview` instead, which preserves
 * thread state.
 */
export function mergePasses(
  findingsByPass: FindingsByPass,
  opts: { ticket: string; round?: number },
): ReviewDocument {
  const round = opts.round ?? 1;
  const review: ReviewDocument = {
    schema: 1,
    ticket: opts.ticket,
    round,
    passes: [],
    findings: [],
  };
  for (const pass of orderedPasses(findingsByPass)) {
    for (const f of findingsByPass[pass] ?? []) {
      mergeOne(review.findings, pass, f, round);
    }
    if (!review.passes.includes(pass)) review.passes.push(pass);
  }
  return review;
}
