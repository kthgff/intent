/**
 * api/links.ts — wp-111 traceability-link routes (D37, API.md, DB-SCHEMA
 * `relations`).
 *
 *   GET    /links?workspace=&subject=[&predicate=&object=] — edges for
 *          a subject (the ticket traceability panel).
 *   POST   /links — record an edge. `source: explicit|human` lands
 *          `verified` (authoritative workflow declarations);
 *          `model|tool` lands `suggested`, or `auto-verified` at
 *          confidence ≥ intelligence.auto_verify_confidence — a
 *          suggestion never masquerades as `verified`.
 *   POST   /links/decide — human verify/reject: `{action, expected}`.
 *          Idempotent (repeat = 200 noop), evented (link_verified /
 *          link_rejected), OCC (`expected` = the state the human saw —
 *          a racing write loses with 409). Stale pins (edge cites a
 *          superseded index head) and out-of-scope repos can never
 *          land `verified` (409 / 403).
 */
import type { EffectiveConfig } from '@sprint-runner/config';
import type { Store } from '@sprint-runner/core';
import {
  RELATION_PREDICATES,
  RELATION_SOURCES,
  RELATION_VERIFICATIONS,
  RelationSchema,
} from '@sprint-runner/core';
import {
  decideLink,
  type LinkAction,
  LinkError,
  proposeLink,
} from '@sprint-runner/kb';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';

const DecideBody = z.object({
  workspace: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.enum(RELATION_PREDICATES),
  object: z.string().min(1),
  action: z.enum(['verify', 'reject']),
  /** OCC — the verification state the human saw; a racing decision
   *  against it loses with 409 (never a check-then-write gap). */
  expected: z.enum(RELATION_VERIFICATIONS).nullable(),
  /** Optional provenance back to the run/run-artifact that produced
   *  the suggestion. */
  run: z.string().nullish(),
});

const ListQuery = z.object({
  workspace: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().optional(),
  object: z.string().optional(),
});

const ProposeBody = RelationSchema.extend({
  workspace: z.string().min(1),
  source: z.enum(RELATION_SOURCES),
});

export interface LinksRouteDeps {
  store: Store;
  config: EffectiveConfig;
  actor: string;
  notify?: (event: { type: string; payload: unknown }) => void;
}

function linkHttp(e: LinkError): ApiError {
  switch (e.kind) {
    case 'invalid':
      return new ApiError(400, 'bad_request', e.message);
    case 'missing':
      return new ApiError(404, 'not_found', e.message);
    case 'unauthorized':
      return new ApiError(403, 'forbidden', e.message);
    case 'conflict':
    case 'stale':
      return new ApiError(409, 'conflict', e.message);
  }
}

export function registerLinkRoutes(
  app: FastifyInstance,
  deps: LinksRouteDeps,
): void {
  app.get('/api/v1/links', async (req) => {
    const q = ListQuery.parse(req.query ?? {});
    const relations = await deps.store.listRelations({
      subject: q.subject,
      ...(q.predicate ? { predicate: q.predicate } : {}),
      ...(q.object ? { object: q.object } : {}),
    });
    return { relations };
  });

  app.post('/api/v1/links', async (req, reply) => {
    const body = ProposeBody.parse(req.body ?? {});
    try {
      const { edge, created } = await proposeLink(
        deps.store,
        deps.config,
        body,
      );
      return reply.status(created ? 201 : 200).send({ relation: edge });
    } catch (e) {
      if (e instanceof LinkError) throw linkHttp(e);
      throw e;
    }
  });

  app.post('/api/v1/links/decide', async (req) => {
    const body = DecideBody.parse(req.body ?? {});
    try {
      const edge = await decideLink(deps.store, deps.config, {
        workspace: body.workspace,
        subject: body.subject,
        predicate: body.predicate,
        object: body.object,
        action: body.action as LinkAction,
        expected: body.expected ?? undefined,
        actor: deps.actor,
        ...(body.run ? { run: body.run } : {}),
      });
      deps.notify?.({ type: 'link_decided', payload: edge });
      return { relation: edge };
    } catch (e) {
      if (e instanceof LinkError) throw linkHttp(e);
      throw e;
    }
  });
}
