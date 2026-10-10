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
import { randomUUID } from 'node:crypto';
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
import type {
  BoardAnnotation,
  BoardAnnotationKind,
  BoardConnector,
  BoardItem,
  BoardType,
  BoardVote,
  BoardVoteSession,
  Store,
} from '@veto/core';
import {
  BOARD_ANNOTATION_KINDS,
  BOARD_CONNECTOR_STATUSES,
  BOARD_ITEM_COLORS,
  BOARD_ITEM_KINDS,
  BOARD_TYPES,
  NOTE_IMPORTANCES,
  NOTE_KINDS,
  NOTE_STATUSES,
  VOTE_STAMPS,
  annotationGeometrySchema,
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
  notify?: (event: { type: string; payload: unknown }) => void;
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
  .strict();

const CreateItemBody = z
  .object({
    workspace: WorkspaceName,
    kind: z.enum(BOARD_ITEM_KINDS).optional(),
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
    color: z.enum(BOARD_ITEM_COLORS).nullable().optional(),
    z_index: z.number().int().optional(),
  })
  .strict();

const ItemPatch = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
    y: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
    w: z.number().finite().min(40).max(10_000).optional(),
    h: z.number().finite().min(40).max(10_000).optional(),
    zone: z.string().max(120).nullable().optional(),
    color: z.enum(BOARD_ITEM_COLORS).nullable().optional(),
    z_index: z.number().int().min(-100_000).max(100_000).optional(),
    title: z.string().max(500).nullable().optional(),
    body: z.string().max(100_000).nullable().optional(),
    // Easy Edit (D62) — semantic fields for bulk triage. `board` is
    // further constrained in the route: null (→ tray) or the request's
    // own slug; cross-board moves are rejected.
    note_kind: z.enum(NOTE_KINDS).nullable().optional(),
    importance: z.enum(NOTE_IMPORTANCES).nullable().optional(),
    note_status: z.enum(NOTE_STATUSES).optional(),
    board: z.string().max(64).nullable().optional(),
    // Frame-presentation ordering (TOOLS-TDD §2.5) — zone items only;
    // enforced in the route.
    presentation_order: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .nullable()
      .optional(),
    // Canvas-legitimate status moves only — soft-delete (discarded),
    // restore (active), park (icebox). consumed/frozen/shipped belong to
    // synthesis + ship flows that set consumed_by; the canvas may not
    // mint them (D57).
    status: z.enum(['active', 'icebox', 'discarded']).optional(),
  })
  .strict();

