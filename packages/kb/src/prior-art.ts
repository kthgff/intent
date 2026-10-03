/**
 * Prior-art recall (PRD "the ledger learns"; ADAPTERS {{PRIOR_ART}}) —
 * injected into triage/interview/design prompts. v1 match = file
 * overlap against past tickets' recorded file plans + embedding
 * similarity over `ticket:*` embedding rows.
 *
 * Storage conventions (this package owns them — ontology-lite over the
 * §12 tables):
 * - file index: `relations(subject='ticket:<ws>:<id>', predicate=
 *   'documents', object='file:<path>')` — the ticket's plan documents
 *   these files; written by {@link recordTicketFiles} when a tdd.md
 *   file plan lands.
 * - embeddings: `object_ref='ticket:<ws>:<id>'` over the ticket's
 *   title + file list, written by {@link indexTicket}.
 *
 * `prior_art_recall: false` or `embeddings: off` degrade gracefully:
 * file-overlap needs no vectors at all.
 */
import type { Store, TicketRow } from '@sprint-runner/core';
import type { Embedder } from './embeddings.js';

/** object_ref / relation-subject prefix for ticket rows. */
export const ticketRef = (workspace: string, ticketId: string): string =>
  `ticket:${workspace}:${ticketId}`;

const FILE_PREFIX = 'file:';

/**
 * Record a ticket's file plan into the KB index. Call when a tdd.md
 * file plan is approved/materialized — this is what makes the plan
 * queryable by later tickets' prior-art recall.
 */
export async function recordTicketFiles(
  store: Store,
  key: { workspace: string; ticket_id: string },
  files: string[],
): Promise<void> {
  const subject = ticketRef(key.workspace, key.ticket_id);
  for (const f of files) {
    await store.upsertRelation({
      subject,
      predicate: 'documents',
      object: `${FILE_PREFIX}${f}`,
      source: 'file-plan',
    });
  }
}

/** Store the ticket's embedding (title + files) for similarity recall. */
export async function indexTicket(
  store: Store,
  embedder: Embedder,
  ticket: {
    workspace: string;
    ticket_id: string;
    title: string;
    files?: string[];
  },
): Promise<void> {
  const text = [ticket.title, ...(ticket.files ?? [])].join('\n');
  const vector = await embedder.embed(text);
  if (vector === null) return; // embeddings: off — nothing to write
  await store.upsertEmbedding({
    object_ref: ticketRef(ticket.workspace, ticket.ticket_id),
    model: embedder.model,
    vector: Array.from(vector),
  });
}

export interface PriorArtHit {
  ticket: string;
  kind: 'file-overlap' | 'similar';
  detail: string;
}

export interface PriorArtOpts {
  /** `prior_art_recall` setting — false → empty block. */
  enabled?: boolean;
  /** Embedder for similarity matches; null/off → file-overlap only. */
  embedder?: Embedder | null;
  /** Max hits to render. */
  limit?: number;
  /** Cosine-distance ceiling for embedding matches. */
  maxDistance?: number;
}

/**
 * Render the {{PRIOR_ART}} token body. Returns '' when disabled or no
 * hits — the token degrades to an empty block rather than noise.
 */
export async function priorArt(
  ticket: {
    workspace: string;
    ticket_id: string;
    title: string;
    files?: string[];
  },
  store: Store,
  opts: PriorArtOpts = {},
): Promise<string> {
  if (opts.enabled === false) return '';
  const limit = opts.limit ?? 5;
  const hits: PriorArtHit[] = [];
  const self = ticketRef(ticket.workspace, ticket.ticket_id);
  const seen = new Set<string>();

  // 1. File-overlap: past tickets whose plans touched the same files.
  if (ticket.files?.length) {
    const mine = new Set(ticket.files.map((f) => `${FILE_PREFIX}${f}`));
    const byTicket = new Map<string, Set<string>>();
    for (const r of await store.listRelations({ predicate: 'documents' })) {
      if (!r.subject.startsWith('ticket:')) continue;
      if (r.subject === self) continue;
      if (!r.object.startsWith(FILE_PREFIX)) continue;
      let set = byTicket.get(r.subject);
      if (!set) {
        set = new Set();
        byTicket.set(r.subject, set);
      }
      if (mine.has(r.object)) set.add(r.object.slice(FILE_PREFIX.length));
    }
    for (const [ref, overlap] of byTicket) {
      if (overlap.size === 0) continue;
      hits.push({
        ticket: ref,
        kind: 'file-overlap',
        detail: `touched ${[...overlap].join(', ')}`,
      });
      seen.add(ref);
    }
  }

  // 2. Embedding similarity — only when a live embedder is configured.
  if (opts.embedder) {
    const text = [ticket.title, ...(ticket.files ?? [])].join('\n');
    const vector = await opts.embedder.embed(text);
    if (vector !== null && vector.length > 0) {
      const maxDistance = opts.maxDistance ?? 0.4;
      const nearest = await store.nearestEmbeddings({
        model: opts.embedder.model,
        vector: Array.from(vector),
        limit: limit + 1,
      });
      for (const n of nearest) {
        if (n.object_ref === self || seen.has(n.object_ref)) continue;
        if (n.distance > maxDistance) continue;
        hits.push({
          ticket: n.object_ref,
          kind: 'similar',
          detail: `similarity distance ${n.distance.toFixed(3)}`,
        });
      }
    }
  }

  if (hits.length === 0) return '';
  const titles = new Map<string, string>();
  for (const h of hits.slice(0, limit)) {
    const [, ws, id] = h.ticket.split(':');
    if (ws && id) {
      const t = await store.getTicket({ workspace: ws, ticket_id: id });
      if (t) titles.set(h.ticket, t.title);
    }
  }
  const lines = hits.slice(0, limit).map((h) => {
    const title = titles.get(h.ticket);
    const label = title ? `${h.ticket} "${title}"` : h.ticket;
    return `- ${label} (${h.kind}: ${h.detail})`;
  });
  return ['## Prior art', ...lines].join('\n');
}

/** Ticket row → priorArt input (helper for conductor call sites). */
export function ticketPriorArtInput(
  row: TicketRow,
  files: string[],
): { workspace: string; ticket_id: string; title: string; files: string[] } {
  return {
    workspace: row.workspace,
    ticket_id: row.ticket_id,
    title: row.title,
    files,
  };
}
