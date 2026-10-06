/**
 * release/notes.ts — three-audience release notes (DELIVERY §3,
 * wp-135).
 *
 * Content lives in `doc_versions(<release>, 'notes-<audience>.md')`;
 * the `release_notes` row is PUBLICATION metadata. `doc_version`
 * pins the APPROVED revision — a draft landing after approval never
 * silently becomes the published content (invariant 6: AI output is
 * ai-suggested until a human approval event exists; approval binds to
 * the doc version it approved).
 *
 *   draft   → append doc_version; row exists with all-null metadata
 *   approve → human only; pins doc_version = latest draft, sets
 *             approved_by/at, emits `release_note_approved`
 *   publish → requires approval; sets published_at
 */
import {
  type ActorType,
  type DocKind,
  RELEASE_NOTE_AUDIENCES,
  type ReleaseNoteAudience,
  type ReleaseNoteRow,
  type ReleaseRow,
} from '@sprint-runner/core';
import { type ReleaseCtx, ReleaseError } from './types.js';

const AUDIENCES = new Set<string>(RELEASE_NOTE_AUDIENCES);

/** `notes-<audience>.md` doc kind for an audience (DOC_KINDS, wp-132). */
export function releaseNoteDoc(audience: ReleaseNoteAudience): DocKind {
  return `notes-${audience}.md` as DocKind;
}

function requireAudience(audience: string): ReleaseNoteAudience {
  if (!AUDIENCES.has(audience)) {
    throw new ReleaseError(
      'bad-item',
      `notes audience '${audience}' is not one of ${RELEASE_NOTE_AUDIENCES.join('|')}`,
    );
  }
  return audience as ReleaseNoteAudience;
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

/**
 * Save a notes draft — used by the `release-notes` stage ingest AND by
 * direct human edits. Appends `notes-<audience>.md` and upserts the
 * `release_notes` row PRESERVING publication metadata: doc_version
 * stays pinned to the approved revision (or null), so a re-draft never
 * launders unapproved content into a published note.
 */
export async function saveReleaseNoteDraft(
  ctx: ReleaseCtx,
  releaseId: string,
  args: {
    audience: string;
    content: string;
    editedBy?: string;
  },
): Promise<ReleaseNoteRow> {
  const release = await requireRelease(ctx, releaseId);
  const audience = requireAudience(args.audience);
  if (!args.content?.trim()) {
    throw new ReleaseError(
      'bad-item',
      `notes ${releaseId}/${audience}: empty draft content`,
    );
  }
  const version = await ctx.store.appendDocVersion(
    {
      workspace: ctx.workspace,
      subject: releaseId,
      doc: releaseNoteDoc(audience),
    },
    args.content,
    args.editedBy ?? ctx.actor,
  );
  const existing = await ctx.store.getReleaseNote({
    workspace: ctx.workspace,
    release_id: releaseId,
    audience,
  });
  const row: ReleaseNoteRow = {
    workspace: ctx.workspace,
    release_id: releaseId,
    audience,
    doc_version: existing?.doc_version ?? null,
    approved_by: existing?.approved_by ?? null,
    approved_at: existing?.approved_at ?? null,
    published_at: existing?.published_at ?? null,
  };
  await ctx.store.upsertReleaseNote(row);
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: releaseId,
    ts: ctx.now().toISOString(),
    stage: null,
    actor_type: 'human',
    actor_id: ctx.actor,
    event: 'doc_drafted',
    run: null,
    refs: [`doc:${releaseId}:notes-${audience}.md:v${version.version}`],
    data: {
      doc: `notes-${audience}.md`,
      audience,
      doc_version: version.version,
    },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  return row;
}

/**
 * Human approval of the CURRENT draft — pins `doc_version` to the
 * latest `notes-<audience>.md` revision and stamps approved_by/at.
 * Agents can never approve (invariant 6). Emits
 * `release_note_approved` on the release subject.
 */
export async function approveReleaseNote(
  ctx: ReleaseCtx,
  releaseId: string,
  args: {
    audience: string;
    approver: string;
    actorType: ActorType;
  },
): Promise<ReleaseNoteRow> {
  await requireRelease(ctx, releaseId);
  const audience = requireAudience(args.audience);
  if (args.actorType !== 'human') {
    throw new ReleaseError(
      'ai-approval',
      `notes ${releaseId}/${audience}: only a human can approve (actorType '${args.actorType}') — DELIVERY invariant 6`,
    );
  }
  if (!args.approver?.trim()) {
    throw new ReleaseError('bad-item', 'approver identity is required');
  }
  const draft = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject: releaseId,
    doc: releaseNoteDoc(audience),
  });
  if (!draft) {
    throw new ReleaseError(
      'bad-state',
      `notes ${releaseId}/${audience}: no draft to approve — write notes-${audience}.md first`,
    );
  }
  const ts = ctx.now().toISOString();
  const existing = await ctx.store.getReleaseNote({
    workspace: ctx.workspace,
    release_id: releaseId,
    audience,
  });
  const row: ReleaseNoteRow = {
    workspace: ctx.workspace,
    release_id: releaseId,
    audience,
    doc_version: draft.version,
    approved_by: args.approver,
    approved_at: ts,
    published_at: existing?.published_at ?? null,
  };
  await ctx.store.upsertReleaseNote(row);
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: releaseId,
    ts,
    stage: null,
    actor_type: 'human',
    actor_id: ctx.actor,
    event: 'release_note_approved',
    run: null,
    refs: [`doc:${releaseId}:notes-${audience}.md:v${draft.version}`],
    data: { audience, doc_version: draft.version, approver: args.approver },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  return row;
}

