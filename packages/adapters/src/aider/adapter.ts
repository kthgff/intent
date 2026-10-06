/**
 * AiderAdapter — aider + OpenRouter BYOK backend per ADAPTERS.md /
 * wp-052 (process runtime) + wp-096 (container runtime, D30).
 *
 * `aider --message-file <prompt.md> --yes-always --auto-commits
 * --model openrouter/<model>` runs DETACHED in the worktree;
 * stdout/stderr → `<runDir>/aider.log`. Two launch runtimes:
 *
 *   - `process` — spawned on the host (`--message-file` points at
 *     `<runDir>/prompt.md`); binary resolved via findAiderBinary()
 *     (PATH → AIDER_BIN → pipx/uvx shims — missing = clean init error).
 *   - `container` (D30 default) — `docker exec -w <worktree> -e <names>`
 *     inside the subject's ensured container (run opts `container_id`).
 *     The aider binary lives in the agent image — NO host probe. The
 *     prompt file is delivered through the mounted worktree
 *     (`.veto/prompts/<run-id>.md` — run_dir isn't a mount),
 *     still identical-path per D30. Secrets ride the exec env as bare
 *     `-e NAME` passthrough — values never in argv/logs. control()
 *     maps to docker verbs: kill = `docker kill -s TERM` → grace →
 *     `docker kill`; pause = `docker pause`; resume = `docker unpause`.
 *
 * Capability flags {can_exec: true, can_write_outside_tree: false,
 * has_gh: false} → ARTIFACT_TARGETS renders as the worktree-relative
 * `.veto/<run-id>/` scratch dir; collect() moves scratch
 * artifacts into ctx.run_dir and purges (the diff never sees them —
 * conductor's envops.collectArtifacts is the same seam and runs as a
 * belt-and-suspenders pass; adapters↔conductor dependency direction
 * forbids importing it, so the move is mirrored here). Sentinel parse,
 * usage stream-parse, and artifact collect are runtime-agnostic — the
 * SAME code path serves both runtimes.
 *
 * Usage: per-message `Tokens: …` lines stream-parsed from the log →
 * on_usage callbacks (`streams_usage: true`) and a `per-call`
 * usage.json ledger; cost_usd = tokens × the OpenRouter price table
 * (pricing.ts) — unknown model → null + a warning in usage.notes.
 */
import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type {
  Adapter,
  CapabilityFlags,
  CollectContext,
  ControlOp,
  PrepareContext,
  RenderedPrompt,
  RunHandle,
  RunOpts,
  RunResult,
  Runtime,
  Stage,
  Usage,
  UsageCallback,
  UsagePartial,
} from '@veto/core';
import { STAGE_TEMPLATES, renderPrompt } from '@veto/prompts';
import { parseSentinel } from '../devin/adapter.js';
import { type AiderInvocation, findAiderBinary } from './binary.js';
import { CliDockerExec, type ContainerDockerClient } from './container.js';
import { costUsd, normalizeModelId } from './pricing.js';
import { parseAiderUsageLine } from './usage.js';

/** Grace between SIGTERM and SIGKILL on `kill` (ADAPTERS control
 *  contract — `docker kill -s TERM` → `docker kill` on container runs). */
const KILL_GRACE_MS = 5000;
/** on_usage log-tail poll interval. */
const USAGE_POLL_MS = 250;
/** Rough chars-per-token for the estimation fallback (no tokenizer dep). */
const CHARS_PER_TOKEN = 4;

/** In-container aider invocation (D30): the agent image carries aider
 *  on its PATH — container runs never probe the host for a binary. */
const CONTAINER_INVOCATION: AiderInvocation = {
  bin: 'aider',
  prefixArgs: [],
  source: 'container image PATH',
};

export class AiderAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiderAdapterError';
  }
}

