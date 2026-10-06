/**
 * Container runtime (D30) — docker client + per-subject container
 * lifecycle (CONDUCTOR "Container lifecycle"; wp-095).
 *
 * The client shells out to the real `docker` CLI — same rule as git/gh
 * (AGENTS.md): never a library binding. Fail-closed: an unreachable
 * daemon is a hard error ONLY for `runtime: container` backends —
 * process-runtime installs never touch this module.
 *
 * Lifecycle (one container per subject, mounted worktrees are the
 * durable state — containers are disposable):
 *
 *   ensure()  — create-if-absent, start-if-stopped (unpauses a paused
 *               container), recreate when the bind-mount set or image
 *               drifted; adopts a same-name managed container left
 *               behind by a conductor crash.
 *   sleep()   — docker stop; row → 'stopped' (gate-park, PR pause).
 *   wake()    — start the recorded container; null when none exists.
 *   teardown()— docker rm -f; row → 'removed'.
 *   sweepOrphans() — every `veto/managed=true` container with no live
 *               containers row or a terminal/missing subject is
 *               removed; unmanaged containers are never touched.
 *
 * Runs execute via `docker exec -w <worktree>` (wp-096); secrets ride
 * the exec env (`-e NAME` passthrough names only — values never appear
 * in argv, never logged).
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Capabilities,
  type CapabilityFlags,
  type ContainerKey,
  type ContainerRow,
  type ContainersConfig,
  type Runtime,
  type Store,
  TERMINAL_STATUSES,
  resolveRuntime,
} from '@veto/core';

/** Labels identifying conductor-owned containers (CONDUCTOR D30). */
export const MANAGED_LABEL = 'veto/managed';
export const SUBJECT_LABEL = 'veto/subject';

/** Image name prefix built from `docker/Dockerfile.agent` (SETTINGS
 *  `containers.image` default). */
export const AGENT_IMAGE_PREFIX = 'veto/agent';

/** PID-1 command keeping a subject container alive between execs
 *  (matches `docker/Dockerfile.agent`'s CMD). */
export const KEEPALIVE_CMD = ['sleep', 'infinity'];

const DEFAULT_DOCKER_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const DOCKER_STOP_TIMEOUT_S = 10;

// ---------------------------------------------------------------------------
// Shell-out layer
// ---------------------------------------------------------------------------

/** A `docker` CLI invocation failed. `stderr` carries docker's own
 *  message — argv values are safe to include (never secrets: exec env
 *  is forwarded by name only). */
