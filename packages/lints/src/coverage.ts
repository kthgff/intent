/**
 * Coverage lint — SCHEMAS §4: every TDD file-plan row maps to ≥1
 * case_id in the vs.md coverage matrix, or carries an `untestable:`
 * exemption; every case_id cited in the matrix must exist in the
 * vs.md cases table (fake coverage can't be manufactured).
 * Fail-closed: unparseable tables are violations, never skipped.
 */
import { COVERAGE_KINDS } from '@veto/core';
import {
  type MdTable,
  headerMatches,
  parseTables,
  sectionLines,
} from './md.js';

export interface LintViolation {
  /** Machine-stable rule id, e.g. 'coverage.uncovered-file'. */
  rule: string;
  message: string;
  /** 1-based source line when known. */
  line?: number;
}

export const FILE_PLAN_COLUMNS = ['file', 'repo', 'change', 'why'] as const;
export const CASES_COLUMNS = [
  'case_id',
  'title',
  'type',
  'file',
  'covers',
] as const;
export const COVERAGE_COLUMNS = ['item', 'kind', 'case_ids'] as const;

export interface FilePlanRow {
  file: string;
  repo: string;
  change: string;
  why: string;
  line: number;
  /** `change` cell starts with `untestable:` — coverage-exempt (§4). */
  untestable: boolean;
}

/** Find the first table under a `##` section and check pinned columns.
 *  Returns the table or a violation describing the failure. */
export function pinnedTable(
  md: string,
  section: string,
  pinned: readonly string[],
  rule: string,
): { table: MdTable | null; violation: LintViolation | null } {
  const lines = sectionLines(md, section);
  if (lines === null)
    return {
      table: null,
      violation: {
        rule,
        message: `no ## ${section} section — fail-closed`,
      },
    };
  const [table] = parseTables(lines);
  if (!table)
    return {
      table: null,
      violation: {
        rule,
        message: `## ${section} has no table — fail-closed`,
      },
    };
  if (!headerMatches(table, [...pinned]))
    return {
      table: null,
      violation: {
        rule,
        message: `## ${section} table header [${table.header.join(' | ')}] != pinned [${pinned.join(' | ')}] — fail-closed`,
        line: table.line,
      },
    };
  return { table, violation: null };
}

/** TDD `## File plan` rows (MACHINE-READ, §3). Null = unparseable. */
export function filePlanRows(tddMd: string): {
  rows: FilePlanRow[] | null;
  violation: LintViolation | null;
} {
  const { table, violation } = pinnedTable(
    tddMd,
    'File plan',
    FILE_PLAN_COLUMNS,
    'coverage.file-plan-unparseable',
  );
  if (!table) return { rows: null, violation };
  return {
    rows: table.rows.map((r) => ({
      file: r.cells[0] ?? '',
      repo: r.cells[1] ?? '',
      change: r.cells[2] ?? '',
      why: r.cells[3] ?? '',
      line: r.line,
      untestable: (r.cells[2] ?? '').toLowerCase().startsWith('untestable:'),
    })),
    violation: null,
  };
}

export function coverageLint(tddMd: string, vsMd: string): LintViolation[] {
  const violations: LintViolation[] = [];

  const plan = filePlanRows(tddMd);
  if (plan.violation) violations.push(plan.violation);

  const cases = pinnedTable(
    vsMd,
    'Cases',
    CASES_COLUMNS,
    'coverage.cases-unparseable',
  );
  if (cases.violation) violations.push(cases.violation);
  const caseIds = new Set(
    (cases.table?.rows ?? []).map((r) => r.cells[0] ?? ''),
  );

  const matrix = pinnedTable(
    vsMd,
    'Coverage matrix',
    COVERAGE_COLUMNS,
    'coverage.matrix-unparseable',
  );
  if (matrix.violation) violations.push(matrix.violation);

  // case_ids cited in the matrix must exist in the cases table
  // (fake-case detection — §4 "fake coverage can't be manufactured").
  const fileCoverage = new Map<string, string[]>();
  for (const r of matrix.table?.rows ?? []) {
    const [item = '', kind = '', idsCell = ''] = r.cells;
    if (!COVERAGE_KINDS.includes(kind as never)) {
      violations.push({
        rule: 'coverage.bad-kind',
        message: `coverage matrix row '${item}' has kind '${kind}' ∉ {${COVERAGE_KINDS.join(', ')}}`,
        line: r.line,
      });
      continue;
    }
    const ids = idsCell
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (idsCell.trim().toLowerCase() === 'n/a') {
      // declared-exempt row — allowed only for untestable file-plan rows
      if (kind === 'file') fileCoverage.set(item, []);
      continue;
    }
    if (ids.length === 0) {
      violations.push({
        rule: 'coverage.empty-case-ids',
        message: `coverage matrix row '${item}' lists no case_ids`,
        line: r.line,
      });
      continue;
    }
    for (const id of ids) {
      if (cases.table && !caseIds.has(id)) {
        violations.push({
          rule: 'coverage.unknown-case',
          message: `coverage matrix row '${item}' cites unknown case_id '${id}' — not in the cases table`,
          line: r.line,
        });
      }
    }
    if (kind === 'file')
      fileCoverage.set(item, [...(fileCoverage.get(item) ?? []), ...ids]);
  }

  // every file-plan row → ≥1 case_id, unless `untestable:` exempt (§4)
  for (const row of plan.rows ?? []) {
    if (row.untestable) continue;
    const covered = fileCoverage.get(row.file);
    if (!covered || covered.length === 0) {
      violations.push({
        rule: 'coverage.uncovered-file',
        message: `file-plan row '${row.file}' has no case_id in the coverage matrix (add one or mark the row 'untestable:')`,
        line: row.line,
      });
    }
  }

  return violations;
}
