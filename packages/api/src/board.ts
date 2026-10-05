/**
 * api/board.ts — board surfaces (PRD §15.3, wp-144).
 *
 * Two boards, one file:
 *   - the **pipeline board** (`GET /board`, D21) — tickets grouped by a
 *     derived `phase`, each card carrying `attention` (open gate_items)
 *     and server-computed `drop_targets` (the UI only highlights; an
 *     invalid drop is rejected, never trusted client-side);
 *   - the **idea board** (§15.3 board v2) — board types as config,
 *     typed notes, multiple + org-level boards, the board → statements
 *     extraction handoff, statement-derived surfaces, spawn provenance
 *     and the ChangeSet path for approved-item changes.
 *
 * The routes are a thin shell over `conductor/semantics/board` — the
 * engine owns lifecycle legality, the note taxonomy and the handoff;
 * this file owns HTTP: zod-fail-closed bodies, workspace-qualified ids,
 * and `BoardError` → 4xx mapping.
 */
import type { ConductorWorkspace } from '@sprint-runner/conductor';
import {
  BoardError,
  acceptResurface,
  boardSources,
  boardSurface,
  boardTypeConfig,
  createBoard,
  createTypedNote,
  changeRequestForApprovedItem,
  ingestExtraction,
  proposeResurface,
  referenceApprovedItem,
  setBoardStatus,
  spawnWorkspaceFromBoard,
  statementsByItem,
  statementsForItem,
} from '@sprint-runner/conductor';
import type {
  BoardItem,
  BoardType,
  GateItem,
  Store,
  TicketRow,
} from '@sprint-runner/core';
import { BOARD_TYPES, NOTE_IMPORTANCES, NOTE_KINDS, NOTE_STATUSES } from '@sprint-runner/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface BoardRouteEnv {
  store: Store;
  actor: string;
  nowIso: () => string;
  workspace: (name: string) => ConductorWorkspace;
}

// ---------------------------------------------------------------------------
// Body schemas (fail-closed)
// ---------------------------------------------------------------------------

const WorkspaceName = z.string().min(1).max(64);
const BoardSlug = z.string().min(1).max(64);

