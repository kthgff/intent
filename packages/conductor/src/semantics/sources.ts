/**
 * Evidence-source builders (wp-143) — normalize the three evidence
 * kinds (§15.3/§15.9: board items, interview messages, imported text,
 * docs) into {@link ExtractionSource} for the extraction pipeline.
 * The `text` is exactly what `source_ref.span` offsets index into —
 * deterministic concatenation, never reformatted.
 */
import type { BoardItem, InterviewMessageRow } from '@sprint-runner/core';
import type { ExtractionSource } from './types.js';

/** Board item → source. Title and body are both evidence; joined with
 *  a blank line so spans over the joined text stay meaningful. */
export function sourceFromBoardItem(item: BoardItem): ExtractionSource {
  const title = item.title ?? '';
  const body = item.body ?? '';
  const text =
    title.length > 0 && body.length > 0
      ? `${title}\n\n${body}`
      : title.length > 0
        ? title
        : body;
  return { ref: { kind: 'board-item', id: item.id }, text };
}

/** Interview transcript row → source. `id` = `<session>#<seq>` — the
 *  durable transcript address (interview_messages PK). */
export function sourceFromInterviewMessage(
  msg: InterviewMessageRow,
): ExtractionSource {
  return {
    ref: { kind: 'interview-message', id: `${msg.session_id}#${msg.seq}` },
    text: msg.content,
  };
}

/** A persisted doc version → source. `id` = `<subject>:<doc>` (the
 *  doc_versions address minus version — the version lives on the
 *  artifact link, not the evidence ref). */
export function sourceFromDoc(
  subject: string,
  doc: string,
  content: string,
): ExtractionSource {
  return { ref: { kind: 'doc', id: `${subject}:${doc}` }, text: content };
}

/** Imported text (ticket body, external note, bulk paste) → source. */
export function sourceFromImport(key: string, text: string): ExtractionSource {
  return { ref: { kind: 'import', id: key }, text };
}
