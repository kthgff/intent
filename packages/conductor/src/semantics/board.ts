/**
 * Board v2 engine (wp-144, PRD §15.3) — the semantic idea board on top
 * of the wp-131 `boards`/`board_items` tables and the wp-143 Statement
 * Ledger.
 *
 * The standing rules this module implements:
 *  - **Board types are config, not pipelines.** One board engine;
 *    `BOARD_TYPE_CONFIG` declares each type's inputs/capabilities/
 *    outputs/approval policy — a board may change type with its
 *    history preserved.
 *  - **Typed sticky notes** layer `note_kind`/`topic`/`importance`/
 *    `applies_to`/`note_status`/`rationale` on top of the existing
 *    `kind` (the card's structural type).
 *  - **Multiple boards + org-level boards.** Boards are per-workspace;
 *    a board with `org` set holds unassigned ideas and may spawn a new
 *    workspace while keeping provenance.
 *  - **Board → statements handoff.** A board's open items are evidence;
 *    extraction turns them into statements whose `source_ref` points
 *    back at the item (`board-item`), so a board surface can show the
 *    statements derived from each note.
 *  - **Deferred ideas never die.** Deferred boards/notes keep all
 *    evidence; AI may *propose* resurfacing, a human accepts it.
 *  - **Referencing approved items never mutates them.** A board card
 *    may reference an approved doc version; changes arrive only as
 *    ChangeSets (wp-140).
 */
import { randomUUID } from 'node:crypto';
import type {
  ActorType,
  BoardItem,
  BoardRow,
  BoardStatus,
  BoardType,
  NoteImportance,
  NoteKind,
  NoteStatus,
  StatementRow,
  Store,
} from '@sprint-runner/core';
import {
  BOARD_STATUSES,
  BOARD_TYPES,
  NOTE_IMPORTANCES,
  NOTE_KINDS,
  NOTE_STATUSES,
} from '@sprint-runner/core';
import { createChangeset } from '../changes/engine.js';
import type { ChangesetRow } from '@sprint-runner/core';
import type { ChangesCtx } from '../changes/engine.js';
import {
  type IngestExtractionResult,
  type RunExtractionArgs,
  runExtraction,
} from './extract.js';
import { sourceFromBoardItem } from './sources.js';
import type { StatementActor } from './types.js';

/** Fail-closed board error — malformed input / illegal transition
 *  aborts the write rather than guessing (AGENTS.md). */
export class BoardError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'BoardError';
  }
}

// ---------------------------------------------------------------------------
// Board types as config (§15.3 "one board engine, per-type config")
// ---------------------------------------------------------------------------

/** Evidence the board's capture surface accepts. */
export type BoardInput =
  | 'sticky'
  | 'text'
  | 'document'
  | 'image'
  | 'file'
  | 'link'
  | 'voice'
  | 'zone'
  | 'connector'
  | 'import'
  | 'survey'
  | 'feedback'
  | 'tray';

/** Engine capabilities enabled for a board type. */
export type BoardCapability =
  | 'capture'
  | 'clustering'
  | 'duplicate-suggestion'
  | 'synthesize'
  | 'cross-board-reconcile'
  | 'resurface'
  | 'release-plan';

/** What a board can produce at `proposal-ready`. */
export type BoardOutput =
  | 'solution-brief'
  | 'rs'
  | 'features'
  | 'tickets'
  | 'changeset'
  | 'release-plan';

/** How a board's outputs get approved — never silent. */
export type BoardApproval = 'human-gate' | 'human-gate+changeset' | 'review-studio';

export interface BoardTypeConfig {
  board_type: BoardType;
  label: string;
  summary: string;
  inputs: readonly BoardInput[];
  capabilities: readonly BoardCapability[];
  outputs: readonly BoardOutput[];
  approval: BoardApproval;
  /** Note kinds the capture surface foregrounds (the taxonomy stays
   *  global — a board never loses access to the full set). */
  note_kinds: readonly NoteKind[];
}

const ALL_NOTES = NOTE_KINDS;

