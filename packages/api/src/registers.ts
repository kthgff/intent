/**
 * api/registers.ts — the §15.10 register surfaces (wp-153).
 *
 * Thin HTTP shell over `conductor/registers` — the engine owns the
 * lifecycle legality (human-only confirms, legal commitment
 * transitions, loud expiry); this file owns zod-fail-closed bodies,
 * workspace-qualified ids and error mapping.
 *
 *   GET    /api/v1/assumptions              — the assumption register
 *   POST   /api/v1/assumptions/:ws/:id/confirm — human confirm/expire
 *   GET    /api/v1/quality-debt             — the debt register
 *   GET    /api/v1/commitments              — heads + live drift
 *   POST   /api/v1/commitments              — record committed scope
 *   POST   /api/v1/commitments/:ws/:id/status — advance the lifecycle
 */
import { registers } from '@sprint-runner/conductor';
import type { ConductorWorkspace } from '@sprint-runner/conductor';
import type { Store } from '@sprint-runner/core';
import { DELIVERY_COMMITMENT_STATUSES } from '@sprint-runner/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';

export interface RegisterRouteEnv {
  store: Store;
  actor: string;
  now: () => Date;
  workspace: (name: string) => ConductorWorkspace;
}

const badRequest = (m: string) => new ApiError(400, 'bad_request', m);
const notFound = (m: string) => new ApiError(404, 'not_found', m);

const WsParam = z.string().min(1).max(64);

const ConfirmBody = z.object({
  status: z.enum(['verified', 'invalidated', 'risk-accepted']),
  evidence: z.string().nullish(),
});

const CommitScopeBody = z.object({
  workspace: WsParam,
  commitment_id: z.string().min(1).max(128),
  scope: z.record(z.unknown()),
  target: z.string().nullish(),
  success_criteria: z.string().nullish(),
  exclusions: z.string().nullish(),
  assumptions: z.string().nullish(),
  owner: z.string().nullish(),
});

const AdvanceBody = z.object({
  status: z.enum(DELIVERY_COMMITMENT_STATUSES),
});

export function registerRegisterRoutes(
  app: FastifyInstance,
  env: RegisterRouteEnv,
): void {
  const { store, actor } = env;
  const ctxFor = (ws: string) => ({
    store,
    workspace: env.workspace(ws).name,
    actor,
    now: env.now,
  });

  // ---- assumptions ----
  app.get('/api/v1/assumptions', async (req) => {
    const q = req.query as { workspace?: string; subject?: string };
    const ws = env.workspace(q.workspace ?? 'default');
    return {
      assumptions: await store.listAssumptions({
        workspace: ws.name,
        ...(q.subject ? { subject: q.subject } : {}),
      }),
    };
  });

  app.post('/api/v1/assumptions/:workspace/:id/confirm', async (req) => {
    const { workspace: wsName, id } = req.params as {
      workspace: string;
      id: string;
    };
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        `assumption confirm: ${parsed.error.issues[0]?.message ?? 'invalid body'}`,
      );
    }
    try {
      const row = await registers.confirmAssumption(ctxFor(wsName), {
        assumption_id: id,
        status: parsed.data.status,
        actor,
        actorKind: 'human',
        evidence: parsed.data.evidence ?? null,
      });
      return { assumption: row };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('no assumption')) throw notFound(msg);
      throw badRequest(msg);
    }
  });

  // ---- quality debt ----
  app.get('/api/v1/quality-debt', async (req) => {
    const q = req.query as {
      workspace?: string;
      kind?: string;
      status?: string;
    };
    const ws = env.workspace(q.workspace ?? 'default');
    return {
      debt: await store.listQualityDebt({
        workspace: ws.name,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.status ? { status: q.status } : {}),
      }),
    };
  });

  // ---- delivery commitments ----
  app.get('/api/v1/commitments', async (req) => {
    const q = req.query as { workspace?: string };
    const ws = env.workspace(q.workspace ?? 'default');
    const heads = await store.listDeliveryCommitments({
      workspace: ws.name,
    });
    const commitments = await Promise.all(
      heads.map(async (h) => ({
        ...h,
        drift: await registers.commitmentDrift(store, ws.name, h),
      })),
    );
    return { commitments };
  });

  app.post('/api/v1/commitments', async (req) => {
    const parsed = CommitScopeBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        `commitment: ${parsed.error.issues[0]?.message ?? 'invalid body'}`,
      );
    }
    const body = parsed.data;
    const row = await registers.commitScope(ctxFor(body.workspace), {
      commitment_id: body.commitment_id,
      scope: body.scope,
      target: body.target ?? null,
      success_criteria: body.success_criteria ?? null,
      exclusions: body.exclusions ?? null,
      assumptions: body.assumptions ?? null,
      owner: body.owner ?? null,
      org: null,
      created_by: actor,
    });
    return { commitment: row };
  });

  app.post('/api/v1/commitments/:workspace/:id/status', async (req) => {
    const { workspace: wsName, id } = req.params as {
      workspace: string;
      id: string;
    };
    const parsed = AdvanceBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        `commitment status: ${parsed.error.issues[0]?.message ?? 'invalid body'}`,
      );
    }
    try {
      const row = await registers.advanceCommitment(ctxFor(wsName), {
        commitment_id: id,
        status: parsed.data.status,
        actor,
      });
      return { commitment: row };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('no delivery commitment')) throw notFound(msg);
      throw badRequest(msg);
    }
  });
}
