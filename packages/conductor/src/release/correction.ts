/**
 * release/correction.ts — correction tickets (DELIVERY §2 + invariant
 * 7, wp-134).
 *
 * Post-merge defects are ordinary `tickets` rows — `origin:
 * 'correction'`, `parent:` the merged ticket, `work_type: 'bug'`. No
 * new table. They never alter the merged ticket's history or AC
 * verdicts; they carry their own lifecycle. An OPEN material
 * correction (blocker|critical|major, or ungraded — fail-closed)
 * blocks the `corrections` release gate of any release containing the
 * parent.
 */
import {
  TERMINAL_STATUSES,
  type TicketPriority,
  type TicketRow,
  type TicketSeverity,
} from '@veto/core';
import { isMaterialCorrection } from '@veto/lints';
import { type ReleaseCtx, ReleaseError } from './types.js';

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/** Corrections are filed against work that has actually merged — a
 *  pre-merge defect is just a normal ticket (or a review finding). */
const CORRECTABLE_STATUSES = new Set<string>(['merged', 'released']);

export interface FileCorrectionArgs {
  /** The merged/released ticket the defect is against. */
  parent: string;
  title: string;
  /** Unset severity is legal but counts as MATERIAL (fail-closed —
   *  an ungraded defect is never assumed non-blocking). */
  severity?: TicketSeverity | null;
  priority?: TicketPriority;
  /** Defaults to the parent's repos / feature. */
  repos?: string[];
  feature?: string | null;
  /** Optional body text — appended under "## Description". */
  description?: string;
  /** `blocked_reason` surface, e.g. when the defect is itself blocked. */
  blockedReason?: string | null;
}

/** Open (non-terminal) corrections filed against `parent`. */
export async function listCorrections(
  ctx: ReleaseCtx,
  parent: string,
): Promise<TicketRow[]> {
  const tickets = await ctx.store.listTickets({ workspace: ctx.workspace });
  return tickets.filter(
    (t) => t.origin === 'correction' && t.parent === parent,
  );
}

/** Open MATERIAL corrections against any of `memberIds` — the
 *  `corrections` gate's blocking set. */
export async function openBlockingCorrections(
  ctx: ReleaseCtx,
  memberIds: string[],
): Promise<{ parent: string; correction: TicketRow }[]> {
  const members = new Set(memberIds);
  const tickets = await ctx.store.listTickets({ workspace: ctx.workspace });
  return tickets
    .filter(
      (t) =>
        t.origin === 'correction' &&
        t.parent != null &&
        members.has(t.parent) &&
        !TERMINAL.has(t.status) &&
        isMaterialCorrection(t.severity),
    )
    .map((t) => ({ parent: t.parent as string, correction: t }));
}

/**
 * File a correction ticket against a merged/released ticket. Emits
 * `correction_filed` on the PARENT (the defect hangs off the shipped
 * work, not the fix). Returns the new ticket row.
 */
export async function fileCorrection(
  ctx: ReleaseCtx,
  args: FileCorrectionArgs,
): Promise<TicketRow> {
  const parent = await ctx.store.getTicket({
    workspace: ctx.workspace,
    ticket_id: args.parent,
  });
  if (!parent) {
    throw new ReleaseError(
      'not-found',
      `correction parent ${args.parent}: no tickets row`,
    );
  }
  if (!CORRECTABLE_STATUSES.has(parent.status)) {
    throw new ReleaseError(
      'bad-state',
      `correction parent ${args.parent} is '${parent.status}' — corrections attach to merged|released work (DELIVERY §2)`,
    );
  }

  const ts = ctx.now().toISOString();
  const id = await ctx.store.allocTicketId(ctx.workspace);
  const row: TicketRow = {
    workspace: ctx.workspace,
    ticket_id: id,
    feature:
      args.feature === undefined ? (parent.feature ?? null) : args.feature,
    title: args.title,
    status: 'imported',
    priority: args.priority ?? parent.priority ?? 'medium',
    depth: parent.depth ?? null,
    backend: parent.backend ?? null,
    model: parent.model ?? null,
    repos: args.repos ?? parent.repos,
    parent: parent.ticket_id,
    depends_on: [],
    serves: parent.serves ?? null,
    source: parent.source ?? null,
    work_type: 'bug',
    origin: 'correction',
    severity: args.severity ?? null,
    source_ref: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: args.blockedReason ?? null,
    created_at: ts,
    updated_at: ts,
  };

  const frontmatter = [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: ${args.title}`,
    'status: imported',
    `priority: ${row.priority}`,
    'work_type: bug',
    'origin: correction',
    ...(row.severity ? [`severity: ${row.severity}`] : []),
    `parent: ${parent.ticket_id}`,
    `repos: [${row.repos.join(', ')}]`,
    '---',
    '',
    '## Description',
    args.description ??
      `Correction filed against ${parent.ticket_id} (${parent.title}).`,
    '',
  ].join('\n');

  await ctx.store.transaction(async (store) => {
    await store.upsertTicket(row);
    await store.appendDocVersion(
      { workspace: ctx.workspace, subject: id, doc: 'ticket.md' },
      frontmatter,
      ctx.actor,
    );
    await store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: parent.ticket_id,
      ts,
      stage: null,
      actor_type: 'human',
      actor_id: ctx.actor,
      event: 'correction_filed',
      run: null,
      refs: [id],
      data: {
        correction: id,
        severity: row.severity ?? null,
        material: isMaterialCorrection(row.severity),
        title: args.title,
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
  });
  return row;
}