/**
 * Mark an approved note published. Fail-closed: `published_at` can
 * only be set after a human approval exists (`doc_version` + approved_*
 * set) — and a draft newer than the approved revision does NOT reset
 * publication; the pinned approved revision is what ships.
 */
export async function publishReleaseNote(
  ctx: ReleaseCtx,
  releaseId: string,
  args: { audience: string },
): Promise<ReleaseNoteRow> {
  await requireRelease(ctx, releaseId);
  const audience = requireAudience(args.audience);
  const row = await ctx.store.getReleaseNote({
    workspace: ctx.workspace,
    release_id: releaseId,
    audience,
  });
  if (!row || row.doc_version == null || !row.approved_by) {
    throw new ReleaseError(
      'not-approved',
      `notes ${releaseId}/${audience}: publish requires a human-approved doc_version first (DELIVERY §3)`,
    );
  }
  const next: ReleaseNoteRow = {
    ...row,
    published_at: row.published_at ?? ctx.now().toISOString(),
  };
  if (next.published_at !== row.published_at) {
    await ctx.store.upsertReleaseNote(next);
  }
  return next;
}

/**
 * Transition-table handoff for a `release-notes` run that emitted
 * `DONE`: the run's `notes-<audience>.md` files were already ingested
 * into `doc_versions` by reconcile — this materializes the
 * `release_notes` metadata rows. Fail-closed: DONE with any audience
 * doc missing is malformed output — nothing is written; the caller
 * surfaces it.
 *
 * @returns drafted audiences + missing ones (empty missing = clean).
 */
export async function registerNotesDraft(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<{ drafted: ReleaseNoteAudience[]; missing: ReleaseNoteAudience[] }> {
  await requireRelease(ctx, releaseId);
  const drafted: ReleaseNoteAudience[] = [];
  const missing: ReleaseNoteAudience[] = [];
  const found: { audience: ReleaseNoteAudience; version: number }[] = [];
  for (const audience of RELEASE_NOTE_AUDIENCES) {
    const doc = await ctx.store.getDoc({
      workspace: ctx.workspace,
      subject: releaseId,
      doc: releaseNoteDoc(audience),
    });
    if (doc) found.push({ audience, version: doc.version });
    else missing.push(audience);
  }
  if (missing.length > 0) {
    return { drafted, missing };
  }
  for (const { audience } of found) {
    const existing = await ctx.store.getReleaseNote({
      workspace: ctx.workspace,
      release_id: releaseId,
      audience,
    });
    await ctx.store.upsertReleaseNote({
      workspace: ctx.workspace,
      release_id: releaseId,
      audience,
      doc_version: existing?.doc_version ?? null,
      approved_by: existing?.approved_by ?? null,
      approved_at: existing?.approved_at ?? null,
      published_at: existing?.published_at ?? null,
    });
    drafted.push(audience);
  }
  return { drafted, missing };
}
