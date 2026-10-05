/**
 * wp-095 container-runtime tests (D30):
 *
 *  1. `CliDockerClient` argv — a mock `docker` binary on disk captures
 *     argv + serves canned replies, so the shell-out shape is pinned
 *     without a daemon.
 *  2. Lifecycle logic vs a fake `DockerClientLike` — ensure/sleep/
 *     wake/teardown/sweep decision tables, deterministic.
 *  3. Real-daemon integration — `describe.skipIf` when `docker info`
 *     fails (AGENTS: absent daemon is a hard error only for container
 *     backends; tests skip cleanly).
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store, TicketRow } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliDockerClient,
  type ContainerRuntimeDeps,
  ContainerRuntimeError,
  type DockerClientLike,
  type DockerContainerInfo,
  type DockerCreateSpec,
  DockerError,
  type DockerExecSpec,
  MANAGED_LABEL,
  SUBJECT_LABEL,
  containerName,
  containerRuntimeBackends,
  ensureAgentImage,
  ensureSubjectContainer,
  prepareContainerRuntime,
  sleepSubjectContainer,
  sweepOrphanedContainers,
  teardownSubjectContainer,
  wakeSubjectContainer,
} from '../src/envops/containers.js';

const WS = 'wstest';
const NOW = '2026-10-04T00:00:00.000Z';

const CONTAINERS = {
  runtime: 'container' as const,
  image: 'veto/agent:latest',
  cpu: 2,
  memory: '256m',
  stop_on_gate: true,
};

// ---------------------------------------------------------------------------
// Mock docker binary — logs argv to $MOCK_LOG, canned replies from env vars.
// ---------------------------------------------------------------------------

const MOCK_DOCKER = `#!/usr/bin/env bash
set -u
echo "$*" >> "\${MOCK_LOG:-/dev/null}"
cmd="\${1:-}"
shift || true
case "$cmd" in
  info) echo '24.0.0-mock' ;;
  image)
    if [ "\${1:-}" = 'inspect' ]; then
      if [ -f "\${MOCK_IMAGE:-/dev/null}" ] && grep -qx "\${2:-}" "\${MOCK_IMAGE}" 2>/dev/null; then
        echo '[]'; exit 0
      fi
      echo "Error response from daemon: No such image: \${2:-}" >&2; exit 1
    fi ;;
  ps) [ -f "\${MOCK_PS:-/dev/null}" ] && cat "\${MOCK_PS}" ;;
  inspect)
    if [ -f "\${MOCK_INSPECT:-}" ]; then cat "\${MOCK_INSPECT}"; exit 0; fi
    echo "Error response from daemon: No such container: \${1:-}" >&2; exit 1 ;;
  create) echo 'cafe0000feedface' ;;
  build|pull|start|stop|rm|kill|pause|unpause|exec) ;;
  *) echo "mock-docker: unhandled $cmd $*" >&2; exit 2 ;;
esac
`;

function writeMockDocker(dir: string): { bin: string; log: string } {
  const bin = join(dir, 'docker');
  writeFileSync(bin, MOCK_DOCKER);
  chmodSync(bin, 0o755);
  const log = join(dir, 'docker.log');
  return { bin, log };
}

const logLines = (log: string): string[] =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '');

// ---------------------------------------------------------------------------
// Fake docker client — lifecycle unit tests.
// ---------------------------------------------------------------------------

class FakeDocker implements DockerClientLike {
  readonly containers = new Map<string, DockerContainerInfo>();
  readonly byName = new Map<string, string>();
  readonly calls: string[] = [];
  readonly images = new Set<string>([CONTAINERS.image]);
  readonly buildCalls: {
    tag: string;
    dockerfile: string;
    contextDir: string;
  }[] = [];
  readonly pullCalls: string[] = [];
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
  async buildImage(o: {
    tag: string;
    dockerfile: string;
    contextDir: string;
  }): Promise<void> {
    this.calls.push(`build ${o.tag}`);
    this.buildCalls.push(o);
    this.images.add(o.tag);
  }
  async pullImage(image: string): Promise<void> {
    this.calls.push(`pull ${image}`);
    this.pullCalls.push(image);
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
      c.status = 'running';
      c.running = true;
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
// Shared harness — a real Store (PGlite) + fake docker.
// ---------------------------------------------------------------------------

let dir: string;
let store: PostgresStore;

const deps = (
  docker: DockerClientLike,
  over: Partial<ContainerRuntimeDeps> = {},
): ContainerRuntimeDeps => ({
  docker,
  store,
  containers: CONTAINERS,
  dockerfile: null,
  now: () => new Date(NOW),
  ...over,
});

async function putTicket(
  ticketId: string,
  status: TicketRow['status'],
): Promise<void> {
  await store.upsertTicket({
    workspace: WS,
    ticket_id: ticketId,
    feature: null,
    title: `t ${ticketId}`,
    status,
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos: [],
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

const getRow = (s: Store, subject: string) =>
  s.getContainer({ workspace: WS, subject });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp095-'));
  store = await PostgresStore.connect('pglite:');
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// containerName
// ---------------------------------------------------------------------------

describe('containerName', () => {
  it('veto-<workspace>-<subject-slug> per CONDUCTOR', () => {
    expect(containerName('team-a', 'SR-0042')).toBe('veto-team-a-sr-0042');
  });
  it('slugifies subjects with colons and caps', () => {
    expect(containerName('ws', 'probe:My Repo')).toBe('veto-ws-probe-my-repo');
  });
  it('keeps very long subjects inside the docker name budget with a hash tail', () => {
    const name = containerName('workspace', `SR-${'9'.repeat(200)}`);
    expect(name.length).toBeLessThanOrEqual(100);
    // truncated subject keeps uniqueness — a different tail subject →
    // a different name
    const other = containerName('workspace', `SR-${'8'.repeat(200)}`);
    expect(other).not.toBe(name);
  });
});

// ---------------------------------------------------------------------------
// CliDockerClient argv (mock binary)
// ---------------------------------------------------------------------------

describe('CliDockerClient (mock docker binary)', () => {
  it('create emits labels, bind mounts, caps, and the keepalive argv', async () => {
    const { bin, log } = writeMockDocker(dir);
    const docker = new CliDockerClient({ bin, env: { MOCK_LOG: log } });
    const id = await docker.create({
      name: 'veto-ws-sr-0001',
      image: 'veto/agent:latest',
      labels: {
        [MANAGED_LABEL]: 'true',
        [SUBJECT_LABEL]: 'ws/SR-0001',
      },
      mounts: [{ source: '/tmp/wt-a' }, { source: '/tmp/wt-b' }],
      cpus: 2,
      memory: '4g',
      workdir: '/tmp/wt-a',
    });
    expect(id).toBe('cafe0000feedface');
    const line = logLines(log).find((l) => l.startsWith('create '));
    expect(line).toContain('create --name veto-ws-sr-0001 --init');
    expect(line).toContain('--label veto/managed=true');
    expect(line).toContain('--label veto/subject=ws/SR-0001');
    expect(line).toContain('-v /tmp/wt-a:/tmp/wt-a');
    expect(line).toContain('-v /tmp/wt-b:/tmp/wt-b');
    expect(line).toContain('--cpus 2');
    expect(line).toContain('--memory 4g');
    expect(line).toContain('-w /tmp/wt-a');
    expect(line).toContain('veto/agent:latest sleep infinity');
  });

  it('execArgv puts workdir + bare -e names before the container — secrets never in argv as values', () => {
    const docker = new CliDockerClient({ bin: 'docker' });
    const argv = docker.execArgv('cafe0000', {
      workdir: '/wt',
      envKeys: ['OPENROUTER_API_KEY', 'GH_TOKEN'],
      env: { LANG: 'C.UTF-8' },
      argv: ['aider', '--message-file', '/p.md'],
    });
    expect(argv).toEqual([
      'exec',
      '-w',
      '/wt',
      '-e',
      'OPENROUTER_API_KEY',
      '-e',
      'GH_TOKEN',
      '-e',
      'LANG=C.UTF-8',
      'cafe0000',
      'aider',
      '--message-file',
      '/p.md',
    ]);
  });

  it('listManaged filters on the veto/managed label and batch-inspects', async () => {
    const { bin, log } = writeMockDocker(dir);
    const ps = join(dir, 'ps.txt');
    writeFileSync(ps, 'id1\nid2\n');
    const inspect = join(dir, 'inspect.json');
    writeFileSync(
      inspect,
      JSON.stringify([
        {
          Id: 'id1full',
          Name: '/veto-ws-a-0001',
          Config: {
            Image: 'veto/agent:latest',
            Labels: { [MANAGED_LABEL]: 'true', [SUBJECT_LABEL]: 'ws/A-0001' },
          },
          State: { Status: 'running', Running: true, Paused: false },
          Mounts: [],
        },
        {
          Id: 'id2full',
          Name: '/veto-ws-a-0002',
          Config: { Image: 'veto/agent:latest', Labels: {} },
          State: { Status: 'exited', Running: false, Paused: false },
          Mounts: [],
        },
      ]),
    );
    const docker = new CliDockerClient({
      bin,
      env: { MOCK_LOG: log, MOCK_PS: ps, MOCK_INSPECT: inspect },
    });
    const list = await docker.listManaged();
    expect(list.map((c) => c.name)).toEqual([
      'veto-ws-a-0001',
      'veto-ws-a-0002',
    ]);
    expect(list[0]?.running).toBe(true);
    const calls = logLines(log);
    expect(calls[0]).toBe('ps -aq --filter label=veto/managed=true');
    expect(calls[1]).toBe('inspect id1 id2');
  });

  it('inspect returns null on "No such container"; a missing binary throws DockerError', async () => {
    const { bin, log } = writeMockDocker(dir);
    const docker = new CliDockerClient({ bin, env: { MOCK_LOG: log } });
    expect(await docker.inspect('missing')).toBeNull();
    const absent = new CliDockerClient({ bin: join(dir, 'no-such-docker') });
    await expect(absent.ping()).rejects.toThrow(DockerError);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — fake docker + real (PGlite) store
// ---------------------------------------------------------------------------

describe('subject container lifecycle (fake docker)', () => {
  it('ensure creates + starts, writes a running containers row with labels+mounts', async () => {
    const docker = new FakeDocker();
    const res = await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a', '/wt/b'],
    });
    expect(res?.action).toBe('created');
    expect(res?.row.state).toBe('running');
    expect(res?.row.container_id).toBe('fakeid0001');
    const c = docker.containers.get('fakeid0001');
    expect(c?.labels[SUBJECT_LABEL]).toBe(`${WS}/SR-0001`);
    expect(c?.mounts.map((m) => m.source)).toEqual(['/wt/a', '/wt/b']);
    expect(docker.calls).toEqual([
      `inspect ${containerName(WS, 'SR-0001')}`,
      'create veto-wstest-sr-0001',
      'start fakeid0001',
    ]);
    const row = await getRow(store, 'SR-0001');
    expect(row?.state).toBe('running');
    expect(row?.image).toBe('veto/agent:latest');
  });

  it('ensure on a running container is a no-op', async () => {
    const docker = new FakeDocker();
    await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    docker.calls.length = 0;
    const res = await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    expect(res?.action).toBe('running');
    expect(docker.calls).toEqual(['inspect fakeid0001']);
  });

  it('ensure recreates when ticket_repos grows the mount set', async () => {
    const docker = new FakeDocker();
    const first = await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    docker.calls.length = 0;
    const res = await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a', '/wt/b'],
    });
    expect(res?.action).toBe('recreated');
    expect(res?.row.container_id).toBe('fakeid0002');
    expect(docker.calls).toEqual([
      'inspect fakeid0001',
      'rm fakeid0001',
      'create veto-wstest-sr-0001',
      'start fakeid0002',
    ]);
    expect(docker.containers.get('fakeid0002')?.mounts).toHaveLength(2);
    // the row keeps the subject's history — created_at refreshed
    const row = await getRow(store, 'SR-0001');
    expect(row?.container_id).toBe('fakeid0002');
    expect(row?.state).toBe('running');
  });

  it('ensure recreates when the configured image drifts', async () => {
    const docker = new FakeDocker();
    await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    const res = await ensureSubjectContainer(
      deps(docker, {
        containers: { ...CONTAINERS, image: 'veto/agent:v2' },
      }),
      { workspace: WS, subject: 'SR-0001', mounts: ['/wt/a'] },
    );
    expect(res?.action).toBe('recreated');
    expect(res?.row.image).toBe('veto/agent:v2');
  });

  it('ensure unpauses a paused container instead of re-creating', async () => {
    const docker = new FakeDocker();
    await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    await docker.pause('fakeid0001');
    docker.calls.length = 0;
    const res = await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    expect(res?.action).toBe('started');
    expect(docker.calls).toEqual(['inspect fakeid0001', 'unpause fakeid0001']);
    expect((await getRow(store, 'SR-0001'))?.state).toBe('running');
  });

  it('sleep stops, wake restarts the same container', async () => {
    const docker = new FakeDocker();
    await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    expect(
      await sleepSubjectContainer(deps(docker), {
        workspace: WS,
        subject: 'SR-0001',
      }),
    ).toBe('stopped');
    const stopped = await getRow(store, 'SR-0001');
    expect(stopped?.state).toBe('stopped');
    expect(stopped?.stopped_at).toBe(NOW);
    const woke = await wakeSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
    });
    expect(woke?.action).toBe('started');
    expect(woke?.row.container_id).toBe('fakeid0001');
  });

  it('wake returns null when nothing exists; ensure creates lazily', async () => {
    const docker = new FakeDocker();
    expect(
      await wakeSubjectContainer(deps(docker), {
        workspace: WS,
        subject: 'SR-0099',
      }),
    ).toBeNull();
    expect(docker.calls).not.toContain('create');
    const res = await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0099',
      mounts: ['/wt/a'],
    });
    expect(res?.action).toBe('created');
  });

  it('teardown removes the container and marks the row removed', async () => {
    const docker = new FakeDocker();
    await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    expect(
      await teardownSubjectContainer(deps(docker), {
        workspace: WS,
        subject: 'SR-0001',
      }),
    ).toBe('removed');
    expect(docker.containers.size).toBe(0);
    const row = await getRow(store, 'SR-0001');
    expect(row?.state).toBe('removed');
    expect(row?.stopped_at).toBe(NOW);
  });

  it('adopts a same-name managed container left behind by a crash', async () => {
    const docker = new FakeDocker();
    // conductor crashed after docker create but before upsertContainer
    await docker.create({
      name: containerName(WS, 'SR-0001'),
      image: CONTAINERS.image,
      labels: {
        [MANAGED_LABEL]: 'true',
        [SUBJECT_LABEL]: `${WS}/SR-0001`,
      },
      mounts: [{ source: '/wt/a' }],
    });
    await docker.start('fakeid0001');
    const res = await ensureSubjectContainer(deps(docker), {
      workspace: WS,
      subject: 'SR-0001',
      mounts: ['/wt/a'],
    });
    expect(res?.action).toBe('adopted');
    expect((await getRow(store, 'SR-0001'))?.container_id).toBe('fakeid0001');
  });

  it('fails closed on a foreign container squatting on the veto name', async () => {
    const docker = new FakeDocker();
    await docker.create({
      name: containerName(WS, 'SR-0001'),
      image: 'alpine:latest',
      labels: {}, // not veto-managed
    });
    await expect(
      ensureSubjectContainer(deps(docker), {
        workspace: WS,
        subject: 'SR-0001',
        mounts: ['/wt/a'],
      }),
    ).rejects.toThrow(ContainerRuntimeError);
  });

  it('sweep removes managed containers with no row or a terminal subject — never unmanaged ones', async () => {
    const docker = new FakeDocker();
    // (a) managed, no containers row → orphan
    await docker.create({
      name: 'veto-wstest-ghost-1',
      image: CONTAINERS.image,
      labels: { [MANAGED_LABEL]: 'true', [SUBJECT_LABEL]: `${WS}/GHOST-1` },
    });
    // (b) managed + row + terminal ticket → orphan
    await putTicket('SR-TERM', 'released');
    await docker.create({
      name: 'veto-wstest-sr-term',
      image: CONTAINERS.image,
      labels: { [MANAGED_LABEL]: 'true', [SUBJECT_LABEL]: `${WS}/SR-TERM` },
    });
    await store.upsertContainer({
      workspace: WS,
      subject: 'SR-TERM',
      container_id: 'fakeid0002',
      image: CONTAINERS.image,
      state: 'running',
      created_at: NOW,
      stopped_at: null,
    });
    // (c) managed + row + live ticket → kept
    await putTicket('SR-LIVE', 'in-progress');
    await docker.create({
      name: 'veto-wstest-sr-live',
      image: CONTAINERS.image,
      labels: { [MANAGED_LABEL]: 'true', [SUBJECT_LABEL]: `${WS}/SR-LIVE` },
    });
    await store.upsertContainer({
      workspace: WS,
      subject: 'SR-LIVE',
      container_id: 'fakeid0003',
      image: CONTAINERS.image,
      state: 'running',
      created_at: NOW,
      stopped_at: null,
    });
    // (d) unmanaged container — not even labeled → untouched
    await docker.create({ name: 'foreign-cron', image: 'alpine' });

    const res = await sweepOrphanedContainers(deps(docker));
    expect(res.removed).toEqual(['veto-wstest-ghost-1', 'veto-wstest-sr-term']);
    expect(res.kept).toEqual(['veto-wstest-sr-live']);
    expect(docker.byName.has('foreign-cron')).toBe(true);
    expect((await getRow(store, 'SR-TERM'))?.state).toBe('removed');
  });

  it('sweep removes a managed container whose subject ticket was deleted', async () => {
    const docker = new FakeDocker();
    await docker.create({
      name: 'veto-wstest-sr-gone',
      image: CONTAINERS.image,
      labels: { [MANAGED_LABEL]: 'true', [SUBJECT_LABEL]: `${WS}/SR-GONE` },
    });
    await store.upsertContainer({
      workspace: WS,
      subject: 'SR-GONE',
      container_id: 'fakeid0001',
      image: CONTAINERS.image,
      state: 'running',
      created_at: NOW,
      stopped_at: null,
    });
    const res = await sweepOrphanedContainers(deps(docker));
    expect(res.removed).toEqual(['veto-wstest-sr-gone']);
  });
});

// ---------------------------------------------------------------------------
// Runtime resolution + startup prepare
// ---------------------------------------------------------------------------

describe('runtime resolution', () => {
  const adapters = {
    devin: {
      capabilities: {
        can_exec: true,
        can_write_outside_tree: true,
        has_gh: true,
        runtime: 'process' as const,
      },
    },
    aider: {
      capabilities: {
        can_exec: true,
        can_write_outside_tree: false,
        has_gh: false,
        runtime: 'container' as const,
      },
    },
    mock: {
      capabilities: {
        can_exec: true,
        can_write_outside_tree: false,
        has_gh: false,
      },
    },
  };

  it('container-capable backends follow containers.runtime; process-only stay process', () => {
    const cfg = { containers: CONTAINERS, capabilities: {} };
    expect(containerRuntimeBackends(cfg, adapters)).toEqual(['aider']);
    const proc = {
      containers: { ...CONTAINERS, runtime: 'process' as const },
      capabilities: {},
    };
    expect(containerRuntimeBackends(proc, adapters)).toEqual([]);
  });

  it('capabilities.<backend>.runtime overrides the global', () => {
    const cfg = {
      containers: { ...CONTAINERS, runtime: 'process' as const },
      capabilities: {
        aider: {
          can_exec: true,
          can_write_outside_tree: false,
          has_gh: false,
          runtime: 'container',
        },
        devin: {
          can_exec: true,
          can_write_outside_tree: true,
          has_gh: true,
          runtime: 'container',
        },
      },
    };
    expect(containerRuntimeBackends(cfg, adapters)).toEqual(['aider', 'devin']);
  });

  it('prepareContainerRuntime is a no-op when no backend needs containers', async () => {
    const docker = new FakeDocker();
    const proc = { ...CONTAINERS, runtime: 'process' as const };
    const report = await prepareContainerRuntime(
      deps(docker, { containers: proc }),
      { adapters },
    );
    expect(report.backends).toEqual([]);
    expect(report.image).toBeNull();
    expect(docker.calls).toEqual([]); // daemon never touched
  });

  it('absent daemon → hard error naming the container backends', async () => {
    const docker = new FakeDocker();
    docker.pingError = new Error('connect ENOENT /var/run/docker.sock');
    await expect(
      prepareContainerRuntime(deps(docker), { adapters }),
    ).rejects.toThrow(/aider/);
  });

  it('prepare builds the bundled image when a Dockerfile is wired', async () => {
    const docker = new FakeDocker();
    docker.images.clear();
    const dockerfile = join(dir, 'Dockerfile.agent');
    writeFileSync(dockerfile, 'FROM scratch\n');
    const report = await prepareContainerRuntime(deps(docker, { dockerfile }), {
      adapters,
    });
    expect(report.image).toBe('built');
    expect(docker.buildCalls[0]?.tag).toBe('veto/agent:latest');
    expect(report.serverVersion).toBe('fake-1.0');
  });

  it('prepare pulls a non-bundled image only when absent', async () => {
    const docker = new FakeDocker();
    docker.images.clear();
    const report = await prepareContainerRuntime(
      deps(docker, {
        containers: { ...CONTAINERS, image: 'registry.example/agent:1' },
      }),
      { adapters },
    );
    expect(report.image).toBe('pulled');
    expect(docker.pullCalls).toEqual(['registry.example/agent:1']);
    // second run — image now present
    const again = await prepareContainerRuntime(
      deps(docker, {
        containers: { ...CONTAINERS, image: 'registry.example/agent:1' },
      }),
      { adapters },
    );
    expect(again.image).toBe('present');
    expect(docker.pullCalls).toHaveLength(1);
  });
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

describe.skipIf(!DOCKER_OK)('container lifecycle (real docker daemon)', () => {
  const createdNames: string[] = [];
  let docker: CliDockerClient;
  let mounts: string[];

  const rdeps = (
    over: Partial<ContainerRuntimeDeps> = {},
  ): ContainerRuntimeDeps =>
    deps(docker, {
      containers: { ...CONTAINERS, image: TEST_IMAGE, memory: '256m' },
      command: ['tail', '-f', '/dev/null'], // busybox sleep lacks 'infinity'
      ...over,
    });

  /** Track every container the test creates for guaranteed cleanup. */
  async function trackNames(names: string[]): Promise<void> {
    createdNames.push(...names);
  }

  beforeEach(async () => {
    docker = new CliDockerClient();
    mounts = [mkdtempSync(join(tmpdir(), 'wp095-wt-'))];
    // alpine is small + already on this daemon; pull only when absent.
    if (!(await docker.imageExists(TEST_IMAGE))) {
      await docker.pullImage(TEST_IMAGE);
    }
  });

  afterEach(async () => {
    // sweep any managed test containers + everything we named
    const managed = await docker.listManaged();
    for (const c of managed) {
      if (c.name.startsWith('veto-wstest') || createdNames.includes(c.name)) {
        await docker.rm(c.id, { force: true }).catch(() => {});
      }
    }
    for (const n of createdNames.splice(0)) {
      await docker.rm(n, { force: true }).catch(() => {});
    }
    for (const m of mounts) rmSync(m, { recursive: true, force: true });
  });

  it('ensure creates a labeled, capped, mounted container; exec runs inside it', async () => {
    const res = await ensureSubjectContainer(rdeps(), {
      workspace: WS,
      subject: 'SR-0001',
      mounts,
    });
    expect(res?.action).toBe('created');
    const name = containerName(WS, 'SR-0001');
    await trackNames([name]);
    const info = await docker.inspect(name);
    expect(info?.running).toBe(true);
    expect(info?.labels[MANAGED_LABEL]).toBe('true');
    expect(info?.labels[SUBJECT_LABEL]).toBe(`${WS}/SR-0001`);
    expect(info?.mounts.map((m) => realpathSync(m.source))).toEqual(
      mounts.map((m) => realpathSync(m)),
    );
    // resource caps landed in HostConfig
    const caps = execFileSync('docker', [
      'inspect',
      '--format',
      '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}',
      name,
    ])
      .toString()
      .trim();
    expect(caps).toBe('2000000000 268435456');
    // exec inside the container sees the mounted worktree
    const out = await docker.execRun(name, {
      workdir: mounts[0] ?? '/',
      argv: ['sh', '-c', 'pwd && ls | wc -l'],
    });
    expect(out.stdout.trim().split('\n')[0]).toBe(mounts[0]);
    // secrets ride `-e NAME` passthrough — never argv values
    const secretClient = new CliDockerClient({
      env: { WP095_SECRET: 's3cr3t' },
    });
    const envOut = await secretClient.execRun(name, {
      argv: ['sh', '-c', 'echo "got=$WP095_SECRET"'],
      envKeys: ['WP095_SECRET'],
    });
    expect(envOut.stdout.trim()).toBe('got=s3cr3t');
  }, 90_000);

  it('sleep → wake → ensure; recreate picks up a grown mount set', async () => {
    const subject = 'SR-0002';
    const name = containerName(WS, subject);
    await trackNames([name]);
    await ensureSubjectContainer(rdeps(), {
      workspace: WS,
      subject,
      mounts,
    });
    expect(
      await sleepSubjectContainer(rdeps(), { workspace: WS, subject }),
    ).toBe('stopped');
    expect((await docker.inspect(name))?.running).toBe(false);
    expect((await getRow(store, subject))?.state).toBe('stopped');
    const woke = await wakeSubjectContainer(rdeps(), {
      workspace: WS,
      subject,
    });
    expect(woke?.action).toBe('started');
    expect((await docker.inspect(name))?.running).toBe(true);

    // grown ticket_repos → recreate with a NEW container id
    const second = mkdtempSync(join(tmpdir(), 'wp095-wt-'));
    mounts.push(second);
    const again = await ensureSubjectContainer(rdeps(), {
      workspace: WS,
      subject,
      mounts,
    });
    expect(again?.action).toBe('recreated');
    const info = await docker.inspect(name);
    expect(info?.mounts.map((m) => realpathSync(m.source)).sort()).toEqual(
      mounts.map((m) => realpathSync(m)).sort(),
    );
    expect(info?.id).not.toBe(woke?.row.container_id);
    // both mounts actually visible inside
    const out = await docker.execRun(name, {
      argv: ['sh', '-c', `ls ${second} >/dev/null && echo ok`],
    });
    expect(out.stdout.trim()).toBe('ok');
  }, 90_000);

  it('teardown removes the container + marks the row removed', async () => {
    const subject = 'SR-0003';
    const name = containerName(WS, subject);
    await trackNames([name]);
    await ensureSubjectContainer(rdeps(), {
      workspace: WS,
      subject,
      mounts,
    });
    expect(
      await teardownSubjectContainer(rdeps(), {
        workspace: WS,
        subject,
      }),
    ).toBe('removed');
    expect(await docker.inspect(name)).toBeNull();
    expect((await getRow(store, subject))?.state).toBe('removed');
  }, 90_000);

  it('sweep orphans: managed-no-row + terminal subject removed; unmanaged untouched', async () => {
    // orphan managed container, no row
    await docker.create({
      name: 'veto-wstest-ghost',
      image: TEST_IMAGE,
      labels: { [MANAGED_LABEL]: 'true', [SUBJECT_LABEL]: `${WS}/GHOST` },
      argv: ['tail', '-f', '/dev/null'],
    });
    await trackNames(['veto-wstest-ghost']);
    // terminal subject container
    await putTicket('SR-DONE', 'released');
    const done = await docker.create({
      name: 'veto-wstest-sr-done',
      image: TEST_IMAGE,
      labels: { [MANAGED_LABEL]: 'true', [SUBJECT_LABEL]: `${WS}/SR-DONE` },
      argv: ['tail', '-f', '/dev/null'],
    });
    await trackNames(['veto-wstest-sr-done']);
    await store.upsertContainer({
      workspace: WS,
      subject: 'SR-DONE',
      container_id: done,
      image: TEST_IMAGE,
      state: 'running',
      created_at: NOW,
      stopped_at: null,
    });
    // a foreign container the sweep must never touch
    const foreign = await docker.create({
      name: 'veto-wstest-foreign',
      image: TEST_IMAGE,
      argv: ['tail', '-f', '/dev/null'],
    });
    await trackNames(['veto-wstest-foreign']);

    const res = await sweepOrphanedContainers(rdeps());
    expect(res.removed.sort()).toEqual(
      ['veto-wstest-ghost', 'veto-wstest-sr-done'].sort(),
    );
    expect(await docker.inspect('veto-wstest-foreign')).not.toBeNull();
    expect(await docker.inspect('veto-wstest-ghost')).toBeNull();
    expect(await docker.inspect(done)).toBeNull();
    expect(await docker.inspect(foreign)).not.toBeNull();
  }, 90_000);
});
