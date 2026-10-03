/**
 * Conductor — the babysitter loop (CONDUCTOR.md, wp-030).
 *
 * Watcher + scheduler, not a worker: one `tick()` =
 *   1. RECONCILE — pull tickets repos, rebuild projections, sweep live
 *      runs (pid liveness + mtime → conductor-observed heartbeats;
 *      dead → stalled; timeout → kill + run_killed; exited → collect →
 *      sanitizer → usage → run row → release lease → TransitionHandler),
 *   2. CLAIM — pick the next runnable unit (non-gate transition via
 *      the wp-031 seam, lease free, deps merged, caps unmet, repo-card
 *      rule scoped to repo-executing stages),
 *   3. LAUNCH — worktrees per ticket_repos, render, spawn detached,
 *      register the run row.
 *
 * The sentinel→transition table itself is wp-031 — inject a real
 * `TransitionHandler` then; `StubTransitionHandler` (contracts.ts)
 * drives it until then.
 */
import type { ControlOp, RunHandle } from '@sprint-runner/core';
import { type ClaimReport, claim } from '../claim/index.js';
import { controlRun } from '../control/index.js';
import { type ReconcileReport, reconcile } from '../reconcile/index.js';
import type { ConductorDeps, ConductorWorkspace } from './deps.js';
import { LeaseManager } from './lease.js';
import type { ToolCtx } from './tools.js';

export interface TickReport {
  reconcile: ReconcileReport[];
  claim: ClaimReport[];
}

export class Conductor {
  readonly deps: ConductorDeps;
  readonly leases: LeaseManager;
  /** runId → adapter RunHandle (also persisted as handle.json). */
  readonly handles = new Map<string, RunHandle>();
  readonly killedForCap = new Set<string>();

  constructor(deps: ConductorDeps) {
    this.deps = deps;
    this.leases = new LeaseManager(deps);
  }

  /** One RECONCILE → CLAIM pass per workspace. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { reconcile: [], claim: [] };
    for (const ws of this.deps.workspaces) {
      const ctx = this.#ctx(ws);
      const rr: ReconcileReport = {
        pulled: [],
        stalled: [],
        killed: [],
        collected: [],
        warnings: [],
      };
      await reconcile({ ...ctx, report: rr });
      report.reconcile.push(rr);
      report.claim.push(await claim(ctx));
    }
    return report;
  }

  #ctx(ws: ConductorWorkspace): ToolCtx {
    return {
      deps: this.deps,
      ws,
      leases: this.leases,
      handles: this.handles,
      killedForCap: this.killedForCap,
    };
  }

  /** SIGTERM → SIGKILL after grace (ADAPTERS control; the worktree is
   *  preserved, the lease released, `run_killed` emitted). */
  async killRun(runId: string): Promise<void> {
    await controlRun(this.deps, this.leases, this.handles, runId, 'kill');
  }

  /** SIGSTOP — freezes work, not the clock (lease + timeout keep
   *  ticking). */
  async pauseRun(runId: string): Promise<void> {
    await controlRun(this.deps, this.leases, this.handles, runId, 'pause');
  }

  /** SIGCONT. */
  async resumeRun(runId: string): Promise<void> {
    await controlRun(this.deps, this.leases, this.handles, runId, 'resume');
  }

  async control(runId: string, op: ControlOp): Promise<void> {
    await controlRun(this.deps, this.leases, this.handles, runId, op);
  }
}
