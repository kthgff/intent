/**
 * DevinAdapter — devin backend per ADAPTERS.md / wp-022.
 *
 * `devin -p --prompt-file <runDir>/prompt.md --permission-mode <mode>
 * --export <runDir>/export.json --respect-workspace-trust false
 * [--model <model>]` spawned detached in the worktree; stdout/stderr →
 * `<runDir>/devin.log`. collect() parses the LAST non-empty log line as
 * the sentinel and extracts usage from export.json (usage.ts).
 */
import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import {
  type Adapter,
  type CapabilityFlags,
  type CollectContext,
  type ControlOp,
  type PrepareContext,
  type RenderedPrompt,
  type RunHandle,
  type RunOpts,
  type RunResult,
  SentinelSchema,
  type Stage,
  type UsageCallback,
} from '@sprint-runner/core';
import { STAGE_TEMPLATES, renderPrompt } from '@sprint-runner/prompts';
import { findDevinBinary } from './binary.js';
import { usageFromExport } from './usage.js';

/** Grace between SIGTERM and SIGKILL on `kill` (ADAPTERS control contract). */
const KILL_GRACE_MS = 5000;

/** Real devin `--permission-mode` values (verified 2026-10-03 spike). */
const DEVIN_PERMISSION_MODES = new Set([
  'auto',
  'accept-edits',
  'smart',
  'dangerous',
]);

/**
 * Config `permission_mode` (SETTINGS enum: smart|bypass|accept-edits)
 * → real devin mode. `bypass`→`dangerous` (v0 name), `smart`/`accept-edits`
 * pass through; the real devin modes `auto`/`dangerous` are also accepted
 * verbatim. Anything else → error at adapter init (fail-closed).
 */
export function mapPermissionMode(mode: string): string {
  switch (mode) {
    case 'bypass':
      return 'dangerous';
    case 'smart':
    case 'accept-edits':
      return mode;
    default:
      if (DEVIN_PERMISSION_MODES.has(mode)) return mode;
      throw new DevinAdapterError(
        `unknown permission_mode '${mode}' — expected one of smart|bypass|accept-edits (config) or auto|accept-edits|smart|dangerous (devin)`,
      );
  }
}

export class DevinAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevinAdapterError';
  }
}

export interface DevinAdapterOptions {
  /** Resolved binary path/'devin'. Defaults to findDevinBinary() — missing
   *  binary → clean error at construction (acceptance criterion). */
  binary?: string;
  /** Config permission_mode — mapped via {@link mapPermissionMode}. */
  permissionMode?: string;
  /** Model override → `--model`. */
  model?: string;
  /** Run dir when the conductor doesn't flow run_dir through prepare(). */
  runDir?: string;
  /** Ticket id for usage.json `ticket` field (CollectContext gap). */
  ticket?: string;
  /** Kill grace override (ms) — tests. */
  killGraceMs?: number;
}

interface TrackedChild {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: string | null }>;
  timedOut: boolean;
}

export class DevinAdapter implements Adapter {
  readonly name = 'devin' as const;
  readonly capabilities: CapabilityFlags = {
    can_exec: true,
    can_write_outside_tree: true,
    has_gh: true,
    can_signal: true,
    streams_usage: false,
  };

  private readonly binary: string;
  private readonly permissionMode: string;
  private readonly model?: string;
  private readonly killGraceMs: number;
  private readonly ticket?: string;
  private readonly defaultRunDir?: string;
  private lastRunDir?: string;
  /** Per-run model pin from prepare()'s PrepareContext (wp-155) —
   *  consumed by the next run() so a stale pin can't leak forward. */
  private pendingModel: string | undefined;
  /** Model the most recent run() actually spawned with — usage ledger. */
  private lastUsedModel: string | undefined;
  private readonly children = new Map<number, TrackedChild>();

  constructor(opts: DevinAdapterOptions = {}) {
    this.binary = opts.binary ?? findDevinBinary();
    this.permissionMode = mapPermissionMode(opts.permissionMode ?? 'smart');
    if (opts.model !== undefined) this.model = opts.model;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    if (opts.ticket !== undefined) this.ticket = opts.ticket;
    if (opts.runDir !== undefined) this.defaultRunDir = opts.runDir;
  }

