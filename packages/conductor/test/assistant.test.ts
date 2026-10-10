/**
 * wp-162 tests — Board Assistant engine (BOARD-CHAT-PRD/TDD).
 *
 * Real PostgresStore on PGlite + wp-163 board wizards seeded. Covers:
 *   - shared thread get-or-create + per-turn `created_by` attribution;
 *   - the turn pipeline ordering (pending question → submitAnswer;
 *     `/skill`; freeform → converse) + statements → proposal drafts;
 *   - proposal legality through the single-item write path (OCC on
 *     `base_updated_at`, consumed/frozen/shipped refuse) + stale-on-409;
 *   - atomic batch accept (partial failure lands nothing);
 *   - computePlacement goldens (zone / anchor / fallback / no-overlap);
 *   - deterministic critique + suggestion chips;
 *   - converse fail-closed (no provider, malformed output);
 *   - contradiction → in-thread decision + supersede proposal;
 *   - intent→note_kind map + goals-slot `serve` wiring.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardItem } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MALFORMED_REPLY,
  NO_PROVIDER_REPLY,
  acceptProposal,
  acceptProposals,
  boardCoverage,
  computePlacement,
  converse,
  critiqueChecks,
  draftProposals,
  endRun,
  ensureThread,
  panelState,
  postMessage,
  rejectProposal,
  startRun,
  suggestChips,
  supersedeForDecision,
} from '../src/assistant/index.js';
import type { PlacementArgs } from '../src/assistant/index.js';
import type { AssistantCtx } from '../src/assistant/index.js';
import { seedBoardWizards } from '../src/interview/index.js';
import { InterviewError } from '../src/interview/index.js';

/** First row or fail — avoids the non-null assertion lint. */
function need<T>(rows: T[], what = 'row'): T {
  const r = rows[0];
  if (r === undefined) throw new Error(`expected ${what}`);
  return r;
}
import { createBoard, createTypedNote } from '../src/semantics/board.js';

const WS = 'ws';
const BOARD = 'b1';
const T0 = Date.parse('2026-10-06T00:00:00Z');

let dir: string;
let store: PostgresStore;
let clock: number;

function ctx(over: Partial<AssistantCtx> = {}): AssistantCtx {
  return {
    store,
    workspace: WS,
    actor: 'keith',
    now: () => new Date(clock),
    ...over,
  };
}
const tick = (ms = 60_000) => {
  clock += ms;
};

function makeExtractor(build: (answer: string) => Record<string, unknown>[]) {
  return async (prompt: string): Promise<string> => {
    const m = /```\n([\s\S]*?)\n```/.exec(prompt);
    const answer = m?.[1] ?? '';
    return JSON.stringify({ schema: 1, statements: build(answer) });
  };
}