/** The 8 board types (§15.3) — one engine, per-type config. */
export const BOARD_TYPE_CONFIG: Record<BoardType, BoardTypeConfig> = {
  'new-project': {
    board_type: 'new-project',
    label: 'New project',
    summary: 'Greenfield discovery: problem → Solution Brief → RS.',
    inputs: ['sticky', 'text', 'document', 'link', 'voice', 'zone', 'connector', 'tray'],
    capabilities: ['capture', 'clustering', 'duplicate-suggestion', 'synthesize', 'cross-board-reconcile'],
    outputs: ['solution-brief', 'rs', 'features', 'tickets'],
    approval: 'human-gate',
    note_kinds: ALL_NOTES,
  },
  import: {
    board_type: 'import',
    label: 'Import',
    summary: 'Reconcile imported work items into an RS; may outlive its first purpose.',
    inputs: ['import', 'document', 'link', 'tray'],
    capabilities: ['capture', 'clustering', 'duplicate-suggestion', 'synthesize'],
    outputs: ['solution-brief', 'rs', 'features', 'tickets'],
    approval: 'human-gate',
    note_kinds: ALL_NOTES,
  },
  enhancement: {
    board_type: 'enhancement',
    label: 'Enhancement',
    summary: 'Change requests against an existing Solution — arrive as ChangeSets.',
    inputs: ['sticky', 'text', 'feedback', 'document', 'link', 'voice', 'tray'],
    capabilities: ['capture', 'clustering', 'duplicate-suggestion', 'synthesize', 'cross-board-reconcile'],
    outputs: ['changeset', 'features', 'tickets'],
    approval: 'human-gate+changeset',
    note_kinds: ALL_NOTES,
  },
  modernization: {
    board_type: 'modernization',
    label: 'Modernization',
    summary: 'Current-state survey → target state → sequenced ChangeSets.',
    inputs: ['sticky', 'text', 'document', 'survey', 'link', 'tray'],
    capabilities: ['capture', 'clustering', 'synthesize', 'cross-board-reconcile'],
    outputs: ['solution-brief', 'rs', 'changeset', 'features', 'tickets'],
    approval: 'human-gate+changeset',
    note_kinds: ALL_NOTES,
  },
  quality: {
    board_type: 'quality',
    label: 'Quality',
    summary: 'Defects, debt and risks → remediation ChangeSets.',
    inputs: ['sticky', 'text', 'feedback', 'survey', 'tray'],
    capabilities: ['capture', 'clustering', 'duplicate-suggestion', 'synthesize'],
    outputs: ['changeset', 'tickets'],
    approval: 'human-gate+changeset',
    note_kinds: ['problem', 'constraint', 'feedback', 'idea'],
  },
  feedback: {
    board_type: 'feedback',
    label: 'Feedback',
    summary: 'Shipped-entity feedback → clustered ChangeSets/proposals.',
    inputs: ['feedback', 'sticky', 'text', 'link', 'tray'],
    capabilities: ['capture', 'clustering', 'duplicate-suggestion', 'synthesize', 'resurface'],
    outputs: ['changeset', 'features', 'tickets'],
    approval: 'human-gate+changeset',
    note_kinds: ['feedback', 'problem', 'want', 'idea'],
  },
  'release-planning': {
    board_type: 'release-planning',
    label: 'Release planning',
    summary: 'Feature-first release assembly through the Review Studio.',
    inputs: ['sticky', 'text', 'document', 'tray'],
    capabilities: ['capture', 'cross-board-reconcile', 'release-plan'],
    outputs: ['release-plan'],
    approval: 'review-studio',
    note_kinds: ['want', 'constraint', 'decision', 'question'],
  },
  exploration: {
    board_type: 'exploration',
    label: 'Exploration',
    summary: 'Open-ended capture; may promote to any other type.',
    inputs: [
      'sticky', 'text', 'document', 'image', 'file', 'link', 'voice',
      'zone', 'connector', 'tray',
    ],
    capabilities: ['capture', 'clustering', 'duplicate-suggestion', 'synthesize', 'resurface'],
    outputs: ['solution-brief', 'rs'],
    approval: 'human-gate',
    note_kinds: ALL_NOTES,
  },
};

