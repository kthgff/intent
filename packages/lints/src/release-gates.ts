/**
 * release-gates.ts — Release Center readiness gates (DELIVERY §3–§4,
 * wp-134).
 *
 * Same discipline as the doc lints: pure functions, facts in →
 * verdicts out. The conductor gathers the rows (manifest, approvals,
 * live items, member tickets, corrections), this module decides, and
 * `release_gate_results` records the outcome. Fail-closed: absent
 * facts fail a gate — nothing is guessed.
 */
import { createHash } from 'node:crypto';
import type {
  ReleaseGateVerdict,
  ReleaseItemRow,
  ReleaseManifestItem,
  ReleaseManifestRow,
} from '@sprint-runner/core';

/** The release-readiness gate set (DELIVERY §4 invariants 2, 3, 5 +
 *  the correction rule). `release_gate_results.gate` carries these
 *  ids verbatim. */
export const RELEASE_GATE_IDS = [
  /** A frozen manifest exists for the release. */
  'manifest',
  /** The LATEST manifest version carries a human `approved` decision
   *  and no `rejected` decision (invariant 2 + 3 — approval binds to
   *  the digest; a re-cut resets it). */
  'approved',
  /** Every frozen item→repo entry carries a merged_sha AND every live
   *  member ticket is `merged|released` (invariant 2). */
  'merged',
  /** Every item with non-null `partial_ac` carries `approved_by`
   *  (invariant 5). */
  'partial-ac',
  /** No open material correction hangs off a member ticket
   *  (DELIVERY §2 — "a material defect blocks any release containing
   *  the item"). */
  'corrections',
] as const;
export type ReleaseGateId = (typeof RELEASE_GATE_IDS)[number];

/** One gate outcome. `detail` explains a non-pass verdict — never a
 *  secret (scope ids, severities, approver names only). */
