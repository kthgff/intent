/**
 * S-09 — PR status panel: per-repo rows (branch, PR url/state, CI
 * state, merged sha), merge button enabled when all repos are green,
 * revert for merged.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { client } from '../api';
import { Empty, ErrorBox, Loading, StatusBadge } from '../components';
import { useLoad, useStreamRefresh } from '../hooks';

export default function PrPanel() {
  const { ws = '', id = '' } = useParams();
  const navigate = useNavigate();
  const detail = useLoad(() => client.ticket(ws, id), [ws, id]);
  useStreamRefresh(detail.reload, ['run_status', 'gate_cleared']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const t = detail.data?.ticket;
  const repos = detail.data?.repos ?? [];
  const allGreen =
    repos.length > 0 && repos.every((r) => r.ci_state === 'green');
  const allMerged =
    repos.length > 0 && repos.every((r) => r.pr_state === 'merged');

  const act = async (action: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.action(ws, id, {
        action,
        expected_status: t?.status,
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
      <h1 className="page-title">PR status — {id}</h1>
      <p className="page-sub">
        <Link to={`/tickets/${ws}/${id}`}>← ticket</Link> ·{' '}
        <StatusBadge status={t.status} /> — shepherd watches checks + comments
        and feeds fixes back to the agent.
      </p>
      {error != null && <ErrorBox error={error} />}
      {repos.length === 0 && <Empty label="No per-repo rows yet." />}
      {repos.map((r) => (
        <div className="card" key={r.repo}>
          <div className="card-title">
            <strong>{r.repo}</strong>
            <span className="mono muted">{r.branch ?? '—'}</span>
            {r.pr_url ? (
              <a href={r.pr_url} rel="noreferrer">
                PR ↗
              </a>
            ) : (
              <span className="muted">no PR yet</span>
            )}
            <span className="badge">pr: {r.pr_state ?? '—'}</span>
            <span
              className={`badge spec-${
                r.ci_state === 'green'
                  ? 'good'
                  : r.ci_state === 'failing'
                    ? 'bad'
                    : 'warn'
              }`}
            >
              ci: {r.ci_state ?? 'pending'}
            </span>
            {r.merged_sha && (
              <span className="mono muted">
                merged {r.merged_sha.slice(0, 8)}
              </span>
            )}
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="primary"
          disabled={busy || !allGreen || allMerged}
          title={allGreen ? 'merge' : 'waiting for green checks on all repos'}
          onClick={() => void act('merge')}
        >
          Merge
        </button>
        {allMerged && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void act('revert')}
          >
            Revert
          </button>
        )}
      </div>
      {!allGreen && repos.length > 0 && (
        <p className="muted">
          Merge unlocks when every repo's checks are green.
        </p>
      )}
    </section>
  );
}
