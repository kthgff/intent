/**
 * shepherd/state.ts — per-PR shepherd state, persisted in the ticket
 * dir as `tickets/<id>/shepherd.json`.
 *
 * The DB schema is binding and `ticket_repos` has no columns for
 * cycle counters / seen comments / DoD verification — and DB rows are
 * rebuildable projections anyway (DB-SCHEMA "Rebuildable"). Durable
 * shepherd state therefore lives next to the ticket, committed by the
 * conductor like every other ticket artifact.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SHEPHERD_FILE = 'shepherd.json';

/** Per-PR (ticket_repos row) shepherd bookkeeping. */
export interface PrShepherdState {
  /** ci-fix runs dispatched for this PR (shepherd_max_cycles budget). */
  cycles: number;
  /** Fingerprint of the last failing-check set we queued a ci-fix for
   *  — same fingerprint → don't requeue (the fix is in flight or the
   *  push hasn't landed). */
  last_failure_fingerprint?: string;
  /** Comment ids already handed to a comment-fix run. */
  seen_comment_ids: (string | number)[];
  /** Cycle cap hit — escalation surfaced; stop polling this PR. */
  escalated?: boolean;
  /** DoD `cmd:` row results keyed by criterion text. */
  dod?: Record<
    string,
    {
      status: 'verified' | 'failed';
      /** Run dir (relative) holding the verify logs/report. */
      run_dir?: string;
      at?: string;
    }
  >;
}

export interface ShepherdFile {
  schema: 1;
  /** Keyed by ticket_repos.repo. */
  prs: Record<string, PrShepherdState>;
}

export function emptyShepherdFile(): ShepherdFile {
  return { schema: 1, prs: {} };
}

export async function loadShepherdFile(ticketDir: string): Promise<{
  file: ShepherdFile;
  raw: string | null;
}> {
  try {
    const raw = await readFile(join(ticketDir, SHEPHERD_FILE), 'utf8');
    const parsed = JSON.parse(raw) as ShepherdFile;
    if (typeof parsed !== 'object' || parsed === null) {
      return { file: emptyShepherdFile(), raw };
    }
    return { file: { schema: 1, prs: parsed.prs ?? {} }, raw };
  } catch {
    return { file: emptyShepherdFile(), raw: null };
  }
}

/** Write shepherd.json; returns false when nothing changed (avoids
 *  commit spam — the file is only written when the state moved). */
export async function saveShepherdFile(
  ticketDir: string,
  file: ShepherdFile,
  previousRaw: string | null,
): Promise<boolean> {
  const next = `${JSON.stringify(file, null, 2)}\n`;
  if (next === previousRaw) return false;
  await writeFile(join(ticketDir, SHEPHERD_FILE), next, 'utf8');
  return true;
}

export function prState(file: ShepherdFile, repo: string): PrShepherdState {
  const existing = file.prs[repo];
  if (existing) return existing;
  const created: PrShepherdState = { cycles: 0, seen_comment_ids: [] };
  file.prs[repo] = created;
  return created;
}
