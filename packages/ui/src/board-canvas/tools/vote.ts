/**
 * tools/vote.ts — vote tally + session helpers (TOOLS-TDD §2.4).
 *
 * Votes are signals only: tallies derive from `board_item_votes` rows
 * and display as badges; nothing here ever writes `importance`.
 * Badge visibility gates on an open session (or the caller's
 * `?votes=show` override — then the *latest* session's votes show).
 */
import type { BoardVote, BoardVoteSession } from '@veto/core';

export interface VoteTally {
  up: number;
  down: number;
  question: number;
}

/** The open session when one exists, else the most recently created
 *  (deterministic by `created_at` then id). */
export function currentSession(
  sessions: BoardVoteSession[],
): BoardVoteSession | null {
  const sorted = [...sessions].sort(
    (a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? '') ||
      a.id.localeCompare(b.id),
  );
  const open = sorted.filter((s) => s.status === 'open');
  return open.at(-1) ?? sorted.at(-1) ?? null;
}

export function openSession(
  sessions: BoardVoteSession[],
): BoardVoteSession | null {
  const s = currentSession(sessions);
  return s?.status === 'open' ? s : null;
}

/** Per-item stamp counts for one session's votes. */
export function tallyByItem(votes: BoardVote[]): Map<string, VoteTally> {
  const map = new Map<string, VoteTally>();
  for (const v of votes) {
    const t = map.get(v.item_id) ?? { up: 0, down: 0, question: 0 };
    // Server-enforced closed enum; the schema type widens to string.
    const stamp = v.stamp as keyof VoteTally;
    if (stamp === 'up' || stamp === 'down' || stamp === 'question') {
      t[stamp] += 1;
    }
    map.set(v.item_id, t);
  }
  return map;
}

/**
 * The tallies the canvas should display — `null` means badges hide.
 * Badges show while a session is open, or under `showAll` for the
 * latest session's results (the `?votes=show` deep link).
 */
export function visibleTallies(
  votes: BoardVote[],
  sessions: BoardVoteSession[],
  showAll: boolean,
): Map<string, VoteTally> | null {
  const open = openSession(sessions);
  if (open) return tallyByItem(votes.filter((v) => v.session_id === open.id));
  if (!showAll) return null;
  const latest = currentSession(sessions);
  if (!latest) return null;
  return tallyByItem(votes.filter((v) => v.session_id === latest.id));
}
