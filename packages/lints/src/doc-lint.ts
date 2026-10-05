/**
 * Structured-doc lint — validates the machine-read shapes of
 * agent-written docs (SCHEMAS pinned columns + conventions). Fail-closed:
 * an unparseable/unknown doc yields violations, which the conductor maps
 * to the doc-repair path (CONDUCTOR "Structured-doc lint failure").
 */
import {
  COVERAGE_KINDS,
  DEPTH_TIERS,
  TEST_CASE_TYPES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '@sprint-runner/core';
import type { LintViolation } from './coverage.js';
import {
  CASES_COLUMNS,
  COVERAGE_COLUMNS,
  FILE_PLAN_COLUMNS,
  pinnedTable,
} from './coverage.js';
import { headerMatches, parseFrontmatter, parseTables } from './md.js';

const v = (rule: string, message: string, line?: number): LintViolation =>
  line === undefined ? { rule, message } : { rule, message, line };

function checkEnumCells(
  docName: string,
  section: string,
  rows: { cells: string[]; line: number }[],
  col: number,
  allowed: readonly string[],
  violations: LintViolation[],
): void {
  for (const r of rows) {
    const val = r.cells[col] ?? '';
    if (!allowed.includes(val))
      violations.push(
        v(
          'doc.bad-enum',
          `${docName}: ${section} row has '${val}' ∉ {${allowed.join(', ')}}`,
          r.line,
        ),
      );
  }
}

function lintTicketMd(content: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const fm = parseFrontmatter(content);
  if (fm === null)
    return [
      v('doc.frontmatter', 'ticket.md: frontmatter missing or unparseable'),
    ];
  const required = [
    'schema',
    'id',
    'title',
    'status',
    'priority',
    'repos',
    'depth',
  ];
  for (const k of required)
    if (!(k in fm.data))
      violations.push(
        v('doc.frontmatter', `ticket.md: missing frontmatter key '${k}'`),
      );
  if ('status' in fm.data && !TICKET_STATUSES.includes(fm.data.status as never))
    violations.push(
      v(
        'doc.bad-enum',
        `ticket.md: status '${String(fm.data.status)}' not in §1 enum`,
      ),
    );
  if (
    'priority' in fm.data &&
    !TICKET_PRIORITIES.includes(fm.data.priority as never)
  )
    violations.push(
      v(
        'doc.bad-enum',
        `ticket.md: priority '${String(fm.data.priority)}' ∉ {${TICKET_PRIORITIES.join(', ')}}`,
      ),
    );
  if ('depth' in fm.data && !DEPTH_TIERS.includes(fm.data.depth as never))
    violations.push(
      v(
        'doc.bad-enum',
        `ticket.md: depth '${String(fm.data.depth)}' ∉ {${DEPTH_TIERS.join(', ')}}`,
      ),
    );
  if (
    'repos' in fm.data &&
    (!Array.isArray(fm.data.repos) ||
      fm.data.repos.some((r) => typeof r !== 'string' || r.trim() === ''))
  )
    violations.push(
      v(
        'doc.frontmatter',
        'ticket.md: repos must be a list of non-empty strings',
      ),
    );
  return violations;
}

function lintTddMd(content: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const plan = pinnedTable(
    content,
    'File plan',
    FILE_PLAN_COLUMNS,
    'doc.table',
  );
  if (plan.violation)
    violations.push({
      ...plan.violation,
      message: `tdd.md: ${plan.violation.message}`,
    });
  // optional tables — validated only when present
  const exec = parseTables(content.split(/\r?\n/));
  for (const t of exec) {
    if (
      t.header.includes('step') &&
      !headerMatches(t, ['step', 'description', 'verify-with'])
    )
      violations.push(
        v(
          'doc.table',
          `tdd.md: execution-plan table header [${t.header.join(' | ')}] != pinned [step | description | verify-with]`,
          t.line,
        ),
      );
    if (
      t.header.includes('ts') &&
      t.header.includes('planned') &&
      !headerMatches(t, ['ts', 'planned', 'did', 'reason'])
    )
      violations.push(
        v(
          'doc.table',
          `tdd.md: addenda table header [${t.header.join(' | ')}] != pinned [ts | planned | did | reason]`,
          t.line,
        ),
      );
  }
  return violations;
}

function lintVsMd(content: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const cases = pinnedTable(content, 'Cases', CASES_COLUMNS, 'doc.table');
  if (cases.violation)
    violations.push({
      ...cases.violation,
      message: `vs.md: ${cases.violation.message}`,
    });
  else if (cases.table)
    checkEnumCells(
      'vs.md',
      'Cases',
      cases.table.rows,
      2,
      TEST_CASE_TYPES,
      violations,
    );
  const matrix = pinnedTable(
    content,
    'Coverage matrix',
    COVERAGE_COLUMNS,
    'doc.table',
  );
  if (matrix.violation)
    violations.push({
      ...matrix.violation,
      message: `vs.md: ${matrix.violation.message}`,
    });
  else if (matrix.table)
    checkEnumCells(
      'vs.md',
      'Coverage matrix',
      matrix.table.rows,
      1,
      COVERAGE_KINDS,
      violations,
    );
  return violations;
}

function lintDeviationsMd(content: string): LintViolation[] {
  const [t] = parseTables(content.split(/\r?\n/));
  if (!t || !headerMatches(t, ['planned', 'did', 'reason', 'file']))
    return [
      v(
        'doc.table',
        'DEVIATIONS.md: deviations table missing or header != pinned [planned | did | reason | file]',
      ),
    ];
  return [];
}

function lintSplitPlanMd(content: string): LintViolation[] {
  const t = pinnedTable(
    content,
    'Children',
    ['child', 'title', 'repos', 'depends_on', 'covers'],
    'doc.table',
  );
  return t.violation
    ? [{ ...t.violation, message: `split-plan.md: ${t.violation.message}` }]
    : [];
}

const PR_BODY_HEADINGS = [
  'Summary',
  'Acceptance criteria map',
  'Deviations',
  'Test results',
  'Risks / rollout notes',
];

function lintPrBodyMd(content: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const headings = new Set(
    content
      .split(/\r?\n/)
      .map((l) =>
        l
          .match(/^#{2,6}\s+(.+?)\s*$/)?.[1]
          ?.trim()
          .toLowerCase(),
      )
      .filter((h): h is string => h !== undefined),
  );
  for (const h of PR_BODY_HEADINGS)
    if (!headings.has(h.toLowerCase()))
      violations.push(
        v('doc.heading', `pr-body.md: missing required heading '## ${h}' (§9)`),
      );
  return violations;
}

/** docName is the basename agents wrote — 'ticket.md', 'rs.md',
 *  'tdd.md', 'vs.md', 'DEVIATIONS.md', 'split-plan.md', 'pr-body.md'.
 *  Unknown docs fail closed (never linted = never trusted). */
export function structuredDocLint(
  docName: string,
  content: string,
): LintViolation[] {
  switch (docName) {
    case 'ticket.md':
      return lintTicketMd(content);
    case 'tdd.md':
      return lintTddMd(content);
    case 'vs.md':
      return lintVsMd(content);
    case 'DEVIATIONS.md':
      return lintDeviationsMd(content);
    case 'split-plan.md':
      return lintSplitPlanMd(content);
    case 'pr-body.md':
      return lintPrBodyMd(content);
    default:
      return [
        v('doc.unknown', `unknown structured doc '${docName}' — fail-closed`),
      ];
  }
}
