/**
 * api/discovery.ts — the Discovery UI surface (PRD §15.3/§15.9, wp-147).
 *
 * Route groups:
 *   - `/interview-wizards`        — the versioned wizard catalog (the
 *     MVP configs are seeded lazily on first session start so a GET
 *     never writes);
 *   - `/interview-sessions`       — the Interview Orchestrator surface:
 *     start/list/detail, answer turns, the three input modes
 *     (conversation|guided|bulk — switchable without loss), question
 *     resolution (skipped/unanswerable are first-class), slot actions
 *     (confirm / not-applicable / defer), pause/resume with the
 *     knowledge-diff briefing, and `/understanding` — the Understanding
 *     Panel payload (wp-146 contract: confirmed / interpretation /
 *     needs-clarification / decision-required buckets, explainable
 *     readiness — never a score);
 *   - `/statements`               — the Statement Ledger surface:
 *     list/detail (+versions/relations/decisions), the human decide
 *     actions (confirm/dispute/reject) and correction edits (a new
 *     statement + `supersedes` edge — versioned history, never a
 *     silent overwrite);
 *   - `/statement-decisions`      — open disagreement items, ruled by
 *     humans (`decide` optionally applies the outcome, `dismiss` only
 *     closes the item);
 *   - `/tray` + `PATCH/DELETE /board-items/:id` — S-19/S-20 capture
 *     tray listing + optimistic-conflict item mutations
 *     (`expected_updated_at` fences stale writes → 409).
 *
 * The routes are a thin shell over `conductor/interview` +
 * `conductor/semantics` — the engines own lifecycle legality; this
 * file owns HTTP: zod-fail-closed bodies, workspace scoping, and
 * error → 4xx mapping.
 */
import {
  BoardError,
  StatementError,
  confirmStatement,
  decideStatementDecision,
  dismissStatementDecision,
  disputeStatement,
  interview,
  promoteTrayItem,
  proposeStatement,
  rejectStatement,
  supersedeStatement,
} from '@veto/conductor';
import type {
  BoardItem,
  StatementRow,
  StatementStatus,
  Store,
} from '@veto/core';
import {
  BOARD_ITEM_KINDS,
  BOARD_ITEM_STATUSES,
  INTERVIEW_MODES,
  INTERVIEW_SESSION_STATUSES,
  NOTE_IMPORTANCES,
  NOTE_KINDS,
  NOTE_STATUSES,
} from '@veto/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './server.js';
import type { StreamEvent } from './sse.js';

export interface DiscoveryRouteEnv {
  store: Store;
  actor: string;
  nowIso: () => string;
  workspace: (name: string) => unknown;
  /** SSE fan-out — mutations emit `interview_updated` so the
   *  Understanding Panel / wizard surface refresh live (the durable
   *  write always lands first; the stream is a hint). */
  notify?: (event: StreamEvent) => void;
}

// ---------------------------------------------------------------------------
// Body schemas (fail-closed)
// ---------------------------------------------------------------------------

const WorkspaceName = z.string().min(1).max(64);
const SessionId = z.string().min(1).max(200);
const enumOf = (vals: readonly string[]) =>
  z.string().refine((v) => vals.includes(v), {
    message: `expected one of ${vals.join('|')}`,
  });

const StartSessionBody = z.object({
  workspace: WorkspaceName,
  wizard_id: z.string().min(1).max(64),
  subject: z.string().max(200).nullish(),
  mode: enumOf(INTERVIEW_MODES).optional(),
  session_id: z.string().min(1).max(200).optional(),
  branch: z.string().max(64).nullish(),
  role: z.string().max(64).nullish(),
});

const AnswerBody = z.object({
  workspace: WorkspaceName,
  answer: z.string().min(1).max(100_000),
  question_id: z.string().max(300).optional(),
  slot: z.string().max(120).optional(),
  slots: z.array(z.string().max(120)).max(50).optional(),
  branch: z.string().max(64).nullish(),
});

const ModeBody = z.object({
  workspace: WorkspaceName,
  mode: enumOf(INTERVIEW_MODES),
});

const StatusBody = z.object({
  workspace: WorkspaceName,
  status: enumOf(INTERVIEW_SESSION_STATUSES),
});

const ResolveQuestionBody = z.object({
  workspace: WorkspaceName,
  status: z.enum(['answered', 'skipped', 'unanswerable']),
  reason: z.string().max(2000).nullish(),
});