async function note(
  over: Partial<Parameters<typeof createTypedNote>[1]> = {},
): Promise<BoardItem> {
  return createTypedNote(store, {
    workspace: WS,
    board: BOARD,
    title: 'note',
    ...over,
    actor: { id: 'keith', type: 'human' },
    now: () => new Date(clock),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-assistant-'));
  store = await PostgresStore.connect('pglite:');
  clock = T0;
  const c = ctx();
  await seedBoardWizards(c);
  await createBoard(store, {
    workspace: WS,
    board: BOARD,
    board_type: 'exploration',
    actor: { id: 'keith', type: 'human' },
    now: () => new Date(clock),
  });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// thread + attribution
// ---------------------------------------------------------------------------

describe('thread', () => {
  it('get-or-create is idempotent — one session per board', async () => {
    const c = ctx();
    const a = await ensureThread(c, BOARD);
    const b = await ensureThread(c, BOARD);
    expect(a.session_id).toBe(b.session_id);
    expect(a.session_id).toContain('board-exploration');
    expect(a.mode).toBe('conversation');
    expect(await store.listInterviewSessions({ workspace: WS })).toHaveLength(
      1,
    );
  });

  it('user + assistant turns carry created_by attribution', async () => {
    const c = ctx();
    await postMessage(c, { board: BOARD, text: '/interview', actor: 'amy' });
    tick();
    await postMessage(c, {
      board: BOARD,
      text: 'we need offline sync',
      actor: 'amy',
    });
    const session = await ensureThread(c, BOARD);
    const msgs = await store.listInterviewMessages({
      workspace: WS,
      session_id: session.session_id,
    });
    const user = msgs.find((m) => m.role === 'user');
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(user?.created_by).toBe('amy');
    expect(assistant?.created_by).toBe('assistant');
  });
});

// ---------------------------------------------------------------------------
// runs + answer turn
// ---------------------------------------------------------------------------

describe('runs + turns', () => {
  it('/interview opens run-1, asks goals first; a second run conflicts', async () => {
    const c = ctx();
    const run = await startRun(c, { board: BOARD, skill: 'interview' });
    expect(run.branch?.branch).toBe('run-1');
    expect(run.branch?.role).toBe('interview');
    expect(run.asked?.candidate.slot).toBe('goals');
    await expect(
      startRun(c, { board: BOARD, skill: 'interview' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('answer routes through submitAnswer and drafts create-item proposals', async () => {
    const c = ctx();
    await postMessage(c, { board: BOARD, text: '/interview' });
    tick();
    const res = await postMessage(c, {
      board: BOARD,
      text: 'offline sync for field tablets',
    });
    // verbatim fallback → one observation statement → idea note proposal
    expect(res.proposals.length).toBe(1);
    expect(res.proposals[0]?.op).toBe('create-item');
    expect(res.proposals[0]?.status).toBe('pending');
    const pending = await store.listBoardProposals({
      workspace: WS,
      board: BOARD,
      status: 'pending',
    });
    expect(pending).toHaveLength(1);
    expect((pending[0]?.payload as { note_kind?: string }).note_kind).toBe(
      'idea',
    );
    expect(res.pending).not.toBeNull(); // next question asked
  });

  it('/expand without a selection explains instead of running', async () => {
    const c = ctx();
    const res = await postMessage(c, { board: BOARD, text: '/expand' });
    expect(res.messages.at(-1)?.content).toContain('needs a selection');
  });

  it('endRun merges the branch and posts the readiness summary', async () => {
    const c = ctx();
    await postMessage(c, { board: BOARD, text: '/interview' });
    const res = await postMessage(c, {
      board: BOARD,
      text: 'offline sync for field tablets',
    });
    expect(res.pending).not.toBeNull();
    const ended = await endRun(ctx(), { board: BOARD, branch: 'run-1' });
    expect(ended.merged.branch).toBe('run-1');
    expect(ended.message.role).toBe('assistant');
    expect(ended.message.content).toContain('Coverage:');
  });

  it('/interview end closes the active run — the pending question is not answered', async () => {
    const c = ctx();
    await postMessage(c, { board: BOARD, text: '/interview' });
    const res = await postMessage(c, { board: BOARD, text: '/interview end' });
    expect(res.messages.at(-1)?.content).toContain('run-1 merged');
    expect(res.messages.at(-1)?.content).toContain('Coverage:');
    expect(res.pending).toBeNull();
    const session = await ensureThread(c, BOARD);
    const branches = await store.listInterviewBranches({
      workspace: WS,
      session_id: session.session_id,
    });
    expect(branches.find((b) => b.branch === 'run-1')?.status).toBe('merged');
  });

  it('natural equivalents ("end the interview") close the run ahead of answering', async () => {
    const c = ctx();
    await postMessage(c, { board: BOARD, text: '/interview' });
    const res = await postMessage(c, {
      board: BOARD,
      text: 'end the interview',
    });
    expect(res.messages.at(-1)?.content).toContain('run-1 merged');
    // The user turn is recorded with attribution before the summary.
    const user = res.messages.find((m) => m.role === 'user');
    expect(user?.content).toBe('end the interview');
    expect(user?.created_by).toBe('keith');
  });

  it('/interview end with no active run explains instead of erroring', async () => {
    const c = ctx();
    const res = await postMessage(c, { board: BOARD, text: '/interview end' });
    expect(res.messages.at(-1)?.content).toContain('No interview is running');
    // …and a bare "done" outside a run falls through to command mode.
    const res2 = await postMessage(c, { board: BOARD, text: 'done' });
    expect(res2.messages.at(-1)?.content).toBe(NO_PROVIDER_REPLY);
  });

  it('/expand zone-only scope explains; mixed scope keeps content ids only', async () => {
    const c = ctx();
    const zone = await note({ kind: 'zone', title: 'cluster' });
    const onlyZone = await postMessage(c, {
      board: BOARD,
      text: `/expand ${zone.id}`,
    });
    expect(onlyZone.messages.at(-1)?.content).toContain(
      'needs expandable cards',
    );
    // No branch opened for the rejected scope.
    const session = await ensureThread(c, BOARD);
    expect(
      await store.listInterviewBranches({
        workspace: WS,
        session_id: session.session_id,
      }),
    ).toHaveLength(0);
    // Mixed scope → the zone drops out, the note stays in the marker.
    const n = await note({ title: 'expandable card' });
    const run = await startRun(c, {
      board: BOARD,
      skill: 'expand',
      scope: `${zone.id},${n.id}`,
    });
    expect(run.branch?.branch).toBe('run-1');
    const msgs = await store.listInterviewMessages({
      workspace: WS,
      session_id: session.session_id,
    });
    const marker = msgs.find((m) => m.content.startsWith('[run scope]'));
    expect(marker?.content).toBe(`[run scope] expand scoped to ${n.id}`);
  });
});

// ---------------------------------------------------------------------------
// proposals: accept/reject/stale/supersede/batch
// ---------------------------------------------------------------------------

describe('proposals', () => {
  it('accept commits create-item through the write path + provenance link', async () => {
    const c = ctx();
    const { proposals } = await draftProposals(c, {
      board: BOARD,
      sessionId: (await ensureThread(c, BOARD)).session_id,
      ops: [
        {
          op: 'create-item',
          kind: 'note',
          note_kind: 'want',
          title: 'fast search',
          body: 'users want fast search',
          x: 10,
          y: 10,
        },
      ],
      provenance: { statement_ids: ['st-x'], branch: null },
    });
    const res = await acceptProposal(c, {
      proposalId: need(proposals).proposal_id,
      decidedBy: 'amy',
    });
    expect(res.proposal.status).toBe('accepted');
    expect(res.proposal.decided_by).toBe('amy');
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.provenance).toBe('inferred');
    const links = await store.listStatementArtifactLinks({
      workspace: WS,
      statement_id: 'st-x',
    });
    expect(links[0]?.artifact).toBe(`board-item:${res.items[0]?.id}`);
  });

  it('stale base → conflict + the row marks stale', async () => {
    const c = ctx();
    const item = await note({ title: 't' });
    const { proposals } = await draftProposals(c, {
      board: BOARD,
      sessionId: (await ensureThread(c, BOARD)).session_id,
      ops: [{ op: 'patch-item', id: item.id, patch: { title: 't2' } }],
    });
    // Human lands a competing edit — the fence breaks.
    const itemBase = item.updated_at;
    if (!itemBase) throw new Error('item.updated_at missing');
    await store.updateBoardItemExpected(
      { ...item, title: 'human edit', updated_at: '2099-01-01T00:00:00Z' },
      itemBase,
    );
    await expect(
      acceptProposal(c, {
        proposalId: need(proposals).proposal_id,
        decidedBy: 'amy',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const row = await store.getBoardProposal({
      workspace: WS,
      proposal_id: need(proposals).proposal_id,
    });
    expect(row?.status).toBe('stale');
  });

  it('batch accept is atomic — a stale member lands nothing', async () => {
    const c = ctx();
    const session = await ensureThread(c, BOARD);
    const victim = await note({ title: 'v' });
    const { proposals } = await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      batchId: 'batch-1',
      ops: [
        { op: 'create-item', kind: 'note', title: 'a', x: 0, y: 0 },
        { op: 'patch-item', id: victim.id, patch: { title: 'v2' } },
      ],
    });
    const victimBase = victim.updated_at;
    if (!victimBase) throw new Error('victim.updated_at missing');
    await store.updateBoardItemExpected(
      { ...victim, title: 'changed', updated_at: '2099-01-01T00:00:00Z' },
      victimBase,
    );
    await expect(
      acceptProposals(c, { board: BOARD, batchId: 'batch-1', decidedBy: 'a' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // nothing landed — no 'a' item, no accepted rows
    expect(
      (await store.listBoardItems({ workspace: WS, board: BOARD })).filter(
        (i) => i.title === 'a',
      ),
    ).toHaveLength(0);
    void proposals;
  });

  it('supersede: a re-draft of the same item+op retires the older pending', async () => {
    const c = ctx();
    const session = await ensureThread(c, BOARD);
    const item = await note({ title: 'x' });
    await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      ops: [{ op: 'patch-item', id: item.id, patch: { title: 'v1' } }],
    });
    await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      ops: [{ op: 'patch-item', id: item.id, patch: { title: 'v2' } }],
    });
    const pending = await store.listBoardProposals({
      workspace: WS,
      board: BOARD,
      status: 'pending',
    });
    const superseded = await store.listBoardProposals({
      workspace: WS,
      board: BOARD,
      status: 'superseded',
    });
    expect(pending).toHaveLength(1);
    expect(superseded).toHaveLength(1);
  });

  it('reject stamps the decision + an optional reason hits the thread', async () => {
    const c = ctx();
    const session = await ensureThread(c, BOARD);
    const { proposals } = await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      ops: [{ op: 'create-item', kind: 'note', title: 'n', x: 1, y: 1 }],
    });
    const row = await rejectProposal(c, {
      proposalId: need(proposals).proposal_id,
      decidedBy: 'amy',
      reason: 'off-topic',
    });
    expect(row.status).toBe('rejected');
    const msgs = await store.listInterviewMessages({
      workspace: WS,
      session_id: session.session_id,
    });
    expect(msgs.at(-1)?.content).toContain('off-topic');
  });

  it('same-batch temp_id: frame + children + connector accept atomically (D69)', async () => {
    const c = ctx();
    const session = await ensureThread(c, BOARD);
    const { proposals, dropped } = await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      batchId: 't1',
      ops: [
        // deliberately wrong order — notes before the frame they join
        {
          op: 'create-item',
          kind: 'note',
          title: 'n1',
          zone: 'f',
          temp_id: 'n1',
        },
        {
          op: 'create-item',
          kind: 'note',
          title: 'n2',
          zone: 'f',
          temp_id: 'n2',
        },
        { op: 'connect', source_item_id: 'n1', target_item_id: 'n2' },
        {
          op: 'create-item',
          kind: 'zone',
          title: 'frame',
          temp_id: 'f',
          x: 0,
          y: 0,
          w: 900,
          h: 400,
        },
      ],
    });
    expect(dropped).toHaveLength(0);
    expect(proposals).toHaveLength(4);
    // Notes drafted inside the proposed frame's rect.
    const n1 = proposals.find(
      (p) => p.payload.op === 'create-item' && p.payload.temp_id === 'n1',
    );
    expect(
      n1?.payload.op === 'create-item' &&
        n1.payload.x !== undefined &&
        n1.payload.x < 900,
    ).toBe(true);
    const res = await acceptProposals(c, {
      board: BOARD,
      batchId: 't1',
      decidedBy: 'amy',
    });
    expect(res.proposals).toHaveLength(4);
    const items = await store.listBoardItems({ workspace: WS, board: BOARD });
    const frame = items.find((i) => i.kind === 'zone');
    const notes = items.filter((i) => i.kind === 'note');
    expect(frame).toBeDefined();
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n.zone).toBe(frame?.id);
    const conns = await store.listBoardConnectors({
      workspace: WS,
      board: BOARD,
    });
    expect(conns).toHaveLength(1);
    expect(conns[0]?.source_item_id).not.toBe('n1');
  });

  it('temp_id: child accepted before its pending frame fails clearly and stays retryable (D69)', async () => {
    const c = ctx();
    const session = await ensureThread(c, BOARD);
    const { proposals } = await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      batchId: 't2',
      ops: [
        {
          op: 'create-item',
          kind: 'zone',
          title: 'frame',
          temp_id: 'f',
          x: 0,
          y: 0,
          w: 900,
          h: 400,
        },
        { op: 'create-item', kind: 'note', title: 'n1', zone: 'f' },
      ],
    });
    const frame = proposals.find(
      (p) => p.payload.op === 'create-item' && p.payload.temp_id === 'f',
    );
    const child = proposals.find(
      (p) => p.payload.op === 'create-item' && p.payload.zone === 'f',
    );
    if (!frame || !child) throw new Error('expected frame + child proposals');
    await expect(
      acceptProposal(c, { proposalId: child.proposal_id, decidedBy: 'a' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // stays pending + retryable — never stale on a pending dep
    expect(
      (
        await store.getBoardProposal({
          workspace: WS,
          proposal_id: child.proposal_id,
        })
      )?.status,
    ).toBe('pending');
    // Accept the frame first → the child's zone repoints to the real id
    // and the retry lands.
    await acceptProposal(c, { proposalId: frame.proposal_id, decidedBy: 'a' });
    const repointed = await store.getBoardProposal({
      workspace: WS,
      proposal_id: child.proposal_id,
    });
    expect(
      repointed?.payload.op === 'create-item' && repointed.payload.zone !== 'f',
    ).toBe(true);
    const res = await acceptProposal(c, {
      proposalId: child.proposal_id,
      decidedBy: 'a',
    });
    const items = await store.listBoardItems({ workspace: WS, board: BOARD });
    const z = items.find((i) => i.kind === 'zone');
    expect(res.items[0]?.zone).toBe(z?.id);
  });

  it('temp_id: dangling refs drop at draft instead of stranding ghosts', async () => {
    const c = ctx();
    const session = await ensureThread(c, BOARD);
    const { proposals, dropped } = await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      ops: [
        { op: 'create-item', kind: 'note', title: 'n1', zone: 'never-existed' },
        { op: 'connect', source_item_id: 'nope', target_item_id: 'also-nope' },
      ],
    });
    expect(proposals).toHaveLength(0);
    expect(dropped).toHaveLength(2);
    expect(dropped[0]?.reason).toContain('never-existed');
  });

  it('legality: delete refuses consumed; connect refuses self-link', async () => {
    const c = ctx();
    const consumed = await note({ title: 'gone', status: 'consumed' });
    const session = await ensureThread(c, BOARD);
    const d = await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      ops: [{ op: 'delete-item', id: consumed.id }],
    });
    await expect(
      acceptProposal(c, {
        proposalId: need(d.proposals).proposal_id,
        decidedBy: 'a',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const self = await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      ops: [
        {
          op: 'connect',
          source_item_id: consumed.id,
          target_item_id: consumed.id,
        },
      ],
    });
    await expect(
      acceptProposal(c, {
        proposalId: need(self.proposals).proposal_id,
        decidedBy: 'a',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

// ---------------------------------------------------------------------------
// placement (pure goldens)
// ---------------------------------------------------------------------------

describe('computePlacement', () => {
  const item = (
    id: string,
    x: number,
    y: number,
    w = 240,
    h = 120,
    kind: 'note' | 'zone' = 'note',
  ): PlacementArgs['items'][number] => ({
    id,
    x,
    y,
    w,
    h,
    zone: null,
    kind,
    status: 'active',
  });

  it('empty board → origin; below-bbox fallback column-flows', () => {
    expect(computePlacement({ items: [] })).toEqual({ x: 0, y: 0 });
    const at = computePlacement({ items: [item('a', 100, 100, 200, 80)] });
    expect(at).toEqual({ x: 96, y: 204 }); // snapped x, bbox bottom +24
  });

  it('zone → first free 32px cell inside the zone rect', () => {
    const zone = item('z', 0, 0, 600, 400, 'zone');
    const inside = item('a', 0, 0); // occupies x0-240,y0-120
    expect(computePlacement({ items: [zone, inside], zone: 'z' })).toEqual({
      x: 256,
      y: 0,
    }); // first free grid cell right of 'a'
  });

  it('anchors → right of the anchor bbox, top-aligned', () => {
    const a = item('a', 0, 0, 100, 100);
    const b = item('b', 0, 200, 100, 100);
    expect(computePlacement({ items: [a, b], anchors: ['a', 'b'] })).toEqual({
      x: 128,
      y: 0,
    });
  });

  it('never overlaps existing items or earlier placements', () => {
    const a = item('a', 0, 0);
    const at1 = computePlacement({ items: [a], anchors: ['a'] });
    const at2 = computePlacement({
      items: [a],
      anchors: ['a'],
      placed: [{ x: at1.x, y: at1.y, w: 240, h: 120 }],
    });
    expect(at2.y).toBeGreaterThan(at1.y);
  });
});

// ---------------------------------------------------------------------------
// coverage + critique + chips (deterministic)
// ---------------------------------------------------------------------------

describe('coverage + critique', () => {
  it('findings cover vague/untyped/orphan/no-goals/missing-kind', async () => {
    await note({ title: 'tiny', note_kind: 'idea' }); // vague + orphan
    const findings = critiqueChecks({
      items: await store.listBoardItems({ workspace: WS, board: BOARD }),
    });
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('vague');
    expect(kinds).toContain('orphan');
    expect(kinds).toContain('missing-kind');
    expect(kinds).toContain('no-goals');
  });

  it('/critique posts one findings message, no proposals', async () => {
    const c = ctx();
    await note({ title: 'tiny', note_kind: 'idea' });
    const res = await postMessage(c, { board: BOARD, text: '/critique' });
    const last = res.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content).toContain('Critique —');
    expect(res.proposals).toHaveLength(0);
  });

  it('/critique merges provider findings deduped; unknown item ids drop', async () => {
    const vague = await note({ title: 'x', note_kind: 'idea' });
    const provider = {
      converse: async () =>
        JSON.stringify({
          findings: [
            // duplicate of the deterministic 'vague' on the same item — dropped
            { kind: 'vague', item_id: vague.id, detail: 'too thin' },
            // a NEW finding on a real item — kept, tagged ·model
            {
              kind: 'unanswered-question',
              item_id: vague.id,
              detail: 'no acceptance criteria recorded for this card',
            },
            // hallucinated item — dropped
            { kind: 'orphan', item_id: 'bi-nope', detail: 'ghost card' },
          ],
        }),
    };
    const c = ctx({ provider, model: 'test-model' });
    const res = await postMessage(c, { board: BOARD, text: '/critique' });
    const body = res.messages.at(-1)?.content ?? '';
    // deterministic vague stands once (no dup), the new finding lands
    expect(body.match(/\*\*vague\*\*/g)).toHaveLength(1);
    expect(body).toContain('no acceptance criteria recorded');
    expect(body).toContain('·model');
    expect(body).not.toContain('ghost card');
  });

  it('/critique malformed provider output → deterministic floor only', async () => {
    const c = ctx({
      provider: { converse: async () => 'not json at all' },
      model: 'test-model',
    });
    await note({ title: 'x', note_kind: 'idea' });
    const res = await postMessage(c, { board: BOARD, text: '/critique' });
    const body = res.messages.at(-1)?.content ?? '';
    expect(body).toContain('Critique —');
    expect(body).toContain('**vague**');
    expect(body).not.toContain('·model');
  });

  it('chips: empty board → Run /interview; draft_ready → synthesize', () => {
    expect(
      suggestChips({ items: [], openDecisions: [], draftReady: false }),
    ).toEqual([
      { id: 'interview', label: 'Run /interview', command: '/interview' },
    ]);
    expect(
      suggestChips({ items: [], openDecisions: ['sd-1'], draftReady: true }),
    ).toEqual([
      { id: 'interview', label: 'Run /interview', command: '/interview' },
      {
        id: 'resolve-decisions',
        label: 'Resolve 1 decision',
        command: '/critique',
      },
      { id: 'synthesize', label: 'Looks ready — synthesize?', command: '' },
    ]);
  });

  it('panelState reports model:absent with no provider', async () => {
    const c = ctx();
    const s = await panelState(c, BOARD);
    expect(s.model).toBe('absent');
    expect(s.skills.map((k) => k.skill)).toEqual([
      'interview',
      'expand',
      'critique',
    ]);
  });
});

// ---------------------------------------------------------------------------
// converse (provider seam)
// ---------------------------------------------------------------------------

describe('converse', () => {
  it('no provider → fail-loud reply, zero ops', async () => {
    const c = ctx();
    const session = await ensureThread(c, BOARD);
    const out = await converse(c, {
      board: BOARD,
      sessionId: session.session_id,
      text: 'make me a sticky',
    });
    expect(out.reply).toBe(NO_PROVIDER_REPLY);
    expect(out.ops).toHaveLength(0);
  });

  it('stub provider: valid output → ops drafted as proposals via postMessage', async () => {
    const provider = {
      converse: async () =>
        JSON.stringify({
          reply: 'added a problem card',
          ops: [
            {
              op: 'create-item',
              kind: 'note',
              note_kind: 'problem',
              title: 'imports crash',
            },
          ],
        }),
    };
    const c = ctx({ provider, model: 'test-model' });
    const res = await postMessage(c, {
      board: BOARD,
      text: 'add a problem card for imports crashing',
    });
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]?.payload.op).toBe('create-item');
    // placement computed — schema-optional coords filled
    const p = res.proposals[0]?.payload as { x?: number; y?: number };
    expect(typeof p.x).toBe('number');
    expect(res.messages.at(-1)?.content).toBe('added a problem card');
    const s = await panelState(c, BOARD);
    expect(s.model).toBe('configured');
  });

  it('malformed provider output → fail-closed zero ops', async () => {
    const c = ctx({
      provider: { converse: async () => 'not json at all' },
      model: 'm',
    });
    const session = await ensureThread(c, BOARD);
    const out = await converse(c, {
      board: BOARD,
      sessionId: session.session_id,
      text: 'whatever',
    });
    expect(out.malformed).toBe(true);
    expect(out.reply).toBe(MALFORMED_REPLY);
  });
});

// ---------------------------------------------------------------------------
// intent map + goals wiring + contradictions
// ---------------------------------------------------------------------------

describe('statements → proposals', () => {
  it('intent map: want/problem/constraint land as the right note_kind', async () => {
    const c = ctx({
      extract: makeExtractor((answer) => [
        {
          key: 'a',
          text: 'users want fast search',
          source: 0,
          source_text: 'users want fast search',
          intent: 'want',
        },
        {
          key: 'b',
          text: 'legacy imports crash weekly',
          source: 0,
          source_text: 'legacy imports crash weekly',
          intent: 'problem',
        },
      ]),
    });
    await postMessage(c, { board: BOARD, text: '/interview' });
    const res = await postMessage(c, {
      board: BOARD,
      text: 'users want fast search and legacy imports crash weekly',
    });
    const kinds = res.proposals.map(
      (p) => (p.payload as { note_kind?: string }).note_kind,
    );
    expect(kinds).toEqual(['want', 'problem']);
    expect(res.proposals.every((p) => p.seq != null)).toBe(true);
  });

  it('goals-slot answer + expand anchors → serve ops onto the goal', async () => {
    const goal = await note({ title: 'the goal' });
    const member = await note({ title: 'member' });
    await note({ title: 'filler', serves: [goal.id] }); // makes goal a target
    const c = ctx();
    await postMessage(c, {
      board: BOARD,
      text: `/expand ${goal.id},${member.id}`,
    });
    const res = await postMessage(c, {
      board: BOARD,
      text: 'this covers our retention goal',
    });
    const serves = res.proposals.filter((p) => p.op === 'serve');
    expect(serves).toHaveLength(1);
    expect(serves[0]?.payload).toMatchObject({
      op: 'serve',
      id: member.id,
      goal_item_id: goal.id,
    });
  });

  it('decision-intent extraction opens a decision + in-thread surfacing', async () => {
    const c = ctx({
      extract: makeExtractor((answer) => [
        {
          key: 'a',
          text: 'we decided Postgres over SQLite',
          source: 0,
          source_text: 'we decided Postgres over SQLite',
          intent: 'decision',
        },
      ]),
    });
    await postMessage(c, { board: BOARD, text: '/interview' });
    const res = await postMessage(c, {
      board: BOARD,
      text: 'we decided Postgres over SQLite',
    });
    expect(res.messages.some((m) => m.content.includes('conflicts'))).toBe(
      true,
    );
    const decisions = await store.listStatementDecisions({ workspace: WS });
    expect(decisions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// decision outcome → supersede
// ---------------------------------------------------------------------------

describe('supersedeForDecision', () => {
  it('retires pending proposals authored by the losing statement', async () => {
    const c = ctx();
    const session = await ensureThread(c, BOARD);
    const { proposals } = await draftProposals(c, {
      board: BOARD,
      sessionId: session.session_id,
      ops: [{ op: 'create-item', kind: 'note', title: 'x', x: 0, y: 0 }],
      provenance: { statement_ids: ['st-loser'], branch: null },
    });
    const res = await supersedeForDecision(c, {
      board: BOARD,
      sessionId: session.session_id,
      statement: { statement_id: 'st-loser' },
    });
    expect(res.superseded).toBe(1);
    const row = await store.getBoardProposal({
      workspace: WS,
      proposal_id: need(proposals).proposal_id,
    });
    expect(row?.status).toBe('superseded');
  });
});

// ---------------------------------------------------------------------------
// coverage report shape
// ---------------------------------------------------------------------------

describe('boardCoverage', () => {
  it('counts goals via serves-targets, orphans via unconnected', async () => {
    const g = await note({ title: 'goal', note_kind: 'idea' });
    await note({ title: 'member', note_kind: 'want', serves: [g.id] });
    await note({ title: 'orphan', note_kind: 'idea' });
    const cov = boardCoverage(
      await store.listBoardItems({ workspace: WS, board: BOARD }),
    );
    expect(cov.goals).toBe(1);
    expect(cov.orphans).toBe(1); // goal is a serves-target; member serves it
    expect(cov.typed).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

describe('errors', () => {
  it('unknown board → not-found InterviewError', async () => {
    await expect(
      postMessage(ctx(), { board: 'nope', text: 'hi' }),
    ).rejects.toBeInstanceOf(InterviewError);
  });
});
