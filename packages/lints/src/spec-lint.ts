/**
 * Spec lint — mechanical quality score for ticket.md (SCHEMAS §15).
 * Pure function: doc text in → {score, flags} out. Advisory only; the
 * conductor injects the rendered text as {{SPEC_LINT}} into triage.
 */
import { DEPTH_TIERS, TICKET_PRIORITIES, TICKET_STATUSES } from '@veto/core';
import { parseFrontmatter, parseTables, sectionLines } from './md.js';

export interface SpecLintResult {
  /** 0-100 — 100 minus the weights of failed checks (SCHEMAS §15). */
  score: number;
  flags: string[];
}

/** Vague/aspirational phrases that make an AC unverifiable (§2, §15). */
const VAGUE_PATTERNS: RegExp[] = [
  /\bworks\b/i,
  /\bhandles\b/i,
  /\bsupports\b/i,
  /\bimproves\b/i,
  /\bis fast\b/i,
  /\bproperly\b/i,
  /\bcorrectly\b/i,
  /\bseamlessly\b/i,
  /\buser-friendly\b/i,
  /\brobust\b/i,
  /\bintuitive\b/i,
  /\bas appropriate\b/i,
  /\betc\./i,
];

/** Placeholder strings banned anywhere in the doc (§15). */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\bTBD\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bXXX\b/i,
  /<placeholder>/i,
  /lorem ipsum/i,
  /to be determined/i,
  /\?\?\?/,
];

const DESCRIPTION_MIN = 80;

const REQUIRED_FRONTMATTER_KEYS = [
  'schema',
  'id',
  'title',
  'status',
  'priority',
  'repos',
  'depth',
] as const;

interface AcRow {
  text: string;
  line: number;
  label: string;
}

/** AC rows = `- [ ]` checklist items or `ac_id` table rows under
 *  `## Acceptance criteria` (§15 ac_present). */
function acRows(md: string): AcRow[] | null {
  const lines = sectionLines(md, 'Acceptance criteria');
  if (lines === null) return null;
  const rows: AcRow[] = [];
  let acIdx = 0;
  for (const t of parseTables(lines)) {
    const idCol = t.header.indexOf('ac_id');
    const critCol = t.header.indexOf('criterion');
    if (idCol === -1 && critCol === -1) continue;
    const textCol = critCol !== -1 ? critCol : idCol;
    for (const r of t.rows) {
      acIdx++;
      rows.push({
        text: r.cells[textCol] ?? '',
        line: r.line,
        label: r.cells[idCol] ?? `ac${acIdx}`,
      });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === undefined) continue;
    const m = l.match(/^\s*-\s*\[[ xX]\]\s+(.+)$/);
    if (m && m[1] !== undefined) {
      acIdx++;
      rows.push({ text: m[1].trim(), line: i + 1, label: `ac${acIdx}` });
    }
  }
  rows.sort((a, b) => a.line - b.line);
  return rows;
}

export function specLint(ticketMd: string): SpecLintResult {
  const flags: string[] = [];
  let penalty = 0;

  // frontmatter — 10
  const fm = parseFrontmatter(ticketMd);
  if (fm === null) {
    penalty += 10;
    flags.push('frontmatter missing or unparseable');
  } else {
    const missing = REQUIRED_FRONTMATTER_KEYS.filter((k) => !(k in fm.data));
    const badEnums: string[] = [];
    if (
      'status' in fm.data &&
      !TICKET_STATUSES.includes(fm.data.status as never)
    )
      badEnums.push(`status '${String(fm.data.status)}'`);
    if (
      'priority' in fm.data &&
      !TICKET_PRIORITIES.includes(fm.data.priority as never)
    )
      badEnums.push(`priority '${String(fm.data.priority)}'`);
    if ('depth' in fm.data && !DEPTH_TIERS.includes(fm.data.depth as never))
      badEnums.push(`depth '${String(fm.data.depth)}'`);
    if (missing.length > 0 || badEnums.length > 0) {
      penalty += 10;
      if (missing.length > 0)
        flags.push(`frontmatter missing keys: ${missing.join(', ')}`);
      if (badEnums.length > 0)
        flags.push(`frontmatter invalid enum values: ${badEnums.join(', ')}`);
    }
  }

  // repos — 15
  const repos = fm?.data.repos;
  if (
    !Array.isArray(repos) ||
    repos.length === 0 ||
    repos.some((r) => typeof r !== 'string' || r.trim() === '')
  ) {
    penalty += 15;
    flags.push('repos: empty or missing — list target repos');
  }

  // description — 15
  const desc = sectionLines(ticketMd, 'Description');
  const descText = (desc ?? []).join(' ').trim();
  if (desc === null) {
    penalty += 15;
    flags.push('no ## Description section');
  } else if (descText.length < DESCRIPTION_MIN) {
    penalty += 15;
    flags.push(`description only ${descText.length} chars (min 80)`);
  }

  // ac_present — 20; ac_verifiable — 15
  const acs = acRows(ticketMd);
  if (acs === null || acs.length === 0) {
    penalty += 20;
    flags.push('no verifiable acceptance-criteria rows');
  } else {
    let vague = 0;
    for (const ac of acs) {
      const hit = VAGUE_PATTERNS.find((p) => p.test(ac.text));
      if (hit) {
        vague++;
        const m = ac.text.match(hit);
        flags.push(`${ac.label} vague verb: '${m ? m[0].toLowerCase() : '?'}'`);
      }
    }
    if (vague > 0) penalty += 15;
  }

  // no_placeholders — 15
  const lines = ticketMd.split(/\r?\n/);
  const seen = new Set<string>();
  let placeholderHit = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === undefined) continue;
    for (const p of PLACEHOLDER_PATTERNS) {
      const m = l.match(p);
      if (m && !seen.has(`${m[0]}@${i}`)) {
        seen.add(`${m[0]}@${i}`);
        flags.push(`placeholder '${m[0]}' at line ${i + 1}`);
        placeholderHit = true;
      }
    }
  }
  if (placeholderHit) penalty += 15;

  // dod — 10 (full specs only; light tickets score these free)
  const isFullSpec =
    fm?.data.depth === 'deep' ||
    sectionLines(ticketMd, 'Requirements') !== null;
  if (isFullSpec && sectionLines(ticketMd, 'Definition of Done') === null) {
    penalty += 10;
    flags.push('full spec without ## Definition of Done section');
  }

  return { score: Math.max(0, Math.min(100, 100 - penalty)), flags };
}

/** Render the `{{SPEC_LINT}}` prompt block (SCHEMAS §15). */
export function renderSpecLint(result: SpecLintResult): string {
  const lines = [`spec_score: ${result.score}/100`, 'flags:'];
  if (result.flags.length === 0) return `${lines[0]}\nflags: none`;
  for (const f of result.flags) lines.push(`- ${f}`);
  return lines.join('\n');
}
