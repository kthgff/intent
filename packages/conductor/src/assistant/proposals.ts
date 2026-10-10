/**
 * assistant/proposals.ts — the proposal lifecycle (TDD "Proposals
 * lifecycle", PRD R3). The assistant never writes board state
 * directly; every mutation is a `board_proposals` row a human decides.
 *
 *   draft → pending ──accept──→ committed via single-item legality
 *     │             ┌──reject──→ rejected           (OCC on base_updated_at)
 *     └──supersede──→ superseded                    └──409──→ stale
 *
 * Legality mirrors `packages/api/src/board.ts`'s single-item/batch
 * write path — same store primitives (`createTypedNote`,
 * `updateBoardItemExpected`, `updateBoardConnectorExpected`), same
 * fences (workspace+board scope, `consumed|frozen` immutability,
 * zone validity, connector endpoint checks). The api-side assert
 * helpers live in the api package and can't be imported here; the
 * rules are re-implemented so proposal commits and manual edits agree.
 */
import { randomUUID } from 'node:crypto';
import type {
  BoardItem,
  BoardProposalRow,
  NoteImportance,
  NoteKind,
  ProposalOp,
  StatementRow,
  Store,
} from '@veto/core';
import { BoardProposalRowSchema, ProposalOpSchema } from '@veto/core';
import {
  InterviewError,
  conflict,
  invalid,
  notFound,
} from '../interview/index.js';
import { createTypedNote } from '../semantics/board.js';
import { PLACE, type Rect, computePlacement } from './placement.js';
import { appendThreadMessage } from './thread.js';
import type { AssistantCtx } from './types.js';

// ---------------------------------------------------------------------------
// legality (mirrors api/board.ts — keep in sync)
// ---------------------------------------------------------------------------

function refuseImage(kind: string | null | undefined): void {
  if (kind === 'image') {
    throw invalid(
      'image items require the asset upload route, which is disabled in this release',
    );
  }
}

function refuseBadLinkRef(
  kind: string | null | undefined,
  ref: string | null | undefined,
): void {
  if (kind !== 'link') return;
  let url: URL | null = null;
  try {
    url = ref ? new URL(ref) : null;
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw invalid('link items require a ref URL with http: or https:');
  }
}

function refuseImmutable(item: BoardItem, extra: string[] = []): void {
  const locked = ['consumed', 'frozen', ...extra];
  if (locked.includes(item.status)) {
    throw conflict(
      `board item ${item.id} is ${item.status} — ${item.status} items are immutable`,
    );
  }
}

async function requireBoardItem(
  s: Store,
  workspace: string,
  board: string,
  id: string,
): Promise<BoardItem> {
  const item = await s.getBoardItem(id);
  if (!item || item.workspace !== workspace || item.board !== board) {
    throw notFound(`no board item ${id} on ${workspace}/${board}`);
  }
  return item;
}

/** OCC fence: the draft-time `base_updated_at` must still be current. */
function fence(
  item: { id: string; updated_at?: string | null | undefined },
  base: string | null,
): void {
  if (base != null && item.updated_at !== base) {
    throw conflict(
      `board item ${item.id} changed since the proposal was drafted`,
    );
  }
}

async function assertZone(
  s: Store,
  workspace: string,
  board: string,
  itemId: string,
  zone: string | null | undefined,
): Promise<void> {
  if (zone === undefined || zone === null) return;
  const z = await s.getBoardItem(zone);
  if (
    !z ||
    z.workspace !== workspace ||
    z.board !== board ||
    z.kind !== 'zone' ||
    z.status !== 'active'
  ) {
    throw invalid(`zone ${zone} is not an active zone item on this board`);
  }
  if (z.id === itemId) throw invalid('an item cannot be its own zone');
}

/**
 * Apply one proposal op through the single-item write path. Runs inside
 * the caller's transaction — a legality/OCC failure throws and rolls
 * the whole accept back.
 */
