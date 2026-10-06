/**
 * Import reconciliation (wp-139, PRD §15.3) — the layer between an
 * `import:<source>` run and autonomous development.
 *
 * Semantics:
 *   - Imported tickets land on an `import`-type board (never directly
 *     into autonomous dev). The board is created here if absent.
 *   - Items are clustered by metadata + explicit relations + embeddings
 *     ({@link clusterItems}); duplicate/conflict clusters surface as
 *     reviewable board items.
 *   - **Drift** between an imported artifact and its source of record is
 *     detected and surfaced — NEVER silently overwritten.
 *   - Completed work (source closed while the ticket is live) and
 *     clarification needs (no repo mapping / empty description) are
 *     surfaced too.
 *   - Every imported ticket gets an `import-reconcile` gate (the
 *     "reconciled flag"): a ticket cannot leave `imported` until it is
 *     clear. A ticket with NO findings auto-clears because its
 *     provenance is `source-backed` (auto-approvable); a ticket with
 *     findings is held because findings carry `inferred` provenance and
 *     `inferred` NEVER auto-approves ({@link provenanceAllowsAutoApproval}).
 *   - The provenance trail is recorded as `events` rows
 *     (`import_reconciled` / `import_drift_detected`).
 *
 * Post-reconciliation the board can convert to an ordinary enhancement
 * board with the import history preserved ({@link convertImportBoard}).
 */
import {
  type ProvenanceState,
  type ReconciliationFinding,
  type ReconciliationKind,
  type SourceRef,
  type Store,
  TERMINAL_STATUSES,
  type TicketRow,
  provenanceAllowsAutoApproval,
} from '@veto/core';
import {
  type Cluster,
  type ClusterItem,
  clusterItems,
} from '../semantics/index.js';
import { sourceFor } from './preview.js';
import type { RawIssue } from './types.js';

/** Gate instance name — the "reconciled flag" per imported ticket. */
export const IMPORT_RECONCILE_GATE = 'import-reconcile';
/** Default import-board slug + board type (§15.3 board types). */
export const DEFAULT_IMPORT_BOARD = 'import';
export const IMPORT_BOARD_TYPE = 'import' as const;

/** object_ref convention for ticket embeddings (matches kb prior-art). */
export const ticketRef = (workspace: string, ticketId: string): string =>
  `ticket:${workspace}:${ticketId}`;

export interface ReconcileImportOptions {
  workspace: string;
  store: Store;
  /** Source-of-record rows fetched from the tracker (drift comparison).
   *  Omitted → drift is skipped (re-import-only reconciliation). */
  issues?: RawIssue[];
  /** Import-board slug (default `import`). */
  board?: string;
  /** `actor:` for events (default `runner`). */
  actor?: string;
  /** Embedding model — when set, ticket vectors join the clustering. */
  embeddingModel?: string;
  /** Pairwise-similarity override (tests / alternate encoders). */
  similarity?: (a: ClusterItem, b: ClusterItem) => number;
  /** Restrict to these ticket ids (default: every `imported` ticket). */
  ticketIds?: string[];
  /** Surface the per-ticket `import-reconcile` gate (default true). */
  surfaceGates?: boolean;
}

export interface ReconcileImportResult {
  board: string;
  boardCreated: boolean;
  /** board_item ids written (ticket cards + finding notes). */
  items: string[];
  findings: ReconciliationFinding[];
  /** Tickets with no open findings — auto-reconciled (source-backed). */
  reconciled: string[];
  /** Tickets parked on an open `import-reconcile` gate (need a human). */
  blocked: string[];
}

/** Normalize whitespace for drift comparison. */
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Extract a `## <heading>` section body from a ticket.md doc. */
export function sectionBody(doc: string, heading: string): string | null {
  const re = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'im',
  );
  const m = re.exec(doc);
  if (!m) return null;
  const rest = doc.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

export interface DriftField {
  field: 'title' | 'description' | 'status';
  imported: string;
  source: string;
}

/**
 * Drift between the imported artifact (ticket row + ticket.md) and its
 * source of record (the tracker issue). Pure — no writes.
 */
