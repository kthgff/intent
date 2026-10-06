/**
 * SSE client for `GET /api/v1/stream` (API.md live channel).
 *
 * ONE EventSource per client — a module-level singleton shared by the
 * app shell and every screen. EventSource cannot set headers — auth
 * rides the `veto_session` cookie established by the `?token=` bootstrap
 * (same-origin, sent by default). The stream is a latency
 * optimization: every fact is also durable, so subscribers re-read
 * state on (re)connect — no replay protocol.
 */
import type { EventRow, GateItem, Notification, RunRow } from '@veto/core';
import { getToken } from './api';

export type StreamEventMap = {
  gate_surfaced: GateItem;
  gate_cleared: GateItem;
  run_status: Partial<RunRow> & { id: string };
  run_output: { run_id: string; chunk: string };
  usage_partial: {
    run_id: string;
    tokens_in: number;
    tokens_out: number;
    tokens_cached: number;
  };
  notification: Notification;
  /** A `tickets` row changed — refresh hint for board/focus (s-01). */
  ticket_updated: { workspace: string; ticket_id: string; status?: string };
  /** Interview Orchestrator session state changed (wp-147) — the
   *  Understanding Panel / wizard surface refresh hint. */
  interview_updated: { workspace: string; session_id: string | null };
  // DELIVERY §5 (wp-136) — durable events mirrored onto the stream;
  // payload is the appended `events` row.
  merge_ready: EventRow;
  merge_attempted: EventRow;
  merge_conflict: EventRow;
  release_created: EventRow;
  release_items_changed: EventRow;
  manifest_cut: EventRow;
  release_approved: EventRow;
  release_released: EventRow;
  deployment_confirmed: EventRow;
  feature_exposed: EventRow;
  release_note_approved: EventRow;
  retro_completed: EventRow;
  correction_filed: EventRow;
  dependent_revalidated: EventRow;
};

export type StreamEventType = keyof StreamEventMap;

const STREAM_URL = '/api/v1/stream';
const TYPES: StreamEventType[] = [
  'gate_surfaced',
  'gate_cleared',
  'run_status',
  'run_output',
  'usage_partial',
  'notification',
  'ticket_updated',
  'interview_updated',
  'merge_ready',
  'merge_attempted',
  'merge_conflict',
  'release_created',
  'release_items_changed',
  'manifest_cut',
  'release_approved',
  'release_released',
  'deployment_confirmed',
  'feature_exposed',
  'release_note_approved',
  'retro_completed',
  'correction_filed',
  'dependent_revalidated',
];

export interface StreamHandlers {
  onEvent?: (type: StreamEventType, payload: unknown) => void;
  /** Fires on connect AND reconnect — re-read durable state. */
  onOpen?: () => void;
}

let source: EventSource | null = null;
const handlers = new Set<StreamHandlers>();
let open = false;

function ensureSource(): void {
  if (source) return;
  // Native EventSource sends cookies but not headers — covers the
  // browser/daemon bootstrap. When no cookie exists yet (e.g. webview
  // shell that injects headers on document requests only), append the
  // token as a query param — the conductor may accept it per its
  // bootstrap semantics; cookie auth remains the primary path.
  const token = getToken();
  const hasCookie =
    typeof document === 'undefined' || document.cookie.includes('veto_session');
  const url =
    !hasCookie && token
      ? `${STREAM_URL}?token=${encodeURIComponent(token)}`
      : STREAM_URL;
  source = new EventSource(url);
  source.onopen = () => {
    open = true;
    for (const h of handlers) h.onOpen?.();
  };
  source.onerror = () => {
    open = false;
  };
  for (const type of TYPES) {
    source.addEventListener(type, (e) => {
      let payload: unknown;
      try {
        payload = JSON.parse((e as MessageEvent).data);
      } catch {
        return; /* malformed frame — stream is never the only copy */
      }
      for (const h of handlers) h.onEvent?.(type, payload);
    });
  }
}

/** Subscribe to the shared stream. Returns an unsubscribe function. */
export function subscribeStream(h: StreamHandlers): () => void {
  handlers.add(h);
  ensureSource();
  if (open) queueMicrotask(() => h.onOpen?.());
  return () => {
    handlers.delete(h);
    if (handlers.size === 0 && source) {
      source.close();
      source = null;
      open = false;
    }
  };
}
