/**
 * LAUNCH — CONDUCTOR.md loop step 3.
 *
 * For repo-executing stages (REPO_EXECUTING_STAGES — implement, fix,
 * ci-fix, comment-fix, rebase, revert, verify): create worktree(s)
 * `<repo>.worktrees/<id>` + `ticket/<id>` branches — one ticket_repos
 * row per repo in `repos:`.
 *
 * Cardless stages (triage/design/testplan/doc stages, probe, import,
 * interview, survey) run with the tickets repo checkout as cwd — they
 * may write into `tickets/<id>/` (their outputs are committed by the
 * conductor-side status commit, never by the agent pushing).
 *
 * Then: prepare → adapter.run detached → register the run row +
 * conductor-observed heartbeat + live usage stream → cap check.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Adapter,
  type CommitPolicy,
  PROMPT_TOKENS,
  REPO_EXECUTING_STAGES,
  type RouteDecision,
  type RunBaseline,
  type RunRow,
  type Stage,
  type TicketRow,
  type TokenValues,
  validateRetrievalEvidence,
} from '@veto/core';
import { createWorktree } from '@veto/gitops';
import { createEmbedder, queryEvidence } from '@veto/kb';
import {
  assertRouteProvider,
  renderEvidenceBundle,
  resolveRunRoute,
} from '@veto/prompts';
import type { RunRequest } from '../contracts.js';
import { ensureSubjectContainer } from '../envops/index.js';
import { materializeTestEnvForRun } from '../envops/testenv.js';
import { capExceeded } from '../loop/caps.js';
import {
  type ConductorDeps,
  type ConductorWorkspace,
  actorOf,
  adapterFor,
  backendRuntime,
  containerRuntimeDeps,
  nowIso,
  resolveRepoPath,
  saveHandle,
  stageTimeout,
} from '../loop/deps.js';
import type { LeaseManager } from '../loop/lease.js';
import { formatAssumptionContext } from '../registers/assumptions.js';
import { buildReleaseBundle } from '../release/index.js';
import {
  gitHead,
  pinnedBaselineOf,
  resolveRunBaseline,
  withBaseSha,
} from './baseline.js';
import { blockTicketForCap } from './caps-action.js';
import { runRunnerTask, taskForStage } from './runner.js';

export interface LaunchContext {
  deps: ConductorDeps;
  ws: ConductorWorkspace;
  leases: LeaseManager;
  /** In-memory run-handle registry (persisted to handle.json too). */
  handles: Map<string, import('@veto/core').RunHandle>;
  /** Run ids already killed for a cap hit (stream may refire). */
  killedForCap: Set<string>;
  /** Called when a mid-run usage stream trips a cap. */
  onCapHit?: (run: RunRow, cap: string) => void;
}

/** `<workspace>/<subject>/<attempt:03d>-<stage>` (DB-SCHEMA runs.id
 *  example: `team-a/ABC-123/003-implement`). */
export function formatRunId(
  workspace: string,
  subject: string,
  attempt: number,
  stage: string,
): string {
  return `${workspace}/${subject}/${String(attempt).padStart(3, '0')}-${stage}`;
}

/** Next attempt number for (subject, stage) — max existing + 1. */
export async function nextAttempt(
  ctx: LaunchContext,
  subject: string,
  stage: string,
): Promise<number> {
  const runs = await ctx.deps.store.listRuns({
    workspace: ctx.ws.name,
    subject,
  });
  let max = 0;
  for (const r of runs) {
    if (r.stage === stage && r.attempt > max) max = r.attempt;
  }
  return max + 1;
}

/** True when a live run already fences (subject, stage). */
export async function hasLiveRun(
  deps: ConductorDeps,
  workspace: string,
  subject: string,
  stage: string,
): Promise<boolean> {
  const live = await deps.store.listLiveRuns();
  return live.some(
    (r) =>
      r.workspace === workspace && r.subject === subject && r.stage === stage,
  );
}

/**
 * Queue a `pending` run row (TransitionTools.requestRun + the
 * conductor's own probe queueing). Deduplicated on live runs for
 * (subject, stage). Returns the run id or null when already queued.
 */
