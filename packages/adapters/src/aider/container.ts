/**
 * Container exec substrate for `runtime: container` runs (D30, wp-096).
 *
 * Runs are `docker exec -w <worktree> -e <secret-env-names>` inside the
 * subject's persistent container (ensured by the conductor — wp-095
 * lifecycle, wp-097 wiring). The adapter owns only the exec + control
 * verbs here; the container itself is disposable execution context.
 *
 * {@link ContainerDockerClient} mirrors the surface of the conductor's
 * `CliDockerClient` (`packages/conductor/src/envops/containers.ts`) —
 * structurally compatible, so wp-097 can inject the conductor's client
 * while the default {@link CliDockerExec} keeps the adapter
 * self-contained (adapters can't import conductor — dependency
 * direction). Shells out to the real `docker` CLI — same rule as
 * git/gh (AGENTS.md): never a library binding.
 *
 * Secrets ride the exec env as bare `-e NAME` passthrough — docker
 * resolves the value from the CLI process's own environment, so secret
 * VALUES never appear in argv (and never in logs).
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';

const DEFAULT_DOCKER_TIMEOUT_MS = 120_000;

/** `docker exec` spec — identical shape to the conductor client's
 *  DockerExecSpec so the two clients are interchangeable. */
export interface DockerExecSpec {
  /** `-w` working dir — the mounted worktree path (identical
   *  host/container-side per the D30 mount convention). */
  workdir?: string;
  /** Env passthrough names → bare `-e NAME` (the docker CLI resolves
   *  each value from ITS OWN environment — secrets never in argv). The
   *  caller must place the values in the spawned docker child's env. */
  envKeys?: string[];
  /** Explicit `-e K=V` env — non-secret values only (argv-visible). */
  env?: Record<string, string>;
  /** `--user` override. */
  user?: string;
  /** Command + args inside the container. */
  argv: string[];
}

/** The adapter's docker surface — exec spawn + the control verbs
 *  (`docker kill -s TERM` → `docker kill` | `docker pause` |
 *  `docker unpause`). Structurally satisfied by the conductor's
 *  CliDockerClient and by {@link CliDockerExec}. */
export interface ContainerDockerClient {
  /** `docker exec` argv (the wp-096 seam — pinned in tests). */
  execArgv(container: string, spec: DockerExecSpec): string[];
  /** Spawn a detached `docker exec` — stdio/env belong to the caller
   *  (the adapter pipes stdout/stderr to the run log; `envKeys` resolve
   *  against the child's env so secret values ride spawn env, never
   *  argv). */
  exec(
    container: string,
    spec: DockerExecSpec,
    spawnOpts?: Parameters<typeof spawn>[2],
  ): ChildProcess;
  /** `docker kill -s <signal>` — signals the container's PID1 (stops
   *  the container and every exec'd process with it — D30 kill
   *  semantics). */
  kill(id: string, signal?: string): Promise<void>;
  /** `docker pause` — freezes the container cgroup, exec'd run
   *  included. */
  pause(id: string): Promise<void>;
  /** `docker unpause`. */
  unpause(id: string): Promise<void>;
}

/** A `docker` CLI invocation failed — stderr carries docker's own
 *  message (argv is safe to include: exec env forwards names only). */
export class DockerExecError extends Error {
  override readonly name = 'DockerExecError';
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function runDocker(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    execFile(
      bin,
      [...args],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          res({ stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        rej(
          new DockerExecError(
            `docker ${args.join(' ')} failed (exit ${String(err.code)}): ${String(stderr).trim()}`,
            args,
            typeof err.code === 'number' ? err.code : null,
            String(stderr),
          ),
        );
      },
    );
  });
}

/** Default docker client — shells the real `docker` CLI. Control ops
 *  (kill/pause/unpause) are best-effort at the call site: a stopped or
 *  missing container errors, and the adapter swallows it the same way
 *  it swallows a signal to a dead pid. */
export class CliDockerExec implements ContainerDockerClient {
  readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: { bin?: string; timeoutMs?: number } = {}) {
    this.bin = opts.bin ?? 'docker';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
  }

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

  async kill(id: string, signal = 'KILL'): Promise<void> {
    await runDocker(this.bin, ['kill', '-s', signal, id], this.timeoutMs);
  }

  async pause(id: string): Promise<void> {
    await runDocker(this.bin, ['pause', id], this.timeoutMs);
  }

  async unpause(id: string): Promise<void> {
    await runDocker(this.bin, ['unpause', id], this.timeoutMs);
  }
}
