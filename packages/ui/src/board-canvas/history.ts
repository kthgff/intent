/**
 * history.ts — session-local undo/redo for canvas mutations.
 *
 * A command stores, per direction, the fields to restore plus
 * `fromTs` — the `updated_at` the durable row must still carry for the
 * transition to be safe. Undo/redo are *new OCC-fenced writes*, never
 * a local rewind: planning fails as a conflict when a remote edit
 * moved a member since the recorded state (BOARD-CANVAS-TDD
 * "Undo/redo").
 */
import type { BoardItem } from '@veto/core';

/** Canvas-mutable fields a command records and restores. */
export const PATCHABLE_FIELDS = [
  'x',
  'y',
  'w',
  'h',
  'zone',
  'color',
  'z_index',
  'title',
  'body',
  'status',
] as const;
/** Easy Edit semantic fields (D62) — commands pass this list explicitly
 *  so canvas commands don't record fields they never mutate. */
export const EASY_EDIT_FIELDS = [
  'note_kind',
  'importance',
  'note_status',
  'board',
] as const;
/** Bulk-verb commands (lasso + Easy Edit share these — TOOLS-TDD §3
 *  selection parity): every field any bulk verb can touch, so undo
 *  restores the whole semantic+geometry state the verb changed. */
export const BULK_FIELDS = [
  ...PATCHABLE_FIELDS,
  ...EASY_EDIT_FIELDS,
  'presentation_order',
] as const;
export type PatchableField =
  | (typeof PATCHABLE_FIELDS)[number]
  | (typeof EASY_EDIT_FIELDS)[number]
  | 'presentation_order';
export type ItemPatch = Partial<Pick<BoardItem, PatchableField>>;

export interface ItemMutation {
  id: string;
  expected_updated_at: string;
  patch: ItemPatch;
}

interface CmdRow {
  id: string;
  patch: ItemPatch;
  /** `updated_at` of the assumed from-state — null skips the stale
   *  check (e.g. first transition of a row with no timestamp). */
  fromTs: string | null;
}

export interface BoardCommand {
  label: string;
  undo: CmdRow[];
  redo: CmdRow[];
}

export type HistoryPlan =
  | { ok: true; mutations: ItemMutation[] }
  | { ok: false; conflictId: string };

function pick(item: BoardItem, fields: readonly PatchableField[]): ItemPatch {
  const patch: ItemPatch = {};
  for (const f of fields) {
    (patch as Record<string, unknown>)[f] = item[f];
  }
  return patch;
}

function tsOf(rows: BoardItem[], id: string): string | null {
  return rows.find((r) => r.id === id)?.updated_at ?? null;
}

function planFor(rows: CmdRow[], current: Map<string, BoardItem>): HistoryPlan {
  const mutations: ItemMutation[] = [];
  for (const row of rows) {
    const cur = current.get(row.id);
    if (!cur) return { ok: false, conflictId: row.id };
    if (row.fromTs != null && cur.updated_at !== row.fromTs) {
      return { ok: false, conflictId: row.id };
    }
    // No durable timestamp = nothing to fence on — refuse rather than
    // issue an unfenced write.
    if (cur.updated_at == null) return { ok: false, conflictId: row.id };
    mutations.push({
      id: row.id,
      expected_updated_at: cur.updated_at,
      patch: row.patch,
    });
  }
  return { ok: true, mutations };
}

export function makeCommand(
  label: string,
  before: BoardItem[],
  after: BoardItem[],
  fields: readonly PatchableField[] = PATCHABLE_FIELDS,
): BoardCommand {
  return {
    label,
    undo: before.map((b) => ({
      id: b.id,
      patch: pick(b, fields),
      fromTs: tsOf(after, b.id),
    })),
    redo: after.map((a) => ({
      id: a.id,
      patch: pick(a, fields),
      fromTs: tsOf(before, a.id),
    })),
  };
}

/** Creating an item is undone by discarding it — the "before" row is
 *  the created row with `status: 'discarded'`, fenced on the create
 *  response's timestamp; redo restores the created status. */
export function makeCreateCommand(created: BoardItem): BoardCommand {
  const undid: BoardItem = { ...created, status: 'discarded' };
  return makeCommand('create', [undid], [created]);
}

export class CommandHistory {
  private undoStack: BoardCommand[] = [];
  private redoStack: BoardCommand[] = [];
  constructor(private limit = 100) {}

  push(cmd: BoardCommand): void {
    if (cmd.undo.length === 0 && cmd.redo.length === 0) return;
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Forget commands referencing rows that vanished remotely. */
  dropReferences(ids: Set<string>): void {
    const has = (c: BoardCommand) =>
      [...c.undo, ...c.redo].some((r) => ids.has(r.id));
    this.undoStack = this.undoStack.filter((c) => !has(c));
    this.redoStack = this.redoStack.filter((c) => !has(c));
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  /** Plan an undo/redo against the current durable rows. On success the
   *  caller issues `mutations`; on server 409 nothing was popped, so
   *  re-reading and retrying stays possible. */
  planUndo(current: Map<string, BoardItem>): HistoryPlan {
    const cmd = this.undoStack.at(-1);
    if (!cmd) return { ok: false, conflictId: '' };
    return planFor(cmd.undo, current);
  }

  planRedo(current: Map<string, BoardItem>): HistoryPlan {
    const cmd = this.redoStack.at(-1);
    if (!cmd) return { ok: false, conflictId: '' };
    return planFor(cmd.redo, current);
  }

  /** Acknowledge a successful write; `rows` = the server-returned rows
   *  (their timestamps become the next transition's fences). */
  commitUndo(rows: BoardItem[]): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    const ts = (id: string) =>
      rows.find((r) => r.id === id)?.updated_at ?? null;
    this.redoStack.push({
      label: cmd.label,
      undo: cmd.undo,
      redo: cmd.redo.map((r) => ({ ...r, fromTs: ts(r.id) })),
    });
  }

  commitRedo(rows: BoardItem[]): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    const ts = (id: string) =>
      rows.find((r) => r.id === id)?.updated_at ?? null;
    this.undoStack.push({
      label: cmd.label,
      undo: cmd.undo.map((r) => ({ ...r, fromTs: ts(r.id) })),
      redo: cmd.redo,
    });
  }
}