/** Config for a board type — defaults to `exploration` (the permissive
 *  capture type) when unset, so a board is never config-less. */
export function boardTypeConfig(
  type: BoardType | null | undefined,
): BoardTypeConfig {
  if (type && type in BOARD_TYPE_CONFIG) return BOARD_TYPE_CONFIG[type];
  return BOARD_TYPE_CONFIG.exploration;
}

/** True when the board type enables a capability. */
export function boardSupports(
  type: BoardType | null | undefined,
  capability: BoardCapability,
): boolean {
  return boardTypeConfig(type).capabilities.includes(capability);
}

// ---------------------------------------------------------------------------
// Typed notes (§15.3 typed sticky taxonomy)
// ---------------------------------------------------------------------------

function assertNoteKind(kind: string | null | undefined): NoteKind | null {
  if (kind == null) return null;
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) {
    throw new BoardError(
      `unknown note_kind '${kind}' (expected ${NOTE_KINDS.join('|')})`,
    );
  }
  return kind as NoteKind;
}
function assertImportance(
  v: string | null | undefined,
): NoteImportance | null {
  if (v == null) return null;
  if (!(NOTE_IMPORTANCES as readonly string[]).includes(v)) {
    throw new BoardError(
      `unknown importance '${v}' (expected ${NOTE_IMPORTANCES.join('|')})`,
    );
  }
  return v as NoteImportance;
}
function assertNoteStatus(v: string | null | undefined): NoteStatus | null {
  if (v == null) return null;
  if (!(NOTE_STATUSES as readonly string[]).includes(v)) {
    throw new BoardError(
      `unknown note_status '${v}' (expected ${NOTE_STATUSES.join('|')})`,
    );
  }
  return v as NoteStatus;
}
function assertBoardStatus(v: string | null | undefined): BoardStatus | null {
  if (v == null) return null;
  if (!(BOARD_STATUSES as readonly string[]).includes(v)) {
    throw new BoardError(
      `unknown board status '${v}' (expected ${BOARD_STATUSES.join('|')})`,
    );
  }
  return v as BoardStatus;
}
function assertBoardType(v: string | null | undefined): BoardType | null {
  if (v == null) return null;
  if (!(BOARD_TYPES as readonly string[]).includes(v)) {
    throw new BoardError(
      `unknown board_type '${v}' (expected ${BOARD_TYPES.join('|')})`,
    );
  }
  return v as BoardType;
}

export interface TypedNoteInput {
  workspace: string;
  org?: string | null;
  /** NULL = capture tray (D27). */
  board?: string | null;
  /** Structural card type — defaults to `note`. */
  kind?: BoardItem['kind'];
  note_kind?: NoteKind | null;
  topic?: string | null;
  importance?: NoteImportance | null;
  /** Refs the note applies to (ticket/feature/entity ids). */
  applies_to?: string[] | null;
  note_status?: NoteStatus | null;
  rationale?: string | null;
  title?: string | null;
  body?: string | null;
  ref?: string | null;
  x?: number | null;
  y?: number | null;
  w?: number | null;
  h?: number | null;
  zone?: string | null;
  /** D33 goal board_item ids this note serves. */
  serves?: string[] | null;
  status?: BoardItem['status'];
  provenance?: BoardItem['provenance'];
  actor: StatementActor;
  now?: () => Date;
}

/**
 * Create one typed sticky note. Fail-closed on an unknown note_kind/
 * importance/note_status — the taxonomy is a closed set. The card's
 * structural `kind` defaults to `note`.
 */
