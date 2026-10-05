/**
 * shepherd/poll.ts — the post-PR poll loop (CONDUCTOR "Shepherd loop",
 * wp-051).
 *
 * Called from the conductor tick (throttled by
 * `shepherd.poll_interval_s`). For every ticket in `pr-open`/`ci-watch`
 * and each `ticket_repos` row:
 *
 *   - no pr_url yet → push + `gh pr create` (covers both the
 *     approved-gate PR and the revert PR — REVERT-READY lands ci-watch
 *     with no pr_url);
 *   - `pr-open` + checks registered → `ci-watch` (transient status;
 *     CONDUCTOR tail gating);
 *   - checks failing → `ci-fix` run request carrying
 *     CI_FAILURE_LOGS + CYCLE/MAX_CYCLES, dedup'd on live runs and on
 *     the failure fingerprint; `budgets.shepherd_max_cycles` reached →
 *     escalation gate item + stop polling that PR;
 *   - new review comments → `comment-fix` run (PR_COMMENTS_JSON);
 *   - green + quiet → DoD gate: `cmd:` rows execute as verify tasks
 *     (envops runVerifyTask — a runner task, registered as a runs row),
 *     `manual` rows need a human attestation — all verified/attested →
 *     the `merge.json` doc_version is enabled. The merge button is a
 *     human action and NEVER auto-fires (CONDUCTOR tail gating);
 *   - `gh pr view` → MERGED → merged_sha on the row; ALL rows merged →
 *     `merged` (`reverted` when the merged PR is a revert PR).
 *
 * D29: tickets/docs are Postgres rows — vs.md, merge.json and
 * dod-attestations.json are `doc_versions` read/written through
 * `tools`. Shepherd poll bookkeeping (cycles, fingerprints, seen
 * comments, DoD results) is NOT truth: it lives in
 * `<rootPath>/.veto/shepherd/<ticketId>.json` (state.ts). The only
 * surviving git op here is `git push origin <branch>` on the CODE
 * worktree — there is no tickets repo to commit to.
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRow, TicketRepoRow, TicketRow } from '@sprint-runner/core';
import { git } from '@sprint-runner/gitops';
import type { TransitionTools } from '../contracts.js';
import { runVerifyTask } from '../envops/index.js';
import { hasLiveRun } from '../launch/index.js';
import { recordMerged } from '../merge/bookkeeping.js';
import { runMergeCenter } from '../merge/center.js';
import { nowIso, resolveRepoPath } from '../loop/deps.js';
import { makeTransitionTools } from '../loop/tools.js';
import type { ToolCtx } from '../loop/tools.js';
import {
  type DodRowClassified,
  manualRowsAttested,
  parseDodRows,
  readDodAttestations,
} from './dod.js';
import { checksGreen, isFailing } from './checks.js';
import type { GhClient, PrCheck } from './gh.js';
import { loadShepherdFile, prState, saveShepherdFile } from './state.js';

export interface ShepherdReport {
  workspace: string;
  /** PR urls actually polled this pass. */
  polled: string[];
  /** Human-readable action log (queued runs, status flips, merges). */
  actions: string[];
  warnings: string[];
}

export interface ShepherdCtx extends ToolCtx {
  gh: GhClient;
}

const SHEPHERD_STATUSES = ['pr-open', 'ci-watch'];

/** Stable fingerprint of the failing-check set — same failures → same
 *  fingerprint → no duplicate ci-fix while a push hasn't landed. */
function failureFingerprint(checks: PrCheck[]): string {
  const failing = checks
    .filter(isFailing)
    .map((c) => `${c.name}:${c.state ?? c.bucket ?? ''}`)
    .sort()
    .join('|');
  return createHash('sha1').update(failing).digest('hex').slice(0, 12);
}

function failureLogs(checks: PrCheck[]): string {
  return checks
    .filter(isFailing)
    .map(
      (c) =>
        `- ${c.name} (${c.state ?? c.bucket ?? 'failed'})` +
        `${c.link ? ` ${c.link}` : ''}` +
        `${c.description ? ` — ${c.description}` : ''}`,
    )
    .join('\n');
}

/** True when the ticket merged via a revert run (REVERT-READY →
 *  revert PR → its merge lands `reverted`, not `merged`). */