  prepare(
    _subject: string,
    stage: string,
    ctx: PrepareContext,
  ): RenderedPrompt {
    this.lastRunDir = ctx.run_dir;
    // wp-155: the per-run pin rides PrepareContext — takes precedence
    // over the constructor default for the next run() only.
    this.pendingModel = ctx.model ?? ctx.route?.model ?? undefined;
    if (!(stage in STAGE_TEMPLATES)) {
      throw new DevinAdapterError(`unknown stage '${stage}'`);
    }
    return renderPrompt(stage as Stage, {
      ...(ctx.tokens !== undefined ? { tokens: ctx.tokens } : {}),
      flags: this.capabilities,
      runId: ctx.run_id,
      runDir: ctx.run_dir,
      worktree: ctx.workspace,
    });
  }

  /**
   * Spawn the detached run. `opts` is a run_dir string (legacy) or
   * RunOpts — resolves: explicit param → the run_dir of the most
   * recent prepare() → constructor option. `container_id` is ignored:
   * devin stays `runtime: process` (D30).
   */
  run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
    opts?: RunOpts | string,
  ): RunHandle {
    const runDir = typeof opts === 'string' ? opts : opts?.run_dir;
    const dir = runDir ?? this.lastRunDir ?? this.defaultRunDir;
    if (dir === undefined) {
      throw new DevinAdapterError(
        'no run_dir — call prepare() first, pass runDir, or set opts.runDir',
      );
    }
    mkdirSync(dir, { recursive: true });

    const promptPath = join(dir, 'prompt.md');
    writeFileSync(promptPath, rendered.text, 'utf8');

    const logPath = join(dir, 'devin.log');
    const logFd = openSync(logPath, 'a');

    const args = [
      '-p',
      '--prompt-file',
      promptPath,
      '--permission-mode',
      this.permissionMode,
      '--export',
      join(dir, 'export.json'),
      '--respect-workspace-trust',
      'false',
    ];
    const model = this.pendingModel ?? this.model;
    this.pendingModel = undefined;
    this.lastUsedModel = model;
    if (model !== undefined) args.push('--model', model);

    const spawnOpts: SpawnOptions = {
      cwd: worktree,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    };
    const child = spawn(this.binary, args, spawnOpts);
    closeSync(logFd);
    if (child.pid === undefined) {
      throw new DevinAdapterError('devin spawn failed — no pid');
    }
    child.unref();

    const tracked: TrackedChild = {
      child,
      timedOut: false,
      exit: new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', () => resolve({ code: null, signal: null }));
      }),
    };
    this.children.set(child.pid, tracked);

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
    const tracked = this.children.get(handle.pid);
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

  /** Devin cannot stream per-message usage — never invokes cb. */
  on_usage(_handle: RunHandle, _cb: UsageCallback): void {}

  async collect(handle: RunHandle, ctx: CollectContext): Promise<RunResult> {
    const tracked = this.children.get(handle.pid);
    let exit_code: number | null = null;
    if (tracked !== undefined) {
      const { code } = await tracked.exit;
      exit_code = tracked.timedOut ? 124 : code;
      this.children.delete(handle.pid);
    }

    const { sentinel, sentinel_raw } = parseSentinel(handle.log_path);
    const artifacts = listFiles(ctx.run_dir);
    const usage = usageFromExport(join(ctx.run_dir, 'export.json'), {
      runId: ctx.run_id,
      ...(this.ticket !== undefined ? { ticket: this.ticket } : {}),
      ...((this.lastUsedModel ?? this.model) !== undefined
        ? { model: (this.lastUsedModel ?? this.model) as string }
        : {}),
      promptPath: join(ctx.run_dir, 'prompt.md'),
      logPath: handle.log_path,
    });
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

/** LAST non-empty line of the log → sentinel (CONDUCTOR sentinel table).
 *  `sentinel` is the validated NAME; unrecognized/missing → null while
 *  `sentinel_raw` keeps the line for the failure path. */
export function parseSentinel(logPath: string): {
  sentinel: string | null;
  sentinel_raw: string | null;
} {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return { sentinel: null, sentinel_raw: null };
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = (lines[i] ?? '').trim();
    if (raw === '') continue;
    const colon = raw.indexOf(':');
    const name = (colon === -1 ? raw : raw.slice(0, colon)).trim();
    const arg = colon === -1 ? null : raw.slice(colon + 1).trim();
    const parsed = SentinelSchema.safeParse({ name, arg, raw });
    return {
      sentinel: parsed.success ? parsed.data.name : null,
      sentinel_raw: raw,
    };
  }
  return { sentinel: null, sentinel_raw: null };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && statSync(p).isFile()) {
        out.push(relative(dir, p));
      }
    }
  };
  walk(dir);
  return out.sort();
}
