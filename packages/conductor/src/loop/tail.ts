/**
 * loop/tail.ts — the `run_output` SSE producer (wp-160, API.md stream
 * table, S-07 transcript tail).
 *
 * The conductor tails each live run's `run.log` once per tick and
 * emits the new bytes as `{run_id, chunk}` events through
 * `deps.notify`. Durable truth is the log file itself — the stream is
 * a latency optimization the UI may drop, so emission is best-effort
 * and never awaited into the tick's critical path.
 *
 * Bounded memory (the ticket's constraint):
 * - at most `TAIL_WINDOW` new bytes are read per run per tick — when a
 *   run produces more, the skipped middle is replaced by an explicit
 *   truncation marker rather than buffering unboundedly;
 * - each `run_output` payload carries at most `CHUNK_SIZE` bytes;
 * - offsets live in a map pruned to currently-known run ids, so a long
 *   daemon does not accumulate dead entries.
 */
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConductorDeps, ConductorWorkspace } from './deps.js';
import type { ToolCtx } from './tools.js';

/** Max new bytes read from one run.log per tick (256 KiB). */
export const TAIL_WINDOW = 256 * 1024;
/** Max payload bytes per `run_output` event (8 KiB). */
export const CHUNK_SIZE = 8 * 1024;

const TRUNCATION_MARKER =
  '\n… [run_output: output truncated — see run.log] …\n';

/** Per-workspace tail state: run id → byte offset already emitted. */
export interface TailState {
  offsets: Map<string, number>;
}

export function newTailState(): TailState {
  return { offsets: new Map() };
}

function runLogPath(deps: ConductorDeps, runId: string): string {
  return join(deps.runsDir, ...runId.split('/'), 'run.log');
}

/**
 * Emit buffered bytes as ≤ CHUNK_SIZE `run_output` events. `buf` is
 * already memory-bounded by the read window; notify is fire-and-forget
 * per the deps contract.
 */
function emitChunks(deps: ConductorDeps, runId: string, buf: Buffer): void {
  for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
    deps.notify?.({
      type: 'run_output',
      payload: {
        run_id: runId,
        chunk: buf.subarray(off, off + CHUNK_SIZE).toString('utf8'),
      },
    });
  }
}

/**
 * One tail pass over the workspace's runs. Reads every run.log with
 * bytes past the recorded offset — a `running` row's live log AND the
 * final bytes of a row that just settled (the offset entry is pruned
 * only after the remainder is emitted, so the transcript never loses
 * the tail of a finished run).
 */
export async function tailRunOutputs(
  ctx: ToolCtx,
  ws: ConductorWorkspace,
  state: TailState,
): Promise<void> {
  const { deps } = ctx;
  if (!deps.notify) {
    // No stream attached — do not advance offsets or the first chunks
    // after a late subscribe are silently lost.
    return;
  }

  const liveIds = new Set<string>();
  const runs = await deps.store.listRuns({ workspace: ws.name });
  for (const run of runs) {
    if (run.status === 'running' || state.offsets.has(run.id)) {
      liveIds.add(run.id);
    }
  }

  // Prune ids that are neither running nor have an offset — impossible
  // by construction, but keeps the invariant obvious: the map only
  // ever holds rows we still owe bytes for.
  for (const id of [...state.offsets.keys()]) {
    if (!liveIds.has(id)) state.offsets.delete(id);
  }

  for (const run of runs) {
    if (run.status !== 'running' && !state.offsets.has(run.id)) continue;
    const path = runLogPath(deps, run.id);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      // No log yet — the run is live but hasn't written; keep offset 0.
      continue;
    }
    const offset = state.offsets.get(run.id) ?? 0;
    if (size <= offset) {
      if (run.status !== 'running') state.offsets.delete(run.id);
      continue;
    }

    const pending = size - offset;
    const skipped = Math.max(0, pending - TAIL_WINDOW);
    const readStart = offset + skipped;
    const toRead = size - readStart;

    let buf: Buffer;
    try {
      const fh = await open(path, 'r');
      try {
        buf = Buffer.alloc(toRead);
        await fh.read(buf, 0, toRead, readStart);
      } finally {
        await fh.close();
      }
    } catch {
      continue; // raced rotation/delete — next tick retries from offset
    }

    if (skipped > 0) {
      deps.notify?.({
        type: 'run_output',
        payload: { run_id: run.id, chunk: TRUNCATION_MARKER },
      });
    }
    emitChunks(deps, run.id, buf);

    if (run.status === 'running') {
      state.offsets.set(run.id, size);
    } else {
      // Settled run — the tail is delivered; release the entry.
      state.offsets.delete(run.id);
    }
  }
}
