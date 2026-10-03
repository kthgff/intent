/**
 * shepherd/dod.ts — Definition-of-Done at merge (CONDUCTOR "DoD at
 * merge", SCHEMAS §4).
 *
 * `test.md` carries a `## Definition of Done` table
 * (`| criterion | verified_by |`) where `verified_by` is
 * `cmd:<shell command>` (runner executes it as a verify task before
 * merge enables) or `manual` (a human attest checkbox on the
 * review/PR page).
 *
 * Attestations live in `tickets/<id>/dod-attestations.json` in the
 * tickets repo — the ticket dir is the durable store for ticket-scoped
 * state, and the DB schema (binding) has no column for it. Schema:
 *   { "schema": 1, "attested": [{ "criterion", "attested_by", "at" }] }
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DodRow } from '@sprint-runner/core';

export type { DodRow };

export const DOD_ATTESTATIONS_FILE = 'dod-attestations.json';

/** `cmd:<command>` rows execute as verify tasks; `manual` rows need a
 *  human attestation. Anything else is fail-closed unknown (it counts
 *  as neither — merge stays blocked, SCHEMAS §4 "Merge is blocked
 *  until every row's check has run"). */
export interface DodRowClassified extends DodRow {
  kind: 'cmd' | 'manual' | 'unknown';
  /** The shell command for `cmd:` rows. */
  command?: string;
}

/** Slice a `## <name>` section out of a markdown doc (up to the next
 *  heading of any depth or EOF). Null when absent. */
function sectionBody(md: string, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{2,6}\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? '');
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
  return lines.slice(start, end).join('\n');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Parse the `## Definition of Done` table rows from test.md.
 * Header/comment (`#`) lines are ignored; returns [] when the section
 * or table is absent — a missing DoD table means there is nothing to
 * verify, not a lint failure (coverage lint owns doc shape).
 */
export function parseDodRows(testMd: string): DodRowClassified[] {
  const section = sectionBody(testMd, 'Definition of Done');
  if (section === null) return [];
  const rows: DodRowClassified[] = [];
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = splitRow(t);
    // Header row / separator row.
    if (/^-{3,}:?$/.test(cells[0] ?? '') || cells[0] === 'criterion') continue;
    if (cells.length < 2 || !cells[0] || !cells[1]) continue;
    const [criterion, verified_by] = cells as [string, string];
    if (/^cmd:/i.test(verified_by)) {
      rows.push({
        criterion,
        verified_by,
        kind: 'cmd',
        command: verified_by.slice(4).trim(),
      });
    } else if (/^manual$/i.test(verified_by)) {
      rows.push({ criterion, verified_by, kind: 'manual' });
    } else {
      rows.push({ criterion, verified_by, kind: 'unknown' });
    }
  }
  return rows;
}

export interface DodAttestation {
  criterion: string;
  attested_by?: string;
  at?: string;
}

/** Read `tickets/<id>/dod-attestations.json`; missing/malformed → []
 *  (never throws — a bad file just means "nobody attested yet"). */
export async function readDodAttestations(
  ticketDir: string,
): Promise<DodAttestation[]> {
  try {
    const raw = await readFile(join(ticketDir, DOD_ATTESTATIONS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { attested?: DodAttestation[] };
    return Array.isArray(parsed.attested) ? parsed.attested : [];
  } catch {
    return [];
  }
}

/** All `manual` rows attested? (matched by criterion text). */
export function manualRowsAttested(
  rows: DodRowClassified[],
  attestations: DodAttestation[],
): boolean {
  const attested = new Set(attestations.map((a) => a.criterion));
  return rows
    .filter((r) => r.kind === 'manual')
    .every((r) => attested.has(r.criterion));
}
