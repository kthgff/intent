/**
 * review/security.ts — the security review dimension (PRD §15.8, wp-150).
 *
 * Security is a review DIMENSION, not just a scanner verdict. This
 * engine sits on top of the wp-148 Review Studio entities and owns the
 * rules the spec pins:
 *
 *   - security findings carry the full field set — `security_category`
 *     (the wp-131 taxonomy), `affected_asset`, `exposure`,
 *     `policy_violated` — and a security finding missing them fails
 *     CLOSED (the gate can't assess what it can't read);
 *   - risk-tiered enforcement: low → baseline scans + standard review,
 *     medium → targeted checks + normal approval, high → dedicated
 *     analysis + designated reviewer, critical → blocks merge AND
 *     release until resolved or covered by a tightly-controlled
 *     exception (owner + expiry + rationale);
 *   - blocking security findings cannot be waived by an agent — only a
 *     human grants an exception, and the exception is a `quality_debt`
 *     row of kind `security-exception` that EXPIRES LOUDLY;
 *   - security review starts at DESIGN time: a sensitive-scope change
 *     must carry a `## Threat model` section (the design-time gate);
 *   - scanner results (gitleaks/trufflehog) MAP to findings — never to
 *     a silent pass/fail. Disposition stays human/policy, and a
 *     scanner error fails closed.
 *
 * The engine is a thin semantic layer over the store, exactly like the
 * rest of `review/studio` — `Store` owns the rows, this file owns the
 * rules. `StudioCtx` keeps it callable from both conductor paths and
 * the API.
 */
import {
  type AgentFinding,
  type FindingSeverity,
  type QualityDebtRow,
  type ReviewFindingRow,
  SECURITY_CATEGORIES,
  type SecurityCategory,
} from '@veto/core';
import type { FindingActorKind } from './studio/findings.js';
import { requireSession } from './studio/session.js';
import {
  type StudioCtx,
  forbidden,
  invalid,
  notFound,
} from './studio/types.js';

// ---------------------------------------------------------------------------
// Risk tiers + risk-tiered enforcement
// ---------------------------------------------------------------------------

/**
 * Risk tiers (PRD §15.8 "risk-tiered enforcement"). Engine-local — no
 * DB column and no SETTINGS key, so this is policy, not contract.
 */
export const SECURITY_RISK_TIERS = [
  'low',
  'medium',
  'high',
  'critical',
] as const;
export type SecurityRiskTier = (typeof SECURITY_RISK_TIERS)[number];

/** What a tier turns on. `blocks_*` is the fail-closed tail. */
export interface SecurityEnforcement {
  tier: SecurityRiskTier;
  /** Baseline scanners (gitleaks/trufflehog) run. */
  baseline_scans: boolean;
  /** Targeted checks for the category surface run. */
  targeted_checks: boolean;
  /** A dedicated security analysis pass runs. */
  dedicated_analysis: boolean;
  /** A designated reviewer (not the author) must sign off. */
  designated_reviewer: boolean;
  /** Critical: unresolved findings block the merge gate. */
  blocks_merge: boolean;
  /** Critical: unresolved findings block the release gate. */
  blocks_release: boolean;
  /** Whether a tightly-controlled exception (owner + expiry) is even
   *  allowed. Critical findings may only be waived through it. */
  exception_allowed: boolean;
}

const ENFORCEMENT: Record<SecurityRiskTier, SecurityEnforcement> = {
  low: {
    tier: 'low',
    baseline_scans: true,
    targeted_checks: false,
    dedicated_analysis: false,
    designated_reviewer: false,
    blocks_merge: false,
    blocks_release: false,
    exception_allowed: false,
  },
  medium: {
    tier: 'medium',
    baseline_scans: true,
    targeted_checks: true,
    dedicated_analysis: false,
    designated_reviewer: false,
    blocks_merge: false,
    blocks_release: false,
    exception_allowed: false,
  },
  high: {
    tier: 'high',
    baseline_scans: true,
    targeted_checks: true,
    dedicated_analysis: true,
    designated_reviewer: true,
    blocks_merge: false,
    blocks_release: false,
    exception_allowed: false,
  },
  critical: {
    tier: 'critical',
    baseline_scans: true,
    targeted_checks: true,
    dedicated_analysis: true,
    designated_reviewer: true,
    blocks_merge: true,
    blocks_release: true,
    exception_allowed: true,
  },
};

