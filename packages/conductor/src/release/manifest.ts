/**
 * release/manifest.ts — scope → manifest materialization (DELIVERY
 * §3, wp-134).
 *
 * A manifest freezes `item → [{repo, ticket, merged_sha}]`: for each
 * live release item it resolves member tickets (the ticket itself, or
 * a feature's non-dead member tickets) and their `ticket_repos`
 * merged SHAs. The digest (`releaseManifestDigest`) is over the
 * canonical form, so the same scope always cuts the same digest.
 */
import type {
  ReleaseItemRow,
  ReleaseManifestItem,
  TicketRow,
} from '@veto/core';
import { type ReleaseCtx, ReleaseError } from './types.js';

/** Member statuses excluded from a feature's membership — the ticket
 *  will never ship, so it isn't scope and can't block. `reverted`
 *  stays a member on purpose: a reverted merge inside a release is a
 *  live problem the `merged` gate must see. */
const DEAD_MEMBER_STATUSES = new Set<string>([
  'discarded',
  'split',
  'aborted',
  'wont-do',
]);

/** All member tickets for one release item, resolved live.
 *  `item_kind:'ticket'` → the ticket row (missing → fail-closed).
 *  `item_kind:'feature'` → workspace tickets whose `feature` is the
 *  item id, minus dead members. */
export async function resolveItemTickets(
  ctx: ReleaseCtx,
  item: Pick<ReleaseItemRow, 'item_kind' | 'item_id'>,
): Promise<TicketRow[]> {
  if (item.item_kind === 'ticket') {
    const ticket = await ctx.store.getTicket({
      workspace: ctx.workspace,
      ticket_id: item.item_id,
    });
    if (!ticket) {
      throw new ReleaseError(
        'not-found',
        `release item ${item.item_id}: no tickets row`,
      );
    }
    return DEAD_MEMBER_STATUSES.has(ticket.status) ? [] : [ticket];
  }
  const tickets = await ctx.store.listTickets({ workspace: ctx.workspace });
  return tickets.filter(
    (t) => t.feature === item.item_id && !DEAD_MEMBER_STATUSES.has(t.status),
  );
}

/** Member tickets across a whole manifest's items (deduped). */
export async function resolveManifestMembers(
  ctx: ReleaseCtx,
  items: Pick<ReleaseManifestItem, 'item_kind' | 'item_id'>[],
): Promise<TicketRow[]> {
  const byId = new Map<string, TicketRow>();
  for (const item of items) {
    for (const t of await resolveItemTickets(ctx, item)) {
      byId.set(t.ticket_id, t);
    }
  }
  return [...byId.values()];
}

/** Build the manifest `items` payload for the release's live scope:
 *  per item, one `{repo, ticket, merged_sha}` entry per member
 *  ticket's `ticket_repos` row. Sorted output — the digest is stable
 *  regardless, but deterministic rows keep manifest diffs readable. */
export async function buildManifestItems(
  ctx: ReleaseCtx,
  items: ReleaseItemRow[],
): Promise<ReleaseManifestItem[]> {
  const out: ReleaseManifestItem[] = [];
  for (const item of items) {
    const tickets = await resolveItemTickets(ctx, item);
    const repos: ReleaseManifestItem['repos'] = [];
    for (const ticket of tickets) {
      for (const row of await ctx.store.listTicketRepos({
        workspace: ctx.workspace,
        ticket_id: ticket.ticket_id,
      })) {
        repos.push({
          repo: row.repo,
          ticket: ticket.ticket_id,
          merged_sha: row.merged_sha ?? null,
        });
      }
    }
    repos.sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) ||
        (a.ticket ?? '').localeCompare(b.ticket ?? ''),
    );
    out.push({
      item_kind: item.item_kind,
      item_id: item.item_id,
      ...(item.partial_ac != null ? { partial_ac: item.partial_ac } : {}),
      repos,
    });
  }
  return out;
}
