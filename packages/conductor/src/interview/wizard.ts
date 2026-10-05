/**
 * interview/wizard.ts — versioned wizard definitions (PRD §15.9).
 *
 * `wizard_definitions` points at the live `wizard_versions` row; the
 * `definition` json declares required knowledge areas + thresholds +
 * prompt policy — *config, not code*. Versions are append-only
 * (insert-only): a wizard change is a new version, never an in-place
 * edit, so an in-flight session keeps the version it started on.
 *
 * Three MVP wizards ship here: solution-discovery, requirements-
 * discovery, tdd-discovery.
 */
import type {
  KnowledgeSlotRow,
  Store,
  WizardDefinitionRow,
  WizardVersionRow,
} from '@sprint-runner/core';
import { z } from 'zod';
import {
  DEFAULT_THRESHOLDS,
  type InterviewCtx,
  type SlotState,
  type WizardConfig,
  type WizardSlotSpec,
  type WizardThresholds,
  conflict,
  invalid,
  notFound,
} from './types.js';

const SLOT_STATES = [
  'known',
  'inferred',
  'missing',
  'conflicted',
  'not-applicable',
  'deferred',
] as const;

const StatementScopeSchema = z.enum([
  'org',
  'solution',
  'initiative',
  'feature',
  'repo',
  'ticket',
  'board',
]);

const StatementIntentSchema = z.enum([
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
]);

const SlotSpecSchema = z.object({
  slot: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  scope: StatementScopeSchema.optional(),
  question: z.string().optional(),
  accepts: z.array(StatementIntentSchema).optional(),
  impact: z.number().min(0).max(1).optional(),
});

const ThresholdsSchema = z.object({
  draft: z.array(z.enum(SLOT_STATES)),
  approval: z.array(z.enum(SLOT_STATES)),
});

/** Fail-closed wizard config schema — the `definition` json shape. */
export const WizardConfigSchema = z.object({
  wizard_id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.number().int().positive(),
  slots: z.array(SlotSpecSchema).min(1),
  thresholds: ThresholdsSchema.optional(),
  prompts: z.object({ planner: z.string().optional() }).optional(),
});

/**
 * Validate a wizard definition json fail-closed (AGENTS.md — malformed
 * config blocks rather than guessing). Also enforces: unique slot
 * names; at least one required slot; the approval set is a subset of
 * the draft set (a slot that can't draft can't approve).
 */
export function parseWizardConfig(definition: unknown): WizardConfig {
  const parsed = WizardConfigSchema.safeParse(definition);
  if (!parsed.success) {
    throw invalid(
      `wizard definition fails the config schema: ${parsed.error.message}`,
      parsed.error.issues,
    );
  }
  const cfg = parsed.data;
  const seen = new Set<string>();
  for (const s of cfg.slots) {
    if (seen.has(s.slot)) {
      throw invalid(`wizard '${cfg.wizard_id}': duplicate slot '${s.slot}'`);
    }
    seen.add(s.slot);
  }
  if (!cfg.slots.some((s) => s.required === true)) {
    throw invalid(
      `wizard '${cfg.wizard_id}': at least one required slot is needed for the readiness thresholds`,
    );
  }
  const thresholds = cfg.thresholds ?? DEFAULT_THRESHOLDS;
  const draft = new Set<SlotState>(thresholds.draft);
  for (const state of thresholds.approval) {
    if (!draft.has(state)) {
      throw invalid(
        `wizard '${cfg.wizard_id}': approval state '${state}' is not in the draft set — approval must be stricter than draft`,
      );
    }
  }
  return { ...cfg, thresholds };
}

/** Effective thresholds for a config (defaults applied). */
export function thresholdsOf(cfg: WizardConfig): WizardThresholds {
  return cfg.thresholds ?? DEFAULT_THRESHOLDS;
}

/** Slot spec lookup by name. */
export function slotSpec(
  cfg: WizardConfig,
  slot: string,
): WizardSlotSpec | undefined {
  return cfg.slots.find((s) => s.slot === slot);
}

export interface RegisterWizardResult {
  definition: WizardDefinitionRow;
  version: WizardVersionRow;
  /** False when this exact version already existed (insert-only — the
   *  register call is idempotent for a fixed config). */
  created: boolean;
}

/**
 * Register (or re-register) a wizard definition + one immutable
 * version. The definition's `current_version` is moved to the new
 * version; existing versions are never rewritten — registering an
 * already-published `(wizard_id, version)` with the same definition is
 * a no-op, and re-registering the SAME version with a DIFFERENT
 * definition is refused (append-only).
 */