async function isRevertTicket(
  ctx: ToolCtx,
  ticketId: string,
): Promise<boolean> {
  const runs = await ctx.deps.store.listRuns({
    workspace: ctx.ws.name,
    ticket_id: ticketId,
  });
  return runs.some((r) => r.stage === 'revert' && r.status === 'done');
}

/**
 * Poll every open PR in one workspace. Called by the conductor tick —
 * throttle lives in the caller (`shepherd.poll_interval_s`).
 */
export async function pollOpenPrs(ctx: ShepherdCtx): Promise<ShepherdReport> {
  const { deps, ws, gh } = ctx;
  const store = deps.store;
  const report: ShepherdReport = {
    workspace: ws.name,
    polled: [],
    actions: [],
    warnings: [],
  };
  const tools = makeTransitionTools(ctx);
  const maxCycles = deps.config.budgets.shepherd_max_cycles;

  const tickets = (await store.listTickets({ workspace: ws.name })).filter(
    (t) => SHEPHERD_STATUSES.includes(t.status),
  );

  for (const ticket of tickets) {
    const id = ticket.ticket_id;
    const { file: shep, raw: shepRaw } = await loadShepherdFile(ws, id);
    let rows = await store.listTicketRepos({
      workspace: ws.name,
      ticket_id: id,
    });

    // ---- PR creation (approved-gate PRs and revert PRs) ----
    for (const row of rows) {
      if (row.pr_url || !row.branch || !row.worktree) continue;
      try {
        // The branch must be on the remote before gh can open a PR —
        // when there is no remote (tests, offline) this fails and the
        // row is skipped with a warning, never a stranded crash.
        await git(['push', 'origin', row.branch], { cwd: row.worktree });
      } catch {
        report.warnings.push(`${id}/${row.repo}: push failed (no remote?)`);
        continue;
      }
      try {
        const revert = await isRevertTicket(ctx, id);
        const title = revert
          ? `Revert ${id}: ${ticket.title}`
          : `${id}: ${ticket.title}`;
        const url = await gh.prCreate({
          cwd: row.worktree,
          head: row.branch,
          title,
          body: `Shepherd-managed PR for ${id}.`,
        });
        await store.upsertTicketRepo({
          ...row,
          pr_url: url,
          pr_state: 'open',
          ci_state: 'pending',
        });
        await tools.appendEvent({
          ticketId: id,
          event: 'pr_opened',
          data: {
            repo: row.repo,
            pr_url: url,
            ...(revert ? { revert: true } : {}),
          },
        });
        report.actions.push(`${id}/${row.repo}: pr opened ${url}`);
      } catch (e) {
        report.warnings.push(
          `${id}/${row.repo}: gh pr create failed: ${(e as Error).message}`,
        );
      }
    }
    rows = await store.listTicketRepos({
      workspace: ws.name,
      ticket_id: id,
    });

    // ---- per-PR poll ----
    for (const row of rows) {
      if (!row.pr_url || row.pr_state === 'merged' || row.pr_state === 'closed')
        continue;
      const st = prState(shep, row.repo);
      if (st.escalated) continue;

      let info: { state: string; mergeCommit?: { oid?: string } | null };
      let checks: PrCheck[];
      try {
        info = await gh.prView(row.pr_url);
        checks = await gh.prChecks(row.pr_url);
      } catch (e) {
        report.warnings.push(`${id}/${row.repo}: ${(e as Error).message}`);
        continue;
      }
      report.polled.push(row.pr_url);

      // -- merge / close detection --
      const ghState = info.state.toUpperCase();
      if (ghState === 'MERGED' || ghState === 'CLOSED') {
        const patch: Partial<TicketRepoRow> = {
          pr_state: ghState === 'MERGED' ? 'merged' : 'closed',
        };
        if (ghState === 'MERGED')
          patch.merged_sha = info.mergeCommit?.oid ?? null;
        await store.upsertTicketRepo({ ...row, ...patch });
        if (ghState === 'CLOSED') {
          await tools.appendEvent({
            ticketId: id,
            event: 'note_added',
            data: { repo: row.repo, pr_url: row.pr_url, closed: true },
          });
        }
        continue; // rollup pass below handles the all-merged case
      }

      // -- pr-open → ci-watch when checks register (transient) --
      if (ticket.status === 'pr-open') {
        if (checks.length === 0) continue;
        await tools.applyTicketStatus({
          ticketId: id,
          status: 'ci-watch',
          data: { via: 'shepherd: checks registered', repo: row.repo },
        });
        await tools.surfaceGateItem({
          subject: id,
          gate: 'ci-watch',
          kind: 'approval',
          payload: { via: 'shepherd' },
        });
        ticket.status = 'ci-watch';
        report.actions.push(`${id}: pr-open → ci-watch`);
      }

      // -- checks classification --
      const failing = checks.some(isFailing);
      const green = checksGreen(checks);
      const ciState = failing ? 'failing' : green ? 'green' : 'pending';
      if (row.ci_state !== ciState) {
        await store.upsertTicketRepo({ ...row, ci_state: ciState });
      }
      if (failing) {
        await tools.appendEvent({
          ticketId: id,
          event: 'ci_failed',
          data: {
            repo: row.repo,
            checks: checks.filter(isFailing).map((c) => c.name),
          },
        });
      }

      // -- failing → ci-fix (dedup'd; cycle-capped) --
      if (failing) {
        const fp = failureFingerprint(checks);
        if (st.cycles >= maxCycles) {
          st.escalated = true;
          await tools.surfaceGateItem({
            subject: id,
            gate: 'shepherd-cycle-cap',
            kind: 'escalation',
            blockedAgent: true,
            payload: {
              repo: row.repo,
              pr_url: row.pr_url,
              cycles: st.cycles,
              max_cycles: maxCycles,
            },
          });
          await tools.appendEvent({
            ticketId: id,
            event: 'escalated',
            data: {
              reason: 'shepherd cycle cap',
              repo: row.repo,
              cycles: st.cycles,
            },
          });
          report.actions.push(`${id}/${row.repo}: cycle cap → escalation`);
        } else if (
          fp !== st.last_failure_fingerprint &&
          !(await hasLiveRun(deps, ws.name, id, 'ci-fix'))
        ) {
          const cycle = st.cycles + 1;
          await tools.requestRun({
            workspace: ws.name,
            subject: id,
            stage: 'ci-fix',
            ticketId: id,
            tokens: {
              CI_FAILURE_LOGS: failureLogs(checks),
              CYCLE: String(cycle),
              MAX_CYCLES: String(maxCycles),
            },
          });
          st.cycles = cycle;
          st.last_failure_fingerprint = fp;
          report.actions.push(
            `${id}/${row.repo}: ci-fix queued (cycle ${cycle})`,
          );
        }
        // Failing → the green/quiet merge-enable path is moot.
        continue;
      }

      // -- new review comments → comment-fix --
      let newCommentCount = 0;
      try {
        const comments = await gh.reviewComments(row.pr_url);
        const seen = new Set(st.seen_comment_ids.map(String));
        const fresh = comments.filter((c) => !seen.has(String(c.id)));
        if (
          fresh.length > 0 &&
          !(await hasLiveRun(deps, ws.name, id, 'comment-fix'))
        ) {
          await tools.requestRun({
            workspace: ws.name,
            subject: id,
            stage: 'comment-fix',
            ticketId: id,
            tokens: { PR_COMMENTS_JSON: JSON.stringify(fresh) },
          });
          st.seen_comment_ids.push(...comments.map((c) => c.id));
          await tools.appendEvent({
            ticketId: id,
            event: 'teammate_comment',
            data: { repo: row.repo, count: fresh.length },
          });
          report.actions.push(
            `${id}/${row.repo}: comment-fix queued (${fresh.length} comments)`,
          );
          newCommentCount = fresh.length;
        }
      } catch (e) {
        report.warnings.push(
          `${id}/${row.repo}: comments: ${(e as Error).message}`,
        );
      }

      // -- green + quiet → DoD gate → merge enabled (never auto-merge) --
      const quiet =
        newCommentCount === 0 &&
        !(await hasLiveRun(deps, ws.name, id, 'comment-fix')) &&
        !(await hasLiveRun(deps, ws.name, id, 'ci-fix'));
      if (green && quiet) {
        await evaluateDod(ctx, ticket, row, st, tools, report);
      }
    }

    // ---- rollup: merged iff ALL ticket_repos rows merged ----
    const finalRows = await store.listTicketRepos({
      workspace: ws.name,
      ticket_id: id,
    });
    if (
      finalRows.length > 0 &&
      finalRows.every((r) => r.pr_state === 'merged')
    ) {
      const terminal = (await isRevertTicket(ctx, id)) ? 'reverted' : 'merged';
      // Post-merge bookkeeping (wp-133, DELIVERY §2): ticket status +
      // merged_sha + `merged` event + implementation-note append, all in
      // ONE transaction (recordMerged).
      await recordMerged({
        ctx: { ...ctx, gh },
        tools,
        ticket,
        rows: finalRows,
        status: terminal,
      });
      // Clear the merge-gate inbox row so it doesn't linger open forever.
      const gate = await store.getGateItem({
        workspace: ws.name,
        subject: id,
        gate: 'ci-watch',
      });
      if (gate && !gate.cleared_at) {
        await store.clearGateItem(
          { workspace: ws.name, subject: id, gate: 'ci-watch' },
          nowIso(deps),
        );
      }
      report.actions.push(`${id}: all PRs merged → ${terminal}`);
    }

    // Persist the shepherd state file only when it moved (scratch
    // state — no git commit, it is not a truth artifact).
    await saveShepherdFile(ws, id, shep, shepRaw);
  }

  // ---- Merge Center (wp-133, DELIVERY §2) ----
  // The `ci-watch` tail: evaluate the readiness checklist and, when
  // green, execute the merge via `gh pr merge` (never bypassing branch
  // protection). Runs after the per-ticket poll so freshly-merged rows
  // are visible to the next pass's rollup.
  try {
    const mergeReport = await runMergeCenter({ ...ctx, gh });
    report.actions.push(...mergeReport.actions);
    report.warnings.push(...mergeReport.warnings);
  } catch (e) {
    report.warnings.push(`merge-center: ${(e as Error).message}`);
  }

  return report;
}

