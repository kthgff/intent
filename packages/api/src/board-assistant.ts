/**
 * api/board-assistant.ts — the Board Assistant REST surface
 * (BOARD-CHAT-TDD "REST surface", wp-164). Thin shell over
 * `conductor/assistant` — the engine owns the turn pipeline, run
 * lifecycle, and proposal legality; this file owns HTTP: zod-strict
 * bodies, workspace-scoped ids, `InterviewError` → 4xx mapping, and
 * SSE after every durable write (`interview_updated` for transcript/
 * session state, `board_proposal` per proposal row, the
 * `board_item_updated` notification hint when items land).
 *
 * Registered ONLY when `ui.board_chat` is on — flag-off boards keep
 * the assistant read-only-invisible (no panel, no routes).
 */
import type { ConductorWorkspace } from '@veto/conductor';
import {
  BoardError,
  StatementError,
  assistant,
  interview,
} from '@veto/conductor';
import type { BoardProposalRow, CompletionProvider, Store } from '@veto/core';
import { BOARD_PROPOSAL_STATUSES } from '@veto/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';

export interface BoardAssistantRouteEnv {
  store: Store;
  actor: string;
  /** Resolved assistant provider — undefined = deterministic mode. */
  provider: CompletionProvider | undefined;
  /** Registry-resolved model label for the panel's `model` field. */
  model: string | null;
  workspace: (name: string) => ConductorWorkspace;
  notify?: (event: { type: string; payload: unknown }) => void;
}

const WorkspaceName = z.string().min(1).max(64);
const MessageBody = z
  .object({
    workspace: WorkspaceName,
    text: z.string().min(1).max(8000),
  })
  .strict();
