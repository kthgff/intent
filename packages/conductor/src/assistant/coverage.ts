/**
 * assistant/coverage.ts — deterministic board coverage + the
 * `/critique` checks (TDD "Skills" + "Board wizard configs").
 *
 * Everything here is pure: no LLM, no store access — callers pass
 * board items (+ connectors + open decision ids) in. `serves` edges
 * are the canonical goal wiring (D33 spec-gap rule: an item is a goal
 * iff it is some item's serves target).
 */
import type { BoardConnector, BoardItem, NoteKind } from '@veto/core';
import { activeItems, servesTargetIds } from './types.js';

export interface CoverageReport {
  /** Active cards on the canvas (zones/connectors excluded). */
  total: number;
  /** Active items carrying a note_kind. */
  typed: number;
  /** Active content items with no serves edge out, no incoming serve,
   *  and no connector touch. */
  orphans: number;
  /** `question` notes still `open`. */
  open_questions: number;
  /** Items that are serves targets (the goal population). */
  goals: number;
  /** statement_decisions still open against this board's slots. */
  open_decisions: number;
  by_note_kind: Record<string, number>;
}

const CONTENT_KINDS = new Set(['note', 'text', 'link']);

export function boardCoverage(
  items: BoardItem[],
  connectors: BoardConnector[] = [],
  openDecisions: string[] = [],
): CoverageReport {
  const items_ = activeItems(items);
  const content = items_.filter((i) => CONTENT_KINDS.has(i.kind));
  const goals = servesTargetIds(items_);
  const connected = new Set<string>();
  for (const c of connectors) {
    if (c.status !== 'active') continue;
    connected.add(c.source_item_id);
    connected.add(c.target_item_id);
  }
  const by_note_kind: Record<string, number> = {};
  for (const i of items_) {
    if (i.note_kind)
      by_note_kind[i.note_kind] = (by_note_kind[i.note_kind] ?? 0) + 1;
  }
  return {
    total: content.length,
    typed: content.filter((i) => i.note_kind != null).length,
    orphans: content.filter(
      (i) =>
        (i.serves?.length ?? 0) === 0 &&
        !goals.has(i.id) &&
        !connected.has(i.id),
    ).length,
    open_questions: content.filter(
      (i) => i.note_kind === 'question' && (i.note_status ?? 'open') === 'open',
    ).length,
    goals: items_.filter((i) => goals.has(i.id)).length,
    open_decisions: openDecisions.length,
    by_note_kind,
  };
}

export type CritiqueKind =
  | 'vague'
  | 'untyped'
  | 'orphan'
  | 'unanswered-question'
  | 'missing-kind'
  | 'no-goals'
  | 'open-decision';

export interface CritiqueFinding {
  kind: CritiqueKind;
  /** The offending card, when the finding is item-scoped. */
  item_id?: string;
  detail: string;
}

/** A note is "vague" when its total text is too thin to act on. */
const VAGUE_CHARS = 24;

/** Shared required coverage — mirrors the wp-163 wizard's required
 *  slots (kept structural here: a finding fires only when the whole
 *  kind is absent, never on per-card guesses). */
const REQUIRED_NOTE_KINDS: NoteKind[] = ['problem', 'want', 'constraint'];

/**
 * `/critique` — the deterministic findings (TDD "Skills"). LLM
 * findings may augment the list when a provider exists; this function
 * is the guaranteed floor.
 */
export function critiqueChecks(args: {
  items: BoardItem[];
  connectors?: BoardConnector[];
  openDecisions?: string[];
  requiredKinds?: NoteKind[];
}): CritiqueFinding[] {
  const connectors = args.connectors ?? [];
  const items = activeItems(args.items);
  const content = items.filter((i) => CONTENT_KINDS.has(i.kind));
  const goals = servesTargetIds(items);
  const connected = new Set<string>();
  for (const c of connectors) {
    if (c.status !== 'active') continue;
    connected.add(c.source_item_id);
    connected.add(c.target_item_id);
  }

  const findings: CritiqueFinding[] = [];
  for (const i of content) {
    const text = `${i.title ?? ''} ${i.body ?? ''}`.trim();
    if (text.length > 0 && text.length < VAGUE_CHARS) {
      findings.push({
        kind: 'vague',
        item_id: i.id,
        detail: `"${(i.title ?? i.body ?? '').slice(0, 60)}" is too thin to act on — add detail or drop it`,
      });
    }
    if (i.kind === 'note' && i.note_kind == null) {
      findings.push({
        kind: 'untyped',
        item_id: i.id,
        detail:
          'untyped note — synthesis needs a kind (want/problem/constraint/…)',
      });
    }
    if (
      (i.serves?.length ?? 0) === 0 &&
      !goals.has(i.id) &&
      !connected.has(i.id)
    ) {
      findings.push({
        kind: 'orphan',
        item_id: i.id,
        detail: `"${(i.title ?? i.body ?? i.id).slice(0, 60)}" touches nothing — wire it to a goal or it won't reach synthesis`,
      });
    }
    if (i.note_kind === 'question' && (i.note_status ?? 'open') === 'open') {
      findings.push({
        kind: 'unanswered-question',
        item_id: i.id,
        detail: `"${(i.title ?? i.body ?? '').slice(0, 60)}" is still open`,
      });
    }
  }

  for (const kind of args.requiredKinds ?? REQUIRED_NOTE_KINDS) {
    if (!content.some((i) => i.note_kind === kind)) {
      findings.push({
        kind: 'missing-kind',
        detail: `no \`${kind}\` items — the board can't synthesize without this coverage`,
      });
    }
  }
  if (items.filter((i) => goals.has(i.id)).length === 0) {
    findings.push({
      kind: 'no-goals',
      detail:
        'no goal item yet — nothing is a `serves` target; /interview starts there',
    });
  }
  for (const id of args.openDecisions ?? []) {
    findings.push({
      kind: 'open-decision',
      detail: `open decision ${id} — a ruling resolves the conflict`,
    });
  }
  return findings;
}
