/**
 * merge/bookkeeping.ts — post-merge bookkeeping (DELIVERY §2, wp-133).
 *
 * When every `ticket_repos` row is merged the ticket reaches `merged`
 * (or `reverted` for a revert PR). Four writes must land together:
 *
 *   1. `tickets.status` → merged|reverted;
 *   2. every row's `merged_sha` (source-control-confirmed, invariant 1);
 *   3. a `merged`/`reverted` event carrying `{sha, pr_url}`;
 *   4. an append to the ticket's implementation note (`notes.md`
 *      doc_version).
 *
 * They commit in ONE `store.transaction` — a crash mid-way must not
 * leave a `merged` ticket whose merge SHA or note is missing. The
 * feature-evidence recalc runs after the transaction (best-effort: a
 * missing feature row is not a merge failure).
 */
import type { FeatureStatus, TicketRepoRow, TicketRow } from '@veto/core';
import {
  type TransitionTools,
  rewriteFrontmatterStatus,
} from '../contracts.js';
import type { MergeCtx } from './types.js';

/** The implementation-note doc kind (`notes.md`, DOC_KINDS). */
export const IMPLEMENTATION_NOTE_DOC = 'notes.md' as const;

/** Feature statuses a recalc may advance (never downgrades `done`). */
const FEATURE_ADVANCE_FROM = new Set<FeatureStatus>([
  'draft',
  'ready',
  'active',
]);

/** Build the markdown section appended to the implementation note. */
export function mergeNoteSection(
  status: 'merged' | 'reverted',
  rows: TicketRepoRow[],
): string {
  const lines = [
    `## Merge — ${status}`,
    '',
    '| repo | merged_sha | pr_url |',
    '| --- | --- | --- |',
    ...rows.map(
      (r) => `| ${r.repo} | ${r.merged_sha ?? ''} | ${r.pr_url ?? ''} |`,
    ),
    '',
    markerFor(rows),
    '',
  ];
  return lines.join('\n');
}

/** Stable marker comment used to make the note append idempotent. */
function markerFor(rows: TicketRepoRow[]): string {
  const shas = rows
    .map((r) => `${r.repo}@${r.merged_sha ?? ''}`)
    .sort()
    .join(',');
  return `<!-- veto:merge ${shas} -->`;
}

export interface RecordMergedArgs {
  ctx: MergeCtx;
  tools: TransitionTools;
  ticket: TicketRow;
  /** Final `ticket_repos` rows — every row merged. */
  rows: TicketRepoRow[];
  status: 'merged' | 'reverted';
}

/**
 * Record a confirmed merge atomically. Returns the new implementation-
 * note doc version (or null when the note already carried the merge).
 */
