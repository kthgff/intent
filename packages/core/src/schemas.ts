/**
 * zod schemas for every structured artifact in SCHEMAS.md.
 * Fail-closed: runners parse with `.strict()`-grade discipline — unknown
 * structured output blocks the pipeline rather than guessing (AGENTS.md).
 */
import { z } from 'zod';
import {
  ACTOR_TYPES,
  ASSUMPTION_STATUSES,
  BACKENDS,
  BOARD_ITEM_KINDS,
  BOARD_ITEM_STATUSES,
  BOARD_STATUSES,
  BOARD_TYPES,
  CALL_USAGE_SOURCES,
  CHANGESET_CLASSIFICATIONS,
  CHANGESET_DECISIONS,
  CHANGESET_ITEM_STATUSES,
  CHANGESET_STATUSES,
  CI_STATES,
  CONTAINER_STATES,
  COVERAGE_KINDS,
  DELIVERY_COMMITMENT_STATUSES,
  DELIVERY_STATES,
  DEPLOY_EVIDENCE_TYPES,
  DEPTH_TIERS,
  DESIGN_APPROVAL_STATUSES,
  DEVIATION_REASON_KINDS,
  DOC_KINDS,
  DOSSIER_SCOPES,
  DOSSIER_SECTIONS,
  DOSSIER_SOURCES,
  ENTITY_KINDS,
  ENTITY_SOURCES,
  EVAL_RUN_STATUSES,
  EVENT_NAMES,
  EXECUTION_READINESSES,
  FEATURE_EXPOSURE_STATES,
  FEATURE_STATUSES,
  FINDING_CATEGORIES,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  GAP_KINDS,
  GATE_KINDS,
  INITIATIVE_STATUSES,
  INTERVIEW_BRANCH_STATUSES,
  INTERVIEW_MESSAGE_ROLES,
  INTERVIEW_MODES,
  INTERVIEW_SESSION_STATUSES,
  KNOWLEDGE_SLOT_STATES,
  LATENCY_CLASSES,
  NOTE_IMPORTANCES,
  NOTE_KINDS,
  NOTE_STATUSES,
  PARALLEL_SAFETIES,
  PROVENANCE_STATES,
  PR_STATES,
  QUALITY_DEBT_KINDS,
  QUALITY_DEBT_STATUSES,
  QUESTION_CANDIDATE_STATUSES,
  QUESTION_FORMATS,
  QUESTION_STATUSES,
  RELATION_PREDICATES,
  RELATION_SOURCES,
  RELATION_VERIFICATIONS,
  RELEASE_APPROVAL_DECISIONS,
  RELEASE_GATE_VERDICTS,
  RELEASE_ITEM_KINDS,
  RELEASE_NOTE_AUDIENCES,
  RELEASE_STATUSES,
  REVIEW_ACTIONS,
  REVIEW_COMMENT_DISPOSITIONS,
  REVIEW_COMMENT_TYPES,
  REVIEW_FINDING_STATUSES,
  REVIEW_SESSION_STATUSES,
  RUN_STATUSES,
  SECURITY_CATEGORIES,
  SENTINELS,
  STATEMENT_DECISION_STATUSES,
  STATEMENT_INTENTS,
  STATEMENT_POLARITIES,
  STATEMENT_RELATIONS,
  STATEMENT_SCOPES,
  STATEMENT_STATUSES,
  STATEMENT_STRENGTHS,
  TEST_CASE_TYPES,
  TEST_RESULTS,
  TICKET_ORIGINS,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  TICKET_STATUSES,
  TICKET_WORK_TYPES,
  USAGE_GRANULARITIES,
  USAGE_SOURCES,
} from './enums.js';

const enumOf = (values: readonly string[]) =>
  z.enum(values as [string, ...string[]]);

/** UTC ISO-8601 timestamp (SCHEMAS conventions). */
export const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime());
export type Timestamp = z.infer<typeof TimestampSchema>;

/** `schema: 1` pinned on every structured doc (SCHEMAS conventions). */
export const SchemaVersionSchema = z.literal(1);

// ---------- §1 ticket.md frontmatter ----------

export const TicketFrontmatterSchema = z.object({
  schema: SchemaVersionSchema,
  id: z.string().min(1),
  title: z.string().min(1),
  status: enumOf(TICKET_STATUSES),
  priority: enumOf(TICKET_PRIORITIES),
  /** Parent feature (D26); null = orphan ticket. */
  feature: z.string().nullish(),
  /** One branch+worktree+PR per repo (§1). */
  repos: z.array(z.string().min(1)),
  depth: enumOf(DEPTH_TIERS),
  backend: enumOf(BACKENDS).nullish(),
  model: z.string().nullish(),
  /** e.g. `jira:PROJ-123`, `github:org/repo#N`, `manual` (§1). */
  source: z.string().nullish(),
  /** Set on children produced by a split run (§1). */
  parent: z.string().nullish(),
  depends_on: z.array(z.string()),
  forced: z.boolean().default(false),
  /** `env | agent | <short text>` — set with status: blocked (§1). */
  blocked_reason: z.string().nullish(),
});
export type TicketFrontmatter = z.infer<typeof TicketFrontmatterSchema>;

// ---------- §7 events (the `events` table — D29; was events.jsonl) ----------

export const EventActorSchema = z.object({
  type: enumOf(ACTOR_TYPES),
  id: z.string(),
});
export type EventActor = z.infer<typeof EventActorSchema>;

export const EventSchema = z.object({
  v: z.literal(1),
  ts: z.string(),
  ticket: z.string().nullish(),
  stage: z.string().nullish(),
  actor: EventActorSchema,
  event: enumOf(EVENT_NAMES),
  run: z.string().nullish(),
  /** Artifact paths relative to the ticket dir — events reference,
   *  never embed (§7). */
  refs: z.array(z.string()).default([]),
  data: z.record(z.unknown()).default({}),
  /** null where billing isn't token-computable (§7). */
  cost_usd: z.number().nullish(),
  tokens_in: z.number().int().nullish(),
  tokens_out: z.number().int().nullish(),
  tokens_cached: z.number().int().nullish(),
  usage_source: enumOf(USAGE_SOURCES).nullish(),
  duration_s: z.number().nullish(),
  human_minutes: z.number().nullish(),
});
export type Event = z.infer<typeof EventSchema>;

// ---------- §5 triage.json ----------

export const TriageQuestionOptionSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  recommended: z.boolean().optional(),
});
export type TriageQuestionOption = z.infer<typeof TriageQuestionOptionSchema>;

export const TriageQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string(),
  why: z.string(),
  format: enumOf(QUESTION_FORMATS),
  options: z.array(TriageQuestionOptionSchema).default([]),
  default: z.string().nullish(),
  allow_other: z.boolean().default(false),
  status: enumOf(QUESTION_STATUSES),
  answer: z.union([z.string(), z.array(z.string())]).nullish(),
  answered_by: z.string().nullish(),
  answered_at: z.string().nullish(),
  /** true when skipped → default applied (§5). */
  auto: z.boolean().default(false),
});
export type TriageQuestion = z.infer<typeof TriageQuestionSchema>;