export async function createTypedNote(
  store: Store,
  args: TypedNoteInput,
): Promise<BoardItem> {
  const ts = (args.now?.() ?? new Date()).toISOString();
  const note: BoardItem = {
    id: `bi-${randomUUID().slice(0, 12)}`,
    workspace: args.workspace,
    org: args.org ?? null,
    board: args.board ?? null,
    kind: args.kind ?? 'note',
    ref: args.ref ?? null,
    title: args.title ?? null,
    body: args.body ?? null,
    x: args.x ?? null,
    y: args.y ?? null,
    w: args.w ?? null,
    h: args.h ?? null,
    zone: args.zone ?? null,
    serves: args.serves ?? null,
    status: args.status ?? 'active',
    consumed_by: null,
    note_kind: assertNoteKind(args.note_kind),
    topic: args.topic ?? null,
    importance: assertImportance(args.importance),
    applies_to: args.applies_to ?? null,
    note_status: assertNoteStatus(args.note_status ?? 'open'),
    rationale: args.rationale ?? null,
    provenance: args.provenance ?? 'stakeholder-verified',
    created_at: ts,
    updated_at: ts,
  };
  await store.upsertBoardItem(note);
  return note;
}

/** Rewrite a note's own lifecycle (`note_status`). Returns the updated
 *  card; fail-closed when the card is missing. */
export async function setNoteStatus(
  store: Store,
  args: {
    id: string;
    note_status: NoteStatus;
    actor: StatementActor;
    now?: () => Date;
  },
): Promise<BoardItem> {
  const item = await store.getBoardItem(args.id);
  if (!item) throw new BoardError(`no board_items row for ${args.id}`);
  const ts = (args.now?.() ?? new Date()).toISOString();
  const next: BoardItem = {
    ...item,
    note_status: assertNoteStatus(args.note_status),
    updated_at: ts,
  };
  await store.upsertBoardItem(next);
  return next;
}

/** Defer a note — the card keeps its evidence and can resurface. */
export function deferNote(
  store: Store,
  args: { id: string; actor: StatementActor; now?: () => Date },
): Promise<BoardItem> {
  return setNoteStatus(store, { ...args, note_status: 'deferred' });
}

/** Resurface a deferred note (AI may propose; this write is the human
 *  acceptance — a card never silently re-enters the board). */
export function resurfaceNote(
  store: Store,
  args: { id: string; actor: StatementActor; now?: () => Date },
): Promise<BoardItem> {
  return setNoteStatus(store, { ...args, note_status: 'resurfaced' });
}

/** Move a capture-tray card onto a board (D27 tray → canvas). */
export async function promoteTrayItem(
  store: Store,
  args: {
    id: string;
    board: string;
    actor: StatementActor;
    now?: () => Date;
  },
): Promise<BoardItem> {
  const item = await store.getBoardItem(args.id);
  if (!item) throw new BoardError(`no board_items row for ${args.id}`);
  if (item.board !== null) {
    throw new BoardError(
      `board item ${args.id} is already on board '${item.board}' — not a tray item`,
    );
  }
  const ts = (args.now?.() ?? new Date()).toISOString();
  const next: BoardItem = { ...item, board: args.board, updated_at: ts };
  await store.upsertBoardItem(next);
  return next;
}

// ---------------------------------------------------------------------------
// Board lifecycle (draft|discovery|proposal-ready|approved|deferred|archived)
// ---------------------------------------------------------------------------

export interface CreateBoardArgs {
  workspace: string;
  board: string;
  name?: string | null;
  org?: string | null;
  board_type?: BoardType | null;
  status?: BoardStatus | null;
  actor: StatementActor;
  now?: () => Date;
}

/** Create (or reconfigure) a board. Fail-closed on unknown type/status. */
export async function createBoard(
  store: Store,
  args: CreateBoardArgs,
): Promise<BoardRow> {
  const ts = (args.now?.() ?? new Date()).toISOString();
  const row: BoardRow = {
    workspace: args.workspace,
    org: args.org ?? null,
    board: args.board,
    name: args.name ?? null,
    board_type: assertBoardType(args.board_type ?? 'exploration'),
    status: assertBoardStatus(args.status ?? 'draft'),
    created_at: ts,
  };
  await store.upsertBoard(row);
  return row;
}

/** Set a board's lifecycle status. Illegal-free but validated — the
 *  enum is the guard; every change keeps the board's evidence. */
