/**
 * release/center.ts — the Release Center lifecycle engine (DELIVERY
 * §3–§4, wp-134).
 *
 *   draft → ready → approved → released → closed
 *                    │           │
 *                    └─ reject ──┘         …→ abandoned (terminal)
 *
 * Rules (all fail-closed — an illegal transition throws ReleaseError):
 *
 *   - `freeze` cuts an immutable `release_manifests` version (sha256
 *     over the item→repo→merged_sha map) and moves draft → ready.
 *   - A scope change (item add/remove) after a cut APPENDS a new
 *     manifest version and drops `approved` → `ready` — approvals bind
 *     to the digest, so the new version starts unapproved (invariant
 *     3). Old approval rows stay for audit, never count again.
 *   - `approve` is human-only (invariant 6) and binds to the LATEST
 *     manifest version; `rejected` returns the release to `draft`.
 *   - `markReleased` requires status `approved` + all five gates
 *     green, then flips member tickets → `released` and the release →
 *     `released` in ONE transaction (invariant 2).
 */
import type {
  ActorType,
  EventName,
  ReleaseApprovalRow,
  ReleaseItemKind,
  ReleaseItemRow,
  ReleaseManifestRow,
  ReleaseNoteRow,
  ReleaseRow,
  ReleaseStatus,
} from '@sprint-runner/core';
import { releaseGatesGreen, releaseManifestDigest } from '@sprint-runner/lints';
import { applyTicketStatusTx } from '../contracts.js';
import {
  evaluateRelease,
  recordReleaseGates,
} from './gates.js';
import { buildManifestItems, resolveManifestMembers } from './manifest.js';
import { ReleaseError, type ReleaseCtx } from './types.js';

/** Statuses in which scope is editable. `released`/`closed`/`abandoned`
 *  are frozen forever. */
const SCOPE_MUTABLE = new Set<ReleaseStatus>(['draft', 'ready', 'approved']);

/** Statuses from which `freeze` is meaningful. `approved` freeze is a
 *  no-op (scope changes already reverted it via the auto-recut). */
const FREEZABLE = new Set<ReleaseStatus>(['draft', 'ready', 'approved']);

const APPROVABLE = new Set<ReleaseStatus>(['ready', 'approved']);

const ABANDONABLE = new Set<ReleaseStatus>(['draft', 'ready', 'approved']);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

function requireStatus(
  release: ReleaseRow,
  allowed: ReadonlySet<string>,
  what: string,
): void {
  if (!allowed.has(release.status)) {
    throw new ReleaseError(
      'bad-state',
      `${what}: release ${release.release_id} is '${release.status}' (allowed: ${[...allowed].join('|')})`,
    );
  }
}

/** Release-scoped event — `ticket_id` carries the REL-NNNN subject so
 *  `listEvents({subject})` and SSE pick it up (events table has no
 *  generic subject column). */
async function releaseEvent(
  ctx: ReleaseCtx,
  releaseId: string,
  event: EventName,
  data: Record<string, unknown>,
  opts: { refs?: string[]; actorType?: ActorType } = {},
): Promise<void> {
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: releaseId,
    ts: ctx.now().toISOString(),
    stage: null,
    actor_type: opts.actorType ?? 'human',
    actor_id: ctx.actor,
    event,
    run: null,
    refs: opts.refs ?? [],
    data,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
}

async function setStatus(
  ctx: ReleaseCtx,
  release: ReleaseRow,
  status: ReleaseStatus,
): Promise<ReleaseRow> {
  const next: ReleaseRow = {
    ...release,
    status,
    updated_at: ctx.now().toISOString(),
  };
  await ctx.store.upsertRelease(next);
  return next;
}

/**
 * Cut a manifest version for the release's CURRENT live scope. When
 * the digest matches the latest cut the scope is already frozen —
 * returns the existing row (idempotent, no version churn).
 */
