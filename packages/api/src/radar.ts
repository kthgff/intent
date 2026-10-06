/**
 * radar.ts — Scope Creep Radar routes (PRD §15.5, wp-142).
 *
 * `GET /api/v1/scope-radar` — the computed metrics surface (workspace
 * or filtered by `subject`/`release`). Every number is recomputed from
 * store rows/events at request time — explainable, never a cached
 * score.
 *
 * `POST /api/v1/scope-radar/:workspace/:changeset/acknowledge` —
 * clears a changeset's `scope-budget` escalation gate. Clearing IS the
 * higher approval the budget escalation demands (fail-closed: the
 * engine refuses approving decisions/apply while it is open). The
 * clear writes `gate_items.cleared_at` + a durable `gate_approved`
 * event, and fans out `gate_cleared`/`notification` on SSE.
 */
import { SCOPE_BUDGET_GATE, computeScopeRadar } from '@veto/conductor';
import type { Store } from '@veto/core';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './server.js';

const notFound = (m: string) => new ApiError(404, 'not_found', m);

export interface RadarRouteDeps {
  store: Store;
  actor: string;
  nowIso: () => string;
  /** Resolve workspace name → throws notFound for unknown names. */
  workspace: (name: string) => { name: string };
  /** Live-channel fan-out (the server's notify hook). */
  notify: (event: {
    type: 'gate_cleared' | 'notification';
    payload: unknown;
  }) => void;
}

export function registerRadarRoutes(
  app: FastifyInstance,
  deps: RadarRouteDeps,
): void {
  app.get('/api/v1/scope-radar', async (req) => {
    const q = req.query as {
      workspace?: string;
      subject?: string;
      release?: string;
    };
    const workspace = q.workspace ? deps.workspace(q.workspace).name : null;
    if (!workspace) throw notFound('scope-radar requires ?workspace=');
    return computeScopeRadar(deps.store, workspace, deps.nowIso(), {
      ...(q.subject ? { subject: q.subject } : {}),
      ...(q.release ? { release: q.release } : {}),
    });
  });

  app.post(
    '/api/v1/scope-radar/:workspace/:changeset/acknowledge',
    async (req) => {
      const { workspace: wsName, changeset } = req.params as {
        workspace: string;
        changeset: string;
      };
      const ws = deps.workspace(wsName).name;
      const cs = await deps.store.getChangeset({
        workspace: ws,
        changeset_id: changeset,
      });
      if (!cs) throw notFound(`unknown changeset '${ws}/${changeset}'`);
      const key = {
        workspace: ws,
        subject: changeset,
        gate: SCOPE_BUDGET_GATE,
      };
      const item = await deps.store.getGateItem(key);
      if (!item || item.cleared_at) {
        throw notFound(
          `no open '${SCOPE_BUDGET_GATE}' escalation on ${changeset}`,
        );
      }
      const at = deps.nowIso();
      await deps.store.clearGateItem(key, at);
      await deps.store.appendEvent({
        workspace: ws,
        ticket_id: cs.baseline?.subject ?? null,
        ts: at,
        stage: null,
        actor_type: 'human',
        actor_id: deps.actor,
        event: 'gate_approved',
        run: null,
        refs: [],
        data: { gate: SCOPE_BUDGET_GATE, changeset_id: changeset },
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        human_minutes: null,
      });
      deps.notify({
        type: 'gate_cleared',
        payload: { ...item, cleared_at: at },
      });
      return {
        acknowledged: true,
        changeset_id: changeset,
        gate: SCOPE_BUDGET_GATE,
        cleared_at: at,
      };
    },
  );
}