export async function setBoardStatus(
  store: Store,
  args: {
    workspace: string;
    board: string;
    status: BoardStatus;
    actor: StatementActor;
    now?: () => Date;
  },
): Promise<BoardRow> {
  const board = await store.getBoard(args.workspace, args.board);
  if (!board) {
    throw new BoardError(
      `no boards row for ${args.workspace}/${args.board}`,
    );
  }
  const next: BoardRow = {
    ...board,
    status: assertBoardStatus(args.status),
  };
  await store.upsertBoard(next);
  return next;
}

/** Defer a board — evidence, interview and decisions are retained. */
export function deferBoard(
  store: Store,
  args: { workspace: string; board: string; actor: StatementActor; now?: () => Date },
): Promise<BoardRow> {
  return setBoardStatus(store, { ...args, status: 'deferred' });
}

/** Archive a board (terminal; history preserved). */
export function archiveBoard(
  store: Store,
  args: { workspace: string; board: string; actor: StatementActor; now?: () => Date },
): Promise<BoardRow> {
  return setBoardStatus(store, { ...args, status: 'archived' });
}

/** A resurfacing proposal — the AI's suggestion that a deferred board
 *  is worth another look (never applied silently). */
export interface BoardResurfaceProposal {
  workspace: string;
  board: string;
  board_type: BoardType | null;
  reason: string;
  /** Items retained on the deferred board (all evidence). */
  retained_items: number;
  /** Open statements still on the ledger for this board's items. */
  open_statements: number;
  proposed_by: ActorType;
  requires_approval: boolean;
}

/**
 * Propose resurfacing a deferred board (§15.3 "deferred ideas never
 * die"). Read-only — nothing changes until a human accepts; an AI may
 * only raise the proposal. Fail-closed when the board isn't deferred.
 */
export async function proposeResurface(
  store: Store,
  args: {
    workspace: string;
    board: string;
    reason: string;
    actor: StatementActor;
  },
): Promise<BoardResurfaceProposal> {
  const board = await store.getBoard(args.workspace, args.board);
  if (!board) {
    throw new BoardError(`no boards row for ${args.workspace}/${args.board}`);
  }
  if (board.status !== 'deferred') {
    throw new BoardError(
      `proposeResurface: ${args.workspace}/${args.board} is '${board.status ?? 'unset'}' — only deferred boards resurface`,
    );
  }
  const items = await store.listBoardItems({
    workspace: args.workspace,
    board: args.board,
  });
  const open = await statementsForItems(
    store,
    args.workspace,
    items.map((i) => i.id),
  );
  return {
    workspace: args.workspace,
    board: args.board,
    board_type: (board.board_type as BoardType | null) ?? null,
    reason: args.reason,
    retained_items: items.length,
    open_statements: open.filter(
      (s) => s.status === 'proposed' || s.status === 'confirmed',
    ).length,
    proposed_by: args.actor.type,
    requires_approval: true,
  };
}

/** Accept a resurfacing proposal (human only) — the deferred board
 *  re-enters discovery with all its evidence intact. */
export async function acceptResurface(
  store: Store,
  args: { workspace: string; board: string; actor: StatementActor; now?: () => Date },
): Promise<BoardRow> {
  if (args.actor.type !== 'human') {
    throw new BoardError(
      'acceptResurface: requires a human actor (AI proposes, humans decide — §15.3)',
    );
  }
  const board = await store.getBoard(args.workspace, args.board);
  if (!board) {
    throw new BoardError(`no boards row for ${args.workspace}/${args.board}`);
  }
  if (board.status !== 'deferred') {
    throw new BoardError(
      `acceptResurface: ${args.workspace}/${args.board} is '${board.status ?? 'unset'}' — only deferred boards resurface`,
    );
  }
  return setBoardStatus(store, { ...args, status: 'discovery' });
}

// ---------------------------------------------------------------------------
// Multiple boards + org-level boards + spawn provenance
// ---------------------------------------------------------------------------

/** Every board in a workspace (idea + org-level + delivery). */
export function listWorkspaceBoards(
  store: Store,
  workspace: string,
): Promise<BoardRow[]> {
  return store.listBoards(workspace);
}

/** Org-level boards in a workspace — boards holding unassigned ideas
 *  (§15.3). `org` set on the row is the marker. */
