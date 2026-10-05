/**
 * review/studio/requirements.ts — requirement-first review mode +
 * finding↔evidence links + external thread mappings (PRD §15.8,
 * wp-148).
 *
 * Requirement-first: pick an AC → see the implementing code + its test
 * evidence. The engine resolves three edge planes the wp-131 schema
 * already holds:
 *
 *   - `relations` — the semantic graph: `ac:<id>` -(implements)->
 *     code units (wp-110 commit-pinned refs) and `ac:<id>`
 *     -(tests|verified-by)-> test evidence;
 *   - `review_evidence_links` — explicit finding↔evidence edges
 *     (idempotent insert on the PK);
 *   - `run_artifacts` — the subject's test reports (`test-report.json`,
 *     coverage) cited as `run:<id>:<name>` refs.
 *
 * External mappings: `external_review_mappings` records finding↔
 * GitHub-thread correspondences — explicit and idempotent. GitHub
 * remains authoritative for PR state/checks/merge; these rows are
 * correspondences, never approval proxies.
 */
import type {
  ExternalReviewMappingRow,
  Relation,
  ReviewEvidenceLinkRow,
} from '@sprint-runner/core';
import { requireSession } from './session.js';
import { type StudioCtx, notFound } from './types.js';

/** Predicates that resolve an AC's implementing code edges. */
const CODE_PREDICATES = new Set(['implements', 'documents']);
/** Predicates that resolve an AC's test/verification edges. */
const TEST_PREDICATES = new Set(['tests', 'verified-by']);

/** Infer an evidence-link kind from the ref's scheme when the caller
 *  didn't set one (`ev_…` = code unit, `doc:` = doc version,
 *  `run:` = run artifact, `ac:` = acceptance criterion). */
export function evidenceKind(evidenceRef: string): string {
  if (evidenceRef.startsWith('ac:')) return 'requirement';
  if (evidenceRef.startsWith('doc:')) return 'doc';
  if (evidenceRef.startsWith('run:')) return 'run-artifact';
  if (evidenceRef.startsWith('ev_')) return 'code-unit';
  return 'manual';
}

/**
 * Idempotent finding↔evidence edge — duplicate inserts collapse on
 * the (workspace, review_id, finding_id, evidence_ref) PK.
 */
export async function linkEvidence(
  ctx: StudioCtx,
  args: {
    reviewId: string;
    findingId: string;
    evidenceRef: string;
    kind?: string | null;
  },
): Promise<ReviewEvidenceLinkRow> {
  await requireSession(ctx, args.reviewId);
  const finding = await ctx.store.getReviewFinding({
    workspace: ctx.workspace,
    finding_id: args.findingId,
  });
  if (!finding) {
    throw notFound(`no review finding '${args.findingId}' in ${ctx.workspace}`);
  }
  const row: ReviewEvidenceLinkRow = {
    workspace: ctx.workspace,
    org: finding.org ?? null,
    review_id: args.reviewId,
    finding_id: args.findingId,
    evidence_ref: args.evidenceRef,
    kind: args.kind ?? evidenceKind(args.evidenceRef),
    created_at: ctx.now().toISOString(),
  };
  await ctx.store.insertReviewEvidenceLink(row);
  return row;
}

/** Remove one edge — deleting a link is not a lifecycle event. */
export async function unlinkEvidence(
  ctx: StudioCtx,
  args: { reviewId: string; findingId: string; evidenceRef: string },
): Promise<void> {
  await ctx.store.deleteReviewEvidenceLink({
    workspace: ctx.workspace,
    review_id: args.reviewId,
    finding_id: args.findingId,
    evidence_ref: args.evidenceRef,
  });
}

/** Edges for one finding (or the whole review). */
export async function listEvidenceLinks(
  ctx: StudioCtx,
  args: { reviewId: string; findingId?: string },
): Promise<ReviewEvidenceLinkRow[]> {
  return ctx.store.listReviewEvidenceLinks({
    workspace: ctx.workspace,
    review_id: args.reviewId,
    ...(args.findingId ? { finding_id: args.findingId } : {}),
  });
}

export interface RequirementView {
  ac_id: string;
  /** `implements`/`documents` edges out of `ac:<id>` — code units,
   *  commit-pinned when wp-110 refs carry SHAs. */
  implementing: Relation[];
  /** `tests`/`verified-by` edges — the AC's test evidence. */
  test_edges: Relation[];
  /** Evidence refs linked onto this AC's findings. */
  evidence_refs: string[];
  /** Findings in this review pinned to the AC (`subject = <ac>`). */
  findings: {
    finding_id: string;
    status: string;
    severity: string | null;
    body: string;
  }[];
  /** Latest test-report artifact refs for the session subject —
   *  `run:<id>:<name>` citation form. */
  run_evidence: string[];
}