// ---------------------------------------------------------------------------
// DoD at merge (CONDUCTOR "DoD at merge")
// ---------------------------------------------------------------------------

/** The merge-enable flag (CONDUCTOR "green + quiet → merge button
 *  enabled"). `ticket_repos` has no column for it (DB-SCHEMA is
 *  binding) — D29: the flag is a `doc_versions` doc on the ticket
 *  subject that the UI reads. */
const MERGE_FLAG = 'merge.json';

interface MergeFlagDoc {
  schema: 1;
  enabled: boolean;
  at: string;
  dod: { criterion: string; verified_by: string; status: string }[];
  note: string;
}

async function mergeFlagEnabled(
  docs: Pick<TransitionTools, 'getDocText'>,
  ticketId: string,
): Promise<boolean> {
  try {
    const raw = await docs.getDocText(ticketId, MERGE_FLAG);
    if (raw === null) return false;
    return (JSON.parse(raw) as MergeFlagDoc).enabled === true;
  } catch {
    return false;
  }
}

/**
 * DoD evaluation for a green+quiet PR: `cmd:` rows execute as verify
 * tasks (envops runVerifyTask — DETACHED commands, `timeouts.verify`
 * budget, results persisted into a runs row + the shepherd state
 * file); `manual` rows need an attestation in the
 * `dod-attestations.json` doc. All verified + attested → a new
 * `merge.json` doc version with enabled=true. A failed cmd row
 * surfaces a `dod-failed` gate item — it is not re-run automatically.
 */