export function detectDrift(
  ticket: TicketRow,
  docContent: string | null,
  issue: RawIssue,
): DriftField[] {
  const out: DriftField[] = [];
  if (norm(ticket.title) !== norm(issue.title)) {
    out.push({
      field: 'title',
      imported: norm(ticket.title),
      source: norm(issue.title),
    });
  }
  const importedBody = sectionBody(docContent ?? '', 'Description');
  if (importedBody !== null && norm(importedBody) !== norm(issue.body)) {
    out.push({
      field: 'description',
      imported: norm(importedBody),
      source: norm(issue.body),
    });
  }
  const original = ticket.source_ref?.original_status;
  if (
    original &&
    issue.state &&
    norm(original).toLowerCase() !== norm(issue.state).toLowerCase()
  ) {
    out.push({
      field: 'status',
      imported: norm(original),
      source: norm(issue.state),
    });
  }
  return out;
}

/** Stable board_item id for a ticket card on the import board. */
export const ticketCardId = (ticketId: string): string =>
  `import-ticket-${ticketId}`;
/** Stable board_item id for a finding (idempotent upserts). */
export const findingCardId = (kind: ReconciliationKind, key: string): string =>
  `recon-${kind}-${key}`;

const NOTE_KIND_FOR: Record<string, string> = {
  duplicate: 'problem',
  conflict: 'problem',
  drift: 'problem',
  completed: 'decision',
  clarification: 'question',
};

function findingKey(f: {
  subject?: string | null;
  related: string[];
}): string {
  const ids = [f.subject ?? '', ...f.related].filter(Boolean).sort();
  return ids.join('--') || 'board';
}

interface BuiltFinding {
  finding: ReconciliationFinding;
  cardId: string;
}

function buildFinding(args: {
  workspace: string;
  kind: ReconciliationKind;
  subject: string | null;
  related: string[];
  detail: string;
  provenance: ReconciliationFinding['provenance'];
  sourceRef?: SourceRef | null;
  now: string;
}): BuiltFinding {
  const key = findingKey({ subject: args.subject, related: args.related });
  const id = findingCardId(args.kind, key);
  return {
    cardId: id,
    finding: {
      id,
      workspace: args.workspace,
      kind: args.kind,
      decision: 'open',
      provenance: args.provenance,
      subject: args.subject,
      related: args.related,
      detail: args.detail,
      source_ref: args.sourceRef ?? null,
      created_at: args.now,
      resolved_at: null,
    },
  };
}

/**
 * Reconcile imported tickets. Idempotent: re-running upserts the same
 * board items + gates and records a fresh provenance-trail event.
 */