/** Enforcement policy for a tier (copy — callers never mutate the table). */
export function enforcementFor(tier: SecurityRiskTier): SecurityEnforcement {
  return { ...ENFORCEMENT[tier] };
}

/** Severity → risk tier. `blocker` security findings are critical. */
export function riskTierForSeverity(
  severity: FindingSeverity | string | null | undefined,
): SecurityRiskTier {
  switch (severity) {
    case 'blocker':
      return 'critical';
    case 'major':
      return 'high';
    case 'minor':
      return 'medium';
    default:
      return 'low';
  }
}

const TIER_RANK: Record<SecurityRiskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxTier(a: SecurityRiskTier, b: SecurityRiskTier): SecurityRiskTier {
  return TIER_RANK[b] > TIER_RANK[a] ? b : a;
}

// ---------------------------------------------------------------------------
// Finding classification + field completeness
// ---------------------------------------------------------------------------

/** A security finding is one flagged `category: security` OR carrying a
 *  `security_category` (a pass may only populate the latter). */
export function isSecurityFinding(
  f: Pick<ReviewFindingRow, 'category' | 'security_category'>,
): boolean {
  return f.category === 'security' || f.security_category != null;
}

/**
 * Reasons a security finding is missing part of the required field set.
 * Empty ⇒ complete. `security_category` and `affected_asset` are the
 * hard requirements; the gate fails closed on any reason.
 */
export function securityFieldReasons(
  f: Pick<
    ReviewFindingRow,
    'category' | 'security_category' | 'affected_asset'
  >,
): string[] {
  if (!isSecurityFinding(f)) return [];
  const reasons: string[] = [];
  if (f.security_category == null) {
    reasons.push('missing security_category');
  }
  if (f.affected_asset == null || String(f.affected_asset).trim() === '') {
    reasons.push('missing affected_asset');
  }
  return reasons;
}

/**
 * Deterministic best-effort classification of free-text into the wp-131
 * taxonomy. Used when the pass didn't set `security_category` — the
 * gate still fails closed if this can't classify.
 */
const CATEGORY_KEYWORDS: { category: SecurityCategory; words: string[] }[] = [
  {
    category: 'secrets',
    words: [
      'secret',
      'password',
      'passwd',
      'api key',
      'api-key',
      'apikey',
      'private key',
      'credential',
      'hardcode',
      'hard-code',
      '.env',
      'token leak',
    ],
  },
  {
    category: 'prompt-injection',
    words: [
      'prompt injection',
      'prompt-injection',
      'jailbreak',
      'system prompt',
      'tool abuse',
      'untrusted content',
      'instruction override',
    ],
  },
  {
    category: 'access-control',
    words: [
      'access control',
      'authoriz',
      'authoris',
      'authz',
      'authenticat',
      'permission',
      'privilege',
      'rbac',
      'idor',
      'csrf',
      'session fixation',
      'ownership check',
      'tenant isolation',
    ],
  },
  {
    category: 'injection',
    words: [
      'sql',
      'injection',
      'sqli',
      'xss',
      'command injection',
      'shell injection',
      'code injection',
      'deserial',
      'ssrf',
      'path traversal',
      'ldap injection',
      'xpath',
      'template injection',
      'eval(',
    ],
  },
  {
    category: 'data-exposure',
    words: [
      'pii',
      'personally identifiable',
      'sensitive data',
      'data exposure',
      'leak',
      'stack trace',
      'verbose error',
      'debug log',
      'logging secret',
      'over-expose',
    ],
  },
  {
    category: 'unsafe-deps',
    words: [
      'dependenc',
      'cve-',
      'vulnerab',
      'supply chain',
      'npm audit',
      'outdated package',
      'unpatched',
    ],
  },
  {
    category: 'insecure-defaults',
    words: [
      'insecure default',
      'verify=false',
      'rejectunauthorized',
      'wildcard cors',
      'permissive',
      'debug=true',
      'allowlist',
      'denylist',
      'tls',
      'ssl',
      'hardcoded key',
    ],
  },
];

/** Classify free text into the security taxonomy, or null when nothing
 *  matches (caller fails closed). */
export function classifySecurityCategory(
  text: string | null | undefined,
): SecurityCategory | null {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const { category, words } of CATEGORY_KEYWORDS) {
    if (words.some((w) => t.includes(w))) return category;
  }
  return null;
}

