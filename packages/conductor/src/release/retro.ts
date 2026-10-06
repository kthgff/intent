/**
 * release/retro.ts — release retrospectives + the release bundle that
 * feeds the `retro` and `release-notes` stages (DELIVERY §5/§7,
 * wp-135).
 *
 * - {@link buildReleaseBundle} renders the frozen manifest + delivery
 *   evidence (items, members, deployments, exposure, KPI outcomes,
 *   notes status) as the `RELEASE_MD` prompt token — the honest record
 *   the agent compares against the approved RS.
 * - {@link retroRunRequest} / {@link releaseNotesRunRequest} build the
 *   RunRequest the caller queues (API `POST …/retro` lands with
 *   wp-136; DELIVERY §4.1 keeps `close` itself silent).
 * - {@link completeRetro} is the transition-side commit of a `retro`
 *   run: `retro.md` is already a doc_version (reconcile ingested it),
 *   `retro-proposals.json` becomes DRAFT board items — tray cards,
 *   never committed scope (invariant 6). Emits `retro_completed`.
 */
import { randomUUID } from 'node:crypto';
import {
  type BoardItem,
  RELEASE_NOTE_AUDIENCES,
  type ReleaseRow,
} from '@sprint-runner/core';
import { z } from 'zod';
import type { RunRequest } from '../contracts.js';
import { resolveManifestMembers } from './manifest.js';
import { releaseNoteDoc } from './notes.js';
import { type ReleaseCtx, ReleaseError } from './types.js';

/** A retro may only run on a shipped release — there is nothing to
 *  retrospect before `released`. `closed` stays legal so a re-retro
 *  (fresh KPI numbers) can land after closure. */
const RETROABLE = new Set(['released', 'closed']);

/** The retro run's structured side-output: draft board proposals —
 *  never committed scope (DELIVERY §7 + invariant 6). Malformed JSON
 *  or a bad shape fails the whole commit (nothing is written). */
export const RETRO_PROPOSALS_ARTIFACT = 'retro-proposals.json';

const RetroProposalSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullish(),
  /** Subjects the proposal touches (ticket/feature/… ids — advisory). */
  refs: z.array(z.string()).nullish(),
});
export const RetroProposalsSchema = z.object({
  schema: z.number().int().optional(),
  proposals: z.array(RetroProposalSchema).default([]),
});
export type RetroProposal = z.infer<typeof RetroProposalSchema>;

export function parseRetroProposals(raw: string): RetroProposal[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ReleaseError(
      'bad-item',
      `${RETRO_PROPOSALS_ARTIFACT}: malformed JSON — the retro batch is all-or-nothing`,
    );
  }
  const parsed = RetroProposalsSchema.safeParse(json);
  if (!parsed.success) {
    throw new ReleaseError(
      'bad-item',
      `${RETRO_PROPOSALS_ARTIFACT}: ${parsed.error.issues[0]?.message ?? 'invalid shape'}`,
    );
  }
  return parsed.data.proposals;
}

