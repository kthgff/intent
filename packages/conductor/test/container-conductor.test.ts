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
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter } from '@sprint-runner/adapters';
import { resolveConfig } from '@sprint-runner/config';
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
  TokenValues,
  UsageCallback,
} from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
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
  type ReconcileReport,
  SUBJECT_LABEL,
  StubTransitionHandler,
  containerName,
  containerRuntimeDeps,
  ensureSubjectContainer,
  launch,
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

const DOCKER_OK = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

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
    docker = new CliDockerClient();
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