export const TriageSchema = z.object({
  schema: SchemaVersionSchema,
  ticket: z.string().min(1),
  round: z.number().int().nonnegative(),
  spec_lint: z.object({
    score: z.number(),
    flags: z.array(z.string()),
  }),
  suggestions: z
    .object({
      backend: enumOf(BACKENDS).optional(),
      model: z.string().optional(),
      priority: enumOf(TICKET_PRIORITIES).optional(),
      depth: enumOf(DEPTH_TIERS).optional(),
    })
    .partial()
    .optional(),
  files_likely_touched: z
    .array(z.object({ repo: z.string(), file: z.string() }))
    .default([]),
  /** ticket terms → dossier entities (§5, §12 entity linking). */
  entities_referenced: z
    .array(
      z.object({
        term: z.string(),
        entity: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  risk_summary: z.string().optional(),
  self_answered: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
        evidence: z.string(),
      }),
    )
    .default([]),
  questions: z.array(TriageQuestionSchema).default([]),
});
export type Triage = z.infer<typeof TriageSchema>;

// ---------- §6 review.json + findings ----------

/** Runner-computed dedupe identity — agents never emit this (§6). */
export const FindingFingerprintSchema = z.object({
  file: z.string(),
  symbol: z.string().nullish(),
  category: enumOf(FINDING_CATEGORIES),
  line_range: z.tuple([z.number().int(), z.number().int()]),
  text_hash: z.string(),
});
export type FindingFingerprint = z.infer<typeof FindingFingerprintSchema>;

export const FindingReplySchema = z.object({
  actor: z.string(),
  body: z.string(),
  ts: z.string(),
});
export type FindingReply = z.infer<typeof FindingReplySchema>;

