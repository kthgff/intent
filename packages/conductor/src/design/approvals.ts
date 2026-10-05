/**
 * design/approvals.ts — design approvals bound to a mockup revision
 * (PRD §15.4, wp-149).
 *
 * A `design_approvals` row binds an approval to a mockup `doc` +
 * `doc_version` and the AC ids it covers. The rules this module owns:
 *
 *   - an approval must name a REAL mockup revision (you cannot approve
 *     a version that does not exist);
 *   - the approval checklist (desktop/mobile/flows/error-empty/a11y/
 *     linked-acs) must be complete — an incomplete checklist is a
 *     partial approval and requires a rationale (fail-closed);
 *   - a MATERIAL component change invalidates ONLY the approvals whose
 *     covered ACs the structural diff touches — unaffected approvals
 *     stay `approved` (partial invalidation, §15.4);
 *   - invalidation is a status flip (`approved → invalidated`), never a
 *     delete — the binding stays as the audit record.
 */
import {
  type DesignApprovalRow,
  DesignChecklistSchema,
  type DesignChecklistItem,
  type Mockup,
} from '@sprint-runner/core';
import {
  MOCKUP_DOC,
  affectedAcs,
  diffMockups,
  mockupAcs,
  parseMockup,
  requirementCoverage,
  type MockupDiff,
  type RequirementCoverage,
} from './mockup.js';
import {
  type DesignCtx,
  badRequest,
  designApprovalId,
  invalid,
  notFound,
} from './types.js';

/** True when every checklist item is explicitly `true`. */
export function checklistComplete(checklist: unknown): boolean {
  const parsed = DesignChecklistSchema.safeParse(checklist ?? {});
  if (!parsed.success) return false;
  const required: DesignChecklistItem[] = [
    'desktop',
    'mobile',
    'flows',
    'error-empty',
    'a11y',
    'linked-acs',
  ];
  return required.every((item) => parsed.data[item] === true);
}

/** Load + parse a mockup revision (`doc_version` defaults to latest). */
export async function loadMockup(
  ctx: DesignCtx,
  subject: string,
  opts: { doc?: string; docVersion?: number } = {},
): Promise<{ version: number; mockup: Mockup } | null> {
  const doc = opts.doc ?? MOCKUP_DOC;
  const v =
    opts.docVersion !== undefined
      ? await ctx.store.getDocVersion(
          { workspace: ctx.workspace, subject, doc },
          opts.docVersion,
        )
      : await ctx.store.getDoc({ workspace: ctx.workspace, subject, doc });
  if (!v) return null;
  return { version: v.version, mockup: parseMockup(v.content) };
}

export interface RecordDesignApprovalResult {
  approval: DesignApprovalRow;
  /** True when a new row was written; false on an idempotent re-record. */
  created: boolean;
  checklist_complete: boolean;
  coverage: RequirementCoverage[];
}

/**
 * Record a design approval against a specific mockup revision.
 * Idempotent on the derived `approval_id` (subject+doc+version+reviewer).
 */
export async function recordDesignApproval(
  ctx: DesignCtx,
  args: {
    subject: string;
    reviewer: string;
    /** mockup doc kind — defaults to `mockup.json`. */
    doc?: string;
    /** The revision approved — required (an approval binds a revision). */
    docVersion: number;
    checklist: Record<string, unknown>;
    /** AC ids the approval covers; empty/absent → all ACs in the tree. */
    covers?: string[];
    rationale?: string | null;
    approvalId?: string;
  },
): Promise<RecordDesignApprovalResult> {
  const doc = args.doc ?? MOCKUP_DOC;
  if (!args.reviewer) throw badRequest('design approval: reviewer is required');
  if (!Number.isInteger(args.docVersion) || args.docVersion <= 0) {
    throw badRequest('design approval: docVersion must be a positive integer');
  }
  const loaded = await loadMockup(ctx, args.subject, {
    doc,
    docVersion: args.docVersion,
  });
  if (!loaded) {
    throw notFound(
      `design approval: no ${doc} v${args.docVersion} on '${args.subject}'`,
    );
  }
  const coverage = requirementCoverage(loaded.mockup);
  const complete = checklistComplete(args.checklist);
  if (!complete && !(args.rationale && args.rationale.trim().length > 0)) {
    throw invalid(
      `design approval: checklist is incomplete (desktop/mobile/flows/error-empty/a11y/linked-acs) — a partial approval requires a rationale`,
    );
  }
  const covers =
    args.covers && args.covers.length > 0
      ? [...args.covers].sort()
      : mockupAcs(loaded.mockup);

  const approvalId =
    args.approvalId ??
    designApprovalId(args.subject, doc, args.docVersion, args.reviewer);
  const existing = await ctx.store.getDesignApproval({
    workspace: ctx.workspace,
    approval_id: approvalId,
  });
  const row: DesignApprovalRow = {
    workspace: ctx.workspace,
    org: existing?.org ?? null,
    approval_id: approvalId,
    subject: args.subject,
    doc,
    doc_version: args.docVersion,
    checklist: args.checklist,
    covers,
    reviewer: args.reviewer,
    rationale: args.rationale ?? null,
    status: 'approved',
    created_at: existing?.created_at ?? ctx.now().toISOString(),
    invalidated_at: null,
  };
  await ctx.store.upsertDesignApproval(row);
  return {
    approval: row,
    created: existing === null,
    checklist_complete: complete,
    coverage,
  };
}

