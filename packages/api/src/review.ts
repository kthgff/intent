/**
 * api/review.ts — Review Studio REST surface (PRD §15.8, wp-148).
 *
 * The routes are a thin shell over `conductor/review/studio` — the
 * engine owns lifecycle legality, commit-bound approvals, permissioned
 * dispositions, out-of-scope routing and the delta computation; this
 * file owns HTTP: zod-fail-closed bodies, workspace-qualified ids,
 * `ReviewStudioError` → 4xx mapping, and the conductor-side effects a
 * decision legitimately drives (gate clears, fix-run queueing).
 *
 * Conventions (API.md):
 *   - decisions bind server-side — `expected_revision` is the stale-
 *     write guard (a client approving last week's head gets a 409,
 *     never a silently re-pinned approval);
 *   - internal approvals are INTERNAL — these routes never call `gh`
 *     and never write a GitHub review; `external_review_mappings`
 *     rows record correspondences only.
 */
import { randomUUID } from 'node:crypto';
import type {
  ReviewFindingStatus,
  RunBaseline,
  Store,
  TicketRow,
} from '@sprint-runner/core';
import { REVIEW_ACTIONS } from '@sprint-runner/core';
import { git } from '@sprint-runner/gitops';
import { studio } from '@sprint-runner/conductor';
import type { ConductorWorkspace } from '@sprint-runner/conductor';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';

type StudioCtx = studio.StudioCtx;
const {
  ReviewStudioError,
  addComment,
  approvalState,
  changesSince,
  ensureSession,
  evidenceKind,
  linkEvidence,
  listComments,
  listDecisions,
  listEvidenceLinks,
  listExternalMappings,
  mapExternal,
  reclassifyComment,
  recordDecision,
  recordRevision,
  requirementView,
  transitionFinding,
  unlinkEvidence,
  upsertFinding,
} = studio;

// ---------------------------------------------------------------------------
// Env — closures the server owns (gate clears + run queueing are
// conductor mechanics, not engine mechanics)
// ---------------------------------------------------------------------------

export interface ReviewRouteEnv {
  store: Store;
  /** `actor:` identity (config.actor) — default reviewer/author. */
  actor: string;
  nowIso: () => string;
  workspace: (name: string) => ConductorWorkspace;
  /** Clear a gate item the conductor surfaced (idempotent; throws 404
   *  when absent / 409 when already cleared — callers catch). */
  clearGate: (args: {
    ws: ConductorWorkspace;
    subject: string;
    gate: string;
  }) => Promise<unknown>;
  /** Queue a pending run (fix loop) — returns run id or null when a
   *  live run fences the (subject, stage). */
  requestRun: (
    wsName: string,
    req: { subject: string; stage: string; ticketId?: string },
  ) => Promise<string>;
  ticketOrNull: (wsName: string, ticketId: string) => Promise<TicketRow | null>;
}

const badRequest = (m: string) => new ApiError(400, 'bad_request', m);

// ---------------------------------------------------------------------------
// Request-body schemas (fail-closed — malformed bodies never reach a write)
// ---------------------------------------------------------------------------

const CreateSessionBody = z.object({
  workspace: z.string().min(1),
  subject: z.string().min(1),
  review_id: z.string().min(1).optional(),
});

const RevisionBody = z.object({
  head_sha: z.string().min(1),
  base_sha: z.string().nullish(),
  baseline: z
    .object({
      rs_version: z.number().int().nullish(),
      ticket_rev: z.number().int().nullish(),
      design_rev: z.number().int().nullish(),
      ac_ids: z.array(z.string()).optional(),
      base_sha: z.string().nullish(),
      contract_ver: z.number().int().nullish(),
    })
    .nullish(),
});