export async function reconcileImport(
  opts: ReconcileImportOptions,
): Promise<ReconcileImportResult> {
  const { workspace, store } = opts;
  const actor = opts.actor ?? 'runner';
  const board = opts.board ?? DEFAULT_IMPORT_BOARD;
  const surfaceGates = opts.surfaceGates !== false;
  const now = new Date().toISOString();

  // ---- 1. ensure the import board exists ----
  let boardCreated = false;
  const existingBoard = await store.getBoard(workspace, board);
  if (!existingBoard) {
    await store.upsertBoard({
      workspace,
      org: null,
      board,
      name: board,
      board_type: IMPORT_BOARD_TYPE,
      status: 'discovery',
      created_at: now,
    });
    boardCreated = true;
  }

  // ---- 2. load the imported tickets under reconciliation ----
  const allImported = await store.listTickets({
    workspace,
    status: 'imported',
  });
  const wanted = opts.ticketIds ? new Set(opts.ticketIds) : null;
  const tickets = allImported.filter((t) => !wanted || wanted.has(t.ticket_id));

  const issueBySource = new Map<string, RawIssue>();
  for (const issue of opts.issues ?? [])
    issueBySource.set(sourceFor(issue), issue);

  const items: string[] = [];
  const findings: ReconciliationFinding[] = [];
  const reconciled: string[] = [];
  const blocked: string[] = [];

  const emit = async (
    event: 'import_reconciled' | 'import_drift_detected',
    ticketId: string | null,
    data: Record<string, unknown>,
  ) => {
    await store.appendEvent({
      workspace,
      ticket_id: ticketId,
      ts: new Date().toISOString(),
      stage: 'import',
      actor_type: 'runner',
      actor_id: actor,
      event,
      refs: [],
      data,
    });
  };

  // ---- 3. per-ticket review (drift / completed / clarification) ----
  for (const ticket of tickets) {
    const cardId = ticketCardId(ticket.ticket_id);
    await store.upsertBoardItem({
      id: cardId,
      workspace,
      org: null,
      board,
      kind: 'ticket',
      ref: ticket.ticket_id,
      title: ticket.title,
      body: null,
      x: null,
      y: null,
      w: null,
      h: null,
      zone: null,
      serves: null,
      status: 'active',
      consumed_by: null,
      note_kind: null,
      topic: null,
      importance: null,
      applies_to: null,
      note_status: null,
      rationale: null,
      // Imported from a source of record → source-backed provenance.
      provenance: 'source-backed',
      created_at: now,
      updated_at: now,
    });
    items.push(cardId);

    const ticketFindings: BuiltFinding[] = [];
    const issue = ticket.source ? issueBySource.get(ticket.source) : undefined;

    // 3a. drift vs source of record.
    if (issue) {
      const doc = await store.getDoc({
        workspace,
        subject: ticket.ticket_id,
        doc: 'ticket.md',
      });
      const drift = detectDrift(ticket, doc?.content ?? null, issue);
      if (drift.length > 0) {
        const built = buildFinding({
          workspace,
          kind: 'drift',
          subject: ticket.ticket_id,
          related: [],
          detail: drift
            .map(
              (d) =>
                `${d.field}: imported "${d.imported}" ≠ source "${d.source}"`,
            )
            .join('; '),
          provenance: 'inferred',
          sourceRef: ticket.source_ref ?? null,
          now,
        });
        ticketFindings.push(built);
        await emit('import_drift_detected', ticket.ticket_id, {
          source: ticket.source,
          fields: drift.map((d) => d.field),
        });
      }

      // 3b. completed work: source closed while the ticket is live.
      const isClosed = /^closed$/i.test(issue.state ?? '');
      const ticketTerminal = (TERMINAL_STATUSES as readonly string[]).includes(
        ticket.status,
      );
      if (isClosed && !ticketTerminal) {
        ticketFindings.push(
          buildFinding({
            workspace,
            kind: 'completed',
            subject: ticket.ticket_id,
            related: [],
            detail: `source ${ticket.source} is CLOSED but the imported ticket is still live`,
            provenance: 'source-backed',
            sourceRef: ticket.source_ref ?? null,
            now,
          }),
        );
      }
    }

    // 3c. clarification needs: unmapped repo / empty description.
    if (ticket.repos.length === 0) {
      ticketFindings.push(
        buildFinding({
          workspace,
          kind: 'clarification',
          subject: ticket.ticket_id,
          related: [],
          detail:
            'no repo mapped — triage must confirm which repo(s) this touches',
          provenance: 'inferred',
          sourceRef: ticket.source_ref ?? null,
          now,
        }),
      );
    }

    // 3d. surface findings + the reconcile gate.
    for (const built of ticketFindings) {
      await store.upsertBoardItem({
        id: built.cardId,
        workspace,
        org: null,
        board,
        kind: 'note',
        ref: ticket.ticket_id,
        title: `${built.finding.kind}: ${ticket.ticket_id}`,
        body: built.finding.detail,
        x: null,
        y: null,
        w: null,
        h: null,
        zone: null,
        serves: null,
        status: 'active',
        consumed_by: null,
        note_kind: NOTE_KIND_FOR[built.finding.kind] ?? 'problem',
        topic: built.finding.kind,
        importance: 'must',
        applies_to: [ticket.ticket_id],
        note_status: 'open',
        rationale: `reconciliation finding (${built.finding.provenance})`,
        provenance: built.finding.provenance,
        created_at: now,
        updated_at: now,
      });
      items.push(built.cardId);
      findings.push(built.finding);
      await emit('import_reconciled', ticket.ticket_id, {
        finding: built.cardId,
        kind: built.finding.kind,
        decision: 'open',
        provenance: built.finding.provenance,
      });
    }

    // 3e. the reconciled flag: no findings → auto-clear (source-backed);
    //     findings → hold for a human (inferred never auto-approves).
    const hasBlocking = ticketFindings.length > 0;
    if (surfaceGates) {
      if (hasBlocking) {
        await store.upsertGateItem({
          workspace,
          subject: ticket.ticket_id,
          gate: IMPORT_RECONCILE_GATE,
          kind: 'review',
          surfaced_at: now,
          blocked_agent: true,
        });
      } else {
        // Auto-reconciled — clear any stale gate.
        const gate = await store.getGateItem({
          workspace,
          subject: ticket.ticket_id,
          gate: IMPORT_RECONCILE_GATE,
        });
        if (gate && !gate.cleared_at) {
          await store.clearGateItem(
            {
              workspace,
              subject: ticket.ticket_id,
              gate: IMPORT_RECONCILE_GATE,
            },
            now,
          );
        }
      }
    }
    if (hasBlocking) blocked.push(ticket.ticket_id);
    else reconciled.push(ticket.ticket_id);
  }

  // ---- 4. clustering: duplicates + conflicts across imported tickets ----
  const clusterInput: ClusterItem[] = [];
  for (const ticket of tickets) {
    const embedding =
      opts.embeddingModel != null
        ? await loadEmbedding(
            store,
            workspace,
            ticket.ticket_id,
            opts.embeddingModel,
          )
        : null;
    const doc = await store.getDoc({
      workspace,
      subject: ticket.ticket_id,
      doc: 'ticket.md',
    });
    clusterInput.push({
      id: ticket.ticket_id,
      title: ticket.title,
      body: doc ? sectionBody(doc.content, 'Description') : null,
      repos: ticket.repos,
      relations: [
        ...(ticket.parent ? [ticket.parent] : []),
        ...(ticket.depends_on ?? []),
      ].filter((id) => tickets.some((t) => t.ticket_id === id)),
      embedding,
    });
  }
  const clusters: Cluster[] = clusterItems(
    clusterInput,
    opts.similarity ? { similarity: opts.similarity } : {},
  );
  for (const cluster of clusters) {
    const [a, b] = cluster.members;
    const kind: ReconciliationKind = cluster.duplicate
      ? 'duplicate'
      : 'conflict';
    const detail = cluster.duplicate
      ? `possible duplicate (${cluster.reason}, similarity ${cluster.similarity.toFixed(2)}): ${cluster.members.join(', ')}`
      : `overlapping/conflicting work (${cluster.reason}): ${cluster.members.join(', ')}`;
    const built = buildFinding({
      workspace,
      kind,
      subject: a ?? null,
      related: cluster.members.filter((m) => m !== a),
      detail,
      provenance: 'inferred',
      sourceRef: null,
      now,
    });
    await store.upsertBoardItem({
      id: built.cardId,
      workspace,
      org: null,
      board,
      kind: 'note',
      ref: a ?? null,
      title: `${kind}: ${b ?? ''} ↔ ${a ?? ''}`,
      body: detail,
      x: null,
      y: null,
      w: null,
      h: null,
      zone: null,
      serves: null,
      status: 'active',
      consumed_by: null,
      note_kind: NOTE_KIND_FOR[kind] ?? 'problem',
      topic: kind,
      importance: 'should',
      applies_to: cluster.members,
      note_status: 'open',
      rationale: 'reconciliation finding (inferred)',
      provenance: 'inferred',
      created_at: now,
      updated_at: now,
    });
    items.push(built.cardId);
    findings.push(built.finding);
    await emit('import_reconciled', a ?? null, {
      finding: built.cardId,
      kind,
      decision: 'open',
      provenance: 'inferred',
      members: cluster.members,
    });
  }

  return { board, boardCreated, items, findings, reconciled, blocked };
}