async function cutManifest(
  ctx: ReleaseCtx,
  release: ReleaseRow,
): Promise<{ manifest: ReleaseManifestRow; fresh: boolean }> {
  const items = await ctx.store.listReleaseItems({
    workspace: ctx.workspace,
    release_id: release.release_id,
  });
  if (items.length === 0) {
    throw new ReleaseError(
      'empty-manifest',
      `release ${release.release_id} has no live items — nothing to freeze`,
    );
  }
  const manifestItems = await buildManifestItems(ctx, items);
  const digest = releaseManifestDigest(manifestItems);
  const latest = await ctx.store.getReleaseManifest({
    workspace: ctx.workspace,
    release_id: release.release_id,
  });
  if (latest && latest.digest === digest) {
    return { manifest: latest, fresh: false };
  }
  const version = (latest?.version ?? 0) + 1;
  const manifest: ReleaseManifestRow = {
    workspace: ctx.workspace,
    release_id: release.release_id,
    version,
    digest,
    items: manifestItems,
    created_at: ctx.now().toISOString(),
  };
  await ctx.store.appendReleaseManifest(manifest);
  await releaseEvent(ctx, release.release_id, 'manifest_cut', {
    version,
    digest,
    items: manifestItems.length,
    repos: manifestItems.reduce((n, i) => n + i.repos.length, 0),
  });
  return { manifest, fresh: true };
}

/**
 * Invariant 3 — a scope change after a cut appends a new manifest
 * version and resets pending approvals: approvals bind to the version
 * they approved, so the new cut starts clean. `approved` drops back to
 * `ready` (it must be re-approved against the new digest).
 */
