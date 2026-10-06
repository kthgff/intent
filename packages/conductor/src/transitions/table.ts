/**
 * transitions/table.ts — CONDUCTOR.md "Sentinel → transition table",
 * encoded as DATA (wp-031). Adding a sentinel row changes behavior
 * without a code edit: dispatch looks up (stage, sentinel, payload)
 * and runs the named action.
 *
 * Every row of the spec table appears here exactly once; `spec` is the
 * spec anchor string the coverage test asserts. `when` narrows a row
 * on the sentinel payload (`ESCALATE: needs split` vs `ESCALATE: <other>`).
 * The catch-all `*` stage row implements "any | BLOCKED: <r>".
 */
import type { Sentinel, Stage } from '@sprint-runner/core';

/** Action identifiers — the `do` column. One implementation per id in
 *  `RealTransitionHandler.#actions`. */
export type ActionId =
  | 'interviewQuestions'
  | 'ticketAuthored'
  | 'wontDraft'
  | 'importCommitted'
  | 'importFailed'
  | 'cardPersist'
  | 'probeFailed'
  | 'triageReady'
  | 'triageNeedsInfo'
  | 'queueSplitRun'
  | 'toEscalated'
  | 'splitProposed'
  | 'prdReview'
  | 'designQa'
  | 'tddReview'
  | 'testplanReview'
  | 'implementDone'
  | 'verifyDone'
  | 'reviewPassComplete'
  | 'reviewPassFailed'
  | 'fixesComplete'
  | 'discussReplied'
  | 'needsFixRun'
  | 'pushToCiWatch'
  | 'commentsProcessed'
  | 'rebased'
  | 'revertReady'
  | 'docRepaired'
  | 'docRepairFailed'
  | 'escalationWritten'
  | 'surveyComplete'
  | 'surveyFailed'
  | 'editProposed'
  | 'editClarify'
  | 'editRefused'
  | 'notesDrafted'
  | 'retroDone'
  | 'toBlocked';

export interface TableRow {
  /** Run stage the sentinel was emitted by; `'*'` = any stage. */
  stage: Stage | '*';
  sentinel: Sentinel;
  /** Optional payload predicate — the row matches only when it returns
   *  true (ESCALATE forking, `needs split` vs `<other>`). */
  when?: (payload: string) => boolean;
  action: ActionId;
  /** The CONDUCTOR.md table cell this row implements (coverage test). */
  spec: string;
}