export async function listOrgBoards(
  store: Store,
  workspace: string,
): Promise<BoardRow[]> {
  return (await store.listBoards(workspace)).filter(
    (b) => b.org !== null && b.org !== undefined,
  );
}

/** A `board:<workspace>/<board>` ref records spawn provenance as a card
 *  on the spawned board — durable without a new table. */
export const SPAWN_REF_PREFIX = 'board:';

export interface SpawnWorkspaceArgs {
  originWorkspace: string;
  originBoard: string;
  /** New workspace (Solution) to create. */
  newWorkspace: string;
  name?: string | null;
  /** Board slug inside the new workspace — defaults to `main`. */
  board?: string;
  actor: StatementActor;
  now?: () => Date;
}

export interface SpawnResult {
  workspace: string;
  board: BoardRow;
  origin: { workspace: string; board: string };
  /** The provenance card written on the spawned board. */
  provenance: BoardItem;
}

/**
 * Spawn a new workspace (Solution) from an org board and keep
 * provenance (§15.3 "an org board can spawn a new Solution and keeps
 * provenance"). The new board inherits the origin's board_type; a
 * `note` card on it carries the `board:<origin>` ref so the lineage is
 * queryable via {@link getSpawnProvenance}.
 */
export async function spawnWorkspaceFromBoard(
  store: Store,
  args: SpawnWorkspaceArgs,
): Promise<SpawnResult> {
  const origin = await store.getBoard(args.originWorkspace, args.originBoard);
  if (!origin) {
    throw new BoardError(
      `no boards row for ${args.originWorkspace}/${args.originBoard}`,
    );
  }
  const ts = (args.now?.() ?? new Date()).toISOString();
  const boardSlug = args.board ?? 'main';

  await store.upsertProject({ workspace: args.newWorkspace });
  const board = await createBoard(store, {
    workspace: args.newWorkspace,
    board: boardSlug,
    name: args.name ?? `${origin.name ?? origin.board} (spawned)`,
    org: origin.org ?? null,
    board_type: (origin.board_type as BoardType | null) ?? null,
    status: 'draft',
    actor: args.actor,
    ...(args.now ? { now: args.now } : {}),
  });

  const provenance: BoardItem = {
    id: `bi-${randomUUID().slice(0, 12)}`,
    workspace: args.newWorkspace,
    org: origin.org ?? null,
    board: boardSlug,
    kind: 'note',
    ref: `${SPAWN_REF_PREFIX}${args.originWorkspace}/${args.originBoard}`,
    title: `Spawned from ${args.originWorkspace}/${args.originBoard}`,
    body: JSON.stringify({
      origin_workspace: args.originWorkspace,
      origin_board: args.originBoard,
      spawned_workspace: args.newWorkspace,
      board_type: origin.board_type ?? null,
      spawned_at: ts,
      spawned_by: args.actor.id,
    }),
    x: null,
    y: null,
    w: null,
    h: null,
    zone: null,
    serves: null,
    status: 'active',
    consumed_by: null,
    note_kind: 'decision',
    topic: 'spawn-provenance',
    importance: null,
    applies_to: [`${args.originWorkspace}/${args.originBoard}`],
    note_status: 'resolved',
    rationale: `org board ${args.originWorkspace}/${args.originBoard} spawned this workspace`,
    provenance: 'stakeholder-verified',
    created_at: ts,
    updated_at: ts,
  };
  await store.upsertBoardItem(provenance);

  return {
    workspace: args.newWorkspace,
    board,
    origin: { workspace: args.originWorkspace, board: args.originBoard },
    provenance,
  };
}

/** The spawn provenance card on a board, when it was spawned from an
 *  org board (null otherwise). */
export async function getSpawnProvenance(
  store: Store,
  args: { workspace: string; board: string },
): Promise<BoardItem | null> {
  const items = await store.listBoardItems({
    workspace: args.workspace,
    board: args.board,
  });
  return (
    items.find((i) => i.ref?.startsWith(SPAWN_REF_PREFIX) === true) ?? null
  );
}

// ---------------------------------------------------------------------------
// Board → statements handoff (extraction)
// ---------------------------------------------------------------------------

