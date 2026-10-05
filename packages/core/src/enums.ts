/**
 * Enums / string unions — the vocabulary of sprint-runner contracts.
 * Sources: SCHEMAS.md §1/§5-§7/§11-§13, CONDUCTOR.md sentinel table +
 * run lifecycle, DB-SCHEMA.md column comments, SETTINGS.md enums.
 */

// ---------- ticket frontmatter (SCHEMAS §1) ----------

export const TICKET_STATUSES = [
  'imported',
  'triage',
  'needs-info',
  'escalated',
  'wont-do',
  'ready',
  'prd-draft',
  'prd-review',
  'prd-approved',
  'design-qa',
  'tdd-draft',
  'tdd-review',
  'tdd-approved',
  'test-draft',
  'test-review',
  'test-approved',
  'in-progress',
  'review',
  'changes-requested',
  'approved',
  'pr-open',
  'ci-watch',
  'merged',
  'verifying',
  'verify_failed',
  'released',
  'reverted',
  'failed',
  'blocked',
  'aborted',
  'split',
  'discarded',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Terminal statuses (SCHEMAS §1). `split` is terminal for the parent —
 *  work continues through children. `merged` is NOT terminal — the
 *  verify→release stage runs after it (D27). */
export const TERMINAL_STATUSES = [
  'released',
  'reverted',
  'wont-do',
  'aborted',
  'split',
  'discarded',
] as const satisfies readonly TicketStatus[];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const TICKET_PRIORITIES = ['high', 'medium', 'low'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Spec-depth tiers (SCHEMAS §1, SETTINGS `spec_depth`). */
export const DEPTH_TIERS = ['light', 'standard', 'deep'] as const;
export type DepthTier = (typeof DEPTH_TIERS)[number];

export const BACKENDS = ['devin', 'aider', 'mock'] as const; // 'mock' is the test backend — never user-configured
export type Backend = (typeof BACKENDS)[number];

/** Backend execution runtime (D30): `container` = runs execute inside a
 *  per-subject docker container; `process` = detached OS process on the
 *  host. Declared per backend on CapabilityFlags, defaulted globally by
 *  SETTINGS `containers.runtime`, overridable per backend via
 *  `capabilities.<backend>.runtime`. */
export const RUNTIMES = ['container', 'process'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const PERMISSION_MODES = ['smart', 'bypass', 'accept-edits'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Gate profiles (SETTINGS `gates:`). */
export const GATE_MODES = ['full', 'plan-package', 'minimal'] as const;
export type GateMode = (typeof GATE_MODES)[number];

export const MERGE_STRATEGIES = ['squash', 'merge', 'rebase'] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

// ---------- stages / run kinds ----------

/** Run stages — prompts dir + timeouts keys + verify (CONDUCTOR "Runner
 *  tasks", SETTINGS `timeouts`). `review` runs execute per-pass. */
export const STAGES = [
  'interview',
  'import',
  'probe',
  'triage',
  'split',
  'prd',
  'design',
  'testplan',
  'implement',
  'review',
  'fix',
  'discuss',
  'ci-fix',
  'comment-fix',
  'rebase',
  'revert',
  'doc-repair',
  'escalate',
  'survey',
  'verify',
  /** Addendum stages (wp-131 freeze — prompt templates land with their
   *  owning wps; STAGE_TEMPLATES maps them to `null` until then):
   *  `release-notes` drafts the three-audience notes (DELIVERY §5),
   *  `retro` runs the release retrospective (DELIVERY §7), `extract`
   *  is the statement-extraction stage (wp-143), `mockup` +
   *  `design-ingest` are the design-artifact stages (wp-149). */
  'release-notes',
  'retro',
  'extract',
  'mockup',
  'design-ingest',
] as const;
export type Stage = (typeof STAGES)[number];

/** Stages that execute inside a repo and therefore require a verified
 *  repo card (CONDUCTOR "Repo-card rule"). */
export const REPO_EXECUTING_STAGES = [
  'implement',
  'fix',
  'ci-fix',
  'comment-fix',
  'rebase',
  'revert',
  'verify',
] as const satisfies readonly Stage[];

// ---------- sentinels (CONDUCTOR sentinel → transition table) ----------

/**
 * Every sentinel NAME a prompt can emit (the token before `:` — most
 * sentinels carry a payload after the colon, e.g. `NEEDS-INFO: <n>`).
 * `READY`, `PRD-WRITTEN`, `TDD-WRITTEN`, `TESTPLAN-WRITTEN`, `DONE`,
 * `CARD-WRITTEN`, `REPLIED`, `NEEDS-FIX-RUN`, `CI-FIXED`, `REBASED`,
 * `REVERT-READY`, `REPAIRED`, `ESCALATION-WRITTEN` take no payload.
 */
export const SENTINELS = [
  'INTERVIEW-QA',
  'TICKET-AUTHORED',
  'WONT-DRAFT',
  'IMPORTED',
  'IMPORT-FAILED',
  'CARD-WRITTEN',
  'PROBE-FAILED',
  'READY',
  'NEEDS-INFO',
  'ESCALATE',
  'SPLIT-PROPOSED',
  'UNSPLITTABLE',
  'PRD-WRITTEN',
  'DESIGN-QA',
  'TDD-WRITTEN',
  'TESTPLAN-WRITTEN',
  'DONE',
  'PASS-COMPLETE',
  'PASS-FAILED',
  'FIXES-COMPLETE',
  'REPLIED',
  'NEEDS-FIX-RUN',
  'CI-FIXED',
  'COMMENTS-PROCESSED',
  'REBASED',
  'REVERT-READY',
  'REPAIRED',
  'REPAIR-FAILED',
  'ESCALATION-WRITTEN',
  'SURVEY-COMPLETE',
  'SURVEY-FAILED',
  'BLOCKED',
] as const;
export type Sentinel = (typeof SENTINELS)[number];

// ---------- run lifecycle (DB-SCHEMA runs.status + CONDUCTOR lifecycle) ----------

/**
 * Run registry statuses. DB-SCHEMA lists
 * `pending|leased|running|paused|exited|validated|done|failed|killed|stalled`;
 * CONDUCTOR's lifecycle line additionally names `collecting`,
 * `committed`, and `blocked` — all are included so the union covers
 * both specs.
 */
export const RUN_STATUSES = [
  'pending',
  'leased',
  'running',
  'paused',
  'exited',
  'collecting',
  'validated',
  'committed',
  'done',
  'failed',
  'blocked',
  'killed',
  'stalled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** `containers.state` (DB-SCHEMA, D30) — lifecycle of the per-subject
 *  docker container. `created` = `docker create` done, never started;
 *  `removed` = torn down (row kept for audit). */
export const CONTAINER_STATES = [
  'created',
  'running',
  'stopped',
  'removed',
] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];

// ---------- events (SCHEMAS §7 — the `events` table, D29) ----------

export const EVENT_NAMES = [
  'imported',
  'status_changed',
  'run_started',
  'run_finished',
  'run_failed',
  'run_killed',
  'run_paused',
  'run_resumed',
  'commit',
  'question_asked',
  'question_answered',
  'question_autoaccepted',
  'doc_drafted',
  'doc_feedback',
  'doc_approved',
  'doc_repaired',
  'finding_created',
  'finding_fixed',
  'finding_dismissed',
  'fix_round_started',
  'gate_approved',
  'gate_overridden',
  'claimed',
  'unclaimed',
  'note_added',
  'pr_opened',
  'ci_failed',
  'ci_green',
  'teammate_comment',
  'comments_processed',
  'rebase_run',
  'merged',
  'reverted',
  'escalated',
  'blocked',
  'handoff',
  'resumed',
  'interview_started',
  'ticket_authored',
  'spec_scored',
  'split_proposed',
  'split_approved',
  'split_materialized',
  'survey_started',
  'survey_completed',
  'dossier_updated',
  'dossier_edited',
  'gap_reported',
  'doc_edited',
  'provenance_amended',
  'item_captured',
  'board_synthesized',
  'initiative_planned',
  'replanned',
  'reparented',
  'released',
  'verify_failed',
  'discarded',
  /** Delivery events (DELIVERY §5) + addendum-program events named by
   *  downstream tickets: wp-140 `changeset_*`, wp-141
   *  `baseline_reconciled`, wp-155 `model_transition`. Emitters land
   *  with their wps. */
  'merge_ready',
  'merge_attempted',
  'merge_conflict',
  'release_created',
  'release_items_changed',
  'manifest_cut',
  'release_approved',
  'release_released',
  'deployment_confirmed',
  'feature_exposed',
  'release_note_approved',
  'retro_completed',
  'correction_filed',
  'changeset_created',
  'changeset_decided',
  'changeset_applied',
  'changeset_verified',
  'baseline_reconciled',
  'model_transition',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const ACTOR_TYPES = ['agent', 'human', 'runner', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// ---------- review.json (SCHEMAS §6) ----------

export const FINDING_SEVERITIES = [
  'blocker',
  'major',
  'minor',
  'nit',
  'question',
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = [
  'open',
  'fixed',
  'reopened',
  'dismissed',
  'wontfix',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_CATEGORIES = [
  'correctness',
  'security',
  'perf',
  'style',
  'test-gap',
  'spec-deviation',
  /** Post-merge implementation-vs-approved-design comparison (§15.4,
   *  wp-149) — advisory, human-verdicted. */
  'design-drift',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** spec-bug = traced to spec ambiguity; code-bug = impl error (§6). */
export const FINDING_KINDS = ['spec-bug', 'code-bug'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const REVIEW_PASSES = [
  'correctness',
  'security',
  'spec-compliance',
  'test-gap',
] as const;
export type ReviewPass = (typeof REVIEW_PASSES)[number];

// ---------- triage.json (SCHEMAS §5) ----------

export const QUESTION_FORMATS = ['yesno', 'single', 'multi', 'text'] as const;
export type QuestionFormat = (typeof QUESTION_FORMATS)[number];

export const QUESTION_STATUSES = ['open', 'answered', 'skipped'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

// ---------- usage.json (SCHEMAS §13) ----------

export const USAGE_SOURCES = ['reported', 'partial', 'estimated'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** Per-call rows only ever carry reported|estimated (§13). */
export const CALL_USAGE_SOURCES = ['reported', 'estimated'] as const;
export type CallUsageSource = (typeof CALL_USAGE_SOURCES)[number];

export const USAGE_GRANULARITIES = ['per-call', 'run-aggregate'] as const;
export type UsageGranularity = (typeof USAGE_GRANULARITIES)[number];

// ---------- test-report.json / test plan (SCHEMAS §10, §4) ----------

export const TEST_RESULTS = ['pass', 'fail', 'skip'] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

export const TEST_CASE_TYPES = [
  'unit',
  'integration',
  'e2e',
  'manual',
] as const;
export type TestCaseType = (typeof TEST_CASE_TYPES)[number];

export const COVERAGE_KINDS = ['ac', 'file', 'workflow'] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

// ---------- eval results (wp-156 eval_runs/eval_cases/eval_results) ----------

export const EVAL_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

// ---------- gate items (DB-SCHEMA gate_items, CONDUCTOR gates) ----------

export const GATE_KINDS = [
  'question',
  'approval',
  'review',
  'failure',
  'escalation',
  'split-plan',
  'repair',
  'verify',
] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** Gate instance names (CONDUCTOR auto-advance gates + `merge` +
 *  `repair`, which can land on any status). */
export const GATE_NAMES = [
  'needs-info',
  'design-qa',
  'prd-review',
  'tdd-review',
  'test-review',
  'test-approved',
  'changes-requested',
  'split-plan',
  'escalated',
  'approved',
  'ci-watch',
  'merge',
  'repair',
  'verify-confirm',
  'uat',
  /** Merge-conflict gate item (DELIVERY §2 — a conflict surfaces a gate
   *  + a `rebase` run, never a silent force-push). Verbatim spec
   *  spelling: underscore, matching the `merge_conflict` event. */
  'merge_conflict',
] as const;
export type GateName = (typeof GATE_NAMES)[number];

// ---------- hierarchy + boards (D26/D27, DB-SCHEMA) ----------

export const BOARD_ITEM_KINDS = [
  'idea',
  'initiative',
  'feature',
  'ticket',
  'note',
  'zone',
  'feedback',
  'retro',
] as const;
export type BoardItemKind = (typeof BOARD_ITEM_KINDS)[number];

export const BOARD_ITEM_STATUSES = [
  'icebox',
  'active',
  'consumed',
  'frozen',
  'shipped',
  'discarded',
] as const;
export type BoardItemStatus = (typeof BOARD_ITEM_STATUSES)[number];

export const INITIATIVE_STATUSES = [
  'draft',
  'planned',
  'active',
  'shipped',
  'discarded',
] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

export const FEATURE_STATUSES = [
  'draft',
  'ready',
  'active',
  'done',
  'discarded',
] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/** doc_versions.doc — every persisted doc kind (DB-SCHEMA doc_versions).
 *  Addendum naming (wp-132, PRD §15.2): `rs.md` = Requirements
 *  Specification (was `prd.md`), `vs.md` = Verification Specification
 *  (was `test.md`); the 0001 migration renames existing rows. The old
 *  doc kinds are retired — nothing may write them. */
export const DOC_KINDS = [
  'ticket.md',
  'rs.md',
  'tdd.md',
  'vs.md',
  'feature.md',
  'ac.md',
  'provenance.json',
  'notes.md',
  /** Merge-enable flag per subject — the DoD-evaluated "merge button"
   *  doc (was tickets/<id>/merge.json; D29 → doc_versions). */
  'merge.json',
  /** Human DoD attestations for `manual` rows (was
   *  dod-attestations.json in the ticket dir). */
  'dod-attestations.json',
  /** Addendum doc kinds (adopted naming PRD §15.2):
   *  `solution-brief.md` sits between charter and RS on the Solution
   *  subject, `retro.md` is the release retrospective on a release
   *  subject, `notes-<audience>.md` carries release-note content per
   *  RELEASE_NOTE_AUDIENCES (DELIVERY §3), `mockup.json` is the
   *  structured component tree (§15.4), `briefing.json` is the
   *  knowledge-version diff briefing on session resume (§15.9),
   *  `contract.json` is the approved interface contract pinned in
   *  runs.request.baseline (wp-154), `adr.md` is a first-class
   *  versioned decision doc (§15.2). */
  'solution-brief.md',
  'retro.md',
  'notes-customer.md',
  'notes-stakeholder.md',
  'notes-technical.md',
  'mockup.json',
  'briefing.json',
  'contract.json',
  'adr.md',
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** run_artifacts.name — structured runner output (DB-SCHEMA). */
/** Names are conventional — `findings-<pass>.json` and
 *  `edit-session-<id>.jsonl` also land here (DB-SCHEMA run_artifacts). */
export const RUN_ARTIFACT_KINDS = [
  'triage.json',
  'review.json',
  'usage.json',
  'test-report.json',
  'sentinel',
  'pr-body.md',
  'split-plan.md',
  'proposed-diff.md',
  /** Addendum run output (wp-131): `contract.json` is the decompose
   *  run's interface-contract output (promoted to doc_versions on
   *  approval, wp-154); `design-system.json` is the ingestion run's
   *  extracted component-token bundle (wp-149); `statements.json` is
   *  the `extract` stage's statement batch (wp-143, SCHEMAS §22). */
  'contract.json',
  'design-system.json',
  'statements.json',
] as const;
export type RunArtifactKind = (typeof RUN_ARTIFACT_KINDS)[number];

// ---------- dossier / semantic layer (SCHEMAS §11-§12) ----------

export const DOSSIER_SCOPES = ['repo', 'product'] as const;
export type DossierScope = (typeof DOSSIER_SCOPES)[number];

export const DOSSIER_SECTIONS = [
  'architecture-map',
  'domain-model',
  'user-workflows',
  'personas',
  'docs-digest',
  'ui-map',
  'glossary',
  'landmines',
  'gap-report',
] as const;
export type DossierSection = (typeof DOSSIER_SECTIONS)[number];

export const DOSSIER_SOURCES = [
  'code',
  'docs',
  'screenshots',
  'crawl',
  'tickets',
  'analytics',
] as const;
export type DossierSource = (typeof DOSSIER_SOURCES)[number];

export const GAP_KINDS = [
  'undocumented-workflow',
  'doc-vs-code-contradiction',
  'untested-flow',
  'doc-rot',
  'dead-screen',
  'missing-persona-info',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/** SCHEMAS §12 kind list — includes the D37 evidence-plane kinds
 *  (requirement … incident) so stored entities can cite them. */
export const ENTITY_KINDS = [
  'entity',
  'workflow',
  'persona',
  'concept',
  'term',
  'screen',
  'requirement',
  'acceptance-criterion',
  'code-symbol',
  'test-case',
  'commit',
  'deployment',
  'error-signature',
  'incident',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_SOURCES = ['inferred', 'confirmed', 'imported'] as const;
export type EntitySource = (typeof ENTITY_SOURCES)[number];

/** SCHEMAS §12 predicate list — includes the D37 evidence-plane verbs
 *  (implements|verified-by|introduced-by|observed-in|resolved-by). */
export const RELATION_PREDICATES = [
  'part-of',
  'calls',
  'owned-by',
  'transitions-to',
  'depends-on',
  'synonym-of',
  'documents',
  'tests',
  'contradicts',
  'implements',
  'verified-by',
  'introduced-by',
  'observed-in',
  'resolved-by',
] as const;
export type RelationPredicate = (typeof RELATION_PREDICATES)[number];

/** Where a relation edge came from (DB-SCHEMA relations.source — D37
 *  distinguishes human-stated truth from model/tool inference). */
export const RELATION_SOURCES = ['explicit', 'human', 'model', 'tool'] as const;
export type RelationSource = (typeof RELATION_SOURCES)[number];

/** Verification state of an inferred edge (DB-SCHEMA
 *  relations.verification). */
export const RELATION_VERIFICATIONS = [
  'suggested',
  'auto-verified',
  'verified',
  'rejected',
] as const;
export type RelationVerification = (typeof RELATION_VERIFICATIONS)[number];

/** Taxonomies (SCHEMAS §12 controlled vocabularies). */
export const DEVIATION_REASON_KINDS = [
  'missing-file',
  'wrong-api',
  'spec-ambiguous',
  'upstream-change',
  'perf',
  'other',
] as const;
export type DeviationReasonKind = (typeof DEVIATION_REASON_KINDS)[number];

export const QUESTION_GATES = [
  'scope',
  'ac-clarification',
  'tech-choice',
  'integration',
  'data-model',
  'ux',
  'other',
] as const;
export type QuestionGate = (typeof QUESTION_GATES)[number];

// ---------- per-repo PR state (DB-SCHEMA ticket_repos) ----------

export const PR_STATES = ['open', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

export const CI_STATES = ['pending', 'green', 'failing'] as const;
export type CiState = (typeof CI_STATES)[number];

// =====================================================================
// Addendum contracts (wp-131 freeze) — PRD §15 / DELIVERY.md families.
// Spec text uses mixed separators; multiword enum VALUES normalize to
// hyphens here per the repo convention (`needs-info`, `test-gap`) —
// e.g. `awaiting_decision` → `awaiting-decision`, `depends_on` →
// `depends-on`. Event names keep underscores (existing EVENT_NAMES
// convention). Deliberate resolutions are cataloged in DB-SCHEMA +
// SCHEMAS §20.
// =====================================================================

// ---------- releases / delivery (DELIVERY §3) ----------

/** Release lifecycle (DELIVERY §3). `released` flips member tickets
 *  transactionally; `closed` after the retrospective; `abandoned` is
 *  terminal. */
export const RELEASE_STATUSES = [
  'draft',
  'ready',
  'approved',
  'released',
  'closed',
  'abandoned',
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/** Delivery dimension (DELIVERY §1) — materialized on release_items.
 *  `approved ≠ merged ≠ deployed ≠ released`: a feature is *available*
 *  only when feature_exposure says so. */
export const DELIVERY_STATES = [
  'planned',
  'released',
  'deployed',
  'exposed',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const RELEASE_ITEM_KINDS = ['feature', 'ticket'] as const;
export type ReleaseItemKind = (typeof RELEASE_ITEM_KINDS)[number];

/** release_notes.audience — the three-audience notes set (DELIVERY §3,
 *  PRD §15.6). Content lives in doc_versions (`notes-<audience>.md`). */
export const RELEASE_NOTE_AUDIENCES = [
  'customer',
  'stakeholder',
  'technical',
] as const;
export type ReleaseNoteAudience = (typeof RELEASE_NOTE_AUDIENCES)[number];

/** release_approvals.decision — approval binds to manifest digest
 *  (DELIVERY invariant 3). */
export const RELEASE_APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type ReleaseApprovalDecision =
  (typeof RELEASE_APPROVAL_DECISIONS)[number];

/** release_gate_results.result — a waived gate records the waiver in
 *  `evidence`; the row is append-only audit. */
export const RELEASE_GATE_VERDICTS = ['pass', 'fail', 'waived'] as const;
export type ReleaseGateVerdict = (typeof RELEASE_GATE_VERDICTS)[number];

/** deployments.evidence.type — MVP is manual-only; `webhook`/`probe`
 *  are reserved slots for automated confirmation (DELIVERY §3). */
export const DEPLOY_EVIDENCE_TYPES = ['manual', 'webhook', 'probe'] as const;
export type DeployEvidenceType = (typeof DEPLOY_EVIDENCE_TYPES)[number];

/** feature_exposure.state — `available` requires a linked deployment
 *  (DELIVERY invariant 4). */
export const FEATURE_EXPOSURE_STATES = [
  'hidden',
  'limited',
  'available',
] as const;
export type FeatureExposureState = (typeof FEATURE_EXPOSURE_STATES)[number];

// ---------- changesets (PRD §15.5, wp-140) ----------

/** ChangeSet lifecycle: `draft → analyzing → awaiting-decision →
 *  approved|deferred|rejected → applying → verified`. `apply-failed`
 *  parks a partially-applied set visibly; `abandoned` retires a draft. */
export const CHANGESET_STATUSES = [
  'draft',
  'analyzing',
  'awaiting-decision',
  'approved',
  'deferred',
  'rejected',
  'applying',
  'apply-failed',
  'verified',
  'abandoned',
] as const;
export type ChangesetStatus = (typeof CHANGESET_STATUSES)[number];

/** Change categories (PRD §15.5) — handled differently per type. */
export const CHANGESET_CLASSIFICATIONS = [
  'clarification',
  'correction',
  'addition',
  'modification',
  'removal',
] as const;
export type ChangesetClassification =
  (typeof CHANGESET_CLASSIFICATIONS)[number];

/** Decision options — richer than approve/reject (PRD §15.5): each
 *  carries its consequence into affected releases. */
export const CHANGESET_DECISIONS = [
  'add-now',
  'swap-scope',
  'next-release',
  'decline',
] as const;
export type ChangesetDecision = (typeof CHANGESET_DECISIONS)[number];

/** changeset_items.status — apply is transactional where possible and
 *  partial application stays visible (PRD §15.5). */
export const CHANGESET_ITEM_STATUSES = [
  'pending',
  'applied',
  'skipped',
  'failed',
] as const;
export type ChangesetItemStatus = (typeof CHANGESET_ITEM_STATUSES)[number];

// ---------- statement ledger (PRD §15.3/§15.9, wp-143) ----------

/** semantic_statements.intent — the assertion's illocution. `prohibits`
 *  and `requires` are the binding-authority intents (an approved
 *  prohibition beats a brainstormed `want` — §15.3 authority rule). */
export const STATEMENT_INTENTS = [
  'want',
  'avoid',
  'prohibits',
  'requires',
  'constraint',
  'assumption',
  'decision',
  'question',
  'problem',
  'observation',
] as const;
export type StatementIntent = (typeof STATEMENT_INTENTS)[number];

/** Negations/qualifiers must survive extraction (§15.9 eval gate). */
export const STATEMENT_POLARITIES = ['affirm', 'negate'] as const;
export type StatementPolarity = (typeof STATEMENT_POLARITIES)[number];

/** Binding strength — mirrors the note `importance` scale (§15.3). */
export const STATEMENT_STRENGTHS = [
  'must',
  'should',
  'nice',
  'undecided',
] as const;
export type StatementStrength = (typeof STATEMENT_STRENGTHS)[number];

/** Scoped-knowledge levels (§15.9 "org/solution/initiative/feature/repo
 *  with controlled promotion") + the `ticket`/`board` leaf levels the
 *  ledger attaches to. */
export const STATEMENT_SCOPES = [
  'org',
  'solution',
  'initiative',
  'feature',
  'repo',
  'ticket',
  'board',
] as const;
export type StatementScope = (typeof STATEMENT_SCOPES)[number];

/** semantic_statements.status — AI proposes, humans confirm the
 *  consequential ones; `disputed` routes to statement_decisions
 *  (never a silent merge, §15.9). */
export const STATEMENT_STATUSES = [
  'proposed',
  'confirmed',
  'disputed',
  'superseded',
  'rejected',
] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

/** statement_relationships.predicate (§15.3). */
export const STATEMENT_RELATIONS = [
  'supports',
  'contradicts',
  'clarifies',
  'duplicates',
  'depends-on',
  'supersedes',
  'derived-from',
] as const;
export type StatementRelation = (typeof STATEMENT_RELATIONS)[number];

/** statement_decisions.status. */
export const STATEMENT_DECISION_STATUSES = [
  'open',
  'decided',
  'dismissed',
] as const;
export type StatementDecisionStatus =
  (typeof STATEMENT_DECISION_STATUSES)[number];

/** Provenance tri-state on requirements/items (wp-139) — `inferred`
 *  never auto-approves. */
export const PROVENANCE_STATES = [
  'inferred',
  'source-backed',
  'stakeholder-verified',
] as const;
export type ProvenanceState = (typeof PROVENANCE_STATES)[number];

/** semantic_statements.source_ref.kind — the evidence kind a statement
 *  was extracted from (wp-143). `manual` = directly authored (no
 *  extraction run). */
export const STATEMENT_SOURCE_KINDS = [
  'board-item',
  'interview-message',
  'import',
  'doc',
  'manual',
] as const;
export type StatementSourceKind = (typeof STATEMENT_SOURCE_KINDS)[number];

// ---------- interview orchestrator (PRD §15.9, wp-145) ----------

/** knowledge_slots.state — versioned wizard defs declare required
 *  slots; the planner asks only what materially changes the outcome. */
export const KNOWLEDGE_SLOT_STATES = [
  'known',
  'inferred',
  'missing',
  'conflicted',
  'not-applicable',
  'deferred',
] as const;
export type KnowledgeSlotState = (typeof KNOWLEDGE_SLOT_STATES)[number];

export const INTERVIEW_SESSION_STATUSES = [
  'active',
  'paused',
  'completed',
  'abandoned',
] as const;
export type InterviewSessionStatus =
  (typeof INTERVIEW_SESSION_STATUSES)[number];

/** Specialist branches merge statements preserving attribution (§15.9). */
export const INTERVIEW_BRANCH_STATUSES = [
  'active',
  'merged',
  'abandoned',
] as const;
export type InterviewBranchStatus = (typeof INTERVIEW_BRANCH_STATUSES)[number];

/** Three input modes, switchable without loss (§15.9). */
export const INTERVIEW_MODES = ['conversation', 'guided', 'bulk'] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export const INTERVIEW_MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type InterviewMessageRole = (typeof INTERVIEW_MESSAGE_ROLES)[number];

/** question_candidates.status — `unanswerable` is a first-class
 *  outcome: route/record/mark unresolved, never re-ask (§15.9). */
export const QUESTION_CANDIDATE_STATUSES = [
  'proposed',
  'asked',
  'answered',
  'skipped',
  'unanswerable',
] as const;
export type QuestionCandidateStatus =
  (typeof QUESTION_CANDIDATE_STATUSES)[number];

// ---------- review studio (PRD §15.8, wp-148/150) ----------

/** Materialized headline state of a review session (the verdict is the
 *  latest review_decisions row; this column is the queryable rollup). */
export const REVIEW_SESSION_STATUSES = [
  'open',
  'approved',
  'changes-requested',
  'closed',
] as const;
export type ReviewSessionStatus = (typeof REVIEW_SESSION_STATUSES)[number];

/** review_findings lifecycle (§15.8): `open → triaged → in-remediation
 *  → ready-for-verification → resolved` + permissioned terminal
 *  dispositions (rationale required on the resolution row). */
export const REVIEW_FINDING_STATUSES = [
  'open',
  'triaged',
  'in-remediation',
  'ready-for-verification',
  'resolved',
  'accepted-risk',
  'not-applicable',
  'duplicate',
  'deferred-with-approval',
] as const;
export type ReviewFindingStatus = (typeof REVIEW_FINDING_STATUSES)[number];

/** Semantic comment types (§15.8). `out-of-scope` routes to change
 *  control — a comment is an instruction, not authorization. */
export const REVIEW_COMMENT_TYPES = [
  'defect',
  'requirement-gap',
  'security',
  'architecture',
  'improvement',
  'question',
  'preference',
  'out-of-scope',
  'praise',
] as const;
export type ReviewCommentType = (typeof REVIEW_COMMENT_TYPES)[number];

export const REVIEW_COMMENT_DISPOSITIONS = [
  'must-fix',
  'suggestion',
  'question',
  'informational',
] as const;
export type ReviewCommentDisposition =
  (typeof REVIEW_COMMENT_DISPOSITIONS)[number];

/** review_decisions.action — the five reviewer actions (§15.8);
 *  decisions bind to head SHA + spec baseline. */
export const REVIEW_ACTIONS = [
  'approve',
  'comment',
  'request-fix',
  'request-changes',
  'send-to-board',
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** review_findings.security_category (§15.8 security dimension, wp-150). */
export const SECURITY_CATEGORIES = [
  'access-control',
  'injection',
  'secrets',
  'data-exposure',
  'unsafe-deps',
  'prompt-injection',
  'insecure-defaults',
] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];

// ---------- ticket taxonomy (PRD §15.7/§15.10, wp-151/154) ----------

/** tickets.work_type — a separate dimension from origin (§15.7). */
export const TICKET_WORK_TYPES = [
  'story',
  'bug',
  'technical',
  'spike',
  'security',
  'infrastructure',
  'data',
  'documentation',
  'quality',
] as const;
export type TicketWorkType = (typeof TICKET_WORK_TYPES)[number];

/** tickets.origin — where the work entered. `correction` = post-merge
 *  defect ticket (DELIVERY §2); `rs` = authored from an approved
 *  requirements spec. */
export const TICKET_ORIGINS = [
  'rs',
  'board',
  'review',
  'incident',
  'ai-finding',
  'correction',
  'manual',
] as const;
export type TicketOrigin = (typeof TICKET_ORIGINS)[number];

/** tickets.severity — Priority ≠ severity (§15.7); set on
 *  bugs/incidents. */
export const TICKET_SEVERITIES = [
  'blocker',
  'critical',
  'major',
  'minor',
  'trivial',
] as const;
export type TicketSeverity = (typeof TICKET_SEVERITIES)[number];

/** tickets.execution_readiness — DoR-evaluated readiness (wp-153/154);
 *  `blocked` names failing checks via gate items, never silently. */
export const EXECUTION_READINESSES = [
  'unassessed',
  'incomplete',
  'ready',
  'blocked',
] as const;
export type ExecutionReadiness = (typeof EXECUTION_READINESSES)[number];

/** tickets.parallel_safety — decomposition verdict (wp-154):
 *  `exclusive` = never runs alongside other ticket executions. */
export const PARALLEL_SAFETIES = [
  'unknown',
  'safe',
  'caution',
  'exclusive',
] as const;
export type ParallelSafety = (typeof PARALLEL_SAFETIES)[number];

// ---------- boards v2 (PRD §15.3, wp-144/139) ----------

/** boards.board_type — board types are config, not pipelines (§15.3). */
export const BOARD_TYPES = [
  'new-project',
  'import',
  'enhancement',
  'modernization',
  'quality',
  'feedback',
  'release-planning',
  'exploration',
] as const;
export type BoardType = (typeof BOARD_TYPES)[number];

/** boards.status — deferred boards keep all evidence and may
 *  resurface (§15.3 "deferred ideas never die"). */
export const BOARD_STATUSES = [
  'draft',
  'discovery',
  'proposal-ready',
  'approved',
  'deferred',
  'archived',
] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

/** board_items.note_kind — the typed-sticky taxonomy layered on top of
 *  `kind` (§15.3): idea|want|avoid|problem|constraint|question|decision|
 *  feedback. */
export const NOTE_KINDS = [
  'idea',
  'want',
  'avoid',
  'problem',
  'constraint',
  'question',
  'decision',
  'feedback',
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_IMPORTANCES = [
  'must',
  'should',
  'nice',
  'undecided',
] as const;
export type NoteImportance = (typeof NOTE_IMPORTANCES)[number];

/** board_items.note_status — a note's own lightweight lifecycle
 *  (`deferred`/`resurfaced` serve "deferred ideas never die"). */
export const NOTE_STATUSES = [
  'open',
  'deferred',
  'resurfaced',
  'resolved',
  'dropped',
] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

// ---------- process machinery (PRD §15.10, wp-153/149) ----------

/** assumptions.status — auto-captured when work depends on unverified
 *  info; high-impact unverified assumptions gate or get risk-accepted. */
export const ASSUMPTION_STATUSES = [
  'unverified',
  'verified',
  'invalidated',
  'risk-accepted',
] as const;
export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number];

/** quality_debt.kind — the register's categories (§15.10). */
export const QUALITY_DEBT_KINDS = [
  'accepted-risk',
  'deferred-refactor',
  'security-exception',
  'weak-tests',
  'doc-gap',
  'other',
] as const;
export type QualityDebtKind = (typeof QUALITY_DEBT_KINDS)[number];

/** quality_debt.status — exceptions `expired` loudly (wp-153). */
export const QUALITY_DEBT_STATUSES = [
  'open',
  'acknowledged',
  'resolved',
  'expired',
  'consolidated',
] as const;
export type QualityDebtStatus = (typeof QUALITY_DEBT_STATUSES)[number];

/** delivery_commitments.status — planned ≠ committed ≠ implemented ≠
 *  verified ≠ delivered (§15.6). */
export const DELIVERY_COMMITMENT_STATUSES = [
  'planned',
  'committed',
  'implemented',
  'verified',
  'delivered',
  'missed',
  'cancelled',
] as const;
export type DeliveryCommitmentStatus =
  (typeof DELIVERY_COMMITMENT_STATUSES)[number];

/** design_approvals.status — approval binds to a mockup revision; a
 *  material component change invalidates only affected approvals
 *  (§15.4, wp-149). */
export const DESIGN_APPROVAL_STATUSES = [
  'approved',
  'invalidated',
  'superseded',
] as const;
export type DesignApprovalStatus = (typeof DESIGN_APPROVAL_STATUSES)[number];

// ---------- design artifacts / mockups (PRD §15.4, wp-149) ----------

/** mockup.json fidelity tiers — cheapest that answers the current
 *  question (§15.4): `wireframe` → `hi-fi` → `prototype`. */
export const MOCKUP_FIDELITIES = ['wireframe', 'hi-fi', 'prototype'] as const;
export type MockupFidelity = (typeof MOCKUP_FIDELITIES)[number];

/** Screen states a mockup covers. `default` is the resting screen; the
 *  rest are the state-generator variants (§15.4) — `loading`, `empty`,
 *  `success`, `error`, `permission`. */
export const MOCKUP_STATES = [
  'default',
  'loading',
  'empty',
  'success',
  'error',
  'permission',
] as const;
export type MockupState = (typeof MOCKUP_STATES)[number];

/** Responsive variants a component tree can carry (§15.4). */
export const MOCKUP_BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;
export type MockupBreakpoint = (typeof MOCKUP_BREAKPOINTS)[number];

/** Design-approval checklist items (§15.4): desktop, mobile, flows,
 *  error/empty states, accessibility, linked ACs. */
export const DESIGN_CHECKLIST_ITEMS = [
  'desktop',
  'mobile',
  'flows',
  'error-empty',
  'a11y',
  'linked-acs',
] as const;
export type DesignChecklistItem = (typeof DESIGN_CHECKLIST_ITEMS)[number];

/** Generator modes for the `mockup` stage (§15.4): author a tree from
 *  scratch, ingest a screenshot, ingest a sketch, or expand a screen
 *  into state variants. */
export const MOCKUP_GENERATOR_MODES = [
  'compose',
  'screenshot',
  'sketch',
  'states',
] as const;
export type MockupGeneratorMode = (typeof MOCKUP_GENERATOR_MODES)[number];

/** Design-drift finding category (§15.4) — post-merge implementation
 *  vs approved-mockup comparison. Advisory only: a machine never
 *  resolves it; a human verdict (the normal finding lifecycle) is
 *  required. */
export const DESIGN_DRIFT_CATEGORY = 'design-drift' as const;

// ---------- model routing (PRD §15.12, wp-155) ----------

/** Latency classes drive provider sort + prompt budgets (§15.12):
 *  `instant` = no LLM on path, `interactive` = streamed ~1s TTFT,
 *  `background` = quality-adjusted cost. */
export const LATENCY_CLASSES = [
  'instant',
  'interactive',
  'background',
] as const;
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

/** Which precedence layer supplied a run's pinned model (SCHEMAS §21
 *  RouteDecision.source) — audit field persisted on `runs.request`
 *  and surfaced in `model_transition` events (wp-155). */
export const ROUTE_DECISION_SOURCES = [
  'request',
  'ticket',
  'registry',
  'legacy',
  'default',
  'backend',
] as const;
export type RouteDecisionSource = (typeof ROUTE_DECISION_SOURCES)[number];
