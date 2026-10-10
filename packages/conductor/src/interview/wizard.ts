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
import {
  BOARD_TYPES,
  type BoardItem,
  type BoardType,
  type KnowledgeSlotRow,
  type NoteKind,
  type Store,
  type WizardDefinitionRow,
  type WizardVersionRow,
} from '@veto/core';
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
    const def = await requireDefinition(
      ctx.store,
      ctx.workspace,
      cfg.wizard_id,
    );
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
      question: 'What performance, reliability or scale expectations apply?',
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
      question:
        'What are the public interfaces (functions, endpoints, events)?',
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

// ---------------------------------------------------------------------------
// Board wizard configs (BOARD-CHAT-TDD "Board wizard configs", wp-163)
// ---------------------------------------------------------------------------

/** Per-type copy — the shared slot shape is fixed; the label/question
 *  wording and any extra slots vary by board type. */
type BoardSlotCopy = Pick<WizardSlotSpec, 'label' | 'question'>;

interface BoardWizardVoice {
  name: string;
  description: string;
  goals: BoardSlotCopy;
  problems: BoardSlotCopy;
  wants: BoardSlotCopy;
  constraints: BoardSlotCopy;
  /** Type-specific extra slots (TDD per-type extras row). */
  extras?: WizardSlotSpec[];
}

const BOARD_GENERIC_VOICE: BoardWizardVoice = {
  name: 'Board discovery',
  description:
    'Goals-first discovery for an untyped board — the generic shape every board-<type> wizard shares.',
  goals: {
    label: 'Goals',
    question: 'What is this board for — what are its goals?',
  },
  problems: {
    label: 'Problems',
    question: 'What problems does this board capture?',
  },
  wants: {
    label: 'Wants',
    question: 'What does this board want to see happen?',
  },
  constraints: {
    label: 'Constraints',
    question: 'What constraints apply to this board?',
  },
};