export interface ExtractBoardArgs
  extends Omit<RunExtractionArgs, 'sources' | 'subject' | 'actor'> {
  workspace: string;
  board: string;
  /** Restrict extraction to these item ids (default: all non-discarded). */
  itemIds?: string[];
  /** created_by on every written row. */
  actor: string;
}

export interface ExtractBoardResult extends IngestExtractionResult {
  /** Item ids that were fed to the extractor, in source order. */
  itemIds: string[];
  /** item id → statement_ids extracted from it. */
  byItem: Record<string, string[]>;
}

/**
 * The evidence set for a board extraction: the open (non-discarded)
 * cards in deterministic store order plus their {@link ExtractionSource}
 * views. `itemIds` restricts the set when given. Fail-closed when the
 * set is empty.
 */
export async function boardSources(
  store: Store,
  args: { workspace: string; board: string; itemIds?: string[] },
): Promise<{ items: BoardItem[]; sources: ReturnType<typeof sourceFromBoardItem>[] }> {
  const all = await store.listBoardItems({
    workspace: args.workspace,
    board: args.board,
  });
  const wanted = args.itemIds ? new Set(args.itemIds) : null;
  const items = all.filter(
    (i) => i.status !== 'discarded' && (wanted === null || wanted.has(i.id)),
  );
  if (items.length === 0) {
    throw new BoardError(
      `board ${args.workspace}/${args.board} has no extractable items`,
    );
  }
  return { items, sources: items.map(sourceFromBoardItem) };
}

/** Map an ingest result's statements back to the board items they came
 *  from (`source_ref.kind === 'board-item'`). */
export function statementsByItem(
  result: IngestExtractionResult,
  itemIds: string[],
): Record<string, string[]> {
  const byItem: Record<string, string[]> = {};
  for (const id of itemIds) byItem[id] = [];
  for (const st of result.statements) {
    const ref = st.source_ref as { kind?: string; id?: string } | null;
    if (ref?.kind === 'board-item' && ref.id && byItem[ref.id]) {
      byItem[ref.id]?.push(st.statement_id);
    }
  }
  return byItem;
}

/**
 * Run the extraction handoff for a board: every open card is evidence
 * (§15.3), the LLM produces `statements.json`, and the ingest links
 * each statement back to its card via `source_ref` (`board-item`).
 * `discarded` cards are excluded — a discarded idea is not evidence.
 */
export async function extractBoard(
  store: Store,
  args: ExtractBoardArgs,
): Promise<ExtractBoardResult> {
  const { items, sources } = await boardSources(store, {
    workspace: args.workspace,
    board: args.board,
    ...(args.itemIds ? { itemIds: args.itemIds } : {}),
  });
  const result = await runExtraction(store, {
    ...args,
    subject: `board:${args.board}`,
    sources,
    actor: args.actor,
  });
  return {
    ...result,
    itemIds: items.map((i) => i.id),
    byItem: statementsByItem(result, items.map((i) => i.id)),
  };
}

// ---------------------------------------------------------------------------
// Statement-derived board surfaces (§15.3 "an item shows the statements
// extracted from it")
// ---------------------------------------------------------------------------

/** Every statement whose evidence is one of these board items. */
export async function statementsForItems(
  store: Store,
  workspace: string,
  itemIds: string[],
): Promise<StatementRow[]> {
  const wanted = new Set(itemIds);
  const all = await store.listStatements({ workspace });
  return all.filter((s) => {
    const ref = s.source_ref as { kind?: string; id?: string } | null;
    return ref?.kind === 'board-item' && ref.id !== undefined && wanted.has(ref.id);
  });
}

/** Statements extracted from one board item (empty when none yet). */
export function statementsForItem(
  store: Store,
  args: { workspace: string; itemId: string },
): Promise<StatementRow[]> {
  return statementsForItems(store, args.workspace, [args.itemId]);
}

export interface BoardItemSurface {
  item: BoardItem;
  /** The statements extracted from this item, in ledger order. */
  statements: StatementRow[];
}

