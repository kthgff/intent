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
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { ConductorDeps, StreamEvent } from '@sprint-runner/conductor';
import {
  type Conductor,
  type ConductorWorkspace,
  type RunnerTask,
  type ToolCtx,
  DEFAULT_IMPORT_BOARD,
  applyTicketStatus,
  convertImportBoard,
  fetchIssues,
  preview,
  queuePendingRun,
  reconcileImport,
  renderLogMd,
  resolveReconciliationFinding,
  upsertFrontmatterKeys,
} from '@sprint-runner/conductor';
import {
  deepMerge,
  defaultGlobalConfigPath,
  parseEnv,
  parsePartialConfig,
} from '@sprint-runner/config';
import type { EffectiveConfig } from '@sprint-runner/config';
import {
  BOARD_ITEM_KINDS,
  type BoardItem,
  DOC_KINDS,
  type DocKind,
  type EventName,
  type GateItem,
  RECONCILIATION_DECISIONS,
  type Store,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
} from '@sprint-runner/core';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import YAML from 'yaml';
import { z } from 'zod';
import { lineDiff } from './diff.js';
import { registerReviewRoutes } from './review.js';
import { StreamHub } from './sse.js';

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

const ClaimBodySchema = z
  .object({
    actor: z.string().optional(),
    ttl_s: z.number().int().positive().optional(),
  })
  .passthrough();

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
  /**
   * Built UI bundle (vite `dist/`, wp-099) — served static behind the
   * same token auth on every route; absent/missing → the placeholder
   * page stays. SPA fallback: extensionless GETs resolve to
   * `index.html`; real file misses under it 404.
   */
  uiDist?: string;
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

/** S-01 ranking: blocking-first → priority → age (API.md /inbox). */
function rankInbox(items: GateItem[]): GateItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.blocked_agent ?? false) - Number(a.blocked_agent ?? false) ||
      prank(a.priority) - prank(b.priority) ||
      a.surfaced_at.localeCompare(b.surfaced_at),
  );
}

/** Candidate gate names for a doc approval, in probe order. */
const DOC_GATES: Record<string, string[]> = {
  prd: ['plan-package', 'prd-review'],
  tdd: ['plan-package', 'tdd-review'],
  test: ['plan-package', 'test-review', 'test-approved'],
};

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

