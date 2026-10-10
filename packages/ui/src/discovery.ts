/**
 * Discovery helpers (S-15/S-16/S-19/S-20 + the §15.9 wizard surface).
 *
 * Pure module — screens render the result, tests drive it directly.
 * Display rules only: the server is authoritative for lifecycle
 * legality (statement decides, slot transitions, item mutations all
 * fail closed server-side).
 */
import type {
  BoardItem,
  InterviewSessionRow,
  KnowledgeSlotRow,
  StatementRow,
} from '@veto/core';

// ---------- typed-sticky taxonomy (§15.3, wp-144 note_kinds) ----------

export interface NoteKindMeta {
  label: string;
  icon: string;
  /** Sticky colour class — `note-<key>` (styles.css). */
  color: string;
}

export const NOTE_KIND_META: Record<string, NoteKindMeta> = {
  idea: { label: 'Idea', icon: '💡', color: 'yellow' },
  want: { label: 'Want', icon: '◎', color: 'blue' },
  avoid: { label: 'Avoid', icon: '⊘', color: 'red' },
  problem: { label: 'Problem', icon: '⚠', color: 'orange' },
  constraint: { label: 'Constraint', icon: '▣', color: 'purple' },
  question: { label: 'Question', icon: '?', color: 'pink' },
  decision: { label: 'Decision', icon: '⚖', color: 'green' },
  feedback: { label: 'Feedback', icon: '↩', color: 'blue' },
  comment: { label: 'Comment', icon: '💬', color: 'blue' },
};

export function noteKindMeta(kind: string | null | undefined): NoteKindMeta {
  return (
    NOTE_KIND_META[kind ?? ''] ?? {
      label: kind ?? 'note',
      icon: '◦',
      color: 'yellow',
    }
  );
}

export const IMPORTANCE_LABEL: Record<string, string> = {
  must: 'must',
  should: 'should',
  nice: 'nice',
  undecided: '·',
};

// ---------- canvas grouping (S-16 lane/type grouping) ----------

export type CanvasGrouping = 'zone' | 'type' | 'status' | 'none';

export interface CanvasLane {
  key: string;
  label: string;
  items: BoardItem[];
}

const TYPE_ORDER = [
  'problem',
  'constraint',
  'want',
  'idea',
  'question',
  'decision',
  'avoid',
  'feedback',
];

/**
 * Group canvas items into lanes. `zone` uses the item's zone frame
 * (unzoned → "loose"); `type` groups by the typed-sticky taxonomy in
 * taxonomy order; `status` groups by the note lifecycle. Zones that
 * exist as `kind=zone` items are excluded from item lanes.
 */
export function groupCanvasItems(
  items: BoardItem[],
  mode: CanvasGrouping,
): CanvasLane[] {
  const notes = items.filter((i) => i.kind !== 'zone');
  if (mode === 'none') {
    return [{ key: 'all', label: 'All items', items: notes }];
  }
  const keyFor = (i: BoardItem): string => {
    if (mode === 'zone') return i.zone ?? 'loose';
    if (mode === 'type') return i.note_kind ?? 'untyped';
    return i.note_status ?? 'open';
  };
  const lanes = new Map<string, BoardItem[]>();
  for (const i of notes) {
    const k = keyFor(i);
    lanes.set(k, [...(lanes.get(k) ?? []), i]);
  }
  const order =
    mode === 'type'
      ? (a: string, b: string) => {
          const ia = TYPE_ORDER.indexOf(a);
          const ib = TYPE_ORDER.indexOf(b);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        }
      : (a: string, b: string) => a.localeCompare(b);
  return [...lanes.keys()].sort(order).map((key) => ({
    key,
    label:
      mode === 'type'
        ? (noteKindMeta(key === 'untyped' ? null : key).label ?? 'untyped')
        : key === 'loose'
          ? 'Loose (no zone)'
          : key,
    items: lanes.get(key) ?? [],
  }));
}

/** A card the canvas dims — consumed/frozen are supersede-only. */
export function isConsumedItem(item: BoardItem): boolean {
  return item.status === 'consumed' || item.status === 'frozen';
}

// ---------- Quick Capture type guess (S-19 "one-tap correction") ----