async function recutAfterScopeChange(
  ctx: ReleaseCtx,
  release: ReleaseRow,
): Promise<void> {
  const latest = await ctx.store.getReleaseManifest({
    workspace: ctx.workspace,
    release_id: release.release_id,
  });
  if (!latest) return; // never frozen — scope is still draft
  await cutManifest(ctx, release);
  if (release.status === 'approved') {
    await setStatus(ctx, release, 'ready');
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** Create a `draft` release (REL-NNNN from projects.next_release_seq). */
export async function createRelease(
  ctx: ReleaseCtx,
  args: { title: string; target?: string | null; createdBy?: string },
): Promise<ReleaseRow> {
  if (!args.title?.trim()) {
    throw new ReleaseError('bad-item', 'release title is required');
  }
  const ts = ctx.now().toISOString();
  const release_id = await ctx.store.allocReleaseId(ctx.workspace);
  const row: ReleaseRow = {
    workspace: ctx.workspace,
    release_id,
    title: args.title,
    status: 'draft',
    target: args.target ?? null,
    created_by: args.createdBy ?? ctx.actor,
    created_at: ts,
    updated_at: ts,
  };
  await ctx.store.upsertRelease(row);
  await releaseEvent(ctx, release_id, 'release_created', {
    title: args.title,
    target: args.target ?? null,
  });
  return row;
}

/**
 * Add a scope item. Feature-first membership: `feature` covers every
 * member ticket; `ticket` covers standalone work. `partial_ac` (a
 * non-empty ac_ids subset) REQUIRES `approved_by` — invariant 5. An
 * agent may PROPOSE membership (`addedBy` may be an agent) but cannot
 * supply `approvedBy` — the item-level approver is human. A post-freeze
 * add cuts a new manifest version (invariant 3).
 */
export async function addReleaseItem(
  ctx: ReleaseCtx,
  releaseId: string,
  args: {
    itemKind: ReleaseItemKind;
    itemId: string;
    partialAc?: string[] | null;
    approvedBy?: string | null;
    addedBy?: string;
    actorType?: ActorType;
  },
): Promise<ReleaseItemRow> {
  const release = await requireRelease(ctx, releaseId);
  requireStatus(release, SCOPE_MUTABLE, 'add item');

  const partialAc = args.partialAc ?? null;
  if (partialAc != null && partialAc.length === 0) {
    throw new ReleaseError(
      'bad-item',
      `item ${args.itemId}: partial_ac must be null (full) or a non-empty ac_ids list`,
    );
  }
  if (partialAc != null && !args.approvedBy) {
    throw new ReleaseError(
      'partial-unapproved',
      `item ${args.itemId}: partial_ac requires approved_by (DELIVERY invariant 5)`,
    );
  }
  if (args.approvedBy && args.actorType === 'agent') {
    throw new ReleaseError(
      'ai-approval',
      `item ${args.itemId}: an agent cannot approve a partial release (DELIVERY invariant 6)`,
    );
  }
  if (args.itemKind === 'ticket') {
    const ticket = await ctx.store.getTicket({
      workspace: ctx.workspace,
      ticket_id: args.itemId,
    });
    if (!ticket) {
      throw new ReleaseError('not-found', `item ticket ${args.itemId} not found`);
    }
  } else {
    const feature = await ctx.store.getFeature(
      ctx.workspace,
      args.itemId,
    );
    if (!feature) {
      throw new ReleaseError(
        'not-found',
        `item feature ${args.itemId} not found`,
      );
    }
  }

  const existing = (
    await ctx.store.listReleaseItems({
      workspace: ctx.workspace,
      release_id: releaseId,
    })
  ).find((i) => i.item_kind === args.itemKind && i.item_id === args.itemId);
  const ts = ctx.now().toISOString();
  const row: ReleaseItemRow = {
    workspace: ctx.workspace,
    release_id: releaseId,
    item_kind: args.itemKind,
    item_id: args.itemId,
    partial_ac: partialAc,
    delivery_state: existing?.delivery_state ?? 'planned',
    approved_by: args.approvedBy ?? null,
    added_by: args.addedBy ?? ctx.actor,
    added_at: ts,
    removed_at: null,
  };
  await ctx.store.upsertReleaseItem(row);
  await releaseEvent(ctx, releaseId, 'release_items_changed', {
    added: {
      item_kind: args.itemKind,
      item_id: args.itemId,
      partial_ac: partialAc,
      approved_by: args.approvedBy ?? null,
    },
  });
  await recutAfterScopeChange(ctx, release);
  return row;
}

/** Soft-remove a scope item (`removed_at` — the row stays for audit).
 *  A post-freeze remove cuts a new manifest version (invariant 3). */
export async function removeReleaseItem(
  ctx: ReleaseCtx,
  releaseId: string,
  args: { itemKind: ReleaseItemKind; itemId: string },
): Promise<void> {
  const release = await requireRelease(ctx, releaseId);
  requireStatus(release, SCOPE_MUTABLE, 'remove item');
  const live = await ctx.store.listReleaseItems({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  const item = live.find(
    (i) => i.item_kind === args.itemKind && i.item_id === args.itemId,
  );
  if (!item) {
    throw new ReleaseError(
      'not-found',
      `release ${releaseId} has no live ${args.itemKind} item ${args.itemId}`,
    );
  }
  const ts = ctx.now().toISOString();
  await ctx.store.removeReleaseItem(
    {
      workspace: ctx.workspace,
      release_id: releaseId,
      item_kind: args.itemKind,
      item_id: args.itemId,
    },
    ts,
  );
  await releaseEvent(ctx, releaseId, 'release_items_changed', {
    removed: { item_kind: args.itemKind, item_id: args.itemId },
  });
  await recutAfterScopeChange(ctx, release);
}

/**
 * Freeze the current scope: cut a `release_manifests` version and move
 * `draft → ready`. Idempotent on an unchanged digest. Post-freeze
 * scope changes re-cut automatically via add/remove (invariant 3).
 */
export async function freezeRelease(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<ReleaseManifestRow> {
  const release = await requireRelease(ctx, releaseId);
  requireStatus(release, FREEZABLE, 'freeze');
  if (release.status === 'approved') {
    // Scope is frozen AND approved; freeze is a no-op returning the
    // approved cut (any scope change would already have reverted this).
    const manifest = await ctx.store.getReleaseManifest({
      workspace: ctx.workspace,
      release_id: releaseId,
    });
    if (!manifest) {
      throw new ReleaseError(
        'bad-state',
        `release ${releaseId} is approved with no manifest — corrupt state`,
      );
    }
    return manifest;
  }
  const { manifest } = await cutManifest(ctx, release);
  if (release.status === 'draft') {
    await setStatus(ctx, release, 'ready');
  }
  return manifest;
}

/**
 * Record a human approval decision bound to the LATEST manifest
 * version (DELIVERY §3 — "approval binds to digest").
 *
 *  - `actorType` must be `human` — invariant 6: AI may propose
 *    membership/notes but never approves.
 *  - `approved` → status `approved`; `rejected` → status `draft`
 *    (the release needs re-scoping; a later freeze cuts a new version).
 *  - Emits `release_approved` with `decision` in data — the event
 *    records that an approval decision landed, either way.
 */
export async function approveRelease(
  ctx: ReleaseCtx,
  releaseId: string,
  args: {
    approver: string;
    actorType: ActorType;
    decision: 'approved' | 'rejected';
    rationale?: string | null;
  },
): Promise<ReleaseApprovalRow> {
  const release = await requireRelease(ctx, releaseId);
  requireStatus(release, APPROVABLE, 'approve');
  if (args.actorType !== 'human') {
    throw new ReleaseError(
      'ai-approval',
      `release ${releaseId}: only a human can approve (actorType '${args.actorType}') — DELIVERY invariant 6`,
    );
  }
  if (!args.approver?.trim()) {
    throw new ReleaseError('bad-item', 'approver identity is required');
  }
  const manifest = await ctx.store.getReleaseManifest({
    workspace: ctx.workspace,
    release_id: releaseId,
  });
  if (!manifest) {
    throw new ReleaseError(
      'bad-state',
      `release ${releaseId} has no manifest — freeze before approve`,
    );
  }
  const ts = ctx.now().toISOString();
  const row: ReleaseApprovalRow = {
    workspace: ctx.workspace,
    release_id: releaseId,
    manifest_version: manifest.version,
    approver: args.approver,
    decision: args.decision,
    rationale: args.rationale ?? null,
    created_at: ts,
  };
  await ctx.store.appendReleaseApproval(row);
  await setStatus(
    ctx,
    release,
    args.decision === 'approved' ? 'approved' : 'draft',
  );
  await releaseEvent(ctx, releaseId, 'release_approved', {
    manifest_version: manifest.version,
    digest: manifest.digest,
    approver: args.approver,
    decision: args.decision,
  });
  return row;
}

/**
 * `approved → released`. Evaluates all five release gates and appends
 * the `release_gate_results` audit (including the failing attempt),
 * then — only when every gate is pass|waived — flips member tickets
 * `merged → released`, materializes `delivery_state → released`, flips
 * the release, and emits `release_released` in ONE transaction
 * (invariant 2). On gate failure the release stays `approved`.
 */
export async function markReleased(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<{ tickets: string[]; manifest_version: number }> {
  const release = await requireRelease(ctx, releaseId);
  requireStatus(release, new Set<ReleaseStatus>(['approved']), 'release');

  const { checks, facts } = await evaluateRelease(ctx, release);
  await recordReleaseGates(ctx, release, checks, facts);
  const failed = checks.filter((c) => c.verdict === 'fail');
  if (failed.length > 0) {
    throw new ReleaseError(
      'gate-failed',
      `release ${releaseId} blocked: ${failed
        .map((c) => `${c.gate} (${c.detail ?? 'fail'})`)
        .join('; ')}`,
    );
  }
  const manifest = facts.manifest;
  if (!manifest) {
    // evaluateRelease already failed 'manifest' — unreachable, but the
    // invariant-2 read below needs it; keep the guard explicit.
    throw new ReleaseError('gate-failed', `release ${releaseId}: no manifest`);
  }

  return ctx.store.transaction(async (store) => {
    const tx: ReleaseCtx = { ...ctx, store };
    // Re-read inside the tx — status/digest could have raced.
    const current = await store.getRelease({
      workspace: ctx.workspace,
      release_id: releaseId,
    });
    if (!current || current.status !== 'approved') {
      throw new ReleaseError(
        'bad-state',
        `release ${releaseId} left 'approved' mid-flight — aborting`,
      );
    }
    const head = await store.getReleaseManifest({
      workspace: ctx.workspace,
      release_id: releaseId,
    });
    if (!head || head.digest !== manifest.digest) {
      throw new ReleaseError(
        'gate-failed',
        `release ${releaseId}: manifest changed between gate check and release — aborting`,
      );
    }

    const members = await resolveManifestMembers(tx, head.items);
    const flipped: string[] = [];
    const ts = ctx.now().toISOString();
    for (const ticket of members) {
      if (ticket.status === 'released') continue; // idempotent re-release
      if (ticket.status !== 'merged') {
        throw new ReleaseError(
          'gate-failed',
          `member ${ticket.ticket_id} is '${ticket.status}' — invariant 2 requires merged`,
        );
      }
      await applyTicketStatusTx(store, ctx, {
        ticketId: ticket.ticket_id,
        status: 'released',
        data: { release: releaseId, manifest_version: head.version },
      });
      flipped.push(ticket.ticket_id);
    }

    // Materialize the delivery dimension (DELIVERY §1) on live items.
    const items = await store.listReleaseItems({
      workspace: ctx.workspace,
      release_id: releaseId,
    });
    for (const item of items) {
      await store.upsertReleaseItem({ ...item, delivery_state: 'released' });
    }

    await store.upsertRelease({
      ...current,
      status: 'released',
      updated_at: ts,
    });
    await store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: releaseId,
      ts,
      stage: null,
      actor_type: 'human',
      actor_id: ctx.actor,
      event: 'release_released',
      run: null,
      refs: flipped,
      data: {
        manifest_version: head.version,
        digest: head.digest,
        tickets: flipped,
        items: items.map((i) => `${i.item_kind}:${i.item_id}`),
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    return { tickets: flipped, manifest_version: head.version };
  });
}

/** `released → closed` — the retrospective/bookkeeping phase
 *  (wp-135's retro run) is done; the release is finished. */
export async function closeRelease(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<ReleaseRow> {
  const release = await requireRelease(ctx, releaseId);
  requireStatus(release, new Set<ReleaseStatus>(['released']), 'close');
  return setStatus(ctx, release, 'closed');
}

/** `draft|ready|approved → abandoned` — terminal. */
export async function abandonRelease(
  ctx: ReleaseCtx,
  releaseId: string,
  opts: { reason?: string } = {},
): Promise<ReleaseRow> {
  const release = await requireRelease(ctx, releaseId);
  requireStatus(release, ABANDONABLE, 'abandon');
  const next = await setStatus(ctx, release, 'abandoned');
  await releaseEvent(ctx, releaseId, 'discarded', {
    reason: opts.reason ?? null,
  });
  return next;
}

// ---------------------------------------------------------------------------
// read surface (API GET …/releases/:rel — items + manifest + approvals
// + gates; DELIVERY §6)
// ---------------------------------------------------------------------------

export interface ReleaseDetail {
  release: ReleaseRow;
  items: ReleaseItemRow[];
  manifests: ReleaseManifestRow[];
  /** Latest manifest (what approvals/gates bind to). */
  manifest: ReleaseManifestRow | null;
  /** Approvals bound to the LATEST manifest version. */
  approvals: ReleaseApprovalRow[];
  /** All approval rows (audit, incl. superseded versions). */
  approvalHistory: ReleaseApprovalRow[];
  /** Latest recorded verdict per gate id. */
  gates: Record<string, { result: string; checked_at: string }>;
  notes: ReleaseNoteRow[];
}

export async function getReleaseDetail(
  ctx: ReleaseCtx,
  releaseId: string,
): Promise<ReleaseDetail> {
  const release = await requireRelease(ctx, releaseId);
  const [items, manifests, approvalHistory, gateRows, notes] =
    await Promise.all([
      ctx.store.listReleaseItems({
        workspace: ctx.workspace,
        release_id: releaseId,
      }),
      ctx.store.listReleaseManifests({
        workspace: ctx.workspace,
        release_id: releaseId,
      }),
      ctx.store.listReleaseApprovals({
        workspace: ctx.workspace,
        release_id: releaseId,
      }),
      ctx.store.listReleaseGateResults({
        workspace: ctx.workspace,
        release_id: releaseId,
      }),
      ctx.store.listReleaseNotes({
        workspace: ctx.workspace,
        release_id: releaseId,
      }),
    ]);
  const manifest = manifests[manifests.length - 1] ?? null;
  const gates: ReleaseDetail['gates'] = {};
  for (const row of gateRows) {
    gates[row.gate] = { result: row.result, checked_at: row.checked_at };
  }
  return {
    release,
    items,
    manifests,
    manifest,
    approvals: manifest
      ? approvalHistory.filter((a) => a.manifest_version === manifest.version)
      : [],
    approvalHistory,
    gates,
    notes,
  };
}