export async function queuePendingRun(
  ctx: LaunchContext,
  req: RunRequest,
): Promise<string | null> {
  if (await hasLiveRun(ctx.deps, ctx.ws.name, req.subject, req.stage)) {
    return null;
  }
  const attempt = await nextAttempt(ctx, req.subject, req.stage);
  const id = formatRunId(ctx.ws.name, req.subject, attempt, req.stage);
  const ts = nowIso(ctx.deps);
  // wp-141: pin the baseline at QUEUE time — the spec versions the run
  // will implement are resolved to concrete doc_versions now. The
  // pending row carries the pin across queue→claim; launch reuses it
  // (no retro-edit) and only adds the branch point (base_sha).
  const baseline = await resolveRunBaseline({
    store: ctx.deps.store,
    workspace: ctx.ws.name,
    subject: req.ticketId ?? req.subject,
  });
  await ctx.deps.store.createRun({
    id,
    workspace: ctx.ws.name,
    subject: req.subject,
    ticket_id: req.ticketId ?? null,
    stage: req.stage,
    attempt,
    backend: null,
    model: req.model ?? null,
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: {
      ...(req.tokens ? { tokens: req.tokens } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.task ? { task: req.task } : {}),
      baseline,
    },
    status: 'pending',
    started_at: null,
    heartbeat_at: null,
    exited_at: null,
    sentinel: null,
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: null,
  });
  return id;
}

/** Stage → retrieval task (SCHEMAS §17 `task`) — the evidence plane's
 *  task-bounded view of each code-aware stage. */
const EVIDENCE_TASK = {
  prd: 'prd',
  design: 'impact',
  testplan: 'testplan',
  implement: 'implement',
  review: 'review',
} as const;

/**
 * wp-111 pre-prompt grounding (AC: "existing-product prd-draft obtains
 * and validates a scoped evidence bundle before prompt rendering;
 * greenfield/zero-result behavior is explicit").
 *
 * Returns the `{{EVIDENCE_BUNDLE}}` token value AND persists the
 * validated `retrieval-evidence.json` bundle as a run artifact —
 * the prompt's evidence is inspectable and the artifact is proof of
 * ordering (grounding happens in `buildTokens`, before
 * `adapter.prepare` renders).
 *
 * Explicit outcomes, never a silent empty:
 *  - `intelligence.grounding: off`     → zero bundle, "disabled" reason
 *  - greenfield (repos: [])            → zero bundle, "greenfield" reason
 *  - retrieval error                   → zero bundle, "unavailable" reason
 *  - zero relevant results             → SCHEMAS §17 zero_result_reason
 */
async function stageEvidenceBundle(
  ctx: LaunchContext,
  ticket: TicketRow,
  task: (typeof EVIDENCE_TASK)[keyof typeof EVIDENCE_TASK],
  runId: string,
): Promise<string> {
  const { deps, ws } = ctx;
  const intel = deps.config.intelligence;
  const commitPolicy = (
    intel.allow_stale ? 'allow-stale' : 'current'
  ) as CommitPolicy;
  const requestBase = {
    workspace: ws.name,
    subject: ticket.ticket_id,
    task,
    query: ticket.title,
    source_types: ['code' as const],
    commit_policy: commitPolicy,
    limit: intel.max_results,
    token_limit: intel.context_tokens,
  };

  /** Persist + render an explicit zero-result bundle (validated
   *  fail-closed — even the degraded path ships a §17 artifact). */
  const zero = async (reason: string): Promise<string> => {
    const bundle = validateRetrievalEvidence({
      schema: 1,
      request: { ...requestBase, repos: [] },
      index_heads: [],
      results: [],
      zero_result_reason: reason,
      generated_at: nowIso(deps),
    });
    await deps.store.putArtifact({
      run_id: runId,
      name: 'retrieval-evidence.json',
      content: `${JSON.stringify(bundle, null, 2)}\n`,
      created_at: nowIso(deps),
    });
    return renderEvidenceBundle(bundle);
  };

  if (!intel.grounding) {
    return zero('evidence grounding disabled (intelligence.grounding: off)');
  }
  if (ticket.repos.length === 0) {
    return zero(
      'greenfield ticket — no repositories in scope; evidence starts at first code',
    );
  }
  try {
    const authorized = ticket.repos.filter(
      (r) => deps.config.repos[r] !== undefined,
    );
    const bundle = await queryEvidence(
      deps.store,
      { ...requestBase, repos: [...authorized] },
      {
        authorizedRepos: authorized,
        embedder: createEmbedder(
          deps.config.semantic,
          deps.config.secrets.OPENROUTER_API_KEY
            ? { apiKey: deps.config.secrets.OPENROUTER_API_KEY }
            : {},
        ),
        now: () => nowIso(deps),
      },
    );
    await deps.store.putArtifact({
      run_id: runId,
      name: 'retrieval-evidence.json',
      content: `${JSON.stringify(bundle, null, 2)}\n`,
      created_at: nowIso(deps),
    });
    return renderEvidenceBundle(bundle);
  } catch {
    // Degraded, still explicit — the run continues without advisory
    // context and the artifact records WHY it has none.
    return zero('retrieval error — evidence unavailable for this run');
  }
}