export const FindingSchema = z.object({
  /** Assigned by the runner at merge (§6). */
  thread_id: z.string(),
  status: enumOf(FINDING_STATUSES),
  fingerprint: FindingFingerprintSchema,
  severity: enumOf(FINDING_SEVERITIES),
  category: enumOf(FINDING_CATEGORIES),
  kind: enumOf(FINDING_KINDS),
  file: z.string(),
  line: z.number().int().nonnegative(),
  repo: z.string(),
  body: z.string(),
  evidence: z.string().optional(),
  suggested_fix: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  rounds_seen: z.array(z.number().int()).default([]),
  author: z.string().default('review'),
  replies: z.array(FindingReplySchema).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;

/** A single specialist pass writes a bare array to findings-<pass>.json
 *  (§6) — without runner-computed thread_id/fingerprint. */
export const AgentFindingSchema = FindingSchema.omit({
  thread_id: true,
  fingerprint: true,
  status: true,
  rounds_seen: true,
}).partial({ author: true });
export type AgentFinding = z.infer<typeof AgentFindingSchema>;

export const FindingsFragmentSchema = z.array(AgentFindingSchema);
export type FindingsFragment = z.infer<typeof FindingsFragmentSchema>;

export const ReviewSchema = z.object({
  schema: SchemaVersionSchema,
  ticket: z.string().min(1),
  round: z.number().int().nonnegative(),
  passes: z.array(z.string()),
  findings: z.array(FindingSchema),
});
export type Review = z.infer<typeof ReviewSchema>;

// ---------- §10 test-report.json (runner-produced, ground truth) ----------

export const TestReportCaseSchema = z.object({
  case_id: z.string().min(1),
  implemented: z.boolean(),
  file: z.string().optional(),
  result: enumOf(TEST_RESULTS).optional(),
});
export type TestReportCase = z.infer<typeof TestReportCaseSchema>;

export const TestReportSchema = z.object({
  schema: SchemaVersionSchema,
  ticket: z.string().min(1),
  ts: z.string(),
  command: z.string(),
  cases: z.array(TestReportCaseSchema),
  pass_pct: z.number(),
  planned: z.number().int().nonnegative(),
  implemented: z.number().int().nonnegative(),
  risks: z.array(z.string()).default([]),
});
export type TestReport = z.infer<typeof TestReportSchema>;

// ---------- §13 usage.json (per-run token ledger — REQUIRED artifact) ----------

export const UsageTotalsSchema = z.object({
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  tokens_cached: z.number().int(),
  /** null where billing isn't token-computable (§13). */
  cost_usd: z.number().nullish(),
  duration_s: z.number(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageCallSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  model: z.string(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  tokens_cached: z.number().int(),
  latency_s: z.number(),
  source: enumOf(CALL_USAGE_SOURCES),
});
export type UsageCall = z.infer<typeof UsageCallSchema>;

export const UsageSchema = z.object({
  schema: SchemaVersionSchema,
  ticket: z.string(),
  run: z.string(),
  backend: z.string(),
  model: z.string(),
  granularity: enumOf(USAGE_GRANULARITIES),
  totals: UsageTotalsSchema,
  calls: z.array(UsageCallSchema).default([]),
  source: enumOf(USAGE_SOURCES),
  notes: z.string().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

// ---------- gate items (DB-SCHEMA gate_items — materialized inbox) ----------

export const GateItemSchema = z.object({
  workspace: z.string().min(1),
  /** ticket id or survey:/probe:/import:/interview: subject (DB-SCHEMA). */
  subject: z.string().min(1),
  /** Gate instance name — matches claims.gate. */
  gate: z.string().min(1),
  kind: enumOf(GATE_KINDS),
  surfaced_at: z.string(),
  cleared_at: z.string().nullish(),
  /** Snoozed items stay open but leave badge counts/inbox (D20). */
  snoozed_until: z.string().nullish(),
  blocked_agent: z.boolean().default(false),
  priority: enumOf(TICKET_PRIORITIES).nullish(),
});
export type GateItem = z.infer<typeof GateItemSchema>;

// ---------- §9 pr-body.md (runner assembles PR from it) ----------

export const PR_BODY_SECTIONS = [
  'Summary',
  'Acceptance criteria map',
  'Deviations',
  'Test results',
  'Risks / rollout notes',
] as const;
export type PrBodySection = (typeof PR_BODY_SECTIONS)[number];

/** Parsed pr-body.md: heading name → markdown body (§9). */
export const PrBodySchema = z.object({
  summary: z.string(),
  acceptance_criteria_map: z.string(),
  deviations: z.string(),
  test_results: z.string(),
  risks_rollout_notes: z.string(),
});
export type PrBody = z.infer<typeof PrBodySchema>;

// ---------- §8 DEVIATIONS.md row ----------

export const DeviationRowSchema = z.object({
  planned: z.string(),
  did: z.string(),
  reason: z.string(),
  file: z.string().optional(),
  reason_kind: enumOf(DEVIATION_REASON_KINDS).optional(),
});
export type DeviationRow = z.infer<typeof DeviationRowSchema>;

// ---------- §11 dossier sections (DB-stored) ----------

export const DossierEntrySchema = z.object({
  scope: enumOf(DOSSIER_SCOPES),
  name: z.string().min(1),
  section: enumOf(DOSSIER_SECTIONS),
  version: z.number().int().nonnegative(),
  content: z.string(),
  surveyed_at: z.string(),
  sources_used: z.array(enumOf(DOSSIER_SOURCES)),
  stale: z.boolean().default(false),
  edited_by: z.string().nullish(),
  edited_at: z.string().nullish(),
});
export type DossierEntry = z.infer<typeof DossierEntrySchema>;

export const GapReportRowSchema = z.object({
  gap: z.string(),
  kind: enumOf(GAP_KINDS),
  evidence: z.string(),
  severity: enumOf(FINDING_SEVERITIES),
});
export type GapReportRow = z.infer<typeof GapReportRowSchema>;

// ---------- §12 semantic layer rows ----------

export const EntitySchema = z.object({
  id: z.string().min(1),
  product: z.string(),
  kind: enumOf(ENTITY_KINDS),
  name: z.string(),
  canonical: z.string(),
  aliases: z.array(z.string()).default([]),
  source: enumOf(ENTITY_SOURCES),
  evidence: z.string().optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

export const RelationSchema = z.object({
  subject: z.string().min(1),
  predicate: enumOf(RELATION_PREDICATES),
  object: z.string().min(1),
  evidence: z.string().optional(),
  /** Edge provenance (DB-SCHEMA relations.source — D37). */
  source: enumOf(RELATION_SOURCES).optional(),
  /** Required on inferred links (DB-SCHEMA relations.confidence). */
  confidence: z.number().min(0).max(1).optional(),
  verification: enumOf(RELATION_VERIFICATIONS).optional(),
  /** Commit/version/time boundary the edge is valid at. */
  valid_at: z.string().optional(),
});
export type Relation = z.infer<typeof RelationSchema>;

export const EmbeddingSchema = z.object({
  object_ref: z.string().min(1),
  model: z.string().min(1),
  vector: z.instanceof(Uint8Array).or(z.array(z.number())),
});
export type Embedding = z.infer<typeof EmbeddingSchema>;

// ---------- machine-read markdown table rows (§2-§4, §14) ----------

/** PRD acceptance criteria row (§2). */
export const AcceptanceCriterionRowSchema = z.object({
  ac_id: z.string().min(1),
  criterion: z.string().min(1),
  verifies_how: z.string().optional(),
});
export type AcceptanceCriterionRow = z.infer<
  typeof AcceptanceCriterionRowSchema
>;

/** TDD file-plan row (§3); `change` may start with `untestable:`. */
export const FilePlanRowSchema = z.object({
  file: z.string().min(1),
  repo: z.string().min(1),
  change: z.string(),
  why: z.string().optional(),
});
export type FilePlanRow = z.infer<typeof FilePlanRowSchema>;

/** TDD addendum row appended by implement on deviation (§3). */
export const AddendumRowSchema = z.object({
  ts: z.string(),
  planned: z.string(),
  did: z.string(),
  reason: z.string(),
});
export type AddendumRow = z.infer<typeof AddendumRowSchema>;

/** vs.md (Verification Specification) case row (§4). */
export const TestCaseRowSchema = z.object({
  case_id: z.string().min(1),
  title: z.string(),
  type: enumOf(TEST_CASE_TYPES),
  file: z.string(),
  covers: z.string(),
});
export type TestCaseRow = z.infer<typeof TestCaseRowSchema>;

/** vs.md coverage-matrix row (§4); `case_ids` may be `n/a` for
 *  `untestable:` file-plan rows. */
export const CoverageRowSchema = z.object({
  item: z.string().min(1),
  kind: enumOf(COVERAGE_KINDS),
  case_ids: z.string(),
});
export type CoverageRow = z.infer<typeof CoverageRowSchema>;

/** Definition-of-Done row (§4). `verified_by` = `cmd:<command>` | `manual`. */
export const DodRowSchema = z.object({
  criterion: z.string().min(1),
  verified_by: z.string().min(1),
});
export type DodRow = z.infer<typeof DodRowSchema>;

/** split-plan.md children row (§14). */
export const SplitPlanChildSchema = z.object({
  /** Local label c1..cn — real ids assigned at materialization (§14). */
  child: z.string().min(1),
  title: z.string().min(1),
  repos: z.array(z.string().min(1)),
  /** Sibling labels, not ticket ids. */
  depends_on: z.array(z.string()).default([]),
  /** Parent ac_ids covered. */
  covers: z.array(z.string()).default([]),
});
export type SplitPlanChild = z.infer<typeof SplitPlanChildSchema>;

// ---------- DB row projections (DB-SCHEMA) ----------

export const RunRowSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  subject: z.string().min(1),
  ticket_id: z.string().nullish(),
  stage: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  backend: z.string().nullish(),
  model: z.string().nullish(),
  depth: enumOf(DEPTH_TIERS).nullish(),
  pid: z.number().int().nullish(),
  worktree: z.string().nullish(),
  /** Docker container id when `runtime: container` (D30); null for
   *  process runs. */
  container_id: z.string().nullish(),
  /** Serialized launch request for `pending` rows — {tokens, model} —
   *  survives the queue→claim relaunch (D29). */
  request: z.record(z.unknown()).nullish(),
  status: enumOf(RUN_STATUSES),
  started_at: z.string().nullish(),
  heartbeat_at: z.string().nullish(),
  exited_at: z.string().nullish(),
  sentinel: z.string().nullish(),
  sentinel_raw: z.string().nullish(),
  cost_usd: z.number().nullish(),
  tokens_in: z.number().int().nullish(),
  tokens_out: z.number().int().nullish(),
  tokens_cached: z.number().int().nullish(),
  usage_source: enumOf(USAGE_SOURCES).nullish(),
  duration_s: z.number().nullish(),
  run_dir: z.string().nullish(),
});
export type RunRow = z.infer<typeof RunRowSchema>;

/** containers row (DB-SCHEMA, D30) — one per (workspace, subject);
 *  the conductor-owned per-subject docker container. */
export const ContainerRowSchema = z.object({
  workspace: z.string().min(1),
  subject: z.string().min(1),
  /** Docker container id (last known — kept for audit after removal). */
  container_id: z.string().min(1),
  image: z.string().nullish(),
  state: enumOf(CONTAINER_STATES),
  created_at: z.string().nullish(),
  stopped_at: z.string().nullish(),
});
export type ContainerRow = z.infer<typeof ContainerRowSchema>;

export const TicketRowSchema = z.object({
  workspace: z.string().min(1),
  /** Nullable tenancy partition — reserved for the SaaS pivot
   *  (design-for-both, D43); always null in local-first mode. */
  org: z.string().nullish(),
  ticket_id: z.string().min(1),
  /** Parent feature ref (D26); null = orphan. */
  feature: z.string().nullish(),
  title: z.string(),
  status: enumOf(TICKET_STATUSES),
  priority: enumOf(TICKET_PRIORITIES),
  depth: enumOf(DEPTH_TIERS).nullish(),
  backend: z.string().nullish(),
  model: z.string().nullish(),
  repos: z.array(z.string()),
  parent: z.string().nullish(),
  depends_on: z.array(z.string()).default([]),
  /** D33: goal board_item ids — inherited feature→initiative chain or
   *  direct override. */
  serves: z.array(z.string()).nullish(),
  source: z.string().nullish(),
  /** §15.7 taxonomy — work type × origin are separate dimensions. */
  work_type: enumOf(TICKET_WORK_TYPES).nullish(),
  origin: enumOf(TICKET_ORIGINS).nullish(),
  /** Priority ≠ severity (§15.7); set on bugs/incidents. */
  severity: enumOf(TICKET_SEVERITIES).nullish(),
  /** DoR/decomposition verdicts (wp-153/154). */
  execution_readiness: enumOf(EXECUTION_READINESSES).nullish(),
  parallel_safety: enumOf(PARALLEL_SAFETIES).nullish(),
  /** Import provenance (wp-139): {system, url, imported_at,
   *  original_status} — preserves the original tracker identity. */
  source_ref: z
    .object({
      system: z.string(),
      url: z.string().nullish(),
      imported_at: z.string().nullish(),
      original_status: z.string().nullish(),
    })
    .nullish(),
  /** Declarative test-environment spec (wp-157); materialized
   *  in-container before verify/implement. */
  test_env: z.record(z.unknown()).nullish(),
  forced: z.boolean().default(false),
  spec_score: z.number().nullish(),
  spec_hash: z.string().nullish(),
  blocked_reason: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string(),
});
export type TicketRow = z.infer<typeof TicketRowSchema>;

// ---------- hierarchy + boards (D26/D27, DB-SCHEMA) ----------

export const ProjectRowSchema = z.object({
  workspace: z.string().min(1),
  /** Owning org — design-for-both tenancy (D43); null local-first. */
  org: z.string().nullish(),
  name: z.string().nullish(),
  next_ticket_seq: z.number().int().default(1),
  next_feature_seq: z.number().int().default(1),
  next_initiative_seq: z.number().int().default(1),
  /** REL-NNNN allocator (DELIVERY §3). */
  next_release_seq: z.number().int().default(1),
  settings: z.record(z.unknown()).default({}),
  created_at: z.string().nullish(),
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const BoardRowSchema = z.object({
  workspace: z.string().min(1),
  /** Org-level boards keep `org` set for unassigned ideas (§15.3). */
  org: z.string().nullish(),
  board: z.string().min(1),
  name: z.string().nullish(),
  /** Board type = config, not pipeline (§15.3, wp-144). */
  board_type: enumOf(BOARD_TYPES).nullish(),
  /** Board lifecycle — deferred boards keep evidence + resurface. */
  status: enumOf(BOARD_STATUSES).nullish(),
  created_at: z.string().nullish(),
});
export type BoardRow = z.infer<typeof BoardRowSchema>;

export const BoardItemSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  /** Org-level items on org boards (§15.3); null local-first. */
  org: z.string().nullish(),
  /** NULL = capture tray (D27). */
  board: z.string().nullish(),
  kind: enumOf(BOARD_ITEM_KINDS),
  /** §15.3 typed-sticky taxonomy layered on `kind` (wp-144). */
  note_kind: enumOf(NOTE_KINDS).nullish(),
  topic: z.string().nullish(),
  importance: enumOf(NOTE_IMPORTANCES).nullish(),
  /** Refs the note applies to (json array — ticket/feature/entity). */
  applies_to: z.array(z.string()).nullish(),
  /** The note's own lightweight lifecycle (§15.3, wp-144). */
  note_status: enumOf(NOTE_STATUSES).nullish(),
  rationale: z.string().nullish(),
  /** Provenance tri-state (wp-139) — `inferred` never auto-approves. */
  provenance: enumOf(PROVENANCE_STATES).nullish(),
  ref: z.string().nullish(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  x: z.number().nullish(),
  y: z.number().nullish(),
  w: z.number().nullish(),
  h: z.number().nullish(),
  zone: z.string().nullish(),
  /** D33: goal board_item ids this item serves — the canonical edge. */
  serves: z.array(z.string()).nullish(),
  status: enumOf(BOARD_ITEM_STATUSES),
  consumed_by: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type BoardItem = z.infer<typeof BoardItemSchema>;

export const InitiativeRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  initiative: z.string().min(1),
  board: z.string().nullish(),
  title: z.string(),
  status: enumOf(INITIATIVE_STATUSES),
  owner: z.string().nullish(),
  priority: enumOf(TICKET_PRIORITIES).nullish(),
  /** D33: json goals — board_item ids this initiative serves. */
  serves: z.array(z.string()).nullish(),
  provenance: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type InitiativeRow = z.infer<typeof InitiativeRowSchema>;

export const FeatureRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  feature: z.string().min(1),
  initiative: z.string().nullish(),
  title: z.string(),
  status: enumOf(FEATURE_STATUSES),
  owner: z.string().nullish(),
  priority: enumOf(TICKET_PRIORITIES).nullish(),
  /** D33: goal board_item ids — inherited from initiative, direct
   *  override allowed. */
  serves: z.array(z.string()).nullish(),
  /** Declarative test-environment spec (wp-157) — inherited by
   *  member tickets unless overridden. */
  test_env: z.record(z.unknown()).nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type FeatureRow = z.infer<typeof FeatureRowSchema>;

export const DocVersionSchema = z.object({
  workspace: z.string().min(1),
  subject: z.string().min(1),
  doc: enumOf(DOC_KINDS),
  /** 1,2,3… per (workspace, subject, doc) — assigned by the store. */
  version: z.number().int().positive(),
  content: z.string(),
  edited_by: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type DocVersion = z.infer<typeof DocVersionSchema>;

export const RunArtifactSchema = z.object({
  run_id: z.string().min(1),
  name: z.string().min(1),
  content: z.string(),
  created_at: z.string().nullish(),
});
export type RunArtifact = z.infer<typeof RunArtifactSchema>;

export const TicketRepoRowSchema = z.object({
  workspace: z.string().min(1),
  ticket_id: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().nullish(),
  worktree: z.string().nullish(),
  pr_url: z.string().nullish(),
  pr_state: enumOf(PR_STATES).nullish(),
  ci_state: enumOf(CI_STATES).nullish(),
  merged_sha: z.string().nullish(),
});
export type TicketRepoRow = z.infer<typeof TicketRepoRowSchema>;

export const LeaseSchema = z.object({
  workspace: z.string().min(1),
  subject: z.string().min(1),
  stage: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  holder: z.string().min(1),
  acquired_at: z.string(),
  ttl_s: z.number().int().positive(),
  heartbeat_at: z.string().nullish(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export const ClaimSchema = z.object({
  workspace: z.string().min(1),
  subject: z.string().min(1),
  gate: z.string().min(1),
  claimed_by: z.string().min(1),
  claimed_at: z.string(),
  ttl_s: z.number().int().positive(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const NotificationSchema = z.object({
  id: z.number().int().optional(),
  workspace: z.string().min(1),
  subject: z.string().min(1),
  kind: z.string().min(1),
  payload: z.string().nullish(),
  created_at: z.string(),
  read_at: z.string().nullish(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const PresenceSchema = z.object({
  install_id: z.string().min(1),
  actor: z.string().min(1),
  last_seen: z.string(),
});
export type Presence = z.infer<typeof PresenceSchema>;

export const UsageCallRowSchema = z.object({
  run_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  model: z.string(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  tokens_cached: z.number().int(),
  latency_s: z.number(),
  source: enumOf(CALL_USAGE_SOURCES),
});
export type UsageCallRow = z.infer<typeof UsageCallRowSchema>;

/** events_idx row (DB-SCHEMA projection). */
export const EventRowSchema = z.object({
  seq: z.number().int().optional(),
  workspace: z.string().min(1),
  ticket_id: z.string().nullish(),
  ts: z.string(),
  stage: z.string().nullish(),
  actor_type: enumOf(ACTOR_TYPES),
  actor_id: z.string(),
  event: enumOf(EVENT_NAMES),
  run: z.string().nullish(),
  refs: z.array(z.string()).default([]),
  data: z.record(z.unknown()).default({}),
  cost_usd: z.number().nullish(),
  tokens_in: z.number().int().nullish(),
  tokens_out: z.number().int().nullish(),
  tokens_cached: z.number().int().nullish(),
  usage_source: enumOf(USAGE_SOURCES).nullish(),
  duration_s: z.number().nullish(),
  human_minutes: z.number().nullish(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

/** Sentinel line parsed from a run's last non-empty output line
 *  (CONDUCTOR sentinel table). `name` is the token before `:`;
 *  `arg` is the raw payload (may be null for bare sentinels). */
export const SentinelSchema = z.object({
  name: enumOf(SENTINELS),
  arg: z.string().nullish(),
  raw: z.string(),
});
export type SentinelValue = z.infer<typeof SentinelSchema>;

// =====================================================================
// Addendum row projections (wp-131 freeze — DB-SCHEMA "addendum" block).
// Every new table carries `workspace` + nullable `org` (design-for-both
// tenancy, D43). JSON columns parse to the shapes documented inline.
// =====================================================================

// ---------- runs.request.baseline (PRD §15.5, wp-141) ----------

/** Pinned spec baseline recorded on every run launch — the running
 *  agent resolves THIS, never "latest" (§15.5; wp-141). Shape only:
 *  `runs.request` stays a json column — no DDL. */
export const RunBaselineSchema = z.object({
  /** doc_versions version of the rs.md doc the run pins. */
  rs_version: z.number().int().nullish(),
  /** doc_versions version of ticket.md. */
  ticket_rev: z.number().int().nullish(),
  /** doc_versions version of the design doc (tdd.md/mockup revision). */
  design_rev: z.number().int().nullish(),
  /** AC set the run implements against. */
  ac_ids: z.array(z.string()).default([]),
  /** Base commit the work branched from. */
  base_sha: z.string().nullish(),
  /** contract.json doc_version pinned by contract-first tickets
   *  (wp-154). */
  contract_ver: z.number().int().nullish(),
});
export type RunBaseline = z.infer<typeof RunBaselineSchema>;

/** The `runs.request` json contract (D40 + wp-141): producers write,
 *  consumers parse. `.passthrough()` — forward-compatible, new fields
 *  never break older readers. */
export const RunRequestSchema = z
  .object({
    /** Prompt tokens surviving queue→claim relaunch (D40). */
    tokens: z.record(z.string()).optional(),
    model: z.string().optional(),
    /** RunnerTask spec for agent-less stages (conductor-owned shape). */
    task: z.unknown().optional(),
    baseline: RunBaselineSchema.optional(),
  })
  .passthrough();
export type RunRequestPayload = z.infer<typeof RunRequestSchema>;

// ---------- releases / delivery (DELIVERY §3) ----------

export const ReleaseRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  /** REL-NNNN — allocated from projects.next_release_seq. */
  release_id: z.string().min(1),
  title: z.string(),
  status: enumOf(RELEASE_STATUSES),
  /** Free-text target (version label, train, date). */
  target: z.string().nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type ReleaseRow = z.infer<typeof ReleaseRowSchema>;

export const ReleaseItemRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  release_id: z.string().min(1),
  item_kind: enumOf(RELEASE_ITEM_KINDS),
  item_id: z.string().min(1),
  /** json list of ac_ids for partial releases; null = full item
   *  (DELIVERY §3 — non-null requires approved_by, invariant 5). */
  partial_ac: z.array(z.string()).nullish(),
  /** Materialized delivery dimension (DELIVERY §1). */
  delivery_state: enumOf(DELIVERY_STATES).default('planned'),
  approved_by: z.string().nullish(),
  added_by: z.string().nullish(),
  added_at: z.string().nullish(),
  removed_at: z.string().nullish(),
});
export type ReleaseItemRow = z.infer<typeof ReleaseItemRowSchema>;

/** Immutable manifest cut — a scope change cuts a new version and
 *  resets pending approvals (DELIVERY invariant 3). */
export const ReleaseManifestRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  release_id: z.string().min(1),
  version: z.number().int().positive(),
  /** sha256 of the item→repo→merged_sha map. */
  digest: z.string().min(1),
  /** [{item_kind, item_id, repos: [{repo, merged_sha}]}]. */
  items: z.array(z.record(z.unknown())),
  created_at: z.string().nullish(),
});
export type ReleaseManifestRow = z.infer<typeof ReleaseManifestRowSchema>;

/** Append-only approval bound to a manifest digest (DELIVERY §3). */
export const ReleaseApprovalRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  release_id: z.string().min(1),
  manifest_version: z.number().int().positive(),
  approver: z.string().min(1),
  decision: enumOf(RELEASE_APPROVAL_DECISIONS),
  rationale: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type ReleaseApprovalRow = z.infer<typeof ReleaseApprovalRowSchema>;

/** Publication metadata — the note content lives in doc_versions
 *  (`notes-<audience>.md`); `doc_version` is the approved revision. */
export const ReleaseNoteRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  release_id: z.string().min(1),
  audience: enumOf(RELEASE_NOTE_AUDIENCES),
  doc_version: z.number().int().nullish(),
  approved_by: z.string().nullish(),
  approved_at: z.string().nullish(),
  published_at: z.string().nullish(),
});
export type ReleaseNoteRow = z.infer<typeof ReleaseNoteRowSchema>;

/** Append-only gate-check audit (readiness gates, DELIVERY §3).
 *  `id` is store-assigned (identity). */
export const ReleaseGateResultRowSchema = z.object({
  id: z.number().int(),
  workspace: z.string().min(1),
  org: z.string().nullish(),
  release_id: z.string().min(1),
  gate: z.string().min(1),
  result: enumOf(RELEASE_GATE_VERDICTS),
  evidence: z.record(z.unknown()).nullish(),
  checked_at: z.string(),
});
export type ReleaseGateResultRow = z.infer<typeof ReleaseGateResultRowSchema>;

/** Deployment evidence payload — MVP manual-only (DELIVERY §3
 *  invariant 4: non-empty evidence required; `type` reserves
 *  webhook|probe for automated confirmation). */
export const DeploymentEvidenceSchema = z.object({
  type: enumOf(DEPLOY_EVIDENCE_TYPES),
  by: z.string().nullish(),
  note: z.string().nullish(),
  url: z.string().nullish(),
});
export type DeploymentEvidence = z.infer<typeof DeploymentEvidenceSchema>;

export const DeploymentRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  deployment_id: z.string().min(1),
  release_id: z.string().min(1),
  /** Free-form env name (staging/prod/…) — envs are per-deployment
   *  config, not a fixed enum (DB-SCHEMA note). */
  environment: z.string().min(1),
  sha: z.string().min(1),
  evidence: DeploymentEvidenceSchema,
  confirmed_by: z.string().nullish(),
  confirmed_at: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type DeploymentRow = z.infer<typeof DeploymentRowSchema>;

export const FeatureExposureRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  feature_id: z.string().min(1),
  environment: z.string().min(1),
  state: enumOf(FEATURE_EXPOSURE_STATES),
  audience: z.string().nullish(),
  evidence: z.string().nullish(),
  /** Linked deployment — required when state = `available`
   *  (DELIVERY invariant 4). */
  deployment_id: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type FeatureExposureRow = z.infer<typeof FeatureExposureRowSchema>;

/** KPI outcome — `data` carries {baseline, target, observed, unit}
 *  (DELIVERY §3). */
export const ReleaseOutcomeRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  release_id: z.string().min(1),
  kpi: z.string().min(1),
  data: z
    .object({
      baseline: z.number().nullish(),
      target: z.number().nullish(),
      observed: z.number().nullish(),
      unit: z.string().nullish(),
    })
    .passthrough(),
  measured_at: z.string().nullish(),
});
export type ReleaseOutcomeRow = z.infer<typeof ReleaseOutcomeRowSchema>;

// ---------- changesets (PRD §15.5, wp-140) ----------

/** Baseline pin on a ChangeSet — the (subject, doc, version) the
 *  change applies against. */
export const BaselineRefSchema = z.object({
  subject: z.string().min(1),
  doc: z.string().min(1),
  version: z.number().int().nullish(),
});
export type BaselineRef = z.infer<typeof BaselineRefSchema>;

export const ChangesetRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  changeset_id: z.string().min(1),
  title: z.string().nullish(),
  /** Original request text, verbatim (§15.5). */
  request: z.string().min(1),
  baseline: BaselineRefSchema.nullish(),
  classification: enumOf(CHANGESET_CLASSIFICATIONS).nullish(),
  status: enumOf(CHANGESET_STATUSES),
  /** Affected-artifact analysis (relations + statements, wp-143). */
  analysis: z.record(z.unknown()).nullish(),
  decision: enumOf(CHANGESET_DECISIONS).nullish(),
  decision_rationale: z.string().nullish(),
  decided_by: z.string().nullish(),
  decided_at: z.string().nullish(),
  /** Approval expiry — material upstream change revalidates only
   *  what's invalidated (§15.5 safeguards). */
  expires_on: z.string().nullish(),
  /** Emergency route: expedited decision + mandatory retro doc
   *  (retro_ref → the doc_version carrying the note). */
  emergency: z.boolean().default(false),
  retro_ref: z.string().nullish(),
  /** Apply/reconcile outcome rollup — partial application visible. */
  reconciliation: z.record(z.unknown()).nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type ChangesetRow = z.infer<typeof ChangesetRowSchema>;

export const ChangesetItemRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  changeset_id: z.string().min(1),
  /** Caller-assigned ordinal — items are an ordered apply list. */
  seq: z.number().int().nonnegative(),
  /** Affected artifact subject; `doc` set when doc-addressable. */
  subject: z.string().min(1),
  doc: z.string().nullish(),
  base_version: z.number().int().nullish(),
  /** doc_version carrying the proposed diff (never in-place edits). */
  proposed_version: z.number().int().nullish(),
  /** Proposed change payload (free-form json per artifact kind). */
  change: z.record(z.unknown()).nullish(),
  status: enumOf(CHANGESET_ITEM_STATUSES).default('pending'),
  applied_at: z.string().nullish(),
});
export type ChangesetItemRow = z.infer<typeof ChangesetItemRowSchema>;

// ---------- statement ledger (PRD §15.3/§15.9, wp-143) ----------

/** semantic_statements head row — history lands in
 *  statement_versions on every write (same discipline as
 *  doc_versions). */
export const StatementRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  statement_id: z.string().min(1),
  /** Current version — mirrors max(statement_versions.version). */
  version: z.number().int().positive(),
  /** The atomic assertion (normalized wording). */
  text: z.string().min(1),
  /** Original source text preserved verbatim — never paraphrased
   *  away (§15.3). */
  source_text: z.string().nullish(),
  /** Evidence ref: {kind: board-item|interview-message|import|doc,
   *  id, span} — recovers exactly where the words came from. */
  source_ref: z.record(z.unknown()).nullish(),
  intent: enumOf(STATEMENT_INTENTS).nullish(),
  polarity: enumOf(STATEMENT_POLARITIES).nullish(),
  /** Subject/topic text (entity-linked downstream). */
  subject: z.string().nullish(),
  strength: enumOf(STATEMENT_STRENGTHS).nullish(),
  scope: enumOf(STATEMENT_SCOPES).nullish(),
  /** Entity the scope pins to (initiative/feature/repo id…). */
  scope_ref: z.string().nullish(),
  status: enumOf(STATEMENT_STATUSES),
  confidence: z.number().min(0).max(1).nullish(),
  provenance: enumOf(PROVENANCE_STATES).nullish(),
  /** semantic_extraction_runs id that produced this version. */
  extraction_run: z.string().nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type StatementRow = z.infer<typeof StatementRowSchema>;

/** Append-only statement history — one row per written version. */
export const StatementVersionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  statement_id: z.string().min(1),
  version: z.number().int().positive(),
  text: z.string().min(1),
  source_text: z.string().nullish(),
  source_ref: z.record(z.unknown()).nullish(),
  intent: enumOf(STATEMENT_INTENTS).nullish(),
  polarity: enumOf(STATEMENT_POLARITIES).nullish(),
  subject: z.string().nullish(),
  strength: enumOf(STATEMENT_STRENGTHS).nullish(),
  scope: enumOf(STATEMENT_SCOPES).nullish(),
  scope_ref: z.string().nullish(),
  status: enumOf(STATEMENT_STATUSES),
  confidence: z.number().min(0).max(1).nullish(),
  provenance: enumOf(PROVENANCE_STATES).nullish(),
  extraction_run: z.string().nullish(),
  edited_by: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type StatementVersionRow = z.infer<typeof StatementVersionRowSchema>;

/** Typed statement edge (§15.3) — the authority rule resolves on
 *  these, not vector similarity. */
export const StatementRelationRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  src: z.string().min(1),
  predicate: enumOf(STATEMENT_RELATIONS),
  dst: z.string().min(1),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type StatementRelationRow = z.infer<typeof StatementRelationRowSchema>;

/** Clarification Q&A bound to one statement. */
export const StatementClarificationRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  clarification_id: z.string().min(1),
  statement_id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().nullish(),
  asked_by: z.string().nullish(),
  answered_by: z.string().nullish(),
  created_at: z.string().nullish(),
  answered_at: z.string().nullish(),
});
export type StatementClarificationRow = z.infer<
  typeof StatementClarificationRowSchema
>;

/** Disagreement/consequential interpretation → decision item, never
 *  a silent merge (§15.9). */
export const StatementDecisionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  decision_id: z.string().min(1),
  statement_id: z.string().min(1),
  /** The human ruling (free text). */
  decision: z.string().nullish(),
  status: enumOf(STATEMENT_DECISION_STATUSES),
  rationale: z.string().nullish(),
  decided_by: z.string().nullish(),
  decided_at: z.string().nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type StatementDecisionRow = z.infer<typeof StatementDecisionRowSchema>;

/** Statement → artifact edge — generated artifact elements carry
 *  these back-links (wp-146 unsupported-binding-requirement lint). */
export const StatementArtifactLinkRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  statement_id: z.string().min(1),
  /** Artifact ref — `subject:doc` or `doc:<subject>:<doc>:v<N>`. */
  artifact: z.string().min(1),
  /** Element inside the artifact (e.g. `ac:AC-3`); '' = whole doc. */
  element: z.string().default(''),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type StatementArtifactLinkRow = z.infer<
  typeof StatementArtifactLinkRowSchema
>;

/** Extraction provenance — model + prompt version per batch
 *  (wp-143). */
export const ExtractionRunRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  extraction_run_id: z.string().min(1),
  /** runs.id that produced the extraction. */
  run: z.string().nullish(),
  /** What was extracted from (board/session/subject ref). */
  subject: z.string().nullish(),
  model: z.string().nullish(),
  prompt_version: z.string().nullish(),
  stats: z.record(z.unknown()).nullish(),
  created_at: z.string().nullish(),
});
export type ExtractionRunRow = z.infer<typeof ExtractionRunRowSchema>;

// ---------- interview orchestrator (PRD §15.9, wp-145) ----------

export const WizardDefinitionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  /** e.g. solution-discovery — versioned via wizard_versions. */
  wizard_id: z.string().min(1),
  name: z.string().nullish(),
  description: z.string().nullish(),
  /** Points at the live wizard_versions.version. */
  current_version: z.number().int().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type WizardDefinitionRow = z.infer<typeof WizardDefinitionRowSchema>;

/** Versioned wizard config — required knowledge areas, thresholds,
 *  prompt policy (§15.9 "versioned wizard config"). */
export const WizardVersionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  wizard_id: z.string().min(1),
  version: z.number().int().positive(),
  /** {slots: [{slot, required, scope}], thresholds, prompts…}. */
  definition: z.record(z.unknown()),
  created_at: z.string().nullish(),
});
export type WizardVersionRow = z.infer<typeof WizardVersionRowSchema>;

export const InterviewSessionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  session_id: z.string().min(1),
  wizard_id: z.string().nullish(),
  wizard_version: z.number().int().nullish(),
  /** What the session serves (solution/feature/release/subject ref). */
  subject: z.string().nullish(),
  mode: enumOf(INTERVIEW_MODES).nullish(),
  status: enumOf(INTERVIEW_SESSION_STATUSES),
  /** Two thresholds — draft-ready ≠ approval-ready (§15.9). */
  draft_ready: z.boolean().default(false),
  approval_ready: z.boolean().default(false),
  /** Last snapshotted knowledge version — drives the resume
   *  diff briefing (briefing.json). */
  knowledge_version: z.number().int().nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type InterviewSessionRow = z.infer<typeof InterviewSessionRowSchema>;

/** Multi-stakeholder specialist branch (§15.9). */
export const InterviewBranchRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  session_id: z.string().min(1),
  branch: z.string().min(1),
  /** Stakeholder role routed here. */
  role: z.string().nullish(),
  status: enumOf(INTERVIEW_BRANCH_STATUSES),
  created_at: z.string().nullish(),
  merged_at: z.string().nullish(),
});
export type InterviewBranchRow = z.infer<typeof InterviewBranchRowSchema>;

/** Durable transcript — the stream is never the only copy (§15.9,
 *  SCHEMAS §16). */
export const InterviewMessageRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  session_id: z.string().min(1),
  /** Per-session monotonic — store-assigned on append. */
  seq: z.number().int().nonnegative(),
  /** Branch provenance (who-said-what survives the merge). */
  branch: z.string().nullish(),
  role: enumOf(INTERVIEW_MESSAGE_ROLES),
  content: z.string(),
  created_at: z.string().nullish(),
});
export type InterviewMessageRow = z.infer<typeof InterviewMessageRowSchema>;

export const KnowledgeSlotRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  session_id: z.string().min(1),
  /** Slot name from the wizard definition's knowledge areas. */
  slot: z.string().min(1),
  state: enumOf(KNOWLEDGE_SLOT_STATES),
  /** Current best answer summary. */
  value: z.string().nullish(),
  /** statement_ids backing the value. */
  statement_refs: z.array(z.string()).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  updated_at: z.string().nullish(),
});
export type KnowledgeSlotRow = z.infer<typeof KnowledgeSlotRowSchema>;

/** Planner output — scored next-question candidates (§15.9). */
export const QuestionCandidateRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  session_id: z.string().min(1),
  question_id: z.string().min(1),
  /** Target knowledge slot. */
  slot: z.string().nullish(),
  question: z.string().min(1),
  /** {impact, uncertainty, relevance, answerability, effort}. */
  scores: z.record(z.unknown()).nullish(),
  status: enumOf(QUESTION_CANDIDATE_STATUSES),
  created_at: z.string().nullish(),
  resolved_at: z.string().nullish(),
});
export type QuestionCandidateRow = z.infer<typeof QuestionCandidateRowSchema>;

