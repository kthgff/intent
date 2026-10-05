/**
 * Prompt renderer (wp-020) — renders the shipped templates in
 * `@sprint-runner/core` against the ADAPTERS.md token table.
 *
 * Fail-closed: every `{{TOKEN}}` in a template must resolve or the
 * render throws a RenderError naming the token, stage, and template.
 * No silent empties (AGENTS.md "malformed … blocks the pipeline").
 */
import {
  type CapabilityFlags,
  type DepthTier,
  PROMPT_TOKENS,
  type PromptToken,
  type RenderedPrompt,
  type Stage,
  type TokenValues,
  getPromptTemplate,
} from '@sprint-runner/core';

/**
 * Stage → prompt template name. `review` executes per-pass through the
 * `review-base` template (CONDUCTOR: "4 review passes"). `verify` runs
 * are detached runner tasks with no agent and no prompt → null.
 */
export const STAGE_TEMPLATES = {
  interview: 'interview',
  import: 'import',
  probe: 'probe',
  triage: 'triage',
  split: 'split',
  prd: 'prd',
  design: 'design',
  testplan: 'testplan',
  implement: 'implement',
  review: 'review-base',
  fix: 'fix',
  discuss: 'discuss',
  'ci-fix': 'ci-fix',
  'comment-fix': 'comment-fix',
  rebase: 'rebase',
  revert: 'revert',
  'doc-repair': 'doc-repair',
  escalate: 'escalate',
  survey: 'survey',
  verify: null,
  // Addendum stages (wp-131 freeze) — templates land with their owning
  // wps; mapped to null until then per the STAGES enum contract.
  'release-notes': null,
  retro: null,
  extract: null,
  mockup: null,
  'design-ingest': null,
} as const satisfies Record<Stage, string | null>;

/** Context handed to {@link renderPrompt} / {@link renderTemplate}. */
export interface RenderCtx {
  /** Caller-supplied token values (ADAPTERS token table). */
  tokens?: TokenValues;
  /** Backend capability flags — drive ARTIFACT_TARGETS + CAPABILITY_NOTES. */
  flags: CapabilityFlags;
  /** Run id (`runs/<runId>/`). */
  runId: string;
  /** Absolute path to the run's artifact dir (`runs/<runId>/`). */
  runDir: string;
  /** Absolute path to the worktree the run executes in. */
  worktree: string;
}

/** Render failure — names the unresolved token, stage, and template. */
export class RenderError extends Error {
  readonly token?: string;
  readonly stage?: string;
  readonly template?: string;

  constructor(
    message: string,
    opts: { token?: string; stage?: string; template?: string } = {},
  ) {
    super(message);
    this.name = 'RenderError';
    if (opts.token !== undefined) this.token = opts.token;
    if (opts.stage !== undefined) this.stage = opts.stage;
    if (opts.template !== undefined) this.template = opts.template;
  }
}

/** Whitespace-tolerant token pattern — matches `{{TOKEN}}` and `{{ TOKEN }}`. */
const TOKEN_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const KNOWN_TOKENS: ReadonlySet<string> = new Set(PROMPT_TOKENS);

/** Unique token names appearing in `text`, in first-use order. */
export function scanTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const name = match[1];
    if (name !== undefined) seen.add(name);
  }
  return [...seen];
}

/**
 * ARTIFACT_TARGETS block per ADAPTERS.md:
 * `can_write_outside_tree` → absolute `runs/<id>/` paths; otherwise a
 * worktree-relative `.sprint-runner/<run-id>/` scratch dir the runner
 * collects post-exit and purges (the diff never sees it).
 */
export function artifactTargets(
  flags: CapabilityFlags,
  runId: string,
  runDir: string,
): string {
  if (flags.can_write_outside_tree) {
    return [
      `${runDir}/ (absolute — write all run artifacts under this directory)`,
    ].join('\n');
  }
  return [
    `.sprint-runner/${runId}/ (worktree-relative scratch dir — write all`,
    `run artifacts under it. The runner collects them into runs/${runId}/`,
    'after your run exits and purges the scratch dir; the diff never sees',
    'them. Do NOT write artifacts anywhere else.)',
  ].join('\n');
}

/**
 * CAPABILITY_NOTES block — injected for the capabilities a backend
 * LACKS (ADAPTERS flag table → prompt shaping). Returns '' when the
 * backend has full capabilities (devin) so the token renders to
 * nothing rather than noise.
 */
