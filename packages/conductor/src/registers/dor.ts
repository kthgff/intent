/**
 * registers/dor.ts — the Definition-of-Ready engine (PRD §15.10,
 * wp-153).
 *
 * A configurable per-work-type checklist evaluated at the `ready`
 * transition: objective present, ACs testable, dependencies resolved,
 * repo context available, security considered, budget adequate — plus
 * the Assumption Register check (high-impact unverified rows gate).
 * Failures land as a `dor` gate item NAMING every missing check —
 * never a silent block, never a silent proceed.
 *
 * The engine composes wp-154's `execution_readiness` (deps + contract
 * + slots + statements) — the column is re-evaluated here so the gate
 * and the coordinator agree — and honors `parallel_safety` as payload
 * context (the launch-side fences stay the coordinator's).
 */
import type { Config, TicketRow, TicketWorkType } from '@sprint-runner/core';
import type { TransitionContext } from '../contracts.js';
import { computeExecutionReadiness } from '../decompose/readiness.js';
import {
  type AssumptionCtx,
  blockingAssumptions,
  revalidateStaleAssumptions,
} from './assumptions.js';
import { expireQualityDebt } from './quality-debt.js';

/** The `gate_items.gate` a failed DoR surfaces under. */
export const DOR_GATE = 'dor';

export interface DorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface DorResult {
  ok: boolean;
  checks: DorCheck[];
  /** The failed checks — the gate payload names each one. */
  missing: DorCheck[];
  /** Fresh stale-assumption flags raised during evaluation. */
  staleAssumptions: number;
  /** Debt rows that expired during evaluation. */
  expiredDebt: number;
}

/**
 * Per-work-type check policy (PRD §15.10 "configurable per-type
 * checklist"). Every work type inherits `default`; an entry here
 * replaces it. `security` tickets additionally require the
 * `security-considered` section — the base policy already enforces it
 * whenever the text signals sensitive scope, the security work type
 * enforces it unconditionally.
 */
const BASE_CHECKS = [
  'objective',
  'acceptance-criteria',
  'dependencies',
  'open-decisions',
  'repo-context',
  'security-considered',
  'budget',
  'assumptions',
] as const;

export const DOR_POLICY: Record<string, readonly string[]> = {
  default: BASE_CHECKS,
  security: [...BASE_CHECKS, 'security-section-required'],
  documentation: BASE_CHECKS.filter((c) => c !== 'repo-context'),
  spike: BASE_CHECKS.filter((c) => c !== 'acceptance-criteria'),
};

/** Check ids the active policy requires for `workType`. */
export function dorChecksFor(
  workType: TicketWorkType | string | null | undefined,
): readonly string[] {
  return (
    DOR_POLICY[(workType as string) ?? 'default'] ??
    (DOR_POLICY.default as readonly string[])
  );
}

/** Slice a `## <name>` section out of markdown (next heading or EOF). */
function sectionBody(md: string, names: readonly string[]): string | null {
  const wanted = names.map((n) => n.toLowerCase());
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{2,6}\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? '');
    if (h && wanted.includes((h[1] ?? '').trim().toLowerCase())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join('\n').trim();
  return body === '' ? null : body;
}

/** A `security` work_type without a `## Security`/`## Threat model`
 *  section has demonstrably not considered security — the wp-131
 *  taxonomy owns "is this security work" (a keyword grep would flag
 *  every incidental `auth`/`token` mention). Non-security work types
 *  are considered-covered by the intake classification. */
function securitySectionPresent(md: string): boolean {
  return (
    sectionBody(md, ['security', 'threat model', 'security considerations']) !==
    null
  );
}

/**
 * Evaluate the DoR checklist for a ticket at the `ready` boundary.
 * Also runs the register's loud-maintenance passes for the subject —
 * stale-assumption revalidation + quality-debt expiry — so the gate
 * payload reflects the register state it just surfaced.
 */
