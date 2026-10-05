/**
 * release/gates.ts — release-readiness gate evaluation (DELIVERY §4,
 * wp-134).
 *
 * The conductor gathers facts from the store; `@sprint-runner/lints`
 * decides; results append to `release_gate_results` — append-only
 * audit, one row per gate per evaluation. A `waived` verdict is the
 * recorded human override: it counts as pass only while bound to the
 * current manifest version (a re-cut invalidates it, invariant 3).
 */
import { TERMINAL_STATUSES, type ReleaseRow } from '@sprint-runner/core';
import {
  evaluateReleaseGates,
  type ReleaseGateCheck,
  type ReleaseGateFacts,
  type ReleaseGateId,
} from '@sprint-runner/lints';
import { resolveManifestMembers } from './manifest.js';
import { ReleaseError, type ReleaseCtx } from './types.js';

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/** The correction facts don't have to be material — materiality is
 *  the evaluator's call; gathering keeps every correction so the gate
 *  detail explains itself (minor/trivial pass through, never block). */
async function gatherCorrections(ctx: ReleaseCtx, memberIds: string[]) {
  const members = new Set(memberIds);
  const tickets = await ctx.store.listTickets({ workspace: ctx.workspace });
  return tickets
    .filter(
      (t) =>
        t.origin === 'correction' && t.parent != null && members.has(t.parent),
    )
    .map((t) => ({
      parent: t.parent as string,
      correction_id: t.ticket_id,
      severity: t.severity ?? null,
      open: !TERMINAL.has(t.status),
    }));
}

/** Gates with a `waived` verdict bound to `manifestVersion` — the
 *  recorded human override for the current cut only. */
async function waivedGates(
  ctx: ReleaseCtx,
  releaseId: string,
  manifestVersion: number | null,
): Promise<ReleaseGateId[]> {
  if (manifestVersion == null) return [];
  const rows = await ctx.store.listReleaseGateResults({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  const latest = new Map<ReleaseGateId, (typeof rows)[number]>();
  for (const row of rows) {
    const ev = row.evidence as { manifest_version?: number } | null;
    if (ev?.manifest_version !== manifestVersion) continue;
    latest.set(row.gate as ReleaseGateId, row);
  }
  return [...latest.entries()]
    .filter(([, row]) => row.result === 'waived')
    .map(([gate]) => gate);
}

/** Assemble the evaluator's facts for a release's CURRENT state. */
export async function gatherReleaseGateFacts(
  ctx: ReleaseCtx,
  release: ReleaseRow,
): Promise<ReleaseGateFacts> {
  const manifest = await ctx.store.getReleaseManifest({
    workspace: ctx.workspace,
    release_id: release.release_id,
  });
  const [approvals, items] = await Promise.all([
    manifest
      ? ctx.store.listReleaseApprovals({
          workspace: ctx.workspace,
          release_id: release.release_id,
          manifest_version: manifest.version,
        })
      : Promise.resolve([]),
    ctx.store.listReleaseItems({
      workspace: ctx.workspace,
      release_id: release.release_id,
    }),
  ]);
  const members = manifest
    ? await resolveManifestMembers(ctx, manifest.items)
    : [];
  const corrections = await gatherCorrections(
    ctx,
    members.map((t) => t.ticket_id),
  );
  const waived = await waivedGates(ctx, release.release_id, manifest?.version ?? null);
  return {
    manifest: manifest
      ? {
          version: manifest.version,
          digest: manifest.digest,
          items: manifest.items,
        }
      : null,
    approvals: approvals.map((a) => ({
      approver: a.approver,
      decision: a.decision,
    })),
    items,
    members: members.map((t) => ({
      ticket_id: t.ticket_id,
      status: t.status,
    })),
    corrections,
    waived,
  };
}

/** Evaluate the five release gates against live state (no writes). */
export async function evaluateRelease(
  ctx: ReleaseCtx,
  release: ReleaseRow,
): Promise<{ checks: ReleaseGateCheck[]; facts: ReleaseGateFacts }> {
  const facts = await gatherReleaseGateFacts(ctx, release);
  return { checks: evaluateReleaseGates(facts), facts };
}

/** Append one `release_gate_results` row per check — the audit of an
 *  evaluation pass. Each row's evidence binds it to the manifest
 *  version it evaluated, so a re-cut can't launder old verdicts. */
export async function recordReleaseGates(
  ctx: ReleaseCtx,
  release: ReleaseRow,
  checks: ReleaseGateCheck[],
  facts: ReleaseGateFacts,
): Promise<void> {
  const ts = ctx.now().toISOString();
  for (const c of checks) {
    await ctx.store.appendReleaseGateResult({
      workspace: ctx.workspace,
      release_id: release.release_id,
      gate: c.gate,
      result: c.verdict,
      evidence: {
        manifest_version: facts.manifest?.version ?? null,
        ...(c.detail ? { detail: c.detail } : {}),
      },
      checked_at: ts,
    });
  }
}

/**
 * Record a human waiver for one gate on the current manifest version.
 * A waiver is an explicit override — `by` + `rationale` are required
 * (fail-closed: an unattributed waiver is meaningless). Only gates
 * that currently FAIL can be waived — waiving a passing gate is a
 * no-op-shaped audit smell, reject it.
 */
export async function waiveReleaseGate(
  ctx: ReleaseCtx,
  release: ReleaseRow,
  gate: ReleaseGateId,
  opts: { by: string; rationale: string },
): Promise<void> {
  if (!opts.rationale?.trim()) {
    throw new ReleaseError(
      'bad-item',
      `waive ${gate}: rationale is required — a waiver is a recorded human override`,
    );
  }
  const { checks, facts } = await evaluateRelease(ctx, release);
  const check = checks.find((c) => c.gate === gate);
  if (!check) {
    throw new ReleaseError('not-found', `unknown release gate '${gate}'`);
  }
  if (check.verdict !== 'fail') {
    throw new ReleaseError(
      'bad-state',
      `gate '${gate}' is '${check.verdict}' — only a failing gate can be waived`,
    );
  }
  await ctx.store.appendReleaseGateResult({
    workspace: ctx.workspace,
    release_id: release.release_id,
    gate,
    result: 'waived',
    evidence: {
      manifest_version: facts.manifest?.version ?? null,
      by: opts.by,
      rationale: opts.rationale,
      waived_detail: check.detail ?? null,
    },
    checked_at: ctx.now().toISOString(),
  });
}
