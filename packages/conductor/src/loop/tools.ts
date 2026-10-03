/**
 * TransitionTools factory — builds the narrow transition-application
 * API handed to `TransitionHandler.onRunComplete` (contracts.ts;
 * CONDUCTOR reconcile step 1). wp-031's table drives the pipeline
 * through these methods and nothing else.
 */
import type { ActorType, EventName } from '@sprint-runner/core';
import {
  type ApplyStatusResult,
  type TransitionContext,
  type TransitionTools,
  applyTicketStatus,
} from '../contracts.js';
import { queuePendingRun } from '../launch/index.js';
import { actorOf, gitActor } from './deps.js';
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

export function transitionContext(ctx: ToolCtx): TransitionContext {
  return {
    workspace: ctx.ws.name,
    ticketsRepoPath: ctx.ws.ticketsRepoPath,
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
      applyTicketStatus({ ctx: base, opts, actor: gitActor(deps) }),

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
  };
}
