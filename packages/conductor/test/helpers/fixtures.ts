/**
 * wp-094 E2E fixture world (D29) — seeds `tickets` rows + `doc_versions`
 * directly from the fixture ticket.md docs (parsed via the importer's
 * `parseTicketMd` — no projection pass), copies fixtures/code-repo into
 * a tmp dir + `git init`s it, and boots a real Conductor over a PGlite
 * PostgresStore + a scripted MockAdapter + RealTransitionHandler.
 * Zero LLM spend, everything local.
 *
 * The mock agent is `helpers/mock-agent.mjs` — a superset of the shipped
 * agent that additionally writes files into the run dir's ticket scope
 * (`files`) and emits arbitrary sentinels (`sentinel`). Reconcile's
 * run-dir ingestion promotes `<run_dir>/<ticket_id>/<doc>` writes into
 * `doc_versions`/`run_artifacts` rows — the same path real adapters use.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter } from '@sprint-runner/adapters';
import { type EffectiveConfig, resolveConfig } from '@sprint-runner/config';
import { RS_QUALITY_DIMENSIONS } from '@sprint-runner/core';
import type {
  Adapter,
  CollectContext,
  ControlOp,
  EventRow,
  GateItem,
  PrepareContext,
  RenderedPrompt,
  RunHandle,
  RunResult,
  Stage,
  Store,
  TicketRow,
  UsageCallback,
} from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { parseTicketMd } from '../../src/import/parse.js';
import { Conductor, RealTransitionHandler } from '../../src/index.js';
import type { ConductorDeps, TickReport } from '../../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../../..');
const TICKETS_FIXTURE = join(REPO_ROOT, 'fixtures/tickets-repo');
const CODE_FIXTURE = join(REPO_ROOT, 'fixtures/code-repo');
export const E2E_AGENT = join(HERE, 'mock-agent.mjs');

export const WS = 'ws';
export const HUMAN = { name: 'human', email: 'human@example.com' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ScriptedAdapter — routes a per-(subject, stage, attempt) script into
// MOCK_SCENARIO. Wraps MockAdapter so runs are real detached children.
// ---------------------------------------------------------------------------

/** What a scripted run may do — the `script:` payload for mock-agent.mjs. */
export interface MockScriptSpec {
  /** Last-line sentinel text, verbatim (`'READY'`, `'NEEDS-INFO: 2'`, …).
   *  null → no sentinel (run_failed). */
  sentinel?: string | null;
  /** Files written into the run's artifact dir (→ collected artifacts). */
  artifacts?: Record<string, unknown>;
  /** Absolute-path files written by the child — use the run's
   *  `ticketDir` (`<run_dir>/<ticket_id>/`) for doc writes; ingest
   *  promotes them into doc_versions. */
  files?: Record<string, unknown>;
  /** Never exits — for the timeout/kill path. */
  hang?: boolean;
  delayMs?: number;
  exit?: number;
}

/** A script is a spec object or a builtin DSL word
 *  (`done`/`hang`/`garbage-sentinel`/`no-sentinel`). */
export type MockScript = MockScriptSpec | string;

export interface ScriptedRunInfo {
  subject: string;
  stage: string;
  /** Attempt number parsed from the run id (`…/003-triage`). */
  attempt: number;
  ticketId: string | null;
  /** `<run_dir>/<ticket_id>/` — the agent's doc-write scope. */
  ticketDir?: string;
  runId: string;
}

export type ScriptFn = (run: ScriptedRunInfo) => MockScript;

/** Recover run info from a bare ARTIFACT_TARGETS prompt (the conductor
 *  synthesizes one for `verify` instead of calling adapter.prepare). */
