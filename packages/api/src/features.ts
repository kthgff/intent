/**
 * api/features.ts — Feature Workspace routes (PRD §15.7, wp-152).
 *
 *   GET  /features?workspace=&initiative=&status= — feature rows
 *   GET  /features/<ws>/<feature> — workspace detail rollup: feature
 *        row + docs metadata + member tickets grouped by
 *        work_type×status + requirement links + health findings +
 *        acceptance state + release memberships/exposure
 *   GET  /features/<ws>/<feature>/docs/<name> — versioned feature docs
 *        (feature.md|ac.md|test.md|notes.md|mockup.json)
 *   GET  /features/<ws>/<feature>/acceptance — the Feature Acceptance
 *        Package (approved scope + AC slice + test evidence + known
 *        exclusions → the human acceptance gate bundle)
 *   POST /features/<ws>/<feature>/accept — the explicit human
 *        acceptance gate (`{exclusions?, expected_status?}`); the
 *        ONLY path to status 'done' — release assignment refuses
 *        anything else (conductor addReleaseItem).
 *
 * Feature Health is a findings LIST (blockers, unverified ACs, stale
 * approvals, open gates) computed from live rows — never an opaque
 * score. All routes are workspace-scoped and fail-closed.
 */
import {
  type ConductorWorkspace,
  FeatureError,
  acceptFeature,
  assembleAcceptancePackage,
  featureAcceptanceCriteria,
  featureHealth,
} from '@sprint-runner/conductor';
import {
  DOC_KINDS,
  type DocKind,
  type FeatureRow,
  type Store,
} from '@sprint-runner/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lineDiff } from './diff.js';
import { ApiError } from './server.js';

const badRequest = (m: string) => new ApiError(400, 'bad_request', m);
const notFound = (m: string) => new ApiError(404, 'not_found', m);
const conflict = (m: string) => new ApiError(409, 'conflict', m);

const AcceptBodySchema = z
  .object({
    exclusions: z.array(z.string()).optional(),
    expected_status: z.string().optional(),
  })
  .passthrough();

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

export interface FeatureRouteDeps {
  store: Store;
  /** Resolve a workspace name → configured workspace (throws on
   *  unknown — workspace scoping is never client-supplied). */
  workspace: (name: string) => ConductorWorkspace;
  actor: string;
}

/** Doc kinds readable through the feature doc route (DB-SCHEMA
 *  doc_versions on the feature subject). */
const FEATURE_DOCS = new Set<DocKind>([
  'feature.md',
  'ac.md',
  'vs.md',
  'notes.md',
  'mockup.json',
  'adr.md',
  'provenance.json',
]);

/** Bare name → doc kind, fail-closed on anything outside the feature
 *  doc set (a malformed name is a 400, never a guessed doc). */
function featureDocKind(name: string): DocKind | null {
  const resolved = (DOC_KINDS as readonly string[]).includes(name)
    ? (name as DocKind)
    : (`${name}.md` as DocKind satisfies DocKind);
  if ((DOC_KINDS as readonly string[]).includes(resolved)) {
    return FEATURE_DOCS.has(resolved) ? resolved : null;
  }
  return null;
}

/** Map a conductor FeatureError onto the HTTP contract. */
function mapFeatureError(err: unknown): never {
  if (err instanceof FeatureError) {
    if (err.code === 'not-found') throw notFound(err.message);
    if (err.code === 'bad-state') throw conflict(err.message);
    throw badRequest(err.message);
  }
  throw err;
}