export const TRANSITION_TABLE: readonly TableRow[] = [
  // -- interview --
  {
    stage: 'interview',
    sentinel: 'INTERVIEW-QA',
    action: 'interviewQuestions',
    spec: 'interview | INTERVIEW-QA: <n> | question gate item on the interview subject; re-run on answers',
  },
  {
    stage: 'interview',
    sentinel: 'TICKET-AUTHORED',
    action: 'ticketAuthored',
    spec: 'interview | TICKET-AUTHORED: <id> | commit tickets/<id>/ → imported',
  },
  {
    stage: 'interview',
    sentinel: 'WONT-DRAFT',
    action: 'wontDraft',
    spec: 'interview | WONT-DRAFT: <r> | burn the reserved id, notify',
  },
  // -- chat-to-edit (interview edit mode — API.md, s-01 D25) --
  {
    stage: 'interview',
    sentinel: 'EDIT-PROPOSED',
    action: 'editProposed',
    spec: 'interview(edit) | EDIT-PROPOSED | approval gate item with the proposed diff (proposed-diff.md)',
  },
  {
    stage: 'interview',
    sentinel: 'EDIT-CLARIFY',
    action: 'editClarify',
    spec: 'interview(edit) | EDIT-CLARIFY: <q> | question gate item on the edit session',
  },
  {
    stage: 'interview',
    sentinel: 'EDIT-REFUSED',
    action: 'editRefused',
    spec: 'interview(edit) | EDIT-REFUSED: <r> | failure gate item — the run declined the edit',
  },
  // -- import --
  {
    stage: 'import',
    sentinel: 'IMPORTED',
    action: 'importCommitted',
    spec: 'import | IMPORTED: <n> | commit ticket folders, each → imported',
  },
  {
    stage: 'import',
    sentinel: 'IMPORT-FAILED',
    action: 'importFailed',
    spec: 'import | IMPORT-FAILED: <r> | failure inbox item',
  },
  // -- probe --
  {
    stage: 'probe',
    sentinel: 'CARD-WRITTEN',
    action: 'cardPersist',
    spec: "probe | CARD-WRITTEN | persist card (verified per probe's own report)",
  },
  {
    stage: 'probe',
    sentinel: 'PROBE-FAILED',
    action: 'probeFailed',
    spec: 'probe | PROBE-FAILED: <r> | card verified: false + inbox item',
  },
  // -- triage --
  {
    stage: 'triage',
    sentinel: 'READY',
    action: 'triageReady',
    spec: 'triage | READY | apply suggestions → ready → auto prd-draft',
  },
  {
    stage: 'triage',
    sentinel: 'NEEDS-INFO',
    action: 'triageNeedsInfo',
    spec: 'triage | NEEDS-INFO: <n> | → needs-info + question gate',
  },
  {
    stage: 'triage',
    sentinel: 'ESCALATE',
    when: (p) => /needs split/i.test(p),
    action: 'queueSplitRun',
    spec: 'triage | ESCALATE: needs split | queue split run',
  },
  {
    stage: 'triage',
    sentinel: 'ESCALATE',
    action: 'toEscalated',
    spec: 'triage | ESCALATE: <other> | → escalated',
  },
  // -- split --
  {
    stage: 'split',
    sentinel: 'SPLIT-PROPOSED',
    action: 'splitProposed',
    spec: 'split | SPLIT-PROPOSED: <n> | commit split-plan.md + children/ drafts → split-plan gate',
  },
  {
    stage: 'split',
    sentinel: 'UNSPLITTABLE',
    action: 'toEscalated',
    spec: 'split | UNSPLITTABLE: <r> | → escalated',
  },
  // -- prd --
  {
    stage: 'prd',
    sentinel: 'PRD-WRITTEN',
    action: 'prdReview',
    spec: 'prd | PRD-WRITTEN | → prd-review gate',
  },
  // -- design --
  {
    stage: 'design',
    sentinel: 'DESIGN-QA',
    action: 'designQa',
    spec: 'design | DESIGN-QA: <n> | → design-qa + question gate; re-run on answers',
  },
  {
    stage: 'design',
    sentinel: 'TDD-WRITTEN',
    action: 'tddReview',
    spec: 'design | TDD-WRITTEN | → tdd-review gate',
  },
  // -- testplan --
  {
    stage: 'testplan',
    sentinel: 'TESTPLAN-WRITTEN',
    action: 'testplanReview',
    spec: 'testplan | TESTPLAN-WRITTEN | coverage-matrix lint (fail-closed) → test-review gate',
  },
  // -- doc stages ESCALATE (prd/design/testplan/split share the row) --
  {
    stage: 'prd',
    sentinel: 'ESCALATE',
    action: 'toEscalated',
    spec: 'doc stages | ESCALATE: <r> | → escalated',
  },
  {
    stage: 'design',
    sentinel: 'ESCALATE',
    action: 'toEscalated',
    spec: 'doc stages | ESCALATE: <r> | → escalated',
  },
  {
    stage: 'testplan',
    sentinel: 'ESCALATE',
    action: 'toEscalated',
    spec: 'doc stages | ESCALATE: <r> | → escalated',
  },
  {
    stage: 'split',
    sentinel: 'ESCALATE',
    action: 'toEscalated',
    spec: 'doc stages | ESCALATE: <r> | → escalated',
  },
  // -- implement --
  {
    stage: 'implement',
    sentinel: 'DONE',
    action: 'implementDone',
    spec: 'implement | DONE | verify task (test-report.json) → 4 review passes → review',
  },
  // -- verify (runner task between implement DONE and review passes) --
  {
    stage: 'verify',
    sentinel: 'DONE',
    action: 'verifyDone',
    spec: 'implement | DONE | verify task → 4 review passes → review (verify leg)',
  },
  // -- review passes --
  {
    stage: 'review',
    sentinel: 'PASS-COMPLETE',
    action: 'reviewPassComplete',
    spec: 'review pass | PASS-COMPLETE: <n> | merge findings → fix run (≤auto_fix_rounds) or changes-requested gate',
  },
  {
    stage: 'review',
    sentinel: 'PASS-FAILED',
    action: 'reviewPassFailed',
    spec: 'review pass | PASS-FAILED: <r> | run_failed → retry ladder',
  },
  // -- fix --
  {
    stage: 'fix',
    sentinel: 'FIXES-COMPLETE',
    action: 'fixesComplete',
    spec: 'fix | FIXES-COMPLETE: <f>/<t> | full re-review round',
  },
  // -- discuss --
  {
    stage: 'discuss',
    sentinel: 'REPLIED',
    action: 'discussReplied',
    spec: 'discuss | REPLIED | append reply to the thread',
  },
  {
    stage: 'discuss',
    sentinel: 'NEEDS-FIX-RUN',
    action: 'needsFixRun',
    spec: 'discuss | NEEDS-FIX-RUN | queue fix run',
  },
  // -- shepherd stages --
  {
    stage: 'ci-fix',
    sentinel: 'CI-FIXED',
    action: 'pushToCiWatch',
    spec: 'ci-fix | CI-FIXED | push → ci-watch',
  },
  {
    stage: 'comment-fix',
    sentinel: 'COMMENTS-PROCESSED',
    action: 'commentsProcessed',
    spec: 'comment-fix | COMMENTS-PROCESSED: <a>/<t> | push commits + post replies → ci-watch',
  },
  {
    stage: 'rebase',
    sentinel: 'REBASED',
    action: 'rebased',
    spec: 'rebase | REBASED | force-push → ci-watch',
  },
  {
    stage: 'revert',
    sentinel: 'REVERT-READY',
    action: 'revertReady',
    spec: 'revert | REVERT-READY | push + open revert PR → ci-watch; on merge → reverted',
  },
  // -- doc-repair --
  {
    stage: 'doc-repair',
    sentinel: 'REPAIRED',
    action: 'docRepaired',
    spec: 'doc-repair | REPAIRED | re-lint → resume the interrupted transition',
  },
  {
    stage: 'doc-repair',
    sentinel: 'REPAIR-FAILED',
    action: 'docRepairFailed',
    spec: 'doc-repair | REPAIR-FAILED: <r> | repair gate item (doc-repair-needed)',
  },
  // -- escalate --
  {
    stage: 'escalate',
    sentinel: 'ESCALATION-WRITTEN',
    action: 'escalationWritten',
    spec: 'escalate | ESCALATION-WRITTEN | → escalated',
  },
  // -- survey --
  {
    stage: 'survey',
    sentinel: 'SURVEY-COMPLETE',
    action: 'surveyComplete',
    spec: 'survey | SURVEY-COMPLETE: <n> | dossier + semantic rows → DB (dossier_updated)',
  },
  {
    stage: 'survey',
    sentinel: 'SURVEY-FAILED',
    action: 'surveyFailed',
    spec: 'survey | SURVEY-FAILED: <r> | failure inbox item',
  },
  // -- release-notes / retro (wp-135, DELIVERY §5/§7) --
  {
    stage: 'release-notes',
    sentinel: 'DONE',
    action: 'notesDrafted',
    spec: 'release-notes | DONE | notes-<audience>.md drafts registered; human approves per audience',
  },
  {
    stage: 'retro',
    sentinel: 'DONE',
    action: 'retroDone',
    spec: 'retro | DONE | retro.md + draft board proposals → retro_completed (never commits scope)',
  },
  // -- catch-all --
  {
    stage: '*',
    sentinel: 'BLOCKED',
    action: 'toBlocked',
    spec: 'any | BLOCKED: <r> | → blocked + blocked_reason',
  },
];
