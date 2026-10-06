/**
 * ticket.md frontmatter parsing (was projection/parse.ts, wp-013;
 * moved into import/ under wp-093 D29).
 *
 * Still useful wherever a ticket.md *document* needs validating —
 * import tooling, fixtures, doc render checks. Docs are Postgres
 * `doc_versions` truth (D29): there is no projection pass rebuilding
 * rows from disk, so this is a standalone parser, not a pipeline stage.
 *
 * Fail-closed per AGENTS.md but never throws: malformed content yields
 * a structured error so callers can surface a `failure` gate item and
 * continue.
 *
 * Spec defaults (SCHEMAS §1 documents every default inline): when the
 * frontmatter omits `depth`, `depends_on`, or `forced`, the documented
 * defaults (`standard`, `[]`, `false`) are applied before zod
 * validation. Values that ARE present are validated fail-closed —
 * unknown status/depth/priority or wrong types stay parse errors.
 */
import { readFile } from 'node:fs/promises';
import { type TicketFrontmatter, TicketFrontmatterSchema } from '@veto/core';
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
 * Parse a ticket.md file. Returns a discriminated result — malformed
 * frontmatter is a structured error, never a throw.
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
  return parseTicketMd(raw, path);
}

/**
 * Parse ticket.md *content* (e.g. a `doc_versions` row) — same rules
 * as {@link parseTicketFile} without the filesystem read.
 */
export function parseTicketMd(raw: string, path = '<doc>'): ParseTicketResult {
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