export async function applyProposalOp(
  s: Store,
  args: {
    workspace: string;
    board: string;
    op: ProposalOp;
    base_updated_at: string | null;
    /** The deciding human — `actor`/`created_by` on the writes. */
    actor: string;
    now: () => Date;
  },
): Promise<{ items: BoardItem[]; connector_id?: string }> {
  const { workspace, board, op } = args;
  const ts = args.now().toISOString();
  const actor = { id: args.actor, type: 'human' as const };

  switch (op.op) {
    case 'create-item': {
      refuseImage(op.kind ?? 'note');
      refuseBadLinkRef(op.kind ?? 'note', op.ref ?? null);
      // Zone validity is checked BEFORE any write — legality fails closed.
      if (op.zone) await assertZone(s, workspace, board, '', op.zone);
      const item = await createTypedNote(s, {
        workspace,
        board,
        ...(op.kind !== undefined
          ? { kind: op.kind as BoardItem['kind'] }
          : {}),
        ...(op.note_kind !== undefined
          ? { note_kind: op.note_kind as NoteKind }
          : {}),
        ...(op.title !== undefined ? { title: op.title } : {}),
        ...(op.body !== undefined ? { body: op.body } : {}),
        ...(op.ref !== undefined ? { ref: op.ref } : {}),
        ...(op.topic !== undefined ? { topic: op.topic } : {}),
        ...(op.importance !== undefined
          ? { importance: op.importance as NoteImportance }
          : {}),
        ...(op.applies_to !== undefined ? { applies_to: op.applies_to } : {}),
        ...(op.rationale !== undefined ? { rationale: op.rationale } : {}),
        ...(op.color !== undefined
          ? { color: op.color as BoardItem['color'] }
          : {}),
        ...(op.x !== undefined ? { x: op.x } : {}),
        ...(op.y !== undefined ? { y: op.y } : {}),
        ...(op.w !== undefined ? { w: op.w } : {}),
        ...(op.h !== undefined ? { h: op.h } : {}),
        ...(op.zone !== undefined ? { zone: op.zone } : {}),
        // Assistant-authored content is never silently verified.
        provenance: 'inferred',
        actor,
        now: args.now,
      });
      return { items: [item] };
    }
    case 'patch-item':
    case 'move-item':
    case 'serve': {
      const item = await requireBoardItem(s, workspace, board, op.id);
      refuseImmutable(item);
      fence(item, args.base_updated_at);
      const patch =
        op.op === 'patch-item'
          ? op.patch
          : op.op === 'move-item'
            ? {
                ...(op.x !== undefined ? { x: op.x } : {}),
                ...(op.y !== undefined ? { y: op.y } : {}),
                ...(op.zone !== undefined ? { zone: op.zone } : {}),
              }
            : {};
      const p = patch as Partial<BoardItem>;
      refuseImage(p.kind);
      refuseBadLinkRef(p.kind ?? item.kind, p.ref);
      if (p.zone !== undefined)
        await assertZone(s, workspace, board, item.id, p.zone);
      const serves =
        op.op === 'serve'
          ? await (async () => {
              const goal = await requireBoardItem(
                s,
                workspace,
                board,
                op.goal_item_id,
              );
              if (goal.id === item.id) {
                throw invalid('an item cannot serve itself');
              }
              const cur = item.serves ?? [];
              return cur.includes(goal.id) ? cur : [...cur, goal.id];
            })()
          : undefined;
      const next: BoardItem = {
        ...item,
        ...p,
        ...(serves !== undefined ? { serves } : {}),
        updated_at: ts,
      };
      const updated = await s.updateBoardItemExpected(
        next,
        args.base_updated_at ?? item.updated_at ?? '',
      );
      if (!updated)
        throw conflict(`board item ${item.id} changed concurrently`);
      return { items: [updated] };
    }
    case 'connect': {
      if (op.source_item_id === op.target_item_id) {
        throw invalid('connector cannot link an item to itself');
      }
      const [src, dst] = [
        await requireBoardItem(s, workspace, board, op.source_item_id),
        await requireBoardItem(s, workspace, board, op.target_item_id),
      ];
      refuseImmutable(src);
      refuseImmutable(dst);
      const conn = {
        id: `bc-${randomUUID().slice(0, 12)}`,
        workspace,
        board,
        source_item_id: src.id,
        target_item_id: dst.id,
        label: op.label ?? null,
        status: 'active',
        created_at: ts,
        updated_at: ts,
      };
      await s.upsertBoardConnector(conn);
      return { items: [src, dst], connector_id: conn.id };
    }
    case 'connector-remove': {
      const conn = await s.getBoardConnector(op.id);
      if (!conn || conn.workspace !== workspace || conn.board !== board) {
        throw notFound(`no connector ${op.id} on ${workspace}/${board}`);
      }
      if (conn.status !== 'active') {
        throw conflict(
          `connector ${op.id} is ${conn.status} — only active removes`,
        );
      }
      const next = await s.updateBoardConnectorExpected(
        { ...conn, status: 'superseded', updated_at: ts },
        args.base_updated_at ?? conn.updated_at ?? '',
      );
      if (!next) throw conflict(`connector ${op.id} changed concurrently`);
      return { items: [], connector_id: conn.id };
    }
    case 'delete-item': {
      const item = await requireBoardItem(s, workspace, board, op.id);
      refuseImmutable(item, ['shipped']);
      if (item.status === 'discarded') {
        throw conflict(`board item ${item.id} is already discarded`);
      }
      fence(item, args.base_updated_at);
      const next = await s.updateBoardItemExpected(
        { ...item, status: 'discarded', updated_at: ts },
        args.base_updated_at ?? item.updated_at ?? '',
      );
      if (!next) throw conflict(`board item ${item.id} changed concurrently`);
      return { items: [next] };
    }
  }
}