/** All approvals for a subject (optionally filtered by status). */
export async function listDesignApprovals(
  ctx: DesignCtx,
  filter: { subject?: string; status?: string } = {},
): Promise<DesignApprovalRow[]> {
  return ctx.store.listDesignApprovals({
    workspace: ctx.workspace,
    ...(filter.subject ? { subject: filter.subject } : {}),
    ...(filter.status ? { status: filter.status } : {}),
  });
}

export interface InvalidateResult {
  invalidated: DesignApprovalRow[];
  /** Structural diff per invalidated approval (newest revision). */
  diffs: MockupDiff[];
  /** Approvals examined but left `approved` (unaffected). */
  unaffected: string[];
}

/**
 * Invalidate ONLY the approvals affected by a material change between
 * the revision they bound and `toVersion` (§15.4). Approvals whose
 * covered ACs are untouched stay `approved` — partial invalidation.
 *
 * An approval with no `covers` is treated as covering everything and is
 * invalidated by any material change. An approval whose bound revision
 * no longer exists is invalidated (its binding cannot be verified).
 */
export async function invalidateAffectedApprovals(
  ctx: DesignCtx,
  args: { subject: string; doc?: string; toVersion: number },
): Promise<InvalidateResult> {
  const doc = args.doc ?? MOCKUP_DOC;
  const approvals = await ctx.store.listDesignApprovals({
    workspace: ctx.workspace,
    subject: args.subject,
    status: 'approved',
  });
  const to = await loadMockup(ctx, args.subject, {
    doc,
    docVersion: args.toVersion,
  });
  const invalidated: DesignApprovalRow[] = [];
  const diffs: MockupDiff[] = [];
  const unaffected: string[] = [];
  const ts = ctx.now().toISOString();

  for (const approval of approvals) {
    if (approval.doc !== doc) continue;
    if (approval.doc_version >= args.toVersion) continue;
    if (!to) {
      // New revision vanished — cannot verify the binding; invalidate.
      const row = await flipInvalidated(ctx, approval, ts);
      invalidated.push(row);
      continue;
    }
    const from = await loadMockup(ctx, args.subject, {
      doc,
      docVersion: approval.doc_version,
    });
    if (!from) {
      const row = await flipInvalidated(ctx, approval, ts);
      invalidated.push(row);
      continue;
    }
    const diff = diffMockups(from.mockup, to.mockup, {
      from: approval.doc_version,
      to: args.toVersion,
    });
    const covers = approval.covers ?? [];
    const affected = affectedAcs(diff, from.mockup, to.mockup);
    const touches =
      covers.length === 0
        ? diff.material
        : affected.some((ac) => covers.includes(ac));
    if (touches) {
      const row = await flipInvalidated(ctx, approval, ts);
      invalidated.push(row);
      diffs.push(diff);
    } else {
      unaffected.push(approval.approval_id);
    }
  }
  return { invalidated, diffs, unaffected };
}

/** Invalidate every approval older than the latest mockup revision
 *  (convenience hook after a new mockup version is appended). */
export async function syncDesignApprovals(
  ctx: DesignCtx,
  args: { subject: string; doc?: string },
): Promise<InvalidateResult & { to_version: number | null }> {
  const doc = args.doc ?? MOCKUP_DOC;
  const latest = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject: args.subject,
    doc,
  });
  if (!latest) {
    return { invalidated: [], diffs: [], unaffected: [], to_version: null };
  }
  const r = await invalidateAffectedApprovals(ctx, {
    subject: args.subject,
    doc,
    toVersion: latest.version,
  });
  return { ...r, to_version: latest.version };
}

async function flipInvalidated(
  ctx: DesignCtx,
  approval: DesignApprovalRow,
  ts: string,
): Promise<DesignApprovalRow> {
  const row: DesignApprovalRow = {
    ...approval,
    status: 'invalidated',
    invalidated_at: ts,
  };
  await ctx.store.upsertDesignApproval(row);
  return row;
}

export type ApprovalCurrency = 'current' | 'invalidated' | 'superseded';

export interface DesignApprovalState {
  approval: DesignApprovalRow;
  /** `current` = approved + bound revision is still the latest;
   *  `invalidated` = a material change invalidated it;
   *  `superseded` = a newer approval from the same reviewer exists. */
  currency: ApprovalCurrency;
}

/**
 * Per-approval currency vs the latest mockup revision. A `current`
 * approval is one whose bound `doc_version` still equals the latest and
 * whose status is `approved`.
 */
export async function designApprovalState(
  ctx: DesignCtx,
  subject: string,
  opts: { doc?: string } = {},
): Promise<DesignApprovalState[]> {
  const doc = opts.doc ?? MOCKUP_DOC;
  const approvals = await ctx.store.listDesignApprovals({
    workspace: ctx.workspace,
    subject,
  });
  const latest = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject,
    doc,
  });
  const latestByReviewer = new Map<string, DesignApprovalRow>();
  for (const a of approvals) {
    const prior = latestByReviewer.get(a.reviewer);
    if (!prior || a.doc_version >= prior.doc_version) {
      latestByReviewer.set(a.reviewer, a);
    }
  }
  return approvals.map((approval) => {
    let currency: ApprovalCurrency = 'superseded';
    if (approval.status === 'invalidated') currency = 'invalidated';
    else if (
      approval.status === 'approved' &&
      latestByReviewer.get(approval.reviewer)?.approval_id ===
        approval.approval_id &&
      latest?.version === approval.doc_version
    ) {
      currency = 'current';
    }
    return { approval, currency };
  });
}