/**
 * Build the token table for a stage prompt (ADAPTERS token table).
 * wp-030 ships sane conductor-owned defaults — file contents the
 * runner can supply mechanically (ticket.md, repo cards, paths) and
 * explicit `pending`/empty markers for tokens whose producers are
 * later work packages (dossiers, prior art, spec docs, CI state).
 * {{ARTIFACT_TARGETS}}/{{CAPABILITY_NOTES}} are computed by the
 * renderer from capability flags.
 */
async function buildTokens(
  ctx: LaunchContext,
  req: RunRequest,
  ticket: TicketRow | null,
  runId: string,
  runDir: string,
): Promise<TokenValues> {
  // Every token starts as '' so fail-closed rendering never dies on a
  // token this wp can't produce yet — the prompt still names it.
  const tokens: Record<string, string> = {};
  for (const t of PROMPT_TOKENS) tokens[t] = '';
  const ws = ctx.ws;

  let ticketDir = '';
  if (ticket) {
    // D29: ticket docs live in doc_versions (DB truth). The agent
    // writes its outputs under <run_dir>/<ticket_id>/ — reconcile
    // ingests them into run_artifacts/doc_versions on collect.
    ticketDir = join(runDir, ticket.ticket_id);
    tokens.TICKET_ID = ticket.ticket_id;
    tokens.TICKET_DIR = ticketDir;
    tokens.TICKET_MD =
      (
        await ctx.deps.store.getDoc({
          workspace: ws.name,
          subject: ticket.ticket_id,
          doc: 'ticket.md',
        })
      )?.content ?? '';
    tokens.REPO_NAMES = ticket.repos.join(', ');
    tokens.REPO_NAME = ticket.repos[0] ?? '';
    tokens.DEPTH = ticket.depth ?? ctx.deps.config.spec_depth;
    tokens.BRANCH = `ticket/${ticket.ticket_id}`;
    const cards = Object.fromEntries(
      ticket.repos.map((r) => [r, ctx.deps.config.repos[r]?.card ?? null]),
    );
    tokens.REPO_CARDS = JSON.stringify(cards);

    // wp-110 + wp-111: {{EVIDENCE_BUNDLE}} — the authorized, cited
    // retrieval bundle for code-aware stages (prd/design/testplan/
    // implement/review). ACL = the ticket's own repos ∩ configured
    // repos — a ticket can never pull code evidence outside its
    // declared scope. wp-111 honors the `intelligence:` settings
    // (grounding switch, allow_stale → commit_policy, max_results,
    // context_tokens), makes greenfield/zero-result explicit, and
    // persists the validated bundle as a `retrieval-evidence.json`
    // run artifact BEFORE prompt rendering. Failure degrades to the
    // explicit no-evidence block; it never fabricates and never
    // aborts the launch over advisory context.
    const task = EVIDENCE_TASK[req.stage as keyof typeof EVIDENCE_TASK];
    if (task) {
      tokens.EVIDENCE_BUNDLE = await stageEvidenceBundle(
        ctx,
        ticket,
        task,
        runId,
      );
    }
  } else {
    tokens.TICKET_ID = req.subject;
  }
  // TICKETS_DIR resolves to the run dir: doc-writing stages (interview
  // `<NEW_ID>/ticket.md`, import `<KEY>/ticket.md`) drop files under
  // their artifact dir and reconcile ingests them (D29 — no tickets
  // repo exists to write into).
  tokens.TICKETS_DIR = runDir;
  tokens.DOSSIER = 'dossier pending';
  tokens.PRIOR_ART = 'none';
  tokens.SPEC_LINT = 'not computed (wp-032)';
  tokens.CONTEXT_MD = '';
  // wp-153: open Assumption Register rows surface in ticket/RS context
  // (PRD §15.10 — unverified dependencies are visible to the stage
  // that consumes them, with provenance).
  if (ticket) {
    const assumptions = await ctx.deps.store.listAssumptions({
      workspace: ws.name,
      subject: ticket.ticket_id,
    });
    tokens.CONTEXT_MD = formatAssumptionContext(assumptions);
  }
  tokens.SPLIT_MAX_CHILDREN = String(
    ctx.deps.config.budgets.split_max_children,
  );
  tokens.SURVEY_BUDGET = String(
    ctx.deps.config.survey.budget_usd ?? 'uncapped',
  );
  tokens.DISMISSAL_CAP = String(ctx.deps.config.budgets.fix_dismissal_cap);
  if (req.subject.startsWith('probe:')) {
    const repo = req.subject.slice('probe:'.length);
    tokens.REPO_NAME = repo;
    tokens.REPO_NAMES = repo;
    const path = resolveRepoPath(ctx.deps, ws, repo);
    tokens.REPO_PATH = path;
    tokens.CARD_PATH = join(path, '.veto', 'card.json');
  }
  if (req.stage === 'retro' || req.stage === 'release-notes') {
    // wp-135: RELEASE_MD is the frozen manifest + delivery/outcome
    // evidence bundle for the release subject (DELIVERY §5/§7). A
    // missing release fails closed at launch — the bundle is never a
    // silent empty string.
    tokens.RELEASE_MD = await buildReleaseBundle(
      {
        workspace: ws.name,
        rootPath: ws.rootPath,
        store: ctx.deps.store,
        actor: actorOf(ctx.deps),
        now: () => ctx.deps.now?.() ?? new Date(),
      },
      req.subject,
    );
  }
  return { ...tokens, ...(req.tokens ?? {}) } as TokenValues;
}

