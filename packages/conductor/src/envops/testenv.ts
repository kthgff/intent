/**
 * testenv.ts — durable test-environment requests (PRD §15.10, wp-157).
 *
 * Thin MVP slice of the Test Environment/Data Studio: a ticket (or its
 * feature, inherited) may declare a `test_env` spec (temp DB, synthetic
 * seed set, mocked externals, fixture refs). When a stage that needs
 * such an environment (implement/verify) is about to run, the
 * conductor raises a durable request instead of improvising an
 * environment:
 *
 *   - the request records WHAT environment, WHAT data/fixtures, WHO can
 *     provision, and WHEN it expires;
 *   - it surfaces as a `test-env` gate item the human fulfils (with
 *     provisioning evidence) or explicitly waives (with a recorded
 *     rationale) — `TEST_ENV_GATE`;
 *   - the run BLOCKS until the request leaves `pending` — the conductor
 *     never fabricates an environment;
 *   - `run_id` + `evidence` link the provisioning back to the run.
 *
 * Lifecycle: `pending → fulfilled | waived | expired` (all durable;
 * the row is the audit trail). Ledger events: `test_env_requested`,
 * `test_env_fulfilled`, `test_env_waived`, `test_env_expired`.
 *
 * Materialization: a *fulfilled* request's spec is materialized before
 * the run executes. Provisioning code reads ONLY under the workspace
 * `fixtures/` tree — there is deliberately no path to production data
 * (fixture refs are validated to resolve under `fixtures/`, absolute
 * paths and `..` escapes are rejected fail-closed). The sanitizer
 * still applies to anything leaving the worktree.
 *
 * Richer studio (managed multi-service envs, state-request DSL) stays
 * deferred (PRD §15.10 follow-up).
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import {
  type FeatureRow,
  type Store,
  type TestEnvRequestRow,
  type TestEnvSpec,
  TestEnvSpecSchema,
  type TicketRow,
} from '@sprint-runner/core';
import type { StreamEvent } from '../loop/deps.js';

/** Gate instance name surfaced while a request awaits a human. */
export const TEST_ENV_GATE = 'test-env';

/** Stages that consume a declared test environment (CONDUCTOR repo-
 *  executing stages; the wp-157 MVP covers implement + verify). */
export const TEST_ENV_STAGES = ['implement', 'verify'] as const;

/** Context the request lifecycle operates against. Mirrors the
 *  changes-engine context: the store is the truth, nothing here needs
 *  a rootPath (materialization takes paths explicitly). */
export interface TestEnvCtx {
  workspace: string;
  store: Store;
  actor: string;
  now: () => Date;
  /** Live-channel hook (API.md SSE) — fired AFTER the durable write. */
  notify?: ((event: StreamEvent) => void) | undefined;
}

export type TestEnvErrorCode = 'not_found' | 'bad_state' | 'invalid';