/** Resumable-session snapshot (§15.9) — restart + diff briefing. */
export const SessionSnapshotRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  session_id: z.string().min(1),
  version: z.number().int().positive(),
  /** Knowledge state + position at snapshot time. */
  snapshot: z.record(z.unknown()),
  reason: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type SessionSnapshotRow = z.infer<typeof SessionSnapshotRowSchema>;

// ---------- review studio (PRD §15.8, wp-148/149/150) ----------

export const ReviewSessionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  review_id: z.string().min(1),
  /** Ticket (or subject) under review. */
  subject: z.string().min(1),
  /** Headline rollup — verdict history lives in review_decisions. */
  status: enumOf(REVIEW_SESSION_STATUSES),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
  closed_at: z.string().nullish(),
});
export type ReviewSessionRow = z.infer<typeof ReviewSessionRowSchema>;

/** A reviewable head — approvals bind to head_sha + spec baseline
 *  (§15.8); new commits → stale-approval + delta view. */
export const ReviewRevisionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  review_id: z.string().min(1),
  revision: z.number().int().positive(),
  head_sha: z.string().min(1),
  base_sha: z.string().nullish(),
  /** Spec baseline pinned at review time (RunBaseline-shape). */
  baseline: RunBaselineSchema.nullish(),
  created_at: z.string().nullish(),
});
export type ReviewRevisionRow = z.infer<typeof ReviewRevisionRowSchema>;

