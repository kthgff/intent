/**
 * Finding fingerprints — SCHEMAS §6. Runner-computed (never the agent):
 * normalize whitespace → sha256 over `file|category|normalized_text`.
 * matchThread implements the reopened-detection rule: same file +
 * category and (identical text_hash OR line ranges within ±5 /
 * overlapping) → same thread.
 */
import { createHash } from 'node:crypto';

/** Line-proximity tolerance for reworded reports of the same site (§6). */
export const LINE_TOLERANCE = 5;

/** Finding fields the fingerprint consumes (agent-emitted + runner
 *  derived `line_range`). */
export interface FindingInput {
  file: string;
  category: string;
  /** Finding text — `body`; `evidence` is NOT hashed (quotes reflow). */
  body: string;
  line?: number | null;
  line_range?: [number, number] | null;
}

export interface Fingerprint {
  file: string;
  category: string;
  line_range: [number, number] | null;
  text_hash: string;
}

export interface Thread {
  thread_id: string;
  fingerprint: Fingerprint;
}

export const normalizeFindingText = (text: string): string =>
  text.trim().replace(/\s+/g, ' ');

/** `sha256:`-prefixed hex digest of `file|category|normalized_text`. */
export function fingerprintTextHash(f: FindingInput): string {
  const input = `${f.file}|${f.category}|${normalizeFindingText(f.body)}`;
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

/** Full fingerprint object for a finding (§6 review.json shape). */
export function fingerprint(f: FindingInput): Fingerprint {
  return {
    file: f.file,
    category: f.category,
    line_range: f.line_range ?? (f.line != null ? [f.line, f.line] : null),
    text_hash: fingerprintTextHash(f),
  };
}

/** `f-` + first 4 hex chars of the text-hash digest (§6). */
export function threadIdFor(f: FindingInput | Fingerprint): string {
  const hash = 'text_hash' in f ? f.text_hash : fingerprintTextHash(f);
  return `f-${hash.slice('sha256:'.length, 'sha256:'.length + 4)}`;
}

const rangesNear = (
  a: [number, number] | null,
  b: [number, number] | null,
): boolean => {
  if (a === null || b === null) return false;
  // overlap, or gap ≤ LINE_TOLERANCE on either side
  return a[0] <= b[1] + LINE_TOLERANCE && b[0] <= a[1] + LINE_TOLERANCE;
};

/** Reopened-detection rule (§6): same file+category AND (same text_hash
 *  — covers shifted lines — OR line ranges overlapping/within ±5 —
 *  covers reworded same-site reports). Returns the thread_id or null. */
export function matchThread(
  newFinding: FindingInput,
  existingThreads: Thread[],
): string | null {
  const fp = fingerprint(newFinding);
  for (const t of existingThreads) {
    const tf = t.fingerprint;
    if (tf.file !== fp.file || tf.category !== fp.category) continue;
    if (tf.text_hash === fp.text_hash) return t.thread_id;
    if (rangesNear(fp.line_range, tf.line_range)) return t.thread_id;
  }
  return null;
}