/**
 * Derive the security field set from a review.json finding (which does
 * NOT carry them — SCHEMAS §6 is unchanged). `affected_asset` defaults
 * to the touched file; the category comes from the finding body/evidence
 * when the pass didn't set one. Null category ⇒ the gate flags it.
 */
export function deriveSecurityFields(f: {
  file?: string | null;
  body?: string | null;
  evidence?: string | null;
  security_category?: string | null;
  affected_asset?: string | null;
  exposure?: string | null;
  policy_violated?: string | null;
}): {
  security_category: SecurityCategory | null;
  affected_asset: string | null;
  exposure: string | null;
  policy_violated: string | null;
} {
  const provided =
    f.security_category != null &&
    (SECURITY_CATEGORIES as readonly string[]).includes(f.security_category)
      ? (f.security_category as SecurityCategory)
      : null;
  const category =
    provided ??
    classifySecurityCategory(`${f.body ?? ''} ${f.evidence ?? ''}`.trim());
  return {
    security_category: category,
    affected_asset: f.affected_asset ?? f.file ?? null,
    exposure: f.exposure ?? null,
    policy_violated: f.policy_violated ?? null,
  };
}

// ---------------------------------------------------------------------------
// Security exceptions (quality_debt security-exception + expiry)
// ---------------------------------------------------------------------------

/** Structured metadata stamped into the debt row's `body`. */
export interface SecurityExceptionMeta {
  schema: 1;
  review_id: string;
  /** null = review-wide exception (covers every finding). */
  finding_id: string | null;
  security_category: string | null;
  exposure: string | null;
  /** The gate phase the exception unblocks (merge|release). */
  phase: string | null;
}

/** Deterministic debt id — one exception per (review, finding|review). */
export function securityExceptionId(
  reviewId: string,
  findingId?: string | null,
): string {
  return `se:${reviewId}:${findingId ?? '*'}`;
}

function parseExceptionMeta(
  debt: QualityDebtRow,
): SecurityExceptionMeta | null {
  if (!debt.body) return null;
  const idx = debt.body.indexOf('{');
  if (idx === -1) return null;
  try {
    const parsed = JSON.parse(debt.body.slice(idx)) as SecurityExceptionMeta;
    if (parsed && parsed.schema === 1 && typeof parsed.review_id === 'string') {
      return parsed;
    }
  } catch {
    // Malformed meta → not a usable exception (fail-closed).
  }
  return null;
}

/** A live exception row + its parsed meta. */
export interface SecurityException {
  debt: QualityDebtRow;
  meta: SecurityExceptionMeta;
}

const LIVE_STATUSES = new Set(['open', 'acknowledged']);

function isExpired(debt: QualityDebtRow, now: Date): boolean {
  if (!debt.expires_at) return true; // an exception with no expiry is invalid → treat as expired
  const t = Date.parse(debt.expires_at);
  return !Number.isFinite(t) || t <= now.getTime();
}

/**
 * Active (non-expired) security exceptions for a review. Expiry is
 * evaluated against `ctx.now()` — an expired exception never silently
 * keeps blocking findings waived.
 */
export async function activeSecurityExceptions(
  ctx: StudioCtx,
  args: { reviewId: string },
): Promise<SecurityException[]> {
  const session = await requireSession(ctx, args.reviewId);
  const rows = await ctx.store.listQualityDebt({
    workspace: ctx.workspace,
    kind: 'security-exception',
  });
  const now = ctx.now();
  const out: SecurityException[] = [];
  for (const debt of rows) {
    if (!LIVE_STATUSES.has(debt.status)) continue;
    if (isExpired(debt, now)) continue;
    const meta = parseExceptionMeta(debt);
    if (!meta || meta.review_id !== args.reviewId) continue;
    // A subject mismatch means the row belongs to another review.
    if (debt.subject != null && debt.subject !== session.subject) continue;
    out.push({ debt, meta });
  }
  return out;
}

/** All security exceptions for a review, including expired ones. */
export async function listSecurityExceptions(
  ctx: StudioCtx,
  args: { reviewId: string },
): Promise<SecurityException[]> {
  await requireSession(ctx, args.reviewId);
  const rows = await ctx.store.listQualityDebt({
    workspace: ctx.workspace,
    kind: 'security-exception',
  });
  const out: SecurityException[] = [];
  for (const debt of rows) {
    const meta = parseExceptionMeta(debt);
    if (!meta || meta.review_id !== args.reviewId) continue;
    out.push({ debt, meta });
  }
  return out;
}