export function capabilityNotes(flags: CapabilityFlags): string {
  const notes: string[] = [];
  if (!flags.can_exec) {
    notes.push(
      '- This backend cannot run shell commands — repo-card commands are' +
        ' omitted; name the checks you would run and the runner executes them.',
    );
  }
  if (!flags.can_write_outside_tree) {
    notes.push(
      '- This backend cannot write outside the repo tree — write artifacts' +
        ' to the scratch dir in ARTIFACT_TARGETS; the runner collects them' +
        ' post-exit.',
    );
  }
  if (!flags.has_gh) {
    notes.push(
      '- This backend cannot run `gh` — never push or open PRs; the runner' +
        ' owns push and PR creation.',
    );
  }
  return notes.length === 0
    ? ''
    : ['## Backend capabilities', ...notes].join('\n');
}

/**
 * Dossier wait gate (CONDUCTOR "Dossier wait"): `light`/`standard`
 * tickets flow with `dossier: pending` injected for {{DOSSIER}};
 * `deep`-tier tickets park until their scope's dossier exists.
 * Returns whether the stage may proceed.
 */
export function dossierGateOk(
  depth: DepthTier | string,
  dossierAvailable: boolean,
): boolean {
  if (depth === 'deep') return dossierAvailable;
  return true;
}

/**
 * Value to bind to {{DOSSIER}}: the dossier text when surveyed, else
 * `dossier pending` (light/standard tiers only — deep parks upstream
 * via {@link dossierGateOk}).
 */
export function dossierTokenValue(dossier: string | undefined): string {
  return dossier ?? 'dossier pending';
}

/**
 * Single-pass substitution of `{{TOKEN}}` occurrences in `text`.
 * `resolve` returns the replacement or undefined for unresolved.
 * Replacement text is never re-scanned (idempotent, deterministic).
 */
export function substitute(
  text: string,
  resolve: (token: string) => string | undefined,
): { text: string; resolved: string[]; unresolved: string[] } {
  const resolved = new Set<string>();
  const unresolved = new Set<string>();
  const out = text.replace(TOKEN_PATTERN, (_m, name: string) => {
    const value = resolve(name);
    if (value === undefined) {
      unresolved.add(name);
      return _m;
    }
    resolved.add(name);
    return value;
  });
  return { text: out, resolved: [...resolved], unresolved: [...unresolved] };
}

/**
 * Render a shipped template by name against `ctx`.
 * ARTIFACT_TARGETS and CAPABILITY_NOTES are computed from
 * `ctx.flags`/`ctx.runId`/`ctx.runDir` (capability shaping is the
 * renderer's job per ADAPTERS) and override any caller-supplied values.
 * Every remaining `{{TOKEN}}` must resolve from `ctx.tokens` — the
 * first unresolved token throws a RenderError.
 */
export function renderTemplate(
  templateName: string,
  ctx: RenderCtx,
): RenderedPrompt {
  const template = getPromptTemplate(templateName);
  const values: Record<string, string> = { ...(ctx.tokens ?? {}) };
  values.ARTIFACT_TARGETS = artifactTargets(ctx.flags, ctx.runId, ctx.runDir);
  values.CAPABILITY_NOTES = capabilityNotes(ctx.flags);

  const { text, resolved } = substitute(template, (token) => values[token]);

  const missing = scanTokens(template).find((t) => values[t] === undefined);
  if (missing !== undefined) {
    const known = KNOWN_TOKENS.has(missing)
      ? ''
      : ' (not in the ADAPTERS token table)';
    throw new RenderError(
      `unresolved token {{${missing}}}${known} in template '${templateName}'`,
      { token: missing, template: templateName },
    );
  }

  const tokens: TokenValues = {};
  for (const name of resolved) {
    tokens[name as PromptToken] = values[name] as string;
  }
  return { template: templateName, text, tokens };
}

/**
 * Render the prompt for a pipeline stage. Maps stage → template
 * (`review` → `review-base`; per-pass focus is injected via the
 * PASS_NAME/PASS_FOCUS tokens). `verify` has no agent prompt —
 * throws a RenderError.
 */
export function renderPrompt(stage: Stage, ctx: RenderCtx): RenderedPrompt {
  const templateName = STAGE_TEMPLATES[stage];
  if (templateName === null || templateName === undefined) {
    throw new RenderError(
      `no prompt template for stage '${stage}' (verify runs are detached runner tasks, no agent)`,
      { stage },
    );
  }
  try {
    return renderTemplate(templateName, ctx);
  } catch (err) {
    if (err instanceof RenderError && err.stage === undefined) {
      throw new RenderError(err.message, {
        ...(err.token !== undefined ? { token: err.token } : {}),
        stage,
        ...(err.template !== undefined ? { template: err.template } : {}),
      });
    }
    throw err;
  }
}