const CreateBoardBody = z
  .object({
    workspace: WorkspaceName,
    board: BoardSlug,
    name: z.string().optional(),
    org: z.string().optional(),
    board_type: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const CreateItemBody = z
  .object({
    workspace: WorkspaceName,
    kind: z.string().optional(),
    note_kind: z.string().optional(),
    topic: z.string().optional(),
    importance: z.string().optional(),
    applies_to: z.array(z.string()).optional(),
    note_status: z.string().optional(),
    rationale: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    ref: z.string().optional(),
    zone: z.string().optional(),
    serves: z.array(z.string()).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
  })
  .passthrough();

const SetStatusBody = z
  .object({ workspace: WorkspaceName, status: z.string() })
  .passthrough();

const ResurfaceBody = z
  .object({ workspace: WorkspaceName, reason: z.string().optional() })
  .passthrough();

const SpawnBody = z
  .object({
    workspace: WorkspaceName,
    new_workspace: WorkspaceName,
    name: z.string().optional(),
    board: BoardSlug.optional(),
  })
  .passthrough();

const ReferenceBody = z
  .object({
    workspace: WorkspaceName,
    subject: z.string().min(1),
    doc: z.string().min(1),
    request: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

const ExtractBody = z
  .object({
    workspace: WorkspaceName,
    /** Full `statements.json` (`{schema, statements}`) … */
    output: z.unknown().optional(),
    /** … or just the statements array (wrapped for you). */
    statements: z.array(z.unknown()).optional(),
    item_ids: z.array(z.string()).optional(),
  })
  .passthrough();

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw new ApiError(
      400,
      'bad_request',
      `${what}: ${r.error.issues
        .map((i) => `${i.path.join('.') || '<body>'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return r.data;
}

/** `BoardError` → ApiError passthrough at the route boundary. */
async function board<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BoardError) {
      throw new ApiError(400, 'bad_request', e.message);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Pipeline board — derived phase + drop_targets (D21, API.md /board)
// ---------------------------------------------------------------------------

export const PHASES = ['backlog', 'spec', 'build', 'review', 'done'] as const;
export type Phase = (typeof PHASES)[number];

const PHASE_STATUSES: Record<Phase, readonly string[]> = {
  backlog: ['imported', 'triage', 'needs-info', 'escalated'],
  spec: [
    'prd-draft',
    'prd-review',
    'prd-approved',
    'design-qa',
    'tdd-draft',
    'tdd-review',
    'tdd-approved',
    'test-draft',
    'test-review',
    'test-approved',
  ],
  build: ['ready', 'in-progress', 'review', 'changes-requested'],
  review: ['approved', 'pr-open', 'ci-watch', 'verifying', 'verify_failed'],
  done: ['merged', 'released', 'reverted', 'wont-do', 'aborted', 'split', 'discarded'],
};

const STATUS_PHASE: Record<string, Phase> = Object.fromEntries(
  PHASES.flatMap((p) => PHASE_STATUSES[p].map((s) => [s, p])),
);

const TERMINAL = new Set(PHASE_STATUSES.done);
const IN_FLIGHT = new Set([
  'in-progress',
  'review',
  'changes-requested',
  'approved',
  'pr-open',
  'ci-watch',
  'verifying',
]);

/** A card's server-computed allowed drops — the UI only highlights;
 *  an invalid drop is rejected by the action route. */
export interface DropTarget {
  column: Phase;
  action: 'wont_do' | 'aborted' | 'retry' | 'claim';
  confirm: boolean;
}

/**
 * Phase for a ticket. `failed`/`blocked` render in the phase they died
 * in (D21) — derived from the last `status_changed` event's `from`.
 * `fallback` is used when no event history is available.
 */
export function derivePhase(
  status: string,
  lastEventFrom?: string | null,
): Phase {
  if (status === 'failed' || status === 'blocked') {
    return (
      (lastEventFrom ? STATUS_PHASE[lastEventFrom] : undefined) ?? 'backlog'
    );
  }
  return STATUS_PHASE[status] ?? 'backlog';
}

/** Allowed drag-drop targets for a card (server-authoritative, D21). */
export function dropTargets(ticket: TicketRow): DropTarget[] {
  const phase = STATUS_PHASE[ticket.status] ?? 'backlog';
  const targets: DropTarget[] = [];
  if (ticket.status === 'failed' || ticket.status === 'blocked') {
    targets.push({ column: phase, action: 'retry', confirm: true });
  }
  if (ticket.status === 'escalated') {
    targets.push({ column: phase, action: 'claim', confirm: false });
  }
  if (!TERMINAL.has(ticket.status)) {
    targets.push({
      column: 'done',
      action: IN_FLIGHT.has(ticket.status) ? 'aborted' : 'wont_do',
      confirm: true,
    });
  }
  return targets;
}

/** A non-ticket gate item (survey/import) — the ops strip, not a card. */
const TICKET_ID = /^[A-Z]+-\d+$/;

function isOpsSubject(subject: string): boolean {
  return subject.startsWith('survey:') || subject.startsWith('import:');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerBoardRoutes(
  app: FastifyInstance,
  env: BoardRouteEnv,
): void {
  const { store } = env;

  // ---- pipeline board (GET /board) ---------------------------------

  app.get('/api/v1/board', async (req) => {
    const { workspace: wsName } = req.query as { workspace?: string };
    const tickets = await store.listTickets(
      wsName ? { workspace: wsName } : {},
    );
    const gates = await store.listGateItems(
      wsName ? { workspace: wsName, open: true } : { open: true },
    );

    const attentionByTicket = new Map<string, GateItem[]>();
    const ops: GateItem[] = [];
    for (const g of gates) {
      if (isOpsSubject(g.subject) || !TICKET_ID.test(g.subject)) {
        ops.push(g);
        continue;
      }
      const list = attentionByTicket.get(g.subject) ?? [];
      list.push(g);
      attentionByTicket.set(g.subject, list);
    }

    const cards = await Promise.all(
      tickets.map(async (t) => {
        const key = `${t.workspace}/${t.ticket_id}`;
        const events =
          t.status === 'failed' || t.status === 'blocked'
            ? await store.listEvents({
                workspace: t.workspace,
                ticket_id: t.ticket_id,
                event: 'status_changed',
              })
            : [];
        const lastFrom =
          (events.at(-1)?.data as { from?: string } | undefined)?.from ?? null;
        return {
          workspace: t.workspace,
          ref: key,
          ticket_id: t.ticket_id,
          title: t.title,
          status: t.status,
          phase: derivePhase(t.status, lastFrom),
          priority: t.priority,
          attention: attentionByTicket.get(t.ticket_id) ?? [],
          drop_targets: dropTargets(t),
        };
      }),
    );

    return {
      generated_at: env.nowIso(),
      phases: PHASES.map((phase) => {
        const inPhase = cards
          .filter((c) => c.phase === phase)
          .sort(
            (a, b) =>
              b.attention.length - a.attention.length ||
              a.ticket_id.localeCompare(b.ticket_id),
          );
        return { phase, count: inPhase.length, cards: inPhase };
      }),
      ops,
    };
  });

  // ---- idea boards (§15.3) -----------------------------------------

  app.get('/api/v1/boards', async (req) => {
    const { workspace: wsName } = req.query as { workspace?: string };
    if (!wsName) throw new ApiError(400, 'bad_request', 'workspace is required');
    env.workspace(wsName);
    const boards = await store.listBoards(wsName);
    return {
      boards: boards.map((b) => ({
        ...b,
        type_config: boardTypeConfig(b.board_type as BoardType | null),
      })),
    };
  });

  app.post('/api/v1/boards', async (req, reply) => {
    const body = parse(CreateBoardBody, req.body, 'boards');
    env.workspace(body.workspace);
    const row = await board(() =>
      createBoard(store, {
        workspace: body.workspace,
        board: body.board,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.org !== undefined ? { org: body.org } : {}),
        ...(body.board_type !== undefined
          ? { board_type: body.board_type as never }
          : {}),
        ...(body.status !== undefined ? { status: body.status as never } : {}),
        actor: { id: env.actor, type: 'human' },
        now: () => new Date(),
      }),
    );
    return reply.status(201).send({ board: row });
  });

  app.get('/api/v1/boards/:board', async (req) => {
    const { board: boardSlug } = req.params as { board: string };
    const { workspace: wsName } = req.query as { workspace?: string };
    if (!wsName) throw new ApiError(400, 'bad_request', 'workspace is required');
    env.workspace(wsName);
    const row = await store.getBoard(wsName, boardSlug);
    if (!row) throw new ApiError(404, 'not_found', `no board ${wsName}/${boardSlug}`);
    const surface = await boardSurface(store, {
      workspace: wsName,
      board: boardSlug,
    });
    return {
      board: row,
      type_config: boardTypeConfig(row.board_type as BoardType | null),
      items: surface,
    };
  });

  app.post('/api/v1/boards/:board/items', async (req, reply) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(CreateItemBody, req.body, 'board item');
    env.workspace(body.workspace);
    const item = await board(() =>
      createTypedNote(store, {
        workspace: body.workspace,
        board: boardSlug,
        ...(body.kind !== undefined ? { kind: body.kind as BoardItem['kind'] } : {}),
        ...(body.note_kind !== undefined ? { note_kind: body.note_kind as never } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        ...(body.importance !== undefined
          ? { importance: body.importance as never }
          : {}),
        ...(body.applies_to !== undefined ? { applies_to: body.applies_to } : {}),
        ...(body.note_status !== undefined
          ? { note_status: body.note_status as never }
          : {}),
        ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.ref !== undefined ? { ref: body.ref } : {}),
        ...(body.zone !== undefined ? { zone: body.zone } : {}),
        ...(body.serves !== undefined ? { serves: body.serves } : {}),
        ...(body.x !== undefined ? { x: body.x } : {}),
        ...(body.y !== undefined ? { y: body.y } : {}),
        ...(body.w !== undefined ? { w: body.w } : {}),
        ...(body.h !== undefined ? { h: body.h } : {}),
        actor: { id: env.actor, type: 'human' },
        now: () => new Date(),
      }),
    );
    return reply.status(201).send({ item });
  });

  app.post('/api/v1/boards/:board/status', async (req) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(SetStatusBody, req.body, 'board status');
    env.workspace(body.workspace);
    const row = await board(() =>
      setBoardStatus(store, {
        workspace: body.workspace,
        board: boardSlug,
        status: body.status as never,
        actor: { id: env.actor, type: 'human' },
        now: () => new Date(),
      }),
    );
    return { board: row };
  });

  app.post('/api/v1/boards/:board/resurface', async (req) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(ResurfaceBody, req.body, 'board resurface');
    env.workspace(body.workspace);
    const proposal = await board(() =>
      proposeResurface(store, {
        workspace: body.workspace,
        board: boardSlug,
        reason: body.reason ?? 'circumstances changed',
        actor: { id: env.actor, type: 'agent' },
      }),
    );
    return { proposal };
  });

  app.post('/api/v1/boards/:board/resurface/accept', async (req) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(ResurfaceBody, req.body, 'board resurface accept');
    env.workspace(body.workspace);
    const row = await board(() =>
      acceptResurface(store, {
        workspace: body.workspace,
        board: boardSlug,
        actor: { id: env.actor, type: 'human' },
        now: () => new Date(),
      }),
    );
    return { board: row };
  });

  app.post('/api/v1/boards/:board/spawn', async (req, reply) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(SpawnBody, req.body, 'board spawn');
    env.workspace(body.workspace);
    const spawned = await board(() =>
      spawnWorkspaceFromBoard(store, {
        originWorkspace: body.workspace,
        originBoard: boardSlug,
        newWorkspace: body.new_workspace,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.board !== undefined ? { board: body.board } : {}),
        actor: { id: env.actor, type: 'human' },
        now: () => new Date(),
      }),
    );
    return reply.status(201).send(spawned);
  });

  app.post('/api/v1/boards/:board/extract', async (req) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(ExtractBody, req.body, 'board extract');
    env.workspace(body.workspace);
    if (body.output === undefined && body.statements === undefined) {
      throw new ApiError(
        400,
        'bad_request',
        'board extract: provide `output` (statements.json) or `statements`',
      );
    }
    const output =
      body.output ?? { schema: 1, statements: body.statements ?? [] };
    const result = await board(async () => {
      const { items, sources } = await boardSources(store, {
        workspace: body.workspace,
        board: boardSlug,
        ...(body.item_ids ? { itemIds: body.item_ids } : {}),
      });
      const res = await ingestExtraction(store, {
        workspace: body.workspace,
        subject: `board:${boardSlug}`,
        sources,
        output,
        actor: env.actor,
        now: () => new Date(),
      });
      return {
        ...res,
        itemIds: items.map((i) => i.id),
        byItem: statementsByItem(res, items.map((i) => i.id)),
      };
    });
    return { result };
  });

  app.post('/api/v1/boards/:board/reference', async (req, reply) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(ReferenceBody, req.body, 'board reference');
    env.workspace(body.workspace);
    const actor = { id: env.actor, type: 'human' as const };
    if (body.request !== undefined && body.request.trim().length > 0) {
      // Changes arrive ONLY as ChangeSets (§15.3/§15.5).
      const changeset = await board(() =>
        changeRequestForApprovedItem(store, {
          workspace: body.workspace,
          board: boardSlug,
          subject: body.subject,
          doc: body.doc,
          request: body.request as string,
          actor,
          now: () => new Date(),
        }),
      );
      return reply.status(201).send({ changeset });
    }
    const reference = await board(() =>
      referenceApprovedItem(store, {
        workspace: body.workspace,
        board: boardSlug,
        subject: body.subject,
        doc: body.doc,
        ...(body.title !== undefined ? { title: body.title } : {}),
        actor,
        now: () => new Date(),
      }),
    );
    return reply.status(201).send(reference);
  });

  // ---- statement-derived surface -----------------------------------

  app.get('/api/v1/board-items/:id/statements', async (req) => {
    const { id } = req.params as { id: string };
    const { workspace: wsName } = req.query as { workspace?: string };
    if (!wsName) throw new ApiError(400, 'bad_request', 'workspace is required');
    const item = await store.getBoardItem(id);
    if (!item || item.workspace !== wsName) {
      throw new ApiError(404, 'not_found', `no board item ${id}`);
    }
    const statements = await statementsForItem(store, {
      workspace: wsName,
      itemId: id,
    });
    return { item, statements };
  });

  // Enumerations the UI needs to render the taxonomy + type pickers.
  app.get('/api/v1/boards/meta/taxonomy', async () => ({
    board_types: BOARD_TYPES,
    note_kinds: NOTE_KINDS,
    note_importances: NOTE_IMPORTANCES,
    note_statuses: NOTE_STATUSES,
    type_config: Object.fromEntries(
      BOARD_TYPES.map((t) => [t, boardTypeConfig(t)]),
    ),
  }));
}