const BOARD_WIZARD_VOICES: Record<BoardType, BoardWizardVoice> = {
  'new-project': {
    name: 'New project board',
    description:
      'Greenfield discovery on a new-project board: goals first, then the coverage synthesis needs.',
    goals: {
      label: 'Goals',
      question:
        'What is this project trying to achieve — what does done look like?',
    },
    problems: {
      label: 'Problems',
      question: 'What problem or pain does this project exist to solve?',
    },
    wants: {
      label: 'Wants',
      question: 'What do stakeholders want out of this project?',
    },
    constraints: {
      label: 'Constraints',
      question:
        'What constraints apply — budget, platform, compliance, deadlines?',
    },
  },
  import: {
    name: 'Import board',
    description:
      'Discovery over an imported board: what the imported scope is for and what must survive the import intact.',
    goals: {
      label: 'Goals',
      question: 'What should this imported scope accomplish — what is it for?',
    },
    problems: {
      label: 'Problems',
      question: 'What is broken, missing, or wrong in the imported set?',
    },
    wants: {
      label: 'Wants',
      question: 'What do we want to keep, fix, or drop from the source?',
    },
    constraints: {
      label: 'Constraints',
      question: 'What limits the import — formats, permissions, mapping rules?',
    },
    extras: [
      {
        slot: 'source-fidelity',
        label: 'Source fidelity',
        required: true,
        scope: 'board',
        question:
          'What must match the source exactly — ids, statuses, wording?',
        accepts: ['requires', 'constraint'],
        impact: 0.6,
      },
    ],
  },
  enhancement: {
    name: 'Enhancement board',
    description:
      'Discovery on an enhancement board: what the existing capability should become.',
    goals: {
      label: 'Goals',
      question:
        'What should this capability become — what does better look like?',
    },
    problems: {
      label: 'Gaps',
      question: 'What is missing or weak in the current behaviour?',
    },
    wants: {
      label: 'Requests',
      question: 'What improvements are being asked for?',
    },
    constraints: {
      label: 'Constraints',
      question:
        'What must keep working — compatibility, APIs, migration limits?',
    },
  },
  modernization: {
    name: 'Modernization board',
    description:
      'Discovery on a modernization board: the target state and the legacy pain driving it.',
    goals: {
      label: 'Target state',
      question: 'What is the target state — architecture, stack, platform?',
    },
    problems: {
      label: 'Legacy pain',
      question: 'What legacy pain drives this — debt, scaling, cost?',
    },
    wants: {
      label: 'Wants',
      question: 'What should the modernization deliver?',
    },
    constraints: {
      label: 'Migration limits',
      question:
        'What constrains the migration — downtime, parity, dependencies?',
    },
  },
  quality: {
    name: 'Quality board',
    description:
      'Discovery on a quality board: the quality bar, where it fails, and the gates that must hold.',
    goals: {
      label: 'Quality bar',
      question: 'What quality bar is this board aiming for?',
    },
    problems: {
      label: 'Defects & risks',
      question: 'Where is quality failing — defects, flake, risk?',
    },
    wants: {
      label: 'Improvements',
      question: 'What quality improvements are wanted?',
    },
    constraints: {
      label: 'Standards',
      question: 'What quality gates or standards must hold?',
    },
  },
  feedback: {
    name: 'Feedback board',
    description:
      'Discovery on a feedback board: what the feedback should drive, its themes, and its severity.',
    goals: {
      label: 'Goals',
      question:
        'What should this feedback drive — a fix, a feature, a decision?',
    },
    problems: {
      label: 'Reported problems',
      question: 'What problems does the feedback report?',
    },
    wants: {
      label: 'Requests',
      question: 'What are users asking for?',
    },
    constraints: {
      label: 'Limits',
      question: 'What limits the response — policy, scope, commitments?',
    },
    extras: [
      {
        slot: 'themes',
        label: 'Themes',
        required: true,
        scope: 'board',
        question: 'What themes recur across the feedback?',
        accepts: ['observation', 'problem'],
        impact: 0.6,
      },
      {
        slot: 'severity',
        label: 'Severity',
        required: true,
        scope: 'board',
        question:
          'How severe is the feedback — what breaks, blocks, or merely annoys?',
        accepts: ['problem', 'observation'],
        impact: 0.6,
      },
    ],
  },
  'release-planning': {
    name: 'Release-planning board',
    description:
      'Discovery on a release-planning board: the targets the release must hit and the criteria for cutting scope.',
    goals: {
      label: 'Release goals',
      question: 'What is this release for — the outcome it must deliver?',
    },
    problems: {
      label: 'Risks',
      question: 'What risks or gaps threaten the release?',
    },
    wants: {
      label: 'Scope wants',
      question: 'What do we want in this release?',
    },
    constraints: {
      label: 'Release limits',
      question: 'What fixes the release — dates, scope, dependencies?',
    },
    extras: [
      {
        slot: 'targets',
        label: 'Targets',
        required: true,
        scope: 'board',
        question:
          'What are the concrete release targets — scope, dates, milestones?',
        accepts: ['requires', 'decision'],
        impact: 0.6,
      },
      {
        slot: 'cut-criteria',
        label: 'Cut criteria',
        required: true,
        scope: 'board',
        question: 'When the release is at risk, what gets cut first?',
        accepts: ['decision', 'constraint'],
        impact: 0.6,
      },
    ],
  },
  exploration: {
    name: 'Exploration board',
    description:
      'Discovery on an exploration board: what it is trying to learn or decide.',
    goals: {
      label: 'Goals',
      question: 'What is this exploration trying to learn or decide?',
    },
    problems: {
      label: 'Unknowns',
      question: 'What is unclear or unproven?',
    },
    wants: {
      label: 'Wants',
      question: 'What should come out of the exploration?',
    },
    constraints: {
      label: 'Bounds',
      question: 'What bounds the exploration — time, budget, scope?',
    },
  },
};

/**
 * Build one `board-<type>` wizard: the shared slot shape (required
 * `goals`/`problems`/`wants`/`constraints`, optional
 * `avoids`/`open-questions`/`decisions`) with per-type copy + extras.
 * `goals` carries the top impact so the planner asks it first.
 */
function boardWizard(wizardId: string, voice: BoardWizardVoice): WizardConfig {
  const slot = (
    name: string,
    copy: BoardSlotCopy,
    accepts: WizardSlotSpec['accepts'],
    impact: number,
  ): WizardSlotSpec => ({
    slot: name,
    required: true,
    scope: 'board',
    accepts,
    impact,
    ...copy,
  });
  return {
    wizard_id: wizardId,
    name: voice.name,
    description: voice.description,
    version: 1,
    slots: [
      slot('goals', voice.goals, ['want', 'requires'], 1),
      slot('problems', voice.problems, ['problem', 'observation'], 0.9),
      slot('wants', voice.wants, ['want', 'requires'], 0.8),
      slot('constraints', voice.constraints, ['constraint', 'prohibits'], 0.7),
      ...(voice.extras ?? []),
      {
        slot: 'avoids',
        label: 'Avoids',
        required: false,
        scope: 'board',
        question: 'What is explicitly out of scope or to be avoided?',
        accepts: ['avoid', 'prohibits'],
        impact: 0.5,
      },
      {
        slot: 'open-questions',
        label: 'Open questions',
        required: false,
        scope: 'board',
        question: 'What is still unknown or undecided?',
        accepts: ['question'],
        impact: 0.4,
      },
      {
        slot: 'decisions',
        label: 'Decisions',
        required: false,
        scope: 'board',
        question: 'What has already been decided?',
        accepts: ['decision'],
        impact: 0.4,
      },
    ],
    thresholds: DEFAULT_THRESHOLDS,
  };
}