const FindingBody = z
  .object({
    finding_id: z.string().min(1).optional(),
    body: z.string().min(1),
    severity: z.string().optional(),
    category: z.string().optional(),
    kind: z.string().optional(),
    subject: z.string().nullish(),
    file: z.string().nullish(),
    line: z.number().int().nullish(),
    symbol: z.string().nullish(),
    repo: z.string().nullish(),
    evidence: z.string().nullish(),
    suggested_fix: z.string().nullish(),
    confidence: z.number().min(0).max(1).nullish(),
    blocking: z.boolean().optional(),
    author: z.string().nullish(),
    security_category: z.string().nullish(),
    affected_asset: z.string().nullish(),
    exposure: z.string().nullish(),
    policy_violated: z.string().nullish(),
    expected_status: z.string().optional(),
  })
  .passthrough();

const TransitionBody = z.object({
  to: z.string().min(1),
  rationale: z.string().nullish(),
  actor: z.string().optional(),
  actor_kind: z.enum(['human', 'agent', 'system']).optional(),
  expected_status: z.string().optional(),
});

const CommentBody = z
  .object({
    comment_id: z.string().min(1).optional(),
    body: z.string().min(1),
    type: z.string().nullish(),
    disposition: z.string().nullish(),
    file: z.string().nullish(),
    line: z.number().int().nullish(),
    subject: z.string().nullish(),
    revision: z.number().int().nullish(),
    author: z.string().nullish(),
    ai_classification: z.record(z.unknown()).nullish(),
  })
  .passthrough();

const ReclassifyBody = z.object({
  type: z.string().min(1),
  disposition: z.string().nullish(),
});

const DecisionBody = z
  .object({
    decision_id: z.string().min(1).optional(),
    reviewer: z.string().optional(),
    action: z.enum(REVIEW_ACTIONS),
    rationale: z.string().nullish(),
    /** Stale-write guard — must equal the latest revision or 409. */
    expected_revision: z.number().int().optional(),
    board: z.string().nullish(),
  })
  .passthrough();

const EvidenceBody = z.object({
  evidence_ref: z.string().min(1),
  kind: z.string().nullish(),
});

