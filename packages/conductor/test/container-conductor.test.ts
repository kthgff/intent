/**
 * wp-097 conductor container integration (D30):
 *
 *  1. LAUNCH container-ensure — a repo-executing stage on a
 *     `runtime: container` backend ensures the subject's container
 *     (mounting every ticket_repos worktree), passes `container_id` to
 *     `adapter.run`, and records `runs.container_id`; cardless stages
 *     stay host-side (lazy-create rule); a grown mount set recreates.
 *  2. Reconcile container lifecycle — gate status → `docker stop`,
 *     terminal status → `docker rm` + row 'removed'; a container that
 *     dies mid-run surfaces as dead within a tick (same semantics as a
 *     dead pid).
 *  3. Conductor start — daemon-absent fail-closed naming the backends;
 *     startup orphan sweep (managed orphans removed, unmanaged kept).
 *  4. Real-daemon integration — `describe.skipIf` when `docker info`
 *     fails (docker is an optional runtime dep; tests skip cleanly).
 */
import { execFile, execFileSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter, parseArtifactDir } from '@veto/adapters';
import { resolveConfig } from '@veto/config';
import { REVIEW_PASSES } from '@veto/core';
import type {
  Adapter,
  CapabilityFlags,
  CollectContext,
  ControlOp,
  PrepareContext,
  RenderedPrompt,
  RunHandle,
  RunResult,
  RunRow,
  TicketRow,
  TokenValues,
  UsageCallback,
} from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliDockerClient,
  Conductor,
  type ConductorDeps,
  type ConductorWorkspace,
  type DockerClientLike,
  type DockerContainerInfo,
  type DockerCreateSpec,
  type DockerExecSpec,
  type LaunchContext,
  LeaseManager,
  MANAGED_LABEL,
  RealTransitionHandler,
  type ReconcileReport,
  SUBJECT_LABEL,
  StubTransitionHandler,
  containerName,
  containerRuntimeDeps,
  ensureSubjectContainer,
  launch,
  queuePendingRun,
  reconcile,
  sweepOrphanedContainers,
  teardownSubjectContainer,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_FIXTURE = join(HERE, '../../../fixtures/code-repo');
const WS = 'ws';
const NOW = '2026-10-04T00:00:00.000Z';
const NOOP_SCAN = async () => ({
  ok: true as const,
  scanner: 'stub',
  findings: [],
});