const SlotBody = z.object({
  workspace: WorkspaceName,
  state: z.enum(['known', 'not-applicable', 'deferred']),
  value: z.string().max(4000).nullish(),
});

const StatementDecideBody = z.object({
  workspace: WorkspaceName,
  action: z.enum(['confirm', 'dispute', 'reject']),
  reason: z.string().max(4000).nullish(),
});

const StatementCorrectBody = z.object({
  workspace: WorkspaceName,
  /** The corrected wording — becomes a NEW statement that supersedes
   *  the old one (history preserved; never an overwrite). */
  text: z.string().min(1).max(20_000),
  /** Optionally bind the corrected statement to session slots so the
   *  correction feeds back into the interview (§15.9). */
  session_id: SessionId.optional(),
  slots: z.array(z.string().max(120)).max(50).optional(),
});

const DecisionBody = z.object({
  workspace: WorkspaceName,
  decision: z.string().min(1).max(4000),
  rationale: z.string().max(4000).nullish(),
  apply: z.enum(['confirmed', 'rejected', 'superseded', 'proposed']).optional(),
});

const DismissDecisionBody = z.object({
  workspace: WorkspaceName,
  rationale: z.string().max(4000).nullish(),
});

const PatchItemBody = z.object({
  workspace: WorkspaceName,
  /** OCC fence — the `updated_at` the client read. Stale writes 409. */
  expected_updated_at: z.string().min(1),
  board: z.string().max(64).nullable().optional(),
  kind: enumOf(BOARD_ITEM_KINDS).optional(),
  note_kind: enumOf(NOTE_KINDS).nullable().optional(),
  importance: enumOf(NOTE_IMPORTANCES).nullable().optional(),
  topic: z.string().max(200).nullable().optional(),
  applies_to: z.array(z.string().max(200)).max(100).nullable().optional(),
  note_status: enumOf(NOTE_STATUSES).optional(),
  rationale: z.string().max(4000).nullable().optional(),
  title: z.string().max(500).nullable().optional(),
  body: z.string().max(100_000).nullable().optional(),
  ref: z.string().max(500).nullable().optional(),
  zone: z.string().max(120).nullable().optional(),
  serves: z.array(z.string().max(200)).max(100).nullable().optional(),
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
  w: z.number().nullable().optional(),
  h: z.number().nullable().optional(),
  status: enumOf(BOARD_ITEM_STATUSES).optional(),
});

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

function query(req: { query: unknown }): { workspace?: string } {
  return req.query as { workspace?: string };
}

function requireWorkspace(raw: string | undefined): string {
  if (!raw) throw new ApiError(400, 'bad_request', 'workspace is required');
  return raw;
}

