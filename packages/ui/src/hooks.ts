/**
 * Small shared hooks — data loading + per-screen SSE subscriptions on
 * the single shared stream (sse.ts singleton).
 */
import { useEffect, useRef, useState } from 'react';
import type { StreamEventType } from './sse';
import { subscribeStream } from './sse';

/** Load-state tuple used by every list/detail view. */
export interface LoadState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = () => {
    const n = ++seq.current;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (seq.current === n) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (seq.current === n) setError(e);
      })
      .finally(() => {
        if (seq.current === n) setLoading(false);
      });
  };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => reloadRef.current(), deps);
  return { data, error, loading, reload };
}

/** Subscribe a screen to stream event types; `refresh` also fires on
 *  reconnect (durable state re-read). */
export function useStreamRefresh(
  refresh: () => void,
  types: StreamEventType[],
): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  const key = types.join(',');
  useEffect(
    () =>
      subscribeStream({
        onOpen: () => ref.current(),
        onEvent: (type) => {
          if (key.split(',').includes(type)) ref.current();
        },
      }),
    [key],
  );
}

/** run_output chunks for one run id (S-07 transcript tail). */
export function useRunOutput(
  runId: string | null,
  onChunk: (chunk: string) => void,
): void {
  const ref = useRef(onChunk);
  ref.current = onChunk;
  useEffect(() => {
    if (!runId) return;
    return subscribeStream({
      onEvent: (type, payload) => {
        if (type === 'run_output') {
          const p = payload as { run_id: string; chunk?: string };
          if (p.run_id === runId && p.chunk) ref.current(p.chunk);
        }
      },
    });
  }, [runId]);
}
