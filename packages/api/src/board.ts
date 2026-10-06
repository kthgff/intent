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
import type { ConductorWorkspace } from '@veto/conductor';
import {
  BoardError,
  acceptResurface,
  boardSources,
  boardSurface,
  boardTypeConfig,
  changeRequestForApprovedItem,
  createBoard,
  createTypedNote,
  ingestExtraction,
  proposeResurface,
  referenceApprovedItem,
  setBoardStatus,
  spawnWorkspaceFromBoard,
  statementsByItem,
  statementsForItem,
} from '@veto/conductor';
import type { BoardItem, BoardType, Store } from '@veto/core';
import {
  BOARD_TYPES,
  NOTE_IMPORTANCES,
  NOTE_KINDS,
  NOTE_STATUSES,
} from '@veto/core';
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
// Routes — idea boards (§15.3). The pipeline board (GET /board) lives in
// server.ts — it is the S-01 surface and shares that file's ranking,
// derivePhase, and drop_targets helpers.
// ---------------------------------------------------------------------------

export function registerBoardRoutes(
  app: FastifyInstance,
  env: BoardRouteEnv,
): void {
  const { store } = env;

  app.get('/api/v1/boards', async (req) => {
    const { workspace: wsName } = req.query as { workspace?: string };
    if (!wsName)
      throw new ApiError(400, 'bad_request', 'workspace is required');
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
    if (!wsName)
      throw new ApiError(400, 'bad_request', 'workspace is required');
    env.workspace(wsName);
    const row = await store.getBoard(wsName, boardSlug);
    if (!row)
      throw new ApiError(404, 'not_found', `no board ${wsName}/${boardSlug}`);
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
        ...(body.kind !== undefined
          ? { kind: body.kind as BoardItem['kind'] }
          : {}),
        ...(body.note_kind !== undefined
          ? { note_kind: body.note_kind as never }
          : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        ...(body.importance !== undefined
          ? { importance: body.importance as never }
          : {}),
        ...(body.applies_to !== undefined
          ? { applies_to: body.applies_to }
          : {}),
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
    const output = body.output ?? {
      schema: 1,
      statements: body.statements ?? [],
    };
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
        byItem: statementsByItem(
          res,
          items.map((i) => i.id),
        ),
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
    if (!wsName)
      throw new ApiError(400, 'bad_request', 'workspace is required');
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
