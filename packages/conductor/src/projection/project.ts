/**
 * Ticket projection — rebuild `tickets`/`ticket_repos` rows from git
 * frontmatter (wp-013; CONDUCTOR reconcile step 1, DB-SCHEMA ticket
 * projections "rebuilt from git frontmatter on every pull").
 *
 * Read-only w.r.t. ticket truth: status transitions are never written
 * here — the projection mirrors whatever frontmatter git holds.
 *
 * - One `tickets` row per parsed ticket; one `ticket_repos` row per
 *   `repos[]` entry. On re-project the per-repo run state (`pr_url`,
 *   `pr_state`, `ci_state`, `merged_sha`, `branch`, `worktree`) is
 *   preserved — frontmatter doesn't carry it, so the projection
 *   null-guards rather than clobbering.
 * - `spec_hash` = sha256 of the ticket.md contents. DB-SCHEMA hashes
 *   "spec inputs at spec completion"; spec docs land in a later wp, so
 *   ticket.md is the only input for now.
 * - Malformed ticket → `gate_items` row (kind `failure`) + notification
 *   carrying the parse detail; the remaining tickets still project.
 * - Projection rows whose `tickets/<id>/` dir vanished are deleted.
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store, TicketRepoRow } from '@sprint-runner/core';
import { parseTicketFile } from './parse.js';

/** Gate instance name for malformed-ticket failures (matches
 *  `claims.gate`/`gate_items.gate` semantics — a human clears it by
 *  fixing the ticket.md). */
export const PARSE_FAILURE_GATE = 'ticket-parse';

export interface ProjectionFailure {
  /** tickets/<dir> that failed (ticket id may be unrecoverable). */
  subject: string;
  path: string;
  error: string;
}

export interface ProjectionSummary {
  /** ticket_ids upserted this pass. */
  projected: string[];
  failed: ProjectionFailure[];
  /** ticket_ids whose projection rows were deleted (dir vanished). */
  removed: string[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Scan `<ticketsRepoPath>/tickets/∗/ticket.md` and rebuild the
 * `tickets`/`ticket_repos` projections for `workspace`.
 */
export async function projectTickets(
  ticketsRepoPath: string,
  store: Store,
  workspace: string,
): Promise<ProjectionSummary> {
  const ticketsDir = join(ticketsRepoPath, 'tickets');
  const now = new Date().toISOString();
  const summary: ProjectionSummary = {
    projected: [],
    failed: [],
    removed: [],
  };

  let dirs: string[] = [];
  try {
    dirs = (await readdir(ticketsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // No tickets dir → nothing to project; stale rows still removed below.
  }

  const seen = new Set<string>();

  for (const dir of dirs) {
    const path = join(ticketsDir, dir, 'ticket.md');
    const parsed = await parseTicketFile(path);

    if (!parsed.ok) {
      summary.failed.push({
        subject: dir,
        path,
        error: parsed.error.error,
      });
      await store.upsertGateItem({
        workspace,
        subject: dir,
        gate: PARSE_FAILURE_GATE,
        kind: 'failure',
        surfaced_at: now,
        blocked_agent: true,
      });
      // gate_items has no detail column (DB-SCHEMA) — the parse error
      // rides along as the notification payload.
      await store.insertNotification({
        workspace,
        subject: dir,
        kind: 'gate:failure',
        payload: JSON.stringify({
          gate: PARSE_FAILURE_GATE,
          path,
          error: parsed.error.error,
        }),
        created_at: now,
      });
      continue;
    }

    const fm = parsed.value.frontmatter;
    seen.add(fm.id);

    await store.upsertTicket({
      workspace,
      ticket_id: fm.id,
      title: fm.title,
      status: fm.status,
      priority: fm.priority,
      depth: fm.depth,
      backend: fm.backend ?? null,
      model: fm.model ?? null,
      repos: fm.repos,
      parent: fm.parent ?? null,
      depends_on: fm.depends_on,
      spec_score: null,
      spec_hash: sha256(parsed.value.raw),
      blocked_reason: fm.blocked_reason ?? null,
      updated_at: now,
    });

    // ticket_repos: one row per repos[] entry. Frontmatter carries no
    // branch/worktree/pr/ci — preserve whatever the run stages wrote;
    // null-guard so re-projection never clobbers live state.
    const key = { workspace, ticket_id: fm.id };
    const existing = await store.listTicketRepos(key);
    const wanted = new Set(fm.repos);
    const keep = existing.filter((r) => wanted.has(r.repo));
    const byRepo = new Map(keep.map((r) => [r.repo, r]));

    await store.deleteTicketRepos(key);
    for (const repo of fm.repos) {
      const prev = byRepo.get(repo);
      const row: TicketRepoRow = {
        workspace,
        ticket_id: fm.id,
        repo,
        branch: prev?.branch ?? null,
        worktree: prev?.worktree ?? null,
        pr_url: prev?.pr_url ?? null,
        pr_state: prev?.pr_state ?? null,
        ci_state: prev?.ci_state ?? null,
        merged_sha: prev?.merged_sha ?? null,
      };
      await store.upsertTicketRepo(row);
    }

    summary.projected.push(fm.id);
  }

  // Delete projections whose ticket dir vanished (DB-SCHEMA rebuildable
  // rule — git is the truth).
  const projected = await store.listTickets({ workspace });
  for (const row of projected) {
    if (seen.has(row.ticket_id)) continue;
    const key = { workspace, ticket_id: row.ticket_id };
    await store.deleteTicketRepos(key);
    await store.deleteTicket(key);
    summary.removed.push(row.ticket_id);
  }

  return summary;
}