async function evaluateDod(
  ctx: ShepherdCtx,
  ticket: TicketRow,
  row: TicketRepoRow,
  st: ReturnType<typeof prState>,
  tools: ReturnType<typeof makeTransitionTools>,
  report: ShepherdReport,
): Promise<void> {
  const { deps } = ctx;
  const id = ticket.ticket_id;
  if (await mergeFlagEnabled(tools, id)) return; // already enabled

  const vsMd = (await tools.getDocText(id, 'vs.md')) ?? '';
  const dodRows = parseDodRows(vsMd);
  st.dod ??= {};

  for (const dodRow of dodRows.filter((r) => r.kind === 'cmd')) {
    const prior = st.dod[dodRow.criterion];
    if (prior?.status === 'verified' || prior?.status === 'failed') continue;
    const result = await runDodVerify(ctx, ticket, row, dodRow);
    st.dod[dodRow.criterion] = result;
    if (result.status === 'failed') {
      await tools.surfaceGateItem({
        subject: id,
        gate: 'dod-failed',
        kind: 'failure',
        payload: {
          criterion: dodRow.criterion,
          command: dodRow.command,
          repo: row.repo,
        },
      });
      report.actions.push(
        `${id}/${row.repo}: DoD cmd failed — ${dodRow.criterion}`,
      );
    }
  }

  const attestations = await readDodAttestations(tools, id);
  const statuses = dodRows.map((r) => {
    if (r.kind === 'cmd') {
      return st.dod?.[r.criterion]?.status === 'verified'
        ? 'verified'
        : 'unverified';
    }
    if (r.kind === 'manual') {
      return attestations.some((a) => a.criterion === r.criterion)
        ? 'attested'
        : 'unattested';
    }
    return 'unknown';
  });
  const allClear =
    statuses.every((s) => s === 'verified' || s === 'attested') &&
    manualRowsAttested(dodRows, attestations);
  if (!allClear) return;

  const flag: MergeFlagDoc = {
    schema: 1,
    enabled: true,
    at: nowIso(deps),
    dod: dodRows.map((r, i) => ({
      criterion: r.criterion,
      verified_by: r.verified_by,
      status: statuses[i] ?? 'unknown',
    })),
    note: 'merge button enabled — merge NEVER auto-fires (CONDUCTOR tail gating)',
  };
  await tools.putDoc(id, MERGE_FLAG, `${JSON.stringify(flag, null, 2)}\n`);
  await tools.appendEvent({
    ticketId: id,
    event: 'ci_green',
    data: { repo: row.repo, merge_enabled: true },
  });
  report.actions.push(`${id}/${row.repo}: merge enabled`);
}

