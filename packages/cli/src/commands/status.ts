import type { GateItem, RunRow } from '@veto/core';
/**
 * `status` — queue snapshot (wp-099): open gate_items grouped by kind,
 * live runs, and the container picture (D30 — surfaced as live runs
 * carrying `container_id`; the `containers` table has no Store
 * accessor yet — see TRACKER wp-099 decision).
 *
 * Read-only against the store: boots config + Postgres only — no
 * adapters, no conductor, no API.
 */
import type { PostgresStore } from '@veto/store';
import { bootConfigAndStore } from '../boot.js';

export interface StatusOptions {
  configPath?: string;
  workspace?: string;
  json?: boolean;
  io: { out(s: string): void; err(s: string): void };
}

export interface WorkspaceStatus {
  workspace: string;
  root_path: string;
  tickets_by_status: Record<string, number>;
  open_gate_items: { gate: string; subject: string; kind: string }[];
  gate_items_by_kind: Record<string, number>;
  live_runs: {
    id: string;
    subject: string;
    stage: string;
    status: string;
    backend: string | null;
  }[];
  /** D30 — runs with a docker container attached. */
  containers: {
    subject: string;
    container_id: string;
    run: string;
    status: string;
  }[];
}

export async function collectStatus(
  store: PostgresStore,
  workspaces: { name: string; rootPath: string }[],
  filter?: string,
): Promise<WorkspaceStatus[]> {
  const out: WorkspaceStatus[] = [];
  const live = (await store.listLiveRuns()).filter(
    (r) => !filter || r.workspace === filter,
  );
  for (const ws of workspaces.filter((w) => !filter || w.name === filter)) {
    const tickets = await store.listTickets({ workspace: ws.name });
    const byStatus: Record<string, number> = {};
    for (const t of tickets) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    }
    const gates = await store.listGateItems({
      workspace: ws.name,
      open: true,
    });
    const byKind: Record<string, number> = {};
    for (const g of gates) {
      byKind[g.kind] = (byKind[g.kind] ?? 0) + 1;
    }
    const wsRuns = live.filter((r) => r.workspace === ws.name);
    // D30 container picture: any run row carrying container_id —
    // stopped containers still appear (they're parked at gates).
    const withContainer = (await store.listRuns({ workspace: ws.name }))
      .filter((r) => r.container_id)
      .map((r) => ({
        subject: r.subject,
        container_id: r.container_id as string,
        run: r.id,
        status: r.status,
      }));
    out.push({
      workspace: ws.name,
      root_path: ws.rootPath,
      tickets_by_status: byStatus,
      open_gate_items: gates.map((g: GateItem) => ({
        gate: g.gate,
        subject: g.subject,
        kind: g.kind,
      })),
      gate_items_by_kind: byKind,
      live_runs: wsRuns.map((r: RunRow) => ({
        id: r.id,
        subject: r.subject,
        stage: r.stage,
        status: r.status,
        backend: r.backend ?? null,
      })),
      containers: withContainer,
    });
  }
  return out;
}

export async function cmdStatus(opts: StatusOptions): Promise<number> {
  const { io } = opts;
  let booted: Awaited<ReturnType<typeof bootConfigAndStore>>;
  try {
    booted = await bootConfigAndStore({
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
  } catch (e) {
    io.err(`boot: ${(e as Error).message}`);
    return 2;
  }
  const { store, workspaces } = booted;
  try {
    const rows = await collectStatus(store, workspaces, opts.workspace);
    if (opts.json) {
      io.out(JSON.stringify({ workspaces: rows }, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      io.out(
        opts.workspace
          ? `no workspace '${opts.workspace}' (register via init or POST /workspaces)`
          : 'no workspaces registered — `veto init` inside a repo, or POST /api/v1/workspaces',
      );
      return 0;
    }
    for (const ws of rows) {
      io.out(`workspace ${ws.workspace}  (${ws.root_path})`);
      const statuses = Object.entries(ws.tickets_by_status)
        .map(([s, n]) => `${s}×${n}`)
        .join('  ');
      io.out(`  tickets:    ${statuses || 'none'}`);
      const kinds = Object.entries(ws.gate_items_by_kind)
        .map(([k, n]) => `${k}×${n}`)
        .join('  ');
      io.out(`  open gates: ${kinds || 'none'}`);
      for (const g of ws.open_gate_items) {
        io.out(`    · ${g.subject} — ${g.gate} (${g.kind})`);
      }
      io.out(`  live runs:  ${ws.live_runs.length}`);
      for (const r of ws.live_runs) {
        io.out(
          `    · ${r.id}  ${r.status}${r.backend ? ` (${r.backend})` : ''}`,
        );
      }
      io.out(`  containers: ${ws.containers.length}`);
      for (const c of ws.containers) {
        io.out(`    · ${c.subject}  ${c.container_id}  [${c.status}]`);
      }
    }
    return 0;
  } finally {
    await store.close();
  }
}
