/**
 * ticket.md frontmatter parsing for the projection pass (wp-013;
 * SCHEMAS §1, DB-SCHEMA ticket projections, CONDUCTOR reconcile step 1).
 *
 * Fail-closed per AGENTS.md but never throws: a malformed ticket yields a
 * structured error so the projection can surface a `failure` gate item
 * and continue with the remaining tickets.
 *
 * Spec defaults (SCHEMAS §1 documents every default inline): when the
 * frontmatter omits `depth`, `depends_on`, or `forced`, the documented
 * defaults (`standard`, `[]`, `false`) are applied before zod
 * validation. Values that ARE present are validated fail-closed —
 * unknown status/depth/priority or wrong types stay parse errors.
 */
import { readFile } from 'node:fs/promises';
import {
  type TicketFrontmatter,
  TicketFrontmatterSchema,
} from '@sprint-runner/core';
import YAML from 'yaml';

export interface ParsedTicketFile {
  frontmatter: TicketFrontmatter;
  /** Markdown body after the closing `---`. */
  body: string;
  /** Full file contents — the spec_hash input until spec docs land. */
  raw: string;
}

export interface TicketParseError {
  path: string;
  /** Human-readable parse/validation detail for the gate item. */
  error: string;
}

export type ParseTicketResult =
  | { ok: true; value: ParsedTicketFile }
  | { ok: false; error: TicketParseError };

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Parse `tickets/<id>/ticket.md`. Returns a discriminated result —
 * malformed frontmatter is a structured error, never a throw.
 */
export async function parseTicketFile(
  path: string,
): Promise<ParseTicketResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    return {
      ok: false,
      error: { path, error: `unreadable: ${(e as Error).message}` },
    };
  }

  const m = FRONTMATTER_RE.exec(raw);
  if (!m || m[1] === undefined) {
    return {
      ok: false,
      error: { path, error: 'missing or malformed --- frontmatter block' },
    };
  }

  let data: unknown;
  try {
    data = YAML.parse(m[1]);
  } catch (e) {
    return {
      ok: false,
      error: { path, error: `yaml: ${(e as Error).message}` },
    };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      error: { path, error: 'frontmatter is not a yaml mapping' },
    };
  }

  // SCHEMAS §1 documented defaults for fields a minimal ticket may omit.
  const withDefaults = {
    depth: 'standard',
    depends_on: [],
    forced: false,
    ...(data as Record<string, unknown>),
  };

  const parsed = TicketFrontmatterSchema.safeParse(withDefaults);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      error: { path, error: `schema: ${detail}` },
    };
  }

  const body = raw.slice(m[0].length);
  return {
    ok: true,
    value: { frontmatter: parsed.data, body, raw },
  };
}
