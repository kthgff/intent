/**
 * Adapter contract — every backend implements the same interface
 * (ADAPTERS.md "The contract"). Capability flags from SETTINGS
 * `capabilities:` tell the conductor how to render and collect.
 */
import type { Backend } from './enums.js';
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

/** Detached run handle — {pid, log_path} per ADAPTERS run(). */
export interface RunHandle {
  pid: number;
  /** Path to the run's stdout/stderr log (sentinel = last non-empty line). */
  log_path: string;
}

/** Internal per-message usage stream (ADAPTERS on_usage → conductor;
 *  SCHEMAS §7: never a ledger event). */
export interface UsagePartial {
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
}

export type UsageCallback = (partial: UsagePartial) => void;

/** ADAPTERS control ops — POSIX signals. */
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
   * Spawn the detached run process in `worktree`; return {pid, log_path}.
   * `timeout` in seconds (SETTINGS `timeouts.<stage>`).
   */
  run(
    worktree: string,
    rendered: RenderedPrompt,
    timeout: number,
  ): Promise<RunHandle> | RunHandle;

  /**
   * Run control (ADAPTERS): kill = SIGTERM → SIGKILL after grace;
   * pause = SIGSTOP; resume = SIGCONT.
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