/**
 * Merge a pending row's saved `runs.request` with what this launch
 * computed — tokens (NEW_ID, FEEDBACK, …), the runner-task spec, model,
 * the resolved route decision (wp-155 pinning — a re-launched pending
 * row carries the same audit trail), and the pinned baseline (wp-141 —
 * the doc pins are immutable; only `base_sha` is (re)set at launch).
 * The pinned baseline from the pending row always wins over a fresh
 * resolve, so a relaunch never adopts a newer spec.
 */
function persistedRequest(
  pendingRow: RunRow | undefined,
  tokens: Record<string, string>,
  task: RunRequest['task'],
  model: string | undefined,
  baseline: RunBaseline,
  route?: RouteDecision,
): RunRow['request'] {
  const prev = (pendingRow?.request ?? {}) as Record<string, unknown>;
  // Drop the previously stored tokens/baseline — both are re-merged
  // explicitly below (tokens merge; baseline is the chosen pin).
  const { tokens: prevTokensRaw, baseline: _prevBaseline, ...prevRest } = prev;
  const merged = {
    ...((prevTokensRaw ?? {}) as Record<string, string>),
    ...tokens,
  };
  const out: Record<string, unknown> = {
    ...prevRest,
    ...(Object.keys(merged).length ? { tokens: merged } : {}),
    ...(task ? { task } : {}),
    ...(model ? { model } : {}),
    ...(route ? { route } : {}),
    baseline,
  };
  return Object.keys(out).length ? out : null;
}

/**
 * Container ensure (CONDUCTOR LAUNCH step 3, D30) — for a
 * repo-executing stage on a `runtime: container` backend, create the
 * subject's persistent container if absent (bind-mounting every current
 * `ticket_repos` worktree) or `docker start` it if stopped; the wp-095
 * lifecycle recreates it when the mount set grew. Returns the container
 * id to hand to `adapter.run(opts.container_id)`, or `undefined` when
 * this run stays host-side.
 *
 * Lazy-create rule: cardless doc stages (triage/prd/design/testplan/
 * interview) run on the host — no container exists until the first
 * repo-executing stage has code to execute against.
 */