// ---------------------------------------------------------------------------
// same-batch temp_id aliases (D69)
// ---------------------------------------------------------------------------

/**
 * The item-id reference fields a `temp_id` alias can occupy. Zone
 * fields are included — a frame proposed in the same batch has no
 * durable id yet. `connector-remove.id` is a connector id, not an item
 * id, so it is deliberately absent.
 */
function opItemRefs(op: ProposalOp): string[] {
  switch (op.op) {
    case 'create-item':
      return op.zone ? [op.zone] : [];
    case 'patch-item':
    case 'delete-item':
      return [op.id];
    case 'move-item':
      return op.zone ? [op.id, op.zone] : [op.id];
    case 'serve':
      return [op.id, op.goal_item_id];
    case 'connect':
      return [op.source_item_id, op.target_item_id];
    case 'connector-remove':
      return [];
  }
}

/**
 * Rewrite an op's item-id references through `resolve`; unmapped values
 * pass through untouched. Returns the SAME object when nothing changed
 * so callers can detect rewrites by identity.
 */
function rewriteRefs(
  op: ProposalOp,
  resolve: (v: string) => string | undefined,
): ProposalOp {
  const r = <T extends string | null | undefined>(v: T): T =>
    (v == null ? v : (resolve(v) ?? v)) as T;
  switch (op.op) {
    case 'create-item': {
      const zone = r(op.zone);
      return zone === op.zone ? op : { ...op, zone };
    }
    case 'patch-item':
    case 'delete-item': {
      const id = r(op.id);
      return id === op.id ? op : { ...op, id };
    }
    case 'move-item': {
      const id = r(op.id);
      const zone = r(op.zone);
      return id === op.id && zone === op.zone ? op : { ...op, id, zone };
    }
    case 'serve': {
      const id = r(op.id);
      const goal_item_id = r(op.goal_item_id);
      return id === op.id && goal_item_id === op.goal_item_id
        ? op
        : { ...op, id, goal_item_id };
    }
    case 'connect': {
      const source_item_id = r(op.source_item_id);
      const target_item_id = r(op.target_item_id);
      return source_item_id === op.source_item_id &&
        target_item_id === op.target_item_id
        ? op
        : { ...op, source_item_id, target_item_id };
    }
    case 'connector-remove':
      return op;
  }
}

/** The temp_id a create-item op declares, when it declares one. */
function declaredTemp(op: ProposalOp): string | null {
  return op.op === 'create-item' ? (op.temp_id ?? null) : null;
}

/**
 * Two proposal rows share a temp-alias scope when a ref in one could
 * mean the other's `temp_id`: same `batch_id` when set, else the same
 * draft turn (`session_id` + `seq`). Aliases are meaningless across
 * turns — a same-named alias in a later turn is a coincidence.
 */
function sameTempScope(a: BoardProposalRow, b: BoardProposalRow): boolean {
  if (a.batch_id !== null || b.batch_id !== null) {
    return a.batch_id !== null && a.batch_id === b.batch_id;
  }
  return a.session_id === b.session_id && a.seq === b.seq;
}

/** Human label for a pending create's payload ("zone 'Plans'"). */
function tempLabel(row: BoardProposalRow): string {
  const p = row.payload;
  const what = p.op === 'create-item' && p.kind === 'zone' ? 'frame' : 'item';
  const name = p.op === 'create-item' ? (p.title ?? p.body ?? '') : '';
  return `${what} ${name ? `"${name.slice(0, 60)}" ` : ''}(proposal ${row.proposal_id})`;
}

/**
 * Repoint pending sibling proposals that still reference `tempId` to
 * the now-durable `itemId` — runs inside the accept transaction so a
 * frame accepted alone leaves its children acceptable afterwards.
 */
