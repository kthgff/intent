/**
 * `import:<source>` run orchestration (CONDUCTOR sentinel table):
 * fetch → materialize; emits exactly one sentinel —
 * `IMPORTED: <n>` (transition layer flips each ticket to `imported`)
 * or `IMPORT-FAILED: <reason>` (→ `failure` inbox item).
 *
 * D29: materialize writes DB rows directly (`tickets` + `ticket.md`
 * doc_versions + `ticket_repos`) — no tickets-repo checkout, no commit
 * step. The run machinery (detached run, sentinel parse, reconcile)
 * already exists generically; this is the function a transition layer
 * or `import:github` subject run calls to do the work and produce the
 * sentinel line. {@link runImport} never throws: every failure becomes
 * `IMPORT-FAILED` so the conductor lands a `failure` gate item instead
 * of a bare `run_failed`.
 */
import type { Store } from '@sprint-runner/core';
import { fetchIssues } from './github.js';
import type { FetchIssuesOptions } from './github.js';
import { IMPORT_FAILURE_GATE, materialize } from './materialize.js';
import type { MaterializeResult } from './materialize.js';
import type { FetchIssuesResult } from './types.js';
import type { ImportOutcome } from './types.js';

export interface RunImportOptions {
  /** Subject of the run, e.g. `import:github` — gate/notification
   *  attribution. */
  subject: string;
  workspace: string;
  store: Store;
  /** `importers.default_repo_map`. */
  repoMap: Record<string, string>;
  /** `actor:` for doc_versions/edited_by (defaults inside materialize). */
  actor?: string;
  fetch: FetchIssuesOptions;
  /** Fetch implementation override (tests / alternate importers) —
   *  defaults to the real `gh`-backed {@link fetchIssues}. */
  fetchImpl?: (opts: FetchIssuesOptions) => Promise<FetchIssuesResult>;
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
  const fetched = await (opts.fetchImpl ?? fetchIssues)(opts.fetch);
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
      workspace: opts.workspace,
      store: opts.store,
      repoMap: opts.repoMap,
      ...(opts.actor ? { actor: opts.actor } : {}),
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
    const reason = `materialize-failed: ${(e as Error).message.split('\n')[0]}`;
    await surfaceFailure(opts, reason);
    return {
      outcome: { sentinel: 'IMPORT-FAILED', arg: reason },
      sentinelLine: `IMPORT-FAILED: ${reason}`,
    };
  }
}
