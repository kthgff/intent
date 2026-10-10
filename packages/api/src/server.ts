/**
 * createServer — the REST + SSE surface of API.md (wp-060).
 *
 * One surface on `ui.bind`:`ui.port`; bearer-token auth on EVERY
 * route including `/api/v1/stream` and the static/root mount. Gate
 * writes carry `expected_status` and are idempotent — a stale
 * submission (another install cleared the gate first) gets `409`,
 * never a double-commit.
 *
 * Gate clears reuse the conductor's cleared-gate mechanics: the API
 * writes `gate_items.cleared_at` (+ durable event/notification rows)
 * and the next CLAIM pass's `nextStage` performs the follow-on status
 * write + run request. Run queueing goes through the conductor's
 * `queuePendingRun` (pending rows are leased + launched by CLAIM).
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ConductorDeps, StreamEvent } from '@veto/conductor';
import {
  type Conductor,
  type ConductorWorkspace,
  DEFAULT_IMPORT_BOARD,
  type RunnerTask,
  ShellGhClient,
  type ToolCtx,
  applyTicketStatus,
  convertImportBoard,
  fetchIssues,
  preview,
  queuePendingRun,
  reconcileImport,
  renderLogMd,
  resolveReconciliationFinding,
  upsertFrontmatterKeys,
} from '@veto/conductor';
import {
  defaultGlobalConfigPath,
  mergeConfigFile,
  parseEnv,
} from '@veto/config';
import type { EffectiveConfig } from '@veto/config';
import {
  APPROVED_SCOPE_ORIGINS,
  BOARD_ITEM_KINDS,
  type BoardItem,
  DEPTH_TIERS,
  DOC_KINDS,
  type DocKind,
  type EventName,
  type GateItem,
  RECONCILIATION_DECISIONS,
  type Store,
  TICKET_ORIGINS,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  TICKET_WORK_TYPES,
  type TicketOrigin,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
  type TicketWorkType,
  WORK_TYPE_POLICIES,
  directCreateAllowed,
  evaluateEvidence,
  evidenceFor,
  gatherEvidenceSnapshot,
  latestClassification,
  needsScopeApproval,
  severityRule,
} from '@veto/core';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import YAML from 'yaml';
import { z } from 'zod';
import { registerAlignmentRoutes } from './alignment.js';
import { registerBoardAssistantRoutes } from './board-assistant.js';
import { registerBoardRoutes } from './board.js';
import { registerDesignRoutes } from './design.js';
import {
  DiffApplyError,
  applyUnifiedDiff,
  extractUnifiedDiff,
  lineDiff,
  parseUnifiedDiff,
} from './diff.js';
import { registerDiscoveryRoutes } from './discovery.js';
import { registerEvidenceRoutes } from './evidence.js';
import { registerFeatureRoutes } from './features.js';
import { registerLinkRoutes } from './links.js';
import { deviationMetrics, gateDwell } from './metrics.js';
import { resolveAssistantProvider } from './openrouter.js';
import { registerRadarRoutes } from './radar.js';
import { registerRegisterRoutes } from './registers.js';
import { registerReleaseRoutes } from './releases.js';
import { registerRepoRoutes } from './repos.js';
import { registerReviewRoutes } from './review.js';
import { StreamHub } from './sse.js';
import { registerTelemetryRoutes } from './telemetry.js';

// ---------------------------------------------------------------------------
// Request-body schemas (fail-closed — a malformed body is a 400, never
// a half-parsed write)
// ---------------------------------------------------------------------------

/** Workspace names are directory names (workspace.rootPath anchoring)
 *  and DB keys — slug-shaped only: no separators, no `..`, bounded. */
const WorkspaceNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    'workspace name must be slug-shaped ([a-zA-Z0-9._-], leading alnum)',
  )
  .refine((v) => !v.includes('..'), 'no `..` in workspace names');

const AnswersBodySchema = z
  .object({
    answers: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional(),
    id: z.string().optional(),
    answer: z.union([z.string(), z.array(z.string())]).optional(),
    expected_status: z.string().optional(),
  })
  .passthrough();

const FeedbackBodySchema = z
  .object({
    comment: z.string().min(1),
    expected_status: z.string().optional(),
  })
  .passthrough();

const WorkspaceBodySchema = z
  .object({
    name: WorkspaceNameSchema,
    path: z.string().min(1).optional(),
  })
  .passthrough();

