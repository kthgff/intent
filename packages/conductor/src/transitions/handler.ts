/**
 * transitions/handler.ts — `RealTransitionHandler`, the wp-031
 * implementation behind the frozen `TransitionHandler` seam
 * (contracts.ts). Driven by `TRANSITION_TABLE` (table.ts) — the
 * sentinel→transition rows are data; this class is the interpreter
 * plus the gate/auto-advance engine for `nextStage`.
 *
 * Auto-advance (CONDUCTOR "Auto-advance rules"):
 *   - every non-gate transition fires; the ONLY exception is
 *     → `in-progress`, which waits on the `test-approved` spend-
 *     checkpoint gate (full mode; suppressed in plan-package/minimal).
 *   - gate statuses park until their `gate_items` row clears —
 *     `nextStage` watches cleared gates and performs the follow-on
 *     status write + run request (answers-committed → re-run triage /
 *     design; doc approvals → next draft stage; split-plan approve →
 *     materialize).
 */
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { EffectiveConfig } from '@sprint-runner/config';
import {
  type EventRow,
  type GateMode,
  REVIEW_PASSES,
  type RunResult,
  type RunRow,
  type Sentinel,
  type TicketRow,
  type TicketStatus,
} from '@sprint-runner/core';
import { coverageLint, structuredDocLint } from '@sprint-runner/lints';
import { specLint } from '@sprint-runner/lints';
import { escalationModelFor } from '@sprint-runner/prompts';
import {
  type ApplyStatusOptions,
  type NextTransition,
  type RunOutcome,
  type TransitionContext,
  type TransitionHandler,
  type TransitionTools,
  applyTicketStatus,
  rewriteFrontmatterStatus,
} from '../contracts.js';
import { emitEvent } from '../events/index.js';
import type { EmitArgs } from '../events/index.js';
import { gateForStatus, gateKindFor } from '../gates/index.js';
import { parseTicketMd } from '../import/parse.js';
import { retryDecision } from '../loop/retry.js';
import {
  type ReviewDocument,
  applyFixResults,
  discussReply,
  dismissalClaimsFromDeviations,
  planReviewRound,
} from '../review/index.js';
import {
  type TriageSuggestions,
  applySuggestionsToTicketMd,
  findingsArtifact,
  getArtifactText,
  getDocText,
  latestArtifactText,
  materializeSplit,
  mergeFindingsPass,
  openBlockingSeverities,
  parseSplitPlan,
  pushBranches,
  putArtifactText,
  putDocText,
  readOrNull,
  readReviewJson,
  readTriageJson,
  recordSpecHash,
  runArtifactText,
  specIsStale,
  ticketArtifactText,
} from './actions.js';
import { type ActionId, TRANSITION_TABLE } from './table.js';

/** Max NEEDS-INFO rounds before the ticket escalates (ticket wp-031:
 *  "needs-info rounds cap 3" — three full Q&A rounds, the fourth
 *  NEEDS-INFO escalates). */
export const NEEDS_INFO_CAP = 3;

interface ActionArgs {
  outcome: RunOutcome;
  tools: TransitionTools;
  /** Sentinel payload (text after `:` in sentinel_raw). */
  payload: string;
}

type ActionFn = (args: ActionArgs) => Promise<void>;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Build the raw `events` row emitEvent produces — for writes that
 *  must ride inside a `store.transaction` block (the store's appendEvent
 *  takes the wire shape, not the EmitArgs shorthand). */
function makeEvent(tools: TransitionTools, e: EmitArgs): EventRow {
  return {
    workspace: tools.workspace,
    ticket_id: e.ticketId ?? null,
    ts: tools.now().toISOString(),
    stage: e.stage ?? null,
    actor_type: e.actorType ?? 'runner',
    actor_id: tools.actor,
    event: e.event,
    run: e.run ?? null,
    refs: e.refs ?? [],
    data: e.data ?? {},
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: e.humanMinutes ?? null,
  };
}

export class RealTransitionHandler implements TransitionHandler {
  readonly #config: EffectiveConfig;

  constructor(config: EffectiveConfig) {
    this.#config = config;
  }

  get gateMode(): GateMode {
    return this.#config.gates as GateMode;
  }

