/**
 * TransitionTools factory — builds the narrow transition-application
 * API handed to `TransitionHandler.onRunComplete` (contracts.ts;
 * CONDUCTOR reconcile step 1). The transition table drives the
 * pipeline through these methods and nothing else.
 *
 * wp-092 (D29): tools are DB-only — doc_versions for docs,
 * run_artifacts for structured output, projects.next_*_seq for ids.
 */
import type { ActorType, EventName } from '@sprint-runner/core';
import {
  type ApplyStatusResult,
  type TransitionContext,
  type TransitionTools,
  applyTicketStatus,
} from '../contracts.js';
import { queuePendingRun } from '../launch/index.js';
import { actorOf } from './deps.js';
import type { ConductorDeps, ConductorWorkspace } from './deps.js';
import type { LeaseManager } from './lease.js';

/** Minimal context shape both reconcile and claim can supply. */
export interface ToolCtx {
  deps: ConductorDeps;
  ws: ConductorWorkspace;
  leases: LeaseManager;
  handles: Map<string, import('@sprint-runner/core').RunHandle>;
  killedForCap: Set<string>;
}

/**
 * Artifact lookup tolerant of nested names: `name` may itself carry a
 * nested path (`<repo>/test-report.json`), or be a basename that landed
 * nested (`verify` writes `run_dir/<repo>/test-report.json`). Exact
 * match wins; otherwise the deepest-first basename/nested match.
 */
async function findArtifact(deps: ConductorDeps, runId: string, name: string) {
  const exact = await deps.store.getArtifact(runId, name);
  if (exact) return exact;
  if (name.includes('/')) return null;
  const all = await deps.store.listArtifacts(runId);
  return (
    all.find((a) => a.name === name) ??
    all
      .filter((a) => a.name.endsWith(`/${name}`))
      .sort((a, b) => a.name.localeCompare(b.name))[0] ??
    null
  );
}

export function transitionContext(ctx: ToolCtx): TransitionContext {
  return {
    workspace: ctx.ws.name,
    rootPath: ctx.ws.rootPath,
    store: ctx.deps.store,
    actor: actorOf(ctx.deps),
    now: () => ctx.deps.now?.() ?? new Date(),
  };
}

export function makeTransitionTools(ctx: ToolCtx): TransitionTools {
  const base = transitionContext(ctx);
  const { deps } = ctx;
  return {
    ...base,

    applyTicketStatus: (opts): Promise<ApplyStatusResult> =>
      applyTicketStatus({ ctx: base, opts }),

    surfaceGateItem: async (item) => {
      const ts = base.now().toISOString();
      const row = {
        workspace: base.workspace,
        subject: item.subject,
        gate: item.gate,
        kind: item.kind,
        surfaced_at: ts,
        cleared_at: null,
        blocked_agent: item.blockedAgent ?? false,
        priority: item.priority ?? null,
      };
      await deps.store.upsertGateItem(row);
      // DB-SCHEMA: notifications generated on gate_items insert.
      const notification = {
        workspace: base.workspace,
        subject: item.subject,
        kind: `gate:${item.kind}`,
        payload: JSON.stringify(item),
        created_at: ts,
        read_at: null,
      };
      const notificationId = await deps.store.insertNotification(notification);
      // API.md stream: gate_surfaced + notification after the durable
      // writes above.
      deps.notify?.({ type: 'gate_surfaced', payload: row });
      deps.notify?.({
        type: 'notification',
        payload: { id: notificationId, ...notification },
      });
    },

    appendEvent: (e) =>
      deps.store.appendEvent({
        workspace: base.workspace,
        ticket_id: e.ticketId ?? null,
        ts: base.now().toISOString(),
        stage: e.stage ?? null,
        actor_type: (e.actorType ?? 'runner') as ActorType,
        actor_id: base.actor,
        event: e.event as EventName,
        run: e.run ?? null,
        refs: e.refs ?? [],
        data: e.data ?? {},
        cost_usd: e.costUsd ?? null,
        tokens_in: e.tokensIn ?? null,
        tokens_out: e.tokensOut ?? null,
        tokens_cached: e.tokensCached ?? null,
        usage_source: e.usageSource ?? null,
        duration_s: e.durationS ?? null,
        human_minutes: e.humanMinutes ?? null,
      }),

    requestRun: (req) =>
      queuePendingRun(ctx, { ...req, workspace: base.workspace }),

    // ---- doc + artifact + id helpers (wp-092) ----

    getDocText: async (subject, doc) => {
      const v = await deps.store.getDoc({
        workspace: base.workspace,
        subject,
        doc,
      });
      return v?.content ?? null;
    },

    putDoc: async (subject, doc, content) => {
      const v = await deps.store.appendDocVersion(
        { workspace: base.workspace, subject, doc },
        content,
        base.actor,
      );
      return v.version;
    },

    getArtifactText: async (runId, name) => {
      const a = await deps.store.getArtifact(runId, name);
      return a?.content ?? null;
    },

    putArtifact: (runId, name, content) =>
      deps.store.putArtifact({
        run_id: runId,
        name,
        content,
        created_at: base.now().toISOString(),
      }),

    getLatestArtifactText: async (name, filter) => {
      // Current run only.
      if (filter.runId && !filter.ticketId) {
        const a = await findArtifact(deps, filter.runId, name);
        return a?.content ?? null;
      }
      // Scan the subject's runs newest-first for the latest artifact
      // with this name (e.g. the triage run's triage.json read back at
      // a later gate clear).
      const runs = (
        await deps.store.listRuns(
          filter.ticketId
            ? { workspace: base.workspace, ticket_id: filter.ticketId }
            : { workspace: base.workspace },
        )
      ).sort((a, b) => b.id.localeCompare(a.id));
      for (const r of runs) {
        const a = await findArtifact(deps, r.id, name);
        if (a) return a.content;
      }
      return null;
    },

    allocTicketId: () => deps.store.allocTicketId(base.workspace),
  };
}
