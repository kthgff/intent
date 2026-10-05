/**
 * decompose/plan.ts — the wp-154 decomposition plan: the split run's
 * `split-plan.md` read as a Work Decomposition output (PRD §15.10).
 *
 * `## Children` is the pinned SCHEMAS §14 table (unchanged). wp-154
 * adds two OPTIONAL machine-read sections:
 *
 *   - `## Decomposition` — per-child boundary / repo+service
 *     ownership / test obligation / security sensitivity / expected
 *     complexity / predicted shared files (`child | boundary |
 *     ownership | tests | security | complexity | shared_files`).
 *   - `## Contracts` — shared API/data/event contracts the children
 *     consume (`contract | kind | consumers | artifact`); each row's
 *     `artifact` names a `contracts/<name>.json` run artifact holding
 *     one ContractSpecSchema document.
 *
 * Fail-closed: a missing `## Children` table OR a present-but-
 * malformed optional section returns null — the caller surfaces the
 * repair gate rather than materializing a guess.
 */
import {
  CONTRACT_KINDS,
  type ContractKind,
  DECOMPOSE_COMPLEXITIES,
  DECOMPOSE_SECURITY,
  type DecomposeComplexity,
  type DecomposeSecurity,
} from '@sprint-runner/core';

/** One `## Children` row — sibling labels resolve to real ids at
 *  materialization (SCHEMAS §14). */
export interface SplitChild {
  label: string;
  title: string;
  repos: string[];
  dependsOn: string[]; // sibling labels
  covers: string[];
}

/** One `## Decomposition` row, keyed by child label. */
export interface DecompositionRow {
  child: string;
  /** Logical boundary one-liner (why this is its own ticket). */
  boundary: string;
  /** Repo/service ownership note (e.g. `backend/api`). */
  ownership: string;
  /** Test obligation the child carries. */
  tests: string;
  security: DecomposeSecurity;
  complexity: DecomposeComplexity;
  /** Predicted shared paths — the merge-conflict risk input. */
  sharedFiles: string[];
}

/** One `## Contracts` row — a shared interface + its consumers. */
export interface PlanContract {
  name: string;
  kind: ContractKind;
  /** Child labels consuming this contract. */
  consumers: string[];
  /** Run-artifact relpath of the ContractSpec JSON
   *  (`contracts/<name>.json`). */
  artifact: string;
}

export interface DecompositionPlan {
  children: SplitChild[];
  decomposition: DecompositionRow[];
  contracts: PlanContract[];
}

/** `a, b` / `[a, b]` / `-` / `none` → string list (plan cells). */
function cellList(s: string): string[] {
  const t = s.trim().replace(/^\[|\]$/g, '');
  if (t === '' || t === '-' || t.toLowerCase() === 'none') return [];
  return t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

interface ParsedTable {
  header: string[];
  rows: string[][];
}

/** The `## <section>` block's first pipe table — `null` when the
 *  section is absent, `'malformed'` when it exists but holds no
 *  table (fail-closed). */
function sectionTable(
  md: string,
  section: string,
): ParsedTable | null | 'malformed' {
  const lines = md.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^#{2,6}\\s+${section}\\b`, 'i').test(l),
  );
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  const slice = lines.slice(start + 1, end === -1 ? undefined : end);
  const rows: string[][] = [];
  let header: string[] | null = null;
  for (const line of slice) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length === 0) continue;
    if (header === null) {
      header = cells;
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
    rows.push(cells);
  }
  return header === null ? 'malformed' : { header, rows };
}

const headersMatch = (a: string[], pinned: readonly string[]) =>
  a.length === pinned.length &&
  a.every((h, i) => h.toLowerCase() === pinned[i]);

const CHILDREN_COLUMNS = ['child', 'title', 'repos', 'depends_on', 'covers'];
const CONTRACTS_COLUMNS = ['contract', 'kind', 'consumers', 'artifact'];
const DECOMPOSITION_COLUMNS = [
  'child',
  'boundary',
  'ownership',
  'tests',
  'security',
  'complexity',
  'shared_files',
];

/** Parse the `## Children` table (SCHEMAS §14 pinned columns).
 *  Fail-closed: absent/malformed → null. */
export function parseSplitPlan(md: string): SplitChild[] | null {
  const t = sectionTable(md, 'Children');
  if (t === null || t === 'malformed') return null;
  if (!headersMatch(t.header, CHILDREN_COLUMNS)) return null;
  const rows: SplitChild[] = [];
  for (const cells of t.rows) {
    if (cells.length < CHILDREN_COLUMNS.length) return null;
    rows.push({
      label: cells[0] ?? '',
      title: cells[1] ?? '',
      repos: cellList(cells[2] ?? ''),
      dependsOn: cellList(cells[3] ?? ''),
      covers: cellList(cells[4] ?? ''),
    });
  }
  return rows.length > 0 ? rows : null;
}

/**
 * Parse the full wp-154 decomposition plan. Returns null when the
 * `## Children` table is unparseable OR a present `## Contracts` /
 * `## Decomposition` section is malformed — the caller parks the
 * ticket on the repair gate (never materializes a guess).
 */
export function parseDecompositionPlan(md: string): DecompositionPlan | null {
  const children = parseSplitPlan(md);
  if (!children) return null;

  const contracts: PlanContract[] = [];
  const ct = sectionTable(md, 'Contracts');
  if (ct === 'malformed') return null;
  if (ct) {
    if (!headersMatch(ct.header, CONTRACTS_COLUMNS)) return null;
    for (const cells of ct.rows) {
      if (cells.length < CONTRACTS_COLUMNS.length) return null;
      const kind = cells[1] ?? '';
      if (!(CONTRACT_KINDS as readonly string[]).includes(kind)) return null;
      contracts.push({
        name: cells[0] ?? '',
        kind: kind as ContractKind,
        consumers: cellList(cells[2] ?? ''),
        artifact: cells[3] ?? '',
      });
    }
  }

  const decomposition: DecompositionRow[] = [];
  const dt = sectionTable(md, 'Decomposition');
  if (dt === 'malformed') return null;
  if (dt) {
    if (!headersMatch(dt.header, DECOMPOSITION_COLUMNS)) return null;
    for (const cells of dt.rows) {
      if (cells.length < DECOMPOSITION_COLUMNS.length) return null;
      const security = cells[4] ?? '';
      const complexity = cells[5] ?? '';
      if (!(DECOMPOSE_SECURITY as readonly string[]).includes(security))
        return null;
      if (!(DECOMPOSE_COMPLEXITIES as readonly string[]).includes(complexity))
        return null;
      decomposition.push({
        child: cells[0] ?? '',
        boundary: cells[1] ?? '',
        ownership: cells[2] ?? '',
        tests: cells[3] ?? '',
        security: security as DecomposeSecurity,
        complexity: complexity as DecomposeComplexity,
        sharedFiles: cellList(cells[6] ?? ''),
      });
    }
  }

  return { children, decomposition, contracts };
}
