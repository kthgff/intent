/**
 * Contract lint — wp-154 contract-first checks (PRD §15.7/§15.10).
 *
 * The decompose/split run emits `contracts/<name>.json` run artifacts
 * (one `ContractSpecSchema` each); split-plan approval promotes them
 * into each consuming ticket's `contract.json` doc_version (the
 * `ContractDocSchema` envelope). Both shapes lint fail-closed — a
 * malformed contract is a pipeline blocker, never a guess.
 */
import { ContractDocSchema, ContractSpecSchema } from '@veto/core';
import type { LintViolation } from './coverage.js';

const v = (rule: string, message: string): LintViolation => ({
  rule,
  message,
});

/** JSON.parse → value, or a violation when the text is not JSON. */
function parseJson(
  docName: string,
  content: string,
): { ok: true; value: unknown } | { ok: false; violation: LintViolation } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (e) {
    return {
      ok: false,
      violation: v(
        'contract.json',
        `${docName}: not valid JSON — ${(e as Error).message}`,
      ),
    };
  }
}

/**
 * Lint one contract artifact (`contracts/<name>.json`) written by the
 * decompose/split run. Fail-closed: bad JSON or a schema miss = a
 * violation the conductor maps to the doc-repair path.
 */
export function contractLint(content: string): LintViolation[] {
  const parsed = parseJson('contract.json', content);
  if (!parsed.ok) return [parsed.violation];
  const res = ContractSpecSchema.safeParse(parsed.value);
  if (res.success) return [];
  return res.error.issues.map((i) =>
    v(
      'contract.shape',
      `contract.json: ${i.path.join('.') || '<root>'} — ${i.message}`,
    ),
  );
}

/**
 * Lint a promoted `contract.json` doc_version (the per-ticket envelope
 * of every contract the ticket consumes).
 */
export function contractDocLint(content: string): LintViolation[] {
  const parsed = parseJson('contract.json', content);
  if (!parsed.ok) return [parsed.violation];
  const res = ContractDocSchema.safeParse(parsed.value);
  if (res.success) return [];
  return res.error.issues.map((i) =>
    v(
      'contract.shape',
      `contract.json: ${i.path.join('.') || '<root>'} — ${i.message}`,
    ),
  );
}