/**
 * Heuristic kind guess for a capture — deliberately cheap and ALWAYS
 * user-correctable (s-19: type is guessed, not required).
 */
export function guessCaptureKind(text: string): string {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return 'idea';
  if (t.includes('?')) return 'question';
  if (/^https?:\/\//.test(t)) return 'idea'; // links still land as notes
  if (/\b(must|never|only|at most|required|required to)\b/.test(t)) {
    return 'constraint';
  }
  if (/\b(avoid|don't|do not|no more|stop)\b/.test(t)) return 'avoid';
  if (/\b(bug|broken|slow|fails?|error|crash|regression|incident)\b/.test(t)) {
    return 'feedback';
  }
  if (/\b(slow|hard|pain|takes too long|problem|issue)\b/.test(t)) {
    return 'problem';
  }
  if (/\b(decided|decision|we chose|agreed)\b/.test(t)) return 'decision';
  if (/\b(want|wish|need|should have|would be nice)\b/.test(t)) {
    return 'want';
  }
  return 'idea';
}

// ---------- wizard surface (§15.9) ----------

export type InputMode = 'conversation' | 'guided' | 'bulk';

export const INPUT_MODES: { id: InputMode; label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'guided', label: 'Guided choices' },
  { id: 'bulk', label: 'Bulk paste' },
];

/** Slot-progress chips — state chips, never a percentage (§15.9). */
export const SLOT_STATE_LABEL: Record<string, string> = {
  known: 'known',
  inferred: 'inferred',
  missing: 'missing',
  conflicted: 'conflicted',
  'not-applicable': 'n/a',
  deferred: 'deferred',
};

export function slotStateLabel(slot: KnowledgeSlotRow): string {
  return SLOT_STATE_LABEL[slot.state] ?? slot.state;
}

/**
 * "Why this question" provenance — the planner's scores + target slot.
 * Server-recorded on the candidate; the UI renders, never derives.
 */
export function questionWhy(q: {
  slot?: string | null | undefined;
  scores?: Record<string, unknown> | null | undefined;
}): string {
  const scores = (q.scores ?? {}) as Record<string, unknown>;
  const purpose = typeof scores.purpose === 'string' ? scores.purpose : 'fill';
  const bits = [
    `targets slot '${q.slot ?? '?'}' (${purpose})`,
    `impact ${fmtScore(scores.impact)}`,
    `uncertainty ${fmtScore(scores.uncertainty)}`,
    `relevance ${fmtScore(scores.relevance)}`,
    `answerability ${fmtScore(scores.answerability)}`,
    `effort ${fmtScore(scores.effort)}`,
  ];
  return bits.join(' · ');
}

function fmtScore(v: unknown): string {
  return typeof v === 'number' ? v.toFixed(1) : '—';
}

/**
 * Split bulk-paste input into answers — one non-empty line per answer
 * (blank lines skipped; `#`/`//` comment lines skipped). Bulk mode
 * feeds the SAME session state — each line is an answer turn.
 */
export function splitBulkAnswers(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));
}

/** Statement provenance one-liner for the popover (Understanding
 *  Panel + board inspector). */
export function statementProvenance(s: StatementRow): string {
  const ref = s.source_ref as { kind?: string; id?: string } | null;
  const where = ref?.id ? `${ref.kind ?? 'ref'}:${ref.id}` : 'no source ref';
  const who = s.created_by ?? 'unknown';
  const run = s.extraction_run ? ` · run ${s.extraction_run}` : '';
  return `v${s.version} · ${s.provenance ?? 'untracked'} · ${where} · by ${who}${run}`;
}

/** Resume briefing lines for the modal ("what changed since you left"). */
export function briefingLines(b: {
  summary: string;
  changed_slots: { slot: string; from: string | null; to: string }[];
  new_messages: unknown[];
}): string[] {
  const out: string[] = [b.summary];
  for (const c of b.changed_slots) {
    out.push(`slot ${c.slot}: ${c.from ?? 'none'} → ${c.to}`);
  }
  if (b.new_messages.length > 0) {
    out.push(`${b.new_messages.length} new message(s)`);
  }
  return out;
}

export function sessionTitle(s: InterviewSessionRow): string {
  return s.subject ? `${s.subject}` : (s.session_id ?? '');
}
