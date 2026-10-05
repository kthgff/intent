/**
 * AI Evaluation Lab — golden-set corpus (PRD §15.12, wp-156).
 *
 * Golden sets live as JSON files, one per family, under
 * `fixtures/eval/<family>.json`:
 *
 *   { "family": "extraction", "cases": [ { case_id, input,
 *     expected, tags?, recorded? } ] }
 *
 * Loading is fail-closed (AGENTS.md): a malformed corpus throws a
 * {@link GoldenSetError} rather than silently dropping cases.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalCaseRow } from '@sprint-runner/core';
import type { GoldenCase, GoldenSet } from './types.js';

/** Raised when a golden-set file cannot be parsed or is malformed. */
export class GoldenSetError extends Error {
  override readonly name = 'GoldenSetError';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCase(raw: unknown, source: string, index: number): GoldenCase {
  if (!isPlainObject(raw)) {
    throw new GoldenSetError(`${source}: case[${index}] must be an object`);
  }
  const case_id = raw.case_id;
  if (typeof case_id !== 'string' || case_id.length === 0) {
    throw new GoldenSetError(
      `${source}: case[${index}] needs a non-empty string case_id`,
    );
  }
  const input = raw.input;
  if (!isPlainObject(input)) {
    throw new GoldenSetError(
      `${source}: case ${case_id} needs an object input`,
    );
  }
  const expected = raw.expected;
  if (!isPlainObject(expected)) {
    throw new GoldenSetError(
      `${source}: case ${case_id} needs an object expected`,
    );
  }
  const tags = raw.tags;
  if (
    tags !== undefined &&
    (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))
  ) {
    throw new GoldenSetError(
      `${source}: case ${case_id} tags must be a string array`,
    );
  }
  const golden: GoldenCase = {
    case_id,
    input,
    expected,
    ...(tags !== undefined ? { tags: tags as string[] } : {}),
  };
  if ('recorded' in raw) golden.recorded = raw.recorded;
  return golden;
}

/** Parse an already-decoded golden-set object (fail-closed). */
export function parseGoldenSet(raw: unknown, source = '<golden>'): GoldenSet {
  if (!isPlainObject(raw)) {
    throw new GoldenSetError(`${source}: golden set must be an object`);
  }
  const family = raw.family;
  if (typeof family !== 'string' || family.length === 0) {
    throw new GoldenSetError(`${source}: golden set needs a family`);
  }
  const cases = raw.cases;
  if (!Array.isArray(cases)) {
    throw new GoldenSetError(`${source}: golden set needs a cases array`);
  }
  return {
    family,
    cases: cases.map((c, i) => parseCase(c, source, i)),
  };
}

/** Load one family's golden set from `<dir>/<family>.json`. */
export function loadGoldenSet(family: string, dir: string): GoldenSet {
  const path = join(dir, `${family}.json`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new GoldenSetError(
      `cannot read golden set ${path}: ${(err as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new GoldenSetError(
      `invalid JSON in ${path}: ${(err as Error).message}`,
    );
  }
  return parseGoldenSet(raw, path);
}

/** Load every `*.json` golden set in a corpus directory. */
export function loadGoldenCorpus(dir: string): GoldenSet[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => loadGoldenSet(f.replace(/\.json$/, ''), dir));
}

/** Golden cases → `eval_cases` rows (for `Store.upsertEvalCase`). */
export function goldenSetToCases(
  set: GoldenSet,
  workspace: string,
  org?: string | null,
): EvalCaseRow[] {
  return set.cases.map((c) => ({
    workspace,
    org: org ?? null,
    family: set.family,
    case_id: c.case_id,
    input: c.input,
    expected: c.expected,
    tags: c.tags ?? null,
    created_at: null,
  }));
}

/** `eval_cases` rows → a golden set (round-trip from the store). */
export function goldenSetFromCases(
  family: string,
  rows: EvalCaseRow[],
): GoldenSet {
  return {
    family,
    cases: rows.map((r) => ({
      case_id: r.case_id,
      input: r.input,
      expected: r.expected,
      ...(r.tags ? { tags: r.tags } : {}),
    })),
  };
}