/**
 * Requirement-first view for one AC: `ac:<id>` relations → code +
 * tests, the AC's findings, their evidence links, and the subject's
 * latest `test-report.json` run_artifacts rows (the verification
 * plane — §15.8 "one-click test evidence").
 */
export async function requirementView(
  ctx: StudioCtx,
  args: { reviewId: string; acId: string },
): Promise<RequirementView> {
  const session = await requireSession(ctx, args.reviewId);
  const acRef = args.acId.startsWith('ac:') ? args.acId : `ac:${args.acId}`;
  const edges = await ctx.store.listRelations({ subject: acRef });
  const implementing = edges.filter((r) => CODE_PREDICATES.has(r.predicate));
  const test_edges = edges.filter((r) => TEST_PREDICATES.has(r.predicate));

  // Findings pinned to this AC — `subject` carries the AC ref
  // (`AC-1` or `ac:AC-1` spellings both resolve).
  const findings = (
    await ctx.store.listReviewFindings({
      workspace: ctx.workspace,
      review_id: args.reviewId,
    })
  ).filter((f) => f.subject === args.acId || f.subject === acRef);

  const evidence_refs: string[] = [];
  for (const f of findings) {
    const links = await ctx.store.listReviewEvidenceLinks({
      workspace: ctx.workspace,
      review_id: args.reviewId,
      finding_id: f.finding_id,
    });
    evidence_refs.push(...links.map((l) => l.evidence_ref));
  }

  // Latest test-report run_artifacts for the session subject —
  // newest-first run order, basename-or-nested match (same convention
  // as actions.ticketArtifactText).
  const runs = (
    await ctx.store.listRuns({
      workspace: ctx.workspace,
      subject: session.subject,
    })
  ).sort((a, b) => b.id.localeCompare(a.id));
  const run_evidence: string[] = [];
  for (const r of runs) {
    const artifacts = await ctx.store.listArtifacts(r.id);
    for (const a of artifacts) {
      if (
        a.name === 'test-report.json' ||
        a.name.endsWith('/test-report.json')
      ) {
        run_evidence.push(`run:${r.id}:${a.name}`);
      }
    }
    if (run_evidence.length > 0) break; // newest run carrying a report
  }

  return {
    ac_id: args.acId,
    implementing,
    test_edges,
    evidence_refs,
    findings: findings.map((f) => ({
      finding_id: f.finding_id,
      status: f.status,
      severity: f.severity ?? null,
      body: f.body,
    })),
    run_evidence,
  };
}

/**
 * Record a finding↔external-thread correspondence — explicit,
 * idempotent on (workspace, external_kind, external_id). This NEVER
 * writes to GitHub and never carries approval weight: the mapping is
 * bookkeeping so the same GH thread re-imports idempotently and the
 * internal finding stays traceable (GitHub remains authoritative for
 * PR state).
 */
export async function mapExternal(
  ctx: StudioCtx,
  args: {
    reviewId: string;
    findingId?: string | null;
    externalKind: string;
    externalId: string;
  },
): Promise<ExternalReviewMappingRow> {
  await requireSession(ctx, args.reviewId);
  if (args.findingId) {
    const finding = await ctx.store.getReviewFinding({
      workspace: ctx.workspace,
      finding_id: args.findingId,
    });
    if (!finding) {
      throw notFound(
        `no review finding '${args.findingId}' in ${ctx.workspace}`,
      );
    }
  }
  const row: ExternalReviewMappingRow = {
    workspace: ctx.workspace,
    org: null,
    review_id: args.reviewId,
    finding_id: args.findingId ?? null,
    external_kind: args.externalKind,
    external_id: args.externalId,
    created_at: ctx.now().toISOString(),
  };
  await ctx.store.upsertExternalReviewMapping(row);
  return row;
}

/** Correspondences for a session or one finding. */
export async function listExternalMappings(
  ctx: StudioCtx,
  args: { reviewId: string; findingId?: string },
): Promise<ExternalReviewMappingRow[]> {
  return ctx.store.listExternalReviewMappings({
    workspace: ctx.workspace,
    review_id: args.reviewId,
    ...(args.findingId ? { finding_id: args.findingId } : {}),
  });
}