  /** Action ids with an implementation — asserted by the table
   *  coverage test (every TRANSITION_TABLE row must dispatch). */
  get implementedActions(): string[] {
    return Object.keys(this.#actions);
  }

  // ------------------------------------------------------------------
  // CLAIM — auto-advance chains + gate-clear detection
  // ------------------------------------------------------------------

  async nextStage(
    ticket: TicketRow,
    ctx: TransitionContext,
  ): Promise<NextTransition | null> {
    const id = ticket.ticket_id;
    const tools = this.#statusTools(ctx);
    const gateCleared = async (
      gate: string,
    ): Promise<'open' | 'cleared' | 'auto'> => {
      // The LOOP-advanced status, not `ticket.status` — a `continue`
      // chain (e.g. test-review auto → test-approved) changes the status
      // inside this call, and gateForStatus must see the new one or a
      // suppressed gate wrongly surfaces a gate_items row.
      const disp = gateForStatus(status, this.gateMode);
      if (disp && disp.gate === gate && disp.disposition === 'auto')
        return 'auto';
      const item = await ctx.store.getGateItem({
        workspace: ctx.workspace,
        subject: id,
        gate,
      });
      if (!item) {
        // A gate-status ticket with no gate_items row — repair the gap
        // so the human can see it (fail-closed, never a silent skip).
        await tools.surfaceGateItem({
          subject: id,
          gate,
          kind: gateKindFor(gate),
          priority: ticket.priority as never,
        });
        return 'open';
      }
      if (item.cleared_at) {
        // Mirror the human-side claim into the event ledger (DB-SCHEMA
        // claims ↔ SCHEMAS §7 claimed/unclaimed): a held claim at clear
        // time means someone owned the gate; absence means it cleared
        // unclaimed.
        const claim = await ctx.store.getClaim({
          workspace: ctx.workspace,
          subject: id,
          gate,
        });
        await emitEvent(tools, {
          ticketId: id,
          event: claim ? 'claimed' : 'unclaimed',
          data: { gate, ...(claim ? { actor: claim.claimed_by } : {}) },
        });
        return 'cleared';
      }
      return 'open';
    };
    const clearedGateEvent = async (gate: string) => {
      // `forced` is a tickets-row column (D29 — was a ticket.md
      // frontmatter regex).
      const forced = ticket.forced === true;
      await emitEvent(tools, {
        ticketId: id,
        event: forced ? 'gate_overridden' : 'gate_approved',
        data: { gate },
      });
    };

    // Guard against pathological loops — every iteration either returns
    // or strictly advances the status.
    let status = ticket.status as TicketStatus;
    for (let i = 0; i < 12; i++) {
      switch (status) {
        // ---- auto chains (non-gate transitions always fire) ----
        case 'imported': {
          await this.#inlineSpecLint(ticket, ctx);
          await this.#setStatus(ctx, id, 'triage');
          return { stage: 'triage' };
        }
        case 'triage': {
          // Parked on the split-plan gate? (status stays triage while a
          // split plan awaits approval — CONDUCTOR split materialization)
          const item = await ctx.store.getGateItem({
            workspace: ctx.workspace,
            subject: id,
            gate: 'split-plan',
          });
          if (item && !item.cleared_at) return null;
          if (item?.cleared_at) return this.#resolveSplitPlan(ticket, ctx);
          return null; // triage run in flight / done; nothing to claim
        }
        case 'needs-info': {
          if ((await gateCleared('needs-info')) !== 'cleared') return null;
          await clearedGateEvent('needs-info');
          await this.#emitQuestionAnswers(ticket, ctx, 'needs-info');
          await this.#setStatus(ctx, id, 'triage');
          return { stage: 'triage' };
        }
        case 'ready': {
          await this.#setStatus(ctx, id, 'prd-draft');
          return { stage: 'prd' };
        }
        case 'prd-approved': {
          await this.#setStatus(ctx, id, 'tdd-draft');
          return { stage: 'design' };
        }
        case 'tdd-approved': {
          await this.#setStatus(ctx, id, 'test-draft');
          return { stage: 'testplan' };
        }
        case 'test-approved': {
          const state = await gateCleared('test-approved');
          if (state === 'open') return null;
          // Stale-spec check (CONDUCTOR special paths) runs BEFORE the
          // gate_approved event — a stale ticket must not stamp the
          // approval into the ledger every tick while it waits.
          if (await this.#staleSpecCheck(ticket, ctx)) return null;
          if (state === 'cleared') await clearedGateEvent('test-approved');
          await this.#setStatus(ctx, id, 'in-progress');
          return { stage: 'implement' };
        }
        case 'design-qa': {
          if ((await gateCleared('design-qa')) !== 'cleared') return null;
          await clearedGateEvent('design-qa');
          await this.#emitQuestionAnswers(ticket, ctx, 'design-qa');
          await this.#setStatus(ctx, id, 'tdd-draft');
          return { stage: 'design' };
        }
        case 'changes-requested': {
          if ((await gateCleared('changes-requested')) !== 'cleared')
            return null;
          await clearedGateEvent('changes-requested');
          // Human triage — dismissed/wontfix findings are settled here.
          const review = await readReviewJson(ctx, id);
          const dismissed = (review?.findings ?? []).filter(
            (f) => f.status === 'dismissed' || f.status === 'wontfix',
          ).length;
          if (dismissed > 0) {
            await emitEvent(tools, {
              ticketId: id,
              event: 'finding_dismissed',
              data: { count: dismissed, gate: 'changes-requested' },
            });
          }
          await this.#setStatus(ctx, id, 'approved');
          status = 'approved';
          continue;
        }
        case 'approved': {
          if ((await gateCleared('approved')) !== 'cleared') return null;
          await clearedGateEvent('approved');
          // "approve & open PR" — push + gh pr create is the shepherd's
          // job; pr-open is transient (→ ci-watch when checks register).
          await this.#setStatus(ctx, id, 'pr-open');
          await emitEvent(tools, {
            ticketId: id,
            event: 'pr_opened',
            data: { via: 'approved gate' },
          });
          return null;
        }
        case 'pr-open':
          return null; // transient — shepherd flips it to ci-watch
        case 'ci-watch': {
          const state = await gateCleared('ci-watch');
          if (state === 'open') return null;
          // The merge button NEVER auto-fires (CONDUCTOR tail gating) —
          // a cleared gate means the human merged; record the rollup.
          if (state === 'cleared') {
            await clearedGateEvent('ci-watch');
            // A revert PR merging lands `reverted`, not `merged`
            // (CONDUCTOR revert row; shepherd writes this for real PRs).
            const isRevert = (
              await ctx.store.listRuns({
                workspace: ctx.workspace,
                ticket_id: id,
              })
            ).some((r) => r.stage === 'revert' && r.status === 'done');
            const terminal: TicketStatus = isRevert ? 'reverted' : 'merged';
            await this.#setStatus(ctx, id, terminal);
            await emitEvent(tools, {
              ticketId: id,
              event: terminal,
              data: { via: 'ci-watch gate' },
            });
          }
          return null;
        }
        case 'escalated': {
          if ((await gateCleared('escalated')) !== 'cleared') return null;
          await clearedGateEvent('escalated');
          await emitEvent(tools, {
            ticketId: id,
            event: 'resumed',
            data: { via: 'escalated gate cleared' },
          });
          await this.#setStatus(ctx, id, 'triage');
          return { stage: 'triage' };
        }
        // ---- gate statuses whose clearance advances the docs chain ----
        case 'prd-review':
        case 'tdd-review':
        case 'test-review': {
          const gate = gateForStatus(status, this.gateMode);
          if (!gate) return null;
          if (gate.disposition === 'auto') {
            // Gate suppressed by mode — auto-approve straight through.
            const next: TicketStatus =
              status === 'prd-review'
                ? 'prd-approved'
                : status === 'tdd-review'
                  ? 'tdd-approved'
                  : 'test-approved';
            await this.#setStatus(ctx, id, next, {
              data: { gate: gate.gate, auto: true },
            });
            if (next === 'test-approved') await this.#recordSpec(ctx, id);
            status = next;
            continue;
          }
          const state = await gateCleared(gate.gate);
          if (state === 'open') return null;
          await clearedGateEvent(gate.gate);
          const next: TicketStatus =
            status === 'prd-review'
              ? 'prd-approved'
              : status === 'tdd-review'
                ? 'tdd-approved'
                : 'test-approved';
          await this.#setStatus(ctx, id, next);
          await emitEvent(tools, {
            ticketId: id,
            event: 'doc_approved',
            data: { gate: gate.gate, doc: status },
          });
          if (next === 'test-approved') await this.#recordSpec(ctx, id);
          status = next;
          continue;
        }
        default:
          return null;
      }
    }
    return null;
  }