/** The wizard a board resolves: `board-<board_type>`, `board-generic`
 *  when `board_type` is NULL. */
export function boardWizardId(boardType: string | null | undefined): string {
  return boardType ? `board-${boardType}` : 'board-generic';
}

/** `board-<type>` for every `BOARD_TYPES` value + `board-generic`. */
export const BOARD_WIZARDS: WizardConfig[] = [
  boardWizard('board-generic', BOARD_GENERIC_VOICE),
  ...BOARD_TYPES.map((t) => boardWizard(`board-${t}`, BOARD_WIZARD_VOICES[t])),
];

/** Seed the board wizard catalog (idempotent — the lazy session-start
 *  path; GETs stay read-only). */
export async function seedBoardWizards(
  ctx: InterviewCtx,
): Promise<RegisterWizardResult[]> {
  const out: RegisterWizardResult[] = [];
  for (const cfg of BOARD_WIZARDS) {
    out.push(await registerWizard(ctx, cfg));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage seeding — "goals-first is a seeding rule, not a prompt hack"
// ---------------------------------------------------------------------------

/**
 * Slot → `note_kind` coverage map. `goals` is deliberately absent —
 * the taxonomy has no `goal` note_kind; goal-ness is conferred by
 * *being a serves target* (D33), checked via {@link goalItemIds}.
 */
const BOARD_SLOT_NOTE_KINDS = {
  problems: 'problem',
  wants: 'want',
  constraints: 'constraint',
  avoids: 'avoid',
  'open-questions': 'question',
  decisions: 'decision',
} as const satisfies Record<string, NoteKind>;

/** The goal set on a board (D33): ids that are `serves` targets —
 *  `id ∈ ⋃ serves`, restricted to items present. */
export function goalItemIds(items: readonly BoardItem[]): Set<string> {
  const ids = new Set(items.map((i) => i.id));
  const goals = new Set<string>();
  for (const i of items) {
    for (const target of i.serves ?? []) {
      if (ids.has(target)) goals.add(target);
    }
  }
  return goals;
}

/** Goal-ness derives — an item is a goal iff it is a serves target. */
export function isGoalItem(
  itemId: string,
  items: readonly BoardItem[],
): boolean {
  return goalItemIds(items).has(itemId);
}

/**
 * Deterministic board coverage: `goals` is covered when ≥1 live item
 * is a `serves` target; every other mapped slot is covered by ≥1 live
 * item carrying its `note_kind`. `discarded` items are off the board —
 * they cover nothing.
 */
export function boardSlotCoverage(
  items: readonly BoardItem[],
): ReadonlySet<string> {
  const live = items.filter((i) => i.status !== 'discarded');
  const covered = new Set<string>();
  if (goalItemIds(live).size > 0) covered.add('goals');
  const kinds = new Set(live.map((i) => i.note_kind));
  for (const [slot, kind] of Object.entries(BOARD_SLOT_NOTE_KINDS)) {
    if (kinds.has(kind)) covered.add(slot);
  }
  return covered;
}

function boardSlugOfSubject(subject: string | null): string | null {
  return subject?.startsWith('board:') ? subject.slice('board:'.length) : null;
}

/**
 * Coverage seeding at session start / run start: upgrade this board
 * session's `missing` slots to `inferred` where the board already
 * covers them — covered slots are confirmable in the Understanding
 * tab, never re-asked. Only `missing → inferred`; user-set and
 * derived states are never rewritten. The board defaults to the
 * session's `board:<slug>` subject.
 */
export async function seedBoardSlots(
  ctx: InterviewCtx,
  args: { sessionId: string; board?: string | null },
): Promise<KnowledgeSlotRow[]> {
  const session = await ctx.store.getInterviewSession({
    workspace: ctx.workspace,
    session_id: args.sessionId,
  });
  if (!session) {
    throw notFound(
      `no interview session '${args.sessionId}' in ${ctx.workspace}`,
    );
  }
  const board = args.board ?? boardSlugOfSubject(session.subject ?? null);
  if (!board) {
    throw invalid(
      `no board for session ${args.sessionId} — pass board or give the session a 'board:<slug>' subject`,
    );
  }
  const items = await ctx.store.listBoardItems({
    workspace: ctx.workspace,
    board,
  });
  const covered = boardSlotCoverage(items);
  const ts = ctx.now().toISOString();
  const seeded: KnowledgeSlotRow[] = [];
  const rows = await ctx.store.listKnowledgeSlots({
    workspace: ctx.workspace,
    session_id: args.sessionId,
  });
  for (const row of rows) {
    if (row.state !== 'missing' || !covered.has(row.slot)) continue;
    const next: KnowledgeSlotRow = {
      ...row,
      state: 'inferred',
      updated_at: ts,
    };
    await ctx.store.upsertKnowledgeSlot(next);
    seeded.push(next);
  }
  return seeded;
}