export class TestEnvError extends Error {
  readonly code: TestEnvErrorCode;
  constructor(code: TestEnvErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const notFound = (m: string) => new TestEnvError('not_found', m);
const badState = (m: string) => new TestEnvError('bad_state', m);
const invalid = (m: string) => new TestEnvError('invalid', m);

const nowIso = (ctx: TestEnvCtx): string => ctx.now().toISOString();

// ---------------------------------------------------------------------------
// Spec resolution
// ---------------------------------------------------------------------------

/** Ticket spec overrides its feature's; a ticket with no spec inherits
 *  the feature's (`features.test_env` — wp-157). Returns null when
 *  nothing is declared → no env step (existing behavior). */
export function resolveTestEnvSpec(
  ticket: Pick<TicketRow, 'test_env'> | null | undefined,
  feature?: Pick<FeatureRow, 'test_env'> | null,
): TestEnvSpec | null {
  const raw = ticket?.test_env ?? feature?.test_env ?? null;
  if (raw === null || raw === undefined) return null;
  // Re-parse defensively — a malformed spec blocks (fail-closed)
  // rather than silently materializing a half-declared environment.
  return TestEnvSpecSchema.parse(raw);
}

/** Load the feature a ticket belongs to, when it names one. */
async function featureOf(
  ctx: TestEnvCtx,
  ticket: Pick<TicketRow, 'feature'> | null,
): Promise<FeatureRow | null> {
  if (!ticket?.feature) return null;
  return ctx.store.getFeature(ctx.workspace, ticket.feature);
}

// ---------------------------------------------------------------------------
// Ledger + gate plumbing
// ---------------------------------------------------------------------------

async function emit(
  ctx: TestEnvCtx,
  event:
    | 'test_env_requested'
    | 'test_env_fulfilled'
    | 'test_env_waived'
    | 'test_env_expired',
  req: TestEnvRequestRow,
  data: Record<string, unknown> = {},
): Promise<void> {
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: req.ticket_id,
    ts: nowIso(ctx),
    stage: req.stage,
    actor_type: 'runner',
    actor_id: ctx.actor,
    event,
    run: req.run_id,
    refs: [req.request_id],
    data: {
      request_id: req.request_id,
      subject: req.subject,
      stage: req.stage,
      status: req.status,
      ...data,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
}

/** Surface the `test-env` gate item + its notification (idempotent —
 *  an already-open item is left untouched). */
async function surfaceGate(
  ctx: TestEnvCtx,
  req: TestEnvRequestRow,
  priority?: TicketRow['priority'] | null,
): Promise<void> {
  const existing = await ctx.store.getGateItem({
    workspace: ctx.workspace,
    subject: req.subject,
    gate: TEST_ENV_GATE,
  });
  if (existing && !existing.cleared_at) return;
  const ts = nowIso(ctx);
  await ctx.store.upsertGateItem({
    workspace: ctx.workspace,
    subject: req.subject,
    gate: TEST_ENV_GATE,
    kind: 'approval',
    surfaced_at: ts,
    cleared_at: null,
    blocked_agent: true,
    priority: priority ?? null,
  });
  await ctx.store.insertNotification({
    workspace: ctx.workspace,
    subject: req.subject,
    kind: 'gate:approval',
    payload: JSON.stringify({
      gate: TEST_ENV_GATE,
      request_id: req.request_id,
      stage: req.stage,
      provisioner: req.provisioner,
    }),
    created_at: ts,
    read_at: null,
  });
  ctx.notify?.({
    type: 'gate_surfaced',
    payload: { subject: req.subject, gate: TEST_ENV_GATE },
  });
}

/** Clear the `test-env` gate item (fulfil/waive/expire). */
async function clearGate(ctx: TestEnvCtx, req: TestEnvRequestRow): Promise<void> {
  const ts = nowIso(ctx);
  const existing = await ctx.store.getGateItem({
    workspace: ctx.workspace,
    subject: req.subject,
    gate: TEST_ENV_GATE,
  });
  if (!existing || existing.cleared_at) return;
  await ctx.store.clearGateItem(
    { workspace: ctx.workspace, subject: req.subject, gate: TEST_ENV_GATE },
    ts,
  );
  ctx.notify?.({
    type: 'gate_cleared',
    payload: { subject: req.subject, gate: TEST_ENV_GATE },
  });
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateTestEnvRequestOptions {
  subject: string;
  ticketId?: string | null;
  feature?: string | null;
  stage: string;
  /** Run that raised the request (usually set at launch instead). */
  runId?: string | null;
  spec: TestEnvSpec;
  priority?: TicketRow['priority'] | null;
}

/**
 * Raise a durable request. Idempotent: an existing OPEN request for the
 * subject is returned untouched (the gate stays surfaced), so a
 * re-ticked `nextStage` never duplicates requests.
 */
export async function createTestEnvRequest(
  ctx: TestEnvCtx,
  opts: CreateTestEnvRequestOptions,
): Promise<TestEnvRequestRow> {
  const open = (await ctx.store.listTestEnvRequests({
    workspace: ctx.workspace,
    subject: opts.subject,
    status: 'pending',
  }))[0];
  if (open) return open;

  const spec = TestEnvSpecSchema.parse(opts.spec);
  const requestId = await ctx.store.allocTestEnvRequestId(ctx.workspace);
  const ts = nowIso(ctx);
  const expiresAt =
    spec.expires_in_minutes !== null && spec.expires_in_minutes !== undefined
      ? new Date(
          ctx.now().getTime() + spec.expires_in_minutes * 60_000,
        ).toISOString()
      : null;
  const req: TestEnvRequestRow = {
    workspace: ctx.workspace,
    org: null,
    request_id: requestId,
    subject: opts.subject,
    ticket_id: opts.ticketId ?? null,
    feature: opts.feature ?? null,
    stage: opts.stage,
    run_id: opts.runId ?? null,
    spec,
    status: 'pending',
    requested_by: ctx.actor,
    requested_at: ts,
    provisioner: spec.provisioner ?? null,
    expires_at: expiresAt,
    fulfilled_by: null,
    fulfilled_at: null,
    evidence: null,
    waived_by: null,
    waived_at: null,
    waiver_rationale: null,
    expired_at: null,
    updated_at: ts,
  };
  await ctx.store.upsertTestEnvRequest(req);
  await emit(ctx, 'test_env_requested', req, {
    provisioner: req.provisioner,
    expires_at: req.expires_at,
  });
  await surfaceGate(ctx, req, opts.priority ?? null);
  return req;
}

// ---------------------------------------------------------------------------
// fulfil / waive
// ---------------------------------------------------------------------------

async function loadPending(
  ctx: TestEnvCtx,
  requestId: string,
): Promise<TestEnvRequestRow> {
  const req = await ctx.store.getTestEnvRequest({
    workspace: ctx.workspace,
    request_id: requestId,
  });
  if (!req) {
    throw notFound(`unknown test-env request '${ctx.workspace}/${requestId}'`);
  }
  if (req.status !== 'pending') {
    throw badState(
      `test-env request ${requestId} is '${req.status}' — only a pending request can be fulfilled/waived`,
    );
  }
  return req;
}

export interface FulfilTestEnvRequestOptions {
  requestId: string;
  /** Provisioning evidence (url/ref/note) — required; the row is the
   *  durable link from evidence back to the run. */
  evidence: string;
  /** Human who provisioned (defaults to the context actor). */
  by?: string;
}

/** Mark a pending request fulfilled with provisioning evidence. */
export async function fulfilTestEnvRequest(
  ctx: TestEnvCtx,
  opts: FulfilTestEnvRequestOptions,
): Promise<TestEnvRequestRow> {
  const evidence = opts.evidence?.trim() ?? '';
  if (evidence === '') {
    throw invalid('fulfilTestEnvRequest: provisioning evidence is required');
  }
  const req = await loadPending(ctx, opts.requestId);
  const ts = nowIso(ctx);
  const next: TestEnvRequestRow = {
    ...req,
    status: 'fulfilled',
    fulfilled_by: opts.by ?? ctx.actor,
    fulfilled_at: ts,
    evidence,
    updated_at: ts,
  };
  await ctx.store.upsertTestEnvRequest(next);
  await emit(ctx, 'test_env_fulfilled', next, { evidence });
  await clearGate(ctx, next);
  return next;
}

export interface WaiveTestEnvRequestOptions {
  requestId: string;
  /** Recorded rationale — required (a waiver without a reason is a
   *  silent skip, which the conductor never allows). */
  rationale: string;
  by?: string;
}

/** Explicitly waive a pending request with a recorded rationale. */
export async function waiveTestEnvRequest(
  ctx: TestEnvCtx,
  opts: WaiveTestEnvRequestOptions,
): Promise<TestEnvRequestRow> {
  const rationale = opts.rationale?.trim() ?? '';
  if (rationale === '') {
    throw invalid('waiveTestEnvRequest: a recorded rationale is required');
  }
  const req = await loadPending(ctx, opts.requestId);
  const ts = nowIso(ctx);
  const next: TestEnvRequestRow = {
    ...req,
    status: 'waived',
    waived_by: opts.by ?? ctx.actor,
    waived_at: ts,
    waiver_rationale: rationale,
    updated_at: ts,
  };
  await ctx.store.upsertTestEnvRequest(next);
  await emit(ctx, 'test_env_waived', next, { rationale });
  await clearGate(ctx, next);
  return next;
}

// ---------------------------------------------------------------------------
// expire
// ---------------------------------------------------------------------------

/** Sweep pending requests past their `expires_at` → `expired` (gate
 *  cleared; the next stage check re-raises a fresh request). Returns
 *  the expired request ids. */
export async function expireTestEnvRequests(
  ctx: TestEnvCtx,
  filter: { subject?: string } = {},
): Promise<string[]> {
  const pending = await ctx.store.listTestEnvRequests({
    workspace: ctx.workspace,
    status: 'pending',
    ...(filter.subject ? { subject: filter.subject } : {}),
  });
  const nowMs = ctx.now().getTime();
  const expired: string[] = [];
  for (const req of pending) {
    if (!req.expires_at) continue;
    if (Date.parse(req.expires_at) > nowMs) continue;
    const ts = nowIso(ctx);
    const next: TestEnvRequestRow = {
      ...req,
      status: 'expired',
      expired_at: ts,
      updated_at: ts,
    };
    await ctx.store.upsertTestEnvRequest(next);
    await emit(ctx, 'test_env_expired', next);
    await clearGate(ctx, next);
    expired.push(req.request_id);
  }
  return expired;
}

// ---------------------------------------------------------------------------
// gate integration — the "does the stage need an env" decision
// ---------------------------------------------------------------------------

export type TestEnvDecisionStatus =
  | 'no-spec'
  | 'ready'
  | 'waived'
  | 'blocked';

export interface TestEnvDecision {
  status: TestEnvDecisionStatus;
  /** The request the decision concerns, when a spec is declared. */
  request?: TestEnvRequestRow;
  /** Resolved spec, when declared. */
  spec?: TestEnvSpec;
}

/**
 * The CLAIM-path decision: does this stage need a fulfilled/waived
 * test-environment request before it may launch?
 *
 *   - no declared spec      → `no-spec` (no env step — existing behavior)
 *   - latest request ready  → `ready` (materialize at launch)
 *   - latest request waived → `waived` (proceed; human accepted the risk)
 *   - pending / expired / none → raise (or keep) the request, surface
 *     the gate, return `blocked` (the caller returns null → no launch)
 *
 * Idempotent: repeated calls reuse the open request.
 */
export async function ensureTestEnvForStage(
  ctx: TestEnvCtx,
  opts: {
    ticket: TicketRow;
    feature?: FeatureRow | null;
    stage: string;
    runId?: string | null;
    priority?: TicketRow['priority'] | null;
  },
): Promise<TestEnvDecision> {
  const feature =
    opts.feature !== undefined ? opts.feature : await featureOf(ctx, opts.ticket);
  const spec = resolveTestEnvSpec(opts.ticket, feature);
  if (!spec) return { status: 'no-spec' };

  // Latest request for the subject decides (list is ordered by id).
  const requests = await ctx.store.listTestEnvRequests({
    workspace: ctx.workspace,
    subject: opts.ticket.ticket_id,
  });
  const latest = requests[requests.length - 1];
  if (latest?.status === 'fulfilled') {
    return { status: 'ready', request: latest, spec };
  }
  if (latest?.status === 'waived') {
    return { status: 'waived', request: latest, spec };
  }
  if (latest?.status === 'pending') {
    await surfaceGate(ctx, latest, opts.priority ?? opts.ticket.priority);
    return { status: 'blocked', request: latest, spec };
  }

  // none, or expired → raise a fresh durable request.
  const req = await createTestEnvRequest(ctx, {
    subject: opts.ticket.ticket_id,
    ticketId: opts.ticket.ticket_id,
    feature: opts.ticket.feature ?? null,
    stage: opts.stage,
    runId: opts.runId ?? null,
    spec,
    priority: opts.priority ?? opts.ticket.priority,
  });
  return { status: 'blocked', request: req, spec };
}

// ---------------------------------------------------------------------------
// materialization
// ---------------------------------------------------------------------------

export interface TestEnvPlanStep {
  kind: 'seed' | 'fixture' | 'db' | 'mock';
  /** Shell command for `seed` steps. */
  command?: string;
  /** Absolute source path (under `fixtures/`) for `fixture` steps. */
  source?: string;
  /** Workspace-relative fixture ref (as declared). */
  ref?: string;
  /** Human-readable description. */
  description: string;
}

export interface TestEnvPlan {
  steps: TestEnvPlanStep[];
  /** Non-secret env exported to the run (`TEST_ENV*`). */
  env: Record<string, string>;
  /** Absolute `fixtures/` root the plan may read from. */
  fixturesRoot: string;
}

/**
 * Resolve a fixture ref to an absolute path guaranteed to live under
 * `fixtures/`. Rejects absolute paths and `..` escapes fail-closed —
 * this is the structural guarantee that NO production-data path exists
 * in the provisioning code.
 */
export function resolveFixtureRef(
  ref: string,
  workspaceRoot: string,
): { source: string; fixturesRoot: string } {
  const trimmed = ref.trim();
  if (trimmed === '' || isAbsolute(trimmed)) {
    throw invalid(`fixture ref must be a relative path under fixtures/: '${ref}'`);
  }
  const norm = normalize(trimmed);
  if (norm === '..' || norm.startsWith(`..${'/'}`) || norm.includes('/../')) {
    throw invalid(`fixture ref escapes the workspace: '${ref}'`);
  }
  const fixturesRoot = resolve(workspaceRoot, 'fixtures');
  const source = resolve(workspaceRoot, norm);
  const rel = relative(fixturesRoot, source);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw invalid(
      `fixture ref must resolve under fixtures/ (got '${ref}'): provisioning never reads production data`,
    );
  }
  return { source, fixturesRoot };
}

/**
 * Pure planner: turn a spec into ordered materialization steps. Seed
 * commands come from `spec.seed` (overriding) or the repo card's
 * `seed`; fixtures are validated under `fixtures/`. No I/O.
 */
export function planTestEnvMaterialization(
  spec: TestEnvSpec,
  opts: { workspaceRoot: string; cardSeed?: string | null },
): TestEnvPlan {
  const parsed = TestEnvSpecSchema.parse(spec);
  const steps: TestEnvPlanStep[] = [];
  let fixturesRoot = resolve(opts.workspaceRoot, 'fixtures');

  if (parsed.db) {
    steps.push({
      kind: 'db',
      description: `temp ${parsed.db.engine} database${
        parsed.db.schema ? ` (schema ${parsed.db.schema})` : ''
      }`,
    });
  }

  const seeds =
    parsed.seed.length > 0
      ? parsed.seed
      : opts.cardSeed
        ? [opts.cardSeed]
        : [];
  for (const command of seeds) {
    steps.push({
      kind: 'seed',
      command,
      description: `seed: ${command}`,
    });
  }

  for (const ref of parsed.fixtures) {
    const resolvedRef = resolveFixtureRef(ref, opts.workspaceRoot);
    fixturesRoot = resolvedRef.fixturesRoot;
    steps.push({
      kind: 'fixture',
      source: resolvedRef.source,
      ref,
      description: `fixture ${ref}`,
    });
  }

  for (const mock of parsed.mocks) {
    steps.push({ kind: 'mock', description: `mock external: ${mock}` });
  }

  const env: Record<string, string> = {
    TEST_ENV: parsed.kind ?? 'declared',
  };
  if (parsed.db) env.TEST_ENV_DB = parsed.db.engine;

  return { steps, env, fixturesRoot };
}

export interface TestEnvCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Executor seam — tests inject stubs; the default shells out. */
export interface TestEnvExecutor {
  /** Run one seed command with `cwd` + `env`; resolves on exit. */
  runCommand(
    command: string,
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): Promise<TestEnvCommandResult>;
  /** Copy one fixture file into `destination` (mkdir -p first). */
  copyFixture(source: string, destination: string): Promise<void>;
}

function shellRun(
  command: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<TestEnvCommandResult> {
  return new Promise((res) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      res({ command, exitCode: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      res({ command, exitCode: code, stdout, stderr });
    });
  });
}

export const defaultTestEnvExecutor: TestEnvExecutor = {
  runCommand: shellRun,
  async copyFixture(source, destination) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  },
};

export interface MaterializeTestEnvOptions {
  spec: TestEnvSpec;
  /** Workspace root — anchors `fixtures/` (provisioning reads only
   *  here). */
  workspaceRoot: string;
  /** Worktree the run executes in (seed command cwd). */
  worktree: string;
  /** Run dir — the materialized fixtures land under `<runDir>/test-env/`
   *  so the diff never sees them. */
  runDir: string;
  /** Repo-card `seed` command (overridden by `spec.seed`). */
  cardSeed?: string | null;
  timeoutMs?: number;
  executor?: TestEnvExecutor;
}

export interface MaterializeTestEnvResult {
  ok: boolean;
  plan: TestEnvPlan;
  /** Absolute dir fixtures were copied into. */
  envDir: string;
  env: Record<string, string>;
  results: TestEnvCommandResult[];
  /** Human-readable failure detail (empty when ok). */
  error?: string;
}

const DEFAULT_SEED_TIMEOUT_MS = 300_000;

/**
 * Materialize a *fulfilled* request's declared environment before the
 * run executes: copy fixtures into `<runDir>/test-env/`, run seed
 * commands in the worktree, and export `TEST_ENV*` env. Never reads
 * outside `fixtures/` (see {@link resolveFixtureRef}). Returns a
 * result — a failed seed command is reported, not swallowed.
 */
export async function materializeTestEnv(
  opts: MaterializeTestEnvOptions,
): Promise<MaterializeTestEnvResult> {
  const executor = opts.executor ?? defaultTestEnvExecutor;
  const plan = planTestEnvMaterialization(opts.spec, {
    workspaceRoot: opts.workspaceRoot,
    cardSeed: opts.cardSeed ?? null,
  });
  const envDir = join(opts.runDir, 'test-env');
  const env: Record<string, string> = { ...plan.env, TEST_ENV_DIR: envDir };
  const results: TestEnvCommandResult[] = [];

  for (const step of plan.steps) {
    if (step.kind === 'fixture' && step.source) {
      // `<runDir>/test-env/<path relative to fixtures/>`
      const rel = relative(plan.fixturesRoot, step.source);
      const destination = join(envDir, rel);
      try {
        await stat(step.source);
      } catch {
        return {
          ok: false,
          plan,
          envDir,
          env,
          results,
          error: `fixture not found: ${step.ref ?? step.source}`,
        };
      }
      await executor.copyFixture(step.source, destination);
      continue;
    }
    if (step.kind === 'seed' && step.command) {
      const result = await executor.runCommand(step.command, {
        cwd: opts.worktree,
        env,
        timeoutMs: opts.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS,
      });
      results.push(result);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          plan,
          envDir,
          env,
          results,
          error: `seed command failed (${String(result.exitCode)}): ${step.command}`,
        };
      }
    }
    // db/mock steps are informational in the MVP (managed envs deferred).
  }