const MappingBody = z.object({
  finding_id: z.string().nullish(),
  external_kind: z.string().min(1),
  external_id: z.string().min(1),
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

/** `ReviewStudioError` → ApiError passthrough at the route boundary. */
function mapErr(e: unknown): never {
  if (e instanceof ReviewStudioError) {
    throw new ApiError(e.statusCode, e.code, e.message);
  }
  throw e;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerReviewRoutes(
  app: FastifyInstance,
  env: ReviewRouteEnv,
): void {
  const { store } = env;

  function ctxFor(ws: ConductorWorkspace): StudioCtx {
    return {
      store,
      workspace: ws.name,
      actor: env.actor,
      now: () => new Date(),
    };
  }

  /** Server-side diff for the delta view — real `git diff` per
   *  ticket_repos worktree (multi-repo heads decode `repo@sha,…`). */
  async function diffForTicket(
    ws: ConductorWorkspace,
    subject: string,
    fromSha: string,
    toSha: string,
  ): Promise<{ repo: string; diff: string }[]> {
    const rows = await store.listTicketRepos({
      workspace: ws.name,
      ticket_id: subject,
    });
    const fromMap = headMap(fromSha);
    const toMap = headMap(toSha);
    const out: { repo: string; diff: string }[] = [];
    for (const tr of rows) {
      if (!tr.worktree) continue;
      const from = fromMap.get(tr.repo) ?? (fromMap.size === 1 && !fromSha.includes('@') ? fromSha : null);
      const to = toMap.get(tr.repo) ?? (toMap.size === 1 && !toSha.includes('@') ? toSha : null);
      if (!from || !to) continue;
      try {
        const r = await git(['diff', '--stat', `${from}..${to}`], {
          cwd: tr.worktree,
        });
        const names = await git(['diff', '--name-status', `${from}..${to}`], {
          cwd: tr.worktree,
        });
        out.push({
          repo: tr.repo,
          diff: `${names.stdout}${names.stdout.endsWith('\n') || names.stdout.length === 0 ? '' : '\n'}${r.stdout}`.trim(),
        });
      } catch (e) {
        out.push({
          repo: tr.repo,
          diff: `<diff unavailable: ${(e as Error).message}>`,
        });
      }
    }
    return out;
  }

  /** Decode a bound head token — `repo@sha,repo2@sha2` → per-repo map;
   *  a bare sha maps to the empty-string repo (single-repo head). */
  function headMap(head: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const part of head.split(',')) {
      const at = part.indexOf('@');
      if (at === -1) map.set('', part.trim());
      else map.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    return map;
  }

  async function sessionOr404(wsName: string, reviewId: string) {
    const s = await store.getReviewSession({
      workspace: wsName,
      review_id: reviewId,
    });
    if (!s) {
      throw new ApiError(
        404,
        'not_found',
        `no review session '${reviewId}' in ${wsName}`,
      );
    }
    return s;
  }

  // ---- sessions ----

  app.get('/api/v1/reviews', async (req) => {
    const q = req.query as {
      workspace?: string;
      subject?: string;
      status?: string;
    };
    return {
      sessions: await store.listReviewSessions({
        ...(q.workspace ? { workspace: q.workspace } : {}),
        ...(q.subject ? { subject: q.subject } : {}),
        ...(q.status ? { status: q.status } : {}),
      }),
    };
  });

  app.post('/api/v1/reviews', async (req, reply) => {
    const body = parseBody(CreateSessionBody, req.body, 'reviews.create');
    const ws = env.workspace(body.workspace);
    const session = await ensureSession(ctxFor(ws), {
      subject: body.subject,
      ...(body.review_id ? { reviewId: body.review_id } : {}),
    }).catch(mapErr);
    return reply.status(201).send({ session });
  });

  app.get('/api/v1/reviews/:workspace/:review', async (req) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    const session = await sessionOr404(wsName, review);
    const revisions = await store.listReviewRevisions({
      workspace: wsName,
      review_id: review,
    });
    const findings = await store.listReviewFindings({
      workspace: wsName,
      review_id: review,
    });
    const comments = await store.listReviewComments({
      workspace: wsName,
      review_id: review,
    });
    const decisions = await store.listReviewDecisions({
      workspace: wsName,
      review_id: review,
    });
    return {
      session,
      revisions,
      latest_revision: revisions[revisions.length - 1] ?? null,
      findings,
      comments,
      decisions,
      approval_state: await approvalState(ctxFor(ws), review),
    };
  });

  app.post('/api/v1/reviews/:workspace/:review/close', async (req) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const session = await sessionOr404(wsName, review);
    const body = (req.body ?? {}) as { status?: string };
    const reopen = body?.status === 'open';
    const next = {
      ...session,
      status: (reopen ? 'open' : 'closed') as typeof session.status,
      closed_at: reopen ? null : env.nowIso(),
    };
    await store.upsertReviewSession(next);
    return { session: next };
  });

  // ---- revisions (reviewable heads) ----

  app.post('/api/v1/reviews/:workspace/:review/revisions', async (req, reply) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    await sessionOr404(wsName, review);
    const body = parseBody(RevisionBody, req.body, 'revisions.record');
    const result = await recordRevision(ctxFor(ws), {
      reviewId: review,
      headSha: body.head_sha,
      baseSha: body.base_sha ?? null,
      baseline: (body.baseline as RunBaseline | undefined) ?? null,
    }).catch(mapErr);
    return reply
      .status(result.created ? 201 : 200)
      .send({
        revision: result.revision,
        created: result.created,
        stale_approvals: result.stale_approvals,
      });
  });

  // ---- "Changes Since Your Review" delta ----

  app.get('/api/v1/reviews/:workspace/:review/delta', async (req) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    const session = await sessionOr404(wsName, review);
    const q = req.query as { reviewer?: string; from?: string };
    const from = q.from !== undefined ? Number(q.from) : undefined;
    if (q.from !== undefined && !Number.isInteger(from)) {
      throw badRequest('delta: {from} must be a revision number');
    }
    return changesSince(ctxFor(ws), {
      reviewId: review,
      ...(q.reviewer ? { reviewer: q.reviewer } : {}),
      ...(from !== undefined ? { fromRevision: from } : {}),
      diffFn: (a, b) => diffForTicket(ws, session.subject, a, b),
    }).catch(mapErr);
  });

  // ---- findings ----

  app.get('/api/v1/reviews/:workspace/:review/findings', async (req) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    await sessionOr404(wsName, review);
    const q = req.query as { status?: string; severity?: string };
    return {
      findings: await store.listReviewFindings({
        workspace: wsName,
        review_id: review,
        ...(q.status ? { status: q.status } : {}),
        ...(q.severity ? { severity: q.severity } : {}),
      }),
    };
  });

  app.post('/api/v1/reviews/:workspace/:review/findings', async (req, reply) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    const session = await sessionOr404(wsName, review);
    const body = parseBody(FindingBody, req.body, 'findings.create');
    const findingId =
      body.finding_id ?? `f-${review}-${randomUUID().slice(0, 8)}`;
    const latest = await store.getReviewRevision({
      workspace: wsName,
      review_id: review,
    });
    const { finding, created } = await upsertFinding(ctxFor(ws), {
      workspace: wsName,
      org: session.org ?? null,
      finding_id: findingId,
      review_id: review,
      revision: latest?.revision ?? null,
      subject: body.subject ?? null,
      status: 'open',
      severity: (body.severity ?? null) as never,
      category: (body.category ?? null) as never,
      kind: (body.kind ?? null) as never,
      thread_id: null,
      file: body.file ?? null,
      line: body.line ?? null,
      symbol: body.symbol ?? null,
      repo: body.repo ?? null,
      body: body.body,
      evidence: body.evidence ?? null,
      suggested_fix: body.suggested_fix ?? null,
      confidence: body.confidence ?? null,
      blocking: body.blocking ?? false,
      security_category: (body.security_category ?? null) as never,
      affected_asset: body.affected_asset ?? null,
      exposure: body.exposure ?? null,
      policy_violated: body.policy_violated ?? null,
      author: body.author ?? env.actor,
      created_at: env.nowIso(),
      updated_at: null,
    }).catch(mapErr);
    return reply.status(created ? 201 : 200).send({ finding });
  });

  app.get(
    '/api/v1/reviews/:workspace/:review/findings/:finding',
    async (req) => {
      const { workspace: wsName, review, finding } = req.params as {
        workspace: string;
        review: string;
        finding: string;
      };
      await sessionOr404(wsName, review);
      const row = await store.getReviewFinding({
        workspace: wsName,
        finding_id: finding,
      });
      if (!row || row.review_id !== review) {
        throw new ApiError(404, 'not_found', `no finding '${finding}'`);
      }
      return {
        finding: row,
        history: await store.listFindingResolutions({
          workspace: wsName,
          finding_id: finding,
        }),
        evidence_links: await listEvidenceLinks(ctxFor(env.workspace(wsName)), {
          reviewId: review,
          findingId: finding,
        }),
        external_mappings: await listExternalMappings(
          ctxFor(env.workspace(wsName)),
          { reviewId: review, findingId: finding },
        ),
      };
    },
  );

  app.post(
    '/api/v1/reviews/:workspace/:review/findings/:finding/transition',
    async (req) => {
      const { workspace: wsName, review, finding } = req.params as {
        workspace: string;
        review: string;
        finding: string;
      };
      const ws = env.workspace(wsName);
      await sessionOr404(wsName, review);
      const body = parseBody(TransitionBody, req.body, 'findings.transition');
      const current = await store.getReviewFinding({
        workspace: wsName,
        finding_id: finding,
      });
      if (!current || current.review_id !== review) {
        throw new ApiError(404, 'not_found', `no finding '${finding}'`);
      }
      // Stale-write guard — the human triaged since the client's read.
      if (
        body.expected_status !== undefined &&
        current.status !== body.expected_status
      ) {
        throw new ApiError(
          409,
          'conflict',
          `stale write: expected status '${body.expected_status}', ` +
            `finding is '${current.status}'`,
        );
      }
      const result = await transitionFinding(ctxFor(ws), {
        findingId: finding,
        to: body.to as ReviewFindingStatus,
        actor: body.actor ?? env.actor,
        actorKind: body.actor_kind ?? 'human',
        rationale: body.rationale ?? null,
      }).catch(mapErr);
      return result;
    },
  );

  // ---- evidence links ----

  app.post(
    '/api/v1/reviews/:workspace/:review/findings/:finding/evidence',
    async (req, reply) => {
      const { workspace: wsName, review, finding } = req.params as {
        workspace: string;
        review: string;
        finding: string;
      };
      const ws = env.workspace(wsName);
      const body = parseBody(EvidenceBody, req.body, 'evidence.link');
      const row = await linkEvidence(ctxFor(ws), {
        reviewId: review,
        findingId: finding,
        evidenceRef: body.evidence_ref,
        kind: body.kind ?? evidenceKind(body.evidence_ref),
      }).catch(mapErr);
      return reply.status(201).send({ link: row });
    },
  );

  app.delete(
    '/api/v1/reviews/:workspace/:review/findings/:finding/evidence/:ref',
    async (req) => {
      const { workspace: wsName, review, finding, ref } = req.params as {
        workspace: string;
        review: string;
        finding: string;
        ref: string;
      };
      const ws = env.workspace(wsName);
      await unlinkEvidence(ctxFor(ws), {
        reviewId: review,
        findingId: finding,
        evidenceRef: decodeURIComponent(ref),
      }).catch(mapErr);
      return { removed: decodeURIComponent(ref) };
    },
  );

  // ---- semantic comments ----

  app.get('/api/v1/reviews/:workspace/:review/comments', async (req) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    const q = req.query as { subject?: string };
    return {
      comments: await listComments(ctxFor(ws), {
        reviewId: review,
        ...(q.subject ? { subject: q.subject } : {}),
      }),
    };
  });

  app.post('/api/v1/reviews/:workspace/:review/comments', async (req, reply) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    const body = parseBody(CommentBody, req.body, 'comments.create');
    const result = await addComment(ctxFor(ws), {
      reviewId: review,
      commentId: body.comment_id ?? `cm-${randomUUID().slice(0, 8)}`,
      body: body.body,
      author: body.author ?? env.actor,
      type: (body.type ?? null) as never,
      disposition: (body.disposition ?? null) as never,
      file: body.file ?? null,
      line: body.line ?? null,
      subject: body.subject ?? null,
      revision: body.revision ?? null,
      aiClassification: body.ai_classification ?? null,
    }).catch(mapErr);
    return reply.status(201).send(result);
  });

  app.post(
    '/api/v1/reviews/:workspace/:review/comments/:comment/reclassify',
    async (req) => {
      const { workspace: wsName, review, comment } = req.params as {
        workspace: string;
        review: string;
        comment: string;
      };
      const ws = env.workspace(wsName);
      const body = parseBody(ReclassifyBody, req.body, 'comments.reclassify');
      return reclassifyComment(ctxFor(ws), {
        reviewId: review,
        commentId: comment,
        type: body.type as never,
        disposition: (body.disposition ?? null) as never,
      }).catch(mapErr);
    },
  );

  // ---- decisions (commit-bound verdicts) ----

  app.get('/api/v1/reviews/:workspace/:review/decisions', async (req) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    return { decisions: await listDecisions(ctxFor(ws), review) };
  });

  app.post('/api/v1/reviews/:workspace/:review/decisions', async (req, reply) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    const session = await sessionOr404(wsName, review);
    const body = parseBody(DecisionBody, req.body, 'decisions.record');

    // Stale-write guard — the bound revision moved since the client's
    // read (new commits landed): a 409, never a silently re-pinned
    // approval (§15.8 — approvals bind head SHA + baseline).
    if (body.expected_revision !== undefined) {
      const latest = await store.getReviewRevision({
        workspace: wsName,
        review_id: review,
      });
      if ((latest?.revision ?? 0) !== body.expected_revision) {
        throw new ApiError(
          409,
          'conflict',
          `stale write: expected revision ${body.expected_revision}, ` +
            `latest is ${latest?.revision ?? 'none'}`,
        );
      }
    }

    const result = await recordDecision(ctxFor(ws), {
      reviewId: review,
      decisionId: body.decision_id ?? `rd-${randomUUID().slice(0, 8)}`,
      reviewer: body.reviewer ?? env.actor,
      action: body.action,
      rationale: body.rationale ?? null,
      board: body.board ?? null,
    }).catch(mapErr);

    // ---- conductor-side effects the decision drives ----
    const gates_cleared: string[] = [];
    let run: string | null = null;
    if (body.action === 'approve') {
      // An internal approval clears the review gates the conductor
      // surfaced — 'changes-requested' then 'approved' (the ticket
      // advances through nextStage on the next tick).
      for (const gate of ['changes-requested', 'approved']) {
        const item = await store.getGateItem({
          workspace: wsName,
          subject: session.subject,
          gate,
        });
        if (item && !item.cleared_at) {
          await env.clearGate({ ws, subject: session.subject, gate }).catch(
            () => null,
          );
          gates_cleared.push(gate);
        }
      }
    }
    let fix_already_running = false;
    if (body.action === 'request-fix') {
      // Request AI Fix → back into the fix loop. A live run fencing
      // (subject, fix) is not an error — the decision is durable and
      // the loop is already moving; report it, don't fail the write.
      const ticket = await env.ticketOrNull(wsName, session.subject);
      try {
        run = await env.requestRun(wsName, {
          subject: session.subject,
          stage: 'fix',
          ...(ticket ? { ticketId: ticket.ticket_id } : {}),
        });
      } catch (e) {
        if (e instanceof ApiError && e.statusCode === 409) {
          fix_already_running = true;
        } else throw e;
      }
    }
    return reply.status(201).send({
      ...result,
      gates_cleared,
      ...(run ? { run } : {}),
      ...(fix_already_running ? { fix_already_running } : {}),
    });
  });

  // ---- requirement-first view ----

  app.get(
    '/api/v1/reviews/:workspace/:review/requirements/:ac',
    async (req) => {
      const { workspace: wsName, review, ac } = req.params as {
        workspace: string;
        review: string;
        ac: string;
      };
      const ws = env.workspace(wsName);
      return requirementView(ctxFor(ws), {
        reviewId: review,
        acId: decodeURIComponent(ac),
      }).catch(mapErr);
    },
  );

  // ---- external mappings (correspondences — GitHub authoritative) ----

  app.get('/api/v1/reviews/:workspace/:review/mappings', async (req) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    const q = req.query as { finding_id?: string };
    return {
      mappings: await listExternalMappings(ctxFor(ws), {
        reviewId: review,
        ...(q.finding_id ? { findingId: q.finding_id } : {}),
      }),
    };
  });

  app.post('/api/v1/reviews/:workspace/:review/mappings', async (req, reply) => {
    const { workspace: wsName, review } = req.params as {
      workspace: string;
      review: string;
    };
    const ws = env.workspace(wsName);
    const body = parseBody(MappingBody, req.body, 'mappings.create');
    const row = await mapExternal(ctxFor(ws), {
      reviewId: review,
      findingId: body.finding_id ?? null,
      externalKind: body.external_kind,
      externalId: body.external_id,
    }).catch(mapErr);
    return reply.status(201).send({ mapping: row });
  });
}