async function repointTempRefs(
  s: Store,
  args: {
    workspace: string;
    board: string;
    /** The just-accepted create's proposal row — defines the scope. */
    from: BoardProposalRow;
    tempId: string;
    itemId: string;
    ts: string;
  },
): Promise<void> {
  const pending = await s.listBoardProposals({
    workspace: args.workspace,
    board: args.board,
    status: 'pending',
  });
  for (const p of pending) {
    if (!sameTempScope(p, args.from)) continue;
    const next = rewriteRefs(p.payload, (v) =>
      v === args.tempId ? args.itemId : undefined,
    );
    if (next === p.payload) continue;
    await s.upsertBoardProposal({ ...p, payload: next, updated_at: args.ts });
  }
}

// ---------------------------------------------------------------------------
// drafting
// ---------------------------------------------------------------------------

/** The board-item id an op targets, when it targets one. */
export function proposalTargetId(op: ProposalOp): string | null {
  switch (op.op) {
    case 'patch-item':
    case 'move-item':
    case 'serve':
    case 'connector-remove':
    case 'delete-item':
      return op.id;
    case 'connect':
      return op.source_item_id;
    case 'create-item':
      return null;
  }
}

export interface DraftResult {
  proposals: BoardProposalRow[];
  /** Ops that failed validation — dropped, never guessed. */
  dropped: { op: unknown; reason: string }[];
}

/**
 * Draft ops into durable pending proposals: per-op schema check
 * (fail-closed — malformed ops drop with a reason), placement compute
 * for unpositioned creates, supersede of same-target pending rows,
 * `base_updated_at` fence capture. No board writes happen here.
 */