function metaFromRendered(rendered: RenderedPrompt): ScriptedRunInfo | null {
  const dir = /(\/\S+)\/ \(absolute/.exec(rendered.text)?.[1];
  if (!dir) return null;
  const parts = dir.split('/').filter(Boolean);
  const tail = parts.slice(-3); // <ws>/<subject>/<NNN>-<stage>
  if (tail.length < 3) return null;
  const attemptStage = tail[2] ?? '';
  const m = /^(\d+)-(.+)$/.exec(attemptStage);
  const subject = tail[1] ?? '';
  return {
    subject,
    stage: (m?.[2] ?? 'verify') as Stage,
    attempt: Number(m?.[1] ?? '1'),
    ticketId: /^[A-Z]+-\d+$/.test(subject) ? subject : null,
    runId: tail.join('/'),
  };
}

export class ScriptedAdapter implements Adapter {
  readonly name = 'mock' as const;
  readonly capabilities;
  readonly #inner: MockAdapter;
  readonly #script: ScriptFn;
  readonly #meta = new WeakMap<RenderedPrompt, ScriptedRunInfo>();
  readonly seen: ScriptedRunInfo[] = [];

  constructor(opts: {
    script: ScriptFn;
    agentScript?: string;
    delayMs?: number;
  }) {
    this.#inner = new MockAdapter({
      agentScript: opts.agentScript ?? E2E_AGENT,
      delayMs: opts.delayMs ?? 30,
    });
    this.capabilities = this.#inner.capabilities;
    this.#script = opts.script;
  }

  prepare(
    subject: string,
    stage: string,
    ctx: PrepareContext,
  ): Promise<RenderedPrompt> | RenderedPrompt {
    const attempt = Number(ctx.run_id.split('/').pop()?.split('-')[0] ?? '1');
    const ticketId = ctx.ticket_dir
      ? (ctx.ticket_dir.split('/').pop() ?? null)
      : null;
    const info: ScriptedRunInfo = {
      subject,
      stage: stage as Stage,
      attempt,
      ticketId,
      ...(ctx.ticket_dir ? { ticketDir: ctx.ticket_dir } : {}),
      runId: ctx.run_id,
    };
    const rendered = this.#inner.prepare(subject, stage, ctx);
    this.#meta.set(rendered, info);
    this.seen.push(info);
    return rendered;
  }

  run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
  ): Promise<RunHandle> | RunHandle {
    // prepare() normally records meta keyed by the rendered object. The
    // conductor bypasses prepare() for `verify` (a runner task with no
    // prompt — it synthesizes a bare ARTIFACT_TARGETS line), so fall back
    // to parsing `<runsDir>/<ws>/<subject>/<NNN>-<stage>` out of it.
    const meta = this.#meta.get(rendered) ?? metaFromRendered(rendered);
    const spec = meta ? this.#script(meta) : 'done';
    const scenario =
      typeof spec === 'string'
        ? spec
        : `script:${Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url')}`;
    return this.#inner.run(worktree, rendered, timeout, { scenario });
  }

  control(handle: RunHandle, op: ControlOp): Promise<void> | void {
    return this.#inner.control(handle, op);
  }

  on_usage(handle: RunHandle, cb: UsageCallback): void {
    this.#inner.on_usage(handle, cb);
  }

  collect(
    handle: RunHandle,
    ctx: CollectContext,
  ): Promise<RunResult> | RunResult {
    return this.#inner.collect(handle, ctx);
  }
}

// ---------------------------------------------------------------------------
// Scripted spec-doc payloads (pinned SCHEMAS tables — see lints).
// ---------------------------------------------------------------------------

export function rsDoc(id: string): string {
  return [
    `# RS — ${id}`,
    '',
    '## Problem',
    'Transient S3 errors abort the nightly ETL run permanently.',
    '',
    '## Requirements',
    '- Retry transient failures with exponential backoff (max 3).',
    '- Non-transient errors fail immediately.',
    '- Job log records per-file outcome lines.',
    '',
  ].join('\n');
}

export function tddDoc(id: string, file = 'src/app.ts'): string {
  return [
    `# TDD — ${id}`,
    '',
    '## File plan',
    '| file | repo | change | why |',
    '| --- | --- | --- | --- |',
    `| ${file} | code-repo | add retry wrapper with backoff | transient S3 errors abort the job |`,
    '',
  ].join('\n');
}

