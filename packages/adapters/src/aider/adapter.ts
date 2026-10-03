/**
 * AiderAdapter — aider + OpenRouter BYOK backend per ADAPTERS.md /
 * wp-052.
 *
 * `aider --message-file <runDir>/prompt.md --yes-always --auto-commits
 * --model openrouter/<model>` spawned detached in the worktree;
 * stdout/stderr → `<runDir>/aider.log`. Capability flags
 * {can_exec: true, can_write_outside_tree: false, has_gh: false} →
 * ARTIFACT_TARGETS renders as the worktree-relative `.sprint-runner/
 * <run-id>/` scratch dir; collect() moves scratch artifacts into
 * ctx.run_dir and purges (the diff never sees them — conductor's
 * envops.collectArtifacts is the same seam and runs as a belt-and-
 * suspenders pass; adapters↔conductor dependency direction forbids
 * importing it, so the move is mirrored here).
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
  RunResult,
  Stage,
  Usage,
  UsageCallback,
  UsagePartial,
} from '@sprint-runner/core';
import { STAGE_TEMPLATES, renderPrompt } from '@sprint-runner/prompts';
import { parseSentinel } from '../devin/adapter.js';
import { type AiderInvocation, findAiderBinary } from './binary.js';
import { costUsd, normalizeModelId } from './pricing.js';
import { parseAiderUsageLine } from './usage.js';

/** Grace between SIGTERM and SIGKILL on `kill` (ADAPTERS control contract). */
const KILL_GRACE_MS = 5000;
/** on_usage log-tail poll interval. */
const USAGE_POLL_MS = 250;
/** Rough chars-per-token for the estimation fallback (no tokenizer dep). */
const CHARS_PER_TOKEN = 4;

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
}

interface TrackedRun {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: string | null }>;
  timedOut: boolean;
  /** Worktree the run executes in — needed for scratch-dir collect. */
  worktree: string;
  runId: string;
  usageTimer: NodeJS.Timeout | null;
  usageOffset: number;
}

export class AiderAdapter implements Adapter {
  readonly name = 'aider' as const;
  /** ADAPTERS aider flags: exec ✓, outside-tree ✗ (scratch-dir
   *  artifacts), gh ✗ (runner-owned push/PR). */
  readonly capabilities: CapabilityFlags = {
    can_exec: true,
    can_write_outside_tree: false,
    has_gh: false,
    can_signal: true,
    streams_usage: true,
  };

  private readonly invocation: AiderInvocation;
  private readonly model?: string;
  private readonly openrouterApiKey?: string;
  private readonly extraEnv: Record<string, string>;
  private readonly killGraceMs: number;
  private readonly usagePollMs: number;
  private readonly ticket?: string;
  private readonly defaultRunDir?: string;
  private lastRunDir?: string;
  private lastRunId?: string;
  private readonly runs = new Map<number, TrackedRun>();

  constructor(opts: AiderAdapterOptions = {}) {
    const bin = opts.binary ?? findAiderBinary();
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
    // `.sprint-runner/<run-id>/` scratch ARTIFACT_TARGETS block.
    return renderPrompt(stage as Stage, {
      ...(ctx.tokens !== undefined ? { tokens: ctx.tokens } : {}),
      flags: this.capabilities,
      runId: ctx.run_id,
      runDir: ctx.run_dir,
      worktree: ctx.workspace,
    });
  }

  /** Spawn the detached run. `runDir` resolves: explicit param → the
   *  run_dir of the most recent prepare() → constructor option. */
  run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
    runDir?: string,
  ): RunHandle {
    const dir = runDir ?? this.lastRunDir ?? this.defaultRunDir;
    if (dir === undefined) {
      throw new AiderAdapterError(
        'no run_dir — call prepare() first, pass runDir, or set opts.runDir',
      );
    }
    mkdirSync(dir, { recursive: true });

    const promptPath = join(dir, 'prompt.md');
    writeFileSync(promptPath, rendered.text, 'utf8');

    const logPath = join(dir, 'aider.log');
    const logFd = openSync(logPath, 'a');

    const args = [
      ...this.invocation.prefixArgs,
      '--message-file',
      promptPath,
      '--yes-always',
      '--auto-commits',
    ];
    if (this.model !== undefined) {
      const id = normalizeModelId(this.model);
      args.push('--model', `openrouter/${id}`);
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };
    if (this.openrouterApiKey !== undefined) {
      childEnv.OPENROUTER_API_KEY = this.openrouterApiKey;
    }

    const spawnOpts: SpawnOptions = {
      cwd: worktree,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    };
    const child = spawn(this.invocation.bin, args, spawnOpts);
    closeSync(logFd);
    if (child.pid === undefined) {
      throw new AiderAdapterError('aider spawn failed — no pid');
    }
    child.unref();

    const tracked: TrackedRun = {
      child,
      timedOut: false,
      worktree,
      runId: this.lastRunId ?? dir.split('/').pop() ?? '',
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
        this.terminate(child, this.killGraceMs);
      }, timeout * 1000);
      t.unref();
    }

    return { pid: child.pid, log_path: logPath };
  }

  /** ADAPTERS control: kill = SIGTERM → SIGKILL after grace; pause =
   *  SIGSTOP; resume = SIGCONT. */
  async control(handle: RunHandle, op: ControlOp): Promise<void> {
    const tracked = this.runs.get(handle.pid);
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
    // collectArtifacts: move `.sprint-runner/<run-id>/` → run_dir,
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
        ? join(tracked.worktree, '.sprint-runner', tracked.runId)
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
      // Remove the scratch parent if now empty.
      const parent = join(tracked?.worktree ?? '', '.sprint-runner');
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

  private terminate(child: ChildProcess, graceMs: number): void {
    if (child.pid === undefined) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const pid = child.pid;
    const t = setTimeout(() => {
      if (this.alive(pid)) killPid(pid, 'SIGKILL');
    }, graceMs);
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