/** Load a ticket's embedding vector for clustering (null when absent). */
async function loadEmbedding(
  store: Store,
  workspace: string,
  ticketId: string,
  model: string,
): Promise<number[] | null> {
  const e = await store.getEmbedding({
    object_ref: ticketRef(workspace, ticketId),
    model,
  });
  if (!e) return null;
  return Array.from(e.vector);
}

export interface ResolveFindingOptions {
  workspace: string;
  store: Store;
  findingId: string;
  decision: Exclude<ReconciliationFinding['decision'], 'open'>;
  /** `actor:` recording the human decision. */
  actor?: string;
  /** True when the caller is a human (a human decision re-proves the
   *  item → `stakeholder-verified`). Non-human callers may NOT resolve
   *  an `inferred` finding (wp-139: inferred never auto-approves). */
  human?: boolean;
}

export interface ResolveFindingResult {
  finding: ReconciliationFinding;
  /** Ticket's reconcile gate cleared (all its findings resolved). */
  gateCleared: boolean;
}

/**
 * Record a human decision against a finding. Rejects an automatic
 * resolution of an `inferred` finding — provenance enforcement
 * (`inferred` never auto-approves).
 */
export async function resolveReconciliationFinding(
  opts: ResolveFindingOptions,
): Promise<ResolveFindingResult> {
  const { workspace, store, findingId, decision } = opts;
  const now = new Date().toISOString();
  const actor = opts.actor ?? 'human';
  const card = await store.getBoardItem(findingId);
  if (!card) throw new Error(`reconciliation finding not found: ${findingId}`);

  // Provenance enforcement: inferred findings need a human.
  if (
    !opts.human &&
    !provenanceAllowsAutoApproval(card.provenance as ProvenanceState | null)
  ) {
    throw new Error(
      `finding ${findingId} has provenance '${card.provenance}' — inferred findings cannot be auto-resolved`,
    );
  }

  const kind = (card.topic ?? 'duplicate') as ReconciliationKind;
  const finding: ReconciliationFinding = {
    id: findingId,
    workspace,
    kind,
    decision,
    // A human decision re-proves the item.
    provenance: opts.human
      ? 'stakeholder-verified'
      : (card.provenance ?? 'source-backed'),
    subject: card.ref ?? null,
    related: (card.applies_to ?? []).filter((r) => r !== card.ref),
    detail: card.body ?? '',
    source_ref: null,
    created_at: card.created_at ?? now,
    resolved_at: now,
  };

  await store.upsertBoardItem({
    ...card,
    note_status: 'resolved',
    provenance: finding.provenance,
    updated_at: now,
  });
  await store.appendEvent({
    workspace,
    ticket_id: finding.subject,
    ts: now,
    stage: 'import',
    actor_type: opts.human ? 'human' : 'system',
    actor_id: actor,
    event: 'import_reconciled',
    refs: [],
    data: {
      finding: findingId,
      kind,
      decision,
      provenance: finding.provenance,
    },
  });

  // Clear the ticket's reconcile gate when no open findings remain.
  let gateCleared = false;
  if (finding.subject) {
    const siblings = await store.listBoardItems({
      workspace,
      board: card.board ?? DEFAULT_IMPORT_BOARD,
      kind: 'note',
    });
    const openForSubject = siblings.filter(
      (s) =>
        s.ref === finding.subject &&
        s.note_status === 'open' &&
        s.id !== findingId,
    );
    if (openForSubject.length === 0) {
      const gate = await store.getGateItem({
        workspace,
        subject: finding.subject,
        gate: IMPORT_RECONCILE_GATE,
      });
      if (gate && !gate.cleared_at) {
        await store.clearGateItem(
          { workspace, subject: finding.subject, gate: IMPORT_RECONCILE_GATE },
          now,
        );
        gateCleared = true;
      }
    }
  }

  return { finding, gateCleared };
}

/**
 * Post-reconciliation conversion (§15.3): the import board becomes an
 * ordinary board (default `enhancement`) with all import history
 * preserved (board items + events are untouched).
 */
export async function convertImportBoard(opts: {
  workspace: string;
  store: Store;
  board?: string;
  to?: 'enhancement' | 'modernization' | 'quality';
  actor?: string;
}): Promise<{ board: string; board_type: string }> {
  const { workspace, store } = opts;
  const slug = opts.board ?? DEFAULT_IMPORT_BOARD;
  const to = opts.to ?? 'enhancement';
  const board = await store.getBoard(workspace, slug);
  if (!board) throw new Error(`board not found: ${slug}`);
  await store.upsertBoard({ ...board, board_type: to, status: 'approved' });
  await store.appendEvent({
    workspace,
    ticket_id: null,
    ts: new Date().toISOString(),
    stage: 'import',
    actor_type: 'human',
    actor_id: opts.actor ?? 'human',
    event: 'import_reconciled',
    refs: [],
    data: { board: slug, converted_to: to, from: board.board_type },
  });
  return { board: slug, board_type: to };
}
