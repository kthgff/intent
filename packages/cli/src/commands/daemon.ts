/**
 * `daemon` — the product entrypoint (wp-099): boot config + store
 * migrations → start the conductor loop → serve the built UI dist +
 * API on `ui.bind`:`ui.port` behind the token contract (API.md).
 *
 * One process, one surface: the same Conductor.tick() the app embeds
 * runs every ~10s in a sleep-chained loop (never overlapping), and the
 * Fastify server mounts REST + SSE + the vite-built SPA. SIGINT/
 * SIGTERM shut down cleanly — runs are detached, so a restarted daemon
 * re-collects them (persisted handle.json rows).
 */
import { loadOrCreateToken, startServer } from '@veto/api';
import type { ApiServer } from '@veto/api';
import { bootRuntime } from '../boot.js';
import type { BootedRuntime } from '../boot.js';
import { overlayRepoCards } from '../cards.js';
import { resolveUiDist } from '../paths.js';

/** ~10s reconcile cadence (CONDUCTOR "fires every ~10s tick"). */
const TICK_INTERVAL_MS = 10_000;

export interface DaemonOptions {
  configPath?: string;
  /** Overrides for `ui.port`/`ui.bind` (tests bind port 0). */
  port?: number;
  bind?: string;
  uiDist?: string;
  io: { out(s: string): void; err(s: string): void };
}

export interface DaemonHandle {
  runtime: BootedRuntime;
  server: ApiServer;
  /** Resolved listen address (e.g. `http://127.0.0.1:4711`). */
  url: string;
  /** Run the tick loop until `stop()`/SIGINT/SIGTERM. */
  run(): Promise<void>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot everything and bind the listener. Returned handle separates
 * startup from the forever-loop so tests can start/stop cleanly.
 */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const { io } = opts;
  const runtime = await bootRuntime({
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    onError: (e) => io.err(`conductor: ${(e as Error).message}`),
  });
  const { config, workspaces } = runtime;
  for (const w of runtime.warnings) io.err(`warning: ${w}`);

  const tokenFile = config.ui.token_file;
  if (!tokenFile) {
    throw new Error('ui.token_file unresolved — set it in config.yaml');
  }
  const uiToken = loadOrCreateToken(tokenFile);

  const uiDist = resolveUiDist(opts.uiDist);
  if (!uiDist) {
    io.err(
      'warning: no built UI found (packages/ui/dist) — serving the ' +
        'placeholder page; run `pnpm -F @veto/ui build`',
    );
  }

  const effective =
    opts.port === undefined && opts.bind === undefined
      ? config
      : {
          ...config,
          ui: {
            ...config.ui,
            ...(opts.port !== undefined ? { port: opts.port } : {}),
            ...(opts.bind !== undefined ? { bind: opts.bind } : {}),
          },
        };

  const server = await startServer({
    store: runtime.store,
    conductor: runtime.conductor,
    config: effective,
    uiToken,
    globalConfigPath: runtime.configPath,
    ...(uiDist ? { uiDist } : {}),
  });
  const port = server.server.address();
  const addr =
    typeof port === 'object' && port !== null
      ? `http://${effective.ui.bind}:${port.port}`
      : `http://${effective.ui.bind}:${effective.ui.port}`;

  let stopping = false;
  let tickTimer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;

  const handle: DaemonHandle = {
    runtime,
    server,
    url: addr,

    async run(): Promise<void> {
      while (!stopping) {
        // Repo cards land via probe runs writing card.json into the
        // code repo — refresh the overlay so `verified` is seen (the
        // CLAIM repo-card gate reads config, not the file).
        const cards = await overlayRepoCards(config, workspaces).catch((e) => {
          io.err(`card overlay: ${(e as Error).message}`);
          return { applied: [], warnings: [] };
        });
        for (const w of cards.warnings) io.err(`warning: ${w}`);

        try {
          await runtime.conductor.tick();
        } catch (e) {
          // The babysitter stays up — a tick error is logged, never
          // allowed to kill the daemon (the pipeline must move
          // overnight; transient store errors self-heal).
          io.err(`tick error: ${(e as Error).message}`);
        }
        if (stopping) break;
        await new Promise<void>((res) => {
          wake = res;
          tickTimer = setTimeout(res, TICK_INTERVAL_MS);
        });
      }
    },

    async stop(): Promise<void> {
      stopping = true;
      wake?.();
      if (tickTimer) clearTimeout(tickTimer);
      await server.close();
      await runtime.store.close();
    },
  };
  return handle;
}

/** `veto daemon` / bare `veto` — never resolves until shutdown. */
export async function cmdDaemon(opts: DaemonOptions): Promise<number> {
  const { io } = opts;
  let handle: DaemonHandle;
  try {
    handle = await startDaemon(opts);
  } catch (e) {
    io.err(`daemon: ${(e as Error).message}`);
    return 1;
  }
  const { workspaces } = handle.runtime;

  io.out(`daemon up — ${workspaces.length} workspace(s)`);
  io.out(`  UI + API: ${handle.url}`);
  io.out(`  bootstrap: ${handle.url}/?token=<ui-token> (see token file)`);
  io.out('  conductor tick every 10s — Ctrl-C to stop');

  const onSig = () => {
    void handle.stop();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    await handle.run();
    io.out('daemon stopped');
    return 0;
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}