export const ReviewFindingRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  finding_id: z.string().min(1),
  review_id: z.string().min(1),
  /** Revision first seen on. */
  revision: z.number().int().nullish(),
  subject: z.string().nullish(),
  status: enumOf(REVIEW_FINDING_STATUSES),
  severity: enumOf(FINDING_SEVERITIES).nullish(),
  category: enumOf(FINDING_CATEGORIES).nullish(),
  kind: enumOf(FINDING_KINDS).nullish(),
  /** Link back to the review.json thread (findings-fragment merge). */
  thread_id: z.string().nullish(),
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  symbol: z.string().nullish(),
  repo: z.string().nullish(),
  body: z.string(),
  evidence: z.string().nullish(),
  suggested_fix: z.string().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  /** Human-marked blocking — AI may propose resolution, never
   *  self-resolves a blocking human finding (§15.8). */
  blocking: z.boolean().default(false),
  /** Security-dimension fields (§15.8, wp-150). */
  security_category: enumOf(SECURITY_CATEGORIES).nullish(),
  affected_asset: z.string().nullish(),
  exposure: z.string().nullish(),
  policy_violated: z.string().nullish(),
  author: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type ReviewFindingRow = z.infer<typeof ReviewFindingRowSchema>;

/** Semantic comment (§15.8) — AI proposes the classification; an
 *  `out-of-scope` comment routes to a ChangeSet (wp-140). */