const CONTAINERS = {
  runtime: 'container' as const,
  image: 'veto/agent:latest',
  cpu: 2,
  memory: '256m',
  stop_on_gate: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fake docker client — lifecycle decision tables, deterministic.
// ---------------------------------------------------------------------------

class FakeDocker implements DockerClientLike {
  readonly containers = new Map<string, DockerContainerInfo>();
  readonly byName = new Map<string, string>();
  readonly calls: string[] = [];
  readonly images = new Set<string>([CONTAINERS.image]);
  pingError: Error | null = null;
  seq = 0;

  async ping(): Promise<{ serverVersion: string }> {
    this.calls.push('info');
    if (this.pingError !== null) throw this.pingError;
    return { serverVersion: 'fake-1.0' };
  }
  async imageExists(image: string): Promise<boolean> {
    this.calls.push(`image inspect ${image}`);
    return this.images.has(image);
  }
  async buildImage(): Promise<void> {
    throw new Error('fake docker: buildImage not expected');
  }
  async pullImage(image: string): Promise<void> {
    this.calls.push(`pull ${image}`);
    this.images.add(image);
  }
  async create(spec: DockerCreateSpec): Promise<string> {
    const id = `fakeid${String(++this.seq).padStart(4, '0')}`;
    this.calls.push(`create ${spec.name}`);
    this.containers.set(id, {
      id,
      name: spec.name,
      image: spec.image,
      status: 'created',
      running: false,
      paused: false,
      labels: spec.labels ?? {},
      mounts: (spec.mounts ?? []).map((m) => ({
        source: m.source,
        destination: m.destination ?? m.source,
        type: 'bind',
      })),
      created: NOW,
    });
    this.byName.set(spec.name, id);
    return id;
  }
  private byRef(ref: string): DockerContainerInfo | undefined {
    return this.containers.get(this.byName.get(ref) ?? ref);
  }
  async inspect(ref: string): Promise<DockerContainerInfo | null> {
    this.calls.push(`inspect ${ref}`);
    return this.byRef(ref) ?? null;
  }
  async start(id: string): Promise<void> {
    this.calls.push(`start ${id}`);
    const c = this.byRef(id);
    if (c) {
      c.running = true;
      c.status = 'running';
    }
  }
  async stop(id: string): Promise<void> {
    this.calls.push(`stop ${id}`);
    const c = this.byRef(id);
    if (c) {
      c.running = false;
      c.status = 'exited';
    }
  }
  async rm(id: string): Promise<void> {
    this.calls.push(`rm ${id}`);
    const c = this.byRef(id);
    if (c) {
      this.containers.delete(c.id);
      this.byName.delete(c.name);
    }
  }
  async kill(id: string, signal = 'KILL'): Promise<void> {
    this.calls.push(`kill -s ${signal} ${id}`);
  }
  async pause(id: string): Promise<void> {
    this.calls.push(`pause ${id}`);
    const c = this.byRef(id);
    if (c) {
      c.paused = true;
      c.status = 'paused';
    }
  }
  async unpause(id: string): Promise<void> {
    this.calls.push(`unpause ${id}`);
    const c = this.byRef(id);
    if (c) {
      c.paused = false;
      c.running = true;
      c.status = 'running';
    }
  }
  execArgv(container: string, spec: DockerExecSpec): string[] {
    return new CliDockerClient().execArgv(container, spec);
  }
  exec(): never {
    throw new Error('fake docker: exec not implemented');
  }
  async execRun(): Promise<{ stdout: string; stderr: string }> {
    throw new Error('fake docker: execRun not implemented');
  }
  async listManaged(): Promise<DockerContainerInfo[]> {
    this.calls.push('ps');
    return [...this.containers.values()].filter(
      (c) => c.labels[MANAGED_LABEL] === 'true',
    );
  }
}

// ---------------------------------------------------------------------------
// Container-capable adapter — wraps MockAdapter (real detached child) and
// records the `container_id` the conductor hands it.
// ---------------------------------------------------------------------------

class RecordingAdapter implements Adapter {
  readonly name = 'mock' as const;
  readonly capabilities: CapabilityFlags = {
    can_exec: true,
    can_write_outside_tree: false,
    has_gh: false,
    can_signal: true,
    streams_usage: false,
    runtime: 'container',
  };
  readonly seen: (string | undefined)[] = [];
  constructor(private readonly inner: MockAdapter) {}
  prepare(subject: string, stage: string, ctx: PrepareContext) {
    return this.inner.prepare(subject, stage, ctx);
  }
  run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
    opts?: { run_dir?: string; container_id?: string },
  ): RunHandle {
    this.seen.push(opts?.container_id);
    return this.inner.run(worktree, rendered, timeout);
  }
  control(handle: RunHandle, op: ControlOp): Promise<void> | void {
    return this.inner.control(handle, op);
  }
  on_usage(handle: RunHandle, cb: UsageCallback): void {
    this.inner.on_usage(handle, cb);
  }
  collect(handle: RunHandle, ctx: CollectContext): Promise<RunResult> {
    return this.inner.collect(handle, ctx);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string;
let codeRepo: string;
let runsDir: string;
let store: PostgresStore;

function gitInit(repo: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      repos: {
        'code-repo': {
          path: codeRepo,
          card: {
            test: 'make test',
            lint: 'make lint',
            build: 'make build',
            forbidden_paths: [],
            probed_at: NOW,
            verified: true,
          },
        },
      },
      security: { scan_on_commit: false },
      containers: CONTAINERS,
      ...overrides,
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function makeDeps(
  docker: DockerClientLike,
  adapter: Adapter,
  configOverrides: Record<string, unknown> = {},
): ConductorDeps {
  return {
    store,
    adapters: { mock: adapter },
    config: makeConfig(configOverrides),
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir,
    transitions: new StubTransitionHandler(),
    scan: NOOP_SCAN,
    stallAfterMs: 200,
    docker,
    containerDockerfile: null,
    onError: (e) => console.error('[container-conductor onError]', e),
  };
}

const wsOf = (deps: ConductorDeps): ConductorWorkspace =>
  deps.workspaces[0] as ConductorWorkspace;

function launchCtx(deps: ConductorDeps): LaunchContext {
  return {
    deps,
    ws: wsOf(deps),
    leases: new LeaseManager(deps),
    handles: new Map(),
    killedForCap: new Set(),
  };
}

function reconcileCtx(deps: ConductorDeps) {
  return {
    deps,
    ws: wsOf(deps),
    leases: new LeaseManager(deps),
    handles: new Map<string, RunHandle>(),
    killedForCap: new Set<string>(),
    report: {
      stalled: [],
      killed: [],
      collected: [],
      warnings: [],
    } as ReconcileReport,
  };
}

async function putTicket(
  ticketId: string,
  status: string,
  repos: string[] = ['code-repo'],
): Promise<void> {
  await store.upsertTicket({
    workspace: WS,
    ticket_id: ticketId,
    feature: null,
    title: `t ${ticketId}`,
    status: status as never,
    priority: 'medium',
    depth: 'standard',
    backend: null,
    model: null,
    repos,
    parent: null,
    depends_on: [],
    source: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: NOW,
    updated_at: NOW,
  });
}

const getRun = async (id: string): Promise<RunRow | null> => store.getRun(id);
const containerRow = (subject: string) =>
  store.getContainer({ workspace: WS, subject });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp097-'));
  runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  codeRepo = join(dir, 'code-repo');
  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });
  gitInit(codeRepo);
  store = await PostgresStore.connect('pglite:');
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// LAUNCH — container ensure + container_id
// ---------------------------------------------------------------------------

describe('LAUNCH container ensure (D30)', () => {
  it('repo-executing stage ensures + records container_id; cardless stays host-side; a grown mount set recreates', async () => {
    const docker = new FakeDocker();
    const adapter = new RecordingAdapter(new MockAdapter({ delayMs: 200 }));
    const deps = makeDeps(docker, adapter);
    await putTicket('SR-C1', 'in-progress');
    await putTicket('SR-C2', 'imported');
    await putTicket('SR-C3', 'in-progress');

    // --- repo-executing stage → container ensured, id passed + recorded
    const id = await launch(launchCtx(deps), {
      workspace: WS,
      subject: 'SR-C1',
      stage: 'implement',
      ticketId: 'SR-C1',
    });
    const run = await getRun(id as string);
    const row = await containerRow('SR-C1');
    expect(row).not.toBeNull();
    expect(row?.state).toBe('running');
    expect(run?.container_id).toBe(row?.container_id);
    expect(adapter.seen).toEqual([row?.container_id]);

    const info = await docker.inspect(containerName(WS, 'SR-C1'));
    expect(info?.running).toBe(true);
    expect(info?.labels[SUBJECT_LABEL]).toBe(`${WS}/SR-C1`);
    expect(info?.mounts).toHaveLength(1);
    expect(run?.worktree).toBe(info?.mounts[0]?.source);
    await adapter.control({ pid: run?.pid as number, log_path: '' }, 'kill');

    // --- cardless doc stage → host-side, no container (lazy-create rule)
    const cardless = await launch(launchCtx(deps), {
      workspace: WS,
      subject: 'SR-C2',
      stage: 'triage',
      ticketId: 'SR-C2',
    });
    expect((await getRun(cardless as string))?.container_id).toBeNull();
    expect(adapter.seen).toContain(undefined);
    expect(docker.calls).not.toContain('create veto-ws-sr-c2');
    expect(await containerRow('SR-C2')).toBeNull();

    // --- grown mount set → recreate with a new id (same container name)
    const first = await launch(launchCtx(deps), {
      workspace: WS,
      subject: 'SR-C3',
      stage: 'implement',
      ticketId: 'SR-C3',
    });
    const row1 = await containerRow('SR-C3');
    expect((await getRun(first as string))?.container_id).toBe(
      row1?.container_id,
    );
    await store.upsertTicketRepo({
      workspace: WS,
      ticket_id: 'SR-C3',
      repo: 'code-repo-2',
      branch: 'ticket/SR-C3',
      worktree: join(dir, 'extra-worktree'),
      pr_url: null,
      pr_state: null,
      ci_state: null,
      merged_sha: null,
    });
    const second = await launch(launchCtx(deps), {
      workspace: WS,
      subject: 'SR-C3',
      stage: 'fix',
      ticketId: 'SR-C3',
    });
    const row2 = await containerRow('SR-C3');
    expect(row2?.container_id).not.toBe(row1?.container_id);
    expect((await getRun(second as string))?.container_id).toBe(
      row2?.container_id,
    );
    expect(
      docker.containers.get(row2?.container_id as string)?.mounts,
    ).toHaveLength(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// RECONCILE — container lifecycle (gate sleep / terminal teardown / liveness)
// ---------------------------------------------------------------------------

describe('RECONCILE container lifecycle (D30)', () => {
  it('gate sleep, terminal teardown, dead-container liveness, live heartbeat', async () => {
    const docker = new FakeDocker();
    const adapter = new RecordingAdapter(
      new MockAdapter({ scenario: 'done', delayMs: 1500 }),
    );
    const deps = makeDeps(docker, adapter);
    await putTicket('SR-G1', 'in-progress');
    await putTicket('SR-D1', 'in-progress');
    await putTicket('SR-H1', 'in-progress');

    // --- gate park → docker stop; terminal → docker rm + row removed
    await ensureSubjectContainer(containerRuntimeDeps(deps), {
      workspace: WS,
      subject: 'SR-G1',
      mounts: [codeRepo],
    });
    expect((await containerRow('SR-G1'))?.state).toBe('running');
    await putTicket('SR-G1', 'prd-review');
    await reconcile(reconcileCtx(deps));
    expect((await containerRow('SR-G1'))?.state).toBe('stopped');
    expect((await docker.inspect(containerName(WS, 'SR-G1')))?.running).toBe(
      false,
    );
    await putTicket('SR-G1', 'released');
    await reconcile(reconcileCtx(deps));
    expect((await containerRow('SR-G1'))?.state).toBe('removed');
    expect(await docker.inspect(containerName(WS, 'SR-G1'))).toBeNull();

    // --- a container that dies mid-run surfaces as dead within a tick
    const deadId = await launch(launchCtx(deps), {
      workspace: WS,
      subject: 'SR-D1',
      stage: 'implement',
      ticketId: 'SR-D1',
    });
    const deadRun = await getRun(deadId as string);
    expect(deadRun?.status).toBe('running');
    expect(deadRun?.container_id).not.toBeNull();
    await docker.stop(deadRun?.container_id as string);
    await reconcile(reconcileCtx(deps));
    const after = await getRun(deadId as string);
    expect(after?.status).not.toBe('running');
    expect((await containerRow('SR-D1'))?.state).toBe('stopped');

    // --- a live container + exec client keeps heartbeating
    const hangAdapter = new RecordingAdapter(
      new MockAdapter({ scenario: 'hang', delayMs: 0, heartbeatMs: 100 }),
    );
    const hangDeps = makeDeps(docker, hangAdapter);
    const hangId = await launch(launchCtx(hangDeps), {
      workspace: WS,
      subject: 'SR-H1',
      stage: 'implement',
      ticketId: 'SR-H1',
    });
    await reconcile(reconcileCtx(hangDeps));
    const hangRun = await getRun(hangId as string);
    // Alive (container running + exec client alive) — heartbeated by the
    // conductor. (A silent run may also flag `stalled`, same as a
    // process run — the point is it is NOT collected/killed.)
    expect(['running', 'stalled']).toContain(hangRun?.status);
    expect(Date.parse(hangRun?.heartbeat_at ?? '')).toBeGreaterThan(0);
    await hangAdapter.control(
      { pid: hangRun?.pid as number, log_path: '' },
      'kill',
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Conductor.start — fail-closed daemon detection + orphan sweep
// ---------------------------------------------------------------------------

describe('conductor container bootstrap (D30)', () => {
  it('fails closed on an absent daemon; sweeps orphans; no-ops without container backends', async () => {
    // --- absent daemon → start() rejects naming the backend
    const badDocker = new FakeDocker();
    badDocker.pingError = new Error('connect ENOENT /var/run/docker.sock');
    const containerAdapter = new RecordingAdapter(new MockAdapter());
    const bad = new Conductor(makeDeps(badDocker, containerAdapter));
    await expect(bad.start()).rejects.toThrow(/mock/);

    // --- orphan sweep: managed-no-row removed, unmanaged kept
    const docker = new FakeDocker();
    await docker.create({
      name: 'veto-ws-ghost',
      image: CONTAINERS.image,
      labels: { [MANAGED_LABEL]: 'true', [SUBJECT_LABEL]: `${WS}/GHOST` },
    });
    await docker.create({ name: 'foreign-cron', image: 'alpine' });
    const conductor = new Conductor(makeDeps(docker, containerAdapter));
    const report = await conductor.start();
    expect(report.backends).toEqual(['mock']);
    expect(report.swept.removed).toEqual(['veto-ws-ghost']);
    expect(docker.byName.has('foreign-cron')).toBe(true);

    // --- no container backend → no-op, daemon never contacted
    const procDocker = new FakeDocker();
    const processOnly: Adapter = {
      name: 'mock',
      capabilities: {
        can_exec: true,
        can_write_outside_tree: false,
        has_gh: false,
        runtime: 'process',
      },
      prepare: () => ({ template: 't', text: '', tokens: {} as TokenValues }),
      run: () => ({ pid: 1, log_path: '' }),
      control: () => {},
      on_usage: () => {},
      collect: () => ({
        sentinel: null,
        sentinel_raw: null,
        artifacts: [],
        usage: null,
        exit_code: 0,
      }),
    };
    const procReport = await new Conductor(
      makeDeps(procDocker, processOnly),
    ).start();
    expect(procReport.backends).toEqual([]);
    expect(procDocker.calls).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Real daemon — skipIf absent (docker is an optional runtime dep).
// ---------------------------------------------------------------------------

/** Reachable daemon + the env needed to reach it. The default context
 *  can be dead while Docker Desktop still serves on the desktop socket
 *  (`~/.docker/run/docker.sock`, the `desktop-linux` context) — probe
 *  the default first, then the desktop socket. */
const DOCKER_PROBE = ((): { env: Record<string, string> } | null => {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    return { env: {} };
  } catch {
    /* default context dead — try the desktop socket */
  }
  const sock = join(homedir(), '.docker/run/docker.sock');
  if (!existsSync(sock)) return null;
  const env = { DOCKER_HOST: `unix://${sock}` };
  try {
    execFileSync('docker', ['info'], {
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
    return { env };
  } catch {
    return null;
  }
})();

const DOCKER_OK = DOCKER_PROBE !== null;
const DOCKER_ENV = DOCKER_PROBE?.env ?? {};

/** Process env for docker CLI calls in this suite. */
function dockerEnv(): Record<string, string> {
  return { ...process.env, ...DOCKER_ENV };
}

const TEST_IMAGE = 'alpine:latest';

/** Container-exec adapter — issues a real `docker exec` inside the
 *  conductor-ensured container and writes a sentinel log (the wp-096
 *  exec seam, minimal). */
class ExecAdapter implements Adapter {
  readonly name = 'mock' as const;
  readonly capabilities: CapabilityFlags = {
    can_exec: true,
    can_write_outside_tree: false,
    has_gh: false,
    can_signal: true,
    streams_usage: false,
    runtime: 'container',
  };
  readonly seen: (string | undefined)[] = [];
  readonly logPaths: string[] = [];
  constructor(private readonly docker: CliDockerClient) {}
  prepare(_subject: string, stage: string) {
    return { template: stage, text: '', tokens: {} as TokenValues };
  }
  run(
    worktree: string,
    _rendered: RenderedPrompt,
    _timeout: number,
    opts?: { run_dir?: string; container_id?: string },
  ): RunHandle {
    const containerId = opts?.container_id;
    this.seen.push(containerId);
    const logPath = join(opts?.run_dir ?? tmpdir(), 'exec.log');
    mkdirSync(dirname(logPath), { recursive: true });
    this.logPaths.push(logPath);
    const fd = openSync(logPath, 'a');
    try {
      const child = this.docker.exec(
        containerId as string,
        {
          workdir: worktree,
          argv: ['sh', '-c', 'echo in-container && echo DONE'],
        },
        { stdio: ['ignore', fd, fd] },
      );
      child.unref();
      return {
        pid: child.pid as number,
        log_path: logPath,
        container_id: containerId as string,
      };
    } finally {
      closeSync(fd);
    }
  }
  control(): void {}
  on_usage(): void {}
  async collect(handle: RunHandle): Promise<RunResult> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(handle.pid, 0);
      } catch {
        break;
      }
      await sleep(50);
    }
    await sleep(100);
    const text = readFileSync(handle.log_path, 'utf8');
    const last =
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1) ?? null;
    return {
      sentinel: last ? (last.split(':')[0] ?? '').trim() : null,
      sentinel_raw: last,
      artifacts: [],
      usage: null,
      exit_code: 0,
    };
  }
}

describe.skipIf(!DOCKER_OK)('conductor container run (real docker)', () => {
  let docker: CliDockerClient;
  let mounts: string[];

  const rdeps = (adapter: Adapter): ConductorDeps => {
    const deps = makeDeps(docker, adapter, {
      containers: { ...CONTAINERS, image: TEST_IMAGE, memory: '256m' },
    });
    // alpine has no coreutils `sleep infinity` — keep PID1 alive with tail.
    deps.containerCommand = ['tail', '-f', '/dev/null'];
    return deps;
  };

  beforeEach(async () => {
    docker = new CliDockerClient({ env: DOCKER_ENV });
    mounts = [mkdtempSync(join(tmpdir(), 'wp097-wt-'))];
    if (!(await docker.imageExists(TEST_IMAGE))) {
      await docker.pullImage(TEST_IMAGE);
    }
  });

  afterEach(async () => {
    const managed = await docker.listManaged();
    for (const c of managed) {
      if (c.name.startsWith('veto-ws')) {
        await docker.rm(c.id, { force: true }).catch(() => {});
      }
    }
    for (const m of mounts) rmSync(m, { recursive: true, force: true });
  });

  it('ensures a container and execs the run inside it (runs.container_id set)', async () => {
    const adapter = new ExecAdapter(docker);
    const deps = rdeps(adapter);
    await putTicket('SR-R1', 'in-progress');

    const id = await launch(launchCtx(deps), {
      workspace: WS,
      subject: 'SR-R1',
      stage: 'implement',
      ticketId: 'SR-R1',
    });
    const run = await getRun(id as string);
    const row = await containerRow('SR-R1');
    expect(await docker.inspect(containerName(WS, 'SR-R1'))).not.toBeNull();
    expect(run?.container_id).toBe(row?.container_id);
    expect(adapter.seen).toEqual([row?.container_id]);

    // The exec ran inside the container — the sentinel is collected.
    const result = await adapter.collect({
      pid: run?.pid as number,
      log_path: adapter.logPaths[0] as string,
      container_id: row?.container_id as string,
    });
    expect(result.sentinel).toBe('DONE');

    // The subject is live (non-terminal), so the startup sweep KEEPS the
    // container; teardown is what removes it (terminal path).
    const swept = await sweepOrphanedContainers(containerRuntimeDeps(deps));
    expect(swept.kept).toContain(containerName(WS, 'SR-R1'));
    await teardownSubjectContainer(containerRuntimeDeps(deps), {
      workspace: WS,
      subject: 'SR-R1',
    });
    expect(await docker.inspect(containerName(WS, 'SR-R1'))).toBeNull();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// wp-098 — Container E2E (D30): the containerized run path end-to-end.
//
// Backend under test: a container-capable MOCK backend — the wp-040
// scripted agent (helpers/mock-agent.mjs) `docker cp`'d into the subject
// container once, then executed per run via `docker exec -w <worktree>`
// (aider's image/flags are still unverified per the wp-098 ticket — the
// runtime is what's under test, not the model). Coverage:
//
//   1. Full chain — worktree create → container ensure → exec run →
//      sentinel → artifact collect → transition → gate-sleep → wake →
//      teardown.
//   2. Kill mid-run — container stops, worktree preserved, status stays
//      for retry; the retry wakes the SAME container (docker start).
//   3. Pause/resume — cgroup freeze stops output; the timeout clock
//      keeps ticking (deadline is absolute — a run resumed past its
//      timeout is killed on the next sweep).
//   4. Orphan sweep after a simulated conductor crash — managed
//      containers with no live row or a terminal/missing subject are
//      removed; live subjects + unmanaged containers are kept.
//   5. Multi-repo ticket — two worktree mounts, ONE container.
//   6. Repo-set growth — a second repo's worktree recreates the
//      container (new id, union of mounts).
//
// Real-daemon only (describe.skipIf). The orphan sweep is scoped to
// the conductor's workspaces (`ContainerRuntimeDeps.workspaces`), so
// this file's `ws` containers and containers.test.ts's `wstest` ones
// can't reap each other under vitest file-parallelism.
// ---------------------------------------------------------------------------

const SCRIPT_AGENT = join(HERE, 'helpers/mock-agent.mjs');
const CONTAINER_AGENT = '/opt/veto-mock-agent.mjs';

/** The e2e image: the real agent image when it's already built locally
 *  (D30 — the runtime is what's under test), else a pullable node
 *  image that `conductor.start()` fetches via ensureAgentImage. Both
 *  have `node` for the scripted agent; the keepalive is overridden to
 *  `tail -f /dev/null` which exists in either. */
const E2E_IMAGE = ((): string => {
  try {
    execFileSync('docker', ['image', 'inspect', 'veto/agent:latest'], {
      stdio: 'pipe',
      env: dockerEnv(),
    });
    return 'veto/agent:latest';
  } catch {
    return 'node:22-alpine';
  }
})();

/** `docker cp` — the CliDockerClient surface has no need for it (the
 *  lifecycle never copies into containers); the in-container backend
 *  uses it to install the scripted agent once per container. */
async function dockerCp(src: string, dest: string): Promise<void> {
  // Bounded retry: under suite-wide docker load a cp can fail with an
  // empty-stderr daemon stall; 3 attempts smooth that over without
  // masking a persistently dead target.
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await new Promise<void>((res, rej) => {
        execFile(
          'docker',
          ['cp', src, dest],
          { env: dockerEnv(), timeout: 60_000 },
          (err, _stdout, stderr) => {
            if (err === null) res();
            else {
              rej(new Error(String(stderr).trim() || err.message));
            }
          },
        );
      });
      return;
    } catch (e) {
      lastErr = (e as Error).message;
      await sleep(400);
    }
  }
  throw new Error(`docker cp ${src} → ${dest}: ${lastErr}`);
}

function lastNonEmptyLine(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
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

function execClientAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Script for one in-container run — a builtin DSL word (`done`,
 *  `hang`, `garbage-sentinel`, `no-sentinel`) or a spec object carried
 *  to mock-agent.mjs as `script:<base64url>` (same DSL as the wp-040
 *  ScriptedAdapter minus `files:` — run_dir is NOT bind-mounted into
 *  the container, so only the worktree scratch dir (`artifacts:`)
 *  reaches the host through the path-identical bind mount). */
interface ContainerScriptSpec {
  sentinel?: string | null;
  artifacts?: Record<string, unknown>;
  delayMs?: number;
  hang?: boolean;
  /** Poll for this path before emitting the sentinel — a file the test
   *  drops into the (path-identical, host-visible) worktree releases
   *  the run on demand. */
  waitFor?: string;
}
type ContainerScript = ContainerScriptSpec | string;

interface ContainerRunInfo {
  subject: string;
  stage: string;
  attempt: number;
  ticketId: string | null;
  runId: string;
  /** Set by run() before the script resolves — prepare() doesn't know
   *  the worktree yet. */
  worktree?: string;
}

type ContainerScriptFn = (run: ContainerRunInfo) => ContainerScript;

interface ExecRecord {
  exitCode: number | null;
  exitPromise: Promise<void>;
}

/**
 * ContainerScriptedAdapter — the wp-098 container-capable backend:
 * the scripted mock agent runs INSIDE the subject's container via
 * `docker exec -w <worktree>` (installed once per container by
 * `docker cp`). `can_write_outside_tree: false` → the prompt renders a
 * worktree-relative `.veto/<run-id>/` scratch dir; the mount
 * is path-identical (D30), so in-container artifact writes land on the
 * host and reconcile's collectArtifacts moves them into run_dir.
 * Cardless stages (no container_id — the lazy-create rule) fall back
 * to the wrapped MockAdapter host spawn.
 */
class ContainerScriptedAdapter implements Adapter {
  readonly name = 'mock' as const;
  readonly capabilities: CapabilityFlags = {
    can_exec: true,
    can_write_outside_tree: false,
    has_gh: false,
    can_signal: true,
    streams_usage: false,
    runtime: 'container',
  };
  /** Container ids this backend exec'd into — the in-container proof. */
  readonly inContainer: string[] = [];
  /** Run ids that took the host fallback (cardless stages). */
  readonly hostRuns: string[] = [];
  readonly #docker: CliDockerClient;
  readonly #inner: MockAdapter;
  readonly #script: ContainerScriptFn;
  readonly #agentScript: string;
  readonly #killGraceMs: number;
  readonly #meta = new WeakMap<RenderedPrompt, ContainerRunInfo>();
  readonly #records = new Map<number, ExecRecord>();
  /** Container ids control() issued `docker kill` against — the kill
   *  itself is the durable signal (the subject restarts on retry
   *  ensure, so a post-hoc `inspect().running` race loses). */
  readonly kills: string[] = [];
  readonly #installed = new Set<string>();

  constructor(
    docker: CliDockerClient,
    opts: {
      script: ContainerScriptFn;
      agentScript?: string;
      killGraceMs?: number;
    },
  ) {
    this.#docker = docker;
    this.#script = opts.script;
    this.#agentScript = opts.agentScript ?? SCRIPT_AGENT;
    this.#killGraceMs = opts.killGraceMs ?? 1_000;
    this.#inner = new MockAdapter({
      capabilities: this.capabilities,
      delayMs: 30,
      heartbeatMs: 100,
      // Cardless stages spawn the SAME e2e agent the container gets via
      // docker cp — the bundled agent speaks the named-scenario DSL
      // only and would reject `script:<base64>` payloads.
      agentScript: this.#agentScript,
    });
  }

  prepare(subject: string, stage: string, ctx: PrepareContext): RenderedPrompt {
    const attempt = Number(ctx.run_id.split('/').pop()?.split('-')[0] ?? '1');
    const info: ContainerRunInfo = {
      subject,
      stage,
      attempt,
      ticketId: ctx.ticket_dir
        ? (ctx.ticket_dir.split('/').pop() ?? null)
        : null,
      runId: ctx.run_id,
    };
    const rendered = this.#inner.prepare(subject, stage, ctx);
    this.#meta.set(rendered, info);
    return rendered;
  }

  #scenario(rendered: RenderedPrompt): string {
    const meta = this.#meta.get(rendered);
    const spec = meta ? this.#script(meta) : 'done';
    return typeof spec === 'string'
      ? spec
      : `script:${Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url')}`;
  }

  async run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
    opts?: { run_dir?: string; container_id?: string },
  ): Promise<RunHandle> {
    const meta = this.#meta.get(rendered);
    if (meta) meta.worktree = worktree;
    const scenario = this.#scenario(rendered);
    const containerId = opts?.container_id;
    if (containerId === undefined) {
      // Cardless stage — the lazy-create rule runs it host-side.
      if (meta) this.hostRuns.push(meta.runId);
      return this.#inner.run(worktree, rendered, timeout, { scenario });
    }

    // One-time agent install — the container is persistent, so a single
    // `docker cp` covers every later `docker exec` on it.
    if (!this.#installed.has(containerId)) {
      await dockerCp(this.#agentScript, `${containerId}:${CONTAINER_AGENT}`);
      this.#installed.add(containerId);
    }
    const artifactDir =
      parseArtifactDir(rendered.text, worktree) ??
      join(worktree, '.veto', meta?.runId ?? 'run');
    const logPath = join(opts?.run_dir ?? tmpdir(), 'run.log');
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a');
    const child = this.#docker.exec(
      containerId,
      {
        workdir: worktree,
        env: {
          MOCK_SCENARIO: scenario,
          MOCK_ARTIFACT_DIR: artifactDir,
          MOCK_HEARTBEAT_MS: '100',
          MOCK_DELAY_MS: '0',
        },
        argv: ['node', CONTAINER_AGENT],
      },
      { stdio: ['ignore', fd, fd] },
    );
    closeSync(fd);
    child.unref();
    const pid = child.pid as number;
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => {
      resolveExit = r;
    });
    const rec: ExecRecord = { exitCode: null, exitPromise };
    child.on('exit', (code, signal) => {
      rec.exitCode =
        code ?? (signal === 'SIGKILL' ? 137 : signal === 'SIGTERM' ? 143 : 1);
      resolveExit();
    });
    this.#records.set(pid, rec);
    this.inContainer.push(containerId);
    return { pid, log_path: logPath, container_id: containerId };
  }

  async control(handle: RunHandle, op: ControlOp): Promise<void> {
    const cid = handle.container_id;
    if (cid === undefined) return this.#inner.control(handle, op);
    if (op === 'pause') {
      await this.#docker.pause(cid);
      return;
    }
    if (op === 'resume') {
      await this.#docker.unpause(cid);
      return;
    }
    // kill (CONDUCTOR run control, D30): TERM grace → KILL — the whole
    // container stops (its exec'd run with it); restarted by the next
    // launch's ensure. A frozen cgroup can't die — unpause first.
    const info = await this.#docker.inspect(cid).catch(() => null);
    if (info?.paused) await this.#docker.unpause(cid).catch(() => {});
    if (info?.running) {
      this.kills.push(cid);
      await this.#docker.kill(cid, 'TERM').catch(() => {});
      const deadline = Date.now() + this.#killGraceMs;
      let cur: DockerContainerInfo | null = info;
      while (cur?.running && Date.now() < deadline) {
        await sleep(50);
        cur = await this.#docker.inspect(cid).catch(() => null);
      }
      if (cur?.running) {
        await this.#docker.kill(cid, 'KILL').catch(() => {});
      }
    }
    // The local docker-exec client exits with the container — SIGKILL
    // it anyway in case the daemon already forgot the exec session.
    try {
      process.kill(handle.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  on_usage(): void {}

  async collect(handle: RunHandle, ctx: CollectContext): Promise<RunResult> {
    if (handle.container_id === undefined) {
      return this.#inner.collect(handle, ctx);
    }
    const rec = this.#records.get(handle.pid);
    if (rec) {
      await rec.exitPromise;
    } else {
      // Re-attached run (conductor restart) — poll the exec client.
      const deadline = Date.now() + 30_000;
      while (execClientAlive(handle.pid) && Date.now() < deadline) {
        await sleep(50);
      }
    }
    const raw = lastNonEmptyLine(handle.log_path);
    const sentinel = raw !== null ? MockAdapter.parseSentinel(raw) : null;
    // run_artifacts ingestion is reconcile's job — the scratch dir is
    // already host-visible via the path-identical bind mount and
    // collectArtifacts (can_write_outside_tree: false) moves it into
    // run_dir.
    return {
      sentinel,
      sentinel_raw: raw,
      artifacts: [],
      usage: null,
      exit_code: rec?.exitCode ?? null,
    };
  }
}

/** ConductorDeps wired for the e2e backend: real transitions + real
 *  container runtime on the e2e image (pull-only — never rebuilds
 *  veto/agent inside a test). */
function e2eDeps(
  docker: CliDockerClient,
  adapter: Adapter,
  configOverrides: Record<string, unknown> = {},
): ConductorDeps {
  const deps = makeDeps(docker, adapter, {
    containers: { ...CONTAINERS, image: E2E_IMAGE },
    ...configOverrides,
  });
  deps.transitions = new RealTransitionHandler(deps.config);
  deps.containerCommand = ['tail', '-f', '/dev/null'];
  return deps;
}

const repoEntry = (path: string) => ({
  path,
  card: {
    test: 'make test',
    lint: 'make lint',
    build: 'make build',
    forbidden_paths: [],
    probed_at: NOW,
    verified: true,
  },
});

describe.skipIf(!DOCKER_OK)('wp-098 container e2e (real docker)', () => {
  let docker: CliDockerClient;
  /** Subject container names that must not outlive the test. */
  const tracked = new Set<string>();
  /** Unmanaged container names created by tests (cleanup only). */
  const foreignNames: string[] = [];

  const track = (...subjects: string[]): void => {
    for (const s of subjects) tracked.add(containerName(WS, s));
  };

  beforeEach(() => {
    docker = new CliDockerClient({ env: DOCKER_ENV });
  });

  afterEach(async () => {
    // Acceptance: no container/volume/worktree residue after suite
    // teardown. Worktrees live under the tmp dir the file-level
    // afterEach already removes; only bind mounts are used (no
    // volumes are ever created by the runtime).
    for (const name of [...tracked, ...foreignNames]) {
      // `docker rm -f` hangs on a PAUSED container — unpause first so a
      // failed mid-pause test can't wedge cleanup.
      await docker.unpause(name).catch(() => {});
      await docker.rm(name, { force: true }).catch(() => {});
    }
    for (const name of tracked) {
      expect(await docker.inspect(name), `residue: ${name}`).toBeNull();
    }
    tracked.clear();
    foreignNames.length = 0;
  });

  const tickUntil = async (
    conductor: Conductor,
    pred: () => Promise<boolean> | boolean,
    desc: string,
    maxMs = 90_000,
  ): Promise<void> => {
    // Time-bounded, not tick-bounded: a tick costs seconds of real
    // docker work under load, so a tick count can't stay under the
    // vitest test timeout — and an early throw keeps the diagnostic.
    const deadline = Date.now() + maxMs;
    let ticks = 0;
    for (;;) {
      await conductor.tick();
      ticks++;
      if (await pred()) return;
      if (Date.now() > deadline) break;
      await sleep(40);
    }
    const runs = await store.listRuns({ workspace: WS });
    const diag = runs
      .map(
        (r) =>
          `${r.id} ${r.status} sentinel=${r.sentinel} raw=${r.sentinel_raw} backend=${r.backend} cid=${r.container_id}`,
      )
      .join('\n  ');
    const evts = (await store.listEvents({ workspace: WS }))
      .filter((e) =>
        [
          'run_started',
          'run_finished',
          'run_failed',
          'run_killed',
          'run_paused',
          'run_resumed',
          'status_changed',
        ].includes(e.event),
      )
      .map(
        (e) =>
          `${e.ts} ${e.run ?? e.ticket_id} ${e.event} ` +
          `${JSON.stringify(e.data ?? null)}`,
      )
      .slice(-25)
      .join('\n  ');
    const gates = (await store.listGateItems({ workspace: WS }))
      .map(
        (g) =>
          `${g.subject} ${g.gate}/${g.kind} ${JSON.stringify(g.payload ?? null)}`,
      )
      .join('\n  ');
    const notifs = (await store.listNotifications({ workspace: WS }))
      .map((n) => `${n.kind} ${n.payload?.slice(0, 300)}`)
      .join('\n  ');
    throw new Error(
      `tickUntil(${desc}) — ${ticks} ticks / ${maxMs}ms elapsed\n  runs:\n  ${diag}\n  events:\n  ${evts}\n  gates:\n  ${gates}\n  notifs:\n  ${notifs}`,
    );
  };

  const ticketStatus = async (id: string): Promise<string | undefined> =>
    (await store.getTicket({ workspace: WS, ticket_id: id }))?.status;

  const runToStatus = (
    conductor: Conductor,
    id: string,
    status: string,
  ): Promise<void> =>
    tickUntil(
      conductor,
      async () => (await ticketStatus(id)) === status,
      `${id} → ${status}`,
    );

  const setTicket = async (
    id: string,
    patch: Partial<TicketRow>,
  ): Promise<void> => {
    const t = await store.getTicket({ workspace: WS, ticket_id: id });
    if (!t) throw new Error(`setTicket: no ticket ${id}`);
    await store.upsertTicket({ ...t, ...patch });
  };

  const runsFor = (subject: string) =>
    store.listRuns({ workspace: WS, subject });

  /** Seed the implement run the ticket would have queued on its
   *  test-approved → in-progress transition — the e2e enters the chain
   *  AT in-progress, so the pending row is the claim's trigger. */
  const queueImplement = (deps: ConductorDeps, subject: string) =>
    queuePendingRun(launchCtx(deps), {
      workspace: WS,
      subject,
      stage: 'implement',
      ticketId: subject,
    });

  it(
    'full chain: worktree → ensure → exec → sentinel → collect → transition → gate-sleep → wake → teardown',
    { timeout: 240_000 },
    async () => {
      const t0 = Date.now();
      const adapter = new ContainerScriptedAdapter(docker, {
        script: (r) => {
          if (r.stage === 'implement') {
            return {
              sentinel: 'DONE',
              artifacts: { 'result.json': { ok: true, ran: 'in-container' } },
            };
          }
          if (r.stage === 'review') {
            const pass = REVIEW_PASSES[
              (r.attempt - 1) % REVIEW_PASSES.length
            ] as string;
            return {
              sentinel: `PASS-COMPLETE: ${pass}`,
              artifacts: {
                [`findings-${pass}.json`]: [
                  {
                    file: 'src/app.ts',
                    line: 1,
                    severity: 'nit',
                    category: 'style',
                    body: `nit from ${pass}`,
                  },
                ],
              },
            };
          }
          if (r.stage === 'fix') return { sentinel: 'BLOCKED: wake-ok' };
          return 'done';
        },
      });
      const deps = e2eDeps(docker, adapter);
      const conductor = new Conductor(deps);
      await putTicket('SR-E1', 'in-progress');
      track('SR-E1');
      await conductor.start(); // ping + image + startup orphan sweep
      await queueImplement(deps, 'SR-E1');
      const tBoot = Date.now();

      // The chain: worktree create → container ensure → docker exec →
      // sentinel → artifact collect → transition (verify task + 4
      // review passes) → changes-requested gate → gate-sleep.
      await runToStatus(conductor, 'SR-E1', 'changes-requested');
      const tChain = Date.now();

      const impl = (await runsFor('SR-E1')).find(
        (r) => r.stage === 'implement',
      );
      expect(impl?.status).toBe('done');
      expect(impl?.sentinel).toBe('DONE');
      expect(impl?.container_id).not.toBeNull();

      // Worktree create — the git worktree exists on the host AND was
      // the exec cwd inside the container (path-identical mount).
      const wt = impl?.worktree as string;
      expect(wt).toContain('code-repo.worktrees');
      expect(existsSync(wt)).toBe(true);
      expect(adapter.inContainer).toContain(impl?.container_id);

      // The in-container agent wrote the run's stdout — its banner is
      // in the collected run.log (sentinel source).
      const logText = readFileSync(
        join(impl?.run_dir as string, 'run.log'),
        'utf8',
      );
      expect(logText).toContain('MOCK scenario=script:');

      // Artifact collect — the worktree scratch dir crossed the bind
      // mount and was ingested as a run_artifacts row.
      expect(
        await store.getArtifact(impl?.id as string, 'result.json'),
      ).not.toBeNull();
      // The scratch dir is purged — nothing left in the worktree.
      expect(existsSync(join(wt, '.veto'))).toBe(false);

      // Transition ran the verify task + review passes to the gate.
      const gate = await store.getGateItem({
        workspace: WS,
        subject: 'SR-E1',
        gate: 'changes-requested',
      });
      expect(gate).not.toBeNull();
      const reviewRuns = (await runsFor('SR-E1')).filter(
        (r) => r.stage === 'review',
      );
      expect(reviewRuns).toHaveLength(REVIEW_PASSES.length);

      // gate-sleep — docker stop; the row records 'stopped'.
      const row = await containerRow('SR-E1');
      expect(row?.container_id).toBe(impl?.container_id);
      expect(row?.state).toBe('stopped');
      const parked = await docker.inspect(row?.container_id as string);
      expect(parked?.running).toBe(false);

      // wake — the next repo-executing launch `docker start`s the SAME
      // container (no recreate: mount set + image unchanged).
      const fixId = await launch(launchCtx(deps), {
        workspace: WS,
        subject: 'SR-E1',
        stage: 'fix',
        ticketId: 'SR-E1',
      });
      const fix = await getRun(fixId as string);
      expect(fix?.container_id).toBe(row?.container_id);
      expect((await docker.inspect(row?.container_id as string))?.running).toBe(
        true,
      );
      await tickUntil(
        conductor,
        async () => (await getRun(fixId as string))?.status === 'done',
        'wake fix run done',
      );
      expect((await getRun(fixId as string))?.sentinel).toBe('BLOCKED');
      expect(await ticketStatus('SR-E1')).toBe('blocked');

      // teardown — terminal status → docker rm + row 'removed'.
      await setTicket('SR-E1', { status: 'released' as never });
      await conductor.tick();
      expect((await containerRow('SR-E1'))?.state).toBe('removed');
      expect(await docker.inspect(containerName(WS, 'SR-E1'))).toBeNull();

      // Bind-mount timing notes (macOS Docker Desktop) — recorded into
      // the exec doc; a named-volume fallback stays a follow-up only if
      // these numbers ever hurt.
      console.log(
        `[wp-098 timings] image=${E2E_IMAGE} boot=${tBoot - t0}ms ` +
          `chain-to-gate=${tChain - tBoot}ms`,
      );
    },
  );

  it(
    'kill mid-run: container stops, worktree preserved, status stays for retry (same container wakes)',
    { timeout: 180_000 },
    async () => {
      const adapter = new ContainerScriptedAdapter(docker, {
        script: (r) =>
          r.stage === 'implement' && r.attempt === 1
            ? 'hang'
            : { sentinel: 'DONE', artifacts: { 'result.json': { ok: true } } },
      });
      const deps = e2eDeps(docker, adapter);
      const conductor = new Conductor(deps);
      await putTicket('SR-K1', 'in-progress');
      track('SR-K1');
      await conductor.start();
      await queueImplement(deps, 'SR-K1');

      await tickUntil(
        conductor,
        async () =>
          (await runsFor('SR-K1')).some((r) => r.status === 'running'),
        'killable run running',
      );
      const run1 = (await runsFor('SR-K1')).find(
        (r) => r.status === 'running',
      ) as RunRow;
      const cid = run1.container_id as string;
      const wt = run1.worktree as string;

      await conductor.control(run1.id, 'kill');

      expect((await docker.inspect(cid))?.running).toBe(false);
      expect(existsSync(wt)).toBe(true); // worktree preserved
      expect((await getRun(run1.id))?.status).toBe('killed');
      expect(await ticketStatus('SR-K1')).toBe('in-progress');
      const events = (
        await store.listEvents({ workspace: WS, ticket_id: 'SR-K1' })
      ).map((e) => e.event);
      expect(events).toContain('run_killed');

      // Retry: claim relaunches implement (attempt 2) → ensure starts
      // the SAME stopped container (docker start — the wake path).
      await tickUntil(
        conductor,
        async () =>
          (await getRun(`${WS}/SR-K1/002-implement`))?.status === 'done',
        'implement attempt 2 done',
      );
      const run2 = await getRun(`${WS}/SR-K1/002-implement`);
      expect(run2?.container_id).toBe(cid);
      expect(run2?.sentinel).toBe('DONE');
      expect((await docker.inspect(cid))?.running).toBe(true);
    },
  );

  it(
    'pause freezes work (no log growth, container cgroup paused); resume completes; the timeout clock kept ticking',
    { timeout: 180_000 },
    async () => {
      const adapter = new ContainerScriptedAdapter(docker, {
        script: (r) => {
          if (r.subject === 'SR-P1') {
            return {
              sentinel: 'DONE',
              artifacts: { 'result.json': { ok: true } },
              // Test-gated completion — a fixed delayMs loses under
              // suite load (the run DONEs before the pause lands). The
              // agent polls for `.release-p1` in the bind-mounted
              // worktree, so the run stays alive until we release it.
              waitFor: join(r.worktree as string, '.release-p1'),
            };
          }
          return 'hang'; // SR-P2 hangs forever
        },
      });
      // Implement timeout — SR-P2's run must die on schedule even
      // though it spends most of its life paused (the deadline is
      // absolute; paused runs just skip the sweep until resumed).
      // 35s leaves the whole P1 pause/release choreography inside the
      // window under load.
      const deps = e2eDeps(docker, adapter, {
        timeouts: { implement: 35 },
      });
      const conductor = new Conductor(deps);
      await putTicket('SR-P1', 'in-progress');
      await putTicket('SR-P2', 'in-progress');
      track('SR-P1', 'SR-P2');
      await conductor.start();
      await queueImplement(deps, 'SR-P1');
      await queueImplement(deps, 'SR-P2');

      // --- arm SR-P2's pause FIRST: a paused run skips the timeout
      //     sweep entirely, so freezing it early keeps attempt 1 alive
      //      through the whole P1 section (no early-kill churn). Its
      //     20s clock keeps counting while frozen — by resume time the
      //     deadline is already past. ---
      await tickUntil(
        conductor,
        async () =>
          (await runsFor('SR-P2')).some((r) => r.status === 'running'),
        'SR-P2 running',
      );
      const p2 = (await runsFor('SR-P2')).find(
        (r) => r.status === 'running',
      ) as RunRow;
      // Wait until the exec'd agent is alive inside the container —
      // `running` means the exec CLIENT spawned, but the daemon-side
      // session can still be in flight; pausing in that window makes
      // docker reject the exec ('cannot exec in a paused state', 126)
      // and the run fails instead of being timeout-killed.
      const p2Log = join(p2.run_dir as string, 'run.log');
      await tickUntil(
        conductor,
        () =>
          existsSync(p2Log) &&
          readFileSync(p2Log, 'utf8').includes('MOCK scenario='),
        'SR-P2 agent exec established',
      );
      // Bounded poll for the cgroup state — `docker pause` already ran
      // inside control(), but under suite load a single `inspect` can
      // transiently report "No such container" while the daemon
      // reconciles state. Polls until the deadline; fails loudly with
      // the run row if the container is genuinely gone.
      const awaitPaused = async (
        cid: string,
        want: boolean,
        run: RunRow,
      ): Promise<void> => {
        let info: DockerContainerInfo | null = null;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          info = await docker.inspect(cid).catch(() => null);
          if (info !== null && info.paused === want) return;
          await sleep(100);
        }
        expect(
          info?.paused,
          `container ${cid} paused=${want}; run=${JSON.stringify({ id: run.id, status: run.status, backend: run.backend, container_id: run.container_id })}`,
        ).toBe(want);
      };

      await conductor.control(p2.id, 'pause');
      await awaitPaused(p2.container_id as string, true, p2);

      // --- pause/resume: SR-P1 finishes after a mid-run freeze ---
      await tickUntil(
        conductor,
        async () =>
          (await runsFor('SR-P1')).some(
            (r) => r.status === 'running' && r.container_id !== null,
          ),
        'SR-P1 running in container',
      );
      const p1 = (await runsFor('SR-P1')).find(
        (r) => r.status === 'running' && r.container_id !== null,
      ) as RunRow;
      // Same exec-establishment race as P2 — wait for the agent's
      // banner line before pausing.
      const p1Log = join(p1.run_dir as string, 'run.log');
      await tickUntil(
        conductor,
        () =>
          existsSync(p1Log) &&
          readFileSync(p1Log, 'utf8').includes('MOCK scenario='),
        'SR-P1 agent exec established',
      );
      await conductor.control(p1.id, 'pause');
      await awaitPaused(p1.container_id as string, true, p1);
      expect((await getRun(p1.id))?.status).toBe('paused');

      // Work frozen — the agent emits heartbeat lines ~10Hz live, so a
      // flat log size across 600ms is a real cgroup freeze, not a quiet
      // process. Settle 300ms first: the host-side exec client can
      // still flush bytes the agent wrote just before the freeze.
      await sleep(300);
      const frozenSize = statSync(p1Log).size;
      await sleep(600);
      expect(statSync(p1Log).size).toBe(frozenSize);

      await conductor.control(p1.id, 'resume');
      await awaitPaused(p1.container_id as string, false, p1);
      // Release the run — the agent sees the file via the bind mount
      // and emits DONE.
      writeFileSync(join(p1.worktree as string, '.release-p1'), 'go');
      await tickUntil(
        conductor,
        async () => (await getRun(p1.id))?.status === 'done',
        'SR-P1 done',
      );
      expect((await getRun(p1.id))?.sentinel).toBe('DONE');

      // --- timeout keeps ticking while paused: SR-P2's deadline is
      //     absolute from started_at — most of its elapsed ran out
      //     frozen. On resume the sweep kills it at that deadline;
      //     pause did not defer the clock. ---
      await conductor.control(p2.id, 'resume');
      await tickUntil(
        conductor,
        async () => (await getRun(p2.id))?.status === 'killed',
        'SR-P2 killed after resume',
      );
      // The timeout kill issued `docker kill` against the subject —
      // inspecting `running` here races the same-tick retry ensure
      // (reconcile kills → claim launches attempt 2 → `docker start`
      // revives the shared container before the assert can run).
      expect(adapter.kills).toContain(p2.container_id);
      expect(await ticketStatus('SR-P2')).toBe('in-progress'); // stays for retry
      const events = (
        await store.listEvents({ workspace: WS, ticket_id: 'SR-P2' })
      ).map((e) => e.event);
      expect(events).toContain('run_paused');
      expect(events).toContain('run_resumed');
      expect(events).toContain('run_killed');
    },
  );

  it(
    'orphan sweep after a simulated conductor crash: rowless/terminal managed containers removed, live subjects + unmanaged kept',
    { timeout: 120_000 },
    async () => {
      const adapter = new ContainerScriptedAdapter(docker, {
        script: () => 'done',
      });
      const deps = e2eDeps(docker, adapter);
      await putTicket('SR-KEEP', 'in-progress');
      await putTicket('SR-VANISH', 'in-progress');
      await putTicket('SR-TERM', 'in-progress');
      track('SR-KEEP', 'SR-VANISH', 'SR-TERM');
      const ctr = containerRuntimeDeps(deps);
      for (const s of ['SR-KEEP', 'SR-VANISH', 'SR-TERM']) {
        await ensureSubjectContainer(ctr, {
          workspace: WS,
          subject: s,
          mounts: [codeRepo],
        });
      }

      // Unmanaged container — the sweep never lists/touches it.
      const foreignName = `wp098-foreign-${Date.now()}`;
      foreignNames.push(foreignName);
      const foreignId = await docker.create({
        name: foreignName,
        image: E2E_IMAGE,
        argv: ['tail', '-f', '/dev/null'],
      });

      // Crash scene: SR-VANISH's ticket row is gone, SR-TERM went
      // terminal with the container still up, and SR-GHOST is a managed
      // container with no `containers` row (died between create and
      // upsert).
      await store.deleteTicket({ workspace: WS, ticket_id: 'SR-VANISH' });
      await setTicket('SR-TERM', { status: 'released' as never });
      track('SR-GHOST');
      const ghostId = await docker.create({
        name: containerName(WS, 'SR-GHOST'),
        image: E2E_IMAGE,
        labels: {
          [MANAGED_LABEL]: 'true',
          [SUBJECT_LABEL]: `${WS}/SR-GHOST`,
        },
        argv: ['tail', '-f', '/dev/null'],
      });

      // A fresh conductor start() IS the post-crash startup sweep.
      const report = await new Conductor(deps).start();
      expect(report.swept.removed).toEqual(
        expect.arrayContaining([
          containerName(WS, 'SR-VANISH'),
          containerName(WS, 'SR-TERM'),
          containerName(WS, 'SR-GHOST'),
        ]),
      );
      expect(report.swept.kept).toContain(containerName(WS, 'SR-KEEP'));
      expect(await docker.inspect(ghostId)).toBeNull();
      expect(
        (await docker.inspect(containerName(WS, 'SR-KEEP')))?.running,
      ).toBe(true);
      expect(await docker.inspect(foreignId)).not.toBeNull();
    },
  );

  it(
    'multi-repo ticket: two worktree mounts, one container',
    { timeout: 180_000 },
    async () => {
      const codeRepo2 = join(dir, 'code-repo-2');
      cpSync(CODE_FIXTURE, codeRepo2, { recursive: true });
      gitInit(codeRepo2);
      const adapter = new ContainerScriptedAdapter(docker, {
        script: () => ({
          sentinel: 'DONE',
          artifacts: { 'result.json': { ok: true } },
        }),
      });
      const deps = e2eDeps(docker, adapter, {
        repos: {
          'code-repo': repoEntry(codeRepo),
          'code-repo-2': repoEntry(codeRepo2),
        },
      });
      const conductor = new Conductor(deps);
      await putTicket('SR-M1', 'in-progress', ['code-repo', 'code-repo-2']);
      track('SR-M1');
      await conductor.start();
      await queueImplement(deps, 'SR-M1');

      await tickUntil(
        conductor,
        async () =>
          (await getRun(`${WS}/SR-M1/001-implement`))?.status === 'done',
        'SR-M1 implement done',
      );

      // One ticket_repos row per repo — both worktrees created.
      const rows = await store.listTicketRepos({
        workspace: WS,
        ticket_id: 'SR-M1',
      });
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(existsSync(r.worktree as string)).toBe(true);
      }

      // ONE container, both mounts.
      const cid = (await containerRow('SR-M1'))?.container_id as string;
      const info = await docker.inspect(cid);
      const mounts = (info?.mounts ?? [])
        .filter((m) => m.type === 'bind')
        .map((m) => m.source)
        .sort();
      expect(mounts).toEqual(rows.map((r) => r.worktree).sort());
      const managed = (await docker.listManaged()).filter(
        (c) => c.labels[SUBJECT_LABEL] === `${WS}/SR-M1`,
      );
      expect(managed).toHaveLength(1);

      // Both mounts are live inside the container.
      const [a, b] = rows.map((r) => r.worktree);
      const { stdout } = await docker.execRun(cid, {
        argv: ['sh', '-c', `test -d "${a}" && test -d "${b}" && echo BOTH`],
      });
      expect(stdout.trim()).toBe('BOTH');
      expect((await getRun(`${WS}/SR-M1/001-implement`))?.container_id).toBe(
        cid,
      );
    },
  );

  it(
    'repo-set growth recreates the container (new id, union of mounts)',
    { timeout: 180_000 },
    async () => {
      const codeRepo2 = join(dir, 'code-repo-2');
      cpSync(CODE_FIXTURE, codeRepo2, { recursive: true });
      gitInit(codeRepo2);
      const adapter = new ContainerScriptedAdapter(docker, {
        script: (r) =>
          r.stage === 'fix'
            ? { sentinel: 'BLOCKED: grown' }
            : { sentinel: 'BLOCKED: parked' },
      });
      const deps = e2eDeps(docker, adapter, {
        repos: {
          'code-repo': repoEntry(codeRepo),
          'code-repo-2': repoEntry(codeRepo2),
        },
      });
      const conductor = new Conductor(deps);
      await putTicket('SR-MG1', 'in-progress', ['code-repo']);
      track('SR-MG1');
      await conductor.start();
      await queueImplement(deps, 'SR-MG1');

      await tickUntil(
        conductor,
        async () =>
          (await getRun(`${WS}/SR-MG1/001-implement`))?.status === 'done',
        'SR-MG1 implement done',
      );
      const row1 = await containerRow('SR-MG1');
      const id1 = row1?.container_id as string;
      expect(
        (await docker.inspect(id1))?.mounts.filter((m) => m.type === 'bind'),
      ).toHaveLength(1);

      // The ticket's repo set grows mid-flight → the next launch's
      // ensure sees the mount drift and recreates (container state is
      // disposable; the worktrees hold everything that matters).
      await setTicket('SR-MG1', { repos: ['code-repo', 'code-repo-2'] });
      const fixId = await launch(launchCtx(deps), {
        workspace: WS,
        subject: 'SR-MG1',
        stage: 'fix',
        ticketId: 'SR-MG1',
      });
      const row2 = await containerRow('SR-MG1');
      const id2 = row2?.container_id as string;
      expect(id2).not.toBe(id1);
      expect(await docker.inspect(id1)).toBeNull(); // old container rm'd
      const grown = await docker.inspect(id2);
      expect(grown?.running).toBe(true);
      expect(grown?.mounts.filter((m) => m.type === 'bind')).toHaveLength(2);
      await tickUntil(
        conductor,
        async () => (await getRun(fixId as string))?.status === 'done',
        'SR-MG1 fix done',
      );
      expect((await getRun(fixId as string))?.container_id).toBe(id2);
    },
  );
});
