/**
 * SSE client for `GET /api/v1/stream` (API.md live channel).
 *
 * ONE EventSource per client — a module-level singleton shared by the
 * app shell and every screen. EventSource cannot set headers — auth
 * rides the `sr_session` cookie established by the `?token=` bootstrap
 * (same-origin, sent by default). The stream is a latency
 * optimization: every fact is also durable, so subscribers re-read
 * state on (re)connect — no replay protocol.
 */
import type { GateItem, Notification, RunRow } from '@sprint-runner/core';
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
    typeof document === 'undefined' || document.cookie.includes('sr_session');
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