  /** `triage` + cleared split-plan gate → materialize children (approve)
   *  or re-triage (reject — recorded as a `gate_overridden` event by
   *  whoever cleared it; the gate row carries no decision field). */
  async #resolveSplitPlan(
    ticket: TicketRow,
    ctx: TransitionContext,
  ): Promise<NextTransition | null> {
    const id = ticket.ticket_id;
    const tools = this.#statusTools(ctx);
    const events = await ctx.store.listEvents({
      workspace: ctx.workspace,
      ticket_id: id,
      event: 'gate_overridden',
    });
    const rejected = events.some(
      (e) => (e.data as Record<string, unknown>)?.gate === 'split-plan',
    );
    if (rejected) {
      // Reject → plan stays in place, ticket returns to triage.
      await emitEvent(tools, {
        ticketId: id,
        event: 'doc_feedback',
        data: { gate: 'split-plan', decision: 'rejected' },
      });
      return { stage: 'triage' };
    }
    // The plan is a run_artifacts row written by the split run
    // (D29 — was tickets/<id>/split-plan.md).
    const plan = await ticketArtifactText(ctx, id, 'split-plan.md');
    const children = plan ? parseSplitPlan(plan) : null;
    if (!children) {
      await tools.surfaceGateItem({
        subject: id,
        gate: 'repair',
        kind: 'repair',
        payload: { reason: 'split-plan.md missing/unparseable at approval' },
      });
      return null;
    }
    await emitEvent(tools, {
      ticketId: id,
      event: 'split_approved',
      data: { children: children.length },
    });
    const ids = await materializeSplit({ ctx, ticketId: id, children });
    await emitEvent(tools, {
      ticketId: id,
      event: 'split_materialized',
      refs: Object.values(ids).map((c) => `doc:${c}:ticket.md`),
      data: ids,
    });
    await this.#setStatus(ctx, id, 'split', { data: { children: ids } });
    await emitEvent(tools, {
      ticketId: id,
      event: 'doc_edited',
      data: { what: 'split materialization', children: ids },
    });
    return null; // parent is terminal; children re-enter at `imported`
  }

  // ------------------------------------------------------------------
  // RECONCILE — sentinel dispatch
  // ------------------------------------------------------------------

  async onRunComplete(
    outcome: RunOutcome,
    tools: TransitionTools,
  ): Promise<void> {
    const { run, result } = outcome;
    const name = (result.sentinel ?? '') as Sentinel;
    const payload = sentinelPayload(result);
    const row = TRANSITION_TABLE.find(
      (r) =>
        (r.stage === run.stage || r.stage === '*') &&
        r.sentinel === name &&
        (r.when === undefined || r.when(payload)),
    );
    if (!row) {
      // A sentinel the enum accepts but the table doesn't cover for
      // this stage — fail-closed, never guess (CONDUCTOR table is the
      // contract; a miss means the prompt lied about its stage).
      await emitEvent(tools, {
        ticketId: run.ticket_id,
        stage: run.stage,
        event: 'run_failed',
        run: run.id,
        data: { reason: `no table row for (${run.stage}, ${name})` },
      });
      if (run.ticket_id) {
        await tools.applyTicketStatus({
          ticketId: run.ticket_id,
          status: 'failed',
          run: run.id,
          data: { reason: `unhandled sentinel ${name} for ${run.stage}` },
        });
      }
      return;
    }
    // First-attempt interview/survey runs imply their start events —
    // the ledger records them even though these subjects aren't
    // ticket-driven (SCHEMAS §7 interview_started / survey_started).
    if (
      run.attempt === 1 &&
      (run.stage === 'interview' || run.stage === 'survey')
    ) {
      await emitEvent(tools, {
        ticketId: run.ticket_id,
        stage: run.stage,
        event:
          run.stage === 'interview' ? 'interview_started' : 'survey_started',
        run: run.id,
        data: { subject: run.subject },
      });
    }
    const action = this.#actions[row.action];
    await action({ outcome, tools, payload });
    // No LOG.md regen — the events table is the ledger (D29); LOG.md
    // is a derived render the API/UI produces on read.
  }

  // ------------------------------------------------------------------
  // Table-row actions
  // ------------------------------------------------------------------

  #actions: Record<ActionId, ActionFn> = {
    // -- interview --
    interviewQuestions: async ({ outcome, tools, payload }) => {
      await tools.surfaceGateItem({
        subject: outcome.run.subject,
        gate: 'interview-qa',
        kind: 'question',
        payload: { questions: Number(payload) || payload },
      });
      await emitEvent(tools, {
        stage: 'interview',
        event: 'question_asked',
        run: outcome.run.id,
        data: { subject: outcome.run.subject, count: payload },
      });
      // Re-run on answers: the gate-clear path (API wp) queues the
      // next interview run — interview subjects aren't ticket-driven.
    },

    ticketAuthored: async ({ outcome, tools, payload }) => {
      // TICKET-AUTHORED: <id> — the run wrote <id>/ticket.md into its
      // run dir; reconcile ingested it as a doc_versions row. The
      // truth row doesn't exist yet (interview subjects aren't ticket
      // rows) — create it here, transactionally with the audit events,
      // fail-closed when the doc is missing or malformed.
      const id = payload.trim();
      const raw = await tools.getDocText(id, 'ticket.md');
      const parsed = raw ? parseTicketMd(raw, `${id}/ticket.md`) : null;
      if (!parsed?.ok) {
        await tools.surfaceGateItem({
          subject: outcome.run.subject,
          gate: 'repair',
          kind: 'repair',
          payload: {
            reason: `TICKET-AUTHORED ${id}: ${
              parsed ? parsed.error.error : 'no ticket.md doc ingested'
            }`,
          },
        });
        await emitEvent(tools, {
          stage: 'interview',
          event: 'run_failed',
          run: outcome.run.id,
          data: {
            reason: `TICKET-AUTHORED ${id}: ticket.md missing/unparseable`,
          },
        });
        return;
      }
      const { frontmatter } = parsed.value;
      const ts = tools.now().toISOString();
      // Row + ticket.md status rewrite + audit events in one write
      // (ARCHITECTURE §4.4). Status enters as `imported` — the pipeline
      // entry state — regardless of what the doc claims.
      await tools.store.transaction(async (s) => {
        await s.upsertTicket({
          workspace: tools.workspace,
          ticket_id: id,
          feature: frontmatter.feature ?? null,
          title: frontmatter.title,
          status: 'imported',
          priority: frontmatter.priority,
          depth: frontmatter.depth,
          backend: frontmatter.backend ?? null,
          model: frontmatter.model ?? null,
          repos: frontmatter.repos,
          parent: frontmatter.parent ?? null,
          depends_on: frontmatter.depends_on,
          source: 'interview',
          forced: frontmatter.forced,
          spec_score: null,
          spec_hash: sha256(raw ?? ''),
          blocked_reason: null,
          created_at: ts,
          updated_at: ts,
        });
        for (const repo of frontmatter.repos) {
          await s.upsertTicketRepo({
            workspace: tools.workspace,
            ticket_id: id,
            repo,
            branch: null,
            worktree: null,
            pr_url: null,
            pr_state: null,
            ci_state: null,
            merged_sha: null,
          });
        }
        if (frontmatter.status !== 'imported') {
          // Keep the doc's frontmatter in step with the row (D24 — new
          // version, never in-place).
          const next = rewriteFrontmatterStatus(raw ?? '', 'imported', null);
          if (next !== raw) {
            await s.appendDocVersion(
              { workspace: tools.workspace, subject: id, doc: 'ticket.md' },
              next,
              tools.actor,
            );
          }
        }
        await s.appendEvent(
          makeEvent(tools, {
            ticketId: id,
            stage: 'interview',
            event: 'ticket_authored',
            run: outcome.run.id,
            refs: [`doc:${id}:ticket.md`],
          }),
        );
        await s.appendEvent(
          makeEvent(tools, {
            ticketId: id,
            stage: 'interview',
            event: 'status_changed',
            run: outcome.run.id,
            data: { from: null, to: 'imported', via: 'interview' },
          }),
        );
      });
      await emitEvent(tools, {
        ticketId: id,
        event: 'imported',
        run: outcome.run.id,
        data: { via: 'interview' },
      });
      // Interview → pipeline handoff (SCHEMAS §7 handoff).
      await emitEvent(tools, {
        ticketId: id,
        event: 'handoff',
        run: outcome.run.id,
        data: { from: 'interview', to: 'pipeline' },
      });
    },

    wontDraft: async ({ outcome, tools, payload }) => {
      await tools.surfaceGateItem({
        subject: outcome.run.subject,
        gate: 'wont-draft',
        kind: 'failure',
        payload: { reason: payload },
      });
      await emitEvent(tools, {
        stage: 'interview',
        event: 'note_added',
        run: outcome.run.id,
        data: { sentinel: 'WONT-DRAFT', reason: payload },
      });
    },

    // -- import --
    importCommitted: async ({ tools, outcome, payload }) => {
      // The import run's <KEY>/ticket.md files were ingested into
      // doc_versions by reconcile (D29 — there is no tickets repo to
      // commit; the doc_edited event marks the write the commit used
      // to signal).
      await emitEvent(tools, {
        stage: 'import',
        event: 'imported',
        run: outcome.run.id,
        data: { count: payload, subject: outcome.run.subject },
      });
      await emitEvent(tools, {
        stage: 'import',
        event: 'doc_edited',
        run: outcome.run.id,
        data: { what: 'import doc_versions', count: payload },
      });
    },

    importFailed: async ({ outcome, tools, payload }) => {
      await tools.surfaceGateItem({
        subject: outcome.run.subject,
        gate: 'import-failed',
        kind: 'failure',
        payload: { reason: payload },
      });
      await emitEvent(tools, {
        stage: 'import',
        event: 'note_added',
        run: outcome.run.id,
        data: { sentinel: 'IMPORT-FAILED', reason: payload },
      });
    },

    // -- probe --
    cardPersist: async ({ outcome, tools }) => {
      const repo = outcome.run.subject.replace(/^probe:/, '');
      await this.#persistCard(tools, outcome.run.id, repo, true);
    },

    probeFailed: async ({ outcome, tools, payload }) => {
      const repo = outcome.run.subject.replace(/^probe:/, '');
      await this.#persistCard(tools, outcome.run.id, repo, false);
      await tools.surfaceGateItem({
        subject: outcome.run.subject,
        gate: 'probe-failed',
        kind: 'failure',
        payload: { repo, reason: payload },
      });
      await emitEvent(tools, {
        stage: 'probe',
        event: 'note_added',
        run: outcome.run.id,
        data: { repo, reason: payload },
      });
    },

    // -- triage --
    triageReady: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      // Suggestions application — human-set fields win (CONDUCTOR
      // "Suggestions application"). ticket.md is a doc_versions doc;
      // the rewrite is a new version + a doc_edited event.
      const triage = await readTriageJson(tools, id);
      const suggestions = (triage?.suggestions ?? {}) as TriageSuggestions;
      const raw = await tools.getDocText(id, 'ticket.md');
      let applied: Record<string, string> = {};
      if (raw !== null) {
        const res = applySuggestionsToTicketMd(raw, suggestions);
        applied = res.applied;
        if (res.content !== raw) {
          const version = await tools.putDoc(id, 'ticket.md', res.content);
          await emitEvent(tools, {
            ticketId: id,
            event: 'doc_edited',
            run: outcome.run.id,
            refs: [`doc:${id}:ticket.md:v${version}`],
            data: { doc: 'ticket.md', applied },
          });
        }
      }
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'ready',
        run: outcome.run.id,
        data: { suggestions_applied: applied },
      });
      // `ready` → auto prd-draft: the next CLAIM pass runs it
      // (nextStage ready → prd). Nothing to queue here.
    },

    triageNeedsInfo: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const prior = (
        await tools.store.listRuns({ workspace: tools.workspace, subject: id })
      ).filter(
        (r) => r.stage === 'triage' && r.sentinel === 'NEEDS-INFO',
      ).length;
      if (prior > NEEDS_INFO_CAP) {
        await this.#actions.toEscalated({ outcome, tools, payload });
        return;
      }
      const triage = await readTriageJson(tools, id);
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'needs-info',
        run: outcome.run.id,
        data: { questions: payload },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'needs-info',
        kind: 'question',
        payload: { count: payload, questions: triage?.questions ?? [] },
      });
      await emitEvent(tools, {
        ticketId: id,
        stage: 'triage',
        event: 'question_asked',
        run: outcome.run.id,
        data: { count: payload, round: triage?.round ?? prior },
      });
    },

    queueSplitRun: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      await tools.requestRun({
        workspace: tools.workspace,
        subject: id,
        stage: 'split',
        ticketId: id,
      });
    },

    toEscalated: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'escalated',
        run: outcome.run.id,
        data: { reason: payload },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'escalated',
        kind: 'escalation',
        payload: { reason: payload, run: outcome.run.id },
      });
      await emitEvent(tools, {
        ticketId: id,
        stage: outcome.run.stage,
        event: 'escalated',
        run: outcome.run.id,
        data: { reason: payload },
      });
    },

    // -- split --
    splitProposed: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      // split-plan.md is a run_artifacts row (was
      // tickets/<id>/split-plan.md; the children/ drafts ingest the
      // same way and materializeSplit reads them back at gate clear).
      // This run's output wins; the doc-repair resume path re-enters
      // here with the plan living on an EARLIER run → fall back to the
      // ticket's latest artifact.
      const plan =
        (await runArtifactText(tools, outcome.run.id, id, 'split-plan.md')) ??
        (await ticketArtifactText(tools, id, 'split-plan.md'));
      const violations = plan
        ? structuredDocLint('split-plan.md', plan)
        : [{ rule: 'doc.missing', message: 'split-plan.md not written' }];
      if (violations.length > 0) {
        await this.#requestDocRepair(tools, id, 'split-plan.md', violations);
        return;
      }
      const children = parseSplitPlan(plan as string) ?? [];
      await emitEvent(tools, {
        ticketId: id,
        stage: 'split',
        event: 'split_proposed',
        run: outcome.run.id,
        refs: [`run:${outcome.run.id}:split-plan.md`],
        data: { children: children.length || payload },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'split-plan',
        kind: 'split-plan',
        payload: { children: children.map((c) => c.label) },
      });
    },

    // -- doc stages --
    prdReview: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      await this.#docGate(outcome, tools, id, 'prd-review', 'prd.md');
    },

    designQa: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'design-qa',
        run: outcome.run.id,
        data: { questions: payload },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'design-qa',
        kind: 'question',
        payload: { count: payload },
      });
      await emitEvent(tools, {
        ticketId: id,
        stage: 'design',
        event: 'question_asked',
        run: outcome.run.id,
        data: { count: payload },
      });
    },

    tddReview: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const tdd = await tools.getDocText(id, 'tdd.md');
      const violations = tdd
        ? structuredDocLint('tdd.md', tdd)
        : [{ rule: 'doc.missing', message: 'tdd.md not written' }];
      if (violations.length > 0) {
        await this.#requestDocRepair(tools, id, 'tdd.md', violations);
        return;
      }
      await this.#docGate(outcome, tools, id, 'tdd-review', 'tdd.md');
    },

    testplanReview: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const test = await tools.getDocText(id, 'test.md');
      const tdd = await tools.getDocText(id, 'tdd.md');
      const violations = test
        ? [
            ...structuredDocLint('test.md', test),
            // Coverage-matrix lint — fail-closed (SCHEMAS §4; every
            // ac_id/file-plan row → ≥1 case_id, no fake coverage).
            ...coverageLint(tdd ?? '', test),
          ]
        : [{ rule: 'doc.missing', message: 'test.md not written' }];
      if (violations.length > 0) {
        await this.#requestDocRepair(tools, id, 'test.md', violations);
        return;
      }
      await this.#docGate(outcome, tools, id, 'test-review', 'test.md');
    },

    // -- implement / verify / review --
    implementDone: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'review',
        run: outcome.run.id,
      });
      // verify task = runner-side suite re-run (DETACHED; CONDUCTOR
      // "Runner tasks"), then the 4 review passes chain off it.
      await tools.requestRun({
        workspace: tools.workspace,
        subject: id,
        stage: 'verify',
        ticketId: id,
        tokens: { VERIFY_FOR: 'implement' },
      });
    },

    verifyDone: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      // test-report.json was ingested as a run_artifacts row at
      // collect — top-level from the verify runner task, or nested
      // `<repo>/test-report.json` when a legacy adapter produced it.
      // FAIL-CLOSED: no report → `pass = false` (a verify run with no
      // report proves nothing; it must not gate-open the review chain).
      let found: { name: string; content: string } | null = null;
      const exact = await tools.getArtifactText(
        outcome.run.id,
        'test-report.json',
      );
      if (exact !== null) {
        found = { name: 'test-report.json', content: exact };
      } else {
        const reported = outcome.result.artifacts.find((a) =>
          a.endsWith('test-report.json'),
        );
        if (reported) {
          found = await this.#runArtifact(tools, outcome.run, reported);
        }
      }
      let pass = false;
      let reportRef: string | null = null;
      if (found) {
        try {
          reportRef = `run:${outcome.run.id}:${found.name}`;
          const parsed = JSON.parse(found.content) as {
            pass_pct?: number;
            cases?: { result?: string }[];
          };
          pass =
            (parsed.pass_pct ?? 0) >= 100 &&
            (parsed.cases ?? []).every((c) => c.result !== 'fail');
          await tools.putArtifact(
            outcome.run.id,
            found.name,
            `${JSON.stringify(parsed, null, 2)}\n`,
          );
        } catch {
          pass = false;
        }
      }
      await emitEvent(tools, {
        ticketId: id,
        stage: 'verify',
        event: pass ? 'ci_green' : 'ci_failed',
        run: outcome.run.id,
        refs: reportRef ? [reportRef] : [],
        data: { pass },
      });
      await this.#queueNextReviewPass(tools, id);
    },

    reviewPassComplete: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const review = await readReviewJson(tools, id);
      const round = review?.round ?? 1;
      // Merge every findings-<pass>.json this run produced (each was
      // ingested as a run_artifacts row; the merged review.json is
      // written back onto this run).
      let created = 0;
      let reopened = 0;
      let fixed = 0;
      let mergedAny = false;
      for (const pass of REVIEW_PASSES) {
        const artifact = findingsArtifact(outcome.result.artifacts, pass);
        if (!artifact) continue;
        const found = await this.#runArtifact(tools, outcome.run, artifact);
        if (!found) {
          // Reported but not ingested — same fail-closed contract as a
          // missing file under the tickets-repo layout.
          throw new Error(
            `PASS-COMPLETE ${payload}: findings-${pass}.json reported but no run_artifacts row`,
          );
        }
        const r = await mergeFindingsPass({
          ctx: tools,
          runId: outcome.run.id,
          ticketId: id,
          pass,
          findingsText: found.content,
          round,
        });
        created += r.created;
        reopened += r.reopened;
        fixed += r.fixed;
        mergedAny = true;
      }
      if (!mergedAny) {
        // Fail-closed: PASS-COMPLETE with no findings fragment is a
        // malformed structured output, not an empty pass.
        await this.#actions.reviewPassFailed({
          outcome,
          tools,
          payload: `PASS-COMPLETE ${payload} produced no findings-*.json`,
        });
        return;
      }
      if (created > 0) {
        await emitEvent(tools, {
          ticketId: id,
          stage: 'review',
          event: 'finding_created',
          run: outcome.run.id,
          refs: [`run:${outcome.run.id}:review.json`],
          data: { count: created, round, pass: payload },
        });
      }
      if (reopened > 0) {
        await emitEvent(tools, {
          ticketId: id,
          stage: 'review',
          event: 'finding_created',
          run: outcome.run.id,
          data: { reopened, round },
        });
      }
      if (fixed > 0) {
        await emitEvent(tools, {
          ticketId: id,
          stage: 'review',
          event: 'finding_fixed',
          run: outcome.run.id,
          data: { count: fixed, round },
        });
      }

      const after = await readReviewJson(tools, id);
      if (!after || !REVIEW_PASSES.every((p) => after.passes.includes(p))) {
        await this.#queueNextReviewPass(tools, id);
        return;
      }
      // All 4 passes merged → auto-fix severities route to a fix run
      // inside `review.auto_fix_rounds`; the rest go to the human.
      const blocking = openBlockingSeverities(
        after,
        this.#config.review.auto_fix_severities,
      );
      if (
        planReviewRound(
          after as unknown as ReviewDocument,
          this.#config.review,
        ) === 'fix-run'
      ) {
        await tools.requestRun({
          workspace: tools.workspace,
          subject: id,
          stage: 'fix',
          ticketId: id,
          tokens: { REVIEW_ROUND: String(round) },
        });
        await emitEvent(tools, {
          ticketId: id,
          stage: 'review',
          event: 'fix_round_started',
          run: outcome.run.id,
          data: { round, severities: blocking },
        });
        return;
      }
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'changes-requested',
        run: outcome.run.id,
        data: { round, blocking },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'changes-requested',
        kind: 'review',
        payload: { round, blocking },
      });
    },

    reviewPassFailed: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const failures = (
        await tools.store.listRuns({ workspace: tools.workspace, subject: id })
      ).filter(
        (r) => r.stage === 'review' && ['failed', 'killed'].includes(r.status),
      ).length;
      const verdict = retryDecision({
        stage: 'review',
        transient: false,
        failures: Math.max(failures, 1),
        escalationModel: escalationModelFor(this.#config),
      });
      if (verdict.kind === 'retry') {
        await tools.requestRun({
          workspace: tools.workspace,
          subject: id,
          stage: 'review',
          ticketId: id,
          ...(verdict.model ? { model: verdict.model } : {}),
        });
        return;
      }
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'failed',
        run: outcome.run.id,
        data: { reason: `PASS-FAILED: ${payload}`, failures },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'review-failed',
        kind: 'failure',
        payload: { reason: payload, failures },
      });
    },

    fixesComplete: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      // Apply the fix run's claims to review.json before the re-review:
      // FIXES-COMPLETE <f>/<t> + DEVIATIONS.md self-dismissals, capped
      // by budgets.fix_dismissal_cap — over-cap → the whole batch
      // escalates to the human (PRD §7.3).
      const review = await readReviewJson(tools, id);
      if (review) {
        const devPath = outcome.result.artifacts.find((a) =>
          a.endsWith('DEVIATIONS.md'),
        );
        const devArtifact = devPath
          ? await this.#runArtifact(tools, outcome.run, devPath)
          : null;
        const deviations = devArtifact?.content ?? '';
        const applied = applyFixResults(
          {
            payload,
            dismissed_thread_ids: dismissalClaimsFromDeviations(deviations),
          },
          review as unknown as ReviewDocument,
          { fix_dismissal_cap: this.#config.budgets.fix_dismissal_cap },
          { ts: tools.now().toISOString() },
        );
        if (applied.fixed > 0 || applied.dismissed > 0) {
          await tools.putArtifact(
            outcome.run.id,
            'review.json',
            `${JSON.stringify(applied.review, null, 2)}\n`,
          );
        }
        if (applied.dismissed > 0) {
          await emitEvent(tools, {
            ticketId: id,
            stage: 'fix',
            event: 'finding_dismissed',
            run: outcome.run.id,
            data: { count: applied.dismissed, by: 'fix-run' },
          });
        }
        if (applied.escalated) {
          await tools.surfaceGateItem({
            subject: id,
            gate: 'fix-dismissal-breach',
            kind: 'escalation',
            blockedAgent: true,
            payload: {
              reason: `fix run self-dismissed over cap (${applied.dismissed + applied.overCap.length} > ${this.#config.budgets.fix_dismissal_cap}) — ALL findings escalate`,
              over_cap: applied.overCap,
            },
          });
          await emitEvent(tools, {
            ticketId: id,
            stage: 'fix',
            event: 'escalated',
            run: outcome.run.id,
            data: {
              reason: 'fix dismissal cap breach',
              over_cap: applied.overCap,
            },
          });
        }
      }
      // FIXES-COMPLETE → a full re-review round: verify task again,
      // then the 4 passes merge over the grown review.json.
      await tools.requestRun({
        workspace: tools.workspace,
        subject: id,
        stage: 'verify',
        ticketId: id,
        tokens: { VERIFY_FOR: 'fix', FIXED: payload },
      });
      await emitEvent(tools, {
        ticketId: id,
        stage: 'fix',
        event: 'commit',
        run: outcome.run.id,
        data: { fixes: payload },
      });
    },

    // -- discuss --
    discussReplied: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const replyArtifact = outcome.result.artifacts.find((a) =>
        a.endsWith('reply.json'),
      );
      if (replyArtifact) {
        try {
          const found = await this.#runArtifact(
            tools,
            outcome.run,
            replyArtifact,
          );
          if (!found) throw new Error('reply.json not ingested');
          const reply = JSON.parse(found.content) as {
            thread_id?: string;
            body?: string;
          };
          const review = await readReviewJson(tools, id);
          if (review) {
            const res = discussReply(review as unknown as ReviewDocument, {
              sentinel: 'REPLIED',
              thread_id: reply.thread_id,
              body: reply.body,
              ts: tools.now().toISOString(),
            });
            if (res.kind === 'appended') {
              await tools.putArtifact(
                outcome.run.id,
                'review.json',
                `${JSON.stringify(res.review, null, 2)}\n`,
              );
              await emitEvent(tools, {
                ticketId: id,
                stage: 'discuss',
                event: 'note_added',
                run: outcome.run.id,
                data: { what: 'thread reply', thread_id: reply.thread_id },
              });
            }
          }
        } catch {
          /* malformed reply.json — the run's own lint path handles it */
        }
      }
    },

    needsFixRun: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      await tools.requestRun({
        workspace: tools.workspace,
        subject: id,
        stage: 'fix',
        ticketId: id,
      });
      await emitEvent(tools, {
        ticketId: id,
        stage: 'discuss',
        event: 'fix_round_started',
        run: outcome.run.id,
        data: { via: 'NEEDS-FIX-RUN' },
      });
    },

    // -- shepherd stages --
    pushToCiWatch: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const ticket = await tools.store.getTicket({
        workspace: tools.workspace,
        ticket_id: id,
      });
      const pushed = await pushBranches(tools, ticket);
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'ci-watch',
        run: outcome.run.id,
        data: { pushed },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'ci-watch',
        kind: 'approval',
        payload: { pushed },
      });
    },

    commentsProcessed: async ({ outcome, tools, payload }) => {
      // The run exists because a teammate left review comments
      // (shepherd poll → comment-fix run; SCHEMAS §7).
      await emitEvent(tools, {
        ticketId: outcome.run.ticket_id,
        stage: 'comment-fix',
        event: 'teammate_comment',
        run: outcome.run.id,
        data: { total: payload.split('/')[1] ?? payload },
      });
      await emitEvent(tools, {
        ticketId: outcome.run.ticket_id,
        stage: 'comment-fix',
        event: 'comments_processed',
        run: outcome.run.id,
        data: { addressed: payload },
      });
      await this.#actions.pushToCiWatch({ outcome, tools, payload });
    },

    rebased: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const ticket = await tools.store.getTicket({
        workspace: tools.workspace,
        ticket_id: id,
      });
      const pushed = await pushBranches(tools, ticket, { force: true });
      await emitEvent(tools, {
        ticketId: id,
        stage: 'rebase',
        event: 'rebase_run',
        run: outcome.run.id,
        data: { pushed },
      });
      await this.#actions.pushToCiWatch({ outcome, tools, payload });
    },

    revertReady: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const ticket = await tools.store.getTicket({
        workspace: tools.workspace,
        ticket_id: id,
      });
      const pushed = await pushBranches(tools, ticket);
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'ci-watch',
        run: outcome.run.id,
        data: { pushed, revert: true },
      });
      await emitEvent(tools, {
        ticketId: id,
        stage: 'revert',
        event: 'pr_opened',
        run: outcome.run.id,
        data: { revert: true },
      });
      // On merge → `reverted` (shepherd wp writes it + the event).
    },

    // -- doc-repair --
    docRepaired: async ({ outcome, tools }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const ticket = await tools.store.getTicket({
        workspace: tools.workspace,
        ticket_id: id,
      });
      const status = ticket?.status ?? '';
      await emitEvent(tools, {
        ticketId: id,
        stage: 'doc-repair',
        event: 'doc_repaired',
        run: outcome.run.id,
        data: { resume_from: status },
      });
      // Re-lint → resume the interrupted transition (or escalate to a
      // repair gate when the fix didn't take — CONDUCTOR doc-repair).
      // Repaired docs land as the LATEST doc_versions version / this
      // run's artifacts (D29).
      const lintFor = async (): Promise<
        { rule: string; message: string }[] | null
      > => {
        switch (status) {
          case 'test-draft': {
            const test = await tools.getDocText(id, 'test.md');
            const tdd = await tools.getDocText(id, 'tdd.md');
            return test
              ? [
                  ...structuredDocLint('test.md', test),
                  ...coverageLint(tdd ?? '', test),
                ]
              : null;
          }
          case 'tdd-draft': {
            const tdd = await tools.getDocText(id, 'tdd.md');
            return tdd ? structuredDocLint('tdd.md', tdd) : null;
          }
          case 'triage': {
            const plan =
              (await runArtifactText(
                tools,
                outcome.run.id,
                id,
                'split-plan.md',
              )) ?? (await ticketArtifactText(tools, id, 'split-plan.md'));
            return plan ? structuredDocLint('split-plan.md', plan) : null;
          }
          default:
            return null;
        }
      };
      const violations = await lintFor();
      if (violations === null) return; // nothing lint-bound was parked
      if (violations.length > 0) {
        await tools.surfaceGateItem({
          subject: id,
          gate: 'repair',
          kind: 'repair',
          blockedAgent: true,
          payload: { doc: 'doc-repair-needed', violations },
        });
        return;
      }
      switch (status) {
        case 'test-draft':
          await this.#docGate(outcome, tools, id, 'test-review', 'test.md');
          return;
        case 'tdd-draft':
          await this.#docGate(outcome, tools, id, 'tdd-review', 'tdd.md');
          return;
        case 'triage':
          await this.#actions.splitProposed({ outcome, tools, payload: '' });
          return;
        default:
          return;
      }
    },

    docRepairFailed: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      await tools.surfaceGateItem({
        subject: id,
        gate: 'repair',
        kind: 'repair',
        blockedAgent: true,
        payload: { doc: 'doc-repair-needed', reason: payload },
      });
      await emitEvent(tools, {
        ticketId: id,
        stage: 'doc-repair',
        event: 'note_added',
        run: outcome.run.id,
        data: { reason: `REPAIR-FAILED: ${payload}` },
      });
    },

    // -- escalate --
    escalationWritten: async ({ outcome, tools, payload }) => {
      await this.#actions.toEscalated({ outcome, tools, payload });
    },

    // -- survey --
    surveyComplete: async ({ outcome, tools, payload }) => {
      const m = /^survey:([^:]+):(.+)$/.exec(outcome.run.subject);
      const scope = (m?.[1] ?? 'repo') as 'repo' | 'product';
      const name = m?.[2] ?? outcome.run.subject;
      const ts = tools.now().toISOString();
      let sections = 0;
      let gaps = 0;
      for (const artifact of outcome.result.artifacts) {
        if (!artifact.endsWith('.md')) continue;
        const section = basename(artifact, '.md');
        // Sections were ingested as this run's run_artifacts rows.
        const found = await this.#runArtifact(tools, outcome.run, artifact);
        const content = found?.content ?? null;
        if (content === null) continue;
        // Human dossier edits survive re-survey (DB-SCHEMA) — audit the
        // preserved edit as an event.
        const prev = await tools.store.getDossierSection(scope, name, section);
        if (prev?.edited_by) {
          await emitEvent(tools, {
            stage: 'survey',
            event: 'dossier_edited',
            run: outcome.run.id,
            data: { scope, name, section, edited_by: prev.edited_by },
          });
        }
        await tools.store.upsertDossierSection({
          scope,
          name,
          section: section as never,
          version: Math.floor(Date.parse(ts) / 1000),
          content,
          surveyed_at: ts,
          sources_used: ['code'],
          stale: false,
          edited_by: null,
          edited_at: null,
        });
        sections += 1;
        if (section === 'gap-report') {
          gaps =
            content.split('\n').filter((l) => /^\|[^|]*\|/.test(l.trim()))
              .length - 2;
        }
      }
      await emitEvent(tools, {
        stage: 'survey',
        event: 'survey_completed',
        run: outcome.run.id,
        data: { scope, name, sections, count: payload },
      });
      await emitEvent(tools, {
        stage: 'survey',
        event: 'dossier_updated',
        run: outcome.run.id,
        data: { scope, name, sections },
      });
      if (gaps > 0) {
        await emitEvent(tools, {
          stage: 'survey',
          event: 'gap_reported',
          run: outcome.run.id,
          data: { scope, name, gaps },
        });
      }
    },

    surveyFailed: async ({ outcome, tools, payload }) => {
      await tools.surfaceGateItem({
        subject: outcome.run.subject,
        gate: 'survey-failed',
        kind: 'failure',
        payload: { reason: payload },
      });
      await emitEvent(tools, {
        stage: 'survey',
        event: 'note_added',
        run: outcome.run.id,
        data: { reason: payload },
      });
    },

    // -- catch-all --
    toBlocked: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id;
      if (id) {
        await tools.applyTicketStatus({
          ticketId: id,
          status: 'blocked',
          blockedReason: payload || 'blocked',
          run: outcome.run.id,
          data: { reason: payload },
        });
      } else {
        await tools.surfaceGateItem({
          subject: outcome.run.subject,
          gate: 'blocked',
          kind: 'failure',
          payload: { reason: payload },
        });
      }
      await emitEvent(tools, {
        ticketId: id,
        stage: outcome.run.stage,
        event: 'blocked',
        run: outcome.run.id,
        data: { reason: payload },
      });
    },
  };

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  /** Read an artifact the current run produced, by the adapter-reported
   *  path — the ingest keys rows by run-dir-relative name (basename
   *  covers scratch-dir artifacts). */
  async #runArtifact(
    tools: TransitionTools,
    run: RunRow,
    reportedPath: string,
  ): Promise<{ name: string; content: string } | null> {
    const dir = run.run_dir;
    const rel =
      dir && reportedPath.startsWith(`${dir}/`)
        ? reportedPath.slice(dir.length + 1)
        : reportedPath;
    for (const name of new Set([rel, basename(rel)])) {
      const content = await tools.getArtifactText(run.id, name);
      if (content !== null) return { name, content };
    }
    return null;
  }

  /** A TransitionTools view over a bare context (claim path — the
   *  reconcile-side tools factory isn't available outside
   *  onRunComplete). requestRun stays reconcile-only; everything else
   *  is store-backed on either path. */
  #statusTools(ctx: TransitionContext): TransitionTools {
    return {
      ...ctx,
      applyTicketStatus: (opts: ApplyStatusOptions) =>
        applyTicketStatus({ ctx, opts }),
      surfaceGateItem: async (item) => {
        const ts = ctx.now().toISOString();
        await ctx.store.upsertGateItem({
          workspace: ctx.workspace,
          subject: item.subject,
          gate: item.gate,
          kind: item.kind,
          surfaced_at: ts,
          cleared_at: null,
          blocked_agent: item.blockedAgent ?? false,
          priority: item.priority ?? null,
        });
        await ctx.store.insertNotification({
          workspace: ctx.workspace,
          subject: item.subject,
          kind: `gate:${item.kind}`,
          payload: JSON.stringify(item),
          created_at: ts,
          read_at: null,
        });
      },
      appendEvent: (e) =>
        ctx.store.appendEvent({
          workspace: ctx.workspace,
          ticket_id: e.ticketId ?? null,
          ts: ctx.now().toISOString(),
          stage: e.stage ?? null,
          actor_type: e.actorType ?? 'runner',
          actor_id: ctx.actor,
          event: e.event,
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
      requestRun: async () => {
        throw new Error(
          'requestRun is reconcile-side (claim uses the pending-run queue)',
        );
      },
      getDocText: (subject, doc) => getDocText(ctx, subject, doc),
      putDoc: (subject, doc, content) => putDocText(ctx, subject, doc, content),
      getArtifactText: (runId, name) => getArtifactText(ctx, runId, name),
      putArtifact: (runId, name, content) =>
        putArtifactText(ctx, runId, name, content),
      getLatestArtifactText: async (name, filter) => {
        if (filter.runId && !filter.ticketId) {
          return getArtifactText(ctx, filter.runId, name);
        }
        if (filter.ticketId) {
          return latestArtifactText(ctx, name, {
            ticketId: filter.ticketId,
          });
        }
        const runs = (
          await ctx.store.listRuns({ workspace: ctx.workspace })
        ).sort((a, b) => b.id.localeCompare(a.id));
        for (const r of runs) {
          const a = await ctx.store.getArtifact(r.id, name);
          if (a) return a.content;
        }
        return null;
      },
      allocTicketId: () => ctx.store.allocTicketId(ctx.workspace),
    };
  }

  async #setStatus(
    ctx: TransitionContext,
    ticketId: string,
    status: TicketStatus,
    extra: Partial<ApplyStatusOptions> = {},
  ): Promise<void> {
    await applyTicketStatus({ ctx, opts: { ticketId, status, ...extra } });
  }

  /** imported → spec-lint runs INLINE in the tick (CONDUCTOR "Runner
   *  tasks"; SCHEMAS §15 advisory score → tickets.spec_score +
   *  spec_scored event). */
  async #inlineSpecLint(
    ticket: TicketRow,
    ctx: TransitionContext,
  ): Promise<void> {
    const raw = await getDocText(ctx, ticket.ticket_id, 'ticket.md');
    if (raw === null) return;
    const result = specLint(raw);
    await ctx.store.upsertTicket({
      ...ticket,
      spec_score: result.score,
      updated_at: ctx.now().toISOString(),
    });
    const tools = this.#statusTools(ctx);
    await emitEvent(tools, {
      ticketId: ticket.ticket_id,
      event: 'spec_scored',
      data: { score: result.score, flags: result.flags },
    });
  }

  /** Queue the next unreported review pass (REVIEW_PASSES order from
   *  §6); returns true when a pass was queued. */
  async #queueNextReviewPass(
    tools: TransitionTools,
    id: string,
  ): Promise<boolean> {
    const review = await readReviewJson(tools, id);
    const done = new Set(review?.passes ?? []);
    const next = REVIEW_PASSES.find((p) => !done.has(p));
    if (!next) return false;
    await tools.requestRun({
      workspace: tools.workspace,
      subject: id,
      stage: 'review',
      ticketId: id,
      tokens: { REVIEW_PASS: next, REVIEW_ROUND: String(review?.round ?? 1) },
    });
    return true;
  }

  /** Fail-closed lint → ONE doc-repair run (CONDUCTOR doc-repair). */
  async #requestDocRepair(
    tools: TransitionTools,
    id: string,
    doc: string,
    violations: { rule: string; message: string }[],
  ): Promise<void> {
    await emitEvent(tools, {
      ticketId: id,
      event: 'doc_feedback',
      data: { doc, violations },
    });
    await tools.requestRun({
      workspace: tools.workspace,
      subject: id,
      stage: 'doc-repair',
      ticketId: id,
      tokens: {
        REPAIR_DOC: doc,
        LINT_VIOLATIONS: JSON.stringify(violations),
      },
    });
  }

  /** Doc-gate tail: status → gate item per gate mode (+ doc_drafted). */
  async #docGate(
    outcome: RunOutcome,
    tools: TransitionTools,
    id: string,
    status: 'prd-review' | 'tdd-review' | 'test-review',
    doc: string,
  ): Promise<void> {
    await tools.applyTicketStatus({
      ticketId: id,
      status,
      run: outcome.run.id,
    });
    await emitEvent(tools, {
      ticketId: id,
      stage: outcome.run.stage,
      event: 'doc_drafted',
      run: outcome.run.id,
      refs: [`doc:${id}:${doc}`],
    });
    const gate = gateForStatus(status, this.gateMode);
    if (!gate || gate.disposition !== 'surface') return;
    await tools.surfaceGateItem({
      subject: id,
      gate: gate.gate,
      kind: gateKindFor(gate.gate),
      payload: { doc },
    });
  }

  /** Record the spec-completion hash on `tickets.spec_hash` (stale-spec
   *  baseline — CONDUCTOR "Stale-spec check"). */
  async #recordSpec(ctx: TransitionContext, id: string): Promise<void> {
    await recordSpecHash(ctx, id);
  }

  /** Implement-launch re-hash; stale → `stale-spec` inbox item and the
   *  ticket stays test-approved (never implements stale requirements). */
  async #staleSpecCheck(
    ticket: TicketRow,
    ctx: TransitionContext,
  ): Promise<boolean> {
    if (!(await specIsStale(ctx, ticket.ticket_id))) return false;
    // Surface once — nextStage re-runs every tick; an open stale-spec
    // gate already in place must not re-notify (no event spam).
    const existing = await ctx.store.getGateItem({
      workspace: ctx.workspace,
      subject: ticket.ticket_id,
      gate: 'stale-spec',
    });
    if (existing) return true;
    const tools = this.#statusTools(ctx);
    await tools.surfaceGateItem({
      subject: ticket.ticket_id,
      gate: 'stale-spec',
      kind: 'failure',
      payload: { reason: 'spec inputs changed since spec completion' },
    });
    await emitEvent(tools, {
      ticketId: ticket.ticket_id,
      event: 'note_added',
      data: { kind: 'stale-spec' },
    });
    return true;
  }

  /** Answers committed into triage.json/design.json on gate clear →
   *  question_answered (+ question_autoaccepted for auto-skips). The
   *  json is a run_artifacts row — the newest one across the ticket's
   *  runs carries the human's answers (D29). */
  async #emitQuestionAnswers(
    ticket: TicketRow,
    ctx: TransitionContext,
    gate: 'needs-info' | 'design-qa',
  ): Promise<void> {
    const file = gate === 'needs-info' ? 'triage.json' : 'design.json';
    const raw = await ticketArtifactText(ctx, ticket.ticket_id, file);
    let questions: { status?: string; auto?: boolean }[] = [];
    try {
      questions = raw
        ? ((JSON.parse(raw) as { questions?: never[] }).questions ?? [])
        : [];
    } catch {
      /* tolerate absence — the human may have answered in the mirror doc */
    }
    const tools = this.#statusTools(ctx);
    const auto = questions.filter((q) => q.auto === true).length;
    if (auto > 0) {
      await emitEvent(tools, {
        ticketId: ticket.ticket_id,
        event: 'question_autoaccepted',
        data: { gate, count: auto },
      });
    }
    await emitEvent(tools, {
      ticketId: ticket.ticket_id,
      event: 'question_answered',
      data: { gate, answered: questions.length - auto, auto },
    });
  }

  /** Probe CARD-WRITTEN/PROBE-FAILED → persist the card snapshot as a
   *  `card.json` run_artifacts row on the probe run (the durable copy;
   *  the live config card is the probe agent's own write into the code
   *  repo's `.sprint-runner/` — git-for-code is still real under D29). */
  async #persistCard(
    tools: TransitionTools,
    runId: string,
    repo: string,
    verified: boolean,
  ): Promise<{ verified?: boolean } | null> {
    const repoCfg = this.#config.repos[repo];
    const repoPath = repoCfg?.path
      ? isAbsolute(repoCfg.path)
        ? repoCfg.path
        : resolve(tools.rootPath, repoCfg.path)
      : null;
    const cardRaw = repoPath
      ? await readOrNull(join(repoPath, '.sprint-runner', 'card.json'))
      : null;
    const parsed = cardRaw
      ? (JSON.parse(cardRaw) as Record<string, unknown>)
      : {};
    // `verified` per the probe's own report (CONDUCTOR); PROBE-FAILED
    // forces false.
    parsed.verified = verified ? (parsed.verified ?? true) : false;
    await tools.putArtifact(
      runId,
      'card.json',
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    return parsed;
  }
}

/** Sentinel payload = text after the first `:` in sentinel_raw. */
export function sentinelPayload(result: RunResult): string {
  const raw = result.sentinel_raw ?? '';
  const i = raw.indexOf(':');
  return i === -1 ? '' : raw.slice(i + 1).trim();
}