export function createServer(opts: ServerOptions): ApiServer {
  const { store, conductor, config } = opts;
  const bind = opts.bind ?? config.ui.bind;
  const globalConfigPath = opts.globalConfigPath ?? defaultGlobalConfigPath();
  const hub = new StreamHub();
  const actor = config.actor ?? 'sprint-runner';

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
    void reply.status(status).send({
      error: code,
      message: err.message,
      ...((err as ApiError).refs ? { refs: (err as ApiError).refs } : {}),
    });
  });

  // ------------------------------------------------------------------
  // Auth — bearer token or session cookie on EVERYTHING (API.md auth)
  // ------------------------------------------------------------------

  const sessionCookie = 'sr_session';

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
      // Loopback bootstrap: hand out the session cookie (API.md).
      void reply
        .header(
          'set-cookie',
          `${sessionCookie}=${opts.uiToken}; HttpOnly; SameSite=Strict; Path=/`,
        )
        .type('text/html')
        .send(
          '<html><body><h1>sprint-runner</h1><p>Session established.</p></body></html>',
        );
      return;
    }
    if (uiMounted && (await serveStaticFile(reply, 'index.html'))) {
      return;
    }
    void reply
      .type('text/html')
      .send(
        '<html><body><h1>sprint-runner</h1>' +
          '<p>UI bundle not built — run ' +
          '<code>pnpm -F @sprint-runner/ui build</code>.</p></body></html>',
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
    const { workspace: wsName } = req.query as { workspace?: string };
    const items = rankInbox(
      await store.listGateItems(
        wsName ? { workspace: wsName, open: true } : { open: true },
      ),
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
  // /tickets — S-01/S-05
  // ------------------------------------------------------------------

  app.get('/api/v1/tickets', async (req) => {
    const q = req.query as {
      workspace?: string;
      status?: string;
      repo?: string;
    };
    let tickets = await store.listTickets({
      ...(q.workspace ? { workspace: q.workspace } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
    if (q.repo)
      tickets = tickets.filter((t) => t.repos.includes(q.repo as string));
    return { tickets };
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
    return {
      ticket: row,
      ticket_md: ticketMd,
      triage: triageRaw ? JSON.parse(triageRaw) : null,
      repos,
      docs,
      open_gates: gates.filter((g) => g.subject === ticket),
      family: [...family, ...children],
    };
  });

  /**
   * Doc name → DOC_KINDS doc. Routes accept either the bare name
   * (`rs`) or the full doc kind (`rs.md`). `split-plan` is the one
   * exception: it's a run_artifact (RUN_ARTIFACT_KINDS), served from
   * the latest producing run.
   */
  function docKindFor(name: string): DocKind | null {
    if ((DOC_KINDS as readonly string[]).includes(name)) return name as DocKind;
    const md = `${name}.md`;
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
    const doc = JSON.parse(art.content) as {
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
    prd: 'prd',
    tdd: 'design',
    test: 'testplan',
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
      const stage = DOC_STAGE[name];
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
      const candidates = DOC_GATES[name];
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
        data: { doc: name, gate },
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
      const review = JSON.parse(art.content) as {
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
        return { action, status: 'wont-do' };
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
    const workspaces = await Promise.all(
      conductor.deps.workspaces.map(async (ws) => ({
        name: ws.name,
        root_path: ws.rootPath,
        queue_depth: pending.filter((r) => r.workspace === ws.name).length,
        open_gate_items: (
          await store.listGateItems({ workspace: ws.name, open: true })
        ).length,
      })),
    );
    return { workspaces };
  });

  app.post('/api/v1/workspaces', async (req, reply) => {
    const body = parseBody(WorkspaceBodySchema, req.body, 'workspaces');
    if (conductor.deps.workspaces.some((w) => w.name === body.name)) {
      throw conflict(`workspace '${body.name}' already exists`);
    }
    // D29: a workspace is a plain root dir (run dirs, repo anchoring,
    // .veto/ scratch) — no tickets repo to clone, no tickets_repos
    // config key. The project row is the DB registration.
    const rootPath =
      body.path ??
      join(
        homedir(),
        '.local',
        'share',
        'sprint-runner',
        'workspaces',
        body.name,
      );
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

  app.post('/api/v1/interview', async (req, reply) => {
    const body = parseBody(InterviewBodySchema, req.body, 'interview');
    if (!body.text) {
      throw badRequest('interview: {text} is required');
    }
    const ws = workspace(body.workspace);
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
    const items = await store.listBoardItems({ workspace: wsName, board: slug });
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
    if (!(RECONCILIATION_DECISIONS as readonly string[]).includes(body.decision)) {
      throw badRequest(
        `unknown decision '${body.decision}' (expected ${RECONCILIATION_DECISIONS.join('|')})`,
      );
    }
    if (body.decision === 'open') {
      throw badRequest('resolve-finding: decision must be a resolution, not `open`');
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
      let existing: Record<string, unknown> = {};
      if (existsSync(globalConfigPath)) {
        const parsed = YAML.parse(
          await readFile(globalConfigPath, 'utf8'),
        ) as unknown;
        if (parsed && typeof parsed === 'object') {
          existing = parsed as Record<string, unknown>;
        }
      }
      const merged = deepMerge(existing, body.config) as Record<
        string,
        unknown
      >;
      // Fail-closed validation of the merged document.
      parsePartialConfig(merged, `PUT /settings → ${globalConfigPath}`);
      await mkdir(dirname(globalConfigPath), { recursive: true });
      await writeFile(globalConfigPath, YAML.stringify(merged), 'utf8');
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
      // out through the API (SETTINGS.md secrets section).
      const envPath = join(dirname(globalConfigPath), '.env');
      const current = existsSync(envPath)
        ? parseEnv(await readFile(envPath, 'utf8'))
        : {};
      Object.assign(current, body.secrets);
      const text = `${Object.entries(current)
        .map(([k, v]) => `${k}=${v}`)
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
    const { workspace: wsName } = req.query as { workspace?: string };
    const workspaces = wsName
      ? [wsName]
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
    for (const ws of workspaces) {
      for (const t of await store.listTickets({ workspace: ws })) {
        ticketsByStatus[t.status] = (ticketsByStatus[t.status] ?? 0) + 1;
      }
      openGateItems += (
        await store.listGateItems({ workspace: ws, open: true })
      ).length;
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
        totals.human_minutes += e.human_minutes ?? 0;
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
