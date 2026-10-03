import type { Finding, FindingSeverity } from '@sprint-runner/core';
/**
 * S-08 — code review page: findings list w/ severity filter, verdict
 * buttons (accept/dismiss/wontfix), approve→open PR / send back.
 * Findings come from review.json — surfaced via ticket events/refs and
 * the triage projection; the API exposes verdict writes, so the UI
 * fetches the review payload embedded in ticket detail when present.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { client } from '../api';
import { Empty, ErrorBox, Loading, StatusBadge } from '../components';
import { useLoad, useStreamRefresh } from '../hooks';

const SEVS: FindingSeverity[] = [
  'blocker',
  'major',
  'minor',
  'nit',
  'question',
];

interface ReviewLike {
  findings?: Finding[];
  round?: number;
  passes?: string[];
}

export default function CodeReview() {
  const { ws = '', id = '' } = useParams();
  const navigate = useNavigate();
  const detail = useLoad(() => client.ticket(ws, id), [ws, id]);
  const events = useLoad(() => client.ticketEvents(ws, id), [ws, id]);
  useStreamRefresh(detail.reload, ['run_status', 'gate_cleared']);
  const [sevFilter, setSevFilter] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // review.json isn't directly exposed; triage/events may carry the
  // review payload in event data — pull the newest one that has
  // findings (fail-soft: empty list when absent).
  const review: ReviewLike | null = useMemo(() => {
    const evs = events.data?.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const data = evs[i]?.data as Record<string, unknown> | undefined;
      const r = data?.review as ReviewLike | undefined;
      if (r?.findings) return r;
    }
    const tri = detail.data?.triage as unknown as ReviewLike | null;
    return tri?.findings ? tri : null;
  }, [events.data, detail.data]);

  const findings = useMemo(
    () =>
      (review?.findings ?? []).filter(
        (f) => !sevFilter || f.severity === sevFilter,
      ),
    [review, sevFilter],
  );

  const t = detail.data?.ticket;

  const doVerdict = async (fid: string, verdict: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.verdict(ws, id, fid, verdict);
      await Promise.all([detail.reload(), events.reload()]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await client.action(ws, id, {
        action,
        expected_status: t?.status,
        ...extra,
      });
      navigate(`/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!t) return <Empty />;

  return (
    <section>
      <h1 className="page-title">Code review — {id}</h1>
      <p className="page-sub">
        <Link to={`/tickets/${ws}/${id}`}>← ticket</Link> ·{' '}
        <StatusBadge status={t.status} /> ·{' '}
        {review?.round != null ? `round ${review.round}` : 'round —'}
      </p>
      {error != null && <ErrorBox error={error} />}

      <div className="counters" style={{ marginBottom: 12 }}>
        <div className="counter">
          <div className="v">{review?.findings?.length ?? 0}</div>
          <div className="k">findings</div>
        </div>
        <div className="counter">
          <div className="v">
            {review?.findings?.filter((f) => f.status === 'open').length ?? 0}
          </div>
          <div className="k">open</div>
        </div>
        <div className="counter">
          <div className="v">{detail.data?.repos.length ?? 0}</div>
          <div className="k">repos</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 10 }}>
        <select
          aria-label="severity filter"
          style={{ width: 'auto' }}
          value={sevFilter}
          onChange={(e) => setSevFilter(e.target.value)}
        >
          <option value="">all severities</option>
          {SEVS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act('open_pr')}
        >
          Approve → open PR
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void act('send_back', { to: 'in-progress' })}
        >
          Send back to fix
        </button>
      </div>

      {findings.length === 0 && (
        <Empty label="No findings (or review.json not surfaced yet)." />
      )}
      {findings.map((f) => (
        <div className="card" key={f.thread_id}>
          <div className="card-title">
            <span
              className={`badge spec-${f.severity === 'blocker' || f.severity === 'major' ? 'bad' : 'warn'}`}
            >
              {f.severity}
            </span>
            <span className="badge">{f.category}</span>
            <span className="badge">{f.kind}</span>
            <span className="mono muted">
              {f.repo}:{f.file}:{f.line}
            </span>
            <StatusBadge status={f.status} />
            <span className="spacer" />
            {f.status === 'open' && (
              <>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => void doVerdict(f.thread_id, 'accept')}
                >
                  accept
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => void doVerdict(f.thread_id, 'dismiss')}
                >
                  dismiss
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => void doVerdict(f.thread_id, 'wontfix')}
                >
                  wontfix
                </button>
              </>
            )}
          </div>
          <p>{f.body}</p>
          {f.suggested_fix && (
            <p className="muted">suggested fix: {f.suggested_fix}</p>
          )}
          {f.replies.map((r) => (
            <div key={`${r.ts}-${r.actor}`} className="card-meta">
              {r.actor} @ {r.ts.slice(0, 16)}: {r.body}
            </div>
          ))}
        </div>
      ))}

      <h2 className="group-title">Per-repo state</h2>
      {(detail.data?.repos ?? []).map((r) => (
        <div className="card" key={r.repo}>
          <div className="card-title">
            <strong>{r.repo}</strong>
            <span className="mono muted">{r.branch ?? '—'}</span>
            {r.pr_url && (
              <a href={r.pr_url} rel="noreferrer">
                PR ↗
              </a>
            )}
            <span className="badge">ci: {r.ci_state ?? '—'}</span>
            <span className="badge">pr: {r.pr_state ?? '—'}</span>
          </div>
        </div>
      ))}
    </section>
  );
}