export async function recordMerged(
  args: RecordMergedArgs,
): Promise<number | null> {
  const { ctx, ticket, rows, status } = args;
  const { deps, ws } = ctx;
  const store = deps.store;
  const id = ticket.ticket_id;
  const ts = (deps.now?.() ?? new Date()).toISOString();
  const marker = markerFor(rows);

  let noteVersion: number | null = null;
  await store.transaction(async (s) => {
    // 0. idempotency read INSIDE the tx — a concurrent merge handler
    // must not double-append the note section.
    const note = await s.getDoc({
      workspace: ws.name,
      subject: id,
      doc: IMPLEMENTATION_NOTE_DOC,
    });
    const noteContent =
      note?.content ?? `# Implementation note — ${id}\n\n`;
    const alreadyNoted = noteContent.includes(marker);
    const nextNote = alreadyNoted
      ? noteContent
      : `${noteContent.trimEnd()}\n\n${mergeNoteSection(status, rows)}`;

    // 1. status (row change + ticket.md frontmatter, D24/D29).
    const current = await s.getTicket({ workspace: ws.name, ticket_id: id });
    const from = current?.status ?? null;
    if (current && current.status !== status) {
      await s.upsertTicket({ ...current, status, updated_at: ts });
    }
    if (current) {
      const ticketDoc = await s.getDoc({
        workspace: ws.name,
        subject: id,
        doc: 'ticket.md',
      });
      if (ticketDoc?.content.startsWith('---')) {
        try {
          const next = rewriteFrontmatterStatus(
            ticketDoc.content,
            status,
            null,
          );
          if (next !== ticketDoc.content) {
            await s.appendDocVersion(
              { workspace: ws.name, subject: id, doc: 'ticket.md' },
              next,
              deps.config.actor ?? 'veto',
            );
          }
        } catch {
          /* no/malformed frontmatter — row status is truth */
        }
      }
      await s.appendEvent({
        workspace: ws.name,
        ticket_id: id,
        ts,
        stage: null,
        actor_type: 'runner',
        actor_id: deps.config.actor ?? 'veto',
        event: 'status_changed',
        run: null,
        refs: [],
        data: { from, to: status, via: 'merge-center' },
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        human_minutes: null,
      });
    }
    // 2. merged_sha per row (source-control-confirmed — invariant 1).
    for (const row of rows) {
      const existing = await s.getTicketRepo({
        workspace: ws.name,
        ticket_id: id,
        repo: row.repo,
      });
      if (existing && existing.merged_sha !== row.merged_sha) {
        await s.upsertTicketRepo({ ...existing, merged_sha: row.merged_sha });
      }
    }
    // 3. event with {sha, pr_url}.
    await s.appendEvent({
      workspace: ws.name,
      ticket_id: id,
      ts,
      stage: null,
      actor_type: 'runner',
      actor_id: deps.config.actor ?? 'veto',
      event: status,
      run: null,
      refs: rows.map((r) => `repo:${r.repo}`),
      data: {
        via: 'merge-center',
        sha: Object.fromEntries(rows.map((r) => [r.repo, r.merged_sha])),
        pr_url: Object.fromEntries(rows.map((r) => [r.repo, r.pr_url])),
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    // 4. implementation-note append (new doc version, never in place).
    if (!alreadyNoted) {
      const v = await s.appendDocVersion(
        { workspace: ws.name, subject: id, doc: IMPLEMENTATION_NOTE_DOC },
        nextNote,
        deps.config.actor ?? 'veto',
      );
      noteVersion = v.version;
    }
  });

  // Post-merge: recalc feature evidence (best-effort — never fails a merge).
  if (ticket.feature) {
    try {
      await recalcFeatureEvidence(ctx, ticket.feature);
    } catch {
      /* evidence recalc is advisory */
    }
  }
  return noteVersion;
}

/**
 * Recompute a feature's evidence rollup from its tickets: any member
 * delivered (`merged|verifying|released`) advances a pre-delivery
 * feature to `active`. The rollup NEVER writes `done` — feature
 * completion is explicit human acceptance (PRD §15.7, wp-152:
 * `acceptFeature`), never implied by ticket completion. Never
 * downgrades `done`/`discarded`.
 */
export async function recalcFeatureEvidence(
  ctx: MergeCtx,
  featureId: string,
): Promise<FeatureStatus | null> {
  const { deps, ws } = ctx;
  const store = deps.store;
  const feature = await store.getFeature(ws.name, featureId);
  if (!feature) return null;
  const tickets = (await store.listTickets({ workspace: ws.name })).filter(
    (t) => t.feature === featureId,
  );
  const delivered = tickets.filter((t) =>
    ['merged', 'verifying', 'released'].includes(t.status),
  ).length;
  let next: FeatureStatus | null = null;
  if (
    delivered > 0 &&
    FEATURE_ADVANCE_FROM.has(feature.status as FeatureStatus) &&
    feature.status !== 'active'
  ) {
    next = 'active';
  }
  if (next) {
    await store.upsertFeature({
      ...feature,
      status: next,
      updated_at: (deps.now?.() ?? new Date()).toISOString(),
    });
  }
  return next;
}