async function requireRelease(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<ReleaseRow> {
  const release = await ctx.store.getRelease({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  if (!release) {
    throw new ReleaseError('not-found', `no release ${releaseId}`);
  }
  return release;
}

// ---------------------------------------------------------------------------
// RELEASE_MD — the bundle injected into retro + release-notes prompts
// ---------------------------------------------------------------------------

function cell(v: unknown): string {
  const s = v == null || v === '' ? '—' : String(v);
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Render the release's full delivery record as markdown — the
 * `RELEASE_MD` token. Deterministic and honest: empty sections render
 * "none recorded", never disappear (the agent must see the absence).
 */
export async function buildReleaseBundle(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<string> {
  const release = await requireRelease(ctx, releaseId);
  const [items, manifests, deployments, outcomes, notes] = await Promise.all([
    ctx.store.listReleaseItems({
      workspace: ctx.workspace,
      release_id: releaseId,
    }),
    ctx.store.listReleaseManifests({
      workspace: ctx.workspace,
      release_id: releaseId,
    }),
    ctx.store.listDeployments({
      workspace: ctx.workspace,
      release_id: releaseId,
    }),
    ctx.store.listReleaseOutcomes({
      workspace: ctx.workspace,
      release_id: releaseId,
    }),
    ctx.store.listReleaseNotes({
      workspace: ctx.workspace,
      release_id: releaseId,
    }),
  ]);
  const manifest = manifests.at(-1) ?? null;
  const members = manifest
    ? await resolveManifestMembers(ctx, manifest.items)
    : [];
  const featureIds = new Set(
    items.filter((i) => i.item_kind === 'feature').map((i) => i.item_id),
  );
  for (const t of members) if (t.feature) featureIds.add(t.feature);
  const exposure: Awaited<ReturnType<typeof ctx.store.listFeatureExposure>> =
    [];
  for (const f of [...featureIds].sort()) {
    exposure.push(
      ...(await ctx.store.listFeatureExposure({
        workspace: ctx.workspace,
        feature_id: f,
      })),
    );
  }

  const L: string[] = [
    `# Release ${release.release_id} — ${release.title}`,
    '',
    `status: ${release.status} · target: ${release.target ?? '—'} · created_by: ${release.created_by ?? '—'}`,
    '',
    `## Manifest ${manifest ? `v${manifest.version} (${manifest.digest.slice(0, 19)}…)` : '(none — scope was never frozen)'}`,
    '',
  ];
  if (manifest) {
    L.push('| item | kind | partial_ac | repos |');
    L.push('| --- | --- | --- | --- |');
    for (const item of manifest.items) {
      L.push(
        `| ${item.item_id} | ${item.item_kind} | ${item.partial_ac ? item.partial_ac.join(', ') : 'full'} | ${
          item.repos
            .map(
              (r) =>
                `${r.repo}@${(r.merged_sha ?? 'UNMERGED').slice(0, 12)}${r.ticket ? ` (${r.ticket})` : ''}`,
            )
            .join('<br>') || '—'
        } |`,
      );
    }
  }
  L.push('', '## Live items (delivery dimension)', '');
  if (items.length === 0) L.push('none recorded');
  else {
    L.push('| item | kind | delivery_state | approved_by | added_by |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const i of items) {
      L.push(
        `| ${i.item_id} | ${i.item_kind} | ${i.delivery_state} | ${cell(i.approved_by)} | ${cell(i.added_by)} |`,
      );
    }
  }
  L.push('', '## Member tickets', '');
  if (members.length === 0) L.push('none recorded');
  else {
    L.push('| ticket | status | title |');
    L.push('| --- | --- | --- |');
    for (const t of members) {
      L.push(`| ${t.ticket_id} | ${t.status} | ${cell(t.title)} |`);
    }
  }
  L.push('', '## Deployments', '');
  if (deployments.length === 0) L.push('none recorded');
  else {
    L.push('| deployment | env | sha | evidence | confirmed |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const d of deployments) {
      const ev = d.evidence;
      L.push(
        `| ${d.deployment_id} | ${d.environment} | ${d.sha.slice(0, 12)} | ${cell(`${ev.type} by ${ev.by ?? '?'}: ${ev.note ?? ''}`)} | ${cell(d.confirmed_at)} |`,
      );
    }
  }
  L.push('', '## Feature exposure', '');
  if (exposure.length === 0) L.push('none recorded');
  else {
    L.push('| feature | env | state | audience | deployment |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const e of exposure) {
      L.push(
        `| ${e.feature_id} | ${e.environment} | ${e.state} | ${cell(e.audience)} | ${cell(e.deployment_id)} |`,
      );
    }
  }
  L.push('', '## KPI outcomes', '');
  if (outcomes.length === 0) L.push('none recorded');
  else {
    L.push('| kpi | baseline | target | observed | unit | measured_at |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const o of outcomes) {
      L.push(
        `| ${o.kpi} | ${cell(o.data.baseline)} | ${cell(o.data.target)} | ${cell(o.data.observed)} | ${cell(o.data.unit)} | ${cell(o.measured_at)} |`,
      );
    }
  }
  L.push('', '## Release notes', '');
  const noteByAudience = new Map(notes.map((n) => [n.audience, n]));
  L.push('| audience | approved_revision | approved_by | published |');
  L.push('| --- | --- | --- | --- |');
  for (const audience of RELEASE_NOTE_AUDIENCES) {
    const n = noteByAudience.get(audience);
    const doc = await ctx.store.getDoc({
      workspace: ctx.workspace,
      subject: releaseId,
      doc: releaseNoteDoc(audience),
    });
    L.push(
      `| ${audience} | ${cell(n?.doc_version ? `v${n.doc_version}` : doc ? `draft v${doc.version} (unapproved)` : 'none')} | ${cell(n?.approved_by)} | ${cell(n?.published_at)} |`,
    );
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// run requests — the caller queues these (API POST …/retro, wp-136)
// ---------------------------------------------------------------------------

/** RunRequest for the `retro` stage on a shipped release. */
export async function retroRunRequest(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<RunRequest> {
  const release = await requireRelease(ctx, releaseId);
  if (!RETROABLE.has(release.status)) {
    throw new ReleaseError(
      'bad-state',
      `retro: release ${releaseId} is '${release.status}' — retrospectives run on released|closed work (DELIVERY §7)`,
    );
  }
  return { workspace: ctx.workspace, subject: releaseId, stage: 'retro' };
}

/** RunRequest for the `release-notes` stage — requires a frozen
 *  manifest (the notes describe the approved cut, not live scope). */
export async function releaseNotesRunRequest(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<RunRequest> {
  const release = await requireRelease(ctx, releaseId);
  const manifest = await ctx.store.getReleaseManifest({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  if (!manifest) {
    throw new ReleaseError(
      'bad-state',
      `release-notes: release ${releaseId} has no frozen manifest — freeze scope first (DELIVERY §5)`,
    );
  }
  return {
    workspace: ctx.workspace,
    subject: releaseId,
    stage: 'release-notes',
  };
}

// ---------------------------------------------------------------------------
// retro completion — transition-side commit (retro | DONE)
// ---------------------------------------------------------------------------

/**
 * Commit a completed `retro` run for `releaseId`: require the ingested
 * `retro.md` doc_version, parse `retro-proposals.json` (absent = zero
 * proposals; malformed = throw — nothing commits), create DRAFT board
 * items in the capture tray (kind `retro`, status `icebox`,
 * provenance `inferred` — ai-suggested, never auto-approvable), and
 * emit `retro_completed`. No tickets, releases, or scope are touched —
 * proposals are advisories a human triages (invariant 6).
 */
export async function completeRetro(
  ctx: ReleaseCtx,
  releaseId: string,
  opts: { runId?: string | null } = {},
): Promise<{ docVersion: number; proposalIds: string[] }> {
  const release = await requireRelease(ctx, releaseId);
  if (!RETROABLE.has(release.status)) {
    throw new ReleaseError(
      'bad-state',
      `retro: release ${releaseId} is '${release.status}' — nothing shipped to retrospect`,
    );
  }
  const retro = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject: releaseId,
    doc: 'retro.md',
  });
  if (!retro) {
    throw new ReleaseError(
      'bad-state',
      `retro ${releaseId}: DONE without a retro.md doc_version — malformed run output`,
    );
  }
  let proposals: RetroProposal[] = [];
  if (opts.runId) {
    const raw = await ctx.store.getArtifact(
      opts.runId,
      RETRO_PROPOSALS_ARTIFACT,
    );
    if (raw) proposals = parseRetroProposals(raw.content);
  }

  const ts = ctx.now().toISOString();
  const proposalIds: string[] = [];
  for (const p of proposals) {
    const item: BoardItem = {
      id: `bi-${randomUUID().slice(0, 12)}`,
      workspace: ctx.workspace,
      board: null, // capture tray — a human triages it onward (D27)
      kind: 'retro',
      ref: releaseId,
      title: p.title,
      body: p.body ?? null,
      status: 'icebox',
      consumed_by: null,
      applies_to: p.refs ?? null,
      provenance: 'inferred', // ai-suggested — never auto-approves
      created_at: ts,
      updated_at: ts,
    };
    await ctx.store.upsertBoardItem(item);
    proposalIds.push(item.id);
  }
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: releaseId,
    ts,
    stage: 'retro',
    actor_type: 'agent',
    actor_id: ctx.actor,
    event: 'retro_completed',
    run: opts.runId ?? null,
    refs: [`doc:${releaseId}:retro.md:v${retro.version}`, ...proposalIds],
    data: {
      retro_doc_version: retro.version,
      proposals: proposalIds,
      proposal_count: proposalIds.length,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  return { docVersion: retro.version, proposalIds };
}
