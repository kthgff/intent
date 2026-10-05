/**
 * zod schemas for every structured artifact in SCHEMAS.md.
 * Fail-closed: runners parse with `.strict()`-grade discipline — unknown
 * structured output blocks the pipeline rather than guessing (AGENTS.md).
 */
import { z } from 'zod';
import {
  ACTOR_TYPES,
  BACKENDS,
  BOARD_ITEM_KINDS,
  BOARD_ITEM_STATUSES,
  CALL_USAGE_SOURCES,
  CI_STATES,
  CONTAINER_STATES,
  COVERAGE_KINDS,
  DEPTH_TIERS,
  DEVIATION_REASON_KINDS,
  DOC_KINDS,
  DOSSIER_SCOPES,
  DOSSIER_SECTIONS,
  DOSSIER_SOURCES,
  ENTITY_KINDS,
  ENTITY_SOURCES,
  EVENT_NAMES,
  FEATURE_STATUSES,
  FINDING_CATEGORIES,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  GAP_KINDS,
  GATE_KINDS,
  INITIATIVE_STATUSES,
  PR_STATES,
  QUESTION_FORMATS,
  QUESTION_STATUSES,
  RELATION_PREDICATES,
  RELATION_SOURCES,
  RELATION_VERIFICATIONS,
  RUN_STATUSES,
  SENTINELS,
  TEST_CASE_TYPES,
  TEST_RESULTS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
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

/** test.md case row (§4). */
export const TestCaseRowSchema = z.object({
  case_id: z.string().min(1),
  title: z.string(),
  type: enumOf(TEST_CASE_TYPES),
  file: z.string(),
  covers: z.string(),
});
export type TestCaseRow = z.infer<typeof TestCaseRowSchema>;

/** test.md coverage-matrix row (§4); `case_ids` may be `n/a` for
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
  name: z.string().nullish(),
  next_ticket_seq: z.number().int().default(1),
  next_feature_seq: z.number().int().default(1),
  next_initiative_seq: z.number().int().default(1),
  settings: z.record(z.unknown()).default({}),
  created_at: z.string().nullish(),
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const BoardRowSchema = z.object({
  workspace: z.string().min(1),
  board: z.string().min(1),
  name: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type BoardRow = z.infer<typeof BoardRowSchema>;

export const BoardItemSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  /** NULL = capture tray (D27). */
  board: z.string().nullish(),
  kind: enumOf(BOARD_ITEM_KINDS),
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
  feature: z.string().min(1),
  initiative: z.string().nullish(),
  title: z.string(),
  status: enumOf(FEATURE_STATUSES),
  owner: z.string().nullish(),
  priority: enumOf(TICKET_PRIORITIES).nullish(),
  /** D33: goal board_item ids — inherited from initiative, direct
   *  override allowed. */
  serves: z.array(z.string()).nullish(),
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