export class DockerError extends Error {
  override readonly name = 'DockerError';
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

/** Lifecycle/startup-level failure (daemon missing for a container
 *  backend, foreign container squatting on a veto name, …). */
export class ContainerRuntimeError extends Error {
  override readonly name = 'ContainerRuntimeError';
}

interface DockerCallOptions {
  timeoutMs?: number;
  /** Extra env for the docker CLI process itself. */
  env?: Record<string, string>;
  /** Stdin payload (unused today — here for completeness). */
  input?: string;
}

function runDocker(
  bin: string,
  args: readonly string[],
  opts: DockerCallOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
  return new Promise((res, rej) => {
    execFile(
      bin,
      [...args],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          res({ stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const timedOut =
          (err as { killed?: boolean }).killed === true ||
          err.message.includes('ETIMEDOUT');
        rej(
          new DockerError(
            `docker ${args.join(' ')} failed (${timedOut ? 'timed out' : `exit ${String(err.code)}`}): ${String(stderr).trim()}`,
            args,
            typeof err.code === 'number' ? err.code : null,
            String(stderr),
            timedOut,
          ),
        );
      },
    );
  });
}

const NO_SUCH = /no such (container|object|image)|no such container/i;

function isNotFound(err: unknown): boolean {
  return err instanceof DockerError && NO_SUCH.test(err.stderr);
}

// ---------------------------------------------------------------------------
// DockerClient
// ---------------------------------------------------------------------------

/** Bind-mount spec — host path mounted at the identical container path
 *  unless `destination` overrides (D30 mounts are path-identical). */
export interface DockerMount {
  source: string;
  destination?: string;
}

/** `docker create` spec. */
export interface DockerCreateSpec {
  name: string;
  image: string;
  labels?: Record<string, string>;
  mounts?: DockerMount[];
  /** `--cpus` (docker accepts fractional cpus). */
  cpus?: number;
  /** `--memory` (`4g`, `512m`, …). */
  memory?: string;
  /** `-w` working dir. */
  workdir?: string;
  /** Command + args — must keep PID1 alive between execs
   *  (default `sleep infinity`). */
  argv?: string[];
  /** `--init` (tini PID1 — reaps exec'd orphans). Default true. */
  init?: boolean;
}

/** `docker exec` spec (wp-096 seam). */
export interface DockerExecSpec {
  /** `-w` working dir — the mounted worktree path (identical host-side). */
  workdir?: string;
  /** Env passthrough names → `-e NAME` (value resolved from the exec'd
   *  docker CLI env — secrets NEVER appear in argv). */
  envKeys?: string[];
  /** Explicit `-e K=V` env — non-secret values only (argv-visible). */
  env?: Record<string, string>;
  /** `--user` override. */
  user?: string;
  /** Command + args inside the container. */
  argv: string[];
}

export interface DockerMountInfo {
  source: string;
  destination: string;
  type: string;
}

/** `docker inspect` projection. */
export interface DockerContainerInfo {
  id: string;
  /** Container name without the leading '/'. */
  name: string;
  /** Image ref as given at create (`Config.Image`). */
  image: string;
  /** `State.Status` (created|running|paused|exited|…). */
  status: string;
  running: boolean;
  paused: boolean;
  labels: Record<string, string>;
  mounts: DockerMountInfo[];
  created: string | null;
}

interface InspectJson {
  Id?: string;
  Name?: string;
  Created?: string;
  Config?: { Image?: string; Labels?: Record<string, string> | null };
  State?: { Status?: string; Running?: boolean; Paused?: boolean };
  Mounts?: { Type?: string; Source?: string; Destination?: string }[];
}

function toInfo(raw: InspectJson): DockerContainerInfo {
  const state = raw.State ?? {};
  return {
    id: raw.Id ?? '',
    name: (raw.Name ?? '').replace(/^\//, ''),
    image: raw.Config?.Image ?? '',
    status: state.Status ?? '',
    running: state.Running === true,
    paused: state.Paused === true,
    labels: raw.Config?.Labels ?? {},
    mounts: (raw.Mounts ?? []).map((m) => ({
      source: m.Source ?? '',
      destination: m.Destination ?? '',
      type: m.Type ?? '',
    })),
    created: raw.Created ?? null,
  };
}

/**
 * `docker` CLI client — one `execFile` call per op, injectable binary +
 * timeouts for tests. All methods throw `DockerError` on non-zero exit;
 * lookup methods return `null`/`false` on a clean "not found".
 */
export class CliDockerClient {
  readonly bin: string;
  private readonly timeoutMs: number;
  private readonly env: Record<string, string> | undefined;

  constructor(
    opts: {
      bin?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    } = {},
  ) {
    this.bin = opts.bin ?? 'docker';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
    this.env = opts.env;
  }

  private call(
    args: readonly string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return runDocker(this.bin, args, {
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      ...(this.env !== undefined ? { env: this.env } : {}),
    });
  }

  /** `docker info` — daemon liveness probe. Throws when unreachable. */
  async ping(): Promise<{ serverVersion: string }> {
    const { stdout } = await this.call([
      'info',
      '--format',
      '{{.ServerVersion}}',
    ]);
    return { serverVersion: stdout.trim() };
  }

  /** `docker image inspect` — image presence check. */
  async imageExists(image: string): Promise<boolean> {
    try {
      await this.call(['image', 'inspect', image]);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** `docker build -f <dockerfile> -t <tag> <contextDir>`. */
  async buildImage(opts: {
    tag: string;
    dockerfile: string;
    contextDir: string;
  }): Promise<void> {
    await this.call(
      ['build', '-f', opts.dockerfile, '-t', opts.tag, opts.contextDir],
      { timeoutMs: BUILD_TIMEOUT_MS },
    );
  }

  /** `docker pull <ref>` — for registry images (non-local builds). */
  async pullImage(image: string): Promise<void> {
    await this.call(['pull', image], { timeoutMs: BUILD_TIMEOUT_MS });
  }

  /** `docker create …` → the new container id. */
  async create(spec: DockerCreateSpec): Promise<string> {
    const args = ['create', '--name', spec.name];
    if (spec.init ?? true) args.push('--init');
    for (const [k, v] of Object.entries(spec.labels ?? {})) {
      args.push('--label', `${k}=${v}`);
    }
    for (const m of spec.mounts ?? []) {
      args.push('-v', `${m.source}:${m.destination ?? m.source}`);
    }
    if (spec.cpus !== undefined) args.push('--cpus', String(spec.cpus));
    if (spec.memory !== undefined) args.push('--memory', spec.memory);
    if (spec.workdir !== undefined) args.push('-w', spec.workdir);
    args.push(spec.image, ...(spec.argv ?? KEEPALIVE_CMD));
    const { stdout } = await this.call(args);
    return stdout.trim();
  }

  /** `docker inspect` — null when the container doesn't exist. */
  async inspect(ref: string): Promise<DockerContainerInfo | null> {
    let stdout: string;
    try {
      ({ stdout } = await this.call(['inspect', ref]));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const parsed = JSON.parse(stdout) as InspectJson[];
    const first = parsed[0];
    return first ? toInfo(first) : null;
  }

  async start(id: string): Promise<void> {
    await this.call(['start', id]);
  }

  /** `docker stop [-t secs]` — SIGTERM then SIGKILL after the timeout. */
  async stop(
    id: string,
    timeoutSeconds = DOCKER_STOP_TIMEOUT_S,
  ): Promise<void> {
    await this.call(['stop', '-t', String(timeoutSeconds), id]);
  }

  /** `docker rm` — force covers a still-running container. */
  async rm(id: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.call(['rm', ...(opts.force ? ['-f'] : []), id]);
  }

  async kill(id: string, signal = 'KILL'): Promise<void> {
    await this.call(['kill', '-s', signal, id]);
  }

  async pause(id: string): Promise<void> {
    await this.call(['pause', id]);
  }

  async unpause(id: string): Promise<void> {
    await this.call(['unpause', id]);
  }

  /**
   * `docker exec` argv — the wp-096 adapter seam. `envKeys` entries
   * become bare `-e NAME` (the docker CLI resolves the value from ITS
   * own environment, keeping secrets out of argv); `env` entries become
   * `-e K=V` for non-secret values only.
   */
  execArgv(container: string, spec: DockerExecSpec): string[] {
    const args = ['exec'];
    if (spec.user !== undefined) args.push('--user', spec.user);
    if (spec.workdir !== undefined) args.push('-w', spec.workdir);
    for (const k of spec.envKeys ?? []) args.push('-e', k);
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(container, ...spec.argv);
    return args;
  }

  /** Spawn a detached `docker exec` — stdio/env/spawn opts belong to
   *  the caller (wp-096 pipes stdout to the run log). Passthrough
   *  `envKeys` resolve against the child's `env`, so the caller must
   *  include the values there (spawn env, not argv). */
  exec(
    container: string,
    spec: DockerExecSpec,
    spawnOpts: Parameters<typeof spawn>[2] = {},
  ): ChildProcess {
    return spawn(this.bin, this.execArgv(container, spec), {
      detached: true,
      ...spawnOpts,
    });
  }

  /** `docker exec` to completion — buffered stdout/stderr. */
  async execRun(
    container: string,
    spec: DockerExecSpec,
  ): Promise<{ stdout: string; stderr: string }> {
    return this.call(this.execArgv(container, spec));
  }

  /** Every container carrying `veto/managed=true` (any state — `ps -a`).
   *  Foreign containers are never returned. */
  async listManaged(): Promise<DockerContainerInfo[]> {
    const { stdout } = await this.call([
      'ps',
      '-aq',
      '--filter',
      `label=${MANAGED_LABEL}=true`,
    ]);
    const ids = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (ids.length === 0) return [];
    const { stdout: inspectOut } = await this.call(['inspect', ...ids]);
    return (JSON.parse(inspectOut) as InspectJson[]).map(toInfo);
  }
}

// ---------------------------------------------------------------------------
// Container lifecycle (CONDUCTOR "Container lifecycle" — D30)
// ---------------------------------------------------------------------------

export interface ContainerRuntimeDeps {
  docker: DockerClientLike;
  store: Store;
  /** Resolved `containers:` settings block. */
  containers: ContainersConfig;
  /** Resolved `capabilities:` map — per-backend `runtime` overrides. */
  capabilities?: Record<string, Capabilities | undefined>;
  /** Dockerfile backing `containers.image` — `undefined` auto-resolves
   *  to the repo's `docker/Dockerfile.agent` (used only when the image
   *  is the bundled `veto/agent` one); `null` = pull-only. */
  dockerfile?: string | null;
  /** Keepalive command override (tests with non-coreutils images). */
  command?: string[];
  /** Workspace names this conductor owns. When set, the orphan sweep
   *  only evaluates managed containers whose `veto/subject` label
   *  resolves to one of them — a conductor must never reap another
   *  workspace's containers on a shared daemon. */
  workspaces?: string[];
  now?: () => Date;
}

/** Structural client type — the lifecycle ops need only this surface,
 *  so tests can inject a fake without subclassing. */
export interface DockerClientLike {
  ping(): Promise<{ serverVersion: string }>;
  imageExists(image: string): Promise<boolean>;
  buildImage(opts: {
    tag: string;
    dockerfile: string;
    contextDir: string;
  }): Promise<void>;
  pullImage(image: string): Promise<void>;
  create(spec: DockerCreateSpec): Promise<string>;
  inspect(ref: string): Promise<DockerContainerInfo | null>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSeconds?: number): Promise<void>;
  rm(id: string, opts?: { force?: boolean }): Promise<void>;
  kill(id: string, signal?: string): Promise<void>;
  pause(id: string): Promise<void>;
  unpause(id: string): Promise<void>;
  execArgv(container: string, spec: DockerExecSpec): string[];
  exec(
    container: string,
    spec: DockerExecSpec,
    spawnOpts?: Parameters<typeof spawn>[2],
  ): ChildProcess;
  execRun(
    container: string,
    spec: DockerExecSpec,
  ): Promise<{ stdout: string; stderr: string }>;
  listManaged(): Promise<DockerContainerInfo[]>;
}

const isoNow = (deps: ContainerRuntimeDeps): string =>
  (deps.now ?? (() => new Date()))().toISOString();

function subjectLabelValue(workspace: string, subject: string): string {
  return `${workspace}/${subject}`;
}

const SLUG_CHARS = /[^a-z0-9_.-]+/g;

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(SLUG_CHARS, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return slug === '' ? 'x' : slug;
}

/** `veto-<workspace>-<subject-slug>` (CONDUCTOR D30). Slugged to the
 *  docker name charset ([a-zA-Z0-9][a-zA-Z0-9_.-]*) and capped at 100
 *  chars — a truncated subject gets a sha suffix so distinct subjects
 *  can't collide. */
export function containerName(workspace: string, subject: string): string {
  const ws = slugify(workspace);
  let subj = slugify(subject);
  // `veto-` + ws + `-` overhead: cap total ≤100, keep the tail unique.
  const budget = 100 - 'veto-'.length - ws.length - 1;
  if (subj.length > budget) {
    const hash = createHash('sha1').update(subject).digest('hex').slice(0, 8);
    subj = `${subj.slice(0, Math.max(budget - 9, 1))}-${hash}`;
  }
  return `veto-${ws}-${subj}`;
}

/** Bind-mount sources of a container (only `bind` mounts count — image
 *  volumes aren't subject state). */
function bindMountSources(info: DockerContainerInfo): string[] {
  return info.mounts
    .filter((m) => m.type === 'bind')
    .map((m) => m.source)
    .sort();
}

/** Canonicalize host paths — docker may report the resolved path in
 *  inspect, so both sides go through realpath (falling back to
 *  resolve() for not-yet-existing paths). */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function sortedCanon(paths: string[]): string[] {
  return [...new Set(paths.map(canonical))].sort();
}

function sameMounts(info: DockerContainerInfo, desired: string[]): boolean {
  const actual = sortedCanon(bindMountSources(info));
  const want = sortedCanon(desired);
  return actual.length === want.length && actual.every((m, i) => m === want[i]);
}

function isManagedBy(
  info: DockerContainerInfo,
  workspace: string,
  subject: string,
): boolean {
  return (
    info.labels[MANAGED_LABEL] === 'true' &&
    info.labels[SUBJECT_LABEL] === subjectLabelValue(workspace, subject)
  );
}

export interface EnsureSubjectOptions {
  workspace: string;
  subject: string;
  /** Host worktree paths to bind-mount (identical paths container-side).
   *  `undefined` = wake-only — never create, never check the mount set. */
  mounts?: string[];
  /** Create-time `-w` (defaults to the first mount). */
  workdir?: string;
}

export interface EnsureContainerResult {
  row: ContainerRow;
  /** What ensure had to do. */
  action: 'created' | 'recreated' | 'adopted' | 'started' | 'running';
}

/**
 * ensure(subject) — the launch-path call (CONDUCTOR D30):
 *
 *   create if absent → start if stopped (unpause if paused) → recreate
 *   if the bind-mount set grew or the configured image changed.
 *
 * `mounts: undefined` makes this the wake path: it won't create a
 * mountless container and returns `null` when nothing exists.
 */
export async function ensureSubjectContainer(
  deps: ContainerRuntimeDeps,
  opts: EnsureSubjectOptions,
): Promise<EnsureContainerResult | null> {
  const { docker, store } = deps;
  const key: ContainerKey = {
    workspace: opts.workspace,
    subject: opts.subject,
  };
  const label = subjectLabelValue(opts.workspace, opts.subject);
  const name = containerName(opts.workspace, opts.subject);
  const row = await store.getContainer(key);

  let live: DockerContainerInfo | null = null;
  let adopted = false;
  if (row !== null && row.state !== 'removed') {
    live = await docker.inspect(row.container_id);
  }
  if (live === null) {
    // Row absent or pointing at a dead container — adopt a same-name
    // managed container (crash between create and upsert), or fail
    // closed on a foreign container squatting on our name.
    const named = await docker.inspect(name);
    if (named !== null) {
      if (!isManagedBy(named, opts.workspace, opts.subject)) {
        throw new ContainerRuntimeError(
          `container name ${name} is in use by an unmanaged container ` +
            `${named.id} — refusing to adopt it (subject ${label})`,
        );
      }
      live = named;
      adopted = true;
    }
  }

  if (live !== null) {
    const imageDrift = live.image !== deps.containers.image;
    const mountDrift =
      opts.mounts !== undefined && !sameMounts(live, opts.mounts);
    if (imageDrift || mountDrift) {
      await docker.rm(live.id, { force: true });
      live = null;
    }
  }

  if (live === null) {
    if (opts.mounts === undefined) return null; // wake-only
    const id = await docker.create({
      name,
      image: deps.containers.image,
      labels: {
        [MANAGED_LABEL]: 'true',
        [SUBJECT_LABEL]: label,
      },
      mounts: [...new Set(opts.mounts)].map((source) => ({ source })),
      cpus: deps.containers.cpu,
      memory: deps.containers.memory,
      ...(opts.workdir !== undefined
        ? { workdir: opts.workdir }
        : opts.mounts[0] !== undefined
          ? { workdir: opts.mounts[0] }
          : {}),
      ...(deps.command !== undefined ? { argv: deps.command } : {}),
    });
    await docker.start(id);
    const saved = await upsertState(deps, key, {
      container_id: id,
      image: deps.containers.image,
      state: 'running',
      created_at: isoNow(deps),
      stopped_at: null,
    });
    return { row: saved, action: row === null ? 'created' : 'recreated' };
  }

  let woke = false;
  if (live.paused) {
    // gate-resume: docker start can't touch a paused container — wake it.
    await docker.unpause(live.id);
    woke = true;
  }
  if (!live.running) {
    await docker.start(live.id);
    woke = true;
  }
  const saved = await upsertState(deps, key, {
    container_id: live.id,
    image: live.image,
    state: 'running',
    created_at: row?.created_at ?? live.created ?? isoNow(deps),
    stopped_at: null,
  });
  return {
    row: saved,
    action: adopted ? 'adopted' : woke ? 'started' : 'running',
  };
}

/** wake(subject) — start the recorded container. `null` when the row
 *  or the container is gone (caller falls back to ensure()). Never
 *  creates. */
export async function wakeSubjectContainer(
  deps: ContainerRuntimeDeps,
  key: ContainerKey,
): Promise<EnsureContainerResult | null> {
  return ensureSubjectContainer(deps, {
    workspace: key.workspace,
    subject: key.subject,
  });
}

/** sleep(subject) — `docker stop` (gate-park / PR-pause). Idempotent;
 *  a vanished container marks the row 'removed' (that IS the truth). */
export async function sleepSubjectContainer(
  deps: ContainerRuntimeDeps,
  key: ContainerKey,
): Promise<'stopped' | 'absent'> {
  const row = await deps.store.getContainer(key);
  if (row === null || row.state === 'removed') return 'absent';
  const info = await deps.docker.inspect(row.container_id);
  if (info === null) {
    await upsertState(deps, key, {
      container_id: row.container_id,
      image: row.image ?? null,
      state: 'removed',
      created_at: row.created_at ?? null,
      stopped_at: isoNow(deps),
    });
    return 'absent';
  }
  if (info.paused) await deps.docker.unpause(info.id); // stop can't stop paused
  if (info.running) await deps.docker.stop(info.id);
  await upsertState(deps, key, {
    container_id: row.container_id,
    image: row.image ?? null,
    state: 'stopped',
    created_at: row.created_at ?? null,
    stopped_at: isoNow(deps),
  });
  return 'stopped';
}

/** teardown(subject) — `docker rm -f` + row → 'removed'. Also removes
 *  a same-name managed container when the row is missing (crash
 *  backstop). */
export async function teardownSubjectContainer(
  deps: ContainerRuntimeDeps,
  key: ContainerKey,
): Promise<'removed' | 'absent'> {
  const name = containerName(key.workspace, key.subject);
  const row = await deps.store.getContainer(key);
  let removed = false;
  if (row !== null && row.state !== 'removed') {
    if (await deps.docker.inspect(row.container_id)) {
      await deps.docker.rm(row.container_id, { force: true });
      removed = true;
    }
  }
  if (row === null) {
    // No row — a same-name managed container may still exist (died
    // between create and upsert). Remove ours; leave foreign ones.
    const named = await deps.docker.inspect(name);
    if (named !== null && isManagedBy(named, key.workspace, key.subject)) {
      await deps.docker.rm(named.id, { force: true });
      removed = true;
    }
  }
  if (row !== null) {
    await upsertState(deps, key, {
      container_id: row.container_id,
      image: row.image ?? null,
      state: 'removed',
      created_at: row.created_at ?? null,
      stopped_at: isoNow(deps),
    });
    return 'removed';
  }
  return removed ? 'removed' : 'absent';
}

export interface SweepResult {
  /** Names (or ids) of containers the sweep removed. */
  removed: string[];
  /** Names of managed containers with a live row + live subject. */
  kept: string[];
}

/**
 * sweepOrphans() — conductor-startup reconcile (CONDUCTOR D30): list
 * every `veto/managed=true` container and `docker rm` it when there is
 * no live `containers` row, the row points at a different container id,
 * or the subject is terminal/deleted. Unmanaged containers (no label)
 * are never listed and never touched. When `deps.workspaces` is set,
 * managed containers labeled for a workspace outside the set are
 * skipped entirely — each conductor owns only its own workspaces.
 */
export async function sweepOrphanedContainers(
  deps: ContainerRuntimeDeps,
): Promise<SweepResult> {
  const managed = await deps.docker.listManaged();
  const removed: string[] = [];
  const kept: string[] = [];
  for (const c of managed) {
    const who = c.labels[SUBJECT_LABEL];
    let orphan: boolean;
    let key: ContainerKey | null = null;
    let row: ContainerRow | null = null;
    const slash = who === undefined ? -1 : who.indexOf('/');
    if (who === undefined || slash <= 0 || slash === who.length - 1) {
      if (deps.workspaces !== undefined && deps.workspaces.length > 0) {
        // Scoped sweep: a label we can't resolve to one of OUR
        // workspaces is left alone — it may belong to a conductor
        // outside the set (a malformed label must never bypass the
        // workspace fence into a `docker rm`).
        kept.push(c.name === '' ? c.id : c.name);
        continue;
      }
      // Managed but unresolvable — ours, still an orphan.
      orphan = true;
    } else {
      key = {
        workspace: who.slice(0, slash),
        subject: who.slice(slash + 1),
      };
      if (
        deps.workspaces !== undefined &&
        !deps.workspaces.includes(key.workspace)
      ) {
        // Another conductor's container — never ours to judge.
        continue;
      }
      row = await deps.store.getContainer(key);
      orphan =
        row === null ||
        row.state === 'removed' ||
        row.container_id !== c.id ||
        (await isTerminalSubject(deps, key));
    }
    if (orphan) {
      await deps.docker.rm(c.id, { force: true });
      if (row !== null && row.container_id === c.id && key !== null) {
        await upsertState(deps, key, {
          container_id: row.container_id,
          image: row.image ?? null,
          state: 'removed',
          created_at: row.created_at ?? null,
          stopped_at: isoNow(deps),
        });
      }
      removed.push(c.name === '' ? c.id : c.name);
    } else {
      kept.push(c.name === '' ? c.id : c.name);
    }
  }
  return { removed, kept };
}

/** Terminal check for the sweep — ticket subjects only. A ticket-like
 *  subject with no `tickets` row counts as gone (deleted → orphan);
 *  non-ticket subjects (`probe:…`, `survey:…`) can never be terminal. */
async function isTerminalSubject(
  deps: ContainerRuntimeDeps,
  key: ContainerKey,
): Promise<boolean> {
  if (key.subject.includes(':')) return false;
  const ticket = await deps.store.getTicket({
    workspace: key.workspace,
    ticket_id: key.subject,
  });
  return (
    ticket === null ||
    (TERMINAL_STATUSES as readonly string[]).includes(ticket.status)
  );
}

/** Write-through helper — every lifecycle op lands one row. */
async function upsertState(
  deps: ContainerRuntimeDeps,
  key: ContainerKey,
  row: Omit<ContainerRow, 'workspace' | 'subject'>,
): Promise<ContainerRow> {
  const full: ContainerRow = {
    workspace: key.workspace,
    subject: key.subject,
    ...row,
  };
  await deps.store.upsertContainer(full);
  return full;
}

// ---------------------------------------------------------------------------
// Startup — daemon detection + base image (detect-at-startup rule)
// ---------------------------------------------------------------------------

/** The effective runtime for one backend (D30): per-backend override →
 *  adapter-declared capability → `containers.runtime` global. */
export function resolveBackendRuntime(
  config: {
    containers: ContainersConfig;
    capabilities?: Record<string, Capabilities | undefined> | undefined;
  },
  backend: string,
  declared?: Runtime | null,
): Runtime {
  return resolveRuntime({
    override: config.capabilities?.[backend]?.runtime,
    declared,
    global: config.containers.runtime,
  });
}

/** Names of registered backends resolving to `runtime: container`. */
export function containerRuntimeBackends(
  config: {
    containers: ContainersConfig;
    capabilities?: Record<string, Capabilities | undefined> | undefined;
  },
  adapters: Record<string, { capabilities: CapabilityFlags }>,
): string[] {
  return Object.keys(adapters)
    .sort()
    .filter(
      (name) =>
        resolveBackendRuntime(
          config,
          name,
          adapters[name]?.capabilities.runtime,
        ) === 'container',
    );
}

/** Repo `docker/Dockerfile.agent` when the configured image is the
 *  bundled `veto/agent` one and the file exists (source tree or a
 *  bundle that ships it); otherwise undefined → pull path. */
export function defaultAgentDockerfile(image: string): string | undefined {
  if (!image.startsWith(AGENT_IMAGE_PREFIX)) return undefined;
  const p = fileURLToPath(
    new URL('../../../../docker/Dockerfile.agent', import.meta.url),
  );
  return existsSync(p) ? p : undefined;
}

/**
 * Base image at conductor start (D30): the bundled `veto/agent` image
 * is built from `docker/Dockerfile.agent` (idempotent — docker layer
 * caching makes a no-change build cheap); a registry-configured image
 * is pulled only when absent. Fail-closed: a failed build/pull throws.
 */
export async function ensureAgentImage(
  deps: Pick<ContainerRuntimeDeps, 'docker' | 'containers' | 'dockerfile'>,
): Promise<'built' | 'pulled' | 'present'> {
  const image = deps.containers.image;
  const dockerfile =
    deps.dockerfile === undefined
      ? defaultAgentDockerfile(image)
      : (deps.dockerfile ?? undefined);
  if (dockerfile !== undefined) {
    await deps.docker.buildImage({
      tag: image,
      dockerfile,
      contextDir: dirname(dockerfile),
    });
    return 'built';
  }
  if (await deps.docker.imageExists(image)) return 'present';
  await deps.docker.pullImage(image);
  return 'pulled';
}

export interface ContainerRuntimeReport {
  /** Registered backends resolving to runtime:container (empty → the
   *  docker daemon was never contacted). */
  backends: string[];
  /** null when no backend needs containers. */
  image: 'built' | 'pulled' | 'present' | null;
  /** Daemon server version (null when untouched). */
  serverVersion: string | null;
  swept: SweepResult;
}

/**
 * Conductor-startup container bootstrap (wp-095; wired in wp-097):
 *
 *   1. Resolve which registered backends need `runtime: container` —
 *      none → return immediately (daemon never touched; a `runtime:
 *      process` install is unaffected by a missing docker).
 *   2. `docker info` — daemon unreachable → hard error naming the
 *      backends that need it.
 *   3. Build/pull the base image — failure → hard error naming it.
 *   4. sweepOrphans().
 */
export async function prepareContainerRuntime(
  deps: ContainerRuntimeDeps,
  opts: {
    adapters: Record<string, { capabilities: CapabilityFlags }>;
  },
): Promise<ContainerRuntimeReport> {
  const backends = containerRuntimeBackends(
    { containers: deps.containers, capabilities: deps.capabilities },
    opts.adapters,
  );
  if (backends.length === 0) {
    return {
      backends: [],
      image: null,
      serverVersion: null,
      swept: { removed: [], kept: [] },
    };
  }
  let serverVersion: string;
  try {
    ({ serverVersion } = await deps.docker.ping());
  } catch (err) {
    throw new ContainerRuntimeError(
      `docker daemon unreachable — required for runtime: container backend(s): ${backends.join(', ')}. Start docker, or set containers.runtime: process (or capabilities.<backend>.runtime: process) for a detached-process fallback. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let image: 'built' | 'pulled' | 'present';
  try {
    image = await ensureAgentImage(deps);
  } catch (err) {
    throw new ContainerRuntimeError(
      `agent image ${deps.containers.image} unavailable — required for ` +
        `runtime: container backend(s): ${backends.join(', ')}. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const swept = await sweepOrphanedContainers(deps);
  return { backends, image, serverVersion, swept };
}