export function vsDoc(id: string, file = 'src/app.ts'): string {
  return [
    `# Verification spec — ${id}`,
    '',
    '## Cases',
    '| case_id | title | type | file | covers |',
    '| --- | --- | --- | --- | --- |',
    `| case:c1 | transient errors retried with backoff | unit | ${file} | retry logic |`,
    '',
    '## Coverage matrix',
    '| item | kind | case_ids |',
    '| --- | --- | --- |',
    `| ${file} | file | case:c1 |`,
    '',
  ].join('\n');
}

export function testReport(pass = true): unknown {
  return {
    pass_pct: pass ? 100 : 0,
    cases: [{ case_id: 'case:c1', result: pass ? 'pass' : 'fail' }],
  };
}

/** `rs-quality.json` (SCHEMAS §24) — a valid cited quality pass for the
 *  prd stage. `findings` empty = the explicit clean pass; the runner
 *  fails closed on a missing/malformed/partial artifact. */
export function rsQualityDoc(
  id: string,
  findings: Record<string, unknown>[] = [],
): unknown {
  return {
    schema: 1,
    subject: id,
    doc_version: 1,
    evidence_ref: 'retrieval-evidence.json',
    dimensions_checked: [...RS_QUALITY_DIMENSIONS],
    findings,
    generated_at: '2026-10-05T00:00:00Z',
  };
}

/** `findings-<pass>.json` fragment — a JSON array (SCHEMAS §6 input
 *  shape; runner computes fingerprint/thread_id). */
export function findingsFragment(
  findings: Record<string, unknown>[] = [],
): unknown[] {
  return findings;
}

// ---------------------------------------------------------------------------
// makeFixtureWorld
// ---------------------------------------------------------------------------

export interface WorldOptions {
  /** Per-run script: (subject, stage, attempt) → spec. */
  script: ScriptFn;
  /** Merged over the fixture config (gates, timeouts, budgets…). */
  configOverrides?: Record<string, unknown>;
  /** Extra/override ticket.md contents keyed by ticket id; null drops
   *  the fixture ticket. Seeded as `tickets` rows + `doc_versions`. */
  tickets?: Record<string, string | null>;
}

export interface FixtureWorld {
  dir: string;
  codeRepo: string;
  runsDir: string;
  workspace: string;
  store: PostgresStore;
  conductor: Conductor;
  adapter: ScriptedAdapter;
  config: EffectiveConfig;

  tick(): Promise<TickReport>;
  /** Tick (with inter-tick sleeps for child runtime) until the ticket's
   *  `tickets` row status equals `status`. Throws with diagnostics. */
  runToStatus(
    ticketId: string,
    status: string,
    maxTicks?: number,
  ): Promise<void>;
  /** Tick until an OPEN `gate_items` row exists for (subject, gate). */
  waitForGate(
    subject: string,
    gate: string,
    maxTicks?: number,
  ): Promise<GateItem>;
  /**
   * Simulate the human: clear the gate_items row like the API does.
   * `answers` writes `{questions:[…, status:'answered', answer]}` back
   * into the newest triage.json/design.json run_artifacts row for the
   * subject (needs-info → triage.json, design-qa → design.json) — the
   * same doc the transitions read (D29).
   */
  clearGate(
    subject: string,
    gate: string,
    opts?: { answers?: Record<string, string> | string[] },
  ): Promise<void>;
  readTicket(id: string): Promise<TicketRow>;
  /** `status:` line from the ticket.md `doc_versions` content. */
  docStatus(id: string): Promise<string>;
  eventsFor(id: string): Promise<EventRow[]>;
  runsFor(subject: string): Promise<import('@sprint-runner/core').RunRow[]>;
  gateItems(open?: boolean): Promise<GateItem[]>;
  dispose(): Promise<void>;
}

function gitInit(repo: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
}

