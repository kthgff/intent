/**
 * gates/ — gate definitions, gate-mode compression, and the
 * status→gate map used by `RealTransitionHandler.nextStage` (wp-031).
 *
 * CONDUCTOR "Auto-advance rules" lists the gates; SETTINGS `gates:`
 * (`full | plan-package | minimal`) compresses which ones actually
 * surface a `gate_items` row:
 *
 *   - full          → every gate in CONDUCTOR's list surfaces.
 *   - plan-package  → prd/tdd/test reviews collapse into ONE
 *                     `plan-package` review gate (surfaced once, at the
 *                     test-review point, after all three docs exist);
 *                     the separate spend-checkpoint gate is folded into
 *                     it (the package approval IS the "go").
 *   - minimal       → only the human-answer gates (`needs-info`,
 *                     `design-qa`), `changes-requested`, and `approved`
 *                     surface.
 *
 * `repair` and `escalated` items are fail-closed machinery, not doc
 * gates — they surface in EVERY mode (a suppressed repair item would
 * silently strand a ticket; CONDUCTOR lets repair "land on any
 * status").
 */
import type { GateKind, GateMode, TicketStatus } from '@sprint-runner/core';

/** Every gate named in CONDUCTOR "Auto-advance rules" (+ `repair`,
 *  which can land on any status, and `merge`/`ci-watch` tail gates),
 *  plus the wp-151 governance gates (`scope-proposal`, `stale-spec`). */
export const ALL_GATES = [
  'needs-info',
  'design-qa',
  'prd-review',
  'tdd-review',
  'test-review',
  'test-approved',
  'changes-requested',
  'split-plan',
  'scope-proposal',
  'escalated',
  'approved',
  'ci-watch',
  'merge',
  'repair',
  'plan-package',
  'test-env',
  /** wp-111: unresolved `critical` RS-quality findings hold prd-review
   *  until a human resolves/waives them (INTELLIGENCE §5). */
  'rs-quality',
] as const;
export type Gate = (typeof ALL_GATES)[number];

/** The doc-review gates plan-package collapses into one. */
export const PLAN_PACKAGE_GATES = [
  'prd-review',
  'tdd-review',
  'test-review',
  'test-approved',
] as const;

/** Gates that always surface regardless of mode (fail-closed). The
 *  `test-env` provisioning gate is a hard block (wp-157) — it is never
 *  suppressed by a gate mode. */
const ALWAYS_SURFACE = new Set([
  'repair',
  'escalated',
  'test-env',
  // wp-111: a critical spec-quality finding is fail-closed machinery —
  // gate modes can compress doc REVIEWS, never an unresolved critical.
  'rs-quality',
]);

const MODE_GATES: Record<GateMode, ReadonlySet<string>> = {
  full: new Set(ALL_GATES),
  'plan-package': new Set([
    'needs-info',
    'design-qa',
    'plan-package',
    'split-plan',
    'scope-proposal',
    'changes-requested',
    'approved',
    'ci-watch',
    'merge',
    'escalated',
    'repair',
  ]),
  minimal: new Set([
    'needs-info',
    'design-qa',
    'changes-requested',
    'scope-proposal',
    'approved',
    'escalated',
    'repair',
  ]),
};

/** A gate surfaces a `gate_items` row, or is auto-approved (suppressed)
 *  by the active gate mode. */
export type GateDisposition = 'surface' | 'auto';

/**
 * The gate a doc-review STATUS waits on under `mode`. In plan-package
 * mode the four doc gates collapse to the single `plan-package` gate —
 * surfaced at `test-review` (the last doc), earlier docs auto-approve.
 */
export function gateForStatus(
  status: TicketStatus,
  mode: GateMode,
): { gate: string; disposition: GateDisposition } | null {
  switch (status) {
    case 'needs-info':
      return { gate: 'needs-info', disposition: 'surface' };
    case 'design-qa':
      return { gate: 'design-qa', disposition: 'surface' };
    case 'prd-review':
      return mode === 'full'
        ? { gate: 'prd-review', disposition: 'surface' }
        : { gate: 'prd-review', disposition: 'auto' };
    case 'tdd-review':
      return mode === 'full'
        ? { gate: 'tdd-review', disposition: 'surface' }
        : { gate: 'tdd-review', disposition: 'auto' };
    case 'test-review':
      if (mode === 'full')
        return { gate: 'test-review', disposition: 'surface' };
      if (mode === 'plan-package')
        return { gate: 'plan-package', disposition: 'surface' };
      return { gate: 'test-review', disposition: 'auto' };
    case 'test-approved':
      return mode === 'full'
        ? { gate: 'test-approved', disposition: 'surface' }
        : { gate: 'test-approved', disposition: 'auto' };
    case 'changes-requested':
      return { gate: 'changes-requested', disposition: 'surface' };
    case 'approved':
      return { gate: 'approved', disposition: 'surface' };
    case 'escalated':
      return { gate: 'escalated', disposition: 'surface' };
    case 'ci-watch':
      return mode === 'minimal'
        ? { gate: 'ci-watch', disposition: 'auto' }
        : { gate: 'ci-watch', disposition: 'surface' };
    default:
      return null;
  }
}

/** `gate_items.kind` for a gate name (CONDUCTOR gate list → DB-SCHEMA
 *  gate_items.kind enum). */
export function gateKindFor(gate: string): GateKind {
  switch (gate) {
    case 'needs-info':
    case 'design-qa':
    case 'interview-qa':
      return 'question';
    case 'prd-review':
    case 'tdd-review':
    case 'test-review':
    case 'plan-package':
    case 'changes-requested':
    case 'rs-quality':
      return 'review';
    case 'test-approved':
    case 'approved':
    case 'ci-watch':
    case 'merge':
    case 'test-env':
    case 'scope-proposal':
      return 'approval';
    case 'split-plan':
      return 'split-plan';
    case 'repair':
      return 'repair';
    case 'escalated':
      return 'escalation';
    default:
      return 'failure'; // import/probe/survey/stale-spec failures
  }
}

/** Does `gate` surface a `gate_items` row under `mode`? */
export function gateSurfaces(mode: GateMode, gate: string): boolean {
  if (ALWAYS_SURFACE.has(gate)) return true;
  return MODE_GATES[mode].has(gate);
}

/** The gate names a mode surfaces — exported for tests + docs. */
export function surfacedGates(mode: GateMode): string[] {
  return ALL_GATES.filter(
    (g) =>
      gateSurfaces(mode, g) &&
      !(
        mode === 'plan-package' &&
        g !== 'plan-package' &&
        (PLAN_PACKAGE_GATES as readonly string[]).includes(g)
      ),
  );
}
