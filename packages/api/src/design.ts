/**
 * api/design.ts — design-artifact REST surface (PRD §15.4, wp-149).
 *
 * Thin shell over `conductor/design` — the engine owns mockup-tree
 * validity, structural diffs, approval↔revision binding + partial
 * invalidation, the screen-state generator, design-system ingestion and
 * advisory `design-drift` findings; this file owns HTTP: zod-fail-closed
 * bodies, workspace-qualified ids, `DesignError` → 4xx mapping, and the
 * conductor-side effect a new mockup revision legitimately drives
 * (re-checking bound approvals for invalidation).
 */
import { design } from '@sprint-runner/conductor';
import type { ConductorWorkspace } from '@sprint-runner/conductor';
import type { MockupState, Store } from '@sprint-runner/core';
import { MOCKUP_STATES } from '@sprint-runner/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';

type DesignCtx = design.DesignCtx;
const {
  DesignError,
  designApprovalState,
  expandScreenStates,
  listDesignApprovals,
  loadMockup,
  parseDesignSystem,
  parseMockup,
  recordDesignApproval,
  recordDesignDrift,
  requirementCoverage,
  screenTree,
  syncDesignApprovals,
} = design;

export interface DesignRouteEnv {
  store: Store;
  actor: string;
  nowIso: () => string;
  workspace: (name: string) => ConductorWorkspace;
}

const badRequest = (m: string) => new ApiError(400, 'bad_request', m);

const MockupBody = z.object({
  /** mockup.json document text (validated fail-closed). */
  content: z.string().min(1),
});

const ApprovalBody = z.object({
  reviewer: z.string().min(1).optional(),
  doc: z.string().min(1).optional(),
  doc_version: z.number().int().positive(),
  checklist: z.record(z.unknown()),
  covers: z.array(z.string()).optional(),
  rationale: z.string().nullish(),
});