async function ensureRunContainer(
  ctx: LaunchContext,
  args: {
    req: RunRequest;
    ticket: TicketRow | null;
    adapter: Adapter;
  },
): Promise<string | undefined> {
  const { deps, ws } = ctx;
  const { req, ticket, adapter } = args;
  if (!ticket) return undefined;
  if (!(REPO_EXECUTING_STAGES as readonly string[]).includes(req.stage)) {
    return undefined; // cardless stage → host process
  }
  if (backendRuntime(deps, adapter.name, adapter) !== 'container') {
    return undefined; // process backend
  }
  // Mounts = every worktree on the ticket (one container, N mounts for
  // multi-repo — never N containers). Worktrees were created above.
  const ticketRepos = await deps.store.listTicketRepos({
    workspace: ws.name,
    ticket_id: ticket.ticket_id,
  });
  const mounts = ticketRepos
    .map((r) => r.worktree)
    .filter((w): w is string => typeof w === 'string' && w.length > 0);
  if (mounts.length === 0) return undefined; // nothing to execute against
  const ensured = await ensureSubjectContainer(containerRuntimeDeps(deps), {
    workspace: ws.name,
    subject: req.subject,
    mounts,
  });
  return ensured?.row.container_id;
}

/**
 * LAUNCH one run: lease → worktree(s) → prepare → spawn detached →
 * register. `pendingRow` set → reuses that row (requestRun path).
 * Returns the run id, or null when the lease was contested.
 */