const BatchItemsBody = z
  .object({
    workspace: WorkspaceName,
    mutations: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            expected_updated_at: z.string().min(1),
            patch: ItemPatch,
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

const CreateConnectorBody = z
  .object({
    workspace: WorkspaceName,
    source_item_id: z.string().min(1).max(120),
    target_item_id: z.string().min(1).max(120),
    label: z.string().max(500).optional(),
  })
  .strict();

const PatchConnectorBody = z
  .object({
    workspace: WorkspaceName,
    label: z.string().max(500).nullable().optional(),
    status: z.enum(BOARD_CONNECTOR_STATUSES).optional(),
    expected_updated_at: z.string().min(1),
  })
  .strict();

// ---- canvas tool extensions (BOARD-CANVAS-TOOLS-TDD §2.7) ----

const CreateAnnotationBody = z
  .object({
    workspace: WorkspaceName,
    kind: z.enum(BOARD_ANNOTATION_KINDS),
    /** Validated per-kind by `annotationGeometrySchema` — >2k-point
     *  strokes, wrong-shape geometry, and non-finite coords all
     *  fail closed here. */
    geometry: z.unknown(),
    color: z.enum(BOARD_ITEM_COLORS).nullable().optional(),
  })
  .strict();

const PatchAnnotationBody = z
  .object({
    workspace: WorkspaceName,
    expected_updated_at: z.string().min(1),
    kind: z.enum(BOARD_ANNOTATION_KINDS).optional(),
    geometry: z.unknown().optional(),
    color: z.enum(BOARD_ITEM_COLORS).nullable().optional(),
  })
  .strict();

const OpenVoteSessionBody = z
  .object({
    workspace: WorkspaceName,
    closes_at: z.string().max(64).nullable().optional(),
  })
  .strict();

const PatchVoteSessionBody = z
  .object({
    workspace: WorkspaceName,
    expected_updated_at: z.string().min(1),
    status: z.enum(['closed']),
  })
  .strict();

const CastVoteBody = z
  .object({
    workspace: WorkspaceName,
    session_id: z.string().min(1).max(120),
    item_id: z.string().min(1).max(120),
    stamp: z.enum(VOTE_STAMPS),
  })
  .strict();

/** BOARD-CANVAS-TDD fail-closed guards shared by the create and patch
 *  paths. Image items cannot exist without an asset row, and the upload
 *  route is disabled until a patched multipart plugin exists for the
 *  pinned Fastify major — so `kind: 'image'` writes are refused
 *  everywhere. */
export function assertCanvasItemKind(kind: string | undefined): void {
  if (kind === 'image') {
    throw new ApiError(
      400,
      'bad_request',
      'image items require the asset upload route, which is disabled in this release',
    );
  }
}

/** `ref` on a link-kind item must be a http/https URL (no SSRF — link
 *  metadata is never fetched, but the target scheme is still pinned). */
export function assertCanvasItemRef(
  kind: string | null | undefined,
  ref: string | null | undefined,
): void {
  if (kind !== 'link') return;
  let url: URL | null = null;
  try {
    url = ref ? new URL(ref) : null;
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new ApiError(
      400,
      'bad_request',
      'link items require a ref URL with http: or https:',
    );
  }
}

const SetStatusBody = z
  .object({ workspace: WorkspaceName, status: z.string() })
  .strict();

const ResurfaceBody = z
  .object({ workspace: WorkspaceName, reason: z.string().optional() })
  .strict();

const SpawnBody = z
  .object({
    workspace: WorkspaceName,
    new_workspace: WorkspaceName,
    name: z.string().optional(),
    board: BoardSlug.optional(),
  })
  .strict();

const ReferenceBody = z
  .object({
    workspace: WorkspaceName,
    subject: z.string().min(1),
    doc: z.string().min(1),
    request: z.string().optional(),
    title: z.string().optional(),
  })
  .strict();

const ExtractBody = z
  .object({
    workspace: WorkspaceName,
    /** Full `statements.json` (`{schema, statements}`) … */
    output: z.unknown().optional(),
    /** … or just the statements array (wrapped for you). */
    statements: z.array(z.unknown()).optional(),
    item_ids: z.array(z.string()).optional(),
  })
  .strict();

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

/** Kind↔geometry pairing validated against the shared contract —
 *  malformed, oversized (>2k points), or wrong-shape payloads fail
 *  closed with a human-readable 400 (TOOLS-TDD §2.6). */
function parseGeometry(
  kind: BoardAnnotationKind,
  raw: unknown,
): BoardAnnotation['geometry'] {
  const r = annotationGeometrySchema(kind).safeParse(raw);
  if (!r.success) {
    throw new ApiError(
      400,
      'bad_request',
      `annotation geometry (${kind}): ${r.error.issues
        .map((i) => `${i.path.join('.') || '<geometry>'} ${i.message}`)
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
  // Same `notification`-frame convention as discovery.ts — other open
  // clients re-read durable board/item state on any mutation here.
  const boardItemTouched = (
    ws: string,
    itemId: string | null,
    board: string | null,
  ) =>
    env.notify?.({
      type: 'notification',
      payload: {
        kind: 'board_item_updated',
        workspace: ws,
        item_id: itemId,
        board,
      },
    });

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
    boardItemTouched(body.workspace, null, row.board);
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
      connectors: await store.listBoardConnectors({
        workspace: wsName,
        board: boardSlug,
        status: 'active',
      }),
      annotations: await store.listBoardAnnotations({
        workspace: wsName,
        board: boardSlug,
      }),
      votes: await store.listBoardVotes({
        workspace: wsName,
        board: boardSlug,
      }),
      vote_sessions: await store.listBoardVoteSessions({
        workspace: wsName,
        board: boardSlug,
      }),
    };
  });

  app.post('/api/v1/boards/:board/items', async (req, reply) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(CreateItemBody, req.body, 'board item');
    env.workspace(body.workspace);
    assertCanvasItemKind(body.kind);
    assertCanvasItemRef(body.kind ?? 'note', body.ref ?? null);
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
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.z_index !== undefined ? { z_index: body.z_index } : {}),
        actor: { id: env.actor, type: 'human' },
        now: () => new Date(),
      }),
    );
    boardItemTouched(body.workspace, item.id, item.board ?? boardSlug);
    return reply.status(201).send({ item });
  });

  app.patch('/api/v1/boards/:board/items', async (req) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(BatchItemsBody, req.body, 'board item batch');
    env.workspace(body.workspace);
    const now = env.nowIso();
    const items = await store.transaction(async (tx) => {
      const out: BoardItem[] = [];
      for (const mutation of body.mutations) {
        const item = await tx.getBoardItem(mutation.id);
        if (
          !item ||
          item.workspace !== body.workspace ||
          item.board !== boardSlug
        ) {
          throw new ApiError(
            404,
            'not_found',
            `no board item ${mutation.id} on ${body.workspace}/${boardSlug}`,
          );
        }
        if (item.status === 'consumed' || item.status === 'frozen') {
          throw new ApiError(
            409,
            'conflict',
            `board item ${item.id} is ${item.status} — consumed items are immutable`,
          );
        }
        if (item.updated_at !== mutation.expected_updated_at) {
          throw new ApiError(
            409,
            'conflict',
            `board item ${item.id} changed since your read`,
          );
        }
        const p = mutation.patch;
        // `board` may only clear to tray or repeat this slug — a real
        // cross-board move is a different flow (D62).
        if (
          p.board !== undefined &&
          p.board !== null &&
          p.board !== boardSlug
        ) {
          throw new ApiError(
            400,
            'bad_request',
            `batch patches may only move items to the tray or keep board ${boardSlug}`,
          );
        }
        // Zone membership must point at an active zone item on this
        // board (or null to unzone) — never a free-form label.
        if (p.zone !== undefined && p.zone !== null) {
          const zoneItem = await tx.getBoardItem(p.zone);
          if (
            !zoneItem ||
            zoneItem.workspace !== body.workspace ||
            zoneItem.board !== boardSlug ||
            zoneItem.kind !== 'zone' ||
            zoneItem.status !== 'active'
          ) {
            throw new ApiError(
              400,
              'bad_request',
              `zone ${p.zone} is not an active zone item on this board`,
            );
          }
          if (zoneItem.id === item.id) {
            throw new ApiError(
              400,
              'bad_request',
              'an item cannot be its own zone',
            );
          }
        }
        // presentation_order is zone-only (TOOLS-TDD §2.5) — non-null
        // values on other kinds are rejected, clearing is always legal.
        if (
          p.presentation_order !== undefined &&
          p.presentation_order !== null &&
          item.kind !== 'zone'
        ) {
          throw new ApiError(
            400,
            'bad_request',
            'presentation_order applies to zone items only',
          );
        }
        const next: BoardItem = {
          ...item,
          ...(p.x !== undefined ? { x: p.x } : {}),
          ...(p.y !== undefined ? { y: p.y } : {}),
          ...(p.w !== undefined ? { w: p.w } : {}),
          ...(p.h !== undefined ? { h: p.h } : {}),
          ...(p.zone !== undefined ? { zone: p.zone } : {}),
          ...(p.color !== undefined ? { color: p.color } : {}),
          ...(p.z_index !== undefined ? { z_index: p.z_index } : {}),
          ...(p.presentation_order !== undefined
            ? { presentation_order: p.presentation_order }
            : {}),
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.body !== undefined ? { body: p.body } : {}),
          ...(p.note_kind !== undefined ? { note_kind: p.note_kind } : {}),
          ...(p.importance !== undefined ? { importance: p.importance } : {}),
          ...(p.note_status !== undefined
            ? { note_status: p.note_status }
            : {}),
          ...(p.board !== undefined ? { board: p.board } : {}),
          ...(p.status !== undefined ? { status: p.status } : {}),
          updated_at: now,
        };
        const updated = await tx.updateBoardItemExpected(
          next,
          mutation.expected_updated_at,
        );
        if (!updated) {
          throw new ApiError(
            409,
            'conflict',
            `board item ${item.id} changed concurrently`,
          );
        }
        out.push(updated);
      }
      return out;
    });
    boardItemTouched(body.workspace, null, boardSlug);
    return { items };
  });

  app.post('/api/v1/boards/:board/connectors', async (req, reply) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(CreateConnectorBody, req.body, 'board connector');
    env.workspace(body.workspace);
    if (body.source_item_id === body.target_item_id) {
      throw new ApiError(
        400,
        'bad_request',
        'connector cannot link an item to itself',
      );
    }
    const [source, target] = await Promise.all([
      store.getBoardItem(body.source_item_id),
      store.getBoardItem(body.target_item_id),
    ]);
    for (const item of [source, target]) {
      if (
        !item ||
        item.workspace !== body.workspace ||
        item.board !== boardSlug
      ) {
        throw new ApiError(
          400,
          'bad_request',
          'connector endpoints must be on this board',
        );
      }
      if (item.status !== 'active') {
        throw new ApiError(
          409,
          'conflict',
          'connector endpoints must be active',
        );
      }
    }
    const duplicate = (
      await store.listBoardConnectors({
        workspace: body.workspace,
        board: boardSlug,
        status: 'active',
      })
    ).some(
      (c) =>
        c.source_item_id === body.source_item_id &&
        c.target_item_id === body.target_item_id,
    );
    if (duplicate) {
      throw new ApiError(409, 'conflict', 'connector already exists');
    }
    const ts = env.nowIso();
    const connector: BoardConnector = {
      id: `bc-${randomUUID().slice(0, 12)}`,
      workspace: body.workspace,
      board: boardSlug,
      source_item_id: body.source_item_id,
      target_item_id: body.target_item_id,
      label: body.label ?? null,
      status: 'active',
      created_at: ts,
      updated_at: ts,
    };
    await store.upsertBoardConnector(connector);
    boardItemTouched(body.workspace, null, boardSlug);
    return reply.status(201).send({ connector });
  });

  /** OCC-fenced connector update — label (and active/superseded
   *  lifecycle). Endpoints are immutable: redraw the connector instead
   *  of silently rebinding what it points at. */
  app.patch('/api/v1/boards/:board/connectors/:id', async (req, reply) => {
    const { board: boardSlug, id } = req.params as {
      board: string;
      id: string;
    };
    const body = parse(PatchConnectorBody, req.body, 'board connector');
    env.workspace(body.workspace);
    const conn = await store.getBoardConnector(id);
    if (
      !conn ||
      conn.workspace !== body.workspace ||
      conn.board !== boardSlug
    ) {
      throw new ApiError(
        404,
        'not_found',
        `no connector ${id} on ${body.workspace}/${boardSlug}`,
      );
    }
    if (conn.updated_at !== body.expected_updated_at) {
      throw new ApiError(
        409,
        'conflict',
        `connector ${id} changed since your read`,
      );
    }
    const next: BoardConnector = {
      ...conn,
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      updated_at: env.nowIso(),
    };
    const updated = await store.updateBoardConnectorExpected(
      next,
      body.expected_updated_at,
    );
    if (!updated) {
      throw new ApiError(
        409,
        'conflict',
        `connector ${id} changed concurrently`,
      );
    }
    boardItemTouched(body.workspace, null, boardSlug);
    return reply.send({ connector: updated });
  });

  /** Supersede — connectors are never hard-deleted once created
   *  (topology history stays auditable). */
  app.delete('/api/v1/boards/:board/connectors/:id', async (req, reply) => {
    const { board: boardSlug, id } = req.params as {
      board: string;
      id: string;
    };
    const { workspace: wsName } = req.query as { workspace?: string };
    const ws = env.workspace(parse(WorkspaceName, wsName, 'workspace'));
    const conn = await store.getBoardConnector(id);
    if (!conn || conn.workspace !== ws.name || conn.board !== boardSlug) {
      throw new ApiError(
        404,
        'not_found',
        `no connector ${id} on ${ws.name}/${boardSlug}`,
      );
    }
    const next: BoardConnector = {
      ...conn,
      status: 'superseded',
      updated_at: env.nowIso(),
    };
    let updated: BoardConnector | null;
    if (conn.updated_at) {
      updated = await store.updateBoardConnectorExpected(next, conn.updated_at);
    } else {
      await store.upsertBoardConnector(next);
      updated = next;
    }
    boardItemTouched(ws.name, null, boardSlug);
    return reply.send({ connector: updated });
  });

  // ---- drawing layer (BOARD-CANVAS-TOOLS-TDD §2.6) ------------------
  // Annotations are SVG-layer rows, never board_items — same bearer
  // auth, OCC fence, and SSE broadcast as every other canvas write.

  app.post('/api/v1/boards/:board/annotations', async (req, reply) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(CreateAnnotationBody, req.body, 'board annotation');
    env.workspace(body.workspace);
    const geometry = parseGeometry(
      body.kind as BoardAnnotationKind,
      body.geometry,
    );
    const ts = env.nowIso();
    const annotation: BoardAnnotation = {
      id: `ba-${randomUUID().slice(0, 12)}`,
      workspace: body.workspace,
      board: boardSlug,
      kind: body.kind,
      geometry,
      color: body.color ?? null,
      created_by: env.actor,
      created_at: ts,
      updated_at: ts,
    };
    await store.upsertBoardAnnotation(annotation);
    boardItemTouched(body.workspace, null, boardSlug);
    return reply.status(201).send({ annotation });
  });

  app.patch('/api/v1/boards/:board/annotations/:id', async (req, reply) => {
    const { board: boardSlug, id } = req.params as {
      board: string;
      id: string;
    };
    const body = parse(PatchAnnotationBody, req.body, 'board annotation');
    env.workspace(body.workspace);
    const ann = await store.getBoardAnnotation(id);
    if (!ann || ann.workspace !== body.workspace || ann.board !== boardSlug) {
      throw new ApiError(
        404,
        'not_found',
        `no annotation ${id} on ${body.workspace}/${boardSlug}`,
      );
    }
    if (ann.updated_at !== body.expected_updated_at) {
      throw new ApiError(
        409,
        'conflict',
        `annotation ${id} changed since your read`,
      );
    }
    const nextKind = body.kind ?? ann.kind;
    const next: BoardAnnotation = {
      ...ann,
      kind: nextKind,
      // Geometry is re-validated against the *resulting* kind — a
      // kind+geometry pair can never disagree after a patch.
      ...(body.geometry !== undefined
        ? {
            geometry: parseGeometry(
              nextKind as BoardAnnotationKind,
              body.geometry,
            ),
          }
        : body.kind !== undefined
          ? {
              geometry: parseGeometry(
                nextKind as BoardAnnotationKind,
                ann.geometry,
              ),
            }
          : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      updated_at: env.nowIso(),
    };
    const updated = await store.updateBoardAnnotationExpected(
      next,
      body.expected_updated_at,
    );
    if (!updated) {
      throw new ApiError(
        409,
        'conflict',
        `annotation ${id} changed concurrently`,
      );
    }
    boardItemTouched(body.workspace, null, boardSlug);
    return reply.send({ annotation: updated });
  });

  /** Drawings are not governed artifacts — a real delete is legal. */
  app.delete('/api/v1/boards/:board/annotations/:id', async (req, reply) => {
    const { board: boardSlug, id } = req.params as {
      board: string;
      id: string;
    };
    const { workspace: wsName } = req.query as { workspace?: string };
    const ws = env.workspace(parse(WorkspaceName, wsName, 'workspace'));
    const ann = await store.getBoardAnnotation(id);
    if (!ann || ann.workspace !== ws.name || ann.board !== boardSlug) {
      throw new ApiError(
        404,
        'not_found',
        `no annotation ${id} on ${ws.name}/${boardSlug}`,
      );
    }
    await store.deleteBoardAnnotation(id);
    boardItemTouched(ws.name, null, boardSlug);
    return reply.send({ deleted: true });
  });

  // ---- vote sessions + stamps (BOARD-CANVAS-TOOLS-TDD §2.4) ---------

  /** Open a counting window. One open session per board — a second
   *  open would make "the current tally" ambiguous, so it 409s. */
  app.post('/api/v1/boards/:board/vote-sessions', async (req, reply) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(OpenVoteSessionBody, req.body, 'vote session');
    env.workspace(body.workspace);
    const sessions = await store.listBoardVoteSessions({
      workspace: body.workspace,
      board: boardSlug,
    });
    if (sessions.some((s) => s.status === 'open')) {
      throw new ApiError(
        409,
        'conflict',
        'a vote session is already open on this board',
      );
    }
    const ts = env.nowIso();
    const session: BoardVoteSession = {
      id: `bvs-${randomUUID().slice(0, 12)}`,
      workspace: body.workspace,
      board: boardSlug,
      opened_by: env.actor,
      closes_at: body.closes_at ?? null,
      status: 'open',
      created_at: ts,
      updated_at: ts,
    };
    await store.upsertBoardVoteSession(session);
    boardItemTouched(body.workspace, null, boardSlug);
    return reply.status(201).send({ session });
  });

  /** Close a session — OCC-fenced lifecycle PATCH; closed is
   *  terminal (re-open is a new session). */
  app.patch('/api/v1/boards/:board/vote-sessions/:id', async (req, reply) => {
    const { board: boardSlug, id } = req.params as {
      board: string;
      id: string;
    };
    const body = parse(PatchVoteSessionBody, req.body, 'vote session');
    env.workspace(body.workspace);
    const session = await store.getBoardVoteSession(id);
    if (
      !session ||
      session.workspace !== body.workspace ||
      session.board !== boardSlug
    ) {
      throw new ApiError(
        404,
        'not_found',
        `no vote session ${id} on ${body.workspace}/${boardSlug}`,
      );
    }
    if (session.status === 'closed') {
      throw new ApiError(
        409,
        'conflict',
        `vote session ${id} is already closed`,
      );
    }
    if (session.updated_at !== body.expected_updated_at) {
      throw new ApiError(
        409,
        'conflict',
        `vote session ${id} changed since your read`,
      );
    }
    const updated = await store.updateBoardVoteSessionExpected(
      {
        ...session,
        status: 'closed',
        updated_at: env.nowIso(),
      },
      body.expected_updated_at,
    );
    if (!updated) {
      throw new ApiError(
        409,
        'conflict',
        `vote session ${id} changed concurrently`,
      );
    }
    boardItemTouched(body.workspace, null, boardSlug);
    return reply.send({ session: updated });
  });

  /** Cast a stamp — upserts the caller's row (one vote per voter per
   *  session is the table's PK). The session must be open; closed is a
   *  server-enforced 409, never a greyed-out button (TOOLS-TDD §2.4). */
  app.put('/api/v1/boards/:board/votes', async (req, reply) => {
    const { board: boardSlug } = req.params as { board: string };
    const body = parse(CastVoteBody, req.body, 'board vote');
    env.workspace(body.workspace);
    const session = await store.getBoardVoteSession(body.session_id);
    if (
      !session ||
      session.workspace !== body.workspace ||
      session.board !== boardSlug
    ) {
      throw new ApiError(
        404,
        'not_found',
        `no vote session ${body.session_id} on ${body.workspace}/${boardSlug}`,
      );
    }
    if (session.status !== 'open') {
      throw new ApiError(
        409,
        'conflict',
        `vote session ${body.session_id} is closed`,
      );
    }
    const item = await store.getBoardItem(body.item_id);
    if (
      !item ||
      item.workspace !== body.workspace ||
      item.board !== boardSlug
    ) {
      throw new ApiError(
        404,
        'not_found',
        `no board item ${body.item_id} on ${body.workspace}/${boardSlug}`,
      );
    }
    const ts = env.nowIso();
    const vote: BoardVote = {
      workspace: body.workspace,
      board: boardSlug,
      item_id: body.item_id,
      voter: env.actor,
      session_id: body.session_id,
      stamp: body.stamp,
      created_at: ts,
      updated_at: ts,
    };
    await store.upsertBoardVote(vote);
    boardItemTouched(body.workspace, null, boardSlug);
    return reply.send({ vote });
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
    boardItemTouched(body.workspace, null, boardSlug);
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
    boardItemTouched(body.workspace, null, boardSlug);
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
