import {
  AlignmentServiceError,
  clusterFeedback,
  decideAlignmentFinding,
  releaseReadiness,
  runAlignment,
} from '@veto/conductor';
/**
 * api/alignment.ts — wp-112 continuous-alignment routes (D37 Phase B,
 * API.md `/alignment/<scope>` row, SCHEMAS §18).
 *
 *   GET  /api/v1/alignment/:scope?workspace= — latest durable
 *        `alignment-findings.json` for the scope + its findings and
 *        recent runs.
 *   POST /api/v1/alignment/:scope — request a fresh comparison.
 *        `{workspace, trigger?, trigger_sha?}`. `on-merge` runs
 *        coalesce on (scope, trigger_sha) → 200 with the existing run;
 *        manual runs land 201. Honors `intelligence.alignment` mode and
 *        configured token/spend caps (disabled → 409, cap → 429).
 *   POST /api/v1/alignment/decide — human dismiss/verify/resolve/
 *        reopen on a finding: `{workspace, id, action, expected,
 *        rationale?}` — OCC (`expected` = the status the human saw;
 *        a racing write → 409), idempotent, evented.
 *   GET  /api/v1/alignment/:scope/readiness?workspace= — for
 *        `release:<id>` scopes: deterministic gate checks PLUS the
 *        advisory risk narrative. `gate_verdict` is gates-only — the
 *        narrative can never turn a failed gate green.
 *   POST /api/v1/feedback/clusters — `{workspace, board?}` → feedback
 *        cluster proposals. Proposes only — never creates board items
 *        or initiatives; original refs preserved.
 */
import type { EffectiveConfig } from '@veto/config';
import type { Store } from '@veto/core';
import {
  ALIGNMENT_FINDING_ACTIONS,
  ALIGNMENT_FINDING_STATUSES,
  validateAlignmentFindings,
} from '@veto/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';

const DecideBody = z.object({
  workspace: z.string().min(1),
  id: z.string().min(1),
  action: z.enum(ALIGNMENT_FINDING_ACTIONS),
  /** OCC — the status the human saw; a racing decision loses with 409. */
  expected: z.enum(ALIGNMENT_FINDING_STATUSES).nullable(),
  rationale: z.string().nullish(),
});

const RunBody = z.object({
  workspace: z.string().min(1),
  trigger: z.enum(['manual', 'on-merge']).default('manual'),
  /** The merged head an on-merge run coalesces on. */
  trigger_sha: z.string().nullish(),
});

const ClusterBody = z.object({
  workspace: z.string().min(1),
  board: z.string().nullish(),
});

export interface AlignmentRouteDeps {
  store: Store;
  config: EffectiveConfig;
  actor: string;
  /** Resolve a workspace name → its configured rootPath. */
  workspaceRoot?: (name: string) => string | undefined;
  notify?: (event: { type: string; payload: unknown }) => void;
}

function alignHttp(e: AlignmentServiceError): ApiError {
  switch (e.kind) {
    case 'invalid':
      return new ApiError(400, 'bad_request', e.message);
    case 'missing':
      return new ApiError(404, 'not_found', e.message);
    case 'budget':
      return new ApiError(429, 'budget_exceeded', e.message);
    case 'conflict':
    case 'disabled':
      return new ApiError(409, 'conflict', e.message);
  }
}

export function registerAlignmentRoutes(
  app: FastifyInstance,
  deps: AlignmentRouteDeps,
): void {
  const ctx = (workspace: string) => ({
    store: deps.store,
    workspace,
    actor: deps.actor,
    now: () => new Date(),
  });

  app.get('/api/v1/alignment/:scope', async (req) => {
    const { scope } = req.params as { scope: string };
    const q = z.object({ workspace: z.string().min(1) }).parse(req.query ?? {});
    const runs = await deps.store.listAlignmentRuns({
      workspace: q.workspace,
      scope,
    });
    const latest = runs[0] ?? null;
    const artifact = latest?.artifact
      ? validateAlignmentFindings(JSON.parse(latest.artifact))
      : null;
    const findings = await deps.store.listAlignmentFindings({
      workspace: q.workspace,
      scope,
    });
    return { scope, latest_run: latest, artifact, findings, runs };
  });

  app.get('/api/v1/alignment/:scope/readiness', async (req) => {
    const { scope } = req.params as { scope: string };
    if (!scope.startsWith('release:')) {
      throw new ApiError(
        400,
        'bad_request',
        'readiness is defined for release:<id> scopes',
      );
    }
    const q = z.object({ workspace: z.string().min(1) }).parse(req.query ?? {});
    try {
      return await releaseReadiness(
        {
          ...ctx(q.workspace),
          rootPath: deps.workspaceRoot?.(q.workspace) ?? '',
        },
        scope.slice('release:'.length),
      );
    } catch (e) {
      if (e instanceof AlignmentServiceError) throw alignHttp(e);
      // ReleaseError 'not-found' → 404.
      if ((e as { code?: string }).code === 'not-found') {
        throw new ApiError(404, 'not_found', (e as Error).message);
      }
      throw e;
    }
  });

  app.post('/api/v1/alignment/:scope', async (req, reply) => {
    const { scope } = req.params as { scope: string };
    const body = RunBody.parse(req.body ?? {});
    try {
      const res = await runAlignment(ctx(body.workspace), deps.config, {
        scope,
        trigger: body.trigger,
        triggerSha: body.trigger_sha ?? null,
        notify: (e) => deps.notify?.(e),
      });
      return reply
        .status(res.created ? 201 : 200)
        .send({ run: res.run, artifact: res.artifact });
    } catch (e) {
      if (e instanceof AlignmentServiceError) throw alignHttp(e);
      throw e;
    }
  });

  app.post('/api/v1/alignment/decide', async (req) => {
    const body = DecideBody.parse(req.body ?? {});
    try {
      const finding = await decideAlignmentFinding(ctx(body.workspace), {
        id: body.id,
        action: body.action,
        expected: body.expected ?? undefined,
        rationale: body.rationale ?? null,
      });
      deps.notify?.({ type: 'alignment_status', payload: finding });
      return { finding };
    } catch (e) {
      if (e instanceof AlignmentServiceError) throw alignHttp(e);
      throw e;
    }
  });

  app.post('/api/v1/feedback/clusters', async (req) => {
    const body = ClusterBody.parse(req.body ?? {});
    const proposals = await clusterFeedback(ctx(body.workspace), {
      ...(body.board ? { board: body.board } : {}),
    });
    return { proposals };
  });
}