export async function launch(
  ctx: LaunchContext,
  req: RunRequest & { pendingRow?: RunRow },
): Promise<string | null> {
  const { deps, ws } = ctx;
  const store = deps.store;
  const ticket = req.ticketId
    ? await store.getTicket({ workspace: ws.name, ticket_id: req.ticketId })
    : null;

  const attempt =
    req.pendingRow?.attempt ?? (await nextAttempt(ctx, req.subject, req.stage));
  const runId =
    req.pendingRow?.id ?? formatRunId(ws.name, req.subject, attempt, req.stage);

  // --- lease (CONDUCTOR CLAIM: contested → skip this tick) ---
  const leaseKey = {
    workspace: ws.name,
    subject: req.subject,
    stage: req.stage,
    attempt,
  };
  if (!(await ctx.leases.acquire(ws, leaseKey))) return null;

  // --- durable per-run request fields ---
  // Interview NEW_ID is allocated ONCE per run and carried on
  // `runs.request.tokens` — a pending row's re-launch (or a WONT-DRAFT
  // re-interview that deliberately burns the id) must not allocate
  // again. allocTicketId needs a projects row (D29 id rule); the
  // workspace may predate project registration → self-heal.
  const reqTokens = { ...(req.tokens ?? {}) };
  // Chat-to-edit runs reuse the interview stage but never author a new
  // ticket — skip NEW_ID allocation (it would burn a sequence id).
  if (
    req.stage === 'interview' &&
    !reqTokens.NEW_ID &&
    reqTokens.EDIT_SESSION === undefined
  ) {
    // allocTicketId self-heals a missing projects row with sequences
    // seeded above the existing ids — NEW_ID can never collide with a
    // ticket that already exists.
    reqTokens.NEW_ID = await store.allocTicketId(ws.name);
  }
  const task = req.task ?? taskForStage(req.stage);

  const backend = (ticket?.backend ?? deps.config.backend) as string;
  // wp-155: model resolution goes through the routing registry —
  // runs.request pin > ticket pin > models.<stage> > models.default >
  // legacy knobs > backend default. No stage hardcodes a model.
  const route = resolveRunRoute({
    config: deps.config,
    kind: req.stage,
    requestModel: req.model ?? null,
    ticketModel: ticket?.model ?? null,
  });
  const model = route.model;
  // SCHEMAS §21 `providers` is an allowlist, not a preference: when the
  // resolved model names a provider the route excludes, launch fails
  // closed rather than quietly routing around the registry.
  const modelProvider = model?.includes('/')
    ? model.slice(0, model.indexOf('/'))
    : null;
  if (modelProvider) assertRouteProvider(route, modelProvider);
  const depth = (ticket?.depth ?? deps.config.spec_depth) as RunRow['depth'];
  const ts = nowIso(deps);
  const runDir = join(deps.runsDir, ...runId.split('/'));
  await mkdir(runDir, { recursive: true });

  // --- worktrees (CONDUCTOR LAUNCH step 3) ---
  let worktree = ws.rootPath;
  if (
    ticket &&
    (REPO_EXECUTING_STAGES as readonly string[]).includes(req.stage)
  ) {
    const slug = runId.replaceAll('/', '-');
    for (const repo of ticket.repos) {
      const repoPath = resolveRepoPath(deps, ws, repo);
      const branch = `ticket/${ticket.ticket_id}`;
      // The worktree+branch are per-TICKET (ticket_repos row), not per
      // run — a verify/fix/rebase run after `implement` must reuse the
      // existing checkout: `git worktree add` refuses a branch that is
      // already checked out elsewhere.
      const existing = await store.getTicketRepo({
        workspace: ws.name,
        ticket_id: ticket.ticket_id,
        repo,
      });
      const dir =
        existing?.worktree && existsSync(existing.worktree)
          ? existing.worktree
          : await createWorktree(repoPath, slug, branch);
      await store.upsertTicketRepo({
        workspace: ws.name,
        ticket_id: ticket.ticket_id,
        repo,
        branch,
        worktree: dir,
        pr_url: existing?.pr_url ?? null,
        pr_state: existing?.pr_state ?? null,
        ci_state: existing?.ci_state ?? null,
        merged_sha: existing?.merged_sha ?? null,
      });
      worktree = dir; // last wins for multi-repo; cwd only anchors the spawn
    }
  }

  // --- test-environment materialization (PRD §15.10, wp-157) ---
  // A declared `test_env` spec materializes before the run executes.
  // Best-effort + fail-safe: no spec → no env step; a pending/expired
  // request never fabricates an environment (the claim path blocks
  // first); a failed materialization is surfaced, never silent.
  if (ticket && req.stage !== 'probe') {
    try {
      const cardSeed =
        ticket.repos
          .map((r) => deps.config.repos[r]?.card?.seed)
          .find((s) => typeof s === 'string') ?? null;
      const materialized = await materializeTestEnvForRun({
        ctx: {
          workspace: ws.name,
          store,
          actor: actorOf(deps),
          now: () => deps.now?.() ?? new Date(),
          notify: deps.notify,
        },
        ticket,
        stage: req.stage,
        runId,
        worktree,
        runDir,
        workspaceRoot: ws.rootPath,
        cardSeed,
      });
      if (materialized && !materialized.ok) {
        await store.insertNotification({
          workspace: ws.name,
          subject: ticket.ticket_id,
          kind: 'test-env-materialize-failed',
          payload: JSON.stringify({
            run_id: runId,
            error: materialized.error,
            env_dir: materialized.envDir,
          }),
          created_at: ts,
          read_at: null,
        });
      }
    } catch (e) {
      deps.onError?.(e);
    }
  }

  // --- wp-141: pin the run baseline (never "latest") ---
  // A pending row already carries its pin from queue time — reuse it
  // verbatim (no retro-edit) and only stamp the branch point. A
  // ticket-driven claim (no pending row) resolves the doc heads NOW.
  const pinnedBaseline = pinnedBaselineOf(req.pendingRow);
  const baseline =
    pinnedBaseline !== null
      ? withBaseSha(pinnedBaseline, await gitHead(worktree))
      : await resolveRunBaseline({
          store,
          workspace: ws.name,
          subject: req.ticketId ?? req.subject,
          worktree,
        });

  // --- runner-task lane (CONDUCTOR "Runner tasks") ---
  // `verify`/`import` carry a stage but no agent: register a
  // `backend: 'runner'` row, run the conductor-side task, settle it
  // through the normal reconcile collect path.
  if (task) {
    const row: RunRow = {
      id: runId,
      workspace: ws.name,
      subject: req.subject,
      ticket_id: ticket?.ticket_id ?? req.ticketId ?? null,
      stage: req.stage,
      attempt,
      backend: 'runner',
      model: null,
      depth: null,
      pid: null,
      worktree,
      container_id: null,
      request: persistedRequest(
        req.pendingRow,
        reqTokens,
        task,
        req.model,
        baseline,
      ),
      status: 'running',
      started_at: ts,
      heartbeat_at: ts,
      exited_at: null,
      sentinel: null,
      sentinel_raw: null,
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      run_dir: runDir,
    };
    if (req.pendingRow) await store.updateRun(runId, row);
    else await store.createRun(row);
    deps.notify?.({ type: 'run_status', payload: { ...row } });
    await store.appendEvent({
      workspace: ws.name,
      ticket_id: row.ticket_id,
      ts,
      stage: req.stage,
      actor_type: 'runner',
      actor_id: actorOf(deps),
      event: 'run_started',
      run: runId,
      refs: [],
      data: { attempt, task: task.kind, worktree },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    const ticketRepos = ticket
      ? await store.listTicketRepos({
          workspace: ws.name,
          ticket_id: ticket.ticket_id,
        })
      : [];
    void runRunnerTask({
      deps,
      ws,
      leases: ctx.leases,
      run: row,
      task,
      ticketRepos,
    }).catch((e) => deps.onError?.(e));
    return runId;
  }

  // --- render + spawn ---
  const adapter = adapterFor(deps, backend);
  const ticketDir = ticket ? join(runDir, ticket.ticket_id) : undefined;
  const rendered = await adapter.prepare(req.subject, req.stage, {
    workspace: ws.name,
    run_dir: runDir,
    run_id: runId,
    backend: adapter.name,
    ...(model ? { model } : {}),
    route,
    ...(depth ? { depth } : {}),
    ...(ticketDir ? { ticket_dir: ticketDir } : {}),
    tokens: await buildTokens(
      ctx,
      { ...req, tokens: reqTokens },
      ticket,
      runId,
      runDir,
    ),
  });
  // Container ensure BEFORE the exec (CONDUCTOR LAUNCH step 3, D30) —
  // the adapter's `docker exec -w <worktree>` targets this container.
  const containerId = await ensureRunContainer(ctx, { req, ticket, adapter });
  const handle = await adapter.run(
    worktree,
    rendered,
    stageTimeout(deps, req.stage),
    {
      run_dir: runDir,
      ...(containerId !== undefined ? { container_id: containerId } : {}),
    },
  );
  await saveHandle(runDir, handle);
  ctx.handles.set(runId, handle);

  // --- register run row ---
  const row: RunRow = {
    id: runId,
    workspace: ws.name,
    subject: req.subject,
    ticket_id: ticket?.ticket_id ?? req.ticketId ?? null,
    stage: req.stage,
    attempt,
    backend: adapter.name,
    model,
    depth,
    pid: handle.pid,
    worktree,
    container_id: containerId ?? null,
    request: persistedRequest(
      req.pendingRow,
      reqTokens,
      undefined,
      req.model,
      baseline,
      route,
    ),
    status: 'running',
    started_at: ts,
    heartbeat_at: ts,
    exited_at: null,
    sentinel: null,
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: runDir,
  };
  if (req.pendingRow) await store.updateRun(runId, row);
  else await store.createRun(row);

  // API.md stream: run_status after the durable row write.
  deps.notify?.({ type: 'run_status', payload: { ...row } });

  await store.appendEvent({
    workspace: ws.name,
    ticket_id: row.ticket_id,
    ts,
    stage: req.stage,
    actor_type: 'runner',
    actor_id: actorOf(deps),
    event: 'run_started',
    run: runId,
    refs: [],
    data: {
      attempt,
      pid: handle.pid,
      worktree,
      ...(containerId !== undefined ? { container_id: containerId } : {}),
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });

  // --- live usage stream → runs.tokens_* + cap check (ADAPTERS
  //     on_usage; CONDUCTOR "evaluated on every streamed usage_partial") ---
  adapter.on_usage(handle, (partial) => {
    void store
      .updateRunUsage(runId, partial)
      .then(async () => {
        // API.md stream: usage_partial mirrors the durable counters.
        deps.notify?.({
          type: 'usage_partial',
          payload: { run_id: runId, ...partial },
        });
        if (!row.ticket_id) return;
        const cap = await capExceeded(deps, ws.name, row.ticket_id as string);
        if (cap) await blockTicketForCap(ctx, row, cap);
      })
      .catch((e) => deps.onError?.(e));
  });

  return runId;
}

// wp-141 baseline pinning helpers (resolve + pinnedBaselineOf + gitHead).
export * from './baseline.js';