const DriftBody = z.object({
  doc_version: z.number().int().positive(),
  screen_id: z.string().nullish(),
  component_id: z.string().nullish(),
  body: z.string().min(1),
  evidence: z.string().nullish(),
  severity: z.enum(['blocker', 'major', 'minor', 'nit', 'question']).nullish(),
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  repo: z.string().nullish(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw badRequest(
      `${what}: ${r.error.issues
        .map((i) => `${i.path.join('.') || '<body>'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return r.data;
}

/** `DesignError` → ApiError passthrough at the route boundary. */
function mapErr(e: unknown): never {
  if (e instanceof DesignError) {
    throw new ApiError(e.statusCode, e.code, e.message);
  }
  throw e;
}

/** Run a synchronous engine call, mapping a thrown DesignError to HTTP. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    return mapErr(e);
  }
}

export function registerDesignRoutes(
  app: FastifyInstance,
  env: DesignRouteEnv,
): void {
  const { store } = env;

  function ctxFor(ws: ConductorWorkspace): DesignCtx {
    return {
      store,
      workspace: ws.name,
      actor: env.actor,
      now: () => new Date(),
    };
  }

  // ---- mockups (structured component trees) ----

  app.get('/api/v1/design/:workspace/:subject/mockups', async (req) => {
    const { workspace: wsName, subject } = req.params as {
      workspace: string;
      subject: string;
    };
    const versions = await store.listDocVersions({
      workspace: wsName,
      subject,
      doc: 'mockup.json',
    });
    return {
      subject,
      latest: versions[versions.length - 1]?.version ?? null,
      versions: versions.map((v) => ({
        version: v.version,
        edited_by: v.edited_by ?? null,
        created_at: v.created_at ?? null,
      })),
    };
  });

  app.get(
    '/api/v1/design/:workspace/:subject/mockups/:version',
    async (req) => {
      const { workspace: wsName, subject, version } = req.params as {
        workspace: string;
        subject: string;
        version: string;
      };
      const v = Number(version);
      if (!Number.isInteger(v)) throw badRequest('version must be an integer');
      const ws = env.workspace(wsName);
      const loaded = await loadMockup(ctxFor(ws), subject, {
        docVersion: v,
      }).catch(mapErr);
      if (!loaded) {
        throw new ApiError(404, 'not_found', `no mockup.json v${v}`);
      }
      return {
        version: loaded.version,
        mockup: loaded.mockup,
        coverage: requirementCoverage(loaded.mockup),
      };
    },
  );

  app.post('/api/v1/design/:workspace/:subject/mockups', async (req, reply) => {
    const { workspace: wsName, subject } = req.params as {
      workspace: string;
      subject: string;
    };
    const ws = env.workspace(wsName);
    const body = parseBody(MockupBody, req.body, 'mockups.create');
    // Fail-closed: never persist a malformed / inconsistent tree.
    guard(() => parseMockup(body.content));
    const v = await store.appendDocVersion(
      { workspace: wsName, subject, doc: 'mockup.json' },
      body.content,
      env.actor,
    );
    // A new revision may invalidate bound approvals (partial — only the
    // approvals whose covered ACs the structural diff touches).
    const invalidated = await syncDesignApprovals(ctxFor(ws), {
      subject,
    }).catch(mapErr);
    return reply.status(201).send({
      version: v.version,
      invalidated: invalidated.invalidated,
      to_version: invalidated.to_version,
    });
  });

  /** Nested render tree for the canvas (screen + optional state/breakpoint). */
  app.get(
    '/api/v1/design/:workspace/:subject/mockups/:version/screens/:screen',
    async (req) => {
      const { workspace: wsName, subject, version, screen } = req.params as {
        workspace: string;
        subject: string;
        version: string;
        screen: string;
      };
      const v = Number(version);
      if (!Number.isInteger(v)) throw badRequest('version must be an integer');
      const q = req.query as { state?: string; breakpoint?: string };
      if (q.state && !(MOCKUP_STATES as readonly string[]).includes(q.state)) {
        throw badRequest(`unknown state '${q.state}'`);
      }
      const ws = env.workspace(wsName);
      const loaded = await loadMockup(ctxFor(ws), subject, {
        docVersion: v,
      }).catch(mapErr);
      if (!loaded) throw new ApiError(404, 'not_found', `no mockup.json v${v}`);
      const tree = screenTree(loaded.mockup, decodeURIComponent(screen), {
        ...(q.state ? { state: q.state as MockupState } : {}),
        ...(q.breakpoint
          ? { breakpoint: q.breakpoint as never }
          : {}),
      });
      if (!tree) {
        throw new ApiError(404, 'not_found', `no screen '${screen}'`);
      }
      return { version: v, screen, state: q.state ?? 'default', tree };
    },
  );

  /** Expand a screen into state variants (state generator). */
  app.post(
    '/api/v1/design/:workspace/:subject/mockups/:version/states',
    async (req) => {
      const { workspace: wsName, subject, version } = req.params as {
        workspace: string;
        subject: string;
        version: string;
      };
      const v = Number(version);
      if (!Number.isInteger(v)) throw badRequest('version must be an integer');
      const body = parseBody(
        z.object({
          screen_id: z.string().min(1),
          states: z.array(z.enum(MOCKUP_STATES)).min(1),
        }),
        req.body,
        'mockups.states',
      );
      const ws = env.workspace(wsName);
      const loaded = await loadMockup(ctxFor(ws), subject, {
        docVersion: v,
      }).catch(mapErr);
      if (!loaded) throw new ApiError(404, 'not_found', `no mockup.json v${v}`);
      const expanded = guard(() =>
        expandScreenStates(loaded.mockup, {
          screenId: body.screen_id,
          states: body.states,
        }),
      );
      return { mockup: expanded };
    },
  );

  // ---- approvals ----

  app.get('/api/v1/design/:workspace/:subject/approvals', async (req) => {
    const { workspace: wsName, subject } = req.params as {
      workspace: string;
      subject: string;
    };
    const ws = env.workspace(wsName);
    const approvals = await listDesignApprovals(ctxFor(ws), { subject });
    const state = await designApprovalState(ctxFor(ws), subject);
    const latest = await loadMockup(ctxFor(ws), subject);
    return {
      approvals,
      state,
      latest_version: latest?.version ?? null,
      coverage: latest ? requirementCoverage(latest.mockup) : [],
    };
  });

  app.post(
    '/api/v1/design/:workspace/:subject/approvals',
    async (req, reply) => {
      const { workspace: wsName, subject } = req.params as {
        workspace: string;
        subject: string;
      };
      const ws = env.workspace(wsName);
      const body = parseBody(ApprovalBody, req.body, 'approvals.create');
      const result = await recordDesignApproval(ctxFor(ws), {
        subject,
        reviewer: body.reviewer ?? env.actor,
        docVersion: body.doc_version,
        checklist: body.checklist,
        ...(body.covers ? { covers: body.covers } : {}),
        ...(body.doc ? { doc: body.doc } : {}),
        rationale: body.rationale ?? null,
      }).catch(mapErr);
      return reply.status(result.created ? 201 : 200).send(result);
    },
  );

  // ---- design-drift (advisory) ----

  app.post('/api/v1/design/:workspace/:subject/drift', async (req, reply) => {
    const { workspace: wsName, subject } = req.params as {
      workspace: string;
      subject: string;
    };
    const ws = env.workspace(wsName);
    const body = parseBody(DriftBody, req.body, 'drift.create');
    const finding = await recordDesignDrift(ctxFor(ws), {
      subject,
      docVersion: body.doc_version,
      screenId: body.screen_id ?? null,
      componentId: body.component_id ?? null,
      body: body.body,
      evidence: body.evidence ?? null,
      severity: body.severity ?? null,
      file: body.file ?? null,
      line: body.line ?? null,
      repo: body.repo ?? null,
    }).catch(mapErr);
    return reply.status(201).send({ finding });
  });

  // ---- design-system ingestion (parse/validate only; the stage writes) ----

  app.post('/api/v1/design/:workspace/:subject/design-system', async (req) => {
    const body = parseBody(
      z.object({ content: z.string().min(1) }),
      req.body,
      'design-system.parse',
    );
    return { bundle: guard(() => parseDesignSystem(body.content)) };
  });
}