export async function evaluateDor(args: {
  ctx: TransitionContext;
  config: Pick<Config, 'repos' | 'budgets'>;
  ticket: TicketRow;
}): Promise<DorResult> {
  const { ctx, config, ticket } = args;
  const { store, workspace } = ctx;
  const id = ticket.ticket_id;
  const required = new Set(dorChecksFor(ticket.work_type));
  const checks: DorCheck[] = [];
  const push = (id2: string, label: string, ok: boolean, detail: string) => {
    if (required.has(id2)) checks.push({ id: id2, label, ok, detail });
  };

  // ---- register maintenance (loud) before evaluation ----
  const actx: AssumptionCtx = {
    store,
    workspace,
    actor: ctx.actor,
    now: ctx.now,
  };
  const stale = await revalidateStaleAssumptions(actx, id);
  const expiredDebt = await expireQualityDebt(actx, { subject: id });

  const ticketMd =
    (await store.getDoc({ workspace, subject: id, doc: 'ticket.md' }))
      ?.content ?? '';

  // ---- objective ----
  const objective = sectionBody(ticketMd, [
    'description',
    'objective',
    'problem',
  ]);
  push(
    'objective',
    'Objective stated',
    objective !== null,
    objective ? 'objective present' : 'no Description/Objective section',
  );

  // ---- acceptance criteria ----
  const acs = sectionBody(ticketMd, [
    'acceptance criteria',
    'acceptance-criteria',
  ]);
  const acItems =
    acs?.split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).length ?? 0;
  push(
    'acceptance-criteria',
    'Acceptance criteria testable',
    acItems > 0,
    acItems > 0 ? `${acItems} AC item(s)` : 'no AC items',
  );

  // ---- execution readiness (wp-154 composition) ----
  const readiness = await computeExecutionReadiness({
    ctx,
    ticket,
    contracts: [],
  });
  const depReasons = readiness.reasons.filter(
    (r) => r.startsWith('depends_on') || r.startsWith('contract'),
  );
  const otherReasons = readiness.reasons.filter(
    (r) => !r.startsWith('depends_on') && !r.startsWith('contract'),
  );
  // Honor the column AND the recompute — a persisted `blocked` verdict
  // fails even if the live recompute is narrower.
  const columnBlocked = ticket.execution_readiness === 'blocked';
  push(
    'dependencies',
    'Dependencies resolved',
    depReasons.length === 0 && !columnBlocked,
    depReasons.length > 0
      ? depReasons.join('; ')
      : columnBlocked
        ? 'execution_readiness=blocked'
        : 'no blocking deps',
  );
  push(
    'open-decisions',
    'No open slots/decisions',
    otherReasons.length === 0,
    otherReasons.length === 0
      ? 'knowledge slots + statements settled'
      : otherReasons.join('; '),
  );

  // ---- repo context ----
  const unknownRepos = ticket.repos.filter((r) => !config.repos[r]);
  // `repos: []` is a legitimate greenfield ticket (wp-111's explicit
  // no-evidence bundle) — the check fails on DECLARED repos that have
  // no configured context, never on an empty declaration.
  push(
    'repo-context',
    'Repo context available',
    unknownRepos.length === 0,
    ticket.repos.length === 0
      ? 'no repos declared (greenfield)'
      : unknownRepos.length > 0
        ? `unconfigured repo(s): ${unknownRepos.join(', ')}`
        : `${ticket.repos.length} repo(s) configured`,
  );

  // ---- security considered ----
  const securitySection = securitySectionPresent(ticketMd);
  const securityTyped = ticket.work_type === 'security';
  const securityOk =
    securitySection ||
    !(securityTyped || required.has('security-section-required'));
  push(
    'security-considered',
    'Security considered',
    securityOk,
    securitySection
      ? 'security section present'
      : securityOk
        ? 'non-security work type'
        : 'security-typed ticket without a ## Security/## Threat model section',
  );

  // ---- budget adequate ----
  const cap = config.budgets.spend_cap_usd_per_ticket;
  let spent = 0;
  if (cap != null) {
    const events = await store.listEvents({ workspace, ticket_id: id });
    for (const e of events) spent += e.cost_usd ?? 0;
  }
  const budgetOk = cap == null || spent < cap;
  push(
    'budget',
    'Budget adequate',
    budgetOk,
    cap == null
      ? 'no per-ticket spend cap'
      : budgetOk
        ? `spent $${spent.toFixed(2)} of $${cap} cap`
        : `spent $${spent.toFixed(2)} meets/exceeds $${cap} cap`,
  );

  // ---- assumptions ----
  const assumptions = await store.listAssumptions({
    workspace,
    subject: id,
  });
  const blockers = blockingAssumptions(assumptions);
  push(
    'assumptions',
    'High-impact assumptions resolved',
    blockers.length === 0,
    blockers.length === 0
      ? assumptions.length === 0
        ? 'no assumptions recorded'
        : 'no high-impact unverified assumptions'
      : `${blockers.length} high-impact unverified: ${blockers
          .map((a) => a.assumption_id)
          .join(', ')}`,
  );

  const missing = checks.filter((c) => !c.ok);
  return {
    ok: missing.length === 0,
    checks,
    missing,
    staleAssumptions: stale.length,
    expiredDebt: expiredDebt.length,
  };
}
