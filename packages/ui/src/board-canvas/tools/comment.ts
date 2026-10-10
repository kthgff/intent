/**
 * tools/comment.ts — comment-pin helpers (BOARD-CANVAS-TOOLS-TDD §2.3).
 *
 * A comment is a durable `board_items` row: `kind='feedback'` +
 * `note_kind='comment'`, `ref` = the target item it was dropped on
 * (null = free-standing), `note_status` drives resolve
 * (open → resolved; resolved pins stay, never delete). Threads are
 * derived — every comment sharing a `ref` target forms that target's
 * thread; a free-standing comment is its own thread.
 */
import type { BoardItem } from '@veto/core';

export const isCommentItem = (i: BoardItem): boolean =>
  i.kind === 'feedback' && i.note_kind === 'comment' && i.status !== 'discarded';

/** Thread key: the target item id when attached, else the comment's
 *  own id (a free-standing pin is a thread of one). */
export const threadKeyOf = (i: BoardItem): string => i.ref ?? i.id;

/** Threads keyed by `threadKeyOf`, comments in creation order. */
export function commentThreads(
  items: BoardItem[],
): Map<string, BoardItem[]> {
  const map = new Map<string, BoardItem[]>();
  for (const i of items.filter(isCommentItem)) {
    const key = threadKeyOf(i);
    map.set(key, [...(map.get(key) ?? []), i]);
  }
  for (const list of map.values()) {
    list.sort((a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    );
  }
  return map;
}

/** Open (unresolved) comments in a thread — the pin badge counts
 *  only these; resolved entries stay readable inside the popover. */
export function openComments(thread: BoardItem[]): BoardItem[] {
  return thread.filter((c) => c.note_status !== 'resolved');
}