export function registerFeatureRoutes(
  app: FastifyInstance,
  deps: FeatureRouteDeps,
): void {
  const { store } = deps;
  const now = () => new Date();

  const ctxFor = (ws: ConductorWorkspace) => ({
    workspace: ws.name,
    rootPath: ws.rootPath,
    store,
    actor: deps.actor,
    now,
  });

  async function getFeatureOr404(wsName: string, featureId: string) {
    const f = await store.getFeature(wsName, featureId);
    if (!f) throw notFound(`unknown feature '${wsName}/${featureId}'`);
    return f;
  }

  /** Feature Health — the explainable findings list. No score. */
  async function healthFor(ws: ConductorWorkspace, featureId: string) {
    try {
      return await featureHealth(ctxFor(ws), featureId);
    } catch (err) {
      mapFeatureError(err);
    }
  }

  app.get('/api/v1/features', async (req) => {
    const q = req.query as {
      workspace?: string;
      initiative?: string;
      status?: string;
    };
    if (q.workspace !== undefined) deps.workspace(q.workspace);
    const features = await store.listFeatures({
      ...(q.workspace ? { workspace: q.workspace } : {}),
      ...(q.initiative ? { initiative: q.initiative } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
    return { features };
  });

  /**
   * Feature detail — one payload backing the six workspace tabs:
   * Overview (row + initiative + owner/status), Requirements
   * (documents/implements relations — the primary RS is the first
   * verified `documents` edge), Design (design-doc versions +
   * mockups), Tickets (member tickets + type×status grouping),
   * Quality (AC evidence matrix + health findings), Release
   * (memberships + exposure + deployments).
   */
  app.get('/api/v1/features/:workspace/:feature', async (req) => {
    const { workspace: wsName, feature: featureId } = req.params as {
      workspace: string;
      feature: string;
    };
    const ws = deps.workspace(wsName);
    const feature = await getFeatureOr404(wsName, featureId);

    const [initiative, docs, allTickets, relations, findings, events] =
      await Promise.all([
        feature.initiative
          ? store.getInitiative(wsName, feature.initiative)
          : null,
        store.listDocs({ workspace: wsName, subject: featureId }),
        store.listTickets({ workspace: wsName }),
        store.listRelations({ subject: featureId }),
        healthFor(ws, featureId),
        store.listEvents({ workspace: wsName, ticket_id: featureId }),
      ]);
    const tickets = allTickets.filter((t) => t.feature === featureId);

    // Requirement links (multi-RS, one primary): `documents`/
    // `implements` edges out of the feature subject. Primary = first
    // `verified` documents edge, else first documents edge — the UI
    // renders it pinned; suggested edges are labeled, never trusted.
    const requirementEdges = relations.filter((r) =>
      ['documents', 'implements'].includes(r.predicate),
    );
    const primary =
      requirementEdges.find(
        (r) => r.predicate === 'documents' && r.verification === 'verified',
      ) ??
      requirementEdges.find((r) => r.predicate === 'documents') ??
      null;

    // Tickets grouped by work_type × status (Tickets tab).
    const groups: Record<string, Record<string, number>> = {};
    for (const t of tickets) {
      const wt = (t.work_type as string | null) ?? 'untyped';
      groups[wt] = groups[wt] ?? {};
      groups[wt][t.status] = (groups[wt][t.status] ?? 0) + 1;
    }

    // Release tab: live memberships (removed rows stay for audit),
    // per-environment exposure, and confirmed deployments carrying
    // the feature.
    const releases = await store.listReleases({ workspace: wsName });
    const memberships = (
      await Promise.all(
        releases.map(async (r) => {
          const items = await store.listReleaseItems({
            workspace: wsName,
            release_id: r.release_id,
          });
          return items
            .filter((i) => i.item_kind === 'feature' && i.item_id === featureId)
            .map((i) => ({ release: r, item: i }));
        }),
      )
    ).flat();
    const exposure = await store.listFeatureExposure({
      workspace: wsName,
      feature_id: featureId,
    });
    const deployments = (
      await Promise.all(
        releases.map((r) =>
          store.listDeployments({
            workspace: wsName,
            release_id: r.release_id,
          }),
        ),
      )
    ).flat();

    const acceptance = events
      .filter(
        (e) =>
          e.event === 'doc_approved' && e.data?.doc === 'acceptance-package',
      )
      .at(-1);

    return {
      feature,
      initiative,
      docs: docs.map((d) => ({
        doc: d.doc,
        version: d.version,
        edited_by: d.edited_by,
        created_at: d.created_at,
      })),
      tickets,
      tickets_by_type: groups,
      requirements: {
        primary,
        edges: requirementEdges,
      },
      health: findings,
      acceptance: acceptance
        ? {
            accepted: true,
            at: acceptance.ts,
            by: acceptance.actor_id,
            exclusions:
              (acceptance.data?.exclusions as string[] | undefined) ?? [],
          }
        : { accepted: false },
      release: {
        memberships,
        exposure,
        deployments,
      },
      events,
    };
  });

  /** Versioned feature doc read (same shape as the ticket doc route —
   *  diffs derive from consecutive immutable versions, D29). */
  app.get('/api/v1/features/:workspace/:feature/docs/:name', async (req) => {
    const {
      workspace: wsName,
      feature: featureId,
      name,
    } = req.params as { workspace: string; feature: string; name: string };
    deps.workspace(wsName);
    await getFeatureOr404(wsName, featureId);
    const doc = featureDocKind(name);
    if (doc === null) {
      throw badRequest(
        `unknown feature doc '${name}' (expected ${[...FEATURE_DOCS].join('|')})`,
      );
    }
    const dv = await store.getDoc({
      workspace: wsName,
      subject: featureId,
      doc,
    });
    if (!dv) throw notFound(`no ${doc} for ${wsName}/${featureId}`);
    const all = await store.listDocVersions({
      workspace: wsName,
      subject: featureId,
      doc,
    });
    const diffs: { from: string; to: string; diff: string }[] = [];
    for (let i = 1; i < all.length; i++) {
      const prev = all.at(i - 1);
      const cur = all.at(i);
      if (!prev || !cur) continue;
      diffs.push({
        from: `v${prev.version}`,
        to: `v${cur.version}`,
        diff: lineDiff(prev.content, cur.content),
      });
    }
    return {
      name,
      doc,
      content: dv.content,
      version: dv.version,
      versions: all.map((v) => ({
        version: v.version,
        edited_by: v.edited_by,
        created_at: v.created_at,
      })),
      diffs,
    };
  });

  /** The Feature Acceptance Package — the bundle a human reviews
   *  before accepting (approved scope + AC slice + evidence +
   *  exclusions, with live findings visible). */
  app.get('/api/v1/features/:workspace/:feature/acceptance', async (req) => {
    const { workspace: wsName, feature: featureId } = req.params as {
      workspace: string;
      feature: string;
    };
    const ws = deps.workspace(wsName);
    try {
      return await assembleAcceptancePackage(ctxFor(ws), featureId);
    } catch (err) {
      mapFeatureError(err);
    }
  });

  /**
   * The explicit human acceptance gate (PRD §15.7 — "Feature
   * completion is explicit acceptance, never implied by ticket
   * completion"). Gate-write rules apply: `expected_status` fences the
   * write (a stale submission is a 409), and accepting a `done`/
   * `discarded` feature conflicts instead of double-committing.
   * `exclusions` are recorded verbatim in the durable doc_approved
   * event — accepted-with-exclusions is honest, never silent.
   */
  app.post(
    '/api/v1/features/:workspace/:feature/accept',
    async (req, reply) => {
      const { workspace: wsName, feature: featureId } = req.params as {
        workspace: string;
        feature: string;
      };
      const body = parseBody(AcceptBodySchema, req.body, 'feature accept');
      const ws = deps.workspace(wsName);
      const feature = await getFeatureOr404(wsName, featureId);
      if (
        body.expected_status !== undefined &&
        feature.status !== body.expected_status
      ) {
        throw conflict(
          `stale write: expected status '${body.expected_status}', ` +
            `feature is '${feature.status}'`,
        );
      }
      let next: FeatureRow;
      try {
        next = await acceptFeature(ctxFor(ws), featureId, {
          exclusions: body.exclusions ?? [],
        });
      } catch (err) {
        mapFeatureError(err);
      }
      return reply.send({ accepted: true, feature: next });
    },
  );

  /** AC evidence matrix for the Quality tab (same rows the acceptance
   *  package renders — one derivation, no drift). */
  app.get('/api/v1/features/:workspace/:feature/acs', async (req) => {
    const { workspace: wsName, feature: featureId } = req.params as {
      workspace: string;
      feature: string;
    };
    const ws = deps.workspace(wsName);
    await getFeatureOr404(wsName, featureId);
    try {
      const acs = await featureAcceptanceCriteria(ctxFor(ws), featureId);
      return { acs };
    } catch (err) {
      mapFeatureError(err);
    }
  });
}
