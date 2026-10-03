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
import { readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { EffectiveConfig } from '@sprint-runner/config';
import {
  type GateMode,
  REVIEW_PASSES,
  type RunResult,
  type Sentinel,
  type Stage,
  type TicketRow,
  type TicketStatus,
} from '@sprint-runner/core';
import { commitAll } from '@sprint-runner/gitops';
import { coverageLint, structuredDocLint } from '@sprint-runner/lints';
import { specLint } from '@sprint-runner/lints';
import {
  type ApplyStatusOptions,
  type NextTransition,
  type RunOutcome,
  type TransitionContext,
  type TransitionHandler,
  type TransitionTools,
  applyTicketStatus,
} from '../contracts.js';
import { emitEvent, regenerateLog } from '../events/index.js';
import { gateForStatus, gateKindFor } from '../gates/index.js';
import { retryDecision } from '../loop/retry.js';
import {
  type TriageSuggestions,
  applySuggestionsToTicketMd,
  findingsArtifact,
  flatFrontmatter,
  gitActor,
  materializeSplit,
  mergeFindingsPass,
  openBlockingSeverities,
  parseSplitPlan,
  pushBranches,
  readOrNull,
  readReviewJson,
  readTriageJson,
  recordSpecHash,
  specIsStale,
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
      const forced = /forced\s*:\s*true/.test(
        (await readOrNull(this.#ticketFile(ctx, id))) ?? '',
      );
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
          const review = await readReviewJson(
            join(ctx.ticketsRepoPath, 'tickets', id),
          );
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
    const ticketDir = join(ctx.ticketsRepoPath, 'tickets', id);
    const plan = await readOrNull(join(ticketDir, 'split-plan.md'));
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
      refs: Object.values(ids).map((c) => `tickets/${c}/ticket.md`),
      data: ids,
    });
    await this.#setStatus(ctx, id, 'split', { data: { children: ids } });
    await emitEvent(tools, {
      ticketId: id,
      event: 'commit',
      data: { what: 'split materialization' },
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
    if (run.ticket_id) {
      await regenerateLog(tools, run.ticket_id).catch(() => {});
    }
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
      const id = payload.trim();
      await emitEvent(tools, {
        ticketId: id,
        stage: 'interview',
        event: 'ticket_authored',
        run: outcome.run.id,
        refs: [`tickets/${id}/ticket.md`],
      });
      await tools.applyTicketStatus({
        ticketId: id,
        status: 'imported',
        run: outcome.run.id,
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
      // The import run wrote ticket folders into the cardless worktree
      // (the tickets repo) — commit + project them; status commits for
      // each folder ride the next projection pass.
      await commitAll(
        tools.ticketsRepoPath,
        `conductor: import ${payload} ticket(s)`,
        gitActor(tools),
      );
      await emitEvent(tools, {
        stage: 'import',
        event: 'imported',
        run: outcome.run.id,
        data: { count: payload, subject: outcome.run.subject },
      });
      await emitEvent(tools, {
        stage: 'import',
        event: 'commit',
        run: outcome.run.id,
        data: { what: 'import commit' },
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
      const card = await this.#persistCard(tools, repo, true);
      await emitEvent(tools, {
        stage: 'probe',
        event: 'commit',
        run: outcome.run.id,
        data: { repo, verified: card?.verified ?? true },
      });
    },

    probeFailed: async ({ outcome, tools, payload }) => {
      const repo = outcome.run.subject.replace(/^probe:/, '');
      await this.#persistCard(tools, repo, false);
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
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
      // Suggestions application — human-set fields win (CONDUCTOR
      // "Suggestions application").
      const triage = await readTriageJson(ticketDir);
      const suggestions = (triage?.suggestions ?? {}) as TriageSuggestions;
      const file = join(ticketDir, 'ticket.md');
      const raw = await readFile(file, 'utf8');
      const { content, applied } = applySuggestionsToTicketMd(raw, suggestions);
      if (content !== raw) await writeFile(file, content, 'utf8');
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
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
      const triage = await readTriageJson(ticketDir);
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
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
      const plan = await readOrNull(join(ticketDir, 'split-plan.md'));
      const violations = plan
        ? structuredDocLint('split-plan.md', plan)
        : [{ rule: 'doc.missing', message: 'split-plan.md not written' }];
      if (violations.length > 0) {
        await this.#requestDocRepair(tools, id, 'split-plan.md', violations);
        return;
      }
      await commitAll(
        tools.ticketsRepoPath,
        `conductor: ${id} split plan (${payload} children)`,
        gitActor(tools),
      );
      const children = parseSplitPlan(plan as string) ?? [];
      await emitEvent(tools, {
        ticketId: id,
        stage: 'split',
        event: 'split_proposed',
        run: outcome.run.id,
        refs: [`tickets/${id}/split-plan.md`],
        data: { children: children.length || payload },
      });
      await tools.surfaceGateItem({
        subject: id,
        gate: 'split-plan',
        kind: 'split-plan',
        payload: { children: children.map((c) => c.label) },
      });
      await emitEvent(tools, {
        ticketId: id,
        event: 'commit',
        run: outcome.run.id,
        data: { what: 'split-plan.md + children/ drafts' },
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
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
      const tdd = await readOrNull(join(ticketDir, 'tdd.md'));
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
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
      const test = await readOrNull(join(ticketDir, 'test.md'));
      const tdd = await readOrNull(join(ticketDir, 'tdd.md'));
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
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
      const report = outcome.result.artifacts.find((a) =>
        a.endsWith('test-report.json'),
      );
      let pass = true;
      if (report) {
        try {
          const parsed = JSON.parse(await readFile(report, 'utf8')) as {
            pass_pct?: number;
            cases?: { result?: string }[];
          };
          pass =
            (parsed.pass_pct ?? 0) >= 100 &&
            (parsed.cases ?? []).every((c) => c.result !== 'fail');
          const dest = join(ticketDir, 'test-report.json');
          await writeFile(dest, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
          await commitAll(
            tools.ticketsRepoPath,
            `conductor: ${id} test-report`,
            gitActor(tools),
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
        refs: report ? [`tickets/${id}/test-report.json`] : [],
        data: { pass },
      });
      await this.#queueNextReviewPass(tools, id);
    },

    reviewPassComplete: async ({ outcome, tools, payload }) => {
      const id = outcome.run.ticket_id ?? outcome.run.subject;
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
      const review = await readReviewJson(ticketDir);
      const round = review?.round ?? 1;
      // Merge every findings-<pass>.json this run produced.
      let created = 0;
      let reopened = 0;
      let fixed = 0;
      let mergedAny = false;
      for (const pass of REVIEW_PASSES) {
        const artifact = findingsArtifact(outcome.result.artifacts, pass);
        if (!artifact) continue;
        const r = await mergeFindingsPass({
          ticketDir,
          ticketId: id,
          pass,
          findingsPath: artifact,
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
      await commitAll(
        tools.ticketsRepoPath,
        `conductor: ${id} review.json round ${round}`,
        gitActor(tools),
      );
      if (created > 0) {
        await emitEvent(tools, {
          ticketId: id,
          stage: 'review',
          event: 'finding_created',
          run: outcome.run.id,
          refs: [`tickets/${id}/review.json`],
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

      const after = await readReviewJson(ticketDir);
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
      if (blocking.length > 0 && round <= this.#config.review.auto_fix_rounds) {
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
        escalationModel: this.#config.escalation_model ?? null,
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
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
      const replyArtifact = outcome.result.artifacts.find((a) =>
        a.endsWith('reply.json'),
      );
      if (replyArtifact) {
        try {
          const reply = JSON.parse(await readFile(replyArtifact, 'utf8')) as {
            thread_id?: string;
            body?: string;
          };
          const review = await readReviewJson(ticketDir);
          const finding = review?.findings.find(
            (f) => f.thread_id === reply.thread_id,
          );
          if (review && finding) {
            (finding.replies as unknown[]).push({
              actor: 'agent',
              body: reply.body ?? '',
              ts: tools.now().toISOString(),
            });
            await writeFile(
              join(ticketDir, 'review.json'),
              `${JSON.stringify(review, null, 2)}\n`,
              'utf8',
            );
            await commitAll(
              tools.ticketsRepoPath,
              `conductor: ${id} discuss reply ${reply.thread_id}`,
              gitActor(tools),
            );
          }
        } catch {
          /* malformed reply.json — the run's own lint path handles it */
        }
      }
      await emitEvent(tools, {
        ticketId: id,
        stage: 'discuss',
        event: 'commit',
        run: outcome.run.id,
        data: { what: 'thread reply' },
      });
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
      const ticketDir = join(tools.ticketsRepoPath, 'tickets', id);
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
      const lintFor = async (): Promise<
        { rule: string; message: string }[] | null
      > => {
        switch (status) {
          case 'test-draft': {
            const test = await readOrNull(join(ticketDir, 'test.md'));
            const tdd = await readOrNull(join(ticketDir, 'tdd.md'));
            return test
              ? [
                  ...structuredDocLint('test.md', test),
                  ...coverageLint(tdd ?? '', test),
                ]
              : null;
          }
          case 'tdd-draft': {
            const tdd = await readOrNull(join(ticketDir, 'tdd.md'));
            return tdd ? structuredDocLint('tdd.md', tdd) : null;
          }
          case 'triage': {
            const plan = await readOrNull(join(ticketDir, 'split-plan.md'));
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
        const content = await readOrNull(artifact);
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

  #ticketFile(ctx: TransitionContext, id: string): string {
    return join(ctx.ticketsRepoPath, 'tickets', id, 'ticket.md');
  }

  /** applyTicketStatus + LOG.md regen against a bare context (claim
   *  path — TransitionTools isn't available outside reconcile). */
  #statusTools(ctx: TransitionContext): TransitionTools {
    return {
      ...ctx,
      applyTicketStatus: (opts: ApplyStatusOptions) =>
        applyTicketStatus({ ctx, opts, actor: gitActor(ctx) }),
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
    };
  }

  async #setStatus(
    ctx: TransitionContext,
    ticketId: string,
    status: TicketStatus,
    extra: Partial<ApplyStatusOptions> = {},
  ): Promise<void> {
    await applyTicketStatus({
      ctx,
      opts: { ticketId, status, ...extra },
      actor: gitActor(ctx),
    });
    await regenerateLog(ctx, ticketId).catch(() => {});
  }

  /** imported → spec-lint runs INLINE in the tick (CONDUCTOR "Runner
   *  tasks"; SCHEMAS §15 advisory score → tickets.spec_score +
   *  spec_scored event). */
  async #inlineSpecLint(
    ticket: TicketRow,
    ctx: TransitionContext,
  ): Promise<void> {
    const raw = await readOrNull(this.#ticketFile(ctx, ticket.ticket_id));
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
    const review = await readReviewJson(
      join(tools.ticketsRepoPath, 'tickets', id),
    );
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
      refs: [`tickets/${id}/${doc}`],
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

  /** Record the spec-completion hash (stale-spec baseline). */
  async #recordSpec(ctx: TransitionContext, id: string): Promise<void> {
    const ticketDir = join(ctx.ticketsRepoPath, 'tickets', id);
    await recordSpecHash(ticketDir);
    await commitAll(
      ctx.ticketsRepoPath,
      `conductor: ${id} spec_hash baseline`,
      gitActor(ctx),
    );
  }

  /** Implement-launch re-hash; stale → `stale-spec` inbox item and the
   *  ticket stays test-approved (never implements stale requirements). */
  async #staleSpecCheck(
    ticket: TicketRow,
    ctx: TransitionContext,
  ): Promise<boolean> {
    const ticketDir = join(ctx.ticketsRepoPath, 'tickets', ticket.ticket_id);
    if (!(await specIsStale(ticketDir))) return false;
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
   *  question_answered (+ question_autoaccepted for auto-skips). */
  async #emitQuestionAnswers(
    ticket: TicketRow,
    ctx: TransitionContext,
    gate: 'needs-info' | 'design-qa',
  ): Promise<void> {
    const ticketDir = join(ctx.ticketsRepoPath, 'tickets', ticket.ticket_id);
    const file = gate === 'needs-info' ? 'triage.json' : 'design.json';
    const raw = await readOrNull(join(ticketDir, file));
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

  /** Probe CARD-WRITTEN/PROBE-FAILED → persist the card snapshot into
   *  the tickets repo `.sprint-runner/cards/<repo>.json` (the durable
   *  copy; the live config card is the probe agent's own write). */
  async #persistCard(
    tools: TransitionTools,
    repo: string,
    verified: boolean,
  ): Promise<{ verified?: boolean } | null> {
    const repoCfg = this.#config.repos[repo];
    const repoPath = repoCfg?.path
      ? isAbsolute(repoCfg.path)
        ? repoCfg.path
        : resolve(tools.ticketsRepoPath, repoCfg.path)
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
    const dir = join(tools.ticketsRepoPath, '.sprint-runner', 'cards');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${repo}.json`),
      `${JSON.stringify(parsed, null, 2)}\n`,
      'utf8',
    );
    await commitAll(
      tools.ticketsRepoPath,
      `conductor: probe card ${repo} verified=${parsed.verified}`,
      gitActor(tools),
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
