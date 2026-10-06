/**
 * config.yaml schema — SETTINGS.md. Precedence (highest wins):
 * ticket frontmatter > tickets-repo config > global config > defaults.
 * Secrets live ONLY in .env / env vars — never here.
 */
import { z } from 'zod';
import {
  BACKENDS,
  DEPTH_TIERS,
  GATE_MODES,
  MERGE_STRATEGIES,
  PERMISSION_MODES,
  RUNTIMES,
  type Runtime,
} from './enums.js';
import { ModelRouteEntrySchema } from './schemas.js';

const enumOf = (values: readonly string[]) =>
  z.enum(values as [string, ...string[]]);

/** Repo card — written by the auto-probe run, `verified: true` required
 *  for repo-executing stages (SETTINGS; CONDUCTOR repo-card rule). */
export const RepoCardSchema = z.object({
  test: z.string().optional(),
  lint: z.string().optional(),
  build: z.string().optional(),
  /** Seed/setup command run to materialize a declared test environment
   *  before a verify/implement run (PRD §15.10, wp-157) — repo-card
   *  script; a `test_env.seed` spec list overrides it. */
  seed: z.string().optional(),
  forbidden_paths: z.array(z.string()).default([]),
  probed_at: z.string().nullish(),
  verified: z.boolean().default(false),
});
export type RepoCard = z.infer<typeof RepoCardSchema>;