export async function draftProposals(
  ctx: AssistantCtx,
  args: {
    board: string;
    sessionId: string;
    ops: unknown[];
    /** Transcript seq that produced this batch. */
    seq?: number | null;
    /** Checkpoint grouping for batch accept. */
    batchId?: string | null;
    anchors?: string[];
    provenance?: BoardProposalRow['provenance'];
    actor?: string;
  },
): Promise<DraftResult> {
  const items = await ctx.store.listBoardItems({
    workspace: ctx.workspace,
    board: args.board,
  });
  const ts = ctx.now().toISOString();
  const out: BoardProposalRow[] = [];
  const dropped: DraftResult['dropped'] = [];

  // Pass 1: schema check + collect this turn's temp_id aliases. A ref
  // is legal when it names an existing board row OR an alias declared
  // anywhere in the same ops array (forward refs resolve at accept).
  const parsedOps: ProposalOp[] = [];
  for (const raw of args.ops) {
    const parsed = ProposalOpSchema.safeParse(raw);
    if (!parsed.success) {
      dropped.push({
        op: raw,
        reason: parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; '),
      });
      continue;
    }
    parsedOps.push(parsed.data);
  }
  const temps = new Set(
    parsedOps.map(declaredTemp).filter((t): t is string => t !== null),
  );
  const itemIds = new Set(items.map((i) => i.id));
  const zoneIds = new Set(
    items
      .filter((i) => i.kind === 'zone' && i.status === 'active')
      .map((i) => i.id),
  );

  // Pass 2: placement for unpositioned creates. temp_id zone refs
  // resolve to the proposing create's rect, so notes draft inside a
  // same-batch frame; creates are retried until their temp zone has a
  // rect (forward refs) or fall back to the anchor/below rules. Zone
  // rects never enter `placed` — containers are not obstacles.
  const placed: Rect[] = [];
  const zoneRects = new Map<string, Rect>();
  const placedOps = parsedOps.map((op) => ({
    op,
    done: op.op !== 'create-item',
  }));
  const place = (entry: { op: ProposalOp; done: boolean }) => {
    const op = entry.op;
    if (op.op !== 'create-item') return true;
    if (op.x !== undefined && op.y !== undefined) {
      entry.done = true;
      const t = declaredTemp(op);
      if (op.kind === 'zone' && t) {
        zoneRects.set(t, {
          x: op.x,
          y: op.y,
          w: op.w ?? PLACE.w,
          h: op.h ?? PLACE.h,
        });
      }
      return true;
    }
    if (op.zone && temps.has(op.zone) && !zoneRects.has(op.zone)) {
      return false; // temp zone not placed yet — retry next sweep
    }
    const at = computePlacement({
      items: [
        ...items,
        ...[...zoneRects.entries()].map(([id, r]) => ({
          id,
          ...r,
          zone: null,
          kind: 'zone' as const,
          status: 'active',
        })),
      ],
      placed,
      zone: op.zone ?? null,
      ...(args.anchors ? { anchors: args.anchors } : {}),
      w: op.w ?? PLACE.w,
      h: op.h ?? PLACE.h,
    });
    entry.op = { ...op, x: at.x, y: at.y };
    entry.done = true;
    const rect = { x: at.x, y: at.y, w: op.w ?? PLACE.w, h: op.h ?? PLACE.h };
    if (op.kind === 'zone') {
      const t = declaredTemp(entry.op);
      if (t) zoneRects.set(t, rect);
    } else {
      placed.push(rect);
    }
    return true;
  };
  for (let sweep = 0; sweep <= parsedOps.length; sweep++) {
    let progress = false;
    for (const entry of placedOps) {
      if (!entry.done && place(entry)) progress = true;
    }
    if (!progress) break;
  }
  // Unplaceable leftovers (a temp zone that never materialized) get the
  // plain fallback — a missing rect never blocks the draft.
  for (const entry of placedOps) {
    if (entry.done || entry.op.op !== 'create-item') continue;
    const op = entry.op;
    const at = computePlacement({
      items,
      placed,
      ...(args.anchors ? { anchors: args.anchors } : {}),
      w: op.w ?? PLACE.w,
      h: op.h ?? PLACE.h,
    });
    entry.op = { ...op, x: at.x, y: at.y };
    placed.push({ x: at.x, y: at.y, w: op.w ?? PLACE.w, h: op.h ?? PLACE.h });
  }

  for (const { op } of placedOps) {
    // Pass 3: fail-closed ref check — a zone ref must name an active
    // zone or a declared alias; every other item ref must name a board
    // item or a declared alias. Unresolvable refs drop with a reason
    // instead of drafting a ghost that can never accept.
    const refs = opItemRefs(op);
    const bad = refs.find((v) =>
      (op.op === 'create-item' || op.op === 'move-item') &&
      v === (op as { zone?: string }).zone
        ? !zoneIds.has(v) && !temps.has(v)
        : !itemIds.has(v) && !temps.has(v),
    );
    if (bad !== undefined) {
      dropped.push({
        op,
        reason: `references unknown item "${bad}" — no such board item or same-batch temp_id`,
      });
      continue;
    }
    const targetId = proposalTargetId(op);
    const target =
      targetId === null
        ? null
        : op.op === 'connector-remove'
          ? await ctx.store.getBoardConnector(targetId)
          : await ctx.store.getBoardItem(targetId);
    if (targetId) {
      // Same-item pending duplicates collapse — the queue never grows
      // stale re-drafts of the same change.
      await ctx.store.supersedePendingProposals({
        workspace: ctx.workspace,
        board: args.board,
        itemId: targetId,
        op: op.op,
      });
    }
    const row: BoardProposalRow = {
      workspace: ctx.workspace,
      org: null,
      proposal_id: `bp-${randomUUID().slice(0, 12)}`,
      board: args.board,
      session_id: args.sessionId,
      batch_id: args.batchId ?? null,
      seq: args.seq ?? null,
      op: op.op,
      payload: op,
      base_updated_at: target?.updated_at ?? null,
      anchor: args.anchors ?? null,
      provenance: args.provenance ?? null,
      status: 'pending',
      created_by: args.actor ?? 'assistant',
      decided_by: null,
      decided_at: null,
      created_at: ts,
      updated_at: ts,
    };
    await ctx.store.upsertBoardProposal(row);
    out.push(row);
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: null,
      ts,
      stage: 'board-assistant',
      actor_type: 'agent',
      actor_id: 'assistant',
      event: 'proposal_created',
      run: null,
      refs: [`board:${args.board}`, `proposal:${row.proposal_id}`],
      data: { op: op.op, batch_id: row.batch_id, session_id: args.sessionId },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
  }
  return { proposals: out, dropped };
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

/**
 * Commit one pending proposal through the single-item write path.
 * `pending` rows only; an OCC/legality failure marks the row `stale`
 * and rethrows `conflict` (409) — the caller may re-draft fresh.
 */
export async function acceptProposal(
  ctx: AssistantCtx,
  args: { proposalId: string; decidedBy: string },
): Promise<{ proposal: BoardProposalRow; items: BoardItem[] }> {
  const row = await ctx.store.getBoardProposal({
    workspace: ctx.workspace,
    proposal_id: args.proposalId,
  });
  if (!row) throw notFound(`no proposal ${args.proposalId}`);
  if (row.status !== 'pending') {
    throw conflict(`proposal ${args.proposalId} is ${row.status}`);
  }
  // Same-batch alias check: a ref that names a still-pending sibling's
  // temp_id fails with a clear retryable error (stays `pending`), never
  // the generic zone/not-found failure that strands the ghost (D69).
  const refs = opItemRefs(row.payload);
  if (refs.length > 0) {
    const pending = await ctx.store.listBoardProposals({
      workspace: ctx.workspace,
      board: row.board,
      status: 'pending',
    });
    const siblingTemps = new Map(
      pending
        .filter(
          (p) =>
            p.proposal_id !== row.proposal_id &&
            sameTempScope(p, row) &&
            declaredTemp(p.payload) !== null,
        )
        .map((p) => [declaredTemp(p.payload) as string, p]),
    );
    for (const v of refs) {
      const dep = siblingTemps.get(v);
      if (dep && !(await ctx.store.getBoardItem(v))) {
        throw invalid(
          `this proposal references ${tempLabel(dep)} — accept that proposal first, or accept the whole batch together`,
        );
      }
    }
  }
  const decidedAt = ctx.now().toISOString();
  try {
    const { items } = await ctx.store.transaction((tx) =>
      applyProposalOp(tx, {
        workspace: ctx.workspace,
        board: row.board,
        op: row.payload,
        base_updated_at: row.base_updated_at ?? null,
        actor: args.decidedBy,
        now: ctx.now,
      }).then(async (r) => {
        // Provenance chain: item → statement(s) → transcript turn.
        if (row.payload.op === 'create-item' && row.provenance?.statement_ids) {
          for (const sid of row.provenance.statement_ids) {
            await tx.upsertStatementArtifactLink({
              workspace: ctx.workspace,
              org: null,
              statement_id: sid,
              artifact: `board-item:${r.items[0]?.id}`,
              element: '',
              created_by: args.decidedBy,
              created_at: decidedAt,
            });
          }
        }
        await tx.upsertBoardProposal({
          ...row,
          status: 'accepted',
          decided_by: args.decidedBy,
          decided_at: decidedAt,
          updated_at: decidedAt,
        });
        // The accepted create may have been the frame sibling refs
        // point at — repoint them to the durable id so individually
        // accepted children land too.
        const temp = declaredTemp(row.payload);
        if (temp && r.items[0]) {
          await repointTempRefs(tx, {
            workspace: ctx.workspace,
            board: row.board,
            from: row,
            tempId: temp,
            itemId: r.items[0].id,
            ts: decidedAt,
          });
        }
        return r;
      }),
    );
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: null,
      ts: decidedAt,
      stage: 'board-assistant',
      actor_type: 'human',
      actor_id: args.decidedBy,
      event: 'proposal_resolved',
      run: null,
      refs: [`board:${row.board}`, `proposal:${row.proposal_id}`],
      data: { op: row.op, decision: 'accepted' },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    return {
      proposal: {
        ...row,
        status: 'accepted',
        decided_by: args.decidedBy,
        decided_at: decidedAt,
        updated_at: decidedAt,
      },
      items,
    };
  } catch (e) {
    // Stale covers both fences: the row changed since draft (409) and
    // the target no longer exists (404) — either way the proposal
    // cannot land on the current board.
    if (
      e instanceof InterviewError &&
      (e.code === 'conflict' || e.code === 'not-found')
    ) {
      await ctx.store.upsertBoardProposal({
        ...row,
        status: 'stale',
        decided_by: args.decidedBy,
        decided_at: decidedAt,
        updated_at: decidedAt,
      });
    }
    throw e;
  }
}

/** Reject a pending proposal — the ghost vanishes, the record stays. */
export async function rejectProposal(
  ctx: AssistantCtx,
  args: { proposalId: string; decidedBy: string; reason?: string },
): Promise<BoardProposalRow> {
  const row = await ctx.store.getBoardProposal({
    workspace: ctx.workspace,
    proposal_id: args.proposalId,
  });
  if (!row) throw notFound(`no proposal ${args.proposalId}`);
  if (row.status !== 'pending') {
    throw conflict(`proposal ${args.proposalId} is ${row.status}`);
  }
  const ts = ctx.now().toISOString();
  const next: BoardProposalRow = {
    ...row,
    status: 'rejected',
    decided_by: args.decidedBy,
    decided_at: ts,
    updated_at: ts,
  };
  await ctx.store.upsertBoardProposal(next);
  await ctx.store.appendEvent({
    workspace: ctx.workspace,
    ticket_id: null,
    ts,
    stage: 'board-assistant',
    actor_type: 'human',
    actor_id: args.decidedBy,
    event: 'proposal_resolved',
    run: null,
    refs: [`board:${row.board}`, `proposal:${row.proposal_id}`],
    data: { op: row.op, decision: 'rejected', reason: args.reason ?? null },
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
  if (args.reason) {
    await appendThreadMessage(ctx, {
      sessionId: row.session_id,
      role: 'system',
      content: `[proposal rejected] ${row.proposal_id} (${row.op}) — ${args.reason}`,
    });
  }
  return next;
}

/**
 * Atomic batch accept — one `store.transaction`, all-or-nothing (TDD).
 * `ids` or `batch_id` selects the pending set; every row must be
 * pending on this board or the batch refuses before any write.
 */
export async function acceptProposals(
  ctx: AssistantCtx,
  args: {
    board: string;
    ids?: string[];
    batchId?: string;
    decidedBy: string;
  },
): Promise<{ proposals: BoardProposalRow[]; items: BoardItem[] }> {
  let rows: BoardProposalRow[];
  if (args.ids && args.ids.length > 0) {
    rows = (
      await Promise.all(
        args.ids.map((id) =>
          ctx.store.getBoardProposal({
            workspace: ctx.workspace,
            proposal_id: id,
          }),
        ),
      )
    ).filter((r): r is BoardProposalRow => r !== null);
    const missing = args.ids.filter(
      (id) => !rows.some((r) => r.proposal_id === id),
    );
    if (missing.length > 0) {
      throw notFound(`no proposals ${missing.join(', ')}`);
    }
  } else if (args.batchId) {
    rows = (
      await ctx.store.listBoardProposals({
        workspace: ctx.workspace,
        board: args.board,
        status: 'pending',
      })
    ).filter((r) => r.batch_id === args.batchId);
  } else {
    throw invalid('acceptProposals: pass ids or batchId');
  }
  for (const r of rows) {
    if (r.board !== args.board) {
      throw conflict(`proposal ${r.proposal_id} belongs to ${r.board}`);
    }
    if (r.status !== 'pending') {
      throw conflict(
        `proposal ${r.proposal_id} is ${r.status} — batch refuses`,
      );
    }
  }
  if (rows.length === 0) return { proposals: [], items: [] };

  const decidedAt = ctx.now().toISOString();
  try {
    const items = await ctx.store.transaction(async (tx) => {
      // temp_id aliases declared by creates inside (and outside) this
      // accept set. Rows apply in stored order, but an op referencing
      // an in-batch alias pulls its create forward first (DFS); a
      // pending alias outside the set fails with a clear retryable
      // error before any legality check (D69).
      const aliasRow = new Map<string, BoardProposalRow>();
      for (const r of rows) {
        const t = declaredTemp(r.payload);
        if (t) aliasRow.set(t, r);
      }
      const pendingTemps = new Map<string, BoardProposalRow>();
      for (const p of await tx.listBoardProposals({
        workspace: ctx.workspace,
        board: args.board,
        status: 'pending',
      })) {
        const t = declaredTemp(p.payload);
        if (t && !aliasRow.has(t)) pendingTemps.set(t, p);
      }
      const resolved = new Map<string, string>();
      const applied = new Set<string>();
      const visiting = new Set<string>();

      const all: BoardItem[] = [];
      const applyRow = async (row: BoardProposalRow): Promise<void> => {
        if (applied.has(row.proposal_id)) return;
        visiting.add(row.proposal_id);
        for (const v of opItemRefs(row.payload)) {
          const dep = aliasRow.get(v);
          if (dep && !applied.has(dep.proposal_id)) {
            if (visiting.has(dep.proposal_id)) {
              throw invalid(`temp_id "${v}" resolves in a cycle`);
            }
            await applyRow(dep);
            continue;
          }
          const pending = pendingTemps.get(v);
          if (pending && !resolved.has(v)) {
            throw invalid(
              `proposal ${row.proposal_id} references ${tempLabel(pending)} — include it in this accept or accept it first`,
            );
          }
        }
        visiting.delete(row.proposal_id);
        const r = await applyProposalOp(tx, {
          workspace: ctx.workspace,
          board: row.board,
          op: rewriteRefs(row.payload, (v) => resolved.get(v)),
          base_updated_at: row.base_updated_at ?? null,
          actor: args.decidedBy,
          now: ctx.now,
        });
        if (row.payload.op === 'create-item' && row.provenance?.statement_ids) {
          for (const sid of row.provenance.statement_ids) {
            await tx.upsertStatementArtifactLink({
              workspace: ctx.workspace,
              org: null,
              statement_id: sid,
              artifact: `board-item:${r.items[0]?.id}`,
              element: '',
              created_by: args.decidedBy,
              created_at: decidedAt,
            });
          }
        }
        await tx.upsertBoardProposal({
          ...row,
          status: 'accepted',
          decided_by: args.decidedBy,
          decided_at: decidedAt,
          updated_at: decidedAt,
        });
        const temp = declaredTemp(row.payload);
        if (temp && r.items[0]) {
          resolved.set(temp, r.items[0].id);
          // Sibling pending rows outside this accept set repoint to the
          // durable id, so individually accepted children still land.
          await repointTempRefs(tx, {
            workspace: ctx.workspace,
            board: args.board,
            from: row,
            tempId: temp,
            itemId: r.items[0].id,
            ts: decidedAt,
          });
        }
        applied.add(row.proposal_id);
        all.push(...r.items);
      };
      for (const row of rows) await applyRow(row);
      return all;
    });
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: null,
      ts: decidedAt,
      stage: 'board-assistant',
      actor_type: 'human',
      actor_id: args.decidedBy,
      event: 'proposal_resolved',
      run: null,
      refs: [
        `board:${args.board}`,
        ...rows.map((r) => `proposal:${r.proposal_id}`),
      ],
      data: {
        decision: 'accepted',
        batch_id: args.batchId ?? null,
        count: rows.length,
      },
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
    });
    return {
      proposals: rows.map((r) => ({
        ...r,
        status: 'accepted' as const,
        decided_by: args.decidedBy,
        decided_at: decidedAt,
        updated_at: decidedAt,
      })),
      items,
    };
  } catch (e) {
    if (
      e instanceof InterviewError &&
      (e.code === 'conflict' || e.code === 'not-found')
    ) {
      const ts = ctx.now().toISOString();
      for (const row of rows) {
        await ctx.store.upsertBoardProposal({
          ...row,
          status: 'stale',
          decided_by: args.decidedBy,
          decided_at: ts,
          updated_at: ts,
        });
      }
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// contradiction outcome → supersede (TDD turn pipeline step 5)
// ---------------------------------------------------------------------------

/**
 * A statement decision ruled against (`rejected`/`superseded` apply)
 * retires the losing side: pending proposals it authored are
 * superseded, and its committed board item earns a `delete-item`
 * proposal — the human still decides the board write.
 */
export async function supersedeForDecision(
  ctx: AssistantCtx,
  args: {
    board: string;
    sessionId: string;
    /** The decided statement's id (decision.statement_id). */
    statement: StatementRow | { statement_id: string };
    actor?: string;
  },
): Promise<{ superseded: number; proposals: BoardProposalRow[] }> {
  const sid = args.statement.statement_id;
  const links = await ctx.store.listStatementArtifactLinks({
    workspace: ctx.workspace,
    statement_id: sid,
  });
  const itemIds = links
    .map((l) => /^board-item:(.+)$/.exec(l.artifact)?.[1])
    .filter((x): x is string => !!x);
  let superseded = 0;
  const pending = await ctx.store.listBoardProposals({
    workspace: ctx.workspace,
    board: args.board,
    status: 'pending',
  });
  for (const p of pending) {
    const target = proposalTargetId(p.payload);
    const authoredByStatement = p.provenance?.statement_ids?.includes(sid);
    if (authoredByStatement || (target !== null && itemIds.includes(target))) {
      const ts = ctx.now().toISOString();
      await ctx.store.upsertBoardProposal({
        ...p,
        status: 'superseded',
        updated_at: ts,
      });
      superseded++;
    }
  }
  const drafts = await draftProposals(ctx, {
    board: args.board,
    sessionId: args.sessionId,
    ops: itemIds.map((id) => ({ op: 'delete-item', id })),
    provenance: { statement_ids: [sid], branch: null },
    actor: args.actor ?? 'assistant',
  });
  return { superseded, proposals: drafts.proposals };
}

/** Parse a stored row back to its schema — fail-closed read guard. */
export function parseProposalRow(raw: unknown): BoardProposalRow {
  return BoardProposalRowSchema.parse(raw);
}