export async function registerWizard(
  ctx: InterviewCtx,
  definition: unknown,
): Promise<RegisterWizardResult> {
  const cfg = parseWizardConfig(definition);
  const ts = ctx.now().toISOString();
  const existing = await ctx.store.getWizardVersion(
    { workspace: ctx.workspace, wizard_id: cfg.wizard_id },
    cfg.version,
  );
  if (existing) {
    if (JSON.stringify(existing.definition) !== JSON.stringify(cfg)) {
      throw conflict(
        `wizard '${cfg.wizard_id}' v${cfg.version} already exists with a different definition — versions are append-only`,
      );
    }
    const def = await requireDefinition(ctx.store, ctx.workspace, cfg.wizard_id);
    return { definition: def, version: existing, created: false };
  }

  const version: WizardVersionRow = {
    workspace: ctx.workspace,
    org: null,
    wizard_id: cfg.wizard_id,
    version: cfg.version,
    definition: cfg as unknown as Record<string, unknown>,
    created_at: ts,
  };
  await ctx.store.appendWizardVersion(version);

  const prior = await ctx.store.getWizardDefinition({
    workspace: ctx.workspace,
    wizard_id: cfg.wizard_id,
  });
  const row: WizardDefinitionRow = {
    workspace: ctx.workspace,
    org: null,
    wizard_id: cfg.wizard_id,
    name: cfg.name ?? prior?.name ?? null,
    description: cfg.description ?? prior?.description ?? null,
    current_version: cfg.version,
    created_at: prior?.created_at ?? ts,
    updated_at: ts,
  };
  await ctx.store.upsertWizardDefinition(row);
  return { definition: row, version, created: true };
}

async function requireDefinition(
  store: Store,
  workspace: string,
  wizardId: string,
): Promise<WizardDefinitionRow> {
  const def = await store.getWizardDefinition({
    workspace,
    wizard_id: wizardId,
  });
  if (!def) throw notFound(`no wizard '${wizardId}' in ${workspace}`);
  return def;
}

/**
 * Load a wizard config. When `version` is omitted the definition's
 * `current_version` (falling back to the latest version) is used — an
 * in-flight session passes the exact version it started on.
 */
export async function loadWizardConfig(
  ctx: InterviewCtx,
  wizardId: string,
  version?: number,
): Promise<WizardConfig> {
  let v = version;
  if (v === undefined) {
    const def = await requireDefinition(ctx.store, ctx.workspace, wizardId);
    v = def.current_version ?? undefined;
  }
  const row = await ctx.store.getWizardVersion(
    { workspace: ctx.workspace, wizard_id: wizardId },
    v,
  );
  if (!row) {
    throw notFound(
      `no wizard '${wizardId}'${v !== undefined ? ` v${v}` : ''} in ${ctx.workspace}`,
    );
  }
  return parseWizardConfig(row.definition);
}

/** Fresh slot rows for a session — required slots start `missing`,
 *  optional slots start `not-applicable` (they don't need answers). */
export function initialSlots(
  cfg: WizardConfig,
  key: { workspace: string; org?: string | null; sessionId: string },
  ts: string,
): KnowledgeSlotRow[] {
  return cfg.slots.map((spec) => ({
    workspace: key.workspace,
    org: key.org ?? null,
    session_id: key.sessionId,
    slot: spec.slot,
    state: spec.required === true ? 'missing' : 'not-applicable',
    value: null,
    statement_refs: [],
    confidence: null,
    updated_at: ts,
  }));
}

// ---------------------------------------------------------------------------
// MVP wizard configs (§15.9 "Three MVP wizard configs")
// ---------------------------------------------------------------------------

/** solution-discovery — the Solution creation / idea-discovery wizard. */
export const SOLUTION_DISCOVERY: WizardConfig = {
  wizard_id: 'solution-discovery',
  name: 'Solution discovery',
  description:
    'Problem-first discovery for a new solution: who feels the pain, what done looks like, and what constrains it.',
  version: 1,
  slots: [
    {
      slot: 'problem',
      label: 'Problem',
      required: true,
      scope: 'solution',
      question: 'What problem does this solution exist to solve?',
      accepts: ['problem', 'observation'],
      impact: 1,
    },
    {
      slot: 'audience',
      label: 'Audience',
      required: true,
      scope: 'solution',
      question: 'Who experiences this problem, and who else is affected?',
      accepts: ['observation', 'want'],
      impact: 0.9,
    },
    {
      slot: 'value',
      label: 'Value',
      required: true,
      scope: 'solution',
      question: 'What measurable outcome improves when this is solved?',
      accepts: ['requires', 'want'],
      impact: 0.9,
    },
    {
      slot: 'success-metrics',
      label: 'Success metrics',
      required: true,
      scope: 'solution',
      question: 'How will we know it worked — what can we measure?',
      accepts: ['requires', 'constraint'],
      impact: 0.8,
    },
    {
      slot: 'constraints',
      label: 'Constraints',
      required: false,
      scope: 'org',
      question: 'What constraints (budget, compliance, platform) apply?',
      accepts: ['constraint', 'prohibits'],
      impact: 0.6,
    },
    {
      slot: 'non-goals',
      label: 'Non-goals',
      required: false,
      scope: 'solution',
      question: 'What is explicitly out of scope?',
      accepts: ['avoid', 'prohibits'],
      impact: 0.5,
    },
    {
      slot: 'alternatives',
      label: 'Existing alternatives',
      required: false,
      scope: 'solution',
      question: 'What do people do today instead?',
      accepts: ['observation'],
      impact: 0.5,
    },
  ],
  thresholds: DEFAULT_THRESHOLDS,
};

