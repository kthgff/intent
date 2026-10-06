/**
 * api/releases.ts — wp-136 Delivery API (DELIVERY §6).
 *
 *   GET    /releases/:workspace                    — list
 *   POST   /releases/:workspace                    — {title, target?} → draft
 *   GET    /releases/:workspace/:rel               — items + manifest +
 *          approvals + gates + notes (getReleaseDetail)
 *   POST   /releases/:workspace/:rel/items         — {item_kind, item_id,
 *          partial_ac?, approved_by?} (partial_ac requires approved_by —
 *          invariant 5; a post-freeze add re-cuts the manifest, §4.1)
 *   DELETE /releases/:workspace/:rel/items         — {item_kind, item_id}
 *          (soft-remove; the row stays for audit — DELIVERY §3)
 *   POST   /releases/:workspace/:rel/freeze        — cut manifest, draft→ready
 *   POST   /releases/:workspace/:rel/approve       — {decision, rationale?}
 *          human-only (actor_kind 'agent' → 403, invariant 6)
 *   POST   /releases/:workspace/:rel/release       — approved → released,
 *          all five release gates must pass (markReleased; §6 omits the
 *          ship route — resolved spec gap, see API.md)
 *   POST   /releases/:workspace/:rel/deployments   — {env, sha, evidence}
 *          manual evidence required, every field non-empty (invariant 4)
 *   POST   /features/:workspace/:f/exposure        — {env, state, evidence?,
 *          deployment_id?} — `available` requires a linked confirmed
 *          deployment carrying the feature (invariant 4)
 *   GET    /merge-center/:workspace                — per-ticket readiness
 *          (conductor evaluateMergeCenter)
 *   POST   /tickets/:workspace/:t/corrections      — {title, severity?, …}
 *          → origin:'correction' ticket with parent link (fileCorrection)
 *   POST   /releases/:workspace/:rel/notes/:audience/approve — human-only
 *   POST   /releases/:workspace/:rel/notes/:audience/publish — requires a
 *          human-approved doc_version (publishReleaseNote)
 *   POST   /releases/:workspace/:rel/retro         — queues a `retro` run
 *
 * All writes: zod parseBody (fail-closed 400 on malformed). OCC: writes
 * accept `expected_status` — a stale read of the release status loses
 * with 409 before any domain write. ReleaseError codes map:
 * bad-item/empty-manifest/partial-unapproved/invalid-evidence → 400,
 * not-found → 404, ai-approval → 403,
 * bad-state/gate-failed/no-deployment/not-approved → 409.
 *
 * SSE: the durable `events` rows the domain functions write are
 * mirrored onto the stream via a store wrapper that fans the DELIVERY
 * §5 names out to `notify` (payload = the appended event row) — the
 * stream stays a latency optimization, never the only copy.
 */
import type {
  ConductorWorkspace,
  GhClient,
  StreamEvent,
  ToolCtx,
} from '@veto/conductor';
import {
  type ReleaseCtx,
  ReleaseError,
  addReleaseItem,
  approveRelease,
  approveReleaseNote,
  createRelease,
  evaluateMergeCenter,
  fileCorrection,
  freezeRelease,
  getReleaseDetail,
  markReleased,
  publishReleaseNote,
  recordDeployment,
  releaseNotesRunRequest,
  removeReleaseItem,
  retroRunRequest,
  saveReleaseNoteDraft,
  setFeatureExposure,
} from '@veto/conductor';
import {
  ACTOR_TYPES,
  type DocKind,
  type EventRow,
  FEATURE_EXPOSURE_STATES,
  RELEASE_APPROVAL_DECISIONS,
  RELEASE_ITEM_KINDS,
  RELEASE_NOTE_AUDIENCES,
  type Store,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
} from '@veto/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lineDiff } from './diff.js';
import { ApiError, parseBody } from './server.js';

// ---------------------------------------------------------------------------
// schemas — fail-closed; a malformed body is a 400 before any write
// ---------------------------------------------------------------------------

const CreateReleaseBody = z
  .object({
    title: z.string().min(1),
    target: z.string().nullish(),
  })
  .passthrough();

const Occ = z.object({
  /** OCC — the release status the caller read. A racing write 409s. */
  expected_status: z.string().optional(),
});

const ItemBody = Occ.extend({
  item_kind: z.enum(RELEASE_ITEM_KINDS),
  item_id: z.string().min(1),
  partial_ac: z.array(z.string().min(1)).nullish(),
  approved_by: z.string().nullish(),
  actor_kind: z.enum(ACTOR_TYPES).optional(),
}).passthrough();

