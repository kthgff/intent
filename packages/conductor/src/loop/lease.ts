/**
 * Fencing: Postgres leases (wp-092 — `leases_via`/git-ref CAS are
 * gone, D29; DB-SCHEMA "Leases are DB-only").
 *
 *   - `store.acquireLease` is a transactional insert; expired leases
 *     are stealable per the TTL rule; contested → caller skips the
 *     tick (CONDUCTOR CLAIM).
 *   - Heartbeats ride alongside runs.heartbeat_at.
 *   - Release is best-effort — a stale lease expires via its TTL.
 */
import type { LeaseKey } from '@veto/core';
import {
  type ConductorDeps,
  type ConductorWorkspace,
  actorOf,
} from './deps.js';

/** Tracks nothing — leases are fully durable rows; kept as a class so
 *  callers/tests keep the same seam. */
export class LeaseManager {
  constructor(private deps: ConductorDeps) {}

  /**
   * Try to fence (workspace, subject, stage, attempt). Returns true
   * when this conductor holds the lease; false when contested —
   * caller skips the tick (CONDUCTOR CLAIM).
   */
  async acquire(_ws: ConductorWorkspace, key: LeaseKey): Promise<boolean> {
    const holder = actorOf(this.deps);
    const ttl = this.deps.leaseTtlS ?? 300;
    const lease = await this.deps.store.acquireLease(key, holder, ttl);
    return lease !== null;
  }

  /** Release after collect (CONDUCTOR reconcile step 1). Best-effort —
   *  a stale lease expires via its TTL anyway. */
  async release(_ws: ConductorWorkspace, key: LeaseKey): Promise<void> {
    const holder = actorOf(this.deps);
    await this.deps.store.releaseLease(key, holder).catch(() => {});
  }

  /** Conductor-observed lease heartbeat alongside runs.heartbeat_at.
   *  Owner-fenced — a stolen/expired lease makes this a no-op. */
  async heartbeat(key: LeaseKey, at: string): Promise<void> {
    const holder = actorOf(this.deps);
    await this.deps.store.heartbeatLease(key, holder, at).catch(() => {});
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