export interface AiderAdapterOptions {
  /** Resolved invocation or a binary path/'aider'. Defaults to
   *  findAiderBinary() — missing binary → clean error at construction. */
  binary?: string | AiderInvocation;
  /** OpenRouter model id — `openrouter/` prefix added when missing
   *  (SETTINGS `main_model` convention). */
  model?: string;
  /** OpenRouter API key → child env `OPENROUTER_API_KEY`. Secrets come
   *  from .env — never logged, never in argv. Defaults to the parent
   *  process env passthrough. */
  openrouterApiKey?: string;
  /** Extra env for the child (secrets etc.). */
  env?: Record<string, string>;
  /** Run dir when the conductor doesn't flow run_dir through prepare(). */
  runDir?: string;
  /** Ticket id for usage.json `ticket` field (CollectContext gap). */
  ticket?: string;
  /** Kill grace override (ms) — tests. */
  killGraceMs?: number;
  /** on_usage poll interval override (ms) — tests. */
  usagePollMs?: number;
  /** Resolved runtime for this adapter (D30): `container` = run()
   *  requires `opts.container_id` and `docker exec`s inside it;
   *  `process` (default) = detached host spawn. The conductor-side
   *  wiring resolves this via `resolveRuntime` (capabilities.<backend>
   *  .runtime override → declared `container` → containers.runtime);
   *  without that wiring the adapter stays a process backend. */
  runtime?: Runtime;
  /** Docker client for container runs — default {@link CliDockerExec}
   *  shells `docker`; the conductor's CliDockerClient satisfies this
   *  surface structurally; tests inject a fake. */
  docker?: ContainerDockerClient;
}

interface TrackedRun {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: string | null }>;
  timedOut: boolean;
  /** Worktree the run executes in — needed for scratch-dir collect. */
  worktree: string;
  runId: string;
  /** D30 exec target — set on container runs. */
  containerId?: string;
  /** Container-runtime prompt file inside the mounted worktree
   *  (`.veto/prompts/<run-id>.md`) — purged at collect. */
  containerPrompt?: string;
  usageTimer: NodeJS.Timeout | null;
  usageOffset: number;
}

export class AiderAdapter implements Adapter {
  readonly name = 'aider' as const;
  /** ADAPTERS aider flags: exec ✓, outside-tree ✗ (scratch-dir
   *  artifacts), gh ✗ (runner-owned push/PR), container-capable (D30 —
   *  `runtime: container` declared; the resolved runtime still comes
   *  from containers.runtime / capabilities.aider.runtime). */
  readonly capabilities: CapabilityFlags = {
    can_exec: true,
    can_write_outside_tree: false,
    has_gh: false,
    can_signal: true,
    streams_usage: true,
    runtime: 'container',
  };

  private readonly invocation: AiderInvocation;
  private readonly model?: string;
  private readonly openrouterApiKey?: string;
  private readonly extraEnv: Record<string, string>;
  private readonly killGraceMs: number;
  private readonly usagePollMs: number;
  private readonly ticket?: string;
  private readonly defaultRunDir?: string;
  private readonly runtime: Runtime;
  private readonly docker: ContainerDockerClient;
  private lastRunDir?: string;
  private lastRunId?: string;
  private readonly runs = new Map<number, TrackedRun>();