export interface ReleaseGateCheck {
  gate: ReleaseGateId;
  verdict: ReleaseGateVerdict;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Manifest canonicalization + digest (DELIVERY §3: "digest — sha256 of
// items", the item→repo→merged_sha map)
// ---------------------------------------------------------------------------

/** Canonical form: items sorted by (item_kind, item_id), repos sorted
 *  by repo, ac_ids sorted — so a digest depends only on the frozen
 *  scope, never on insertion order or column layout. */
export function canonicalManifestItems(
  items: ReleaseManifestItem[],
): ReleaseManifestItem[] {
  return items
    .map((item) => ({
      item_kind: item.item_kind,
      item_id: item.item_id,
      ...(item.partial_ac && item.partial_ac.length > 0
        ? { partial_ac: [...item.partial_ac].sort() }
        : {}),
      repos: item.repos
        .map((r) => ({
          repo: r.repo,
          ...(r.ticket ? { ticket: r.ticket } : {}),
          merged_sha: r.merged_sha ?? null,
        }))
        .sort(
          (a, b) =>
            a.repo.localeCompare(b.repo) ||
            (a.ticket ?? '').localeCompare(b.ticket ?? ''),
        ),
    }))
    .sort((a, b) =>
      a.item_kind === b.item_kind
        ? a.item_id.localeCompare(b.item_id)
        : a.item_kind.localeCompare(b.item_kind),
    );
}

/** `sha256:<hex>` over the canonical manifest scope. `partial_ac` is
 *  part of the digested scope — changing a partial release's approved
 *  ac_ids changes the digest (invariant 3 applies to it too). */
export function releaseManifestDigest(items: ReleaseManifestItem[]): string {
  const canonical = canonicalManifestItems(items);
  const hex = createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
  return `sha256:${hex}`;
}

// ---------------------------------------------------------------------------
// Corrections (DELIVERY §2 — correction tickets, material defects)
// ---------------------------------------------------------------------------

/** Severities that make an open correction "material" — a defect that
 *  must not ship silently. `minor`/`trivial` do not block a release;
 *  an UNGRADED correction (null severity) counts as material —
 *  fail-closed: unknown severity is never assumed shippable. */
export const MATERIAL_CORRECTION_SEVERITIES = [
  'blocker',
  'critical',
  'major',
] as const;

export function isMaterialCorrection(
  severity: string | null | undefined,
): boolean {
  if (severity == null || severity === '') return true;
  return (MATERIAL_CORRECTION_SEVERITIES as readonly string[]).includes(
    severity,
  );
}

/** One correction ticket's exposure facts, resolved by the caller. */
export interface CorrectionFact {
  /** Member ticket the correction is filed against (tickets.parent). */
  parent: string;
  /** The correction ticket's own id. */
  correction_id: string;
  severity: string | null;
  /** true while the correction ticket is non-terminal. */
  open: boolean;
}

/** Facts the evaluator needs — gathered by the conductor from the
 *  store, resolved against the CURRENT (latest) manifest version. */
export interface ReleaseGateFacts {
  /** Latest frozen manifest, or null when the release was never frozen. */
  manifest:
    | (Pick<ReleaseManifestRow, 'version' | 'digest'> & {
        items: ReleaseManifestItem[];
      })
    | null;
  /** Approval decisions bound to the LATEST manifest version only
   *  (older-version approvals are already reset by the re-cut).
   *  `decision` is the raw row value — only the literal 'approved' /
   *  'rejected' count; anything else is ignored (fail-closed). */
  approvals: {
    approver: string;
    decision: string;
  }[];
  /** Live scope items (invariant 5 is re-checked on the live rows —
   *  `partial_ac` can be amended between cuts only through the engine,
   *  which re-cuts, but the gate never trusts that path). */
  items: Pick<
    ReleaseItemRow,
    'item_kind' | 'item_id' | 'partial_ac' | 'approved_by'
  >[];
  /** Live member tickets resolved from the manifest's items. */
  members: { ticket_id: string; status: string }[];
  /** Open/closed corrections on every member ticket. */
  corrections: CorrectionFact[];
  /** Gates already waived for THIS manifest version (a `waived`
   *  release_gate_results row whose evidence binds it to the current
   *  version — a human override, recorded). */
  waived: ReleaseGateId[];
}

function verdict(
  gate: ReleaseGateId,
  ok: boolean,
  detail: string | undefined,
  facts: ReleaseGateFacts,
): ReleaseGateCheck {
  const v: ReleaseGateVerdict = ok
    ? 'pass'
    : facts.waived.includes(gate)
      ? 'waived'
      : 'fail';
  return detail ? { gate, verdict: v, detail } : { gate, verdict: v };
}

/** Statuses a member ticket may hold at release time — merged work
 *  that ships, or already released (idempotent re-release). */
const RELEASABLE_MEMBER_STATUSES = new Set(['merged', 'released']);

/**
 * Evaluate all five release gates against the gathered facts. Pure —
 * no store access, no clock. The result order matches
 * RELEASE_GATE_IDS so reports are stable.
 */
export function evaluateReleaseGates(
  facts: ReleaseGateFacts,
): ReleaseGateCheck[] {
  const checks: ReleaseGateCheck[] = [];
  const m = facts.manifest;

  // ---- manifest: a frozen cut exists ----
  checks.push(
    verdict(
      'manifest',
      m != null,
      m == null
        ? 'no frozen manifest — `freeze` cuts one'
        : `v${m.version} ${m.digest.slice(0, 19)}…`,
      facts,
    ),
  );

  // ---- approved: latest version carries a clean human approval ----
  {
    const approvedBy = facts.approvals
      .filter((a) => a.decision === 'approved')
      .map((a) => a.approver);
    const rejectedBy = facts.approvals
      .filter((a) => a.decision === 'rejected')
      .map((a) => a.approver);
    const ok = m != null && approvedBy.length > 0 && rejectedBy.length === 0;
    checks.push(
      verdict(
        'approved',
        ok,
        ok
          ? `v${m?.version} approved by ${approvedBy.join(', ')}`
          : rejectedBy.length > 0
            ? `v${m?.version ?? '?'} rejected by ${rejectedBy.join(', ')} — scope change must cut a new manifest`
            : 'no human approval bound to the current manifest digest',
        facts,
      ),
    );
  }

  // ---- merged: every frozen repo entry carries a merged_sha and
  //      every live member ticket is merged|released ----
  {
    const missing: string[] = [];
    if (m != null) {
      for (const item of m.items) {
        if (item.repos.length === 0) {
          missing.push(`${item.item_id}: no merged repos recorded`);
        }
        for (const r of item.repos) {
          if (r.merged_sha == null || r.merged_sha === '') {
            missing.push(
              `${item.item_id}/${r.repo}${r.ticket ? ` (${r.ticket})` : ''}: unmerged`,
            );
          }
        }
      }
    }
    const unmergedMembers = facts.members
      .filter((t) => !RELEASABLE_MEMBER_STATUSES.has(t.status))
      .map((t) => `${t.ticket_id}(${t.status})`);
    const blockers = [...missing, ...unmergedMembers];
    checks.push(
      verdict(
        'merged',
        m != null && blockers.length === 0,
        blockers.length > 0 ? `unmerged: ${blockers.join(', ')}` : undefined,
        facts,
      ),
    );
  }

  // ---- partial-ac: invariant 5 ----
  {
    const unapproved = facts.items
      .filter((i) => i.partial_ac != null && i.approved_by == null)
      .map((i) => i.item_id);
    checks.push(
      verdict(
        'partial-ac',
        unapproved.length === 0,
        unapproved.length > 0
          ? `partial releases without approved_by: ${unapproved.join(', ')}`
          : undefined,
        facts,
      ),
    );
  }

  // ---- corrections: material open defects on member tickets ----
  {
    const blocking = facts.corrections
      .filter((c) => c.open && isMaterialCorrection(c.severity))
      .map(
        (c) => `${c.correction_id}(${c.severity ?? 'ungraded'}→${c.parent})`,
      );
    checks.push(
      verdict(
        'corrections',
        blocking.length === 0,
        blocking.length > 0
          ? `material open corrections: ${blocking.join(', ')}`
          : undefined,
        facts,
      ),
    );
  }

  return checks;
}

/** Convenience rollup — true when every gate is `pass` or `waived`. */
export function releaseGatesGreen(checks: ReleaseGateCheck[]): boolean {
  return checks.every((c) => c.verdict !== 'fail');
}