const RunBody = z
  .object({
    workspace: WorkspaceName,
    skill: z.enum(['interview', 'expand']),
    scope: z
      .object({
        subject: z.string().min(1).max(500).optional(),
        item_ids: z.array(z.string().min(1)).max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const WsOnlyBody = z.object({ workspace: WorkspaceName }).strict();
const RejectBody = z
  .object({ workspace: WorkspaceName, reason: z.string().max(500).optional() })
  .strict();
const BatchBody = z
  .object({
    workspace: WorkspaceName,
    ids: z.array(z.string().min(1)).max(200).optional(),
    batch_id: z.string().min(1).optional(),
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

export function registerBoardAssistantRoutes(
  app: FastifyInstance,
  env: BoardAssistantRouteEnv,
): void {
  const { store } = env;

  const provider = env.provider;
  const actx = (ws: string): assistant.AssistantCtx => ({
    store,
    workspace: ws,
    actor: env.actor,
    now: () => new Date(),
    ...(provider ? { provider } : {}),
    ...(env.model ? { model: env.model } : {}),
    ...(provider
      ? {
          extract: (prompt: string) =>
            provider.converse([{ role: 'user', content: prompt }]),
          propose: (prompt: string) =>
            provider.converse([{ role: 'user', content: prompt }]),
        }
      : {}),
  });

  /** Coverage seeding rides mutation paths (GETs stay read-only). */
  const seed =
    (board: string) => async (c: assistant.AssistantCtx, sessionId: string) => {
      await interview.seedBoardSlots(c, { sessionId, board });
    };

  /** The wizard catalog must exist before the thread session can
   *  start — lazy + idempotent (wp-163), mutation paths only. */
  async function seedCatalog(ws: string): Promise<void> {
    await interview.seedBoardWizards(actx(ws));
  }

  /** Engine errors → 4xx at the boundary (never a 500 leak). */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof interview.InterviewError) {
        throw new ApiError(e.statusCode, e.code.replace(/-/g, '_'), e.message);
      }
      if (e instanceof BoardError || e instanceof StatementError) {
        throw new ApiError(400, 'bad_request', e.message);
      }
      throw e;
    }
  }

  const threadTouched = (ws: string, sessionId: string | null) =>
    env.notify?.({
      type: 'interview_updated',
      payload: { workspace: ws, session_id: sessionId },
    });
  const proposalTouched = (ws: string, p: BoardProposalRow) =>
    env.notify?.({
      type: 'board_proposal',
      payload: {
        workspace: ws,
        board: p.board,
        proposal_id: p.proposal_id,
        status: p.status,
      },
    });
  const itemsTouched = (ws: string, board: string) =>
    env.notify?.({
      type: 'notification',
      payload: { kind: 'board_item_updated', workspace: ws, board },
    });

  const boardPath = '/api/v1/boards/:board';

  /** Chips the route can't honor yet are stripped here — `synthesize`
   *  has no live route in v1 (TDD: hidden when the route isn't live). */
  const liveChips = (state: assistant.AssistantPanelState) =>
    state.chips.filter((c) => c.id !== 'synthesize');

  app.get(`${boardPath}/assistant`, async (req) => {
    const { board: boardSlug } = req.params as { board: string };
    const { workspace: wsName } = req.query as { workspace?: string };
    if (!wsName)
      throw new ApiError(400, 'bad_request', 'workspace is required');
    env.workspace(wsName);
    const state = await call(() =>
      assistant.panelState(actx(wsName), boardSlug),
    );
    return { ...state, chips: liveChips(state) };
  });

  app.post(`${boardPath}/assistant/messages`, async (req) => {
    const body = parse(MessageBody, req.body, 'assistant message');
    env.workspace(body.workspace);
    await seedCatalog(body.workspace);
    const res = await call(() =>
      assistant.postMessage(actx(body.workspace), {
        board: boardSlug(req),
        text: body.text,
        actor: env.actor,
        seed: seed(boardSlug(req)),
      }),
    );
    threadTouched(body.workspace, res.messages[0]?.session_id ?? null);
    for (const p of res.proposals) proposalTouched(body.workspace, p);
    return {
      messages: res.messages,
      proposals: res.proposals,
      pending_question: res.pending,
    };
  });

  app.post(`${boardPath}/assistant/runs`, async (req) => {
    const body = parse(RunBody, req.body, 'assistant run');
    env.workspace(body.workspace);
    const scope =
      body.scope?.item_ids?.join(',') ?? body.scope?.subject ?? null;
    await seedCatalog(body.workspace);
    const run = await call(() =>
      assistant.startRun(actx(body.workspace), {
        board: boardSlug(req),
        skill: body.skill,
        scope,
        seed: seed(boardSlug(req)),
      }),
    );
    threadTouched(body.workspace, run.session.session_id);
    // `branch` is null when the scope resolved to nothing expandable
    // (zone-only selection) — the explanation is already in-thread.
    return {
      branch: run.branch?.branch ?? null,
      asked: run.asked?.candidate ?? null,
    };
  });

  app.post(`${boardPath}/assistant/runs/:branch/end`, async (req) => {
    const body = parse(WsOnlyBody, req.body, 'end run');
    env.workspace(body.workspace);
    const { branch } = req.params as { branch: string };
    const ended = await call(() =>
      assistant.endRun(actx(body.workspace), {
        board: boardSlug(req),
        branch,
      }),
    );
    threadTouched(body.workspace, ended.message.session_id);
    return { summary: ended.message.content, message: ended.message };
  });

  app.get(`${boardPath}/proposals`, async (req) => {
    const { board: boardSlug } = req.params as { board: string };
    const q = req.query as { workspace?: string; status?: string };
    if (!q.workspace)
      throw new ApiError(400, 'bad_request', 'workspace is required');
    env.workspace(q.workspace);
    if (
      q.status !== undefined &&
      !(BOARD_PROPOSAL_STATUSES as readonly string[]).includes(q.status)
    ) {
      throw new ApiError(400, 'bad_request', `unknown status '${q.status}'`);
    }
    const proposals = await store.listBoardProposals({
      workspace: q.workspace,
      board: boardSlug,
      ...(q.status !== undefined ? { status: q.status } : {}),
    });
    return { proposals };
  });

  app.post(`${boardPath}/proposals/accept`, async (req) => {
    const body = parse(BatchBody, req.body, 'accept batch');
    env.workspace(body.workspace);
    const res = await call(() =>
      assistant.acceptProposals(actx(body.workspace), {
        board: boardSlug(req),
        ...(body.ids !== undefined ? { ids: body.ids } : {}),
        ...(body.batch_id !== undefined ? { batchId: body.batch_id } : {}),
        decidedBy: env.actor,
      }),
    );
    for (const p of res.proposals) proposalTouched(body.workspace, p);
    if (res.items.length > 0) itemsTouched(body.workspace, boardSlug(req));
    return res;
  });

  app.post(`${boardPath}/proposals/:id/accept`, async (req) => {
    const body = parse(WsOnlyBody, req.body, 'accept proposal');
    env.workspace(body.workspace);
    const { id } = req.params as { id: string };
    const existing = await store.getBoardProposal({
      workspace: body.workspace,
      proposal_id: id,
    });
    if (!existing || existing.board !== boardSlug(req)) {
      throw new ApiError(404, 'not_found', `no proposal ${id} on this board`);
    }
    const res = await call(() =>
      assistant.acceptProposal(actx(body.workspace), {
        proposalId: id,
        decidedBy: env.actor,
      }),
    );
    proposalTouched(body.workspace, res.proposal);
    if (res.items.length > 0) itemsTouched(body.workspace, res.proposal.board);
    return res;
  });

  app.post(`${boardPath}/proposals/:id/reject`, async (req) => {
    const body = parse(RejectBody, req.body, 'reject proposal');
    env.workspace(body.workspace);
    const { id } = req.params as { id: string };
    const existing = await store.getBoardProposal({
      workspace: body.workspace,
      proposal_id: id,
    });
    if (!existing || existing.board !== boardSlug(req)) {
      throw new ApiError(404, 'not_found', `no proposal ${id} on this board`);
    }
    const proposal = await call(() =>
      assistant.rejectProposal(actx(body.workspace), {
        proposalId: id,
        decidedBy: env.actor,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      }),
    );
    proposalTouched(body.workspace, proposal);
    return { proposal };
  });

  function boardSlug(req: { params: unknown }): string {
    return (req.params as { board: string }).board;
  }
}