// ---------------------------------------------------------------------------

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  env: DiscoveryRouteEnv,
): void {
  const { store } = env;
  const actor = { id: env.actor, type: 'human' as const };
  const ictx = (ws: string): interview.InterviewCtx => ({
    store,
    workspace: ws,
    actor: env.actor,
    now: () => new Date(),
  });

  /** Engine errors → 4xx at the route boundary (never a 500 leak). */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof interview.InterviewError) {
        throw new ApiError(e.statusCode, e.code.replace(/-/g, '_'), e.message);
      }
      if (e instanceof StatementError || e instanceof BoardError) {
        throw new ApiError(400, 'bad_request', e.message);
      }
      throw e;
    }
  }

  const touched = (ws: string, session?: string) =>
    env.notify?.({
      type: 'interview_updated',
      payload: { workspace: ws, session_id: session ?? null },
    });

  /** Board-item live hint (D52) — the conductor's StreamEvent union
   *  has no `board_item_updated` member, so the hint rides the
   *  `notification` type with `payload.kind` discriminating; UIs
   *  re-read durable state (the stream is never the only copy). */
  const boardItemTouched = (ws: string, item: BoardItem | string) =>
    env.notify?.({
      type: 'notification',
      payload: {
        kind: 'board_item_updated',
        workspace: ws,
        item_id: typeof item === 'string' ? item : item.id,
        board: typeof item === 'string' ? null : (item.board ?? null),
      },
    });

  async function requireSession(ws: string, sessionId: string) {
    const s = await interview.getSession(ictx(ws), sessionId);
    if (!s) {
      throw new ApiError(
        404,
        'not_found',
        `no interview session '${sessionId}' in ${ws}`,
      );
    }
    return s;
  }

  // ------------------------------------------------------------------
  // Wizard catalog — the MVP configs are the registry; persisted
  // versions annotate the listing (GET stays read-only).
  // ------------------------------------------------------------------

  app.get('/api/v1/interview-wizards', async (req) => {
    const wsName = requireWorkspace(query(req).workspace);
    env.workspace(wsName);
    const wizards = await Promise.all(
      interview.MVP_WIZARDS.map(async (cfg) => {
        const def = await store.getWizardDefinition({
          workspace: wsName,
          wizard_id: cfg.wizard_id,
        });
        return {
          wizard_id: cfg.wizard_id,
          name: cfg.name,
          description: cfg.description,
          version: cfg.version,
          current_version: def?.current_version ?? null,
          slots: cfg.slots.map((s) => ({
            slot: s.slot,
            label: s.label ?? null,
            required: s.required === true,
            scope: s.scope ?? null,
            question: s.question ?? null,
          })),
          thresholds: interview.thresholdsOf(cfg),
        };
      }),
    );
    return { wizards };
  });

  // ------------------------------------------------------------------
  // Interview sessions
  // ------------------------------------------------------------------

  app.get('/api/v1/interview-sessions', async (req) => {
    const q = req.query as {
      workspace?: string;
      status?: string;
      subject?: string;
    };
    const wsName = requireWorkspace(q.workspace);
    env.workspace(wsName);
    const sessions = await store.listInterviewSessions({
      workspace: wsName,
      ...(q.status ? { status: q.status } : {}),
      ...(q.subject ? { subject: q.subject } : {}),
    });
    return { sessions };
  });

  app.post('/api/v1/interview-sessions', async (req, reply) => {
    const body = parse(StartSessionBody, req.body, 'interview session');
    env.workspace(body.workspace);
    const session = await call(async () => {
      // Seed the MVP wizard catalog idempotently — session start is
      // the write path, so registering definitions here keeps GETs
      // read-only.
      await interview.seedMvpWizards(ictx(body.workspace));
      return interview.startSession(ictx(body.workspace), {
        wizardId: body.wizard_id,
        subject: body.subject ?? null,
        ...(body.mode !== undefined ? { mode: body.mode as never } : {}),
        ...(body.session_id !== undefined
          ? { sessionId: body.session_id }
          : {}),
        branch: body.branch ?? null,
        role: body.role ?? null,
      });
    });
    touched(body.workspace, session.session_id);
    return reply.status(201).send({ session });
  });

  app.get('/api/v1/interview-sessions/:session', async (req) => {
    const { session: sessionId } = req.params as { session: string };
    const wsName = requireWorkspace(query(req).workspace);
    env.workspace(wsName);
    const session = await requireSession(wsName, sessionId);
    const ctx = ictx(wsName);
    const [slots, questions, messages, readiness, branches] = await Promise.all(
      [
        interview.listSlots(ctx, sessionId),
        interview.listQuestions(ctx, sessionId),
        interview.transcript(ctx, sessionId),
        call(() => interview.evaluateReadiness(ctx, sessionId)),
        store.listInterviewBranches({
          workspace: wsName,
          session_id: sessionId,
        }),
      ],
    );
    const pending = await interview.pendingQuestion(ctx, sessionId);
    return {
      session,
      slots,
      questions,
      pending_question: pending,
      transcript: messages,
      readiness,
      branches,
    };
  });

  app.post('/api/v1/interview-sessions/:session/answer', async (req) => {
    const { session: sessionId } = req.params as { session: string };
    const body = parse(AnswerBody, req.body, 'interview answer');
    env.workspace(body.workspace);
    await requireSession(body.workspace, sessionId);
    const result = await call(() =>
      interview.submitAnswer(ictx(body.workspace), {
        sessionId,
        answer: body.answer,
        ...(body.question_id !== undefined
          ? { questionId: body.question_id }
          : {}),
        ...(body.slot !== undefined ? { slot: body.slot } : {}),
        ...(body.slots !== undefined ? { slots: body.slots } : {}),
        branch: body.branch ?? null,
      }),
    );
    touched(body.workspace, sessionId);
    return { result };
  });

  app.post('/api/v1/interview-sessions/:session/mode', async (req) => {
    const { session: sessionId } = req.params as { session: string };
    const body = parse(ModeBody, req.body, 'interview mode');
    env.workspace(body.workspace);
    const session = await call(() =>
      interview.setMode(ictx(body.workspace), {
        sessionId,
        mode: body.mode as never,
      }),
    );
    touched(body.workspace, sessionId);
    return { session };
  });

  app.post('/api/v1/interview-sessions/:session/status', async (req) => {
    const { session: sessionId } = req.params as { session: string };
    const body = parse(StatusBody, req.body, 'interview status');
    env.workspace(body.workspace);
    const session = await call(() =>
      interview.setStatus(ictx(body.workspace), {
        sessionId,
        status: body.status as never,
      }),
    );
    touched(body.workspace, sessionId);
    return { session };
  });

  app.post('/api/v1/interview-sessions/:session/pause', async (req) => {
    const { session: sessionId } = req.params as { session: string };
    const wsName = requireWorkspace(
      (req.body as { workspace?: string } | undefined)?.workspace ??
        query(req).workspace,
    );
    env.workspace(wsName);
    const session = await call(() =>
      interview.pauseSession(ictx(wsName), sessionId),
    );
    touched(wsName, sessionId);
    return { session };
  });

  /** Resume = durable snapshot diff briefing ("what changed since you
   *  left") + status flip back to active. */
  app.post('/api/v1/interview-sessions/:session/resume', async (req) => {
    const { session: sessionId } = req.params as { session: string };
    const wsName = requireWorkspace(
      (req.body as { workspace?: string } | undefined)?.workspace ??
        query(req).workspace,
    );
    env.workspace(wsName);
    const result = await call(() =>
      interview.resumeSession(ictx(wsName), sessionId),
    );
    touched(wsName, sessionId);
    return result;
  });

  app.post(
    '/api/v1/interview-sessions/:session/questions/:question/resolve',
    async (req) => {
      const { session: sessionId, question: questionId } = req.params as {
        session: string;
        question: string;
      };
      const body = parse(ResolveQuestionBody, req.body, 'question resolve');
      env.workspace(body.workspace);
      const candidate = await call(() =>
        interview.resolveQuestion(ictx(body.workspace), {
          sessionId,
          questionId,
          status: body.status,
          reason: body.reason ?? null,
        }),
      );
      touched(body.workspace, sessionId);
      return { question: candidate };
    },
  );

  /** Slot actions — `known` is the human confirmation step (confirms
   *  every proposed statement bound to the slot); `not-applicable` /
   *  `deferred` are explicit user rulings (never re-asked). */
  app.post('/api/v1/interview-sessions/:session/slots/:slot', async (req) => {
    const { session: sessionId, slot } = req.params as {
      session: string;
      slot: string;
    };
    const body = parse(SlotBody, req.body, 'slot update');
    env.workspace(body.workspace);
    const ctx = ictx(body.workspace);
    const row = await call(() =>
      body.state === 'known'
        ? interview.confirmSlot(ctx, { sessionId, slot })
        : interview.markSlot(ctx, {
            sessionId,
            slot,
            state: body.state,
            value: body.value ?? null,
          }),
    );
    touched(body.workspace, sessionId);
    return { slot: row };
  });

  // ------------------------------------------------------------------
  // Understanding Panel (wp-146 contract) — confirmed / interpretation /
  // needs-clarification / decision-required buckets with provenance.
  // ------------------------------------------------------------------

  app.get('/api/v1/interview-sessions/:session/understanding', async (req) => {
    const { session: sessionId } = req.params as { session: string };
    const wsName = requireWorkspace(query(req).workspace);
    env.workspace(wsName);
    const session = await requireSession(wsName, sessionId);
    const ctx = ictx(wsName);
    const [slots, readiness] = await Promise.all([
      interview.listSlots(ctx, sessionId),
      call(() => interview.evaluateReadiness(ctx, sessionId)),
    ]);

    // Session-bound statements: bound via slot refs OR extracted from
    // this session's transcript (`interview-message` source ids are
    // `<session>#<seq>`).
    const boundIds = new Set(slots.flatMap((s) => s.statement_refs ?? []));
    const prefix = `${sessionId}#`;
    const all = await store.listStatements({ workspace: wsName });
    const sessionStatements = all.filter((s) => {
      if (boundIds.has(s.statement_id)) return true;
      const ref = s.source_ref as { kind?: string; id?: string } | null;
      return (
        ref?.kind === 'interview-message' &&
        typeof ref.id === 'string' &&
        ref.id.startsWith(prefix)
      );
    });
    const ids = sessionStatements.map((s) => s.statement_id);

    const [decisions, clarifications] = await Promise.all([
      store.listStatementDecisions({
        workspace: wsName,
        status: 'open',
      }),
      Promise.all(
        ids.map((id) =>
          store.listStatementClarifications({
            workspace: wsName,
            statement_id: id,
          }),
        ),
      ).then((r) => r.flat()),
    ]);
    const openDecisions = decisions.filter((d) => ids.includes(d.statement_id));
    const decisionByStatement = new Map(
      openDecisions.map((d) => [d.statement_id, d] as const),
    );
    const live = sessionStatements.filter(
      interview.isLiveStatement,
    ) as StatementRow[];

    const decorated = (s: StatementRow) => ({
      ...s,
      open_decision: decisionByStatement.get(s.statement_id) ?? null,
    });

    return {
      session,
      readiness,
      /** confirmed — human-verified statements + `known` slots. */
      confirmed: {
        slots: slots.filter((s) => s.state === 'known'),
        statements: live.filter((s) => s.status === 'confirmed').map(decorated),
      },
      /** interpretation — AI-proposed, awaiting human confirmation. */
      interpretation: {
        slots: slots.filter((s) => s.state === 'inferred'),
        statements: live.filter((s) => s.status === 'proposed').map(decorated),
      },
      /** needs-clarification — open areas: missing/deferred slots,
       *  unanswered statement clarifications. */
      needs_clarification: {
        slots: slots.filter(
          (s) => s.state === 'missing' || s.state === 'deferred',
        ),
        clarifications: clarifications.filter((c) => c.answer === null),
      },
      /** decision-required — disagreements route here, never a
       *  silent merge (§15.9). */
      decision_required: {
        slots: slots.filter((s) => s.state === 'conflicted'),
        decisions: openDecisions.map((d) => ({
          ...d,
          statement:
            sessionStatements.find((s) => s.statement_id === d.statement_id) ??
            null,
        })),
        statements: live.filter((s) => s.status === 'disputed').map(decorated),
      },
    };
  });

  // ------------------------------------------------------------------
  // Statements — the ledger surface. Decide actions route through the
  // lifecycle engine (humans confirm/reject/decide; AI proposes).
  // ------------------------------------------------------------------

  app.get('/api/v1/statements', async (req) => {
    const q = req.query as {
      workspace?: string;
      status?: string;
      intent?: string;
      scope?: string;
      scope_ref?: string;
      subject?: string;
    };
    const wsName = requireWorkspace(q.workspace);
    env.workspace(wsName);
    let statements = await store.listStatements({
      workspace: wsName,
      ...(q.status ? { status: q.status } : {}),
      ...(q.intent ? { intent: q.intent } : {}),
      ...(q.scope ? { scope: q.scope } : {}),
      ...(q.scope_ref ? { scope_ref: q.scope_ref } : {}),
    });
    if (q.subject) {
      const needle = q.subject.toLowerCase();
      statements = statements.filter((s) =>
        (s.subject ?? '').toLowerCase().includes(needle),
      );
    }
    const open = await store.listStatementDecisions({
      workspace: wsName,
      status: 'open',
    });
    const openByStatement = new Map<string, number>();
    for (const d of open) {
      openByStatement.set(
        d.statement_id,
        (openByStatement.get(d.statement_id) ?? 0) + 1,
      );
    }
    return {
      statements: statements.map((s) => ({
        ...s,
        open_decisions: openByStatement.get(s.statement_id) ?? 0,
      })),
    };
  });

  app.get('/api/v1/statements/:id', async (req) => {
    const { id } = req.params as { id: string };
    const wsName = requireWorkspace(query(req).workspace);
    env.workspace(wsName);
    const statement = await store.getStatement({
      workspace: wsName,
      statement_id: id,
    });
    if (!statement) {
      throw new ApiError(404, 'not_found', `no statement ${id} in ${wsName}`);
    }
    const [versions, outgoing, incoming, openDecisions, clarifications, links] =
      await Promise.all([
        store.listStatementVersions({ workspace: wsName, statement_id: id }),
        store.listStatementRelations({ workspace: wsName, src: id }),
        store.listStatementRelations({ workspace: wsName, dst: id }),
        store.listStatementDecisions({
          workspace: wsName,
          statement_id: id,
        }),
        store.listStatementClarifications({
          workspace: wsName,
          statement_id: id,
        }),
        store.listStatementArtifactLinks({
          workspace: wsName,
          statement_id: id,
        }),
      ]);
    return {
      statement,
      versions,
      relations: { outgoing, incoming },
      decisions: openDecisions,
      clarifications,
      artifact_links: links,
    };
  });

  /** Human decide on a statement: confirm / dispute / reject. Dispute
   *  opens a decision item (idempotent); confirm upgrades provenance. */
  app.post('/api/v1/statements/:id/decide', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(StatementDecideBody, req.body, 'statement decide');
    env.workspace(body.workspace);
    const ctx = { workspace: body.workspace, statement_id: id, actor };
    const result = await call(async () => {
      if (body.action === 'confirm') {
        return { statement: await confirmStatement(store, ctx) };
      }
      if (body.action === 'reject') {
        return {
          statement: await rejectStatement(store, {
            ...ctx,
            rationale: body.reason ?? null,
          }),
        };
      }
      if (!body.reason) {
        throw new ApiError(
          400,
          'bad_request',
          'statement decide: dispute requires {reason}',
        );
      }
      return disputeStatement(store, { ...ctx, reason: body.reason });
    });
    touched(body.workspace);
    return result;
  });

  /** Correction edit — writes a NEW statement versioned in the ledger
   *  and a `supersedes` edge retiring the old one. The human's wording
   *  is confirmed on entry; nothing is silently overwritten (AC). */
  app.post('/api/v1/statements/:id/correct', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(StatementCorrectBody, req.body, 'statement correct');
    env.workspace(body.workspace);
    const prior = await store.getStatement({
      workspace: body.workspace,
      statement_id: id,
    });
    if (!prior) {
      throw new ApiError(
        404,
        'not_found',
        `no statement ${id} in ${body.workspace}`,
      );
    }
    if (!interview.isLiveStatement(prior)) {
      throw new ApiError(
        409,
        'conflict',
        `statement ${id} is ${prior.status} — nothing live to correct`,
      );
    }
    const result = await call(async () => {
      const corrected = await proposeStatement(store, {
        workspace: body.workspace,
        text: body.text,
        source_text: prior.source_text ?? null,
        source_ref: (prior.source_ref ?? null) as never,
        intent: (prior.intent ?? null) as never,
        polarity: (prior.polarity ?? null) as never,
        subject: prior.subject ?? null,
        strength: (prior.strength ?? null) as never,
        scope: (prior.scope ?? null) as never,
        scope_ref: prior.scope_ref ?? null,
        confirm: true, // human edit = stakeholder-verified
        actor,
      });
      const sup = await supersedeStatement(store, {
        workspace: body.workspace,
        src: corrected.statement_id,
        dst: id,
        actor,
      });
      // Feed the correction back into the interview (§15.9): when the
      // caller names a session + slots, rebind so slots recompute.
      let slots: unknown[] = [];
      if (body.session_id && body.slots && body.slots.length > 0) {
        slots = await interview.bindStatementsToSlots(
          ictx(body.workspace),
          body.session_id,
          body.slots,
          [corrected],
        );
      }
      return { statement: corrected, superseded: prior, ...sup, slots };
    });
    touched(body.workspace, body.session_id);
    return reply.status(201).send(result);
  });

  // ------------------------------------------------------------------
  // Statement decisions — the human rulings on disagreement items.
  // ------------------------------------------------------------------

  app.post('/api/v1/statement-decisions/:id/decide', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(DecisionBody, req.body, 'statement decision');
    env.workspace(body.workspace);
    const decision = await call(() =>
      decideStatementDecision(store, {
        workspace: body.workspace,
        decision_id: id,
        decision: body.decision,
        rationale: body.rationale ?? null,
        ...(body.apply !== undefined ? { apply: body.apply } : {}),
        actor,
      }),
    );
    touched(body.workspace);
    return { decision };
  });

  app.post('/api/v1/statement-decisions/:id/dismiss', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(DismissDecisionBody, req.body, 'decision dismiss');
    env.workspace(body.workspace);
    await call(() =>
      dismissStatementDecision(store, {
        workspace: body.workspace,
        decision_id: id,
        rationale: body.rationale ?? null,
        actor,
      }),
    );
    touched(body.workspace);
    return { dismissed: true, decision_id: id };
  });

  // ------------------------------------------------------------------
  // Tray (S-19/S-20, D27) + board-item mutations (OCC).
  // ------------------------------------------------------------------

  app.get('/api/v1/tray', async (req) => {
    const q = req.query as { workspace?: string; kind?: string };
    const wsName = requireWorkspace(q.workspace);
    env.workspace(wsName);
    let items = await store.listBoardItems({ workspace: wsName, board: null });
    if (q.kind) items = items.filter((i) => i.kind === q.kind);
    return { items };
  });

  /** Optimistic-conflict item mutation — `expected_updated_at` is the
   *  version fence; consumed/frozen items are supersede-only (s-16). */
  app.patch('/api/v1/board-items/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(PatchItemBody, req.body, 'board item patch');
    env.workspace(body.workspace);
    const item = await store.getBoardItem(id);
    if (!item || item.workspace !== body.workspace) {
      throw new ApiError(404, 'not_found', `no board item ${id}`);
    }
    if (item.status === 'consumed' || item.status === 'frozen') {
      throw new ApiError(
        409,
        'conflict',
        `board item ${id} is ${item.status} — consumed items are supersede-only`,
      );
    }
    if (body.expected_updated_at !== item.updated_at) {
      throw new ApiError(
        409,
        'conflict',
        `board item ${id} changed since your read (expected_updated_at ${item.updated_at}) — reload and retry`,
      );
    }
    const ts = env.nowIso();
    // Tray → board moves route through the engine's promotion rule
    // (fail-closed when the item isn't actually in the tray); other
    // board↔board / board→tray moves update the row directly.
    let base = item;
    let fence = item.updated_at ?? '';
    if (
      item.board === null &&
      body.board !== undefined &&
      body.board !== null
    ) {
      await call(() =>
        promoteTrayItem(store, { id, board: body.board as string, actor }),
      );
      // Promotion wrote the row — build the follow-up write from the
      // promoted row (never the stale pre-promotion snapshot) and fence
      // the conditional update on the version promotion stamped.
      const promoted = await store.getBoardItem(id);
      if (!promoted) {
        throw new ApiError(404, 'not_found', `no board item ${id}`);
      }
      base = promoted;
      fence = promoted.updated_at ?? fence;
    }
    const next: BoardItem = {
      ...base,
      ...(body.board !== undefined ? { board: body.board } : {}),
      ...(body.kind !== undefined
        ? { kind: body.kind as BoardItem['kind'] }
        : {}),
      ...(body.note_kind !== undefined
        ? { note_kind: body.note_kind as BoardItem['note_kind'] }
        : {}),
      ...(body.importance !== undefined
        ? { importance: body.importance as BoardItem['importance'] }
        : {}),
      ...(body.topic !== undefined ? { topic: body.topic } : {}),
      ...(body.applies_to !== undefined ? { applies_to: body.applies_to } : {}),
      ...(body.note_status !== undefined
        ? { note_status: body.note_status as BoardItem['note_status'] }
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
      ...(body.status !== undefined
        ? { status: body.status as BoardItem['status'] }
        : {}),
      updated_at: ts,
    };
    const updated = await store.updateBoardItemExpected(next, fence);
    if (!updated) {
      throw new ApiError(
        409,
        'conflict',
        `board item ${id} changed concurrently — reload and retry`,
      );
    }
    touched(body.workspace);
    boardItemTouched(body.workspace, updated);
    return { item: updated };
  });

  /** Tray mistake cleanup — consumed/frozen items refuse deletion
   *  (audit trail is kept; supersede instead). */
  app.delete('/api/v1/board-items/:id', async (req) => {
    const { id } = req.params as { id: string };
    const wsName = requireWorkspace(query(req).workspace);
    env.workspace(wsName);
    const item = await store.getBoardItem(id);
    if (!item || item.workspace !== wsName) {
      throw new ApiError(404, 'not_found', `no board item ${id}`);
    }
    if (item.status === 'consumed' || item.status === 'frozen') {
      throw new ApiError(
        409,
        'conflict',
        `board item ${id} is ${item.status} — supersede, never delete`,
      );
    }
    await store.deleteBoardItem(id);
    touched(wsName);
    boardItemTouched(wsName, item);
    return { deleted: true, id };
  });
}
