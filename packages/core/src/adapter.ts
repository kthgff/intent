/**
 * Adapter contract — every backend implements the same interface
 * (ADAPTERS.md "The contract"). Capability flags from SETTINGS
 * `capabilities:` tell the conductor how to render and collect.
 */
import type { Backend, Runtime } from './enums.js';
import type { Usage } from './schemas.js';
import type { TokenValues } from './tokens.js';

/** SETTINGS `capabilities:` per-backend flags (ADAPTERS flag table).
 *  `can_signal`/`streams_usage` are optional extensions — a runtime that
 *  can't signal its child declares so and the UI hides pause (ADAPTERS
 *  control contract). */
export interface CapabilityFlags {
  /** Can run shell commands → repo-card commands included in prompt. */
  can_exec: boolean;
  /** Can write outside the repo → ARTIFACT_TARGETS renders as absolute
   *  `runs/<id>/` paths; false → worktree-relative `.sprint-runner/<run-id>/`
   *  scratch dir, collected post-exit (ADAPTERS ARTIFACT_TARGETS). */
  can_write_outside_tree: boolean;
  /** Can run `gh` → PR creation in-prompt vs runner-owned. */
  has_gh: boolean;
  /** POSIX signal support (kill/pause/resume); omit/false → UI hides pause. */
  can_signal?: boolean;
  /** Can stream per-message usage mid-run → emits `usage_partial`. */
  streams_usage?: boolean;
  /** Declared execution runtime (D30): `container` = container-capable —
   *  runs execute inside the subject's docker container unless the user
   *  overrides via `containers.runtime`/`capabilities.<backend>.runtime`;
   *  `process`/unset = host-process only. */
  runtime?: Runtime;
}

/** Rendered prompt returned by prepare() — template text with all
 *  {{TOKENS}} substituted (ADAPTERS token table). */
export interface RenderedPrompt {
  /** Prompt template name (e.g. 'implement', 'review-base'). */
  template: string;
  /** Fully rendered prompt text. */
  text: string;
  /** Tokens actually substituted, for audit/debug. */
  tokens: TokenValues;
}

/** Detached run handle — {pid, log_path} per ADAPTERS run();
 *  container-runtime runs also carry {container_id} (D30). */
export interface RunHandle {
  /** Host-side pid — the spawned process (`runtime: process`) or the
   *  `docker exec` client process (`runtime: container`). Either way
   *  pid liveness mirrors the run's liveness. */
  pid: number;
  /** Path to the run's stdout/stderr log (sentinel = last non-empty line). */
  log_path: string;
  /** D30 — docker id/name of the subject container this run exec'd
   *  into; absent on host-process runs. Mirrored to
   *  `runs.container_id` and persisted in handle.json so
   *  control/collect pick the docker seam after a restart. */
  container_id?: string;
  /** Reserved — the docker CLI does not surface an exec id (only
   *  `docker inspect .ExecIDs`, racy); unset today. */
  exec_id?: string;
}

/** Per-run launch options — the optional 4th arg of Adapter.run (D30
 *  seam). All fields optional so process-runtime callers pass nothing. */
export interface RunOpts {
  /** `runs/<id>/` dir when prepare() didn't flow one through — adapters
   *  that write prompt/log files pre-spawn need it. */
  run_dir?: string;
  /** Container exec target (`runtime: container`): docker id/name of
   *  the subject's ensured container — the run issues
   *  `docker exec -w <worktree>` inside it. Absent ⇒ detached
   *  host-process spawn. */
  container_id?: string;
}

/** Internal per-message usage stream (ADAPTERS on_usage → conductor;
 *  SCHEMAS §7: never a ledger event). */
export interface UsagePartial {
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
}

export type UsageCallback = (partial: UsagePartial) => void;

/** ADAPTERS control ops — POSIX signals on `runtime: process`
 *  (SIGTERM→SIGKILL | SIGSTOP | SIGCONT), docker verbs on
 *  `runtime: container` (docker kill | docker pause | docker unpause). */
export type ControlOp = 'kill' | 'pause' | 'resume';

/** Context handed to prepare/collect — deliberately loose in core;
 *  concrete packages (wp-020 renderer, adapters) refine it. */
export interface PrepareContext {
  workspace: string;
  /** Absolute ticket dir for ticket subjects. */
  ticket_dir?: string;
  /** `runs/<id>/` artifact target — absolute or scratch per
   *  can_write_outside_tree (ADAPTERS ARTIFACT_TARGETS). */
  run_dir: string;
  run_id: string;
  backend: Backend;
  model?: string;
  depth?: string;
  tokens?: TokenValues;
}

export interface CollectContext {
  workspace: string;
  ticket_dir?: string;
  run_dir: string;
  run_id: string;
}

/** ADAPTERS collect() result — {sentinel, sentinel_raw, artifacts[],
 *  usage, exit_code}. Missing/malformed sentinel → `run_failed`
 *  (failure-mapping table). */
export interface RunResult {
  /** Sentinel NAME parsed from the last non-empty line, or null. */
  sentinel: string | null;
  /** Raw last non-empty line. */
  sentinel_raw: string | null;
  /** Collected artifact paths (per ARTIFACT_TARGETS). */
  artifacts: string[];
  /** Extracted usage ledger (SCHEMAS §13); may be `source: estimated`. */
  usage: Usage | null;
  exit_code: number | null;
}

/**
 * Backend adapter interface (ADAPTERS.md contract). Implementations:
 * devin (wp-022), aider (wp-052), mock (wp-021).
 */
export interface Adapter {
  /** Backend name as registered in SETTINGS `capabilities:`. */
  readonly name: Backend;
  readonly capabilities: CapabilityFlags;

  /**
   * Render the prompt for a stage. Pick the template, inject tokens per
   * the prompt's token table, inject ARTIFACT_TARGETS per capabilities.
   * `subject` is usually a ticket id; may be `survey:<scope>:<name>`,
   * `probe:<repo>`, `import:<source>`, `interview:<run>` (ADAPTERS).
   */
  prepare(
    subject: string,
    stage: string,
    ctx: PrepareContext,
  ): Promise<RenderedPrompt> | RenderedPrompt;

  /**
   * Launch the detached run in `worktree`; return the handle —
   * {pid, log_path} for a host-process spawn, or {pid, log_path,
   * container_id} when `opts.container_id` targets the subject's
   * container (D30 `docker exec -w <worktree>`; the pid is the exec
   * client). `timeout` in seconds (SETTINGS `timeouts.<stage>`).
   */
  run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
    opts?: RunOpts,
  ): Promise<RunHandle> | RunHandle;

  /**
   * Run control (ADAPTERS) — per the run's runtime: process runs get
   * POSIX signals (kill = SIGTERM → SIGKILL after grace; pause =
   * SIGSTOP; resume = SIGCONT); container runs get docker verbs
   * (docker kill -s TERM → docker kill; docker pause; docker unpause).
   */
  control(handle: RunHandle, op: ControlOp): Promise<void> | void;

  /**
   * Register a usage callback (ADAPTERS on_usage). Adapters that can
   * stream per-message usage invoke `cb`; those that can't never call it.
   */
  on_usage(handle: RunHandle, cb: UsageCallback): void;

  /**
   * Wait until exit, gather artifacts per ARTIFACT_TARGETS, parse the
   * LAST non-empty line as the sentinel, extract usage → RunResult.
   * Usage extraction failure never fails the run (failure-mapping table).
   */
  collect(
    handle: RunHandle,
    ctx: CollectContext,
  ): Promise<RunResult> | RunResult;
}
