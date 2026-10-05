/**
 * `tick` — a single RECONCILE → CLAIM (+ shepherd) pass with a stdout
 * summary (wp-099). Debug surface: exits nonzero on reconcile errors
 * (warnings collect into the report; a thrown tick is a hard error).
 */
import type { TickReport } from '@sprint-runner/conductor';
import { bootRuntime } from '../boot.js';

export interface TickOptions {
  configPath?: string;
  io: { out(s: string): void; err(s: string): void };
}

export function formatTickReport(report: TickReport): string {
  const lines: string[] = [];
  const n = report.reconcile.length;
  for (let i = 0; i < n; i++) {
    const rec = report.reconcile[i];
    const claim = report.claim[i];
    const shep = report.shepherd[i];
    const ws = shep?.workspace ?? `ws[${i}]`;
    lines.push(
      `${ws}:` +
        `  reconcile collected=${rec?.collected.length ?? 0}` +
        ` stalled=${rec?.stalled.length ?? 0}` +
        ` killed=${rec?.killed.length ?? 0}` +
        ` warnings=${rec?.warnings.length ?? 0}` +
        `  | claim launched=${claim?.launched.length ?? 0}` +
        ` skipped=${claim?.skipped.length ?? 0}` +
        `  | shepherd polled=${shep?.polled.length ?? 0}` +
        ` actions=${shep?.actions.length ?? 0}` +
        ` warnings=${shep?.warnings.length ?? 0}`,
    );
    for (const w of rec?.warnings ?? []) lines.push(`    ⚠ ${w}`);
    for (const s of claim?.skipped ?? []) {
      lines.push(`    · skipped ${s.ticket}: ${s.reason}`);
    }
    for (const w of shep?.warnings ?? []) lines.push(`    ⚠ ${w}`);
  }
  if (lines.length === 0) {
    lines.push('no workspaces — nothing to reconcile');
  }
  return lines.join('\n');
}

/** Total reconcile warnings — the nonzero-exit signal (ticket). */
export function tickErrors(report: TickReport): number {
  return report.reconcile.reduce((n, r) => n + r.warnings.length, 0);
}

export async function cmdTick(opts: TickOptions): Promise<number> {
  const { io } = opts;
  let booted: Awaited<ReturnType<typeof bootRuntime>>;
  try {
    booted = await bootRuntime({
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
      onError: (e) => io.err(`conductor: ${(e as Error).message}`),
    });
  } catch (e) {
    // Boot failures (config, storage, adapter binary) are reported,
    // never thrown — callers get an exit code either way.
    io.err(`boot: ${(e as Error).message}`);
    return 2;
  }
  const { conductor, store, warnings } = booted;
  try {
    for (const w of warnings) io.err(`warning: ${w}`);
    const report = await conductor.tick();
    io.out(formatTickReport(report));
    return tickErrors(report) > 0 ? 1 : 0;
  } catch (e) {
    io.err(`tick failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await store.close();
  }
}