export const ReviewCommentRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  comment_id: z.string().min(1),
  review_id: z.string().min(1),
  revision: z.number().int().nullish(),
  subject: z.string().nullish(),
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  type: enumOf(REVIEW_COMMENT_TYPES).nullish(),
  disposition: enumOf(REVIEW_COMMENT_DISPOSITIONS).nullish(),
  /** AI-proposed {type, disposition} before human confirmation. */
  ai_classification: z.record(z.unknown()).nullish(),
  body: z.string(),
  author: z.string().nullish(),
  /** ChangeSet this comment routed to (out-of-scope path). */
  changeset_id: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type ReviewCommentRow = z.infer<typeof ReviewCommentRowSchema>;

/** Append-only reviewer verdict bound to head SHA + spec baseline —
 *  post-approval code change → stale-approval (§15.8). Internal
 *  approvals never pose as GitHub approvals. */
export const ReviewDecisionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  decision_id: z.string().min(1),
  review_id: z.string().min(1),
  revision: z.number().int().nullish(),
  reviewer: z.string().min(1),
  action: enumOf(REVIEW_ACTIONS),
  head_sha: z.string().min(1),
  baseline: RunBaselineSchema.nullish(),
  rationale: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type ReviewDecisionRow = z.infer<typeof ReviewDecisionRowSchema>;