/** requirements-discovery — turning intent into checkable requirements. */
export const REQUIREMENTS_DISCOVERY: WizardConfig = {
  wizard_id: 'requirements-discovery',
  name: 'Requirements discovery',
  description:
    'Turn agreed intent into functional/non-functional requirements with acceptance criteria.',
  version: 1,
  slots: [
    {
      slot: 'functional-requirements',
      label: 'Functional requirements',
      required: true,
      scope: 'feature',
      question: 'What must the system do, in observable terms?',
      accepts: ['requires', 'want'],
      impact: 1,
    },
    {
      slot: 'non-functional-requirements',
      label: 'Non-functional requirements',
      required: true,
      scope: 'feature',
      question:
        'What performance, reliability or scale expectations apply?',
      accepts: ['requires', 'constraint'],
      impact: 0.8,
    },
    {
      slot: 'acceptance-criteria',
      label: 'Acceptance criteria',
      required: true,
      scope: 'feature',
      question: 'When is a requirement demonstrably met?',
      accepts: ['requires', 'decision'],
      impact: 0.9,
    },
    {
      slot: 'edge-cases',
      label: 'Edge cases',
      required: false,
      scope: 'feature',
      question: 'What unusual inputs or states must still behave?',
      accepts: ['constraint', 'question'],
      impact: 0.6,
    },
    {
      slot: 'dependencies',
      label: 'Dependencies',
      required: false,
      scope: 'repo',
      question: 'What other systems or teams does this depend on?',
      accepts: ['constraint', 'assumption'],
      impact: 0.6,
    },
    {
      slot: 'compliance',
      label: 'Compliance',
      required: false,
      scope: 'org',
      question: 'Any regulatory or policy obligations?',
      accepts: ['constraint', 'prohibits'],
      impact: 0.5,
    },
  ],
  thresholds: DEFAULT_THRESHOLDS,
};

/** tdd-discovery — interfaces, data, errors, tests before code. */
export const TDD_DISCOVERY: WizardConfig = {
  wizard_id: 'tdd-discovery',
  name: 'TDD discovery',
  description:
    'Test-first discovery: interfaces, data model, error handling and the test strategy.',
  version: 1,
  slots: [
    {
      slot: 'interfaces',
      label: 'Interfaces',
      required: true,
      scope: 'repo',
      question: 'What are the public interfaces (functions, endpoints, events)?',
      accepts: ['requires', 'decision'],
      impact: 1,
    },
    {
      slot: 'data-model',
      label: 'Data model',
      required: true,
      scope: 'repo',
      question: 'What data is stored, and what are its invariants?',
      accepts: ['requires', 'constraint'],
      impact: 0.9,
    },
    {
      slot: 'error-handling',
      label: 'Error handling',
      required: true,
      scope: 'repo',
      question: 'How do failures surface, and what is retryable?',
      accepts: ['requires', 'constraint'],
      impact: 0.8,
    },
    {
      slot: 'test-strategy',
      label: 'Test strategy',
      required: true,
      scope: 'repo',
      question: 'What tests prove each behaviour, and at what level?',
      accepts: ['requires', 'decision'],
      impact: 0.9,
    },
    {
      slot: 'performance',
      label: 'Performance',
      required: false,
      scope: 'repo',
      question: 'What latency/throughput targets apply?',
      accepts: ['constraint'],
      impact: 0.5,
    },
    {
      slot: 'security',
      label: 'Security',
      required: false,
      scope: 'repo',
      question: 'What security properties must hold?',
      accepts: ['prohibits', 'constraint'],
      impact: 0.6,
    },
  ],
  thresholds: DEFAULT_THRESHOLDS,
};

/** The three MVP wizards (§15.9). */
export const MVP_WIZARDS: WizardConfig[] = [
  SOLUTION_DISCOVERY,
  REQUIREMENTS_DISCOVERY,
  TDD_DISCOVERY,
];

/** Seed the three MVP wizards (idempotent). */
export async function seedMvpWizards(
  ctx: InterviewCtx,
): Promise<RegisterWizardResult[]> {
  const out: RegisterWizardResult[] = [];
  for (const cfg of MVP_WIZARDS) {
    out.push(await registerWizard(ctx, cfg));
  }
  return out;
}