const InterviewBodySchema = z
  .object({
    workspace: WorkspaceNameSchema,
    text: z.string().min(1).optional(),
    ticket_ref: z.string().optional(),
    subject_ref: z.string().optional(),
    message: z.string().optional(),
    target: z.string().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();

const ImportBodySchema = z
  .object({
    workspace: WorkspaceNameSchema,
    source: z.string().min(1),
    repo: z.string().min(1).optional(),
    milestone: z.string().optional(),
    labels: z.array(z.string()).optional(),
    commit: z.boolean().optional(),
  })
  .passthrough();

const CaptureBodySchema = z
  .object({
    workspace: WorkspaceNameSchema,
    kind: z.string().optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    serves: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

/** wp-139: (re)run import reconciliation for a workspace. */
const ReconcileBodySchema = z
  .object({
    workspace: WorkspaceNameSchema,
    board: z.string().optional(),
    ticketIds: z.array(z.string()).optional(),
  })
  .passthrough();

/** wp-139: resolve one reconciliation finding. */
const ResolveFindingBodySchema = z
  .object({
    workspace: WorkspaceNameSchema,
    decision: z.string().min(1),
    actor: z.string().optional(),
  })
  .passthrough();

/** wp-139: convert the import board to an ordinary board. */
const ConvertBoardBodySchema = z
  .object({
    workspace: WorkspaceNameSchema,
    board: z.string().optional(),
    to: z.enum(['enhancement', 'modernization', 'quality']).optional(),
  })
  .passthrough();

/** §15.7 direct ticket creation (wp-151). `work_type` is required; the
 *  route enforces the direct-create rules before any row is written. */
const CreateTicketBodySchema = z
  .object({
    workspace: WorkspaceNameSchema,
    title: z.string().min(1),
    work_type: z.string().min(1),
    origin: z.string().optional(),
    severity: z.string().optional(),
    priority: z.string().optional(),
    depth: z.string().optional(),
    backend: z.string().optional(),
    model: z.string().optional(),
    repos: z.array(z.string()).optional(),
    body: z.string().optional(),
    feature: z.string().optional(),
    parent: z.string().optional(),
    /** Approved-scope evidence for types that may not be direct-created
     *  (`story`): the RS/board proposal that authorizes the work. */
    scope_ref: z.string().optional(),
  })
  .passthrough();

const ClaimBodySchema = z
  .object({
    actor: z.string().optional(),
    ttl_s: z.number().int().positive().optional(),
  })
  .passthrough();

/** Snooze (D20): `{until: <ISO>}` absolute, or `{for_minutes: n}`
 *  relative — exactly one meaningful knob, both optional in the schema
 *  so the handler can 400 with a readable message. */
const SnoozeBodySchema = z
  .object({
    until: z.string().min(1).optional(),
    for_minutes: z.number().positive().optional(),
  })
  .passthrough()
  .refine((b) => b.until !== undefined || b.for_minutes !== undefined, {
    message: 'snooze requires {until} or {for_minutes}',
  });

// ---------------------------------------------------------------------------
// Public surface types
// ---------------------------------------------------------------------------

/**
 * The conductor surface the API needs — the real `Conductor` class
 * satisfies this structurally; tests may stub it. Run queueing and
 * gate-clear helpers rebuild the ToolCtx the loop uses.
 */
export interface ApiConductor {
  deps: ConductorDeps;
  leases: Conductor['leases'];
  handles: Conductor['handles'];
  killedForCap: Conductor['killedForCap'];
  killRun(runId: string): Promise<void>;
  pauseRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
}

export interface ServerOptions {
  store: Store;
  conductor: ApiConductor;
  config: EffectiveConfig;
  /** 32-byte hex UI token — see `loadOrCreateToken`. */
  uiToken: string;
  /** Override for tests: defaults to config.ui.bind. */
  bind?: string;
  /** Path of the global config.yaml for PUT /settings persistence. */
  globalConfigPath?: string;
  /** Override for tests: where POST /repos/clone clones into. */
  reposDir?: string;
  /** Override for tests: git seam for POST /repos/clone. */
  gitClone?: Parameters<typeof registerRepoRoutes>[1]['runGit'];
  /**
   * Built UI bundle (vite `dist/`, wp-099) — served static behind the
   * same token auth on every route; absent/missing → the placeholder
   * page stays. SPA fallback: extensionless GETs resolve to
   * `index.html`; real file misses under it 404.
   */
  uiDist?: string;
  /** Test seam — inject a stubbed fetch for the assistant provider so
   *  tests never call live OpenRouter (wp-164 AC). */
  assistantFetch?: typeof fetch;
}

export interface ApiServer extends FastifyInstance {
  /** Broadcast one event to every SSE client (the `notify` hook the
   *  conductor calls via `deps.notify`). */
  notify(event: StreamEvent): void;
  /** End every SSE stream (tests / shutdown). */
  closeStreams(): void;
  /** Connected SSE client count (observability + tests). */
  streamCount(): number;
}

// ---------------------------------------------------------------------------
// Errors — {error, message, refs?} with 4xx/5xx (API.md conventions)
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly refs?: string[];

  constructor(
    statusCode: number,
    code: string,
    message: string,
    refs?: string[],
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (refs) this.refs = refs;
  }
}

const badRequest = (m: string) => new ApiError(400, 'bad_request', m);
const unauthorized = () =>
  new ApiError(401, 'unauthorized', 'valid bearer token or session required');
const forbidden = (m: string) => new ApiError(403, 'forbidden', m);
const notFound = (m: string) => new ApiError(404, 'not_found', m);
const conflict = (m: string) => new ApiError(409, 'conflict', m);
const notImplemented = (m: string) => new ApiError(501, 'not_implemented', m);

/** Zod-parse a JSON body → the typed shape, or a 400 naming the
 *  issues (fail-closed — a malformed body never reaches a write). */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  what: string,
): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw badRequest(
      `${what}: ${r.error.issues
        .map((i) => `${i.path.join('.') || '<body>'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return r.data as z.output<S>;
}

/** JSON.parse a stored artifact — fail-closed: corrupt durable
 *  content is a 502 `corrupt_artifact`, never a guessed payload. */
export function parseArtifactJson(content: string, what: string): unknown {
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new ApiError(
      502,
      'corrupt_artifact',
      `${what} is not valid JSON: ${(e as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackBind(bind: string): boolean {
  return LOOPBACK.has(bind);
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokenEqual(a: string, b: string): boolean {
  return timingSafeEqual(hashToken(a), hashToken(b));
}

const PRIORITY_RANK: Record<TicketPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const prank = (p: string | null | undefined) =>
  PRIORITY_RANK[(p ?? 'medium') as TicketPriority] ?? 1;

/**
 * S-01 ranking — human-anxiety-first (s-01-board §inbox re-rank):
 * failure/escalation items before routine question/approval rows;
 * within a class, priority then age. `blocked_agent` (pipeline halted)
 * breaks same-kind ties ahead of priority — the machine is waiting.
 */
const ANXIETY_RANK: Record<string, number> = {
  failure: 0,
  escalation: 1,
  repair: 2,
  question: 3,
  review: 4,
  approval: 5,
  'split-plan': 6,
  verify: 7,
};
const anxrank = (kind: string) => ANXIETY_RANK[kind] ?? 8;

/** D20 snooze: an item with `snoozed_until` in the future stays open
 *  but leaves the inbox and badge counts until then. */
const isSnoozed = (item: GateItem, nowIso: string): boolean =>
  item.snoozed_until !== null &&
  item.snoozed_until !== undefined &&
  item.snoozed_until > nowIso;

/** S-01 ranking: anxiety-first → blocked_agent → priority → age. */
function rankInbox(items: GateItem[]): GateItem[] {
  return [...items].sort(
    (a, b) =>
      anxrank(a.kind) - anxrank(b.kind) ||
      Number(b.blocked_agent ?? false) - Number(a.blocked_agent ?? false) ||
      prank(a.priority) - prank(b.priority) ||
      a.surfaced_at.localeCompare(b.surfaced_at),
  );
}

// ---------------------------------------------------------------------------
// S-01 board derivation — the five phase columns collapse the status enum
// (s-01-board §4). `failed`/`blocked`/`verify_failed` are NOT phases: the
// card stays in the phase it died in, flagged — `derivePhase` walks
// status_changed events back to the last meaningful status.
// ---------------------------------------------------------------------------

export const BOARD_PHASES = [
  'backlog',
  'spec',
  'build',
  'review',
  'done',
] as const;
export type BoardPhase = (typeof BOARD_PHASES)[number];

/** TicketStatus → column; failed/blocked map to null — they retain the
 *  last meaningful phase via events. Post-merge statuses (verifying,
 *  verify_failed, released, discarded — D27 additions) land in Done. */
const PHASE_OF_STATUS: Record<TicketStatus, BoardPhase | null> = {
  imported: 'backlog',
  triage: 'backlog',
  'needs-info': 'backlog',
  escalated: 'backlog',
  'wont-do': 'done',
  ready: 'build',
  'prd-draft': 'spec',
  'prd-review': 'spec',
  'prd-approved': 'spec',
  'design-qa': 'spec',
  'tdd-draft': 'spec',
  'tdd-review': 'spec',
  'tdd-approved': 'spec',
  'test-draft': 'spec',
  'test-review': 'spec',
  'test-approved': 'spec',
  'in-progress': 'build',
  review: 'build',
  'changes-requested': 'build',
  approved: 'review',
  'pr-open': 'review',
  'ci-watch': 'review',
  merged: 'done',
  verifying: 'done',
  verify_failed: 'done',
  released: 'done',
  reverted: 'done',
  failed: null,
  blocked: null,
  aborted: 'done',
  split: 'done',
  discarded: 'done',
};

/**
 * A card's column. For `failed`/`blocked` rows the phase is the last
 * non-failure status_changed target in the event ledger; when no such
 * event exists (died before any transition) the fallback is Backlog.
 */
export function derivePhase(
  status: string,
  events: { event: string; data: Record<string, unknown> }[],
): BoardPhase {
  const direct = PHASE_OF_STATUS[status as TicketStatus];
  if (direct) return direct;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.event !== 'status_changed') continue;
    const to = e.data?.to;
    if (typeof to !== 'string') continue;
    const phase = PHASE_OF_STATUS[to as TicketStatus];
    if (phase) return phase;
  }
  return 'backlog';
}

/** Flag style for a card — failures/blocks ride on top of phase. */
function flagOf(status: string): 'failed' | 'blocked' | null {
  if (status === 'blocked') return 'blocked';
  if (status === 'failed' || status === 'verify_failed') return 'failed';
  return null;
}

export interface DropTarget {
  /** The column this card may be dropped onto. */
  column: BoardPhase;
  /** API write: 'wont_do'|'abort'|'retry' → POST actions; 'claim' →
   *  POST gate-items …/claim. */
  action: 'wont_do' | 'abort' | 'retry' | 'claim';
  /** For claim — the gate item name to claim. */
  gate?: string;
  /** Whether the UI must confirm before posting. */
  confirm: boolean;
  /** Human copy for the confirm modal / column hint. */
  label: string;
}

/**
 * Validated drop targets per card (s-01 DnD table). Forward pipeline
 * transitions are conductor-owned and never offered. `drop_targets` is
 * the whole contract — the UI does not infer transitions.
 */
function dropTargetsFor(
  ticket: TicketRow,
  phase: BoardPhase,
  inFlight: boolean,
  attention: GateItem[],
): DropTarget[] {
  const targets: DropTarget[] = [];
  if (phase !== 'done') {
    targets.push({
      column: 'done',
      action: inFlight ? 'abort' : 'wont_do',
      confirm: true,
      label: inFlight
        ? 'Abort in-flight work and move to Done'
        : "Mark as won't-do and move to Done",
    });
  }
  if (ticket.status === 'failed' || ticket.status === 'blocked') {
    targets.push({
      column: phase,
      action: 'retry',
      confirm: true,
      label: 'Retry the last run',
    });
  }
  if (attention.some((g) => g.gate === 'escalated' && !g.cleared_at)) {
    targets.push({
      column: phase,
      action: 'claim',
      gate: 'escalated',
      confirm: false,
      label: 'Claim this escalation',
    });
  }
  return targets;
}

/** Candidate gate names for a doc approval, in probe order. Keyed by
 *  the post-rename doc name; stage/gate ids stay pre-rename. */
const DOC_GATES: Record<string, string[]> = {
  rs: ['plan-package', 'prd-review'],
  tdd: ['plan-package', 'tdd-review'],
  vs: ['plan-package', 'test-review', 'test-approved'],
};

/** wp-132 renamed doc kinds (rs.md/vs.md) but stage/gate ids kept the
 *  old vocabulary — accept both at the doc routes. */
const DOC_NAME_ALIASES: Record<string, string> = {
  prd: 'rs',
  'prd.md': 'rs.md',
  test: 'vs',
  'test.md': 'vs.md',
};
const docNameFor = (name: string): string => DOC_NAME_ALIASES[name] ?? name;

/** Route/gate doc names → the on-disk spelling events must record —
 *  radar keys approvals by the baseline pin doc (`rs.md`/`tdd.md`/
 *  `vs.md`), so an approval event carrying `rs` never matches. */
const DOC_DISK_NAME: Record<string, string> = {
  rs: 'rs.md',
  tdd: 'tdd.md',
  vs: 'vs.md',
};

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

export function createServer(opts: ServerOptions): ApiServer {
  const { store, conductor, config } = opts;
  const bind = opts.bind ?? config.ui.bind;
  const globalConfigPath = opts.globalConfigPath ?? defaultGlobalConfigPath();
  const hub = new StreamHub();
  const actor = config.actor ?? 'veto';

  const app = Fastify({ logger: false }) as unknown as ApiServer;

  app.decorate('notify', (event: StreamEvent) => hub.notify(event));
  app.decorate('closeStreams', () => hub.closeAll());
  app.decorate('streamCount', () => hub.size);
  // Wire the conductor's live-channel hook (additive, wp-060).
  const prevNotify = conductor.deps.notify;
  conductor.deps.notify = (event) => hub.notify(event);
  app.addHook('onClose', async () => {
    conductor.deps.notify = prevNotify;
    hub.closeAll();
  });

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as ApiError).statusCode ?? 500;
    const code =
      (err as ApiError).code ?? (status < 500 ? 'request_failed' : 'internal');
    // 5xx detail stays server-side — a raw err.message can leak paths,
    // SQL text, or store internals; the client only learns it failed.
    if (status >= 500) app.log.error(err);
    void reply.status(status).send({
      error: code,
      message: status >= 500 ? 'internal error' : err.message,
      ...((err as ApiError).refs ? { refs: (err as ApiError).refs } : {}),
    });
  });

  // ------------------------------------------------------------------
  // Auth — bearer token or session cookie on EVERYTHING (API.md auth)
  // ------------------------------------------------------------------

  const sessionCookie = 'veto_session';

  function cookieToken(req: FastifyRequest): string | null {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === sessionCookie) return v.join('=');
    }
    return null;
  }

  app.addHook('onRequest', async (req) => {
    // Bootstrap path: GET /?token=<token> → session cookie. The
    // query-param path is REFUSED on non-loopback binds (API.md).
    if (req.method === 'GET' && req.url.startsWith('/?token=')) {
      if (!isLoopbackBind(bind)) {
        throw forbidden('token bootstrap is refused on non-loopback binds');
      }
      const token = req.url.slice('/?token='.length).split('&')[0] ?? '';
      if (!tokenEqual(decodeURIComponent(token), opts.uiToken)) {
        throw unauthorized();
      }
      return; // route handler sets the cookie
    }
    const auth = req.headers.authorization;
    if (
      auth?.startsWith('Bearer ') &&
      tokenEqual(auth.slice(7), opts.uiToken)
    ) {
      return;
    }
    const cookie = cookieToken(req);
    if (cookie && tokenEqual(cookie, opts.uiToken)) return;
    throw unauthorized();
  });

  // ------------------------------------------------------------------
  // Conductor / workspace helpers
  // ------------------------------------------------------------------

  function workspace(name: string): ConductorWorkspace {
    const ws = conductor.deps.workspaces.find((w) => w.name === name);
    if (!ws) throw notFound(`unknown workspace '${name}'`);
    return ws;
  }

  function toolCtx(ws: ConductorWorkspace): ToolCtx {
    return {
      deps: conductor.deps,
      ws,
      leases: conductor.leases,
      handles: conductor.handles,
      killedForCap: conductor.killedForCap,
    };
  }

  const now = () => new Date().toISOString();

  function transitionCtx(ws: ConductorWorkspace) {
    return {
      workspace: ws.name,
      rootPath: ws.rootPath,
      store,
      actor,
      now: () => new Date(),
    };
  }

  async function emitEvent(
    ws: ConductorWorkspace,
    e: {
      ticketId?: string | null;
      stage?: string | null;
      event: EventName;
      run?: string | null;
      refs?: string[];
      data?: Record<string, unknown>;
      humanMinutes?: number;
    },
  ): Promise<number> {
    return store.appendEvent({
      workspace: ws.name,
      ticket_id: e.ticketId ?? null,
      ts: now(),
      stage: e.stage ?? null,
      actor_type: 'human',
      actor_id: actor,
      event: e.event,
      run: e.run ?? null,
      refs: e.refs ?? [],
      data: e.data ?? {},
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: e.humanMinutes ?? null,
    });
  }

  async function getTicketOr404(
    ws: string,
    ticketId: string,
  ): Promise<TicketRow> {
    const t = await store.getTicket({ workspace: ws, ticket_id: ticketId });
    if (!t) throw notFound(`unknown ticket '${ws}/${ticketId}'`);
    return t;
  }

  /**
   * Verify a POST /tickets `scope_ref` against durable approved-scope
   * evidence (§15.7). The string is never the proof — it must resolve
   * to one of:
   *   - a `boards` row at status `approved` (the approved board
   *     proposal that authorized the work);
   *   - a feature/initiative subject carrying a `doc_approved` event —
   *     the approved RS/acceptance doc_version (the event lands with
   *     `ticket_id` = the subject id, matching acceptFeature);
   *   - any other subject with a `doc_approved` event on its `rs` doc
   *     (an approved requirements spec anywhere in the workspace).
   */
  async function scopeRefApproved(
    wsName: string,
    ref: string,
  ): Promise<boolean> {
    const board = await store.getBoard(wsName, ref);
    if (board) return board.status === 'approved';
    const approvals = await store.listEvents({
      workspace: wsName,
      ticket_id: ref,
      event: 'doc_approved',
    });
    if (await store.getFeature(wsName, ref)) {
      return approvals.length > 0;
    }
    return approvals.some(
      (e) =>
        e.data?.doc === 'rs' ||
        e.data?.doc === 'rs.md' ||
        e.data?.doc === 'acceptance-package',
    );
  }

  /**
   * The Ticket Workbench payload (§15.7, wp-151) — the ticket's
   * taxonomy + per-type tabs + the policy evidence checklist, computed
   * by the SAME policy functions the conductor enforces (taxonomy.ts),
   * so the UI can never drift from the gate behavior.
   */
  async function workbenchFor(wsName: string, row: TicketRow) {
    const workType = (row.work_type as TicketWorkType | null) ?? null;
    const origin = (row.origin as TicketOrigin | null) ?? null;
    const snapshot = await gatherEvidenceSnapshot(store, wsName, {
      ticket_id: row.ticket_id,
      work_type: workType,
      origin,
      severity: row.severity ?? null,
      parent: row.parent ?? null,
      feature: row.feature ?? null,
    });
    const policy = workType === null ? null : WORK_TYPE_POLICIES[workType];
    const evaluated = new Map<string, boolean>();
    const missing: string[] = [];
    for (const gate of ['intake', 'test-approved', 'approved'] as const) {
      const verdict = evaluateEvidence(workType, origin, gate, snapshot);
      for (const r of verdict.satisfied) evaluated.set(r.id, true);
      for (const r of verdict.missing) {
        evaluated.set(r.id, false);
        missing.push(r.id);
      }
    }
    const scopeGate = await store.getGateItem({
      workspace: wsName,
      subject: row.ticket_id,
      gate: 'scope-proposal',
    });
    const cls = await latestClassification(store, wsName, row.ticket_id);
    const scopeVerdict =
      cls.kind === 'ok' ? (cls.value.scope_verdict as string) : null;
    return {
      work_type: workType,
      origin,
      severity: row.severity ?? null,
      severity_rule:
        workType === null ? 'forbidden' : severityRule(workType, origin),
      direct_create: workType === null ? false : directCreateAllowed(workType),
      scope_verdict: scopeVerdict,
      scope_approval_needed: needsScopeApproval(
        workType,
        origin,
        scopeVerdict as never,
        scopeGate !== null && scopeGate.cleared_at !== null,
      ),
      summary: policy?.summary ?? null,
      tabs: policy?.tabs ?? ['type'],
      intake: policy?.intake ?? [],
      evidence: evidenceFor(workType, origin).map((r) => ({
        id: r.id,
        gate: r.gate,
        label: r.label,
        satisfied: evaluated.get(r.id) ?? false,
        check: r.check,
      })),
      missing,
    };
  }

  /**
   * Gate-write idempotency (API.md): `expected_status` must equal the
   * ticket's current status, and the gate item must exist and be open —
   * a stale submission (already cleared by another install, or the
   * ticket moved on) is a 409, never a double-commit.
   */
  async function clearGate(args: {
    ws: ConductorWorkspace;
    subject: string;
    gate: string;
    expectedStatus?: string;
    isTicket?: boolean;
  }): Promise<GateItem> {
    const { ws, subject, gate } = args;
    if (args.expectedStatus !== undefined) {
      const ticket = await getTicketOr404(ws.name, subject);
      if (ticket.status !== args.expectedStatus) {
        throw conflict(
          `stale write: expected status '${args.expectedStatus}', ` +
            `ticket is '${ticket.status}'`,
        );
      }
    }
    const key = { workspace: ws.name, subject, gate };
    const item = await store.getGateItem(key);
    if (!item)
      throw notFound(`no gate item '${gate}' for ${ws.name}/${subject}`);
    if (item.cleared_at) {
      throw conflict(`stale write: gate '${gate}' already cleared`);
    }
    const clearedAt = now();
    await store.clearGateItem(key, clearedAt);
    const row = { ...item, cleared_at: clearedAt };
    hub.notify({ type: 'gate_cleared', payload: row });
    return row;
  }

  /** The first open gate item among `gates` for a subject, or null. */
  async function openGate(
    ws: string,
    subject: string,
    gates: string[],
  ): Promise<string | null> {
    for (const gate of gates) {
      const item = await store.getGateItem({ workspace: ws, subject, gate });
      if (item && !item.cleared_at) return gate;
    }
    return null;
  }

  async function requestRun(
    wsName: string,
    req: {
      subject: string;
      stage: string;
      ticketId?: string;
      model?: string;
      tokens?: Record<string, string>;
      /** Runner-task spec for agent-less stages (verify/import). */
      task?: RunnerTask;
    },
  ): Promise<string> {
    const ws = workspace(wsName);
    const id = await queuePendingRun(toolCtx(ws), {
      workspace: ws.name,
      subject: req.subject,
      stage: req.stage as never,
      ...(req.ticketId ? { ticketId: req.ticketId } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.tokens ? { tokens: req.tokens } : {}),
      ...(req.task ? { task: req.task } : {}),
    });
    if (!id) {
      throw conflict(
        `a live run already fences (${req.subject}, ${req.stage})`,
      );
    }
    return id;
  }

  /**
   * Latest `run_artifacts` row with `name` across a ticket's runs
   * (triage.json, review.json, split-plan.md — structured stage output
   * lives on runs under D29, not in a ticket dir). Nested names are
   * honored both ways: `name` may carry a path (`<repo>/x.json`), and
   * a bare name matches nested artifacts (`verify` writes
   * `<repo>/test-report.json`). Returns the owning run id + the real
   * artifact name so write-back lands on the same row.
   */
  async function latestArtifact(
    wsName: string,
    ticketId: string,
    name: string,
    opts: { subject?: string } = {},
  ): Promise<{ runId: string; name: string; content: string } | null> {
    const runs = (
      await store.listRuns(
        opts.subject
          ? { workspace: wsName, subject: opts.subject }
          : { workspace: wsName, ticket_id: ticketId },
      )
    ).sort((a, b) => b.id.localeCompare(a.id));
    for (const r of runs) {
      const a = await store.getArtifact(r.id, name);
      if (a) return { runId: r.id, name: a.name, content: a.content };
      if (!name.includes('/')) {
        const nested = (await store.listArtifacts(r.id))
          .filter((x) => x.name.endsWith(`/${name}`))
          .sort((x, y) => x.name.localeCompare(y.name))[0];
        if (nested) {
          return { runId: r.id, name: nested.name, content: nested.content };
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Root + static UI mount (wp-099) — token bootstrap, then the built
  // vite bundle. Every byte of it sits behind the same auth hook as
  // the API + SSE (API.md): assets, root, and the SPA fallback all
  // require bearer/session. Missing bundle → placeholder, same as
  // before — the API must stay bootable without a UI build.
  // ------------------------------------------------------------------

  const uiDist = opts.uiDist ? resolve(opts.uiDist) : null;
  const uiMounted = uiDist !== null && existsSync(join(uiDist, 'index.html'));

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm',
    '.mp4': 'video/mp4',
  };

  /**
   * Serve one file out of uiDist. `pathname` is the request path minus
   * the leading `/` — joined+resolved, then verified to still live
   * under the dist root so `..` traversal can never escape. Returns
   * false on any miss (absent, not a file, escape) — callers decide
   * between SPA fallback and 404.
   */
  async function serveStaticFile(
    reply: FastifyReply,
    pathname: string,
  ): Promise<boolean> {
    if (!uiDist) return false;
    const target = resolve(uiDist, `.${sep}${pathname}`);
    if (target !== uiDist && !target.startsWith(uiDist + sep)) {
      return false;
    }
    const s = await stat(target).catch(() => null);
    if (!s?.isFile()) return false;
    const body = await readFile(target);
    void reply
      .type(MIME[extname(target).toLowerCase()] ?? 'application/octet-stream')
      .header(
        'cache-control',
        // Vite fingerprints /assets/* — immutable forever; index.html
        // and friends revalidate every load.
        target.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      )
      .send(body);
    return true;
  }

  app.get('/', async (req, reply) => {
    if (req.url.startsWith('/?token=')) {
      // Loopback bootstrap: hand out the session cookie (API.md), then
      // 303-redirect to `/` so the bearer token doesn't linger in
      // browser history / referrer logs.
      void reply
        .header(
          'set-cookie',
          `${sessionCookie}=${opts.uiToken}; HttpOnly; SameSite=Strict; Path=/`,
        )
        .redirect('/', 303);
      return;
    }
    if (uiMounted && (await serveStaticFile(reply, 'index.html'))) {
      return;
    }
    void reply
      .type('text/html')
      .send(
        '<html><body><h1>veto</h1>' +
          '<p>UI bundle not built — run ' +
          '<code>pnpm -F @veto/ui build</code>.</p></body></html>',
      );
  });

  if (uiMounted) {
    // SPA mount: GETs outside /api resolve to real files first;
    // extensionless misses fall back to index.html so client-side
    // routing works on reload; everything else is a clean 404.
    app.get('/*', async (req, reply) => {
      // Fastify already decodes params once; a literal `%` in a file
      // name must not 500 on a second decode — fall back to raw.
      const raw = (req.params as { '*': string })['*'];
      let pathname = raw;
      try {
        pathname = decodeURIComponent(raw);
      } catch {
        /* raw path */
      }
      if (await serveStaticFile(reply, pathname)) return;
      if (pathname === 'api' || pathname.startsWith('api/')) {
        throw notFound(`no such API route: /${pathname}`);
      }
      if (!extname(pathname)) {
        if (await serveStaticFile(reply, 'index.html')) return;
      }
      throw notFound(`no such asset: /${pathname}`);
    });
  }

  // ------------------------------------------------------------------
  // SSE — GET /api/v1/stream (API.md live channel)
  // ------------------------------------------------------------------

  app.get('/api/v1/stream', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    hub.add(reply);
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);
    reply.raw.on('close', () => clearInterval(heartbeat));
  });

  // ------------------------------------------------------------------
  // /inbox — S-01 unified gate_items (API.md resource table)
  // ------------------------------------------------------------------

  app.get('/api/v1/inbox', async (req) => {
    const q = req.query as { workspace?: string; include_snoozed?: string };
    const wsName = q.workspace;
    const includeSnoozed =
      q.include_snoozed === '1' || q.include_snoozed === 'true';
    const nowIso = now();
    const items = rankInbox(
      (
        await store.listGateItems(
          wsName ? { workspace: wsName, open: true } : { open: true },
        )
      ).filter((i) => includeSnoozed || !isSnoozed(i, nowIso)),
    );
    const out = await Promise.all(
      items.map(async (item) => {
        const claim = await store.getClaim({
          workspace: item.workspace,
          subject: item.subject,
          gate: item.gate,
        });
        return { ...item, claim: claim ?? null };
      }),
    );
    return { items: out };
  });

  // ------------------------------------------------------------------
  // /board — S-01 pipeline board (API.md + s-01-board)
  // ------------------------------------------------------------------
  //
  // Cards carry the ticket row + derived phase + attention + server-
  // computed drop_targets — the conductor remains the only transition
  // authority; the UI consumes, never infers. Non-ticket gate items
  // (survey/import/interview/edit subjects and orphan subjects) ride
  // the ops strip — never a fake column.

  app.get('/api/v1/board', async (req) => {
    const q = req.query as { workspace?: string };
    // Fail-closed: an unknown workspace filter is a 404, not a silent
    // empty board that looks like "no tickets".
    if (q.workspace !== undefined) workspace(q.workspace);
    const filter = q.workspace !== undefined ? { workspace: q.workspace } : {};
    const [tickets, openGates, liveRuns] = await Promise.all([
      store.listTickets(filter),
      store.listGateItems({ ...filter, open: true }),
      store.listLiveRuns(),
    ]);
    const live = liveRuns.filter(
      (r) => q.workspace === undefined || r.workspace === q.workspace,
    );
    const nowIso = now();

    // Claims for every open gate item (badge initials + board filter).
    const gatesWithClaims = await Promise.all(
      openGates.map(async (item) => ({
        ...item,
        claim:
          (await store.getClaim({
            workspace: item.workspace,
            subject: item.subject,
            gate: item.gate,
          })) ?? null,
      })),
    );
    const gatesBySubject = new Map<string, typeof gatesWithClaims>();
    for (const g of gatesWithClaims) {
      const key = `${g.workspace}/${g.subject}`;
      const list = gatesBySubject.get(key) ?? [];
      list.push(g);
      gatesBySubject.set(key, list);
    }
    const liveByTicket = new Map<string, (typeof live)[number]>();
    for (const r of live) {
      if (r.ticket_id) {
        const key = `${r.workspace}/${r.ticket_id}`;
        const prev = liveByTicket.get(key);
        if (!prev || r.id > prev.id) liveByTicket.set(key, r);
      }
    }

    const ticketsKey = new Set(
      tickets.map((t) => `${t.workspace}/${t.ticket_id}`),
    );

    // DELIVERY §8 / wp-137: the delivery dimension (planned→released→
    // deployed→exposed, materialized on release_items) rides the card
    // next to the dev status — one release_items scan per workspace,
    // strongest state wins when a ticket sits in several releases.
    const DELIVERY_RANK: Record<string, number> = {
      planned: 0,
      released: 1,
      deployed: 2,
      exposed: 3,
    };
    const deliveryByTicket = new Map<
      string,
      { release_id: string; state: string }
    >();
    for (const wsName of new Set(tickets.map((t) => t.workspace))) {
      const releases = await store.listReleases({ workspace: wsName });
      for (const rel of releases) {
        for (const item of await store.listReleaseItems({
          workspace: wsName,
          release_id: rel.release_id,
        })) {
          if (item.item_kind !== 'ticket' || item.removed_at) continue;
          const key = `${wsName}/${item.item_id}`;
          const prev = deliveryByTicket.get(key);
          if (
            !prev ||
            (DELIVERY_RANK[item.delivery_state] ?? -1) >
              (DELIVERY_RANK[prev.state] ?? -1)
          ) {
            deliveryByTicket.set(key, {
              release_id: rel.release_id,
              state: item.delivery_state,
            });
          }
        }
      }
    }

    const cards = await Promise.all(
      tickets.map(async (ticket) => {
        const key = `${ticket.workspace}/${ticket.ticket_id}`;
        const attention = rankInbox(
          (gatesBySubject.get(key) ?? []).filter((g) => !g.cleared_at),
        );
        const flagged = flagOf(ticket.status);
        // Phase retention needs the ledger only for flagged cards.
        const events =
          flagged !== null
            ? await store.listEvents({
                workspace: ticket.workspace,
                ticket_id: ticket.ticket_id,
              })
            : [];
        const phase = derivePhase(ticket.status, events);
        const snoozedUntil = attention
          .map((g) => g.snoozed_until)
          .filter((s): s is string => typeof s === 'string')
          .sort()
          .at(-1);
        const snoozed =
          attention.length > 0 &&
          attention.every(
            (g) =>
              typeof g.snoozed_until === 'string' && g.snoozed_until > nowIso,
          );
        const liveRun = liveByTicket.get(key) ?? null;
        return {
          ticket,
          ref: key,
          phase,
          flagged,
          snoozed,
          snoozed_until: snoozedUntil ?? null,
          attention,
          live_run: liveRun
            ? { id: liveRun.id, stage: liveRun.stage, status: liveRun.status }
            : null,
          drop_targets: dropTargetsFor(
            ticket,
            phase,
            liveRun !== null,
            attention,
          ),
          delivery: deliveryByTicket.get(key) ?? null,
        };
      }),
    );

    // Attention-first column order: unsnoozed attention → priority →
    // age (created_at). The UI re-sorts for its filters; this order is
    // the payload's stable baseline.
    cards.sort(
      (a, b) =>
        Number(
          b.attention.some(
            (g) => !g.snoozed_until || g.snoozed_until <= nowIso,
          ),
        ) -
          Number(
            a.attention.some(
              (g) => !g.snoozed_until || g.snoozed_until <= nowIso,
            ),
          ) ||
        prank(a.ticket.priority) - prank(b.ticket.priority) ||
        (a.ticket.created_at ?? '').localeCompare(b.ticket.created_at ?? ''),
    );

    // Ops strip: open gate items whose subject isn't a board ticket —
    // survey:/import:/interview:/edit: subjects and orphans.
    const ops = rankInbox(
      gatesWithClaims.filter(
        (g) => !ticketsKey.has(`${g.workspace}/${g.subject}`),
      ),
    );

    return {
      cards,
      ops,
      wip_limits: config.ui.wip_limits,
      generated_at: nowIso,
    };
  });

  // ------------------------------------------------------------------
  // /tickets — S-01/S-05
  // ------------------------------------------------------------------

  app.get('/api/v1/tickets', async (req) => {
    const q = req.query as {
      workspace?: string;
      status?: string;
      repo?: string;
      feature?: string;
    };
    let tickets = await store.listTickets({
      ...(q.workspace ? { workspace: q.workspace } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
    if (q.repo)
      tickets = tickets.filter((t) => t.repos.includes(q.repo as string));
    if (q.feature) tickets = tickets.filter((t) => t.feature === q.feature);
    return { tickets };
  });

  /**
   * Direct ticket creation (§15.7, wp-151). Engineers create
   * bugs/tech/spikes/operational work directly; a `story` (or any
   * non-direct type) must arrive from an approved RS/board proposal —
   * `directCreateAllowed` / `needsScopeApproval` decide, fail-closed.
   * The created row lands at `imported`, so the pipeline's intake gate
   * still classifies + enforces evidence.
   */
  app.post('/api/v1/tickets', async (req, reply) => {
    const body = parseBody(CreateTicketBodySchema, req.body, 'create ticket');
    const ws = workspace(body.workspace);
    const workType = body.work_type as TicketWorkType;
    if (!(TICKET_WORK_TYPES as readonly string[]).includes(workType)) {
      throw badRequest(
        `unknown work_type '${body.work_type}' (expected ${TICKET_WORK_TYPES.join('|')})`,
      );
    }
    const origin = (body.origin ?? 'manual') as TicketOrigin;
    if (!(TICKET_ORIGINS as readonly string[]).includes(origin)) {
      throw badRequest(
        `unknown origin '${body.origin}' (expected ${TICKET_ORIGINS.join('|')})`,
      );
    }
    // Approved scope = an approved origin (rs/board) or an explicit
    // `scope_ref` to the authorizing RS/board proposal — which must
    // resolve to a REAL approved artifact, never just a string:
    //   - a board row at lifecycle status `approved` (the board
    //     proposal IS the approval);
    //   - a feature/initiative carrying a durable `doc_approved` event
    //     (the RS/acceptance approval the ticket traces back to);
    //   - any other subject with a `doc_approved` event on its rs doc.
    // Anything else is a fabricated proof — 409 whether the ref is
    // unknown or exists-but-unapproved (don't leak which).
    let scopeApproved = (APPROVED_SCOPE_ORIGINS as readonly string[]).includes(
      origin,
    );
    if (body.scope_ref !== undefined) {
      scopeApproved = await scopeRefApproved(ws.name, body.scope_ref);
      if (!scopeApproved) {
        throw conflict(
          `scope_ref '${body.scope_ref}' does not resolve to an approved artifact (approved board or a subject with a doc_approved rs/acceptance doc)`,
        );
      }
    }
    // §15.7 direct-create rules: a type that isn't directly creatable
    // (story) needs approved scope; `needsScopeApproval` decides.
    if (
      (!directCreateAllowed(workType) && !scopeApproved) ||
      needsScopeApproval(workType, origin, null, scopeApproved)
    ) {
      throw forbidden(
        `work type '${workType}' may not be created directly — it must originate from an approved RS/board proposal (set origin ${APPROVED_SCOPE_ORIGINS.join('|')} or supply scope_ref)`,
      );
    }
    // Priority ≠ severity (§15.7): the enum is validated, `forbidden`
    // where it could only mean "importance", and `required` up front
    // for bug/security/incident work — the same rule the intake gate
    // enforces downstream, applied here so a malformed create 400s
    // instead of landing a ticket that can never leave `imported`.
    if (body.severity !== undefined) {
      const rule = severityRule(workType, origin);
      if (!(TICKET_SEVERITIES as readonly string[]).includes(body.severity)) {
        throw badRequest(
          `unknown severity '${body.severity}' (expected ${TICKET_SEVERITIES.join('|')})`,
        );
      }
      if (rule === 'forbidden') {
        throw badRequest(
          `severity does not apply to ${workType} tickets (priority ≠ severity, §15.7)`,
        );
      }
    } else if (severityRule(workType, origin) === 'required') {
      throw badRequest(
        `severity is required for ${workType} tickets (§15.7 — expected ${TICKET_SEVERITIES.join('|')})`,
      );
    }
    const priority = (body.priority ?? 'medium') as TicketPriority;
    if (!(TICKET_PRIORITIES as readonly string[]).includes(priority)) {
      throw badRequest(
        `unknown priority '${body.priority}' (expected ${TICKET_PRIORITIES.join('|')})`,
      );
    }
    const depth = body.depth ?? 'standard';
    if (!(DEPTH_TIERS as readonly string[]).includes(depth)) {
      throw badRequest(
        `unknown depth '${body.depth}' (expected ${DEPTH_TIERS.join('|')})`,
      );
    }
    const repos = body.repos ?? [];
    const source = body.scope_ref ? `scope:${body.scope_ref}` : 'manual';
    const ts = now();
    const ticketId = await store.allocTicketId(ws.name);
    const contents = [
      '---',
      YAML.stringify({
        schema: 1,
        id: ticketId,
        title: body.title,
        status: 'imported',
        priority,
        ...(body.feature ? { feature: body.feature } : {}),
        repos,
        depth,
        source,
        ...(body.parent ? { parent: body.parent } : {}),
        depends_on: [],
        forced: false,
      }).trimEnd(),
      '---',
      '',
      '## Description',
      '',
      body.body?.trim() ?? '',
      '',
    ].join('\n');
    await store.transaction(async (s) => {
      await s.upsertTicket({
        workspace: ws.name,
        ticket_id: ticketId,
        feature: body.feature ?? null,
        title: body.title,
        status: 'imported',
        priority,
        depth,
        backend: body.backend ?? null,
        model: body.model ?? null,
        repos,
        parent: body.parent ?? null,
        depends_on: [],
        source,
        work_type: workType,
        origin,
        severity: (body.severity ?? null) as TicketRow['severity'],
        forced: false,
        spec_score: null,
        spec_hash: null,
        blocked_reason: null,
        created_at: ts,
        updated_at: ts,
      });
      await s.appendDocVersion(
        { workspace: ws.name, subject: ticketId, doc: 'ticket.md' },
        contents,
        actor,
      );
      for (const repo of repos) {
        await s.upsertTicketRepo({
          workspace: ws.name,
          ticket_id: ticketId,
          repo,
          branch: null,
          worktree: null,
          pr_url: null,
          pr_state: null,
          ci_state: null,
          merged_sha: null,
        });
      }
    });
    await emitEvent(ws, {
      ticketId,
      event: 'imported',
      data: {
        via: 'direct-create',
        work_type: workType,
        origin,
        ...(body.scope_ref ? { scope_ref: body.scope_ref } : {}),
      },
    });
    return reply.status(201).send({
      ticket_id: ticketId,
      ticket: await getTicketOr404(ws.name, ticketId),
    });
  });

  app.get('/api/v1/tickets/:workspace/:ticket', async (req) => {
    const { workspace: wsName, ticket } = req.params as {
      workspace: string;
      ticket: string;
    };
    const ws = workspace(wsName);
    const row = await getTicketOr404(wsName, ticket);
    // D29: ticket.md is a doc_versions doc; triage.json a run_artifact.
    const ticketMd =
      (
        await store.getDoc({
          workspace: wsName,
          subject: ticket,
          doc: 'ticket.md',
        })
      )?.content ?? null;
    const triageRaw = (await latestArtifact(wsName, ticket, 'triage.json'))
      ?.content;
    const repos = await store.listTicketRepos({
      workspace: wsName,
      ticket_id: ticket,
    });
    const gates = await store.listGateItems({
      workspace: wsName,
      open: true,
    });
    // Family rail: parent + depends_on (S-05).
    const family: TicketRow[] = [];
    for (const dep of [row.parent, ...(row.depends_on ?? [])]) {
      if (!dep) continue;
      const d = await store.getTicket({ workspace: wsName, ticket_id: dep });
      if (d) family.push(d);
    }
    const children = (await store.listTickets({ workspace: wsName })).filter(
      (t) => t.parent === ticket,
    );
    // Latest version of every doc on the subject (S-05 docs tab, D29).
    const docs = (
      await store.listDocs({ workspace: wsName, subject: ticket })
    ).map((d) => ({
      doc: d.doc,
      version: d.version,
      edited_by: d.edited_by,
      created_at: d.created_at,
    }));
    // Derived board phase for the focus page rail (same rule as
    // /board — failed/blocked retain the phase they died in).
    const flagged = flagOf(row.status);
    const phase = derivePhase(
      row.status,
      flagged !== null
        ? await store.listEvents({
            workspace: wsName,
            ticket_id: ticket,
          })
        : [],
    );
    return {
      ticket: row,
      ticket_md: ticketMd,
      triage: triageRaw ? parseArtifactJson(triageRaw, 'triage.json') : null,
      repos,
      docs,
      phase,
      flagged,
      open_gates: gates.filter((g) => g.subject === ticket),
      family: [...family, ...children],
      // §15.7 Ticket Workbench (wp-151) — per-type tabs + evidence.
      workbench: await workbenchFor(wsName, row),
    };
  });

  /**
   * Doc name → DOC_KINDS doc. Routes accept either the bare name
   * (`rs`) or the full doc kind (`rs.md`). `split-plan` is the one
   * exception: it's a run_artifact (RUN_ARTIFACT_KINDS), served from
   * the latest producing run.
   */
  function docKindFor(name: string): DocKind | null {
    const resolved = docNameFor(name);
    if ((DOC_KINDS as readonly string[]).includes(resolved))
      return resolved as DocKind;
    const md = `${resolved}.md`;
    if ((DOC_KINDS as readonly string[]).includes(md)) return md as DocKind;
    return null;
  }

  app.get('/api/v1/tickets/:workspace/:ticket/docs/:name', async (req) => {
    const {
      workspace: wsName,
      ticket,
      name,
    } = req.params as {
      workspace: string;
      ticket: string;
      name: string;
    };
    workspace(wsName);
    await getTicketOr404(wsName, ticket);
    const doc = docKindFor(name);
    if (doc === null) {
      // split-plan.md is a run artifact, not a doc_versions kind.
      if (name === 'split-plan') {
        const art = await latestArtifact(wsName, ticket, 'split-plan.md');
        if (!art) throw notFound(`no split-plan.md for ${wsName}/${ticket}`);
        return {
          name,
          doc: 'split-plan.md',
          content: art.content,
          versions: [],
          diffs: [],
        };
      }
      throw badRequest(
        `unknown doc '${name}' (expected ${DOC_KINDS.join('|')} or split-plan)`,
      );
    }
    const dv = await store.getDoc({
      workspace: wsName,
      subject: ticket,
      doc,
    });
    if (!dv) throw notFound(`no ${doc} for ${wsName}/${ticket}`);
    // Version history replaces the old git-log diffs (D29 — doc_versions
    // are immutable; diffs derive from consecutive immutable versions).
    const all = await store.listDocVersions({
      workspace: wsName,
      subject: ticket,
      doc,
    });
    const versions = all.map((v) => ({
      version: v.version,
      edited_by: v.edited_by,
      created_at: v.created_at,
    }));
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
      versions,
      diffs,
    };
  });

  app.get('/api/v1/tickets/:workspace/:ticket/events', async (req) => {
    const { workspace: wsName, ticket } = req.params as {
      workspace: string;
      ticket: string;
    };
    workspace(wsName);
    await getTicketOr404(wsName, ticket);
    const events = await store.listEvents({
      workspace: wsName,
      ticket_id: ticket,
    });
    return {
      events,
      // LOG.md is a derived render of the events rows (DB-SCHEMA).
      log_md: renderLogMd(ticket, events),
    };
  });

  // ---- S-08 review.json — latest review run_artifact (D19 gap) ----

  app.get('/api/v1/tickets/:workspace/:ticket/review', async (req) => {
    const { workspace: wsName, ticket } = req.params as {
      workspace: string;
      ticket: string;
    };
    workspace(wsName);
    await getTicketOr404(wsName, ticket);
    // review.json is a run_artifact under D29 — the same lookup the
    // findings verdict route writes through (nested names included).
    const art = await latestArtifact(wsName, ticket, 'review.json');
    if (art === null) {
      throw notFound(`no review.json for ${wsName}/${ticket}`);
    }
    // Fail-closed: a malformed artifact is an honest 5xx, never a
    // half-parsed payload the UI mistakes for a clean review.
    const review = parseArtifactJson(
      art.content,
      `review.json on run ${art.runId}`,
    );
    return { run_id: art.runId, name: art.name, review };
  });

  // ---- S-06 rs-quality.json — latest prd run_artifact (wp-111) ----

  app.get('/api/v1/tickets/:workspace/:ticket/rs-quality', async (req) => {
    const { workspace: wsName, ticket } = req.params as {
      workspace: string;
      ticket: string;
    };
    workspace(wsName);
    await getTicketOr404(wsName, ticket);
    // rs-quality.json is a run_artifact under D29 — the cited AI
    // quality pass rendered next to rs.md (S-06 doc review).
    const art = await latestArtifact(wsName, ticket, 'rs-quality.json');
    if (art === null) {
      throw notFound(`no rs-quality.json for ${wsName}/${ticket}`);
    }
    const quality = parseArtifactJson(
      art.content,
      `rs-quality.json on run ${art.runId}`,
    );
    return { run_id: art.runId, name: art.name, quality };
  });

  // ---- S-04 wizard answers → commit → re-run ----

  app.post('/api/v1/tickets/:workspace/:ticket/answers', async (req, reply) => {
    const { workspace: wsName, ticket } = req.params as {
      workspace: string;
      ticket: string;
    };
    const body = parseBody(AnswersBodySchema, req.body, 'answers');
    const ws = workspace(wsName);
    const isInterview = ticket.startsWith('interview:');
    let row: TicketRow | null = null;
    if (!isInterview) {
      row = await getTicketOr404(wsName, ticket);
      if (
        body.expected_status !== undefined &&
        row.status !== body.expected_status
      ) {
        throw conflict(
          `stale write: expected status '${body.expected_status}', ` +
            `ticket is '${row.status}'`,
        );
      }
    }
    const answers: Record<string, string | string[]> = {
      ...(body.answers ?? {}),
      ...(body.id !== undefined && body.answer !== undefined
        ? { [body.id]: body.answer }
        : {}),
    };
    if (Object.keys(answers).length === 0) {
      throw badRequest('answers: provide {id, answer} or {answers: {…}}');
    }

    // Route by the OPEN gate — the artifact that takes the answers is
    // the one that surfaced the questions (design-qa → design.json;
    // interview-qa → the interview subject's triage.json). Picking the
    // file before checking the gate avoids writing triage.json when a
    // design-qa gate is what actually stands open.
    const gate = isInterview
      ? await openGate(wsName, ticket, ['interview-qa'])
      : await openGate(wsName, ticket, ['needs-info', 'design-qa']);
    const file =
      gate === 'design-qa' ? 'design.json' : ('triage.json' as const);
    const art = await latestArtifact(
      wsName,
      ticket,
      file,
      isInterview ? { subject: ticket } : {},
    );
    if (art === null) {
      throw notFound(
        `${file} not found for ${isInterview ? 'subject' : 'ticket'}`,
      );
    }
    const doc = parseArtifactJson(art.content, file) as {
      questions?: Array<Record<string, unknown>>;
    };
    const ts = now();
    const answered: string[] = [];
    for (const q of doc.questions ?? []) {
      const a = answers[q.id as string];
      if (a === undefined) continue;
      q.answer = a;
      q.status = 'answered';
      q.answered_by = actor;
      q.answered_at = ts;
      answered.push(q.id as string);
    }
    const missing = Object.keys(answers).filter((k) => !answered.includes(k));
    if (answered.length === 0) {
      throw badRequest(`no open question matched: ${missing.join(', ')}`);
    }
    // Write back under the artifact's real name — a nested artifact
    // (`<repo>/triage.json`) is replaced at its own path, not forked
    // under a top-level name.
    await store.putArtifact({
      run_id: art.runId,
      name: art.name,
      content: `${JSON.stringify(doc, null, 2)}\n`,
      created_at: ts,
    });
    await emitEvent(ws, {
      ticketId: isInterview ? null : ticket,
      event: 'question_answered',
      run: art.runId,
      data: {
        questions: answered,
        ...(isInterview ? { subject: ticket } : {}),
      },
    });

    if (gate) await clearGate({ ws, subject: ticket, gate });
    if (isInterview) {
      // Re-run the interview on the same subject — NEW_ID rides the
      // prior run's persisted request so re-runs draft into the SAME
      // reserved id (WONT-DRAFT burns it; answers never allocate).
      const prior = await store.getRun(art.runId);
      const priorReq =
        prior?.request && typeof prior.request === 'object'
          ? (prior.request as { tokens?: Record<string, string> }).tokens
          : undefined;
      const run = await requestRun(wsName, {
        subject: ticket,
        stage: 'interview',
        tokens: {
          ...(priorReq?.NEW_ID ? { NEW_ID: priorReq.NEW_ID } : {}),
          // The answered question set rides the next run's prompt —
          // artifacts are DB rows under D29, not files the agent can
          // re-open (the interview template reads {{TRIAGE_JSON}}).
          TRIAGE_JSON: `${JSON.stringify(doc, null, 2)}\n`,
        },
      });
      return reply.status(202).send({ answered, gate_cleared: gate, run });
    }
    return { answered, gate_cleared: gate };
  });

  // ---- S-06 doc feedback → doc_feedback → revision run ----

  const DOC_STAGE: Record<string, string> = {
    rs: 'prd',
    tdd: 'design',
    vs: 'testplan',
  };

  app.post(
    '/api/v1/tickets/:workspace/:ticket/docs/:name/feedback',
    async (req, reply) => {
      const {
        workspace: wsName,
        ticket,
        name,
      } = req.params as {
        workspace: string;
        ticket: string;
        name: string;
      };
      const stage = DOC_STAGE[docNameFor(name)];
      if (!stage) throw badRequest(`unknown doc '${name}'`);
      const body = parseBody(FeedbackBodySchema, req.body, 'feedback');
      const ws = workspace(wsName);
      const row = await getTicketOr404(wsName, ticket);
      if (
        body.expected_status !== undefined &&
        row.status !== body.expected_status
      ) {
        throw conflict(
          `stale write: expected status '${body.expected_status}', ` +
            `ticket is '${row.status}'`,
        );
      }
      const comment = body.comment;
      // D29: the comment rides the doc_feedback event row AND the
      // pending run's request tokens — the revision run's prompt gets
      // {{FEEDBACK}} even when the queued row is claimed hours later
      // (the event row alone would bury it in the ledger).
      await emitEvent(ws, {
        ticketId: ticket,
        stage,
        event: 'doc_feedback',
        data: { doc: name, comment },
      });
      const run = await requestRun(wsName, {
        subject: ticket,
        stage,
        ticketId: ticket,
        tokens: { FEEDBACK: comment },
      });
      return reply.status(202).send({ accepted: true, run });
    },
  );

  // ---- S-06 doc approve → clear review gate (+ durable doc_approved) ----

  app.post(
    '/api/v1/tickets/:workspace/:ticket/docs/:name/approve',
    async (req) => {
      const {
        workspace: wsName,
        ticket,
        name,
      } = req.params as {
        workspace: string;
        ticket: string;
        name: string;
      };
      const candidates = DOC_GATES[docNameFor(name)];
      if (!candidates) throw badRequest(`unknown doc '${name}'`);
      const body = req.body as { expected_status?: string } | null;
      const ws = workspace(wsName);
      const row = await getTicketOr404(wsName, ticket);
      if (
        body?.expected_status !== undefined &&
        row.status !== body.expected_status
      ) {
        throw conflict(
          `stale write: expected status '${body.expected_status}', ` +
            `ticket is '${row.status}'`,
        );
      }
      const gate = await openGate(wsName, ticket, candidates);
      if (!gate) {
        // Stale resubmission (another install/UI cleared it first) is a
        // 409; a never-surfaced gate is a 404 (API.md gate writes).
        let cleared = false;
        for (const g of candidates) {
          const item = await store.getGateItem({
            workspace: wsName,
            subject: ticket,
            gate: g,
          });
          if (item?.cleared_at) cleared = true;
        }
        if (cleared) {
          throw conflict('stale write: review gate already cleared');
        }
        throw notFound(`no open review gate for ${wsName}/${ticket}/${name}`);
      }
      const cleared = await clearGate({ ws, subject: ticket, gate });
      await emitEvent(ws, {
        ticketId: ticket,
        event: 'doc_approved',
        // Canonical on-disk doc name — approval via the `prd`/`test`
        // aliases registers on `rs.md`/`vs.md`, and radar keys approvals
        // by the baseline pin doc so `rs` must record `rs.md` too.
        data: {
          doc: DOC_DISK_NAME[docNameFor(name)] ?? docNameFor(name),
          gate,
        },
      });
      return { approved: true, gate_cleared: cleared.gate };
    },
  );

  // ---- S-08 finding verdicts ----

  app.post(
    '/api/v1/tickets/:workspace/:ticket/findings/:fid/verdict',
    async (req) => {
      const {
        workspace: wsName,
        ticket,
        fid,
      } = req.params as {
        workspace: string;
        ticket: string;
        fid: string;
      };
      const body = req.body as {
        verdict?: string;
        expected_status?: string;
      } | null;
      const ws = workspace(wsName);
      const row = await getTicketOr404(wsName, ticket);
      if (
        body?.expected_status !== undefined &&
        row.status !== body.expected_status
      ) {
        throw conflict(
          `stale write: expected status '${body.expected_status}', ` +
            `ticket is '${row.status}'`,
        );
      }
      const verdict = body?.verdict;
      if (!verdict || !['accept', 'dismiss', 'wontfix'].includes(verdict)) {
        throw badRequest('verdict must be accept|dismiss|wontfix');
      }
      // review.json is a run_artifact under D29 — write the verdict
      // back onto its producing run.
      const art = await latestArtifact(wsName, ticket, 'review.json');
      if (art === null) throw notFound('review.json not found for ticket');
      const review = parseArtifactJson(art.content, 'review.json') as {
        findings: Array<Record<string, unknown>>;
      };
      const finding = review.findings.find((f) => f.thread_id === fid);
      if (!finding) throw notFound(`no finding '${fid}'`);
      // accept confirms the finding (stays open for the fix loop);
      // dismiss/wontfix settle it (FINDING_STATUSES, SCHEMAS §6).
      finding.status =
        verdict === 'accept'
          ? 'open'
          : verdict === 'dismiss'
            ? 'dismissed'
            : 'wontfix';
      await store.putArtifact({
        run_id: art.runId,
        name: 'review.json',
        content: `${JSON.stringify(review, null, 2)}\n`,
        created_at: now(),
      });
      await emitEvent(ws, {
        ticketId: ticket,
        event: verdict === 'accept' ? 'finding_created' : 'finding_dismissed',
        run: art.runId,
        refs: ['review.json'],
        data: { finding: fid, verdict },
      });
      return { verdict, finding: fid };
    },
  );

  // ---- actions (S-05 rail / inbox buttons) ----

  app.post('/api/v1/tickets/:workspace/:ticket/actions', async (req, reply) => {
    const { workspace: wsName, ticket } = req.params as {
      workspace: string;
      ticket: string;
    };
    const body = req.body as {
      action?: string;
      expected_status?: string;
      to?: string;
      decision?: string;
      params?: Record<string, unknown>;
    } | null;
    const ws = workspace(wsName);
    const row = await getTicketOr404(wsName, ticket);
    const action = body?.action;
    if (!action) throw badRequest('actions: {action} is required');
    if (
      body?.expected_status !== undefined &&
      row.status !== body.expected_status
    ) {
      throw conflict(
        `stale write: expected status '${body.expected_status}', ` +
          `ticket is '${row.status}'`,
      );
    }

    const clear = (gate: string) => clearGate({ ws, subject: ticket, gate });

    switch (action) {
      // Spend checkpoint: clear test-approved → nextStage launches
      // implement (CONDUCTOR auto-advance).
      case 'go_implement': {
        const cleared = await clear('test-approved');
        return { action, gate_cleared: cleared.gate };
      }
      case 'open_pr': {
        const cleared = await clear('approved');
        return { action, gate_cleared: cleared.gate };
      }
      case 'merge': {
        const cleared = await clear('ci-watch');
        return { action, gate_cleared: cleared.gate };
      }
      case 'approve_split': {
        if (body?.decision === 'reject') {
          // ResolveSplitPlan reads gate_overridden to re-triage instead.
          await emitEvent(ws, {
            ticketId: ticket,
            event: 'gate_overridden',
            data: { gate: 'split-plan' },
          });
        }
        const cleared = await clear('split-plan');
        return { action, gate_cleared: cleared.gate };
      }
      // §15.7 scope proposal (wp-151): approve authorizes the over-scope
      // work; decline records a gate_overridden so the conductor
      // escalates instead of absorbing it.
      case 'approve_scope':
      case 'reject_scope': {
        if (action === 'reject_scope') {
          await emitEvent(ws, {
            ticketId: ticket,
            event: 'gate_overridden',
            data: { gate: 'scope-proposal' },
          });
        }
        const cleared = await clear('scope-proposal');
        return { action, gate_cleared: cleared.gate };
      }
      case 'resume': {
        const gate = await openGate(wsName, ticket, [
          'escalated',
          'changes-requested',
        ]);
        if (!gate) {
          // Fall back to a durable resume signal on blocked/failed
          // tickets — CLAIM re-derives the next stage from status.
          await emitEvent(ws, {
            ticketId: ticket,
            event: 'resumed',
            data: { via: 'actions' },
          });
          return { action, resumed: true };
        }
        const cleared = await clear(gate);
        return { action, gate_cleared: cleared.gate };
      }
      case 'send_back': {
        const to = body?.to;
        if (!to) throw badRequest("send_back: {to: '<status>'} is required");
        await applyTicketStatus({
          ctx: transitionCtx(ws),
          opts: {
            ticketId: ticket,
            status: to as TicketStatus,
            data: { action },
          },
        });
        await emitEvent(ws, {
          ticketId: ticket,
          event: 'handoff',
          data: { action, to },
        });
        hub.notify({
          type: 'ticket_updated',
          payload: { workspace: wsName, ticket_id: ticket, status: to },
        });
        return { action, status: to };
      }
      case 'force_ready': {
        // Human override: stamp forced: true (nextStage reads it →
        // gate_overridden ledger entries) + land ready. The flag lives
        // on the tickets row AND the ticket.md doc's frontmatter (a new
        // doc_version — D24/D29).
        await store.upsertTicket({
          ...row,
          forced: true,
          updated_at: now(),
        });
        const dv = await store.getDoc({
          workspace: wsName,
          subject: ticket,
          doc: 'ticket.md',
        });
        if (dv) {
          const next = upsertFrontmatterKeys(dv.content, {
            forced: 'true',
          });
          if (next !== dv.content) {
            await store.appendDocVersion(
              { workspace: wsName, subject: ticket, doc: 'ticket.md' },
              next,
              actor,
            );
          }
        }
        await applyTicketStatus({
          ctx: transitionCtx(ws),
          opts: {
            ticketId: ticket,
            status: 'ready',
            data: { action, forced: true },
          },
        });
        return { action, status: 'ready' };
      }
      case 'wont_do': {
        await applyTicketStatus({
          ctx: transitionCtx(ws),
          opts: {
            ticketId: ticket,
            status: 'wont-do',
            data: { action },
          },
        });
        hub.notify({
          type: 'ticket_updated',
          payload: { workspace: wsName, ticket_id: ticket, status: 'wont-do' },
        });
        return { action, status: 'wont-do' };
      }
      case 'abort': {
        // S-01 drag-drop: an in-flight card dropped on Done. Marks the
        // ticket aborted; a still-running reconcile remains
        // authoritative for the run row.
        await applyTicketStatus({
          ctx: transitionCtx(ws),
          opts: {
            ticketId: ticket,
            status: 'aborted',
            data: { action },
          },
        });
        hub.notify({
          type: 'ticket_updated',
          payload: { workspace: wsName, ticket_id: ticket, status: 'aborted' },
        });
        return { action, status: 'aborted' };
      }
      case 'handoff': {
        await emitEvent(ws, {
          ticketId: ticket,
          event: 'handoff',
          data: { to: body?.to ?? 'human', action },
        });
        return { action, handed_off: true };
      }
      case 'revert': {
        const run = await requestRun(wsName, {
          subject: ticket,
          stage: 'revert',
          ticketId: ticket,
        });
        return reply.status(202).send({ action, run });
      }
      case 'retry': {
        const runs = (
          await store.listRuns({
            workspace: wsName,
            ticket_id: ticket,
          })
        ).sort((a, b) => b.attempt - a.attempt);
        const last = runs.find((r) =>
          ['failed', 'killed', 'stalled', 'done'].includes(r.status),
        );
        if (!last) throw notFound('no completed run to retry');
        const run = await requestRun(wsName, {
          subject: last.subject,
          stage: last.stage,
          ticketId: ticket,
        });
        return reply.status(202).send({ action, run, retry_of: last.id });
      }
      // wp-111: the rs-quality gate is cleared by the human waiving the
      // cited critical findings — an honest gate_overridden ledger
      // entry, not a doc approval (rs.md is read-only; the findings
      // stay recorded). Idempotent: an already-cleared gate is a noop.
      case 'waive_quality': {
        const gate = await store.getGateItem({
          workspace: wsName,
          subject: ticket,
          gate: 'rs-quality',
        });
        if (gate === null || gate.cleared_at !== null) {
          return { action, gate_cleared: null };
        }
        await emitEvent(ws, {
          ticketId: ticket,
          event: 'gate_overridden',
          data: { gate: 'rs-quality' },
        });
        const cleared = await clear('rs-quality');
        return { action, gate_cleared: cleared.gate };
      }
      // Known but not wired to a transition path — honest 501, never
      // faked (wp-060 ticket).
      default:
        throw notImplemented(`action '${action}' is not implemented`);
    }
  });

  // ------------------------------------------------------------------
  // /runs — S-07 monitor + control
  // ------------------------------------------------------------------

  app.get('/api/v1/runs', async (req) => {
    const q = req.query as {
      workspace?: string;
      subject?: string;
      ticket_id?: string;
      status?: string;
    };
    return {
      runs: await store.listRuns({
        ...(q.workspace ? { workspace: q.workspace } : {}),
        ...(q.subject ? { subject: q.subject } : {}),
        ...(q.ticket_id ? { ticket_id: q.ticket_id } : {}),
        ...(q.status ? { status: q.status } : {}),
      }),
    };
  });

  // Run ids contain '/' — callers URL-encode them (encodeURIComponent).
  app.get('/api/v1/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const runId = decodeURIComponent(id);
    const run = await store.getRun(runId);
    if (!run) throw notFound(`unknown run '${id}'`);
    // D29: structured output is run_artifacts rows, not files on disk.
    const artifacts = (await store.listArtifacts(runId)).map((a) => a.name);
    return { run, artifacts };
  });

  for (const op of ['kill', 'pause', 'resume'] as const) {
    app.post(`/api/v1/runs/:id/${op}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const runId = decodeURIComponent(id);
      const run = await store.getRun(runId);
      if (!run) throw notFound(`unknown run '${id}'`);
      const call =
        op === 'kill'
          ? conductor.killRun
          : op === 'pause'
            ? conductor.pauseRun
            : conductor.resumeRun;
      await call.call(conductor, runId);
      return reply.status(202).send({ op, run: runId });
    });
  }

  // ------------------------------------------------------------------
  // /workspaces — S-13
  // ------------------------------------------------------------------

  app.get('/api/v1/workspaces', async () => {
    const pending = await store.listRuns({ status: 'pending' });
    const nowIso = now();
    const workspaces = await Promise.all(
      conductor.deps.workspaces.map(async (ws) => ({
        name: ws.name,
        root_path: ws.rootPath,
        queue_depth: pending.filter((r) => r.workspace === ws.name).length,
        // Badge semantics (D20): snoozed items don't demand attention.
        open_gate_items: (
          await store.listGateItems({ workspace: ws.name, open: true })
        ).filter((i) => !isSnoozed(i, nowIso)).length,
      })),
    );
    return { workspaces };
  });

  // Rich per-project rollup for the /projects picker (UI-INVENTORY §2)
  // — one query, no per-project fan-out. Configured workspaces with no
  // data yet still appear, zeroed, so the picker is complete even on a
  // fresh registration.
  app.get('/api/v1/projects/summary', async () => {
    const summaries = await store.listProjectSummaries(now());
    const byWorkspace = new Map(summaries.map((s) => [s.workspace, s]));
    const projects = conductor.deps.workspaces.map(
      (ws) =>
        byWorkspace.get(ws.name) ?? {
          workspace: ws.name,
          name: ws.name,
          boards: 0,
          open_gate_items: 0,
          queue_depth: 0,
          live_runs: 0,
          last_active_at: null,
          totals: { cost_usd: 0, tokens: 0, human_minutes: 0 },
          counts: { tickets: 0, features: 0, initiatives: 0 },
        },
    );
    return { projects };
  });

  app.post('/api/v1/workspaces', async (req, reply) => {
    const body = parseBody(WorkspaceBodySchema, req.body, 'workspaces');
    if (conductor.deps.workspaces.some((w) => w.name === body.name)) {
      throw conflict(`workspace '${body.name}' already exists`);
    }
    // D29: a workspace is a plain root dir (run dirs, repo anchoring,
    // .veto/ scratch) — no tickets repo to clone, no tickets_repos
    // config key. The project row is the DB registration.
    // `path` is caller-supplied: this is a local tool, so the rule is
    // "absolute and outside the OS-owned trees" — a relative path or a
    // root under /etc, /usr, /System, … is refused before mkdir.
    let rootPath: string;
    if (body.path !== undefined) {
      const resolved = resolve(body.path);
      if (!isAbsolute(body.path)) {
        throw badRequest(`workspace path '${body.path}' must be absolute`);
      }
      // Symlink/case-normalized check: a case-insensitive filesystem
      // turns `/ETC/x` into `/etc`, and a symlinked dir escapes the
      // string check — compare the real canonical path (case-folded)
      // when the target already exists on disk.
      let canonical = resolved;
      try {
        canonical = await realpath(resolved);
      } catch {
        // Doesn't exist yet — the to-be-created path still can't be
        // inside a system tree on the literal spelling.
      }
      const fold = canonical.toLowerCase();
      const SYSTEM_ROOTS = [
        '/etc',
        '/usr',
        '/System',
        '/bin',
        '/sbin',
        '/lib',
        '/lib64',
        '/boot',
        '/dev',
        '/proc',
        '/sys',
        '/var',
        '/private',
        '/root',
        '/Library',
        '/Applications',
        '/Windows',
        '/Program Files',
        '/Program Files (x86)',
      ];
      const denied = (p: string, roots: readonly string[]) =>
        p === '/' || roots.some((r) => p === r || p.startsWith(`${r}/`));
      const SYSTEM_ROOTS_LC = SYSTEM_ROOTS.map((r) => r.toLowerCase());
      if (denied(resolved, SYSTEM_ROOTS) || denied(fold, SYSTEM_ROOTS_LC)) {
        throw badRequest(
          `workspace path '${resolved}' is inside an OS-managed tree — pick a user-writable directory`,
        );
      }
      rootPath = resolved;
    } else {
      rootPath = join(
        homedir(),
        '.local',
        'share',
        'veto',
        'workspaces',
        body.name,
      );
    }
    await mkdir(rootPath, { recursive: true });
    const ts = now();
    const existing = await store.getProject(body.name);
    if (!existing) {
      await store.upsertProject({
        workspace: body.name,
        name: body.name,
        next_ticket_seq: 1,
        next_feature_seq: 1,
        next_initiative_seq: 1,
        next_release_seq: 1,
        // wp-099: persist the resolved root so daemon boots (and the
        // CLI's project listing) can rebuild workspaces from the DB
        // alone — `path` is the canonical field.
        settings: { path: rootPath },
        created_at: ts,
      });
    } else if (existing.settings?.path !== rootPath) {
      // Re-POSTing with an explicit path repairs/updates the row —
      // keep every other settings key intact.
      await store.upsertProject({
        ...existing,
        settings: { ...existing.settings, path: rootPath },
      });
    }
    conductor.deps.workspaces.push({
      name: body.name,
      rootPath,
    });
    return reply.status(201).send({
      workspace: { name: body.name, root_path: rootPath },
    });
  });

  // ------------------------------------------------------------------
  // /interview + /import — S-03
  // ------------------------------------------------------------------

  // ---- chat-to-edit sessions (API.md /interview edit mode, s-01 D25) ----
  //
  // Session state is durable, never memory: a `notes.md` doc_version on
  // subject `edit:<session>` holds a JSONL transcript whose first line
  // is the session header (subject + target). The pending proposal is
  // the newest run's `proposed-diff.md` run_artifact; human approval is
  // the `edit:<session>` gate item the conductor surfaces on
  // EDIT-PROPOSED. No new tables — everything rides existing rows.

  const EDITABLE_TICKET_DOCS = new Set<DocKind>([
    'ticket.md',
    'rs.md',
    'tdd.md',
    'vs.md',
  ]);
  /** Feature-subject editable docs — the "Ask About This Feature"
   *  scoped assistant (PRD §15.7, wp-152; API.md subject_ref
   *  generalization D27) answers from, and diffs, the feature's own
   *  doc evidence only. */
  const EDITABLE_FEATURE_DOCS = new Set<DocKind>([
    'feature.md',
    'ac.md',
    'vs.md',
    'notes.md',
  ]);
  const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  const editSessionSubject = (session: string) => `edit:${session}`;

  interface EditSessionLine {
    ts: string;
    kind: 'session' | 'turn' | 'applied' | 'discarded';
    subject?: string;
    target?: DocKind;
    message?: string;
    run?: string | null;
    outcome?: string;
    doc?: DocKind;
    version?: number;
  }

  /** Parse the session's notes.md JSONL — fail-closed: a corrupt line
   *  is an internal error, never a guessed session. */
  function parseSessionDoc(content: string): EditSessionLine[] {
    return content
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map(
        (l) =>
          parseArtifactJson(l, 'edit-session transcript') as EditSessionLine,
      );
  }

  async function appendSessionLine(
    wsName: string,
    session: string,
    prior: string | null,
    line: EditSessionLine,
  ): Promise<void> {
    const content = `${prior ?? ''}${JSON.stringify(line)}\n`;
    await store.appendDocVersion(
      {
        workspace: wsName,
        subject: editSessionSubject(session),
        doc: 'notes.md',
      },
      content,
      actor,
    );
  }

  /** Locate a session's notes.md — workspace-scoped when the caller
   *  passes ?workspace=, else scanned across known workspaces (session
   *  ids are cs_<uuid>-unique). Returns the doc + workspace name. */
  async function findSession(wsName: string | undefined, session: string) {
    const candidates =
      wsName !== undefined
        ? [wsName]
        : conductor.deps.workspaces.map((w) => w.name);
    for (const name of candidates) {
      const doc = await store.getDoc({
        workspace: name,
        subject: editSessionSubject(session),
        doc: 'notes.md',
      });
      if (doc) return { workspace: name, doc };
    }
    return null;
  }

  app.post('/api/v1/interview', async (req, reply) => {
    const body = parseBody(InterviewBodySchema, req.body, 'interview');
    const ws = workspace(body.workspace);
    const subjectRef = body.subject_ref ?? body.ticket_ref;

    if (subjectRef !== undefined) {
      // ---- chat-to-edit mode: interview run diffs an existing doc ----
      if (!body.message) {
        throw badRequest('interview edit: {message} is required');
      }
      const slash = subjectRef.indexOf('/');
      const refWs = slash === -1 ? ws.name : subjectRef.slice(0, slash);
      const refId = slash === -1 ? subjectRef : subjectRef.slice(slash + 1);
      if (refWs !== ws.name) {
        throw badRequest(
          `interview edit: ref '${subjectRef}' is in workspace '${refWs}', ` +
            `not '${ws.name}'`,
        );
      }
      // subject_ref generalizes to features (D27/API.md; PRD §15.7
      // wp-152): an `F-*` subject edits feature docs via the same
      // session machinery — the feature-scoped assistant answers
      // from the feature's own doc evidence only.
      const featureRef = await store.getFeature(refWs, refId);
      let ticketIdForRun: string | undefined;
      if (featureRef === null) {
        const ticket = await getTicketOr404(refWs, refId);
        ticketIdForRun = ticket.ticket_id;
      }
      const doc = docKindFor(
        body.target ?? (featureRef !== null ? 'feature' : 'ticket'),
      );
      const editable =
        featureRef !== null ? EDITABLE_FEATURE_DOCS : EDITABLE_TICKET_DOCS;
      const targets =
        featureRef !== null ? 'feature|ac|test|notes' : 'ticket|rs|tdd|vs';
      if (doc === null || !editable.has(doc)) {
        throw badRequest(
          `interview edit: target must be one of ${targets} (got '${body.target ?? 'ticket'}')`,
        );
      }
      const session =
        body.session_id ??
        `cs_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      if (!SESSION_ID_RE.test(session)) {
        throw badRequest(`interview edit: malformed session_id '${session}'`);
      }
      const existing = await store.getDoc({
        workspace: ws.name,
        subject: editSessionSubject(session),
        doc: 'notes.md',
      });
      let transcript = '';
      if (existing) {
        const header = parseSessionDoc(existing.content)[0];
        if (header?.kind !== 'session' || header.subject !== refId) {
          throw badRequest(
            `session '${session}' is bound to a different subject`,
          );
        }
        transcript = existing.content;
      } else if (body.session_id !== undefined) {
        throw notFound(`unknown edit session '${session}'`);
      }
      const target = await store.getDoc({
        workspace: ws.name,
        subject: refId,
        doc,
      });
      if (!target) {
        throw notFound(`no ${doc} on ${ws.name}/${refId} to edit`);
      }
      if (!existing) {
        await appendSessionLine(ws.name, session, null, {
          ts: now(),
          kind: 'session',
          subject: refId,
          target: doc,
        });
      }
      // The turn lands durably before the run queues (same rule as the
      // seed text — the pending row is never the only copy).
      const run = await requestRun(ws.name, {
        subject: editSessionSubject(session),
        stage: 'interview',
        ...(ticketIdForRun ? { ticketId: ticketIdForRun } : {}),
        tokens: {
          EDIT_SESSION: session,
          EDIT_TARGET: doc,
          EDIT_MESSAGE: body.message,
          TARGET_DOC: target.content,
          SESSION_LOG: transcript,
        },
      });
      await appendSessionLine(ws.name, session, existing?.content ?? null, {
        ts: now(),
        kind: 'turn',
        message: body.message,
        run,
      });
      return reply
        .status(202)
        .send({ session, run, subject: refId, target: doc });
    }

    // ---- new-ticket interview mode ----
    if (!body.text) {
      throw badRequest('interview: {text} is required');
    }
    const slug = `interview-${Date.now()}`;
    const subject = `interview:${slug}`;
    // D29: the seed lands durably as a notes.md doc_version on the
    // interview subject before the run queues (the pending row is never
    // the only copy), and rides the run's SEED_TEXT prompt token.
    await store.appendDocVersion(
      { workspace: ws.name, subject, doc: 'notes.md' },
      `${body.text}\n`,
      actor,
    );
    const run = await requestRun(ws.name, {
      subject,
      stage: 'interview',
      tokens: { SEED_TEXT: body.text },
    });
    return reply.status(202).send({ subject, run });
  });

  /**
   * Session state for the chat-to-edit composer: transcript turns, the
   * pending proposal (run + diff), and a derived status — 'running'
   * while a live run fences the session, then the open gate's kind
   * (approval → proposal, question → clarify, failure → refused),
   * terminal 'applied'/'discarded' from the transcript tail.
   */
  app.get('/api/v1/interview/:session', async (req) => {
    const { session } = req.params as { session: string };
    const { workspace: wsName } = req.query as { workspace?: string };
    const found = await findSession(wsName, session);
    if (!found) throw notFound(`unknown edit session '${session}'`);
    const lines = parseSessionDoc(found.doc.content);
    const header = lines[0];
    if (header?.kind !== 'session' || !header.subject) {
      throw new ApiError(
        500,
        'internal',
        `edit session '${session}': corrupt transcript`,
      );
    }
    const subject = header.subject;
    const last = lines.at(-1);
    const gate = await store.getGateItem({
      workspace: found.workspace,
      subject,
      gate: `edit:${session}`,
    });
    const runs = (
      await store.listRuns({
        workspace: found.workspace,
        subject: editSessionSubject(session),
      })
    ).sort((a, b) => b.id.localeCompare(a.id));
    const live = runs.find((r) =>
      ['pending', 'leased', 'running', 'paused', 'exited'].includes(r.status),
    );
    let status: string;
    if (last?.kind === 'applied') status = 'applied';
    else if (last?.kind === 'discarded') status = 'discarded';
    else if (gate && !gate.cleared_at) {
      status =
        gate.kind === 'approval'
          ? 'proposal'
          : gate.kind === 'question'
            ? 'clarify'
            : 'refused';
    } else {
      status = live ? 'running' : 'queued';
    }
    let proposal: { run: string; diff: string } | null = null;
    if (status === 'proposal' && live === undefined) {
      for (const r of runs) {
        const a = await store.getArtifact(r.id, 'proposed-diff.md');
        if (a) {
          proposal = { run: r.id, diff: a.content };
          break;
        }
      }
    }
    const gatePayload =
      gate && !gate.cleared_at
        ? { kind: gate.kind, surfaced_at: gate.surfaced_at }
        : null;
    return {
      session,
      workspace: found.workspace,
      subject,
      target: header.target ?? 'ticket.md',
      status,
      turns: lines.filter((l) => l.kind !== 'session'),
      proposal,
      gate: gatePayload,
    };
  });

  /**
   * Apply the pending proposal: strict unified-diff apply against the
   * CURRENT doc version (drift → 409, re-request the edit), then a new
   * doc_version + doc_edited ledger event + gate clear. Stale approve
   * (cleared gate) → 409, never a double-commit.
   */
  app.post('/api/v1/interview/:session/approve', async (req) => {
    const { session } = req.params as { session: string };
    const body = req.body as { expected_status?: string } | null;
    const found = await findSession(undefined, session);
    if (!found) throw notFound(`unknown edit session '${session}'`);
    const lines = parseSessionDoc(found.doc.content);
    const header = lines[0];
    if (header?.kind !== 'session' || !header.subject) {
      throw new ApiError(
        500,
        'internal',
        `edit session '${session}': corrupt transcript`,
      );
    }
    const wsName = found.workspace;
    const subject = header.subject;
    const target = header.target ?? 'ticket.md';
    if (lines.at(-1)?.kind === 'applied') {
      throw conflict(`edit session '${session}' already applied`);
    }
    if (lines.at(-1)?.kind === 'discarded') {
      throw conflict(`edit session '${session}' already discarded`);
    }
    const ws = workspace(wsName);
    // The subject may be a feature (F-*) or a ticket — the POST
    // /interview route admits both (D27 subject_ref generalization),
    // so approve must resolve the same way or feature proposals 404
    // here forever.
    const featureRow = await store.getFeature(wsName, subject);
    const subjectStatus = featureRow
      ? featureRow.status
      : (await getTicketOr404(wsName, subject)).status;
    if (
      body?.expected_status !== undefined &&
      subjectStatus !== body.expected_status
    ) {
      throw conflict(
        `stale write: expected status '${body.expected_status}', ` +
          `${featureRow ? 'feature' : 'ticket'} is '${subjectStatus}'`,
      );
    }
    const gate = `edit:${session}`;
    const item = await store.getGateItem({ workspace: wsName, subject, gate });
    if (!item) throw notFound(`no open proposal for session '${session}'`);
    if (item.cleared_at) {
      throw conflict('stale write: proposal gate already cleared');
    }
    // Newest completed session run's proposed-diff.md is THE proposal.
    const runs = (
      await store.listRuns({
        workspace: wsName,
        subject: editSessionSubject(session),
      })
    ).sort((a, b) => b.id.localeCompare(a.id));
    let art: { runId: string; content: string } | null = null;
    for (const r of runs) {
      const a = await store.getArtifact(r.id, 'proposed-diff.md');
      if (a) {
        art = { runId: r.id, content: a.content };
        break;
      }
    }
    if (!art) {
      throw conflict(`session '${session}' has no proposed diff to apply`);
    }
    let diff: string;
    let parsed: ReturnType<typeof parseUnifiedDiff>;
    try {
      diff = extractUnifiedDiff(art.content);
      parsed = parseUnifiedDiff(diff);
    } catch (e) {
      if (e instanceof DiffApplyError) {
        throw badRequest(`proposal artifact is malformed: ${e.message}`);
      }
      throw e;
    }
    const diffFile = parsed.to.split('/').at(-1);
    if (diffFile !== target) {
      throw badRequest(
        `proposal targets '${diffFile}', session target is '${target}'`,
      );
    }
    const current = await store.getDoc({
      workspace: wsName,
      subject,
      doc: target,
    });
    if (!current) throw notFound(`no ${target} on ${wsName}/${subject}`);
    let next: string;
    try {
      next = applyUnifiedDiff(current.content, diff);
    } catch (e) {
      if (e instanceof DiffApplyError) {
        // The doc moved since the proposal — not malformed, just stale.
        throw conflict(`proposal no longer applies: ${e.message}`);
      }
      throw e;
    }
    const dv = await store.appendDocVersion(
      { workspace: wsName, subject, doc: target },
      next,
      actor,
    );
    await emitEvent(ws, {
      // events.ticket_id doubles as the subject column for feature
      // rows (acceptFeature does the same); `subject_kind` keeps the
      // attribution unambiguous for consumers.
      ticketId: subject,
      event: 'doc_edited',
      run: art.runId,
      refs: [`doc:${subject}:${target}`],
      data: {
        session,
        subject_kind: featureRow ? 'feature' : 'ticket',
        doc: target,
        version: dv.version,
        via: 'chat-to-edit',
      },
    });
    await clearGate({ ws, subject, gate });
    await appendSessionLine(wsName, session, found.doc.content, {
      ts: now(),
      kind: 'applied',
      doc: target,
      version: dv.version,
    });
    return { applied: true, session, doc: target, version: dv.version };
  });

  /** Discard/abandon a session — clears the open proposal gate if any
   *  and seals the transcript (idempotent-ish: terminal → 409). */
  app.delete('/api/v1/interview/:session', async (req) => {
    const { session } = req.params as { session: string };
    const found = await findSession(undefined, session);
    if (!found) throw notFound(`unknown edit session '${session}'`);
    const lines = parseSessionDoc(found.doc.content);
    const header = lines[0];
    const subject = header?.subject ?? '';
    if (
      lines.at(-1)?.kind === 'applied' ||
      lines.at(-1)?.kind === 'discarded'
    ) {
      throw conflict(`edit session '${session}' is already closed`);
    }
    const ws = workspace(found.workspace);
    const item = await store.getGateItem({
      workspace: found.workspace,
      subject,
      gate: `edit:${session}`,
    });
    if (item && !item.cleared_at) {
      await clearGate({ ws, subject, gate: `edit:${session}` });
    }
    await emitEvent(ws, {
      ticketId: subject,
      event: 'note_added',
      data: {
        session,
        kind: 'edit-discarded',
        subject_kind: (await store.getFeature(ws.name, subject))
          ? 'feature'
          : 'ticket',
      },
    });
    await appendSessionLine(found.workspace, session, found.doc.content, {
      ts: now(),
      kind: 'discarded',
    });
    return { discarded: true, session };
  });

  app.post('/api/v1/import', async (req, reply) => {
    const body = parseBody(ImportBodySchema, req.body, 'import');
    const ws = workspace(body.workspace);
    if (body.source !== 'github') {
      throw notImplemented(`import source '${body.source}' is not implemented`);
    }
    if (!body.commit) {
      // Preview rows (S-03 confirm step).
      if (!body.repo) throw badRequest('import preview: {repo} is required');
      const fetched = await fetchIssues({
        repo: body.repo,
        ...(body.milestone ? { milestone: body.milestone } : {}),
        ...(body.labels ? { labels: body.labels } : {}),
        ...(config.importers.github?.token_env
          ? { tokenEnv: config.importers.github.token_env }
          : {}),
        env: config.secrets,
      });
      if (!fetched.ok) {
        throw new ApiError(
          502,
          'import_fetch_failed',
          `${fetched.error.reason}: ${fetched.error.detail}`,
        );
      }
      return {
        rows: preview(fetched.issues, config.importers.default_repo_map),
      };
    }
    // Commit → queue the `import:<source>` subject run as a RUNNER
    // TASK (CONDUCTOR "Runner tasks") — the conductor fetches +
    // materializes rows itself; no agent is spawned. The fetch spec
    // rides runs.request.task so the pending row is self-contained.
    if (!body.repo) throw badRequest('import commit: {repo} is required');
    const run = await requestRun(ws.name, {
      subject: `import:${body.source}`,
      stage: 'import',
      task: {
        kind: 'import',
        repo: body.repo,
        ...(body.milestone ? { milestone: body.milestone } : {}),
        ...(body.labels ? { labels: body.labels } : {}),
      },
    });
    return reply.status(202).send({ run, subject: `import:${body.source}` });
  });

  // ------------------------------------------------------------------
  // /import/reconcile — wp-139 import reconciliation surface
  // ------------------------------------------------------------------

  /** The import board + its reviewable items (ticket cards + findings). */
  app.get('/api/v1/import/board', async (req) => {
    const { workspace: wsName, board } = req.query as {
      workspace?: string;
      board?: string;
    };
    const slug = board ?? DEFAULT_IMPORT_BOARD;
    if (!wsName) {
      // Every import board across workspaces (org-level inbox view).
      const projects = await store.listProjects();
      const boards: Awaited<ReturnType<typeof store.listBoards>> = [];
      for (const p of projects) {
        for (const b of await store.listBoards(p.workspace)) {
          if (b.board_type === 'import') boards.push(b);
        }
      }
      return { boards };
    }
    const row = await store.getBoard(wsName, slug);
    const items = await store.listBoardItems({
      workspace: wsName,
      board: slug,
    });
    return { board: row, items };
  });

  /** (Re)run reconciliation: cluster imported items, detect drift vs the
   *  source of record, surface findings, set the reconciled flag. */
  app.post('/api/v1/import/reconcile', async (req) => {
    const body = parseBody(ReconcileBodySchema, req.body, 'reconcile');
    const ws = workspace(body.workspace);
    const result = await reconcileImport({
      workspace: ws.name,
      store,
      actor,
      ...(body.board ? { board: body.board } : {}),
      ...(body.ticketIds ? { ticketIds: body.ticketIds } : {}),
    });
    return { result };
  });

  /** Resolve a finding. `inferred` findings require a human (provenance
   *  enforcement — inferred never auto-approves). */
  app.post('/api/v1/import/findings/:findingId/resolve', async (req) => {
    const params = req.params as { findingId: string };
    const body = parseBody(
      ResolveFindingBodySchema,
      req.body,
      'resolve-finding',
    );
    if (
      !(RECONCILIATION_DECISIONS as readonly string[]).includes(body.decision)
    ) {
      throw badRequest(
        `unknown decision '${body.decision}' (expected ${RECONCILIATION_DECISIONS.join('|')})`,
      );
    }
    if (body.decision === 'open') {
      throw badRequest(
        'resolve-finding: decision must be a resolution, not `open`',
      );
    }
    const ws = workspace(body.workspace);
    try {
      const out = await resolveReconciliationFinding({
        workspace: ws.name,
        store,
        findingId: params.findingId,
        decision: body.decision,
        actor: body.actor ?? actor,
        human: true,
      });
      return out;
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  });

  /** Convert the import board to an ordinary board (history preserved). */
  app.post('/api/v1/import/convert', async (req) => {
    const body = parseBody(ConvertBoardBodySchema, req.body, 'convert');
    const ws = workspace(body.workspace);
    const out = await convertImportBoard({
      workspace: ws.name,
      store,
      actor,
      ...(body.board ? { board: body.board } : {}),
      ...(body.to ? { to: body.to } : {}),
    });
    return out;
  });

  // ------------------------------------------------------------------
  // /capture — D27 tray ingress (API.md): board:null board_items
  // ------------------------------------------------------------------

  app.post('/api/v1/capture', async (req, reply) => {
    const body = parseBody(CaptureBodySchema, req.body, 'capture');
    const ws = workspace(body.workspace);
    const kind = body.kind ?? 'idea';
    if (!(BOARD_ITEM_KINDS as readonly string[]).includes(kind)) {
      throw badRequest(
        `unknown kind '${kind}' (expected ${BOARD_ITEM_KINDS.join('|')})`,
      );
    }
    const ts = now();
    const item: BoardItem = {
      id: randomUUID(),
      workspace: ws.name,
      board: null, // capture tray (D27)
      kind: kind as BoardItem['kind'],
      ref: null,
      title: body.title,
      body: body.body ?? null,
      x: null,
      y: null,
      w: null,
      h: null,
      zone: null,
      /** D33: goal board_item ids this item serves — the canonical edge
       *  (the event carries it too, but the row is the truth). */
      serves:
        body.serves === undefined
          ? null
          : Array.isArray(body.serves)
            ? body.serves
            : [body.serves],
      status: 'icebox',
      consumed_by: null,
      created_at: ts,
      updated_at: ts,
    };
    await store.upsertBoardItem(item);
    await emitEvent(ws, {
      event: 'item_captured',
      data: {
        item_id: item.id,
        kind: item.kind,
        title: item.title,
        ...(body.serves !== undefined ? { serves: body.serves } : {}),
      },
    });
    // Board-item live hint (D52 — StreamEvent has no board_item type;
    // `notification` frames carry `{kind:'board_item_updated'}`).
    hub.notify({
      type: 'notification',
      payload: {
        kind: 'board_item_updated',
        workspace: ws.name,
        item_id: item.id,
        board: null,
      },
    });
    return reply.status(201).send({ item });
  });

  // ------------------------------------------------------------------
  // /settings — S-02 (secrets are write-only — never read back)
  // ------------------------------------------------------------------

  app.get('/api/v1/settings', async () => {
    const { secrets: _secrets, ...rest } = config;
    return { config: rest };
  });

  app.put('/api/v1/settings', async (req) => {
    const body = req.body as {
      config?: Record<string, unknown>;
      secrets?: Record<string, string>;
    } | null;
    const warnings: string[] = [];

    if (body?.config && Object.keys(body.config).length > 0) {
      // Persist through the config package's write path: comment-
      // preserving YAML merge + fail-closed validation before write.
      const merged = mergeConfigFile(
        globalConfigPath,
        body.config as Record<string, unknown>,
      );
      Object.assign(config, merged);
      const ui = (body.config as Record<string, unknown>).ui as
        | Record<string, unknown>
        | undefined;
      if (ui?.remote_access === true) {
        warnings.push(
          'ui.remote_access is true — the UI binds beyond loopback; ' +
            'the token is still required on every request (SETTINGS.md).',
        );
      }
    }

    if (body?.secrets && Object.keys(body.secrets).length > 0) {
      // Write-only secrets: merged into the global .env, never read back
      // out through the API (SETTINGS.md secrets section). Values are
      // written as raw `K=V` lines — validate so a crafted value can't
      // inject extra lines/vars into the file.
      for (const [k, v] of Object.entries(body.secrets)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
          throw badRequest(
            `secret key '${k}' is not a valid env name (expected [A-Z_][A-Z0-9_]*)`,
          );
        }
        if (typeof v !== 'string' || /[\r\n]/.test(v)) {
          throw badRequest(`secret '${k}' must be a single-line value`);
        }
      }
      const envPath = join(dirname(globalConfigPath), '.env');
      const current = existsSync(envPath)
        ? parseEnv(await readFile(envPath, 'utf8'))
        : {};
      Object.assign(current, body.secrets);
      const envValue = (v: string) =>
        // Quote anything an unquoted line would mangle — a ` #` tail is
        // a comment, and quotes/backslashes need escaping to round-trip
        // through parseEnv.
        /[\s#"'\\]/.test(v)
          ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
          : v;
      const text = `${Object.entries(current)
        .map(([k, v]) => `${k}=${envValue(v)}`)
        .join('\n')}\n`;
      await mkdir(dirname(envPath), { recursive: true });
      await writeFile(envPath, text, { mode: 0o600 });
      Object.assign(config.secrets, body.secrets);
    }

    return { ok: true, warnings };
  });

  // ------------------------------------------------------------------
  // /kb — S-14 dossiers
  // ------------------------------------------------------------------

  app.get('/api/v1/kb/:scope', async (req) => {
    const { scope } = req.params as { scope: string };
    const { name } = req.query as { name?: string };
    if (name) {
      return { sections: await store.getDossier(scope, name) };
    }
    return { dossiers: await store.listDossiers({ scope }) };
  });

  app.put('/api/v1/kb/:scope', async (req) => {
    const { scope } = req.params as { scope: string };
    const body = req.body as {
      name?: string;
      section?: string;
      content?: string;
      workspace?: string;
    } | null;
    if (!body?.name || !body.section || body.content === undefined) {
      throw badRequest('kb: {name, section, content} are required');
    }
    const prior = await store.getDossierSection(scope, body.name, body.section);
    const ts = now();
    const entry = {
      scope: scope as never,
      name: body.name,
      section: body.section as never,
      version: (prior?.version ?? 0) + 1,
      content: body.content,
      surveyed_at: prior?.surveyed_at ?? ts,
      sources_used: prior?.sources_used ?? [],
      stale: false,
      edited_by: actor,
      edited_at: ts,
    };
    await store.upsertDossierSection(entry);
    // Human edits land in the ledger (dossier_edited, SCHEMAS §7) when
    // a workspace context exists to attribute them to.
    const wsName = body.workspace ?? conductor.deps.workspaces[0]?.name;
    if (wsName && conductor.deps.workspaces.some((w) => w.name === wsName)) {
      await emitEvent(workspace(wsName), {
        event: 'dossier_edited',
        data: { scope, name: body.name, section: body.section },
      });
    }
    return { entry };
  });

  app.post('/api/v1/kb/:scope/sync', async (req, reply) => {
    const { scope } = req.params as { scope: string };
    const body = req.body as { name?: string; workspace?: string } | null;
    if (!body?.name) throw badRequest('kb sync: {name} is required');
    const wsName = body.workspace ?? conductor.deps.workspaces[0]?.name;
    if (!wsName) throw badRequest('no workspace registered');
    const subject = `survey:${scope}:${body.name}`;
    const run = await requestRun(wsName, { subject, stage: 'survey' });
    return reply.status(202).send({ run, subject });
  });

  // ------------------------------------------------------------------
  // /metrics — S-12 aggregates from events_idx/usage_calls
  // ------------------------------------------------------------------

  app.get('/api/v1/metrics', async (req) => {
    const q = req.query as { workspace?: string; since?: string };
    const since =
      q.since && !Number.isNaN(Date.parse(q.since)) ? q.since : null;
    const workspaces = q.workspace
      ? [q.workspace]
      : conductor.deps.workspaces.map((w) => w.name);
    const ticketsByStatus: Record<string, number> = {};
    const runsByStatus: Record<string, number> = {};
    const eventsByName: Record<string, number> = {};
    let openGateItems = 0;
    let acceptedOutcomes = 0;
    const totals = {
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_cached: 0,
      human_minutes: 0,
    };
    const deviations = {
      merged_tickets: 0,
      tickets_with_deviations: 0,
      deviations_total: 0,
    };
    const dwell = { cleared_minutes: 0, open_minutes: 0 };
    const nowIso = now();
    for (const ws of workspaces) {
      for (const t of await store.listTickets({ workspace: ws })) {
        ticketsByStatus[t.status] = (ticketsByStatus[t.status] ?? 0) + 1;
      }
      const gateItems = await store.listGateItems({ workspace: ws });
      // Badge semantics: snoozed items are open but not demanding.
      openGateItems += gateItems.filter(
        (i) => !i.cleared_at && !isSnoozed(i, nowIso),
      ).length;
      // human_minutes = gate dwell (PRD): surfaced → cleared, plus
      // still-open items accruing to now. The stale path summed a
      // human_minutes field off events that was never populated.
      const dwellW = gateDwell(gateItems, { since });
      dwell.cleared_minutes += dwellW.cleared_minutes;
      dwell.open_minutes += dwellW.open_minutes;
      const devW = await deviationMetrics(store, ws, since);
      deviations.merged_tickets += devW.merged_tickets;
      deviations.tickets_with_deviations += devW.tickets_with_deviations;
      deviations.deviations_total += devW.deviations_total;
      const runs = await store.listRuns({ workspace: ws });
      for (const r of runs) {
        runsByStatus[r.status] = (runsByStatus[r.status] ?? 0) + 1;
      }
      for (const e of await store.listEvents({ workspace: ws })) {
        eventsByName[e.event] = (eventsByName[e.event] ?? 0) + 1;
        totals.cost_usd += e.cost_usd ?? 0;
        totals.tokens_in += e.tokens_in ?? 0;
        totals.tokens_out += e.tokens_out ?? 0;
        totals.tokens_cached += e.tokens_cached ?? 0;
      }
      // usage_calls is the per-call ledger — per-call latency totals
      // live there; token sums ride events (no double count).
      for (const r of runs) {
        const calls = await store.listUsageCalls(r.id);
        if (calls.length > 0) {
          eventsByName.usage_calls =
            (eventsByName.usage_calls ?? 0) + calls.length;
        }
      }
      // wp-155 (PRD §15.12): cost per VERIFIED ACCEPTED OUTCOME —
      // inference + retries + execution + remediation over outcomes
      // that reached a delivered terminal state, never per-call price.
      for (const t of await store.listTickets({ workspace: ws })) {
        if (t.status === 'merged' || t.status === 'released') {
          acceptedOutcomes += 1;
        }
      }
    }
    totals.human_minutes = dwell.cleared_minutes + dwell.open_minutes;
    const merged = deviations.merged_tickets;
    const costPerAcceptedOutcome =
      acceptedOutcomes > 0
        ? Number((totals.cost_usd / acceptedOutcomes).toFixed(6))
        : null;
    return {
      workspaces,
      tickets_by_status: ticketsByStatus,
      runs_by_status: runsByStatus,
      events_by_name: eventsByName,
      open_gate_items: openGateItems,
      totals,
      // PRD headline: merged tickets with ≥1 deviation ÷ merged tickets.
      deviations: {
        ...deviations,
        deviation_rate:
          merged > 0 ? deviations.tickets_with_deviations / merged : 0,
        addenda_per_ticket:
          merged > 0 ? deviations.deviations_total / merged : 0,
      },
      // Dwell detail so the honest-idle caveat is inspectable, not
      // folded away into one number.
      gate_dwell: {
        ...dwell,
        total_minutes: dwell.cleared_minutes + dwell.open_minutes,
      },
      since,
      accepted_outcomes: acceptedOutcomes,
      cost_per_accepted_outcome: costPerAcceptedOutcome,
    };
  });

  // ------------------------------------------------------------------
  // /gate-items claim/release — shared-queue claiming (API.md)
  // ------------------------------------------------------------------

  app.post(
    '/api/v1/gate-items/:workspace/:subject/:gate/claim',
    async (req, reply) => {
      const {
        workspace: wsName,
        subject,
        gate,
      } = req.params as {
        workspace: string;
        subject: string;
        gate: string;
      };
      const body = parseBody(ClaimBodySchema, req.body, 'claim');
      const ws = workspace(wsName);
      const item = await store.getGateItem({
        workspace: ws.name,
        subject,
        gate,
      });
      if (!item || item.cleared_at) {
        throw notFound(`no open gate item '${gate}' for ${ws.name}/${subject}`);
      }
      const claimActor = body.actor ?? actor;
      const claim = await store.acquireClaim(
        { workspace: ws.name, subject, gate },
        claimActor,
        body.ttl_s ?? 900,
      );
      if (!claim) {
        const held = await store.getClaim({
          workspace: ws.name,
          subject,
          gate,
        });
        throw conflict(
          `gate item already claimed by ${held?.claimed_by ?? 'another actor'}`,
        );
      }
      await emitEvent(ws, {
        ticketId: subject,
        event: 'claimed',
        data: { gate, actor: claimActor },
      });
      return reply.status(201).send({ claim });
    },
  );

  app.delete(
    '/api/v1/gate-items/:workspace/:subject/:gate/claim',
    async (req) => {
      const {
        workspace: wsName,
        subject,
        gate,
      } = req.params as {
        workspace: string;
        subject: string;
        gate: string;
      };
      const ws = workspace(wsName);
      const claim = await store.getClaim({
        workspace: ws.name,
        subject,
        gate,
      });
      if (!claim) throw notFound('no claim held on this gate item');
      await store.releaseClaim(
        { workspace: ws.name, subject, gate },
        claim.claimed_by,
      );
      await emitEvent(ws, {
        ticketId: subject,
        event: 'unclaimed',
        data: { gate, actor: claim.claimed_by },
      });
      return { released: true };
    },
  );

  // ------------------------------------------------------------------
  // gate_items.snoozed_until — D20: hide from inbox/badge until then
  // ------------------------------------------------------------------

  app.post(
    '/api/v1/gate-items/:workspace/:subject/:gate/snooze',
    async (req) => {
      const {
        workspace: wsName,
        subject,
        gate,
      } = req.params as {
        workspace: string;
        subject: string;
        gate: string;
      };
      const body = parseBody(SnoozeBodySchema, req.body, 'snooze');
      const until =
        body.until ??
        new Date(Date.now() + (body.for_minutes ?? 0) * 60_000).toISOString();
      const untilMs = Date.parse(until);
      if (!Number.isFinite(untilMs)) {
        throw badRequest('snooze: {until} must be an ISO timestamp');
      }
      if (untilMs <= Date.now()) {
        throw badRequest('snooze: {until} must be in the future');
      }
      const ws = workspace(wsName);
      const item = await store.getGateItem({
        workspace: ws.name,
        subject,
        gate,
      });
      if (!item || item.cleared_at) {
        throw notFound(`no open gate item '${gate}' for ${ws.name}/${subject}`);
      }
      // upsertGateItem rewrites the row — spread the current item so
      // priority/blocked_agent/kind survive the snooze. No event row:
      // EVENT_NAMES is a closed union (core) and the durable state is
      // the snoozed_until field itself, read back through /inbox.
      await store.upsertGateItem({
        ...item,
        snoozed_until: new Date(untilMs).toISOString(),
      });
      return {
        item: await store.getGateItem({ workspace: ws.name, subject, gate }),
      };
    },
  );

  app.delete(
    '/api/v1/gate-items/:workspace/:subject/:gate/snooze',
    async (req) => {
      const {
        workspace: wsName,
        subject,
        gate,
      } = req.params as {
        workspace: string;
        subject: string;
        gate: string;
      };
      const ws = workspace(wsName);
      const item = await store.getGateItem({
        workspace: ws.name,
        subject,
        gate,
      });
      if (!item || item.cleared_at) {
        throw notFound(`no open gate item '${gate}' for ${ws.name}/${subject}`);
      }
      if (item.snoozed_until === null || item.snoozed_until === undefined) {
        throw notFound(`gate item '${gate}' is not snoozed`);
      }
      await store.upsertGateItem({ ...item, snoozed_until: null });
      return {
        item: await store.getGateItem({ workspace: ws.name, subject, gate }),
      };
    },
  );

  // /reviews — Review Studio surface (PRD §15.8, wp-148)
  // ------------------------------------------------------------------
  registerReviewRoutes(app, {
    store,
    actor,
    nowIso: now,
    workspace,
    clearGate,
    requestRun,
    ticketOrNull: async (wsName, ticketId) =>
      store.getTicket({ workspace: wsName, ticket_id: ticketId }),
  });

  // ------------------------------------------------------------------
  // /board, /boards — pipeline board + idea boards (PRD §15.3, wp-144)
  // ------------------------------------------------------------------
  registerBoardRoutes(app, {
    store,
    actor,
    nowIso: now,
    workspace,
    notify: (e) => hub.notify(e as StreamEvent),
  });

  // /interview-sessions, /statements, /statement-decisions, /tray,
  // /board-items — the Discovery UI surface (PRD §15.3/§15.9, wp-147):
  // Interview Orchestrator sessions + the Understanding Panel payload,
  // statement decide/correct affordances, and the capture tray.
  registerDiscoveryRoutes(app, {
    store,
    actor,
    nowIso: now,
    workspace,
    notify: (e) => hub.notify(e),
  });

  // ------------------------------------------------------------------
  // Board Assistant — `…/assistant*` + `…/proposals` (BOARD-CHAT-TDD,
  // wp-164). Gated on `ui.board_chat` — flag-off boards expose no
  // assistant surface at all. The provider resolves once here:
  // registry kind `assistant` → OpenRouter; missing key/model → the
  // deterministic engine still serves every route (PRD R10).
  // ------------------------------------------------------------------
  if (config.ui.board_chat) {
    const { provider, model } = resolveAssistantProvider({
      config,
      ...(opts.assistantFetch ? { fetchImpl: opts.assistantFetch } : {}),
    });
    registerBoardAssistantRoutes(app, {
      store,
      actor,
      provider,
      model,
      workspace,
      notify: (e) => hub.notify(e as StreamEvent),
    });
  }

  // ------------------------------------------------------------------
  // /design — structured mockups + design approvals (PRD §15.4, wp-149)
  // ------------------------------------------------------------------
  registerDesignRoutes(app, {
    store,
    actor,
    nowIso: now,
    workspace,
  });

  // ------------------------------------------------------------------
  // /evidence, /repositories/<repo>/index — D37 evidence surface (wp-110)
  // ------------------------------------------------------------------
  registerEvidenceRoutes(app, {
    store,
    config,
    workspaceRoot: (name) =>
      conductor.deps.workspaces.find((w) => w.name === name)?.rootPath,
    repoPath: (_wsName, repo) => config.repos[repo]?.path,
    notify: (e) =>
      conductor.deps.notify?.({
        type: e.type as 'index_status',
        payload: e.payload,
      }),
    now,
  });

  // /features — Feature Workspace surface (PRD §15.7, wp-152): detail
  // rollup, versioned docs, health findings, acceptance package +
  // the explicit human acceptance gate.
  registerFeatureRoutes(app, {
    store,
    workspace,
    actor,
  });

  // /assumptions, /quality-debt, /commitments — §15.10 registers (wp-153)
  registerRegisterRoutes(app, {
    store,
    actor,
    now: () => new Date(),
    workspace,
  });

  // /links — wp-111 traceability edges (D37): propose/record +
  // idempotent evented human verify/reject (OCC → 409 stale writes).
  registerLinkRoutes(app, {
    store,
    config,
    actor,
    notify: (e) =>
      conductor.deps.notify?.({
        type: 'link_decided',
        payload: e.payload,
      }),
  });

  // /alignment, /feedback/clusters — wp-112 continuous alignment (D37
  // Phase B): durable alignment-findings.json, OCC human decisions,
  // release-readiness narrative (advisory — never overrides gates).
  registerAlignmentRoutes(app, {
    store,
    config,
    actor,
    workspaceRoot: (name) =>
      conductor.deps.workspaces.find((w) => w.name === name)?.rootPath,
    notify: (e) =>
      conductor.deps.notify?.({
        type: 'alignment_status',
        payload: e.payload,
      }),
  });

  // /telemetry/*, /incidents* — wp-120 telemetry + incident
  // intelligence (D37 Phase C): sanitized ingest → fingerprint/dedupe,
  // durable §19 investigations, OCC incident decisions, and the
  // human-gated draft-ticket proposals (never silent scope).
  registerTelemetryRoutes(app, {
    store,
    actor,
    notify: (e) =>
      conductor.deps.notify?.({
        type: 'incident_status',
        payload: e.payload,
      }),
  });

  // ------------------------------------------------------------------
  // /releases, /merge-center, /features…/exposure, /tickets…/corrections
  // — the Delivery API (DELIVERY §6, wp-136). Durable DELIVERY §5 event
  //  names mirror onto the SSE stream via the store wrapper inside.
  // ------------------------------------------------------------------
  registerReleaseRoutes(app, {
    store,
    actor,
    workspace,
    toolCtx,
    gh: conductor.deps.gh ?? new ShellGhClient(),
    requestRun: (wsName, req) =>
      requestRun(wsName, {
        subject: req.subject,
        stage: req.stage,
        ...(req.ticketId ? { ticketId: req.ticketId } : {}),
      }),
    notify: (e) => hub.notify(e),
  });

  // /repos/clone — connect a GitHub repo: clone into the managed
  // data dir + register `repos.<name>` (Settings → Code Repos).
  registerRepoRoutes(app, {
    config,
    ...(opts.reposDir ? { reposDir: opts.reposDir } : {}),
    ...(opts.gitClone ? { runGit: opts.gitClone } : {}),
    persist: (patch) => {
      const merged = mergeConfigFile(globalConfigPath, patch);
      Object.assign(config, merged);
    },
  });

  // /scope-radar — wp-142 Scope Creep Radar (PRD §15.5): computed
  // metrics + `scope-budget` escalation acknowledgment.
  registerRadarRoutes(app, {
    store,
    actor,
    nowIso: now,
    workspace: (name) => workspace(name),
    notify: (e) =>
      conductor.deps.notify?.({
        type: e.type as 'gate_cleared',
        payload: e.payload,
      }),
  });

  return app;
}

/** Convenience: build + bind on ui.bind:ui.port (API.md). */
export async function startServer(opts: ServerOptions): Promise<ApiServer> {
  const app = createServer(opts);
  const bind = opts.bind ?? opts.config.ui.bind;
  if (opts.config.ui.remote_access && isLoopbackBind(bind)) {
    app.log.warn(
      'ui.remote_access is true but ui.bind is loopback — set ui.bind ' +
        'to a wider address to expose the surface (SETTINGS.md).',
    );
  }
  await app.listen({ host: bind, port: opts.config.ui.port });
  return app;
}