/** Finding lifecycle audit — terminal dispositions require
 *  `rationale` and a permissioned `actor` (§15.8). */
export const FindingResolutionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  finding_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  status: enumOf(REVIEW_FINDING_STATUSES),
  rationale: z.string().nullish(),
  actor: z.string().min(1),
  created_at: z.string().nullish(),
});
export type FindingResolutionRow = z.infer<typeof FindingResolutionRowSchema>;

/** Requirement-first review: finding → evidence edges (AC →
 *  implementing code → test evidence, §15.8). */
export const ReviewEvidenceLinkRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  review_id: z.string().min(1),
  finding_id: z.string().min(1),
  /** ev_… | doc:<subject>:<doc>:v<N> | run:<id>:<name> | ac:<id>. */
  evidence_ref: z.string().min(1),
  kind: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type ReviewEvidenceLinkRow = z.infer<typeof ReviewEvidenceLinkRowSchema>;

/** finding↔external-thread mapping — explicit + idempotent; GitHub
 *  stays authoritative for PR state (§15.8). */
export const ExternalReviewMappingRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  review_id: z.string().min(1),
  finding_id: z.string().nullish(),
  /** e.g. github-pr-review | github-comment. */
  external_kind: z.string().min(1),
  /** Platform-side id the mapping binds to. */
  external_id: z.string().min(1),
  created_at: z.string().nullish(),
});
export type ExternalReviewMappingRow = z.infer<
  typeof ExternalReviewMappingRowSchema