/** A board's cards, each carrying the statements extracted from it. */
export async function boardSurface(
  store: Store,
  args: { workspace: string; board: string },
): Promise<BoardItemSurface[]> {
  const items = await store.listBoardItems({
    workspace: args.workspace,
    board: args.board,
  });
  const statements = await statementsForItems(
    store,
    args.workspace,
    items.map((i) => i.id),
  );
  const byItem = new Map<string, StatementRow[]>();
  for (const s of statements) {
    const ref = s.source_ref as { id?: string } | null;
    if (!ref?.id) continue;
    const list = byItem.get(ref.id) ?? [];
    list.push(s);
    byItem.set(ref.id, list);
  }
  return items.map((item) => ({
    item,
    statements: byItem.get(item.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Referencing approved items — never mutate (ChangeSet path)
// ---------------------------------------------------------------------------

export interface ReferenceApprovedArgs {
  workspace: string;
  board: string;
  /** Approved subject (ticket/initiative/feature id). */
  subject: string;
  doc: string;
  actor: StatementActor;
  title?: string | null;
  now?: () => Date;
}

export interface ApprovedReference {
  item: BoardItem;
  /** The exact immutable version the card references. */
  baseline: { subject: string; doc: string; version: number };
}

/**
 * Reference an approved doc version from a board card. **Read-only**:
 * the card carries `ref` = `<subject>:<doc>@v<N>`; no doc_version is
 * written (§15.3 "a board can reference approved requirements without
 * mutating them"). Fail-closed when the doc has no version.
 */
export async function referenceApprovedItem(
  store: Store,
  args: ReferenceApprovedArgs,
): Promise<ApprovedReference> {
  const head = await store.getDoc({
    workspace: args.workspace,
    subject: args.subject,
    doc: args.doc as Parameters<Store['getDoc']>[0]['doc'],
  });
  if (!head) {
    throw new BoardError(
      `referenceApprovedItem: no doc ${args.subject}:${args.doc} in ${args.workspace}`,
    );
  }
  const ts = (args.now?.() ?? new Date()).toISOString();
  const item: BoardItem = {
    id: `bi-${randomUUID().slice(0, 12)}`,
    workspace: args.workspace,
    org: null,
    board: args.board,
    kind: 'note',
    ref: `${args.subject}:${args.doc}@v${head.version}`,
    title: args.title ?? `Reference: ${args.subject} ${args.doc} v${head.version}`,
    body: null,
    x: null,
    y: null,
    w: null,
    h: null,
    zone: null,
    serves: null,
    status: 'active',
    consumed_by: null,
    note_kind: 'idea',
    topic: args.doc,
    importance: null,
    applies_to: [args.subject],
    note_status: 'open',
    rationale: `references approved ${args.subject}:${args.doc} v${head.version} — read-only`,
    provenance: 'stakeholder-verified',
    created_at: ts,
    updated_at: ts,
  };
  await store.upsertBoardItem(item);
  return {
    item,
    baseline: { subject: args.subject, doc: args.doc, version: head.version },
  };
}

export interface ChangeRequestArgs {
  workspace: string;
  board: string;
  /** Approved subject the change targets. */
  subject: string;
  doc: string;
  /** Verbatim change request — never rewritten after create. */
  request: string;
  actor: StatementActor;
  classification?: ChangesetRow['classification'];
  now?: () => Date;
}

/**
 * Route a board-sourced change against an approved item through the
 * ChangeSet engine (wp-140) — the ONLY path by which an approved item
 * changes. The board card references the item; the change arrives as a
 * ChangeSet anchored to the exact approved baseline version.
 */
export async function changeRequestForApprovedItem(
  store: Store,
  args: ChangeRequestArgs,
): Promise<ChangesetRow> {
  const ctx: ChangesCtx = {
    workspace: args.workspace,
    store,
    actor: args.actor.id,
    now: args.now ?? (() => new Date()),
  };
  return createChangeset(ctx, {
    request: args.request,
    title: `Board ${args.board}: change to ${args.subject}`,
    baseline: { subject: args.subject, doc: args.doc },
    ...(args.classification ? { classification: args.classification } : {}),
    createdBy: args.actor.id,
  });
}