function coveringExceptions(
  exceptions: SecurityException[],
  findingId: string,
): string[] {
  return exceptions
    .filter(
      (e) => e.meta.finding_id === null || e.meta.finding_id === findingId,
    )
    .map((e) => e.debt.debt_id);
}

export interface GrantSecurityExceptionArgs {
  reviewId: string;
  /** null/absent = review-wide exception (covers every finding). */
  findingId?: string | null;
  /** Accountable human owner — required. */
  owner: string;
  /** ISO timestamp the exception stops applying — required. */
  expiresAt: string;
  /** Why this is acceptable — required. */
  rationale: string;
  actor: string;
  /** Defaults to 'human'; an agent/system can NEVER grant. */
  actorKind?: FindingActorKind;
}

/**
 * Grant a tightly-controlled security exception. Human-only; requires
 * owner + future expiry + rationale. Writes a `quality_debt` row of
 * kind `security-exception` (the register entry that expires loudly) and
 * an audit event. Agents are refused — a blocking security finding is
 * never waived by a machine.
 */
export async function grantSecurityException(
  ctx: StudioCtx,
  args: GrantSecurityExceptionArgs,
): Promise<QualityDebtRow> {
  const actorKind = args.actorKind ?? 'human';
  if (actorKind !== 'human') {
    throw forbidden(
      `security exception for ${args.reviewId}: only a human may waive a blocking security finding`,
    );
  }
  const session = await requireSession(ctx, args.reviewId);
  if (!args.owner || args.owner.trim() === '') {
    throw invalid('security exception: owner is required');
  }
  if (!args.rationale || args.rationale.trim() === '') {
    throw invalid('security exception: rationale is required');
  }
  const expiry = Date.parse(args.expiresAt);
  if (!args.expiresAt || !Number.isFinite(expiry)) {
    throw invalid('security exception: a valid expires_at is required');
  }
  if (expiry <= ctx.now().getTime()) {
    throw invalid('security exception: expires_at must be in the future');
  }
  const findingId = args.findingId ?? null;
  if (findingId) {
    const finding = await ctx.store.getReviewFinding({
      workspace: ctx.workspace,
      finding_id: findingId,
    });
    if (!finding || finding.review_id !== args.reviewId) {
      throw notFound(
        `no review finding '${findingId}' in review ${args.reviewId}`,
      );
    }
  }
  const ts = ctx.now().toISOString();
  const meta: SecurityExceptionMeta = {
    schema: 1,
    review_id: args.reviewId,
    finding_id: findingId,
    security_category: null,
    exposure: null,
    phase: null,
  };
  const debt: QualityDebtRow = {
    workspace: ctx.workspace,
    org: session.org ?? null,
    debt_id: securityExceptionId(args.reviewId, findingId),
    subject: session.subject,
    kind: 'security-exception',
    title: findingId
      ? `Security exception — ${findingId}`
      : `Security exception — ${args.reviewId} (review-wide)`,
    body: `${args.rationale.trim()}\n\n${JSON.stringify(meta)}`,
    owner: args.owner,
    revisit: `re-evaluate before ${args.expiresAt}`,
    expires_at: args.expiresAt,
    approved_by: args.actor,
    approved_at: ts,
    consolidated_into: null,
    status: 'acknowledged',
    created_at: ts,
    updated_at: ts,
  };
  await ctx.store.upsertQualityDebt(debt);
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: session.subject,
    ts,
    stage: null,
    actor_type: 'human',
    actor_id: args.actor,
    event: 'finding_dismissed',
    run: null,
    refs: [`review:${args.reviewId}`, `debt:${debt.debt_id}`],
    data: {
      reason: 'security-exception',
      review_id: args.reviewId,
      finding_id: findingId,
      owner: args.owner,
      expires_at: args.expiresAt,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  return debt;
}

/** Revoke an exception (human-only) — status → resolved. */
export async function revokeSecurityException(
  ctx: StudioCtx,
  args: {
    reviewId: string;
    findingId?: string | null;
    actor: string;
    actorKind?: FindingActorKind;
    rationale?: string | null;
  },
): Promise<QualityDebtRow> {
  const actorKind = args.actorKind ?? 'human';
  if (actorKind !== 'human') {
    throw forbidden(
      `security exception for ${args.reviewId}: only a human may revoke an exception`,
    );
  }
  const session = await requireSession(ctx, args.reviewId);
  const debtId = securityExceptionId(args.reviewId, args.findingId ?? null);
  const debt = await ctx.store.getQualityDebt({
    workspace: ctx.workspace,
    debt_id: debtId,
  });
  if (!debt) {
    throw notFound(`no security exception '${debtId}'`);
  }
  const ts = ctx.now().toISOString();
  const next: QualityDebtRow = { ...debt, status: 'resolved', updated_at: ts };
  await ctx.store.upsertQualityDebt(next);
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: session.subject,
    ts,
    stage: null,
    actor_type: 'human',
    actor_id: args.actor,
    event: 'status_changed',
    run: null,
    refs: [`review:${args.reviewId}`, `debt:${debtId}`],
    data: {
      entity: 'quality_debt',
      reason: 'security-exception-revoked',
      review_id: args.reviewId,
      rationale: args.rationale ?? null,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  return next;
}

/**
 * Expire lapsed security exceptions LOUDLY: any live `security-exception`
 * debt whose `expires_at` has passed flips to `expired` and appends an
 * audit event. Returns the rows that expired. A no-op when nothing lapsed
 * — so it is safe to call on every tick.
 */
export async function expireSecurityExceptions(
  ctx: StudioCtx,
  args: { reviewId?: string } = {},
): Promise<QualityDebtRow[]> {
  const rows = await ctx.store.listQualityDebt({
    workspace: ctx.workspace,
    kind: 'security-exception',
  });
  const now = ctx.now();
  const expired: QualityDebtRow[] = [];
  for (const debt of rows) {
    if (!LIVE_STATUSES.has(debt.status)) continue;
    if (!isExpired(debt, now)) continue;
    const meta = parseExceptionMeta(debt);
    if (args.reviewId && meta?.review_id !== args.reviewId) continue;
    const ts = now.toISOString();
    const next: QualityDebtRow = { ...debt, status: 'expired', updated_at: ts };
    await ctx.store.upsertQualityDebt(next);
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: debt.subject,
      ts,
      stage: null,
      actor_type: 'system',
      actor_id: ctx.actor,
      event: 'status_changed',
      run: null,
      refs: [`debt:${debt.debt_id}`],
      data: {
        entity: 'quality_debt',
        reason: 'security-exception-expired',
        review_id: meta?.review_id ?? null,
        finding_id: meta?.finding_id ?? null,
        expires_at: debt.expires_at,
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    expired.push(next);
  }
  return expired;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Statuses that clear a security finding for gating purposes.
 *  `accepted-risk`/`deferred-with-approval` deliberately do NOT — a
 *  critical finding needs an expiring exception, not a bare disposition. */
const CLEARED_STATUSES: ReadonlySet<string> = new Set([
  'resolved',
  'duplicate',
  'not-applicable',
]);

export type SecurityGatePhase = 'merge' | 'release';

export interface SecurityGateResult {
  review_id: string;
  phase: SecurityGatePhase;
  /** Highest risk tier among unresolved, un-covered findings. */
  tier: SecurityRiskTier;
  enforcement: SecurityEnforcement;
  /** Fail-closed: approval/merge must not proceed. */
  blocked: boolean;
  /** Unresolved security findings that still block. */
  blocking_findings: string[];
  /** Security findings missing required fields (fail-closed). */
  malformed_findings: string[];
  /** Active exception debt ids covering otherwise-blocking findings. */
  active_exceptions: string[];
  reasons: string[];
}

/**
 * Evaluate the security gate for a review. Fail-closed: unresolved
 * critical (blocker) security findings block merge AND release unless
 * covered by an active, owner+expiry exception; a security finding
 * missing its field set also blocks (the gate can't assess it).
 *
 * `high` tier does not block, but reports that a designated reviewer is
 * required (enforcement.designated_reviewer).
 */
export async function securityGate(
  ctx: StudioCtx,
  args: { reviewId: string; phase?: SecurityGatePhase },
): Promise<SecurityGateResult> {
  const phase = args.phase ?? 'merge';
  await requireSession(ctx, args.reviewId);
  const findings = await ctx.store.listReviewFindings({
    workspace: ctx.workspace,
    review_id: args.reviewId,
  });
  const security = findings.filter(isSecurityFinding);
  const exceptions = await activeSecurityExceptions(ctx, {
    reviewId: args.reviewId,
  });

  const blocking: string[] = [];
  const malformed: string[] = [];
  const exceptionsSeen = new Set<string>();
  let tier: SecurityRiskTier = 'low';

  for (const f of security) {
    const cleared = CLEARED_STATUSES.has(f.status);
    const reasons = securityFieldReasons(f);
    const covering = coveringExceptions(exceptions, f.finding_id);
    for (const id of covering) exceptionsSeen.add(id);
    if (cleared || covering.length > 0) continue;
    const ftier = riskTierForSeverity(f.severity);
    tier = maxTier(tier, ftier);
    if (reasons.length > 0) {
      malformed.push(f.finding_id);
      blocking.push(f.finding_id);
      continue;
    }
    if (ftier === 'critical') blocking.push(f.finding_id);
  }

  const enforcement = enforcementFor(tier);
  const blocksThisPhase =
    (phase === 'merge' && enforcement.blocks_merge) ||
    (phase === 'release' && enforcement.blocks_release);
  const blocked =
    malformed.length > 0 || (blocksThisPhase && blocking.length > 0);

  const reasons: string[] = [];
  if (malformed.length > 0) {
    reasons.push(
      `security findings missing required fields (fail-closed): ${malformed.join(', ')}`,
    );
  }
  if (blocked && blocking.length > 0 && blocksThisPhase) {
    reasons.push(
      `${blocking.length} unresolved critical security finding(s) block ${phase}: ${blocking.join(', ')}`,
    );
  }
  if (!blocked && enforcement.designated_reviewer && security.length > 0) {
    reasons.push(
      'high-risk security surface — a designated reviewer must sign off',
    );
  }

  return {
    review_id: args.reviewId,
    phase,
    tier,
    enforcement,
    blocked,
    blocking_findings: blocking,
    malformed_findings: malformed,
    active_exceptions: [...exceptionsSeen],
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Design-time security gate (threat modeling in the TDD)
// ---------------------------------------------------------------------------

/** File-path / text signals that mark a change as security-sensitive. */
const SENSITIVE_SIGNALS: { reason: string; re: RegExp }[] = [
  {
    reason: 'authentication/authorization',
    re: /auth|login|session|oauth|jwt|sso|rbac|permission|access[-_]?control/i,
  },
  {
    reason: 'secrets/credentials',
    re: /secret|credential|password|passwd|api[-_]?key|private[-_]?key|\.env|token/i,
  },
  {
    reason: 'cryptography',
    re: /crypt|cipher|encrypt|decrypt|hash|hmac|tls|ssl|certificate/i,
  },
  {
    reason: 'input parsing/untrusted data',
    re: /parse|deserial|decode|unmarshal|sanitiz|validate[-_]?input|request[-_]?body|query[-_]?param/i,
  },
  {
    reason: 'command/query execution',
    re: /exec|spawn|child_process|sql|query|eval|shell/i,
  },
  {
    reason: 'network boundary',
    re: /http|fetch|webhook|proxy|ssrf|redirect|url/i,
  },
  {
    reason: 'payments/money',
    re: /payment|billing|checkout|stripe|invoice|price|currency/i,
  },
  {
    reason: 'personal data',
    re: /pii|gdpr|user[-_]?data|personal[-_]?data|email|phone|address/i,
  },
];

/** Sensitive-scope reasons a change triggers (empty ⇒ not sensitive). */
export function sensitiveScopeReasons(
  files: readonly string[],
  extraText = '',
): string[] {
  const hay = `${files.join('\n')}\n${extraText}`;
  const reasons: string[] = [];
  for (const { reason, re } of SENSITIVE_SIGNALS) {
    if (re.test(hay)) reasons.push(reason);
  }
  return reasons;
}

/** True when the TDD carries a threat-model section (`## Threat model`). */
export function threatModelPresent(tddMd: string | null | undefined): boolean {
  if (!tddMd) return false;
  return /^#{2,6}\s*threat[\s-]*model\b/im.test(tddMd);
}

export interface DesignSecurityGateResult {
  /** A sensitive-scope change requires a threat model. */
  required: boolean;
  /** The TDD carries a threat-model section. */
  satisfied: boolean;
  /** Fail-closed: required && !satisfied. */
  blocked: boolean;
  reasons: string[];
  /** The sensitive signals matched. */
  matched: string[];
}

/**
 * Design-time security gate (PRD §15.8 "security review starts at design
 * time"). Fires when the planned change touches a sensitive surface and
 * the TDD has no threat-model section.
 */
export function designSecurityGate(args: {
  files: readonly string[];
  tddMd?: string | null;
  extraText?: string;
}): DesignSecurityGateResult {
  const matched = sensitiveScopeReasons(args.files, args.extraText ?? '');
  const required = matched.length > 0;
  const satisfied = threatModelPresent(args.tddMd);
  const reasons: string[] = [];
  if (required && !satisfied) {
    reasons.push(
      `sensitive-scope change (${matched.join(', ')}) requires a '## Threat model' section in the TDD`,
    );
  }
  return {
    required,
    satisfied,
    blocked: required && !satisfied,
    reasons,
    matched,
  };
}

// ---------------------------------------------------------------------------
// Scanner results → findings (never a silent pass/fail)
// ---------------------------------------------------------------------------

/** A scanner invocation result. `ok:false` (missing binary, scan error)
 *  fails CLOSED — never a silent pass. */
export interface ScannerResult {
  /** gitleaks | trufflehog | … */
  scanner: string;
  ok: boolean;
  error?: string | null;
  /** Raw scanner findings (array). */
  findings?: unknown[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Map one raw scanner record to an AgentFinding. Secrets are NEVER
 * copied into the finding — the body cites the rule + location only
 * (AGENTS.md: secrets never logged).
 */
function scannerRecordToFinding(
  scanner: string,
  raw: unknown,
  repo: string,
): AgentFinding {
  const r = asRecord(raw);
  const sourceMeta = asRecord(r.SourceMetadata);
  const data = asRecord(sourceMeta.Data);
  const fs = asRecord(data.Filesystem);
  const file =
    firstString(r.File, r.file, fs.file, r.Path, r.path) ?? '(unknown)';
  const lineRaw = firstString(r.StartLine, r.start_line, r.line, fs.line);
  const line = lineRaw ? Math.max(0, Number.parseInt(lineRaw, 10) || 0) : 0;
  const rule = firstString(
    r.RuleID,
    r.rule_id,
    r.DetectorName,
    r.detector_name,
    r.Rule,
  );
  const description = firstString(r.Description, r.description, r.Message);
  const verified = r.Verified === true || r.verified === true;
  const label = [scanner, rule, description].filter(Boolean).join(': ');
  return {
    severity: 'blocker',
    category: 'security',
    kind: 'code-bug',
    file,
    line,
    repo,
    body: `${label || `${scanner} finding`} — potential secret committed at ${file}:${line}.`,
    evidence: `${file}:${line} (${rule ?? scanner})`,
    suggested_fix:
      'Remove the secret from the tree, rotate it, and load it from the environment (.env) — never commit or log it.',
    confidence: verified ? 0.95 : scanner === 'gitleaks' ? 0.9 : 0.7,
    author: 'scanner',
    replies: [],
  };
}

export interface ScannerGateResult {
  /** Fail-closed: a scanner error blocks (never a silent pass). */
  blocked: boolean;
  reasons: string[];
  /** Mapped findings (empty when the scanner errored). */
  findings: AgentFinding[];
}

/**
 * Turn a scanner result into findings + a fail-closed verdict. A scan
 * error (missing binary, malformed output) BLOCKS — the spec forbids
 * silent pass/fail: results map to findings and disposition stays
 * human/policy. Finding the array empty is a legitimate clean pass.
 */
export function scannerGate(
  result: ScannerResult,
  opts: { repo?: string } = {},
): ScannerGateResult {
  if (!result.ok) {
    return {
      blocked: true,
      reasons: [
        `${result.scanner} scan failed — fail-closed: ${
          result.error ?? 'no error detail'
        }`,
      ],
      findings: [],
    };
  }
  if (result.findings !== undefined && !Array.isArray(result.findings)) {
    return {
      blocked: true,
      reasons: [
        `${result.scanner} returned malformed output (findings not an array) — fail-closed`,
      ],
      findings: [],
    };
  }
  const findings = (result.findings ?? []).map((raw) =>
    scannerRecordToFinding(result.scanner, raw, opts.repo ?? ''),
  );
  return { blocked: false, reasons: [], findings };
}

/** Convenience — just the mapped findings (throws away the verdict). */
export function findingsFromScanner(
  result: ScannerResult,
  opts: { repo?: string } = {},
): AgentFinding[] {
  return scannerGate(result, opts).findings;
}