>;

/** Visual-AC / design approval — binds to a mockup revision; a
 *  material component change invalidates only affected approvals
 *  (§15.4, wp-149). */
export const DesignApprovalRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  approval_id: z.string().min(1),
  /** Feature/ticket the approved design belongs to. */
  subject: z.string().min(1),
  /** mockup.json doc + version approved. */
  doc: z.string().min(1),
  doc_version: z.number().int().positive(),
  /** Checklist results: desktop|mobile|flows|error-empty|a11y|… */
  checklist: z.record(z.unknown()).nullish(),
  /** Requirement/AC ids this approval covers. */
  covers: z.array(z.string()).nullish(),
  reviewer: z.string().min(1),
  rationale: z.string().nullish(),
  status: enumOf(DESIGN_APPROVAL_STATUSES),
  created_at: z.string().nullish(),
  invalidated_at: z.string().nullish(),
});
export type DesignApprovalRow = z.infer<typeof DesignApprovalRowSchema>;

// ---------- process machinery (PRD §15.10, wp-153) ----------

/** Assumption Register — auto-captured when a stage depends on
 *  unverified info; high-impact unverified rows gate or get
 *  risk-accepted by a human. */
export const AssumptionRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  assumption_id: z.string().min(1),
  subject: z.string().nullish(),
  /** The unverified statement being relied on. */
  statement: z.string().min(1),
  impact: enumOf(TICKET_PRIORITIES).nullish(),
  impact_if_false: z.string().nullish(),
  evidence_needed: z.string().nullish(),
  /** Affected artifact refs (json array). */
  affected: z.array(z.string()).nullish(),
  status: enumOf(ASSUMPTION_STATUSES),
  owner: z.string().nullish(),
  /** Run/stage that captured it. */
  source: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  resolved_at: z.string().nullish(),
});
export type AssumptionRow = z.infer<typeof AssumptionRowSchema>;

/** Quality Debt Register — owned, revisitable, consolidatable into
 *  modernization initiatives (§15.10). */
export const QualityDebtRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  debt_id: z.string().min(1),
  subject: z.string().nullish(),
  kind: enumOf(QUALITY_DEBT_KINDS),
  title: z.string().min(1),
  body: z.string().nullish(),
  owner: z.string().nullish(),
  /** When/what triggers a revisit (free text). */
  revisit: z.string().nullish(),
  /** Security exceptions expire loudly (wp-153). */
  expires_at: z.string().nullish(),
  /** Approval trail. */
  approved_by: z.string().nullish(),
  approved_at: z.string().nullish(),
  /** Modernization initiative/item this consolidated into. */
  consolidated_into: z.string().nullish(),
  status: enumOf(QUALITY_DEBT_STATUSES),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type QualityDebtRow = z.infer<typeof QualityDebtRowSchema>;

/** Delivery Commitment — versioned committed scope (§15.6):
 *  planned ≠ committed ≠ implemented ≠ verified ≠ delivered. Head =
 *  max(version) per commitment_id. */
export const DeliveryCommitmentRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  commitment_id: z.string().min(1),
  version: z.number().int().positive(),
  /** {features: [], requirement_versions: {…}} — the committed set. */
  scope: z.record(z.unknown()),
  /** Target release/date. */
  target: z.string().nullish(),
  success_criteria: z.string().nullish(),
  exclusions: z.string().nullish(),
  assumptions: z.string().nullish(),
  /** Accountable owner (design-for-both, D43). */
  owner: z.string().nullish(),
  status: enumOf(DELIVERY_COMMITMENT_STATUSES),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type DeliveryCommitmentRow = z.infer<typeof DeliveryCommitmentRowSchema>;

// ---------- eval lab (PRD §15.12, wp-156) ----------

/** Bake-off/eval execution — records model + prompt + policy versions
 *  against a golden set. */
export const EvalRunRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  eval_run_id: z.string().min(1),
  /** Task family (extraction|questions|rs-draft|review|coverage…). */
  family: z.string().min(1),
  model: z.string().nullish(),
  prompt_version: z.string().nullish(),
  policy_version: z.string().nullish(),
  status: enumOf(EVAL_RUN_STATUSES),
  metrics: z.record(z.unknown()).nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
  completed_at: z.string().nullish(),
});
export type EvalRunRow = z.infer<typeof EvalRunRowSchema>;

/** Golden-set case — one per (family, case_id). */
export const EvalCaseRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  family: z.string().min(1),
  case_id: z.string().min(1),
  input: z.record(z.unknown()),
  expected: z.record(z.unknown()),
  /** e.g. negation|qualifier — extraction eval slices (§15.9). */
  tags: z.array(z.string()).nullish(),
  created_at: z.string().nullish(),
});
export type EvalCaseRow = z.infer<typeof EvalCaseRowSchema>;

export const EvalResultRowSchema = z.object({
  workspace: z.string().min(1),
  org: z.string().nullish(),
  eval_run_id: z.string().min(1),
  family: z.string().min(1),
  case_id: z.string().min(1),
  verdict: enumOf(TEST_RESULTS),
  scores: z.record(z.unknown()).nullish(),
  detail: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type EvalResultRow = z.infer<typeof EvalResultRowSchema>;

// ---------- model routing (PRD §15.12, wp-155) ----------

/** One routing-registry entry — every AI interaction kind maps to
 *  primary + fallback + budgets in versioned config, never hardcoded
 *  (§15.12; the `models:` config section lands in wp-155). */
export const ModelRouteSchema = z.object({
  primary: z.string().min(1),
  fallback: z.array(z.string()).default([]),
  max_output_tokens: z.number().int().nullish(),
  schema_required: z.boolean().default(false),
  providers: z.array(z.string()).default([]),
  eval_threshold: z.number().min(0).max(1).nullish(),
  latency_class: enumOf(LATENCY_CLASSES).nullish(),
});
export type ModelRoute = z.infer<typeof ModelRouteSchema>;