/**
 * Execute one DoD `cmd:` row as a verify task (CONDUCTOR "Runner
 * tasks") — a synthetic repo card carrying the row's shell command,
 * running in the PR worktree. Registered as a `runs` row for audit;
 * never routed through sentinel dispatch (it is conductor-side
 * compute, not an agent run).
 */
async function runDodVerify(
  ctx: ShepherdCtx,
  ticket: TicketRow,
  row: TicketRepoRow,
  dodRow: DodRowClassified,
): Promise<{ status: 'verified' | 'failed'; run_dir?: string; at?: string }> {
  const { deps, ws } = ctx;
  const id = ticket.ticket_id;
  const subject = `dod:${id}`;
  const ts = nowIso(deps);
  const prior = await deps.store.listRuns({ workspace: ws.name, subject });
  const attempt = prior.length + 1;
  const runId = `${ws.name}/${subject}/${String(attempt).padStart(3, '0')}-verify`;
  const runDir = join(deps.runsDir, ...runId.split('/'));
  await mkdir(runDir, { recursive: true });

  const repoPath = row.worktree ?? resolveRepoPath(deps, ws, row.repo);
  const result = await runVerifyTask({
    repoPath,
    ...(row.worktree ? { worktree: row.worktree } : {}),
    runId,
    runDir,
    card: {
      test: dodRow.command ?? '',
      forbidden_paths: [],
      verified: true,
    },
    ticket: id,
    timeoutMs: (deps.config.timeouts.verify ?? 3600) * 1000,
  });

  const run: RunRow = {
    id: runId,
    workspace: ws.name,
    subject,
    ticket_id: id,
    stage: 'verify',
    attempt,
    backend: 'runner',
    model: null,
    depth: null,
    pid: null,
    worktree: repoPath,
    status: 'done',
    started_at: ts,
    heartbeat_at: ts,
    exited_at: nowIso(deps),
    sentinel: 'DONE',
    sentinel_raw: 'DONE',
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: result.commands.reduce((s, c) => s + c.durationMs, 0) / 1000,
    run_dir: runDir,
  };
  await deps.store.createRun(run);

  return {
    status: result.exitCode === 0 ? 'verified' : 'failed',
    run_dir: runDir,
    at: nowIso(deps),
  };
}