const RemoveItemBody = Occ.extend({
  item_kind: z.enum(RELEASE_ITEM_KINDS),
  item_id: z.string().min(1),
}).passthrough();

const ApproveBody = Occ.extend({
  decision: z.enum(RELEASE_APPROVAL_DECISIONS),
  rationale: z.string().nullish(),
  approver: z.string().optional(),
  /** 'human' default; 'agent' is accepted by the schema and refused by
   *  the domain (ai-approval → 403) — invariant 6. */
  actor_kind: z.enum(ACTOR_TYPES).optional(),
}).passthrough();

const DeploymentBody = z
  .object({
    env: z.string().min(1),
    sha: z.string().min(1),
    /** Manual attestation {type:'manual', by, note, url} — required
     *  (invariant 4); field-level validation lives in the domain. */
    evidence: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const ExposureBody = z
  .object({
    env: z.string().min(1),
    state: z.enum(FEATURE_EXPOSURE_STATES),
    audience: z.string().nullish(),
    evidence: z.string().nullish(),
    /** Required when state='available' — a confirmed deployment of a
     *  release carrying the feature (invariant 4). */
    deployment_id: z.string().nullish(),
  })
  .passthrough();

const CorrectionBody = z
  .object({
    title: z.string().min(1),
    severity: z.enum(TICKET_SEVERITIES).nullish(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    repos: z.array(z.string()).optional(),
    feature: z.string().nullish(),
    description: z.string().optional(),
  })
  .passthrough();

const NotesApproveBody = z
  .object({
    approver: z.string().optional(),
    actor_kind: z.enum(ACTOR_TYPES).optional(),
  })
  .passthrough();

const NotesDraftBody = z
  .object({
    content: z.string().min(1),
    edited_by: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// deps
// ---------------------------------------------------------------------------

export interface ReleaseRouteDeps {
  store: Store;
  actor: string;
  /** Resolves a workspace name → ConductorWorkspace (throws 404). */
  workspace: (name: string) => ConductorWorkspace;
  /** The runner/merge tool context for a workspace (MergeCtx base). */
  toolCtx: (ws: ConductorWorkspace) => ToolCtx;
  /** Shepherd's gh client for merge-center readiness (tests stub it). */
  gh?: GhClient;
  /** Queue a pending run (server's queuePendingRun wrapper). */
  requestRun: (
    wsName: string,
    req: { subject: string; stage: string; ticketId?: string },
  ) => Promise<string>;
  /** SSE fan-out — called with the mirrored durable event name. */
  notify?: (event: StreamEvent) => void;
}

/** The DELIVERY §5 event names the stream mirrors (StreamEvent union). */
const STREAMED_EVENTS = new Set<string>([
  'merge_ready',
  'merge_attempted',
  'merge_conflict',
  'release_created',
  'release_items_changed',
  'manifest_cut',
  'release_approved',
  'release_released',
  'deployment_confirmed',
  'feature_exposed',
  'release_note_approved',
  'retro_completed',
  'correction_filed',
  'dependent_revalidated',
]);

// ---------------------------------------------------------------------------
// error mapping — ReleaseError.code → HTTP (DELIVERY §6 + ticket spec)
// ---------------------------------------------------------------------------

function releaseHttp(e: ReleaseError): ApiError {
  switch (e.code) {
    case 'not-found':
      return new ApiError(404, 'not_found', e.message);
    case 'ai-approval':
      return new ApiError(403, 'forbidden', e.message);
    case 'bad-item':
    case 'empty-manifest':
    case 'partial-unapproved':
    case 'invalid-evidence':
      return new ApiError(400, 'bad_request', e.message);
    case 'bad-state':
    case 'gate-failed':
    case 'no-deployment':
    case 'not-approved':
      return new ApiError(409, 'conflict', e.message);
  }
}

/** Re-throw domain errors as HTTP-shaped ApiErrors. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ReleaseError) throw releaseHttp(e);
    throw e;
  }
}

export function registerReleaseRoutes(
  app: FastifyInstance,
  deps: ReleaseRouteDeps,
): void {
  /** ReleaseCtx for a workspace — the same shape the conductor's
   *  transition tools carry (workspace + store + actor + clock). The
   *  wrapped store mirrors DELIVERY §5 durable events onto the SSE
   *  stream. */
  function releaseCtx(ws: ConductorWorkspace): ReleaseCtx {
    const base: Store = deps.store;
    // Proxy (not a spread) — store impls are class instances; methods
    // live on the prototype and may touch private fields, so they must
    // bind to the real instance. Only `appendEvent` is wrapped.
    const store = new Proxy(base, {
      get(target, prop) {
        if (prop === 'appendEvent') {
          return async (e: EventRow) => {
            const id = await base.appendEvent(e);
            if (STREAMED_EVENTS.has(e.event)) {
              deps.notify?.({
                type: e.event as StreamEvent['type'],
                payload: e,
              });
            }
            return id;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Store;
    return {
      workspace: ws.name,
      rootPath: ws.rootPath,
      store,
      actor: deps.actor,
      now: () => new Date(),
    };
  }

  /** OCC — the caller's view of the release status must still be true. */
  async function checkExpected(
    ctx: ReleaseCtx,
    releaseId: string,
    expected: string | undefined,
  ): Promise<void> {
    if (expected === undefined) return;
    const release = await ctx.store.getRelease({
      workspace: ctx.workspace,
      release_id: releaseId,
    });
    if (!release) {
      throw new ApiError(404, 'not_found', `no release ${releaseId}`);
    }
    if (release.status !== expected) {
      throw new ApiError(
        409,
        'conflict',
        `stale write: expected status '${expected}', release is '${release.status}'`,
      );
    }
  }

  // ------------------------------------------------------------------
  // /releases
  // ------------------------------------------------------------------

  app.get('/api/v1/releases/:workspace', async (req) => {
    const { workspace: wsName } = req.params as { workspace: string };
    const ws = deps.workspace(wsName);
    const { status } = (req.query ?? {}) as { status?: string };
    const releases = await deps.store.listReleases({
      workspace: ws.name,
      ...(status ? { status } : {}),
    });
    return { releases };
  });

  app.post('/api/v1/releases/:workspace', async (req, reply) => {
    const { workspace: wsName } = req.params as { workspace: string };
    const ws = deps.workspace(wsName);
    const body = parseBody(CreateReleaseBody, req.body, 'create release');
    const release = await guard(() =>
      createRelease(releaseCtx(ws), {
        title: body.title,
        target: body.target ?? null,
      }),
    );
    return reply.status(201).send({ release });
  });

  app.get('/api/v1/releases/:workspace/:rel', async (req) => {
    const { workspace: wsName, rel } = req.params as {
      workspace: string;
      rel: string;
    };
    const ws = deps.workspace(wsName);
    const detail = await guard(() => getReleaseDetail(releaseCtx(ws), rel));
    return detail;
  });

  app.post('/api/v1/releases/:workspace/:rel/items', async (req) => {
    const { workspace: wsName, rel } = req.params as {
      workspace: string;
      rel: string;
    };
    const ws = deps.workspace(wsName);
    const ctx = releaseCtx(ws);
    const body = parseBody(ItemBody, req.body, 'add release item');
    await checkExpected(ctx, rel, body.expected_status);
    const item = await guard(() =>
      addReleaseItem(ctx, rel, {
        itemKind: body.item_kind,
        itemId: body.item_id,
        partialAc: body.partial_ac ?? null,
        approvedBy: body.approved_by ?? null,
        ...(body.actor_kind ? { actorType: body.actor_kind } : {}),
      }),
    );
    return { item };
  });

  app.delete('/api/v1/releases/:workspace/:rel/items', async (req) => {
    const { workspace: wsName, rel } = req.params as {
      workspace: string;
      rel: string;
    };
    const ws = deps.workspace(wsName);
    const ctx = releaseCtx(ws);
    const body = parseBody(RemoveItemBody, req.body, 'remove release item');
    await checkExpected(ctx, rel, body.expected_status);
    await guard(() =>
      removeReleaseItem(ctx, rel, {
        itemKind: body.item_kind,
        itemId: body.item_id,
      }),
    );
    return { removed: `${body.item_kind}:${body.item_id}` };
  });

  app.post('/api/v1/releases/:workspace/:rel/freeze', async (req) => {
    const { workspace: wsName, rel } = req.params as {
      workspace: string;
      rel: string;
    };
    const ws = deps.workspace(wsName);
    const ctx = releaseCtx(ws);
    const body = parseBody(Occ, req.body, 'freeze release');
    await checkExpected(ctx, rel, body.expected_status);
    const manifest = await guard(() => freezeRelease(ctx, rel));
    return { manifest };
  });

  app.post('/api/v1/releases/:workspace/:rel/approve', async (req) => {
    const { workspace: wsName, rel } = req.params as {
      workspace: string;
      rel: string;
    };
    const ws = deps.workspace(wsName);
    const ctx = releaseCtx(ws);
    const body = parseBody(ApproveBody, req.body, 'approve release');
    await checkExpected(ctx, rel, body.expected_status);
    const approval = await guard(() =>
      approveRelease(ctx, rel, {
        approver: body.approver ?? deps.actor,
        actorType: body.actor_kind ?? 'human',
        decision: body.decision,
        rationale: body.rationale ?? null,
      }),
    );
    return { approval };
  });

  app.post('/api/v1/releases/:workspace/:rel/release', async (req) => {
    const { workspace: wsName, rel } = req.params as {
      workspace: string;
      rel: string;
    };
    const ws = deps.workspace(wsName);
    const ctx = releaseCtx(ws);
    const body = parseBody(Occ, req.body, 'release');
    await checkExpected(ctx, rel, body.expected_status);
    const result = await guard(() => markReleased(ctx, rel));
    return result;
  });

  app.post(
    '/api/v1/releases/:workspace/:rel/deployments',
    async (req, reply) => {
      const { workspace: wsName, rel } = req.params as {
        workspace: string;
        rel: string;
      };
      const ws = deps.workspace(wsName);
      const body = parseBody(DeploymentBody, req.body, 'record deployment');
      const deployment = await guard(() =>
        recordDeployment(releaseCtx(ws), rel, {
          environment: body.env,
          sha: body.sha,
          evidence: body.evidence,
        }),
      );
      return reply.status(201).send({ deployment });
    },
  );

  // ------------------------------------------------------------------
  // /features …/exposure
  // ------------------------------------------------------------------

  app.post('/api/v1/features/:workspace/:f/exposure', async (req) => {
    const { workspace: wsName, f } = req.params as {
      workspace: string;
      f: string;
    };
    const ws = deps.workspace(wsName);
    const body = parseBody(ExposureBody, req.body, 'feature exposure');
    const exposure = await guard(() =>
      setFeatureExposure(releaseCtx(ws), f, {
        environment: body.env,
        state: body.state,
        audience: body.audience ?? null,
        evidence: body.evidence ?? null,
        deploymentId: body.deployment_id ?? null,
      }),
    );
    return { exposure };
  });

  // ------------------------------------------------------------------
  // /merge-center — read-only readiness view (DELIVERY §6)
  // ------------------------------------------------------------------

  app.get('/api/v1/merge-center/:workspace', async (req) => {
    const { workspace: wsName } = req.params as { workspace: string };
    const ws = deps.workspace(wsName);
    if (!deps.gh) {
      throw new ApiError(
        503,
        'unavailable',
        'merge-center readiness requires the shepherd gh client (gh on PATH)',
      );
    }
    const ctx = { ...deps.toolCtx(ws), gh: deps.gh };
    const readiness = await evaluateMergeCenter(ctx);
    // Join the ticket status so the UI can gate merged-only
    // affordances (revert) — readiness rows are evaluated for
    // `ci-watch` tickets, which are by definition not yet merged.
    const statusBy = new Map(
      (await deps.store.listTickets({ workspace: wsName })).map((t) => [
        t.ticket_id,
        t.status,
      ]),
    );
    return {
      tickets: [...readiness.values()].map((r) => ({
        ...r,
        status: statusBy.get(r.ticket_id) ?? null,
      })),
    };
  });

  // ------------------------------------------------------------------
  // /tickets …/corrections
  // ------------------------------------------------------------------

  app.post('/api/v1/tickets/:workspace/:t/corrections', async (req, reply) => {
    const { workspace: wsName, t } = req.params as {
      workspace: string;
      t: string;
    };
    const ws = deps.workspace(wsName);
    const body = parseBody(CorrectionBody, req.body, 'file correction');
    const ticket = await guard(() =>
      fileCorrection(releaseCtx(ws), {
        parent: t,
        title: body.title,
        severity: body.severity ?? null,
        ...(body.priority ? { priority: body.priority } : {}),
        ...(body.repos ? { repos: body.repos } : {}),
        ...(body.feature !== undefined ? { feature: body.feature } : {}),
        ...(body.description ? { description: body.description } : {}),
      }),
    );
    return reply.status(201).send({ ticket });
  });

  // ------------------------------------------------------------------
  // notes approve / publish + retro
  // ------------------------------------------------------------------

  app.post(
    '/api/v1/releases/:workspace/:rel/notes/:audience/approve',
    async (req) => {
      const {
        workspace: wsName,
        rel,
        audience,
      } = req.params as {
        workspace: string;
        rel: string;
        audience: string;
      };
      const ws = deps.workspace(wsName);
      const body = parseBody(NotesApproveBody, req.body, 'approve notes');
      const note = await guard(() =>
        approveReleaseNote(releaseCtx(ws), rel, {
          audience,
          approver: body.approver ?? deps.actor,
          actorType: body.actor_kind ?? 'human',
        }),
      );
      return { note };
    },
  );

  app.post(
    '/api/v1/releases/:workspace/:rel/notes/:audience/publish',
    async (req) => {
      const {
        workspace: wsName,
        rel,
        audience,
      } = req.params as {
        workspace: string;
        rel: string;
        audience: string;
      };
      const ws = deps.workspace(wsName);
      const note = await guard(() =>
        publishReleaseNote(releaseCtx(ws), rel, { audience }),
      );
      return { note };
    },
  );

  app.post('/api/v1/releases/:workspace/:rel/retro', async (req) => {
    const { workspace: wsName, rel } = req.params as {
      workspace: string;
      rel: string;
    };
    const ws = deps.workspace(wsName);
    const runReq = await guard(() => retroRunRequest(releaseCtx(ws), rel));
    const run = await deps.requestRun(ws.name, {
      subject: runReq.subject,
      stage: runReq.stage,
      ...(runReq.ticketId ? { ticketId: runReq.ticketId } : {}),
    });
    return { run };
  });

  // ------------------------------------------------------------------
  // release-subject docs + notes drafting (wp-137 — resolved read gaps:
  // the Release Center UI must render `notes-<audience>.md` drafts and
  // `retro.md`, which live in doc_versions on the REL-NNNN subject and
  // are not reachable via /tickets/…/docs)
  // ------------------------------------------------------------------

  /** Queue the `release-notes` stage — requires a frozen manifest
   *  (releaseNotesRunRequest enforces; 409 bad-state otherwise). */
  app.post('/api/v1/releases/:workspace/:rel/notes', async (req) => {
    const { workspace: wsName, rel } = req.params as {
      workspace: string;
      rel: string;
    };
    const ws = deps.workspace(wsName);
    const runReq = await guard(() =>
      releaseNotesRunRequest(releaseCtx(ws), rel),
    );
    const run = await deps.requestRun(ws.name, {
      subject: runReq.subject,
      stage: runReq.stage,
      ...(runReq.ticketId ? { ticketId: runReq.ticketId } : {}),
    });
    return { run };
  });

  /** Human draft edit — append a `notes-<audience>.md` doc_version and
   *  upsert the `release_notes` row, preserving the pinned approved
   *  version (invariant 6). */
  app.post(
    '/api/v1/releases/:workspace/:rel/notes/:audience/draft',
    async (req) => {
      const {
        workspace: wsName,
        rel,
        audience,
      } = req.params as {
        workspace: string;
        rel: string;
        audience: string;
      };
      const ws = deps.workspace(wsName);
      const body = parseBody(NotesDraftBody, req.body, 'notes draft');
      const note = await guard(() =>
        saveReleaseNoteDraft(releaseCtx(ws), rel, {
          audience,
          content: body.content,
          ...(body.edited_by ? { editedBy: body.edited_by } : {}),
        }),
      );
      return { note };
    },
  );

  /** Read a release-subject doc — restricted to `retro.md` and the
   *  `notes-<audience>.md` kinds (fail-closed 400 otherwise). Returns
   *  the same payload shape as /tickets/…/docs/:name. */
  app.get('/api/v1/releases/:workspace/:rel/docs/:name', async (req) => {
    const {
      workspace: wsName,
      rel,
      name,
    } = req.params as {
      workspace: string;
      rel: string;
      name: string;
    };
    const ws = deps.workspace(wsName);
    const doc = releaseDocFor(name);
    if (doc === null) {
      throw new ApiError(
        400,
        'bad_request',
        `unknown release doc '${name}' (expected retro|${RELEASE_NOTE_AUDIENCES.map(
          (a) => `notes-${a}`,
        ).join('|')})`,
      );
    }
    const dv = await deps.store.getDoc({
      workspace: ws.name,
      subject: rel,
      doc,
    });
    if (!dv) {
      throw new ApiError(404, 'not_found', `no ${doc} for ${ws.name}/${rel}`);
    }
    const all = await deps.store.listDocVersions({
      workspace: ws.name,
      subject: rel,
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
}

/** `retro.md` | `notes-<audience>.md` → DocKind, else null (fail-closed). */
function releaseDocFor(name: string): DocKind | null {
  if (name === 'retro' || name === 'retro.md') return 'retro.md';
  const m = name.match(/^notes-(customer|stakeholder|technical)(\.md)?$/);
  return m ? (`notes-${m[1]}.md` as DocKind) : null;
}