export const RepoEntrySchema = z.object({
  path: z.string(),
  card: RepoCardSchema.optional(),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;

export const ProductSchema = z.object({
  repos: z.array(z.string()).default([]),
  docs: z.array(z.string()).default([]),
  screenshots: z.string().nullish(),
  app_url: z.string().nullish(),
  context_file: z.string().nullish(),
});
export type Product = z.infer<typeof ProductSchema>;

export const CapabilitiesSchema = z.object({
  can_exec: z.boolean(),
  can_write_outside_tree: z.boolean(),
  has_gh: z.boolean(),
  /** Per-backend runtime override (D30). Unset → the backend's declared
   *  runtime decides: container-capable backends follow
   *  `containers.runtime`, process-only backends stay `process`. */
  runtime: enumOf(RUNTIMES).optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** `containers:` settings block (SETTINGS, D30) — per-subject docker
 *  container runtime knobs. */
export const ContainersConfigSchema = z.object({
  /** Default runtime for container-capable backends; `process` =
   *  detached-OS-process fallback for every backend. */
  runtime: enumOf(RUNTIMES).default('container'),
  /** Shared agent base image — built from `docker/Dockerfile.agent` or
   *  pulled at conductor start when a container backend is in play. */
  image: z.string().min(1).default('veto/agent:latest'),
  /** `--cpus` cap for each subject container. */
  cpu: z.number().positive().default(2),
  /** `--memory` cap (docker units — `4g`, `512m`, …). */
  memory: z.string().min(1).default('4g'),
  /** `docker stop` the subject's container when it parks on a gate. */
  stop_on_gate: z.boolean().default(true),
});
export type ContainersConfig = z.infer<typeof ContainersConfigSchema>;

const asRuntime = (v: string | null | undefined): Runtime | null =>
  v === 'container' || v === 'process' ? v : null;

/**
 * Resolve a backend's effective runtime (D30):
 *   capabilities.<backend>.runtime override  — wins when set;
 *   else the adapter's declared CapabilityFlags.runtime —
 *     `container` (container-capable) → `containers.runtime` decides;
 *     `process` / undeclared → `process` (a backend never gets promoted
 *     into a container it didn't declare — fail-closed).
 */
export function resolveRuntime(opts: {
  /** `capabilities.<backend>.runtime` from config. */
  override?: string | null | undefined;
  /** Adapter-declared `CapabilityFlags.runtime`. */
  declared?: string | null | undefined;
  /** `containers.runtime` global default. */
  global?: string | undefined;
}): Runtime {
  const override = asRuntime(opts.override);
  if (override !== null) return override;
  if (asRuntime(opts.declared) === 'container') {
    return asRuntime(opts.global) ?? 'container';
  }
  return asRuntime(opts.declared) ?? 'process';
}

export const SurveyConfigSchema = z.object({
  refresh: z.enum(['weekly', 'daily', 'manual']).default('weekly'),
  timeout: z.number().int().positive().default(7200),
  budget_usd: z.number().nullish(),
  sources: z
    .array(z.string())
    .default(['code', 'docs', 'screenshots', 'crawl']),
});
export type SurveyConfig = z.infer<typeof SurveyConfigSchema>;

export const BudgetsSchema = z.object({
  spend_cap_usd_per_ticket: z.number().nullish(),
  tokens_cap_per_ticket: z.number().int().nullish(),
  shepherd_max_cycles: z.number().int().default(5),
  fix_dismissal_cap: z.number().int().default(2),
  split_max_children: z.number().int().default(5),
});
export type Budgets = z.infer<typeof BudgetsSchema>;

export const SemanticConfigSchema = z.object({
  embeddings: z.enum(['local', 'openrouter', 'off']).default('local'),
  embedding_model: z.string().nullish(),
  entity_linking: z.boolean().default(true),
  dedupe: z.boolean().default(true),
});
export type SemanticConfig = z.infer<typeof SemanticConfigSchema>;

/** `intelligence:` settings block (SETTINGS "evidence plane / code
 *  intelligence", D37, wp-111) — retrieval grounding, the RS quality
 *  pass, and traceability-link verification knobs. */
export const IntelligenceConfigSchema = z.object({
  /** Commit-pinned code index; off → retrieval degrades honestly. */
  code_index: z.boolean().default(true),
  /** Master switch for stage evidence bundles ({{EVIDENCE_BUNDLE}});
   *  off → stages render the explicit "grounding disabled" block. */
  grounding: z.boolean().default(true),
  index_on_project_connect: z.boolean().default(true),
  reindex_on_default_branch_change: z.boolean().default(true),
  parser: z.string().default('tree-sitter'),
  incremental: z.boolean().default(true),
  /** Hard per-request result cap for stage evidence bundles. */
  max_results: z.number().int().positive().default(20),
  /** Hard token budget for a stage's evidence bundle. */
  context_tokens: z.number().int().positive().default(8000),
  /** false = `commit_policy: current` — only the current index head is
   *  served; true = `allow-stale` — a superseded head may be served,
   *  labeled `stale` (never silently current). */
  allow_stale: z.boolean().default(false),
  structural_depth: z.number().int().positive().default(2),
  /** The cited AI RS-quality pass (INTELLIGENCE §5); false → the prd
   *  stage skips the rs-quality.json contract. spec_score is never
   *  replaced or altered either way. */
  prd_quality: z.boolean().default(true),
  /** `block` = unresolved critical findings hold the `rs-quality` gate
   *  until a human resolves/waives them; `advisory` = surfaced for
   *  information only. Never auto-approves either way. */
  critical_prd_findings: z.enum(['block', 'advisory']).default('block'),
  /** Model-proposed relation links at confidence ≥ this land
   *  `auto-verified` (visibly labeled automated); below it they need a
   *  human `verified` decision (INTELLIGENCE §1, §12). */
  auto_verify_confidence: z.number().min(0).max(1).default(0.9),
  /** Phase B continuous-alignment mode (wp-112). */
  alignment: z.enum(['off', 'manual', 'on-merge']).default('off'),
  /** Path/ref to the versioned retrieval golden set. */
  evaluation_suite: z.string().nullish(),
  /** Extra generated/vendor/forbidden globs for the indexer. */
  exclude: z.array(z.string()).default([]),
});
export type IntelligenceConfig = z.infer<typeof IntelligenceConfigSchema>;

export const ImportersConfigSchema = z.object({
  github: z.object({ token_env: z.string().optional() }).optional(),
  jira: z
    .object({
      base_url: z.string().nullish(),
      token_env: z.string().optional(),
    })
    .optional(),
  default_repo_map: z.record(z.string()).default({}),
});
export type ImportersConfig = z.infer<typeof ImportersConfigSchema>;

/** `scope_budgets:` settings block (PRD §15.5 safeguards, wp-142) —
 *  Scope Creep Radar thresholds. Every knob is a hard ceiling; a
 *  ChangeSet whose computed radar breaches ANY configured threshold is
 *  escalated to the `scope-budget` gate (higher human approval) before
 *  it may be decided/applied. Unset keys never fire. */
export const ScopeBudgetsSchema = z.object({
  /** Cumulative cost_usd of the change's blast radius (events ledger). */
  cost_usd: z.number().nonnegative().nullish(),
  /** Schedule drift — baseline age in days (pinned baseline version →
   *  now) beyond which change volume is escalation-worthy. */
  schedule_days: z.number().nonnegative().nullish(),
  /** Scope churn: (items added + removed) ÷ baseline scope size, as a
   *  fraction (0.25 = 25%). */
  scope_pct: z.number().nonnegative().nullish(),
  /** Post-approval changesets against the same baseline subject. */
  post_approval_changes: z.number().int().nonnegative().nullish(),
  /** Rework events in the blast radius (changes-requested loops,
   *  fix rounds, invalidated/expired approvals). */
  rework_events: z.number().int().nonnegative().nullish(),
  /** Running executions the change would interrupt (wp-141). */
  affected_executions: z.number().int().nonnegative().nullish(),
});
export type ScopeBudgets = z.infer<typeof ScopeBudgetsSchema>;

export const SecurityConfigSchema = z.object({
  scanner: z.enum(['gitleaks', 'trufflehog']).default('gitleaks'),
  /** FAIL-CLOSED — scan error/finding blocks the commit (SETTINGS). */
  scan_on_commit: z.boolean().default(true),
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const UiConfigSchema = z.object({
  bind: z.string().default('127.0.0.1'),
  port: z.number().int().default(4711),
  token_file: z.string().optional(),
  remote_access: z.boolean().default(false),
  /** Per-column WIP soft limits for the S-01 board (s-01 "WIP
   *  warnings") — `{backlog|spec|build|review|done}: n`. Exceeding a
   *  limit tints the column header amber; it never blocks drops. */
  wip_limits: z
    .record(
      z.enum(['backlog', 'spec', 'build', 'review', 'done']),
      z.number().int().positive(),
    )
    .default({}),
});
export type UiConfig = z.infer<typeof UiConfigSchema>;

export const ReviewConfigSchema = z.object({
  auto_fix_severities: z.array(z.string()).default(['blocker', 'major']),
  auto_fix_rounds: z.number().int().default(2),
});
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

export const ConfigSchema = z.object({
  schema: z.literal(1),
  /** REQUIRED — this install's identity (SETTINGS). */
  actor: z.string().nullish(),
  backend: enumOf(BACKENDS).default('devin'),
  permission_mode: enumOf(PERMISSION_MODES).default('smart'),
  main_model: z.string().nullish(),
  review_model: z.string().nullish(),
  escalation_model: z.string().nullish(),
  /** Model routing registry (PRD §15.12, SCHEMAS §21, wp-155): every
   *  AI interaction kind → a ModelRoute entry. Values are SPARSE —
   *  unset fields inherit `models.default`, then the legacy
   *  `main_model`/`review_model`/`escalation_model` knobs, at
   *  resolution time (@veto/prompts routing). Reserved keys:
   *  `default` (base layer for every kind) and `escalation` (the
   *  retry-ladder step-up tier). Stage names resolve as kinds. */
  models: z.record(ModelRouteEntrySchema).default({}),
  capabilities: z.record(CapabilitiesSchema).default({}),
  /** Per-subject docker containers (D30) — image, resource caps,
   *  gate-park behavior, global runtime default. */
  containers: ContainersConfigSchema.default({}),
  repos: z.record(RepoEntrySchema).default({}),
  products: z.record(ProductSchema).default({}),
  survey: SurveyConfigSchema.default({}),
  gates: enumOf(GATE_MODES).default('full'),
  spec_depth: enumOf(DEPTH_TIERS).default('standard'),
  merge_strategy: enumOf(MERGE_STRATEGIES).default('squash'),
  concurrency: z.object({ implement: z.number().int().default(1) }).default({}),
  worktree_root: z.string().default('sibling'),
  timeouts: z.record(z.number().int().positive()).default({}),
  shepherd: z
    .object({ poll_interval_s: z.number().int().default(60) })
    .default({}),
  budgets: BudgetsSchema.default({}),
  /** Scope Creep Radar thresholds (PRD §15.5, wp-142). */
  scope_budgets: ScopeBudgetsSchema.default({}),
  prior_art_recall: z.boolean().default(true),
  semantic: SemanticConfigSchema.default({}),
  /** Evidence plane / code intelligence (SETTINGS, D37, wp-111). */
  intelligence: IntelligenceConfigSchema.default({}),
  /** Postgres only (D29); PGlite powers tests. */
  storage_url: z.string().default('postgres://localhost:5432/veto'),
  importers: ImportersConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  ui: UiConfigSchema.default({}),
  voice: z.enum(['auto', 'off']).default('auto'),
  notifications: z
    .object({
      desktop: z.boolean().default(true),
      badge: z.boolean().default(true),
    })
    .default({}),
  review: ReviewConfigSchema.default({}),
});
export type Config = z.infer<typeof ConfigSchema>;