function makeConfig(
  codeRepo: string,
  overrides: Record<string, unknown>,
): EffectiveConfig {
  return resolveConfig(null, {
    config: {
      actor: 'e2e-bot',
      backend: 'mock',
      repos: {
        'code-repo': {
          path: codeRepo,
          card: {
            test: 'make test',
            lint: 'make lint',
            build: 'make build',
            forbidden_paths: [],
            probed_at: '2026-10-03T00:00:00Z',
            verified: true,
          },
        },
      },
      security: { scan_on_commit: false },
      ...overrides,
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

/** Seed one ticket: parse the ticket.md, write the `tickets` row +
 *  the `ticket.md` doc_version. Fail-closed — a malformed fixture is a
 *  test bug, so throw. */
async function seedTicket(
  store: Store,
  workspace: string,
  id: string,
  raw: string,
  now: string,
): Promise<void> {
  const parsed = parseTicketMd(raw, `${id}/ticket.md`);
  if (!parsed.ok) {
    throw new Error(`fixture ticket ${id}: ${parsed.error.error}`);
  }
  const fm = parsed.value.frontmatter;
  await store.upsertTicket({
    workspace,
    ticket_id: id,
    feature: fm.feature ?? null,
    title: fm.title,
    status: fm.status,
    priority: fm.priority,
    depth: fm.depth ?? null,
    backend: fm.backend ?? null,
    model: fm.model ?? null,
    repos: fm.repos,
    parent: fm.parent ?? null,
    depends_on: fm.depends_on,
    source: fm.source ?? null,
    forced: fm.forced ?? false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: fm.blocked_reason ?? null,
    created_at: now,
    updated_at: now,
  });
  await store.appendDocVersion(
    { workspace, subject: id, doc: 'ticket.md' },
    raw,
    'e2e-seed',
  );
}

export async function makeFixtureWorld(
  opts: WorldOptions,
): Promise<FixtureWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'sr-e2e-'));
  const codeRepo = join(dir, 'code-repo');
  const runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });
  gitInit(codeRepo);

  const store = await PostgresStore.connect('pglite:');

  // --- seed the DB from the fixture ticket docs (D29 — rows + doc
  //     versions are truth; fixtures/tickets-repo is just canned
  //     markdown now) ---
  const now = new Date().toISOString();
  const ticketsDir = join(TICKETS_FIXTURE, 'tickets');
  for (const id of readdirSync(ticketsDir)) {
    if (opts.tickets?.[id] === null) continue;
    const raw =
      opts.tickets?.[id] ??
      readFileSync(join(ticketsDir, id, 'ticket.md'), 'utf8');
    await seedTicket(store, WS, id, raw, now);
  }
  for (const [id, raw] of Object.entries(opts.tickets ?? {})) {
    if (raw !== null && !readdirSync(ticketsDir).includes(id)) {
      await seedTicket(store, WS, id, raw, now);
    }
  }

  const adapter = new ScriptedAdapter({ script: opts.script });
  const config = makeConfig(codeRepo, opts.configOverrides ?? {});
  const conductor = new Conductor({
    store,
    adapters: { mock: adapter },
    config,
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir,
    transitions: new RealTransitionHandler(config),
    scan: async () => ({ ok: true as const, scanner: 'stub', findings: [] }),
    stallAfterMs: 300,
    onError: (e) => {
      // Surface async-path errors in test output instead of swallowing.
      console.error('[conductor onError]', e);
    },
  } satisfies ConductorDeps);

  /** Newest run_artifacts row named `name` or `<subject>/<name>` across
   *  the subject's runs — mirrors actions.ticketArtifactText. */
  async function latestArtifact(
    subject: string,
    name: string,
  ): Promise<{ run_id: string; name: string; content: string } | null> {
    const runs = (
      await store.listRuns({ workspace: WS, ticket_id: subject })
    ).sort((a, b) => b.id.localeCompare(a.id));
    for (const r of runs) {
      for (const n of [name, `${subject}/${name}`]) {
        const a = await store.getArtifact(r.id, n);
        if (a) return { run_id: r.id, name: n, content: a.content };
      }
    }
    return null;
  }

  const world: FixtureWorld = {
    dir,
    codeRepo,
    runsDir,
    workspace: WS,
    store,
    conductor,
    adapter,
    config,

    tick: () => conductor.tick(),

    async runToStatus(ticketId, status, maxTicks = 600) {
      for (let i = 0; i < maxTicks; i++) {
        await conductor.tick();
        const t = await store.getTicket({ workspace: WS, ticket_id: ticketId });
        if (t?.status === status) return;
        await sleep(40);
      }
      const t = await store.getTicket({ workspace: WS, ticket_id: ticketId });
      const runs = (await store.listRuns({ workspace: WS, subject: ticketId }))
        .map((r) => `${r.stage}#${r.attempt}:${r.status}:${r.sentinel ?? '-'}`)
        .join(', ');
      const events = (
        await store.listEvents({ workspace: WS, ticket_id: ticketId })
      )
        .slice(-12)
        .map((e) => `${e.event}(${e.stage ?? ''})`)
        .join(' → ');
      throw new Error(
        `runToStatus(${ticketId} → ${status}) timed out after ${maxTicks} ticks; ` +
          `status=${t?.status ?? 'missing'}; runs=[${runs}]; events: ${events}`,
      );
    },

    async waitForGate(subject, gate, maxTicks = 600) {
      for (let i = 0; i < maxTicks; i++) {
        await conductor.tick();
        const item = await store.getGateItem({ workspace: WS, subject, gate });
        if (item && item.cleared_at === null) return item;
        await sleep(40);
      }
      throw new Error(`waitForGate(${subject}, ${gate}) timed out`);
    },

    async clearGate(subject, gate, opts2 = {}) {
      if (opts2.answers) {
        const file = gate === 'design-qa' ? 'design.json' : 'triage.json';
        const art = await latestArtifact(subject, file);
        const doc: { questions?: Record<string, unknown>[] } = art
          ? (JSON.parse(art.content) as typeof doc)
          : { questions: [] };
        const answers = Array.isArray(opts2.answers)
          ? opts2.answers
          : Object.values(opts2.answers);
        const questions = doc.questions ?? [];
        for (let i = 0; i < questions.length; i++) {
          questions[i] = {
            ...questions[i],
            status: 'answered',
            answer: answers[i] ?? answers[0] ?? 'answered in e2e',
          };
        }
        doc.questions = questions;
        await store.putArtifact({
          run_id:
            art?.run_id ??
            // No carrier run yet (gate surfaced without a questions
            // file) — attach the answered doc to the latest run anyway.
            (await store.listRuns({ workspace: WS, ticket_id: subject })).sort(
              (a, b) => b.id.localeCompare(a.id),
            )[0]?.id ??
            'orphan',
          name: art?.name ?? file,
          content: `${JSON.stringify(doc, null, 2)}\n`,
          created_at: new Date().toISOString(),
        });
      }
      await store.clearGateItem(
        { workspace: WS, subject, gate },
        new Date().toISOString(),
      );
    },

    readTicket: async (id) => {
      const t = await store.getTicket({ workspace: WS, ticket_id: id });
      if (!t) throw new Error(`no ticket row for ${id}`);
      return t;
    },

    docStatus: async (id) =>
      /^status:\s*(\S+)/m.exec(
        (await store.getDoc({ workspace: WS, subject: id, doc: 'ticket.md' }))
          ?.content ?? '',
      )?.[1] ?? '',

    eventsFor: (id) => store.listEvents({ workspace: WS, ticket_id: id }),
    runsFor: (subject) => store.listRuns({ workspace: WS, subject }),
    gateItems: (open) =>
      store.listGateItems(
        open === undefined ? { workspace: WS } : { workspace: WS, open },
      ),

    async dispose() {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
}

/** Minimal v1 ticket.md for planted tickets. */
export function ticketMd(opts: {
  id: string;
  status: string;
  priority?: string;
  depth?: string;
  title?: string;
}): string {
  return [
    '---',
    'schema: 1',
    `id: ${opts.id}`,
    `title: ${opts.title ?? `E2E ${opts.id}`}`,
    `status: ${opts.status}`,
    `priority: ${opts.priority ?? 'medium'}`,
    'repos: [code-repo]',
    ...(opts.depth ? [`depth: ${opts.depth}`] : []),
    '---',
    '',
    '## Description',
    'E2E fixture ticket.',
    '',
    '## Acceptance criteria',
    '- [ ] it works',
    '',
  ].join('\n');
}
