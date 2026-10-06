/**
 * decompose/coordinator.ts — the Integration Coordinator (PRD §15.10,
 * wp-154).
 *
 * Three duties:
 *
 *   1. **Dependency-aware scheduling** (`coordinateClaim`, called from
 *      CLAIM for repo-executing stages): `depends_on` already parks
 *      children until parents deliver; on top of that —
 *        - `parallel_safety: exclusive` tickets never launch while
 *          another repo-executing run is live, and an exclusive run
 *          blocks every other repo-executing claim (one AI execution
 *          per ticket; parallelism expands only on measured low
 *          conflict rates — the conservative default).
 *        - contract-first: a ticket whose ticket.md declares
 *          `contract:` consumers must have a promoted `contract.json`
 *          doc — absence parks the claim behind a repair gate item
 *          (fail-closed, never silent proceed).
 *        - shared-file conflict prediction: when the candidate's
 *          `tdd.md` file plan intersects a live repo-executing run's
 *          file plan, the claim parks (`shared-file-conflict:<id>`).
 *   2. **Post-merge revalidation** (`revalidateDependents`): when a
 *      ticket merges, every non-terminal dependent's
 *      `execution_readiness` is recomputed (slots+statements+deps) and
 *      its pinned contract re-checked — drift surfaces a
 *      `baseline-drift` gate item + a `dependent_revalidated` event,
 *      never a silent proceed.
 *
 * Sequencing is observable in claim order: every rejection lands in
 * `ClaimReport.skipped` with a named reason.
 */
import {
  type EventRow,
  REPO_EXECUTING_STAGES,
  type RunRow,
  type TicketRow,
} from '@veto/core';
import { filePlanRows } from '@veto/lints';
import type { TransitionContext } from '../contracts.js';
import { firstDocHead, pinnedBaselineOf } from '../launch/baseline.js';
import type { StreamEvent } from '../loop/deps.js';
import { computeExecutionReadiness } from './readiness.js';

/** Gate name surfaced when a declared contract has no pinned doc
 *  (contract-first invariant breach — repair, not silent proceed). */
export const CONTRACT_MISSING_GATE = 'contract-missing';

/** Context the coordinator needs — TransitionContext plus an optional
 *  live-channel fan-out (claim/shepherd pass `deps.notify`). */
export type CoordinatorCtx = TransitionContext & {
  notify?: ((event: StreamEvent) => void) | undefined;
};

// ---------------------------------------------------------------------------
// Claim-time coordination
// ---------------------------------------------------------------------------

/** `contract:` frontmatter on ticket.md — the names the ticket
 *  consumes (set at split materialization). Minimal flat parse —
 *  mirrors transitions/actions.ts `flatFrontmatter` (kept local so
 *  decompose/ never imports back into transitions/). */
function contractNamesFromTicketMd(raw: string | null): string[] {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    raw ?? '',
  );
  if (!m?.[1]) return [];
  const line = m[1].split('\n').find((l) => /^contract\s*:/.test(l));
  if (!line) return [];
  const value = line.replace(/^contract\s*:\s*/, '').trim();
  const t = value.replace(/^\[|\]$/g, '');
  return t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** `repo:file` set from the ticket's tdd.md file plan (SCHEMAS §3) —
 *  null when the doc/plan is absent or unparseable (no prediction can
 *  be made; the concurrency cap still applies). */
async function filePlanSet(
  ctx: CoordinatorCtx,
  ticketId: string,
): Promise<Set<string> | null> {
  const tdd = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject: ticketId,
    doc: 'tdd.md',
  });
  if (!tdd) return null;
  const plan = filePlanRows(tdd.content);
  if (!plan.rows) return null;
  return new Set(plan.rows.map((r) => `${r.repo}:${r.file}`));
}

/**
 * Claim coordination for one repo-executing candidate. Returns the
 * skip reason (observable in ClaimReport) or null when the claim may
 * proceed.
 */
