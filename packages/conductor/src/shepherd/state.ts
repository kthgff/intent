/**
 * shepherd/state.ts — per-PR shepherd bookkeeping, persisted as a
 * plain fs file under the workspace scratch dir:
 * `<rootPath>/.veto/shepherd/<ticketId>.json`.
 *
 * The DB schema is binding and `ticket_repos` has no columns for
 * cycle counters / seen comments / DoD verification. D29: there
 * is no tickets repo and no `tickets/<id>/` dir on disk, so this
 * runner bookkeeping lives in the workspace's `.veto/` scratch area
 * (deps.ts `stateDir`). It is NOT durable truth and gets no git
 * commits — Postgres holds the truth rows; this is poll-cursor state
 * that can be rebuilt by re-polling.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConductorWorkspace } from '../loop/deps.js';
import { stateDir } from '../loop/deps.js';

/** `.veto/` subdir holding the per-ticket shepherd state files. */
export const SHEPHERD_STATE_DIR = 'shepherd';

/** Absolute path of `<rootPath>/.veto/shepherd/<ticketId>.json`. */
export function shepherdStatePath(
  ws: ConductorWorkspace,
  ticketId: string,
): string {
  return stateDir(ws, SHEPHERD_STATE_DIR, `${ticketId}.json`);
}

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

export async function loadShepherdFile(
  ws: ConductorWorkspace,
  ticketId: string,
): Promise<{
  file: ShepherdFile;
  raw: string | null;
}> {
  try {
    const raw = await readFile(shepherdStatePath(ws, ticketId), 'utf8');
    const parsed = JSON.parse(raw) as ShepherdFile;
    if (typeof parsed !== 'object' || parsed === null) {
      return { file: emptyShepherdFile(), raw };
    }
    return { file: { schema: 1, prs: parsed.prs ?? {} }, raw };
  } catch {
    return { file: emptyShepherdFile(), raw: null };
  }
}

/** Write `<ticketId>.json`; returns false when nothing changed (the
 *  file is only written when the state moved). mkdir -p first — the
 *  `.veto/shepherd/` dir may not exist yet on a fresh workspace. */
export async function saveShepherdFile(
  ws: ConductorWorkspace,
  ticketId: string,
  file: ShepherdFile,
  previousRaw: string | null,
): Promise<boolean> {
  const next = `${JSON.stringify(file, null, 2)}\n`;
  if (next === previousRaw) return false;
  const path = shepherdStatePath(ws, ticketId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, 'utf8');
  return true;
}

export function prState(file: ShepherdFile, repo: string): PrShepherdState {
  const existing = file.prs[repo];
  if (existing) return existing;
  const created: PrShepherdState = { cycles: 0, seen_comment_ids: [] };
  file.prs[repo] = created;
  return created;
}
