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

/** doc_versions.doc — every persisted doc kind (DB-SCHEMA doc_versions). */
export const DOC_KINDS = [
  'ticket.md',
  'prd.md',
  'tdd.md',
  'test.md',
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

export const ENTITY_KINDS = [
  'entity',
  'workflow',
  'persona',
  'concept',
  'term',
  'screen',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_SOURCES = ['inferred', 'confirmed', 'imported'] as const;
export type EntitySource = (typeof ENTITY_SOURCES)[number];

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
