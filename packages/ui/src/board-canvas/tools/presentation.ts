/**
 * tools/presentation.ts — frame-presentation ordering (TOOLS-TDD §2.5).
 *
 * Zones carry an optional durable `presentation_order`; present mode
 * steps through *ordered* zones only — unordered frames are skipped
 * entirely rather than guessing a position for them.
 */
import type { BoardItem } from '@veto/core';

/** Ordered presentation slides: zone items with a non-null
 *  `presentation_order`, sorted by it (ties break on stable id). */
export function orderedZones(items: BoardItem[]): BoardItem[] {
  return items
    .filter(
      (i) =>
        i.kind === 'zone' &&
        i.status !== 'discarded' &&
        i.presentation_order != null,
    )
    .sort(
      (a, b) =>
        (a.presentation_order as number) - (b.presentation_order as number) ||
        a.id.localeCompare(b.id),
    );
}
