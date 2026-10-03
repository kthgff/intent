/**
 * `import:<source>` run orchestration (CONDUCTOR sentinel table):
 * fetch → materialize → commit; emits exactly one sentinel —
 * `IMPORTED: <n>` (transition layer commits/keeps folders, each →
 * `imported`) or `IMPORT-FAILED: <reason>` (→ `failure` inbox item).
 *
 * The run machinery (detached run, sentinel parse, reconcile) already
 * exists generically; this is the function a transition layer or
 * `import:github` subject run calls to do the work and produce the
 * sentinel line. {@link runImport} never throws: every failure becomes
 * `IMPORT-FAILED` so the conductor lands a `failure` gate item instead
 * of a bare `run_failed`.
 */
import type { Store } from '@sprint-runner/core';
import { fetchIssues } from './github.js';
import type { FetchIssuesOptions } from './github.js';
import { IMPORT_FAILURE_GATE, materialize } from './materialize.js';
import type { MaterializeResult } from './materialize.js';
import type { ImportOutcome } from './types.js';

export interface RunImportOptions {
  /** Subject of the run, e.g. `import:github` — gate/notification
   *  attribution. */
  subject: string;
  workspace: string;
  store: Store;
  ticketsRepoPath: string;
  /** `importers.default_repo_map`. */
  repoMap: Record<string, string>;
  fetch: FetchIssuesOptions;
}

export interface RunImportResult {
  outcome: ImportOutcome;
  /** Sentinel line exactly as the run's last output line. */
  sentinelLine: string;
  materialize?: MaterializeResult;
}

async function surfaceFailure(
  opts: RunImportOptions,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await opts.store.upsertGateItem({
    workspace: opts.workspace,
    subject: opts.subject,
    gate: IMPORT_FAILURE_GATE,
    kind: 'failure',
    surfaced_at: now,
    blocked_agent: false,
  });
  await opts.store.insertNotification({
    workspace: opts.workspace,
    subject: opts.subject,
    kind: 'gate:failure',
    payload: JSON.stringify({ gate: IMPORT_FAILURE_GATE, reason }),
    created_at: now,
  });
}

export async function runImport(
  opts: RunImportOptions,
): Promise<RunImportResult> {
  const fetched = await fetchIssues(opts.fetch);
  if (!fetched.ok) {
    const reason = `${fetched.error.reason}: ${fetched.error.detail}`;
    await surfaceFailure(opts, reason);
    return {
      outcome: { sentinel: 'IMPORT-FAILED', arg: reason },
      sentinelLine: `IMPORT-FAILED: ${reason}`,
    };
  }

  try {
    const mat = await materialize(fetched.issues, {
      ticketsRepoPath: opts.ticketsRepoPath,
      repoMap: opts.repoMap,
      workspace: opts.workspace,
      store: opts.store,
    });
    const n = mat.imported.length;
    // Sentinel shape is exactly `IMPORTED: <n>` (CONDUCTOR table) —
    // collisions already surfaced as their own failure gate items.
    return {
      outcome: {
        sentinel: 'IMPORTED',
        arg: String(n),
        imported: mat.imported.map((t) => t.id),
      },
      sentinelLine: `IMPORTED: ${n}`,
      materialize: mat,
    };
  } catch (e) {
    const reason = `commit-failed: ${(e as Error).message.split('\n')[0]}`;
    await surfaceFailure(opts, reason);
    return {
      outcome: { sentinel: 'IMPORT-FAILED', arg: reason },
      sentinelLine: `IMPORT-FAILED: ${reason}`,
    };
  }
}