  return { ok: true, plan, envDir, env, results };
}

export interface MaterializeForRunOptions {
  ctx: TestEnvCtx;
  ticket: TicketRow | null | undefined;
  stage: string;
  runId: string;
  /** Worktree the run executes in. */
  worktree: string;
  /** Run dir — materialized fixtures land under `<runDir>/test-env/`. */
  runDir: string;
  /** Workspace root (anchors `fixtures/`). */
  workspaceRoot: string;
  /** Repo-card `seed` command. */
  cardSeed?: string | null;
  executor?: TestEnvExecutor;
}

/**
 * Launch-path materialization guard (CONDUCTOR LAUNCH). Returns null —
 * no env step — when:
 *
 *   - the stage does not consume a test environment;
 *   - no `test_env` spec is declared (existing behavior); or
 *   - the latest request is not fulfilled (a waived request is a
 *     deliberate human decision; a pending/expired request means the
 *     claim path should have blocked — this guard NEVER fabricates an
 *     environment).
 *
 * On a fulfilled request it materializes the declared spec and links
 * the provisioning evidence back to the run (`run_id`, first consumer).
 */
export async function materializeTestEnvForRun(
  opts: MaterializeForRunOptions,
): Promise<MaterializeTestEnvResult | null> {
  if (!opts.ticket) return null;
  if (!(TEST_ENV_STAGES as readonly string[]).includes(opts.stage)) return null;
  const feature = await featureOf(opts.ctx, opts.ticket);
  const spec = resolveTestEnvSpec(opts.ticket, feature);
  if (!spec) return null; // missing spec → no env step (existing behavior)

  const requests = await opts.ctx.store.listTestEnvRequests({
    workspace: opts.ctx.workspace,
    subject: opts.ticket.ticket_id,
  });
  const latest = requests[requests.length - 1];
  if (!latest || latest.status !== 'fulfilled') return null;

  // Provisioning evidence links back to the run that first needed the
  // environment (idempotent across implement→verify reuse).
  if (!latest.run_id) {
    await opts.ctx.store.upsertTestEnvRequest({
      ...latest,
      run_id: opts.runId,
      updated_at: nowIso(opts.ctx),
    });
  }

  return materializeTestEnv({
    spec,
    workspaceRoot: opts.workspaceRoot,
    worktree: opts.worktree,
    runDir: opts.runDir,
    cardSeed: opts.cardSeed ?? null,
    ...(opts.executor ? { executor: opts.executor } : {}),
  });
}
