/**
 * Shared conductor dependencies + small OS helpers (wp-030).
 *
 * The conductor is a watcher + scheduler, not a worker (CONDUCTOR.md
 * "Processes"): it never executes stage work inline — it spawns
 * detached runs via adapters and OBSERVES them (pid liveness + log/
 * artifact mtime → `runs.heartbeat_at`; the detached process never
 * touches the DB — DB-SCHEMA rules).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { EffectiveConfig } from '@sprint-runner/config';
import type {
  Adapter,
  RunHandle,
  RunRow,
  Stage,
  Store,
} from '@sprint-runner/core';
import type { TransitionHandler } from '../contracts.js';
import type { ScanResult } from '../envops/index.js';
import type { GhClient } from '../shepherd/gh.js';

/** A tickets repo the conductor is responsible for. */
export interface ConductorWorkspace {
  /** Workspace key — `tickets_repos.<name>` (DB-SCHEMA workspace). */
  name: string;
  /** Absolute path to the local checkout. */
  ticketsRepoPath: string;
}

/**
 * Live-channel event for the API SSE stream (API.md §stream). The
 * conductor emits these AFTER the durable write (store row / events
 * row) completes — the stream is a latency optimization, never the
 * only copy. Additive hook for wp-060; `payload` is the DB-row shape
 * (or a delta) per the API.md event table.
 */
export interface StreamEvent {
  type:
    | 'gate_surfaced'
    | 'gate_cleared'
    | 'run_status'
    | 'run_output'
    | 'usage_partial'
    | 'notification';
  payload: unknown;
}

/** Injectable dependencies for every conductor pass. */
export interface ConductorDeps {
  store: Store;
  /** Backend adapters keyed by backend name ('devin'|'aider'|'mock'). */
  adapters: Record<string, Adapter>;
  config: EffectiveConfig;
  workspaces: ConductorWorkspace[];
  /** Root for `runs/<id>/` artifact dirs. */
  runsDir: string;
  /** Sentinel→transition seam (wp-031). */
  transitions: TransitionHandler;
  /** Wall clock — injectable for tests. */
  now?: () => Date;
  /**
   * Sanitizer scan override (SETTINGS `security.scanner`) — tests inject
   * a stub because gitleaks may be absent on the machine. Default:
   * envops `scanArtifacts` (fail-closed per `security.scan_on_commit`).
   */
  scan?: (paths: string[]) => Promise<ScanResult>;
  /** Lease TTL in seconds (DB-SCHEMA: default 300). */
  leaseTtlS?: number;
  /**
   * Heartbeat staleness budget — a live run with no log/artifact mtime
   * progress for longer than this is `stalled` (DB-SCHEMA: "stalled
   * after ~2 missed ticks"). Default 25s ≈ two 10s ticks.
   */
  stallAfterMs?: number;
  /** Attempt `git pull --rebase` on each workspace every reconcile
   *  (CONDUCTOR loop step 1). Skipped automatically when the checkout
   *  has no `origin` remote. Default true. */
  pull?: boolean;
  /**
   * Shepherd's `gh` client (wp-051 — CONDUCTOR "Shepherd loop").
   * Tests inject a stub; default is `ShellGhClient` (shells `gh` on
   * PATH). The poll runs inside the tick, throttled by
   * `shepherd.poll_interval_s`.
   */
  gh?: GhClient;
  /** Sink for errors on detached async paths (the usage-stream cap
   *  check runs off an adapter callback, outside tick()). */
  onError?: (error: unknown) => void;
  /**
   * Live-channel hook (wp-060 / API.md SSE). Called after each durable
   * write the UI streams — run_status on run row changes, gate_surfaced
   * + notification on gate_items insert, usage_partial on streamed
   * usage. Best-effort; never awaited into the critical path.
   */
  notify?: ((event: StreamEvent) => void) | undefined;
}

export function nowOf(deps: ConductorDeps): Date {
  return deps.now?.() ?? new Date();
}

export function nowIso(deps: ConductorDeps): string {
  return nowOf(deps).toISOString();
}

export function actorOf(deps: ConductorDeps): string {
  return deps.config.actor ?? 'sprint-runner';
}

/** Git commit identity derived from `actor:` (SETTINGS). */
export function gitActor(deps: ConductorDeps): { name: string; email: string } {
  const name = actorOf(deps);
  return { name, email: `${name}@sprint-runner.local` };
}

/** `timeouts.<stage>` lookup — keys use underscores (`ci_fix`). */
export function stageTimeout(deps: ConductorDeps, stage: string): number {
  const key = stage.replaceAll('-', '_');
  return deps.config.timeouts[key] ?? 900;
}

/** Resolve the adapter for a run/ticket backend name, honoring the
 *  frontmatter > config precedence already folded into `backend`. */
export function adapterFor(deps: ConductorDeps, backend: string): Adapter {
  const adapter = deps.adapters[backend];
  if (!adapter) {
    throw new Error(
      `no adapter registered for backend '${backend}' (SETTINGS capabilities:)`,
    );
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// Run-handle persistence — `<run_dir>/handle.json`
// ---------------------------------------------------------------------------

const HANDLE_FILE = 'handle.json';

/** Persist the adapter RunHandle so a restarted conductor can collect/
 *  signal runs it didn't spawn in this process. */
export async function saveHandle(runDir: string, handle: RunHandle) {
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, HANDLE_FILE),
    `${JSON.stringify(handle, null, 2)}\n`,
    'utf8',
  );
}

/** Load a persisted handle; falls back to a pid-only handle when the
 *  run row has one (log_path may be absent — liveness still works). */
export async function loadHandle(run: RunRow): Promise<RunHandle | null> {
  const file = join(run.run_dir ?? '', HANDLE_FILE);
  if (run.run_dir && existsSync(file)) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as RunHandle;
      if (typeof parsed.pid === 'number') return parsed;
    } catch {
      /* fall through to pid-only */
    }
  }
  if (typeof run.pid === 'number') {
    return { pid: run.pid, log_path: join(run.run_dir ?? '', 'run.log') };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conductor-observed liveness + heartbeat (DB-SCHEMA rules)
// ---------------------------------------------------------------------------

export function pidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function mtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Last observed PROGRESS for a run: newest of the run's log mtime and
 * its artifact dir mtime (floored at started_at). Deliberately excludes
 * `runs.heartbeat_at` — the conductor refreshes that itself every tick;
 * staleness must measure the detached process's own output.
 */
export async function lastActivityMs(
  run: RunRow,
  handle: RunHandle | null,
): Promise<number> {
  const candidates = [Date.parse(run.started_at ?? '') || 0];
  if (handle?.log_path) candidates.push(await mtimeMs(handle.log_path));
  if (run.run_dir) candidates.push(await mtimeMs(run.run_dir));
  return Math.max(...candidates);
}

/** Resolve a config repo path — relative paths are anchored at the
 *  tickets repo (SETTINGS `repos.<name>.path`). */
export function resolveRepoPath(
  deps: ConductorDeps,
  ws: ConductorWorkspace,
  repo: string,
): string {
  const p = deps.config.repos[repo]?.path;
  if (!p) throw new Error(`repo '${repo}' not in config repos:`);
  return isAbsolute(p) ? p : resolve(ws.ticketsRepoPath, p);
}