  constructor(opts: AiderAdapterOptions = {}) {
    this.runtime = opts.runtime ?? 'process';
    // Container runtime execs aider from the agent image's PATH — the
    // host binary probe would fail closed on machines without a host
    // aider (AGENTS.md: container runs must not depend on one).
    const bin =
      opts.binary ??
      (this.runtime === 'container' ? CONTAINER_INVOCATION : findAiderBinary());
    this.invocation =
      typeof bin === 'string'
        ? { bin, prefixArgs: [], source: 'explicit' }
        : bin;
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.openrouterApiKey !== undefined) {
      this.openrouterApiKey = opts.openrouterApiKey;
    }
    this.extraEnv = opts.env ?? {};
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    this.usagePollMs = opts.usagePollMs ?? USAGE_POLL_MS;
    if (opts.ticket !== undefined) this.ticket = opts.ticket;
    if (opts.runDir !== undefined) this.defaultRunDir = opts.runDir;
    this.docker = opts.docker ?? new CliDockerExec();
  }

  prepare(
    _subject: string,
    stage: string,
    ctx: PrepareContext,
  ): RenderedPrompt {
    this.lastRunDir = ctx.run_dir;
    this.lastRunId = ctx.run_id;
    if (!(stage in STAGE_TEMPLATES)) {
      throw new AiderAdapterError(`unknown stage '${stage}'`);
    }
    // can_write_outside_tree false → renderPrompt emits the
    // `.veto/<run-id>/` scratch ARTIFACT_TARGETS block.
    return renderPrompt(stage as Stage, {
      ...(ctx.tokens !== undefined ? { tokens: ctx.tokens } : {}),
      flags: this.capabilities,
      runId: ctx.run_id,
      runDir: ctx.run_dir,
      worktree: ctx.workspace,
    });
  }

  /** Spawn the detached run — a host process, or `docker exec` inside
   *  the subject's container when `opts.container_id` is set (D30).
   *  `opts.run_dir` resolves: explicit param → the run_dir of the most
   *  recent prepare() → constructor option. */
  run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
    opts?: RunOpts,
  ): RunHandle {
    const dir = opts?.run_dir ?? this.lastRunDir ?? this.defaultRunDir;
    if (dir === undefined) {
      throw new AiderAdapterError(
        'no run_dir — call prepare() first, pass opts.run_dir, or set opts.runDir',
      );
    }
    const containerId = opts?.container_id;
    if (containerId === undefined && this.runtime === 'container') {
      // Fail closed: a container-runtime aider can only run inside the
      // subject's container — silently host-spawning would die on the
      // missing host binary AND break D30 isolation.
      throw new AiderAdapterError(
        "runtime 'container' but run() got no container_id — the " +
          "conductor must ensure the subject's container and pass its id",
      );
    }
    mkdirSync(dir, { recursive: true });

    const runId = this.lastRunId ?? dir.split('/').pop() ?? '';
    const promptPath = join(dir, 'prompt.md');
    writeFileSync(promptPath, rendered.text, 'utf8');

    const logPath = join(dir, 'aider.log');
    const logFd = openSync(logPath, 'a');

    let child: ChildProcess;
    let containerPrompt: string | undefined;
    try {
      if (containerId === undefined) {
        child = this.spawnProcess(worktree, promptPath, logFd);
      } else {
        // D30: the prompt must reach aider through a path the container
        // sees — run_dir isn't mounted, the worktree is (identical
        // path inside and out).
        containerPrompt = join(
          worktree,
          '.veto',
          'prompts',
          `${runId.replaceAll('/', '-')}.md`,
        );
        mkdirSync(dirname(containerPrompt), { recursive: true });
        writeFileSync(containerPrompt, rendered.text, 'utf8');
        child = this.docker.exec(
          containerId,
          {
            workdir: worktree,
            envKeys: this.secretEnvKeys(),
            argv: [this.invocation.bin, ...this.aiderArgs(containerPrompt)],
          },
          {
            stdio: ['ignore', logFd, logFd],
            env: this.childEnv(),
          },
        );
      }
    } finally {
      closeSync(logFd);
    }
    if (child.pid === undefined) {
      throw new AiderAdapterError('aider spawn failed — no pid');
    }
    child.unref();

    const tracked: TrackedRun = {
      child,
      timedOut: false,
      worktree,
      runId,
      ...(containerId !== undefined ? { containerId } : {}),
      ...(containerPrompt !== undefined ? { containerPrompt } : {}),
      usageTimer: null,
      usageOffset: 0,
      exit: new Promise((res) => {
        child.once('exit', (code, signal) => res({ code, signal }));
        child.once('error', () => res({ code: null, signal: null }));
      }),
    };
    this.runs.set(child.pid, tracked);

    if (timeout > 0) {
      const t = setTimeout(() => {
        tracked.timedOut = true;
        this.terminate(tracked);
      }, timeout * 1000);
      t.unref();
    }

    return {
      pid: child.pid,
      log_path: logPath,
      ...(containerId !== undefined ? { container_id: containerId } : {}),
    };
  }

  /** Host-process spawn (`runtime: process`). */
  private spawnProcess(
    worktree: string,
    promptPath: string,
    logFd: number,
  ): ChildProcess {
    const spawnOpts: SpawnOptions = {
      cwd: worktree,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: this.childEnv(),
    };
    return spawn(this.invocation.bin, this.aiderArgs(promptPath), spawnOpts);
  }

  /** The aider argv (minus the binary) — `--message-file` takes the
   *  path aider will actually open: run_dir prompt on the host, the
   *  mounted-worktree copy inside a container. */
  private aiderArgs(messageFile: string): string[] {
    const args = [
      ...this.invocation.prefixArgs,
      '--message-file',
      messageFile,
      '--yes-always',
      '--auto-commits',
    ];
    if (this.model !== undefined) {
      const id = normalizeModelId(this.model);
      args.push('--model', `openrouter/${id}`);
    }
    return args;
  }

  /** Child env — process env + injected secrets. The same env rides
   *  the `docker exec` child so bare `-e NAME` passthrough resolves. */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };
    if (this.openrouterApiKey !== undefined) {
      env.OPENROUTER_API_KEY = this.openrouterApiKey;
    }
    return env;
  }

  /** Env NAMES forwarded into the container as bare `-e NAME` —
   *  secrets only; docker resolves the values from the exec child's
   *  env, keeping them out of argv and logs (D30 secrets rule). */
  private secretEnvKeys(): string[] {
    const keys = new Set(Object.keys(this.extraEnv));
    if (this.openrouterApiKey !== undefined) keys.add('OPENROUTER_API_KEY');
    return [...keys].sort();
  }

  /** ADAPTERS control, per-runtime: process = SIGTERM→SIGKILL grace /
   *  SIGSTOP / SIGCONT; container = `docker kill -s TERM` → grace →
   *  `docker kill` / `docker pause` / `docker unpause` (D30 — the verbs
   *  signal the container, taking the exec'd run with it). */
  async control(handle: RunHandle, op: ControlOp): Promise<void> {
    const tracked = this.runs.get(handle.pid);
    const containerId = tracked?.containerId ?? handle.container_id;
    if (containerId !== undefined) {
      switch (op) {
        case 'pause':
          await this.docker.pause(containerId).catch(() => {});
          return;
        case 'resume':
          await this.docker.unpause(containerId).catch(() => {});
          return;
        case 'kill': {
          await this.dockerKill(containerId, tracked);
          // Belt: the host-side `docker exec` client must not linger
          // after its container died.
          killPid(handle.pid, 'SIGKILL');
          return;
        }
      }
      return;
    }
    switch (op) {
      case 'pause':
        killPid(handle.pid, 'SIGSTOP');
        return;
      case 'resume':
        killPid(handle.pid, 'SIGCONT');
        return;
      case 'kill': {
        killPid(handle.pid, 'SIGTERM');
        if (tracked !== undefined) {
          await Promise.race([tracked.exit, sleep(this.killGraceMs)]);
        } else {
          await sleep(this.killGraceMs);
        }
        if (this.alive(handle.pid)) killPid(handle.pid, 'SIGKILL');
        return;
      }
    }
  }

  /** Container kill sequence (D30): unpause (a paused container can't
   *  be signaled) → `docker kill -s TERM` → grace → `docker kill`
   *  (SIGKILL). Every docker call is best-effort — a dead/gone
   *  container errors the CLI the same way a dead pid errors
   *  process.kill; control() stays post-mortem safe. */
  private async dockerKill(
    containerId: string,
    tracked: TrackedRun | undefined,
  ): Promise<void> {
    await this.docker.unpause(containerId).catch(() => {});
    await this.docker.kill(containerId, 'TERM').catch(() => {});
    if (tracked !== undefined) {
      await Promise.race([tracked.exit, sleep(this.killGraceMs)]);
    } else {
      await sleep(this.killGraceMs);
    }
    await this.docker.kill(containerId, 'KILL').catch(() => {});
  }

  /** Stream per-message usage: tail the log, parse `Tokens: …` lines,
   *  invoke cb per parsed line. Unknown formats → no callback
   *  (ADAPTERS on_usage contract). */
  on_usage(handle: RunHandle, cb: UsageCallback): void {
    const tracked = this.runs.get(handle.pid);
    if (tracked === undefined || tracked.usageTimer !== null) return;
    const logPath = handle.log_path;
    tracked.usageTimer = setInterval(() => {
      for (const partial of readNewUsage(logPath, tracked)) cb(partial);
    }, this.usagePollMs);
    tracked.usageTimer.unref();
  }

  async collect(handle: RunHandle, ctx: CollectContext): Promise<RunResult> {
    const tracked = this.runs.get(handle.pid);
    let exit_code: number | null = null;
    if (tracked !== undefined) {
      const { code } = await tracked.exit;
      exit_code = tracked.timedOut ? 124 : code;
      if (tracked.usageTimer !== null) clearInterval(tracked.usageTimer);
      this.runs.delete(handle.pid);
    } else {
      while (this.alive(handle.pid)) await sleep(50);
    }

    const { sentinel, sentinel_raw } = parseSentinel(handle.log_path);

    // Scratch-dir artifact collection (can_write_outside_tree: false —
    // ADAPTERS ARTIFACT_TARGETS). Mirror of conductor envops
    // collectArtifacts: move `.veto/<run-id>/` → run_dir,
    // purge so the diff never sees it. The conductor's own envops pass
    // remains authoritative on the reconcile path; this is the seam.
    const artifacts = this.collectScratch(tracked, ctx);

    const usage = this.extractUsage(handle.log_path, ctx);
    try {
      writeFileSync(
        join(ctx.run_dir, 'usage.json'),
        `${JSON.stringify(usage, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // usage.json write failure never fails the run
    }

    return { sentinel, sentinel_raw, artifacts, usage, exit_code };
  }

  private collectScratch(
    tracked: TrackedRun | undefined,
    ctx: CollectContext,
  ): string[] {
    const scratch =
      tracked !== undefined
        ? join(tracked.worktree, '.veto', tracked.runId)
        : null;
    if (scratch !== null && existsSync(scratch)) {
      mkdirSync(ctx.run_dir, { recursive: true });
      for (const file of listFiles(scratch)) {
        const rel = relative(scratch, file);
        const dest = join(ctx.run_dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(file, dest);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
    // Container-runtime prompt copy — `.veto/prompts/` sits
    // outside the artifact scratch so collect never ingests it; purge
    // best-effort (untracked post-restart runs leave gitignored
    // residue, same convention as the scratch parent).
    if (tracked?.containerPrompt !== undefined) {
      rmSync(tracked.containerPrompt, { force: true });
      try {
        if (readdirSync(dirname(tracked.containerPrompt)).length === 0) {
          rmSync(dirname(tracked.containerPrompt), {
            recursive: true,
            force: true,
          });
        }
      } catch {
        /* prompts dir absent/non-readable — residue is gitignored */
      }
    }
    if (tracked !== undefined) {
      // Remove the scratch parent if now empty.
      const parent = join(tracked.worktree, '.veto');
      try {
        if (readdirSync(parent).length === 0) {
          rmSync(parent, { recursive: true, force: true });
        }
      } catch {
        /* parent absent/non-readable — residue is conductor's problem */
      }
    }
    return listFiles(ctx.run_dir)
      .filter(
        (f) => f !== 'prompt.md' && f !== 'aider.log' && f !== 'usage.json',
      )
      .map((f) => relative(ctx.run_dir, f));
  }

  /** Per-call ledger from `Tokens: …` lines; cost from the price table.
   *  Extraction failure → `source: estimated`, never a run failure. */
  private extractUsage(logPath: string, ctx: CollectContext): Usage {
    const model = this.model ?? '';
    const durationS = 0;
    const base = {
      schema: 1 as const,
      ticket: this.ticket ?? '',
      run: ctx.run_id,
      backend: 'aider',
      model,
    };
    try {
      const text = readFileSync(logPath, 'utf8');
      const calls = text
        .split('\n')
        .map((l) => parseAiderUsageLine(l.trim()))
        .filter((u): u is NonNullable<typeof u> => u !== null);

      if (calls.length === 0) {
        return {
          ...base,
          granularity: 'run-aggregate',
          totals: {
            tokens_in: 0,
            tokens_out: Math.ceil(text.length / CHARS_PER_TOKEN),
            tokens_cached: 0,
            cost_usd: null,
            duration_s: durationS,
          },
          calls: [],
          source: 'estimated',
          notes:
            'aider log carried no recognizable token-usage lines — tokens_out estimated from log volume',
        };
      }

      const tokensIn = calls.reduce((a, c) => a + c.tokens_in, 0);
      const tokensOut = calls.reduce((a, c) => a + c.tokens_out, 0);
      const tokensCached = calls.reduce((a, c) => a + c.tokens_cached, 0);
      const cost = costUsd(model, tokensIn, tokensOut, tokensCached);
      const notes =
        model === ''
          ? 'no model configured — cost_usd null'
          : cost === null
            ? `model '${normalizeModelId(model)}' missing from OpenRouter price table — cost_usd null`
            : undefined;

      const now = new Date().toISOString();
      return {
        ...base,
        granularity: 'per-call',
        totals: {
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          tokens_cached: tokensCached,
          cost_usd: cost,
          duration_s: durationS,
        },
        calls: calls.map((c, i) => ({
          seq: i,
          ts: now,
          model,
          tokens_in: c.tokens_in,
          tokens_out: c.tokens_out,
          tokens_cached: c.tokens_cached,
          latency_s: 0,
          source: 'reported' as const,
        })),
        source: 'reported',
        ...(notes !== undefined ? { notes } : {}),
      };
    } catch {
      return {
        ...base,
        granularity: 'run-aggregate',
        totals: {
          tokens_in: 0,
          tokens_out: 0,
          tokens_cached: 0,
          cost_usd: null,
          duration_s: durationS,
        },
        calls: [],
        source: 'estimated',
        notes: 'aider adapter: usage extraction failed',
      };
    }
  }

  /** Stage-timeout termination — routed per-runtime: container runs
   *  get the docker kill sequence (a client-side kill would orphan the
   *  exec'd process inside the container); process runs get
   *  SIGTERM→SIGKILL. */
  private terminate(tracked: TrackedRun): void {
    if (tracked.containerId !== undefined) {
      void this.dockerKill(tracked.containerId, tracked).then(() => {
        if (tracked.child.pid !== undefined) {
          killPid(tracked.child.pid, 'SIGKILL');
        }
      });
      return;
    }
    const child = tracked.child;
    if (child.pid === undefined) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const pid = child.pid;
    const t = setTimeout(() => {
      if (this.alive(pid)) killPid(pid, 'SIGKILL');
    }, this.killGraceMs);
    t.unref();
  }

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/** Read newly appended log bytes since the last poll → parsed usage
 *  partials. Advances `tracked.usageOffset`. */
function readNewUsage(
  logPath: string,
  tracked: { usageOffset: number },
): UsagePartial[] {
  const out: UsagePartial[] = [];
  try {
    const size = statSync(logPath).size;
    if (size <= tracked.usageOffset) return out;
    const fd = openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(size - tracked.usageOffset);
      const read = readSync(fd, buf, 0, buf.length, tracked.usageOffset);
      tracked.usageOffset += read;
      for (const line of buf.subarray(0, read).toString('utf8').split('\n')) {
        const partial = parseAiderUsageLine(line.trim());
        if (partial !== null) out.push(partial);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* log not written yet */
  }
  return out;
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already dead — control() is best-effort post-mortem
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
