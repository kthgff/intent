/**
 * Minimal markdown helpers for the doc lints — frontmatter, `##` section
 * slicing, and pipe-table parsing. Fail-closed: anything unparseable
 * returns null/empty and the caller emits a violation.
 */
import YAML from 'yaml';

export interface Frontmatter {
  /** Raw key → value map (already YAML-decoded). */
  data: Record<string, unknown>;
  /** Body after the closing `---` fence. */
  body: string;
}

/** Parse a `---` YAML frontmatter block. Null when absent or malformed. */
export function parseFrontmatter(md: string): Frontmatter | null {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m || m[1] === undefined) return null;
  let data: unknown;
  try {
    data = YAML.parse(m[1]);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return null;
  return { data: data as Record<string, unknown>, body: md.slice(m[0].length) };
}

/** Lines of a `## <name>` section (up to the next `#`/`##` or EOF).
 *  Null when the heading is absent. Heading match is case-insensitive
 *  and tolerates a `#` prefix of any depth ≥2. */
export function sectionLines(md: string, name: string): string[] | null {
  const wanted = name.trim().toLowerCase();
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const h = line.match(/^#{2,6}\s+(.+?)\s*#*\s*$/);
    if (h && h[1] !== undefined && h[1].trim().toLowerCase() === wanted) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

export interface TableRow {
  cells: string[];
  /** 1-based line number in the source doc. */
  line: number;
}

export interface MdTable {
  header: string[];
  rows: TableRow[];
  /** 1-based line of the header row. */
  line: number;
}

const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSepRow = (cells: string[]) =>
  cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** All pipe tables in a line range. A header row followed by a `| --- |`
 *  separator is treated as one table; consecutive `|` lines without a
 *  separator are a table whose first row is the header (SCHEMAS docs use
 *  bare header rows). */
export function parseTables(lines: string[], lineOffset = 0): MdTable[] {
  const tables: MdTable[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || !isTableLine(line)) {
      i++;
      continue;
    }
    const header = splitRow(line);
    const headerLine = lineOffset + i + 1;
    i++;
    const rows: TableRow[] = [];
    let first = true;
    while (i < lines.length) {
      const l = lines[i];
      if (l === undefined || !isTableLine(l)) break;
      const cells = splitRow(l);
      if (first && isSepRow(cells)) {
        i++;
        first = false;
        continue;
      }
      first = false;
      rows.push({ cells, line: lineOffset + i + 1 });
      i++;
    }
    tables.push({ header, rows, line: headerLine });
  }
  return tables;
}

/** Header cells equal the pinned columns (order-sensitive, SCHEMAS
 *  "pinned headers/order" convention). */
export function headerMatches(table: MdTable, pinned: string[]): boolean {
  return (
    table.header.length === pinned.length &&
    pinned.every((c, idx) => table.header[idx] === c)
  );
}
