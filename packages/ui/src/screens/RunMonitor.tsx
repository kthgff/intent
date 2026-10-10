import type { RunRow } from '@veto/core';
/**
 * S-07 — live run monitor. RunsList = registry; RunMonitor = transcript
 * tail via SSE `run_output`, live usage via `usage_partial`, kill /
 * pause / resume controls.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { client } from '../api';
import {
  ConfirmDialog,
  Empty,
  ErrorBox,
  Loading,
  StatusBadge,
  fmtTokens,
} from '../components';
import { useLoad, useRunOutput, useStreamRefresh } from '../hooks';
import { projectPath, useProject } from '../project';
import { subscribeStream } from '../sse';

/** Statuses where pause/kill make sense — never on a finished run. */
const LIVE_RUN = new Set(['pending', 'leased', 'running', 'paused']);

export function RunsList() {
  const ws = useProject();
  const [status, setStatus] = useState('');
  const state = useLoad(
    () => client.runs({ workspace: ws, ...(status ? { status } : {}) }),
    [ws, status],
  );
  useStreamRefresh(state.reload, ['run_status']);
  return (
    <section className="runs-list-screen">
      <h1 className="page-title">Runs</h1>
      <p className="page-sub">Detached agent runs watched by the conductor.</p>
      <div className="row screen-toolbar runs-toolbar">
        <select
          aria-label="status filter"
          className="auto"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">all statuses</option>
          {[
            'pending',
            'running',
            'paused',
            'failed',
            'done',
            'killed',
            'stalled',
          ].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {state.loading && <Loading />}
      {state.error != null && <ErrorBox error={state.error} />}
      {state.data && state.data.runs.length === 0 && (
        <Empty label="No runs match." />
      )}
      {state.data && state.data.runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>run</th>
              <th>subject</th>
              <th>stage</th>
              <th>status</th>
              <th>model</th>
              <th>tokens</th>
            </tr>
          </thead>
          <tbody>
            {state.data.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link
                    className="mono"
                    to={projectPath(ws, `/runs/${encodeURIComponent(r.id)}`)}
                  >
                    {r.id}
                  </Link>
                </td>
                <td className="muted">{r.subject}</td>
                <td>{r.stage}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="muted">{r.model ?? '—'}</td>
                <td
                  className="mono"
                  title={`${r.tokens_in ?? 0} in / ${r.tokens_out ?? 0} out`}
                >
                  {fmtTokens(r.tokens_in)}→{fmtTokens(r.tokens_out)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function RunMonitor() {
  const ws = useProject();
  const { id = '' } = useParams();
  const runId = decodeURIComponent(id);
  const state = useLoad(() => client.run(runId), [runId]);
  const [transcript, setTranscript] = useState('');
  const [live, setLive] = useState<{
    tokens_in: number;
    tokens_out: number;
    tokens_cached: number;
  } | null>(null);
  const [elapsed, setElapsed] = useState('');
  const [opError, setOpError] = useState<unknown>(null);
  const [busyOp, setBusyOp] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  const tailRef = useRef<HTMLPreElement | null>(null);

  useRunOutput(
    runId,
    useCallback((chunk: string) => {
      setTranscript((t) => t + chunk);
      requestAnimationFrame(() => {
        if (followRef.current)
          tailRef.current?.scrollTo(0, tailRef.current.scrollHeight);
      });
    }, []),
  );

  useStreamRefresh(state.reload, ['run_status']);
  // live usage counters via the shared stream (usage_partial)
  useEffect(
    () =>
      subscribeStream({
        onEvent: (type, payload) => {
          if (type !== 'usage_partial') return;
          const p = payload as {
            run_id: string;
            tokens_in: number;
            tokens_out: number;
            tokens_cached: number;
          };
          if (p.run_id === runId) {
            setLive({
              tokens_in: p.tokens_in,
              tokens_out: p.tokens_out,
              tokens_cached: p.tokens_cached,
            });
          }
        },
      }),
    [runId],
  );

  // elapsed ticker
  const startedAt = state.data?.run.started_at ?? null;
  const exitedAt = state.data?.run.exited_at ?? null;
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const end = exitedAt ? new Date(exitedAt).getTime() : Date.now();
      const s = Math.max(
        0,
        Math.floor((end - new Date(startedAt).getTime()) / 1000),
      );
      setElapsed(`${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startedAt, exitedAt]);

  const run = state.data?.run;
  const isLive = run ? LIVE_RUN.has(run.status) : false;
  const op = async (o: 'kill' | 'pause' | 'resume') => {
    if (busyOp) return;
    setBusyOp(true);
    setOpError(null);
    try {
      await client.runOp(runId, o);
      state.reload();
    } catch (e) {
      setOpError(e);
    } finally {
      setBusyOp(false);
    }
  };

  return (
    <section className="run-monitor-screen">
      <p className="page-sub" style={{ marginBottom: 2 }}>
        <Link to={projectPath(ws, '/runs')}>← runs</Link>
      </p>
      <h1 className="page-title mono">{runId}</h1>
      {state.loading && <Loading />}
      {state.error != null && <ErrorBox error={state.error} />}
      {opError != null && <ErrorBox error={opError} />}
      {run && (
        <>
          <div className="row run-header-bar">
            <StatusBadge status={run.status} />
            <span className="muted">
              {run.stage} · {run.backend ?? '?'} ·{' '}
              {run.model ?? 'default model'} · attempt {run.attempt}
            </span>
            {run.ticket_id && (
              <Link
                to={projectPath(run.workspace, `/tickets/${run.ticket_id}`)}
              >
                {run.ticket_id}
              </Link>
            )}
            <span className="spacer" />
            <span className="muted">{elapsed}</span>
            {isLive && (
              <>
                <button
                  type="button"
                  className="small"
                  disabled={busyOp}
                  onClick={() =>
                    void op(run.status === 'paused' ? 'resume' : 'pause')
                  }
                >
                  {run.status === 'paused' ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  className="small danger"
                  disabled={busyOp}
                  onClick={() => setConfirmKill(true)}
                >
                  Kill
                </button>
              </>
            )}
          </div>
          {run.worktree && (
            <p className="muted mono" style={{ marginTop: -6 }}>
              worktree: {run.worktree}
            </p>
          )}
          {!isLive && (run.sentinel ?? run.sentinel_raw) && (
            <output className="warn-banner">
              {run.sentinel ?? run.sentinel_raw}
            </output>
          )}
          <div className="counters run-counters">
            <Counter
              label="tokens in"
              value={live?.tokens_in ?? run.tokens_in}
            />
            <Counter
              label="tokens out"
              value={live?.tokens_out ?? run.tokens_out}
            />
            <Counter
              label="cached"
              value={live?.tokens_cached ?? run.tokens_cached}
            />
            <Counter
              label="cost"
              value={run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '—'}
              raw
            />
          </div>
          <h2 className="group-title">
            Transcript tail{' '}
            <label className="muted small" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => {
                  setFollow(e.target.checked);
                  if (e.target.checked)
                    requestAnimationFrame(() =>
                      tailRef.current?.scrollTo(
                        0,
                        tailRef.current.scrollHeight,
                      ),
                    );
                }}
              />{' '}
              follow
            </label>
          </h2>
          <pre
            className="terminal"
            ref={tailRef}
            role="log"
            aria-live="off"
            onScroll={() => {
              const el = tailRef.current;
              if (!el) return;
              // Scrolling up pauses follow; hitting bottom re-arms it.
              const atBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 12;
              if (atBottom !== follow) setFollow(atBottom);
            }}
          >
            {transcript ||
              (isLive
                ? '(waiting for run_output chunks…)'
                : '(run ended — no transcript captured)')}
          </pre>
          <h2 className="group-title">Artifacts</h2>
          {(state.data?.artifacts ?? []).length === 0 ? (
            <Empty label="No artifacts listed." />
          ) : (
            <ul className="mono">
              {state.data?.artifacts.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {!run && !state.loading && !state.error && <Empty />}
      {confirmKill && (
        <ConfirmDialog
          title={`Kill run ${runId}?`}
          body="Sends SIGTERM to the agent process — the run ends as killed and the ticket surfaces a failure gate."
          confirmLabel="Kill run"
          danger
          busy={busyOp}
          onConfirm={() => {
            setConfirmKill(false);
            void op('kill');
          }}
          onCancel={() => setConfirmKill(false)}
        />
      )}
    </section>
  );
}

function Counter({
  label,
  value,
  raw,
}: {
  label: string;
  value: number | string | null | undefined;
  raw?: boolean;
}) {
  return (
    <div className="counter">
      <div className="v">
        {raw ? (value ?? '—') : fmtTokens(value as number | null | undefined)}
      </div>
      <div className="k">{label}</div>
    </div>
  );
}
