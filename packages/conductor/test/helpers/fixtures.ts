/**
 * wp-040 E2E fixture world — copies fixtures/tickets-repo +
 * fixtures/code-repo into a tmp dir, `git init`s both, wires a bare
 * file:// remote for the tickets repo (push/pull coverage), and boots a
 * real Conductor over SqliteStore + a scripted MockAdapter +
 * RealTransitionHandler. Zero LLM spend, everything local.
 *
 * The mock agent is `helpers/mock-agent.mjs` — a superset of the shipped
 * agent that additionally writes files into the ticket dir (`files`) and
 * emits arbitrary sentinels (`sentinel`), because transition rows read
 * spec docs from `tickets/<id>/` (tdd.md/test.md lints, triage.json
 * answers), not just run artifacts.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter } from '@sprint-runner/adapters';
import { type EffectiveConfig, resolveConfig } from '@sprint-runner/config';
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
import { commitAll } from '@sprint-runner/gitops';
import { SqliteStore } from '@sprint-runner/store';
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
  /** Absolute-path files written by the child (ticket-dir docs). */
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
  /** Absolute `tickets/<id>/` dir for ticket subjects. */
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

export function prdDoc(id: string): string {
  return [
    `# PRD — ${id}`,
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

export function testDoc(id: string, file = 'src/app.ts'): string {
  return [
    `# Test plan — ${id}`,
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
  /** Drop fixture tickets / add extra ones before git init. Keys are
   *  ticket ids → full ticket.md content or null to delete. */
  tickets?: Record<string, string | null>;
}

export interface FixtureWorld {
  dir: string;
  ticketsRepo: string;
  codeRepo: string;
  remoteDir: string;
  runsDir: string;
  workspace: string;
  store: SqliteStore;
  conductor: Conductor;
  adapter: ScriptedAdapter;
  config: EffectiveConfig;

  tick(): Promise<TickReport>;
  /** Tick (with inter-tick sleeps for child runtime) until the ticket's
   *  projected status equals `status`. Throws with diagnostics. */
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
   * `answers` writes `{questions:[…, status:'answered', answer]}` into
   * the gate's answers doc (needs-info → triage.json, design-qa →
   * design.json) and commits it to the tickets repo first.
   */
  clearGate(
    subject: string,
    gate: string,
    opts?: { answers?: Record<string, string> | string[] },
  ): Promise<void>;
  readTicket(id: string): Promise<TicketRow>;
  /** status: line straight from tickets/<id>/ticket.md on disk. */
  diskStatus(id: string): string;
  ticketDir(id: string): string;
  eventsFor(id: string): Promise<EventRow[]>;
  runsFor(subject: string): Promise<import('@sprint-runner/core').RunRow[]>;
  gateItems(open?: boolean): Promise<GateItem[]>;
  /** tickets/<id>/events.jsonl parsed line-by-line. */
  ledgerFor(id: string): Record<string, unknown>[];
  dispose(): void;
}

function gitInit(repo: string, remote?: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
  if (remote) {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
    execFileSync('git', ['push', '-qu', 'origin', 'main'], { cwd: repo });
  }
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

export async function makeFixtureWorld(
  opts: WorldOptions,
): Promise<FixtureWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'sr-e2e-'));
  const ticketsRepo = join(dir, 'tickets-repo');
  const codeRepo = join(dir, 'code-repo');
  const remoteDir = join(dir, 'tickets-remote.git');
  const runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  cpSync(TICKETS_FIXTURE, ticketsRepo, { recursive: true });
  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });

  // Ticket seed surgery (before git init so seeds are committed clean).
  for (const [id, content] of Object.entries(opts.tickets ?? {})) {
    const tdir = join(ticketsRepo, 'tickets', id);
    if (content === null) {
      rmSync(tdir, { recursive: true, force: true });
    } else {
      mkdirSync(tdir, { recursive: true });
      writeFileSync(join(tdir, 'ticket.md'), content, 'utf8');
    }
  }

  // Bare remote for the tickets repo → reconcile's pull --rebase runs
  // for real over file:// (no network).
  execFileSync('git', ['init', '-qb', 'main', '--bare', remoteDir]);
  gitInit(codeRepo);
  gitInit(ticketsRepo, remoteDir);

  const store = new SqliteStore(`sqlite://${join(dir, 'state.db')}`);
  const adapter = new ScriptedAdapter({ script: opts.script });
  const config = makeConfig(codeRepo, opts.configOverrides ?? {});
  const conductor = new Conductor({
    store,
    adapters: { mock: adapter },
    config,
    workspaces: [{ name: WS, ticketsRepoPath: ticketsRepo }],
    runsDir,
    transitions: new RealTransitionHandler(config),
    scan: async () => ({ ok: true as const, scanner: 'stub', findings: [] }),
    stallAfterMs: 300,
    pull: true,
    onError: (e) => {
      // Surface async-path errors in test output instead of swallowing.
      console.error('[conductor onError]', e);
    },
  } satisfies ConductorDeps);

  const world: FixtureWorld = {
    dir,
    ticketsRepo,
    codeRepo,
    remoteDir,
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
        const path = join(ticketsRepo, 'tickets', subject, file);
        let doc: { questions?: Record<string, unknown>[] } = { questions: [] };
        try {
          doc = JSON.parse(await readFile(path, 'utf8'));
        } catch {
          /* write fresh */
        }
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
        await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
        await commitAll(
          ticketsRepo,
          `human: ${subject} ${gate} answers`,
          HUMAN,
        );
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

    diskStatus: (id) =>
      /^status:\s*(\S+)/m.exec(
        readFileSync(join(ticketsRepo, 'tickets', id, 'ticket.md'), 'utf8'),
      )?.[1] ?? '',

    ticketDir: (id) => join(ticketsRepo, 'tickets', id),

    eventsFor: (id) => store.listEvents({ workspace: WS, ticket_id: id }),
    runsFor: (subject) => store.listRuns({ workspace: WS, subject }),
    gateItems: (open) =>
      store.listGateItems(
        open === undefined ? { workspace: WS } : { workspace: WS, open },
      ),

    ledgerFor(id) {
      try {
        return readFileSync(
          join(ticketsRepo, 'tickets', id, 'events.jsonl'),
          'utf8',
        )
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    },

    dispose() {
      store.close();
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
