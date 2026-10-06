/**
 * shepherd/dod.ts — Definition-of-Done at merge (CONDUCTOR "DoD at
 * merge", SCHEMAS §4).
 *
 * `vs.md` carries a `## Definition of Done` table
 * (`| criterion | verified_by |`) where `verified_by` is
 * `cmd:<shell command>` (runner executes it as a verify task before
 * merge enables) or `manual` (a human attest checkbox on the
 * review/PR page).
 *
 * Attestations are a `doc_versions` doc on the ticket subject —
 * `dod-attestations.json` (D29: no ticket dir on disk; the human
 * attestation writer appends a new doc version via putDoc). Schema:
 *   { "schema": 1, "attested": [{ "criterion", "attested_by", "at" }] }
 */
import type { DocKind, DodRow } from '@veto/core';
import type { TransitionTools } from '../contracts.js';

export type { DodRow };

/** doc_versions doc kind carrying human DoD attestations. */
export const DOD_ATTESTATIONS_DOC: DocKind = 'dod-attestations.json';

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
 * Parse the `## Definition of Done` table rows from vs.md.
 * Header/comment (`#`) lines are ignored; returns [] when the section
 * or table is absent — a missing DoD table means there is nothing to
 * verify, not a lint failure (coverage lint owns doc shape).
 */
export function parseDodRows(vsMd: string): DodRowClassified[] {
  const section = sectionBody(vsMd, 'Definition of Done');
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

/** Read the latest `dod-attestations.json` doc version for a ticket;
 *  missing/malformed → [] (never throws — a bad doc just means
 *  "nobody attested yet"). */
export async function readDodAttestations(
  docs: Pick<TransitionTools, 'getDocText'>,
  subject: string,
): Promise<DodAttestation[]> {
  try {
    const raw = await docs.getDocText(subject, DOD_ATTESTATIONS_DOC);
    if (raw === null) return [];
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

// ---------------------------------------------------------------------------
// wp-153 DoD engine — per-check evaluation (PRD §15.10)
// ---------------------------------------------------------------------------

/** Per-check verdict for one DoD row. `pending`/`unattested`/`unverified`
 *  keep merge disabled; `unknown` is fail-closed (an unspellable
 *  `verified_by` can never count as done); `failed` means the cmd row
 *  ran and did not pass — it surfaces a `dod-failed` gate item and is
 *  not retried automatically. */
export interface DodCheckStatus {
  criterion: string;
  verified_by: string;
  kind: 'cmd' | 'manual' | 'unknown';
  status:
    | 'verified'
    | 'attested'
    | 'unverified'
    | 'unattested'
    | 'failed'
    | 'unknown';
}

/** Statuses that satisfy a check (merge may enable). */
const DOD_OK = new Set(['verified', 'attested']);

/**
 * Per-check evaluation for merge/release readiness (wp-153): each
 * `cmd:` row reads its verify result from `cmdResults` (shepherd
 * state), each `manual` row needs a human attestation row in
 * `dod-attestations.json`, `unknown` rows always fail closed.
 */
export function dodCheckStatuses(
  rows: readonly DodRowClassified[],
  cmdResults: Readonly<Record<string, { status?: string } | undefined>>,
  attestations: readonly DodAttestation[],
): DodCheckStatus[] {
  const attested = new Set(attestations.map((a) => a.criterion));
  return rows.map((r) => {
    if (r.kind === 'cmd') {
      const st = cmdResults[r.criterion]?.status;
      return {
        criterion: r.criterion,
        verified_by: r.verified_by,
        kind: r.kind,
        status:
          st === 'verified'
            ? 'verified'
            : st === 'failed'
              ? 'failed'
              : 'unverified',
      };
    }
    if (r.kind === 'manual') {
      return {
        criterion: r.criterion,
        verified_by: r.verified_by,
        kind: r.kind,
        status: attested.has(r.criterion) ? 'attested' : 'unattested',
      };
    }
    return {
      criterion: r.criterion,
      verified_by: r.verified_by,
      kind: r.kind,
      status: 'unknown',
    };
  });
}

/** Every check satisfied? (empty row set → true — nothing to verify). */
export function dodChecksClear(checks: readonly DodCheckStatus[]): boolean {
  return checks.every((c) => DOD_OK.has(c.status));
}