export async function coordinateClaim(args: {
  ctx: CoordinatorCtx;
  ticket: TicketRow;
  stage: string;
  /** Currently live runs (run.status running/paused/leased…). */
  live: RunRow[];
}): Promise<string | null> {
  const { ctx, ticket, stage, live } = args;
  if (!(REPO_EXECUTING_STAGES as readonly string[]).includes(stage)) {
    return null;
  }
  const liveRepoRuns = live.filter(
    (r) =>
      r.workspace === ctx.workspace &&
      r.ticket_id !== null &&
      r.ticket_id !== ticket.ticket_id &&
      (REPO_EXECUTING_STAGES as readonly string[]).includes(r.stage),
  );

  // --- exclusive fencing (both directions) ---
  if (ticket.parallel_safety === 'exclusive' && liveRepoRuns.length > 0) {
    return 'exclusive-in-flight';
  }
  for (const r of liveRepoRuns) {
    const other = r.ticket_id
      ? await ctx.store.getTicket({
          workspace: ctx.workspace,
          ticket_id: r.ticket_id,
        })
      : null;
    if (other?.parallel_safety === 'exclusive') {
      return `exclusive-in-flight:${other.ticket_id}`;
    }
    // --- shared-file conflict prediction ---
    const [mine, theirs] = await Promise.all([
      filePlanSet(ctx, ticket.ticket_id),
      filePlanSet(ctx, other?.ticket_id ?? ''),
    ]);
    if (mine && theirs) {
      const overlap = [...mine].filter((f) => theirs.has(f));
      if (overlap.length > 0) {
        return `shared-file-conflict:${r.ticket_id}(${overlap.length})`;
      }
    }
  }

  // --- contract-first invariant ---
  const contractDoc = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject: ticket.ticket_id,
    doc: 'ticket.md',
  });
  const declared = contractNamesFromTicketMd(contractDoc?.content ?? null);
  if (declared.length > 0) {
    const pinned = await ctx.store.getDoc({
      workspace: ctx.workspace,
      subject: ticket.ticket_id,
      doc: 'contract.json',
    });
    if (!pinned) {
      // Surface once — an open gate item means the human already knows.
      const existing = await ctx.store.getGateItem({
        workspace: ctx.workspace,
        subject: ticket.ticket_id,
        gate: CONTRACT_MISSING_GATE,
      });
      if (!existing || existing.cleared_at) {
        const ts = ctx.now().toISOString();
        const gateRow = {
          workspace: ctx.workspace,
          subject: ticket.ticket_id,
          gate: CONTRACT_MISSING_GATE,
          kind: 'repair' as const,
          surfaced_at: ts,
          cleared_at: null,
          blocked_agent: true,
          priority: null,
        };
        await ctx.store.upsertGateItem(gateRow);
        ctx.notify?.({ type: 'gate_surfaced', payload: gateRow });
        await ctx.store.insertNotification({
          workspace: ctx.workspace,
          subject: ticket.ticket_id,
          kind: `gate:${CONTRACT_MISSING_GATE}`,
          payload: JSON.stringify({
            gate: CONTRACT_MISSING_GATE,
            contracts: declared,
          }),
          created_at: ts,
          read_at: null,
        });
      }
      return 'contract-unpinned';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Post-merge revalidation
// ---------------------------------------------------------------------------

export interface RevalidationResult {
  ticket_id: string;
  readiness: string;
  /** contract drift detected: {pinned, head} versions. */
  drift: { pinned: number; head: number } | null;
}

/** The dependent's pinned contract vs the current contract.json head
 *  — the drift that forces revalidation rather than silent proceed. */
async function pinnedContractDrift(
  ctx: CoordinatorCtx,
  ticketId: string,
): Promise<{ pinned: number; head: number } | null> {
  const runs = (
    await ctx.store.listRuns({
      workspace: ctx.workspace,
      ticket_id: ticketId,
    })
  ).sort((a, b) => b.id.localeCompare(a.id));
  let pinned: number | null = null;
  for (const r of runs) {
    const b = pinnedBaselineOf(r);
    if (b?.contract_ver != null) {
      pinned = b.contract_ver;
      break;
    }
  }
  if (pinned === null) return null; // never pinned — nothing to drift
  const head = await firstDocHead(ctx.store, ctx.workspace, ticketId, [
    'contract.json',
  ]);
  if (head === null || head === pinned) return null;
  return { pinned, head };
}

/**
 * Revalidate every non-terminal ticket that `depends_on` the merged
 * one: recompute `execution_readiness` (slots+statements+deps — the
 * dep's merge may unblock it or expose a dead dep), re-check the
 * pinned contract, and record the outcome as a `dependent_revalidated`
 * event. Contract drift surfaces a `baseline-drift` gate item —
 * revalidation, never silent proceed.
 */
export async function revalidateDependents(args: {
  ctx: CoordinatorCtx;
  mergedTicketId: string;
}): Promise<RevalidationResult[]> {
  const { ctx, mergedTicketId } = args;
  const ts = ctx.now().toISOString();
  const TERMINAL = [
    'released',
    'reverted',
    'wont-do',
    'aborted',
    'split',
    'discarded',
  ];
  const dependents = (
    await ctx.store.listTickets({ workspace: ctx.workspace })
  ).filter(
    (t) =>
      t.depends_on.includes(mergedTicketId) &&
      !TERMINAL.includes(t.status as never),
  );

  const out: RevalidationResult[] = [];
  for (const dep of dependents) {
    try {
      const drift = await pinnedContractDrift(ctx, dep.ticket_id);
      const ticketDoc = await ctx.store.getDoc({
        workspace: ctx.workspace,
        subject: dep.ticket_id,
        doc: 'ticket.md',
      });
      const declared = contractNamesFromTicketMd(ticketDoc?.content ?? null);
      const res = await computeExecutionReadiness({
        ctx,
        ticket: dep,
        contracts: declared,
      });
      const readiness =
        drift !== null && res.readiness === 'ready'
          ? 'incomplete'
          : res.readiness;
      const reasons = [...res.reasons];
      if (drift) {
        reasons.push(
          `contract.json drifted v${drift.pinned} → v${drift.head} — revalidation required`,
        );
      }
      if (dep.execution_readiness !== readiness) {
        await ctx.store.upsertTicket({
          ...dep,
          execution_readiness: readiness,
          updated_at: ts,
        });
      }
      if (drift) {
        const existing = await ctx.store.getGateItem({
          workspace: ctx.workspace,
          subject: dep.ticket_id,
          gate: 'baseline-drift',
        });
        if (!existing || existing.cleared_at) {
          const gateRow = {
            workspace: ctx.workspace,
            subject: dep.ticket_id,
            gate: 'baseline-drift',
            kind: 'approval' as const,
            surfaced_at: ts,
            cleared_at: null,
            blocked_agent: true,
            priority: 'high' as const,
          };
          await ctx.store.upsertGateItem(gateRow);
          ctx.notify?.({ type: 'gate_surfaced', payload: gateRow });
          await ctx.store.insertNotification({
            workspace: ctx.workspace,
            subject: dep.ticket_id,
            kind: 'gate:baseline-drift',
            payload: JSON.stringify({
              gate: 'baseline-drift',
              via: 'post-merge-revalidation',
              dep: mergedTicketId,
              drift,
            }),
            created_at: ts,
            read_at: null,
          });
        }
      }
      await ctx.store.appendEvent({
        workspace: ctx.workspace,
        ticket_id: dep.ticket_id,
        ts,
        stage: null,
        actor_type: 'runner',
        actor_id: ctx.actor,
        event: 'dependent_revalidated',
        run: null,
        refs: [],
        data: {
          merged: mergedTicketId,
          readiness,
          reasons,
          drift,
        },
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        human_minutes: null,
      } satisfies Omit<EventRow, 'seq'> as never);
      out.push({ ticket_id: dep.ticket_id, readiness, drift });
    } catch (e) {
      // Fail-closed surfacing: a revalidation failure becomes a repair
      // gate item on the dependent — never a swallowed error and never
      // a merge blocked by an advisory re-check.
      await ctx.store
        .upsertGateItem({
          workspace: ctx.workspace,
          subject: dep.ticket_id,
          gate: 'repair',
          kind: 'repair',
          surfaced_at: ts,
          cleared_at: null,
          blocked_agent: false,
          priority: null,
        })
        .catch(() => undefined);
      await ctx.store
        .appendEvent({
          workspace: ctx.workspace,
          ticket_id: dep.ticket_id,
          ts,
          stage: null,
          actor_type: 'runner',
          actor_id: ctx.actor,
          event: 'note_added',
          run: null,
          refs: [],
          data: {
            what: 'dependent revalidation failed',
            dep: mergedTicketId,
            error: (e as Error).message,
          },
          cost_usd: null,
          tokens_in: null,
          tokens_out: null,
          tokens_cached: null,
          usage_source: null,
          duration_s: null,
          human_minutes: null,
        })
        .catch(() => undefined);
    }
  }
  return out;
}
