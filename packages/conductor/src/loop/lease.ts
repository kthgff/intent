/**
 * Fencing: lease-or-gitref CAS (CONDUCTOR CLAIM "Acquire lease (DB or
 * git-ref CAS); contested → skip this tick"; SETTINGS `leases_via:
 * auto|db|git-ref`).
 *
 *   - `db`/`auto` → Store.acquireLease (transactional insert; expired
 *     leases are stealable per the TTL rule).
 *   - `git-ref` → `refs/locks/<subject>-<stage>` CAS on the tickets
 *     repo via gitops acquireRefLock — the atomic push IS the CAS.
 *   - `auto` additionally falls back to git-ref when the DB lease
 *     write throws (dual-install resilience).
 *
 * Git-ref locks carry `{holder, acquired_at, expires_at}` JSON; the
 * expiry sweep runs inside every pullRebase (CONDUCTOR "Git-ref CAS
 * lock expiry").
 */
import type { LeaseKey } from '@sprint-runner/core';
import { acquireRefLock, git } from '@sprint-runner/gitops';
import {
  type ConductorDeps,
  type ConductorWorkspace,
  actorOf,
} from './deps.js';

/** Tracks refs this conductor acquired so release can delete them. */
export class LeaseManager {
  readonly #refLocks = new Map<string, string>(); // leaseKey → ref

  constructor(private deps: ConductorDeps) {}

  /**
   * Try to fence (workspace, subject, stage, attempt). Returns true
   * when this conductor holds the lease; false when contested —
   * caller skips the tick (CONDUCTOR CLAIM).
   */
  async acquire(ws: ConductorWorkspace, key: LeaseKey): Promise<boolean> {
    const holder = actorOf(this.deps);
    const ttl = this.deps.leaseTtlS ?? 300;
    const mode = this.deps.config.leases_via;

    if (mode !== 'git-ref') {
      try {
        const lease = await this.deps.store.acquireLease(key, holder, ttl);
        if (lease) return true;
        if (mode === 'db') return false;
        // auto: contested is a definitive answer too — no need for refs.
        return false;
      } catch (e) {
        if (mode === 'db') throw e;
        // auto: DB unavailable → git-ref CAS fallback.
      }
    }

    const ref = `refs/locks/${key.subject}-${key.stage}`;
    const result = await acquireRefLock(ws.ticketsRepoPath, ref, {
      holder,
      ttlS: ttl,
    });
    if (result.status !== 'acquired') return false;
    this.#refLocks.set(lockId(key), ref);
    return true;
  }

  /** Release after collect/commit (CONDUCTOR reconcile step 1). Best-
   *  effort on both paths — a stale ref expires via its TTL anyway. */
  async release(ws: ConductorWorkspace, key: LeaseKey): Promise<void> {
    const holder = actorOf(this.deps);
    await this.deps.store.releaseLease(key, holder).catch(() => {});
    const ref = this.#refLocks.get(lockId(key));
    if (ref) {
      this.#refLocks.delete(lockId(key));
      await git(['push', 'origin', '--delete', ref], {
        cwd: ws.ticketsRepoPath,
      }).catch(() => {});
    }
  }

  /** Conductor-observed lease heartbeat alongside runs.heartbeat_at. */
  async heartbeat(key: LeaseKey, at: string): Promise<void> {
    await this.deps.store.heartbeatLease(key, at).catch(() => {});
  }

  /** Is a live (unexpired) lease held by anyone? CLAIM pre-check. */
  async isFree(key: LeaseKey): Promise<boolean> {
    const lease = await this.deps.store.getLease(key).catch(() => null);
    if (!lease) return true;
    const base = Date.parse(lease.heartbeat_at ?? lease.acquired_at);
    const expiryMs = base + lease.ttl_s * 1000;
    return expiryMs <= Date.now();
  }
}

function lockId(key: LeaseKey): string {
  return `${key.workspace}/${key.subject}/${key.stage}/${key.attempt}`;
}
