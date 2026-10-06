/**
 * MockAdapter (wp-021) — the scripted test backend implementing the
 * ADAPTERS.md contract. `run()` spawns a real detached child process
 * (`node agent.mjs`, pure Node, shipped in this package) driven by the
 * `MOCK_SCENARIO` env DSL — see src/mock/README.md. Zero LLM spend, real
 * process semantics: pid, log file, signals, heartbeat-by-mtime.
 */
import { type ChildProcess, spawn } from 'node:child_process';
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
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
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
  SENTINELS,
  type Stage,
  type Usage,
  type UsageCallback,
  type UsagePartial,
} from '@veto/core';
import { renderPrompt } from '@veto/prompts';

/** Prefix of the streamed usage line format the agent emits. */
export const USAGE_LINE_PREFIX = 'USAGE ';
export const USAGE_TOTAL_PREFIX = 'USAGE_TOTAL ';

const SENTINEL_SET: ReadonlySet<string> = new Set(SENTINELS);
/** Sentinel shape: NAME or `NAME: payload` — uppercase + dashes. */
const SENTINEL_RE = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)(?::(.*))?$/;

export interface MockRunOptions {
  /** Override the scenario DSL for this run (default: adapter option). */
  scenario?: string;
  /** Explicit artifact dir; default = parsed from the rendered prompt's
   *  ARTIFACT_TARGETS block. */
  artifactDir?: string;
  /** Explicit log path; default = `<artifactDir-parent>/run-<pid>.log` or tmpdir. */
  logPath?: string;
  /** Work delay before the sentinel is printed (agent env). */
  delayMs?: number;
  /** Heartbeat noise interval in ms; 0 disables (agent env). */
  heartbeatMs?: number;
  /** Ignore SIGTERM — exercises the SIGKILL escalation path. */
  ignoreTerm?: boolean;
}

export interface MockAdapterOptions {
  /** Capability flags — default {can_exec:true, can_write_outside_tree:true, has_gh:false}. */
  capabilities?: Partial<CapabilityFlags>;
  /** Default scenario when neither run opts nor MOCK_SCENARIO env set one. */
  scenario?: string;
  /** Path to the agent script — default: shipped src/mock/agent.mjs. */
  agentScript?: string;
  /** SIGTERM → SIGKILL grace period (ADAPTERS kill spec). Default 500ms. */
  killGraceMs?: number;
  /** on_usage log-tail poll interval. Default 50ms. */
  usagePollMs?: number;
  /** Default work delay before the sentinel (agent env). */
  delayMs?: number;
  /** Default heartbeat noise interval in ms (agent env). */
  heartbeatMs?: number;
}

interface MockRunRecord {
  child: ChildProcess;
  logPath: string;
  artifactDir: string;
  /** Artifact dir lives inside the worktree (scratch) → copy into
   *  ctx.run_dir + purge on collect (ADAPTERS ARTIFACT_TARGETS). */
  scratch: boolean;
  promptChars: number;
  startedAt: number;
  exitCode: number | null;
  exited: boolean;
  exitPromise: Promise<void>;
  usageTimer: NodeJS.Timeout | null;
  usageOffset: number;
}

const DEFAULT_CAPABILITIES: CapabilityFlags = {
  can_exec: true,
  can_write_outside_tree: true,
  has_gh: false,
  can_signal: true,
  streams_usage: true,
};

function defaultAgentScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Running from src (vitest) or dist (built) — agent.mjs is copied to
  // dist by the package build script.
  for (const candidate of [
    join(here, 'agent.mjs'),
    join(here, '../../src/mock/agent.mjs'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(here, 'agent.mjs');
}

/** Extract the artifact dir from a rendered prompt's ARTIFACT_TARGETS
 *  block (the renderer emits `<dir>/ (absolute …)` or
 *  `.veto/<id>/ (worktree-relative …)`). */
export function parseArtifactDir(
  renderedText: string,
  worktree: string,
): string | null {
  // The renderer inlines ARTIFACT_TARGETS (e.g. "Artifact paths: <dir>/ (absolute …)"),
  // so match anywhere in a line, not anchored.
  const abs = renderedText.match(/(\/\S+)\/ \(absolute/);
  if (abs?.[1]) return abs[1];
  const rel = renderedText.match(/(\.veto\/\S+)\/ \(worktree-relative/);
  if (rel?.[1]) return join(worktree, rel[1]);
  return null;
}

/** Parse one `USAGE {json}` line → UsagePartial, or null. */
export function parseUsageLine(line: string): UsagePartial | null {
  if (
    !line.startsWith(USAGE_LINE_PREFIX) ||
    line.startsWith(USAGE_TOTAL_PREFIX)
  )
    return null;
  try {
    const parsed = JSON.parse(
      line.slice(USAGE_LINE_PREFIX.length),
    ) as Partial<UsagePartial>;
    if (
      typeof parsed.tokens_in === 'number' &&
      typeof parsed.tokens_out === 'number' &&
      typeof parsed.tokens_cached === 'number'
    ) {
      return {
        tokens_in: parsed.tokens_in,
        tokens_out: parsed.tokens_out,
        tokens_cached: parsed.tokens_cached,
      };
    }
  } catch {
    /* malformed — skip */
  }
  return null;
}

/** Bound on the collect() pid-poll fallback (untracked handle). */
const COLLECT_PID_WAIT_MS = 60_000;

function pidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Recursively list files under dir, returned as absolute paths. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

function lastNonEmptyLine(logPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim();
    if (line !== '') return line;
  }
  return null;
}

export class MockAdapter implements Adapter {
  readonly name: Adapter['name'] = 'mock';
  readonly capabilities: CapabilityFlags;

  readonly #opts: Required<
    Pick<MockAdapterOptions, 'killGraceMs' | 'usagePollMs'>
  > &
    MockAdapterOptions;
  readonly #records = new Map<number, MockRunRecord>();
  readonly #agentScript: string;

  constructor(options: MockAdapterOptions = {}) {
    this.capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...(options.capabilities ?? {}),
    };
    this.#opts = { killGraceMs: 500, usagePollMs: 50, ...options };
    this.#agentScript = options.agentScript ?? defaultAgentScript();
  }

  prepare(subject: string, stage: string, ctx: PrepareContext): RenderedPrompt {
    return renderPrompt(stage as Stage, {
      flags: this.capabilities,
      runId: ctx.run_id,
      runDir: ctx.run_dir,
      worktree: ctx.workspace,
      tokens: {
        TICKET_ID: subject,
        TICKET_DIR: ctx.ticket_dir ?? '',
        ...(ctx.tokens ?? {}),
      },
    });
  }

  run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
    opts?: MockRunOptions | RunOpts,
  ): RunHandle {
    // D30 RunOpts fields (run_dir/container_id) don't apply to the
    // mock backend — only the MockRunOptions fields are read.
    const mopts = opts as MockRunOptions | undefined;
    const artifactDir =
      mopts?.artifactDir ??
      parseArtifactDir(rendered.text, worktree) ??
      join(tmpdir(), `veto-mock-${Date.now()}`);
    mkdirSync(artifactDir, { recursive: true });

    // In-tree artifact dirs are the `.veto/<run-id>/` scratch
    // contract — the log must live INSIDE the leaf so collectArtifacts
    // moves it into run_dir as `run.log` (SKIP_FILES) instead of
    // stranding a `mock-run-*.log` sibling that trips the residue
    // check for `can_write_outside_tree: false` backends.
    const logPath =
      mopts?.logPath ??
      (isInsideTree(worktree, artifactDir)
        ? join(artifactDir, 'run.log')
        : join(dirname(artifactDir), `mock-run-${Date.now()}.log`));
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, 'a');

    const child = spawn(process.execPath, [this.#agentScript], {
      cwd: worktree,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        MOCK_SCENARIO:
          mopts?.scenario ??
          this.#opts.scenario ??
          process.env.MOCK_SCENARIO ??
          'done',
        MOCK_ARTIFACT_DIR: artifactDir,
        MOCK_DELAY_MS: String(mopts?.delayMs ?? this.#opts.delayMs ?? 50),
        MOCK_HEARTBEAT_MS: String(
          mopts?.heartbeatMs ?? this.#opts.heartbeatMs ?? 100,
        ),
        MOCK_TIMEOUT_S: String(timeout > 0 ? timeout : 0),
        ...(mopts?.ignoreTerm ? { MOCK_IGNORE_TERM: '1' } : {}),
      },
    });
    closeSync(logFd);
    child.unref();

    if (child.pid === undefined) {
      throw new Error(
        `mock agent spawn failed — no pid (${this.#agentScript})`,
      );
    }
    const pid = child.pid;
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => {
      resolveExit = r;
    });
    const record: MockRunRecord = {
      child,
      logPath,
      artifactDir,
      scratch: isInsideTree(worktree, artifactDir),
      promptChars: rendered.text.length,
      startedAt: Date.now(),
      exitCode: null,
      exited: false,
      exitPromise,
      usageTimer: null,
      usageOffset: 0,
    };
    child.on('exit', (code, signal) => {
      record.exited = true;
      record.exitCode =
        code ?? (signal === 'SIGKILL' ? 137 : signal === 'SIGTERM' ? 143 : 1);
      if (record.usageTimer) clearInterval(record.usageTimer);
      resolveExit();
    });
    // A failed spawn emits 'error' and NEVER 'exit' — without this the
    // error is unhandled and collect() would hang on exitPromise.
    child.once('error', () => {
      record.exited = true;
      record.exitCode = record.exitCode ?? 1;
      if (record.usageTimer) clearInterval(record.usageTimer);
      resolveExit();
    });
    this.#records.set(pid, record);
    return { pid, log_path: logPath };
  }

  async control(handle: RunHandle, op: ControlOp): Promise<void> {
    const pid = handle.pid;
    // Never signal pid 0/undefined — kill(0) targets this conductor's
    // own process group. A pid-less handle carries no signalable child.
    if (typeof pid !== 'number' || pid <= 0) {
      if (op === 'kill') return; // nothing alive to kill
      throw new Error(
        `mock control '${op}': handle has no pid — nothing to signal`,
      );
    }
    if (op === 'pause') {
      process.kill(pid, 'SIGSTOP');
      return;
    }
    if (op === 'resume') {
      process.kill(pid, 'SIGCONT');
      return;
    }
    // kill: SIGTERM → SIGKILL after grace (ADAPTERS control contract)
    if (!pidAlive(pid)) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    const deadline = Date.now() + this.#opts.killGraceMs;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return;
      await sleep(25);
    }
    if (pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
  }

  on_usage(handle: RunHandle, cb: UsageCallback): void {
    const record = this.#records.get(handle.pid);
    if (!record || record.usageTimer) return;
    record.usageTimer = setInterval(() => {
      try {
        const fd = openSync(record.logPath, 'r');
        const size = statSync(record.logPath).size;
        if (size <= record.usageOffset) {
          closeSync(fd);
          return;
        }
        const buf = Buffer.alloc(size - record.usageOffset);
        const read = readSync(fd, buf, 0, buf.length, record.usageOffset);
        closeSync(fd);
        record.usageOffset += read;
        for (const line of buf.subarray(0, read).toString('utf8').split('\n')) {
          const partial = parseUsageLine(line.trim());
          if (partial) cb(partial);
        }
      } catch {
        /* log not written yet */
      }
    }, this.#opts.usagePollMs);
    record.usageTimer.unref();
  }

  async collect(handle: RunHandle, ctx: CollectContext): Promise<RunResult> {
    const record = this.#records.get(handle.pid);

    // Wait until exit (detached child — 'exit' event or pid poll).
    if (record) {
      await record.exitPromise;
    } else {
      // No tracked child (conductor restart) — poll pid liveness, but
      // bounded: a pid that never dies can't hang collect forever.
      const deadline = Date.now() + COLLECT_PID_WAIT_MS;
      while (pidAlive(handle.pid) && Date.now() < deadline) {
        await sleep(50);
      }
    }

    const raw = lastNonEmptyLine(handle.log_path);
    const sentinel = raw !== null ? MockAdapter.parseSentinel(raw) : null;

    // Scratch-dir collection: copy artifacts into ctx.run_dir, purge
    // (ADAPTERS ARTIFACT_TARGETS — the diff never sees them). D29: the
    // run dir lives under the workspace root, so "inside the tree" no
    // longer implies scratch — only copy/purge when the artifact dir is
    // a DIFFERENT directory than the collect target.
    if (record?.scratch && record.artifactDir !== ctx.run_dir) {
      mkdirSync(ctx.run_dir, { recursive: true });
      for (const file of listFiles(record.artifactDir)) {
        const rel = relative(record.artifactDir, file);
        const dest = join(ctx.run_dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(file, dest);
      }
      rmSync(record.artifactDir, { recursive: true, force: true });
    }

    const artifactRoot = record?.scratch
      ? ctx.run_dir
      : (record?.artifactDir ?? ctx.run_dir);
    const artifacts = listFiles(artifactRoot);

    const usage = this.#extractUsage(handle.log_path, record, ctx);
    if (record?.usageTimer) clearInterval(record.usageTimer);

    return {
      sentinel,
      sentinel_raw: raw,
      artifacts,
      usage,
      exit_code: record?.exitCode ?? null,
    };
  }

  /** Sentinel NAME from the last non-empty line, or null when the line
   *  isn't a known sentinel (CONDUCTOR: missing/unparseable → run_failed). */
  static parseSentinel(lastLine: string): string | null {
    const m = lastLine.match(SENTINEL_RE);
    if (!m?.[1]) return null;
    return SENTINEL_SET.has(m[1]) ? m[1] : null;
  }

  /** Usage extraction — never fails the run (ADAPTERS failure mapping:
   *  absent → `source: estimated` with a labeled token estimate). */
  #extractUsage(
    logPath: string,
    record: MockRunRecord | undefined,
    ctx: CollectContext,
  ): Usage {
    const ticket = ctx.ticket_dir ? basename(ctx.ticket_dir) : '';
    const base = {
      schema: 1 as const,
      ticket,
      run: ctx.run_id,
      backend: 'mock',
      model: 'mock',
    };
    const durationS = record ? (Date.now() - record.startedAt) / 1000 : 0;
    try {
      const text = readFileSync(logPath, 'utf8');
      const calls = text
        .split('\n')
        .map((l) => parseUsageLine(l.trim()))
        .filter((u): u is UsagePartial => u !== null);
      const totalLine = text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith(USAGE_TOTAL_PREFIX));
      const totals =
        totalLine !== undefined
          ? (JSON.parse(totalLine.slice(USAGE_TOTAL_PREFIX.length)) as {
              tokens_in: number;
              tokens_out: number;
              tokens_cached: number;
              cost_usd?: number | null;
            })
          : calls.reduce(
              (acc, u) => ({
                tokens_in: acc.tokens_in + u.tokens_in,
                tokens_out: acc.tokens_out + u.tokens_out,
                tokens_cached: acc.tokens_cached + u.tokens_cached,
                cost_usd: null as number | null,
              }),
              {
                tokens_in: 0,
                tokens_out: 0,
                tokens_cached: 0,
                cost_usd: null as number | null,
              },
            );
      if (calls.length > 0 || totalLine !== undefined) {
        return {
          ...base,
          granularity: calls.length > 0 ? 'per-call' : 'run-aggregate',
          totals: {
            tokens_in: totals.tokens_in,
            tokens_out: totals.tokens_out,
            tokens_cached: totals.tokens_cached,
            cost_usd: totals.cost_usd ?? null,
            duration_s: durationS,
          },
          calls: calls.map((u, i) => ({
            seq: i,
            ts: new Date().toISOString(),
            model: 'mock',
            tokens_in: u.tokens_in,
            tokens_out: u.tokens_out,
            tokens_cached: u.tokens_cached,
            latency_s: 0,
            source: 'reported' as const,
          })),
          source: 'reported',
        };
      }
      // No usage lines → labeled estimate (ADAPTERS estimation fallback:
      // tokens_in is exact-ish from the rendered prompt, tokens_out
      // estimated from log volume).
      return {
        ...base,
        granularity: 'run-aggregate',
        totals: {
          tokens_in: Math.ceil((record?.promptChars ?? 0) / 4),
          tokens_out: Math.ceil(text.length / 4),
          tokens_cached: 0,
          cost_usd: null,
          duration_s: durationS,
        },
        calls: [],
        source: 'estimated',
        notes: 'mock adapter: no USAGE lines — estimated from prompt/log size',
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
        notes: 'mock adapter: usage extraction failed',
      };
    }
  }
}

/** Resolve a path relative to the worktree — exported for tests. */
export function isInsideTree(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
