import type { Finding, FindingSeverity } from '@veto/core';
/**
 * S-08 — code review page: findings list w/ severity filter, verdict
 * buttons (accept/dismiss/wontfix), approve→open PR / send back.
 * Findings come from review.json — surfaced via ticket events/refs and
 * the triage projection; the API exposes verdict writes, so the UI
 * fetches the review payload embedded in ticket detail when present.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Citation, isCodeRef } from '../Evidence';
import { client } from '../api';
import {
  ConfirmDialog,
  Empty,
  ErrorBox,
  Loading,
  StatusBadge,
  fmtAge,
} from '../components';
import { useLoad, useStreamRefresh } from '../hooks';
import { projectPath } from '../project';

const SEVS: FindingSeverity[] = [
  'blocker',
  'major',
  'minor',
  'nit',
  'question',
];

/** nit/question are noise-level — neutral badge, not amber alarm. */
const SEV_TONE: Record<FindingSeverity, string> = {
  blocker: 'spec-bad',
  major: 'spec-bad',
  minor: 'spec-warn',
  nit: 'spec-dim',
  question: 'spec-dim',
};

interface ReviewLike {
  findings?: Finding[];
  round?: number;
  passes?: string[];
}

export default function CodeReview({
  embedded = false,
}: { embedded?: boolean }) {
  const { ws = '', id = '' } = useParams();
  const navigate = useNavigate();
  const detail = useLoad(() => client.ticket(ws, id), [ws, id]);
  const events = useLoad(() => client.ticketEvents(ws, id), [ws, id]);
  useStreamRefresh(detail.reload, ['run_status', 'gate_cleared']);
  const [sevFilter, setSevFilter] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmPr, setConfirmPr] = useState(false);
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
    setBusyId(fid);
    setError(null);
    try {
      await client.verdict(ws, id, fid, verdict);
      await Promise.all([detail.reload(), events.reload()]);
    } catch (e) {
      setError(e);
    } finally {
      setBusyId(null);
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
      navigate(projectPath(ws, `/tickets/${encodeURIComponent(id)}`));
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
      {!embedded && (
        <>
          <h1 className="page-title">Code review — {id}</h1>
          <p className="page-sub">
            <Link to={projectPath(ws, `/tickets/${id}`)}>← ticket</Link> ·{' '}
            <StatusBadge status={t.status} /> ·{' '}
            {review?.round != null ? `round ${review.round}` : 'round —'}
          </p>
        </>
      )}
      {embedded && (
        <p className="page-sub">
          <StatusBadge status={t.status} /> ·{' '}
          {review?.round != null ? `round ${review.round}` : 'round —'} ·{' '}
          <Link to={projectPath(ws, `/tickets/${id}/review`)}>full view →</Link>
        </p>
      )}
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
          onClick={() => {
            const open =
              review?.findings?.filter((f) => f.status === 'open').length ?? 0;
            if (open > 0) setConfirmPr(true);
            else void act('open_pr');
          }}
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
        {confirmPr && (
          <ConfirmDialog
            title="Open PR with open findings?"
            body={`${
              review?.findings?.filter((f) => f.status === 'open').length ?? 0
            } finding(s) still open — human override is recorded in the ledger.`}
            confirmLabel="Open PR anyway"
            busy={busy}
            onConfirm={() => {
              setConfirmPr(false);
              void act('open_pr');
            }}
            onCancel={() => setConfirmPr(false)}
          />
        )}
      </div>

      {findings.length === 0 && (
        <Empty label="No findings (or review.json not surfaced yet)." />
      )}
      {findings.map((f) => (
        <div className="card" key={f.thread_id}>
          <div className="card-title">
            <span
              className={`badge ${SEV_TONE[f.severity as FindingSeverity] ?? 'spec-dim'}`}
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
                  disabled={busy || busyId === f.thread_id}
                  onClick={() => void doVerdict(f.thread_id, 'accept')}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={busy || busyId === f.thread_id}
                  onClick={() => void doVerdict(f.thread_id, 'dismiss')}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={busy || busyId === f.thread_id}
                  onClick={() => void doVerdict(f.thread_id, 'wontfix')}
                >
                  Won't fix
                </button>
              </>
            )}
          </div>
          <p>{f.body}</p>
          {f.suggested_fix && (
            <p className="muted">suggested fix: {f.suggested_fix}</p>
          )}
          {f.evidence &&
            (isCodeRef(f.evidence) ? (
              <p className="muted">
                <Citation ws={ws} ref={f.evidence} />
              </p>
            ) : (
              <p className="muted">evidence: {f.evidence}</p>
            ))}
          {f.replies.map((r) => (
            <div key={`${r.ts}-${r.actor}`} className="card-meta">
              {r.actor} · <span title={r.ts}>{fmtAge(r.ts)} ago</span>: {r.body}
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
            <span className="badge">CI: {r.ci_state ?? '—'}</span>
            <span className="badge">PR: {r.pr_state ?? '—'}</span>
          </div>
        </div>
      ))}
    </section>
  );
}
