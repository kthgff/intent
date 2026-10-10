/**
 * S-09 — PR status panel: per-repo rows (branch, PR url/state, CI
 * state, merged sha), merge button enabled when all repos are green,
 * revert for merged.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { client } from '../api';
import {
  ConfirmDialog,
  Empty,
  ErrorBox,
  Loading,
  StatusBadge,
} from '../components';
import { useLoad, useStreamRefresh } from '../hooks';
import { projectPath } from '../project';

export default function PrPanel() {
  const { ws = '', id = '' } = useParams();
  const navigate = useNavigate();
  const detail = useLoad(() => client.ticket(ws, id), [ws, id]);
  useStreamRefresh(detail.reload, ['run_status', 'gate_cleared']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmRevert, setConfirmRevert] = useState(false);

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
    <section className="pr-panel-screen">
      <h1 className="page-title">PR status — {id}</h1>
      <p className="page-sub">
        <Link to={projectPath(ws, `/tickets/${id}`)}>← ticket</Link> ·{' '}
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
            <span className="badge">PR: {r.pr_state ?? '—'}</span>
            <span
              className={`badge spec-${
                r.ci_state === 'green'
                  ? 'good'
                  : r.ci_state === 'failing'
                    ? 'bad'
                    : 'warn'
              }`}
            >
              CI: {r.ci_state ?? 'pending'}
            </span>
            {r.merged_sha &&
              (r.pr_url ? (
                <a
                  className="mono muted"
                  href={`${r.pr_url.replace(/\/pull\/\d+.*$/, '')}/commit/${r.merged_sha}`}
                  rel="noreferrer"
                  title={r.merged_sha}
                >
                  merged {r.merged_sha.slice(0, 8)}
                </a>
              ) : (
                <span className="mono muted" title={r.merged_sha}>
                  merged {r.merged_sha.slice(0, 8)}
                </span>
              ))}
          </div>
        </div>
      ))}
      <div className="row pr-actions">
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
            onClick={() => setConfirmRevert(true)}
          >
            Revert
          </button>
        )}
      </div>
      {confirmRevert && (
        <ConfirmDialog
          title="Revert merged PRs?"
          body={`Reverts ${repos
            .map((r) => r.merged_sha?.slice(0, 8) ?? r.repo)
            .join(', ')} — a revert run is queued and the ticket is reopened.`}
          confirmLabel="Revert"
          danger
          busy={busy}
          onConfirm={() => {
            setConfirmRevert(false);
            void act('revert');
          }}
          onCancel={() => setConfirmRevert(false)}
        />
      )}
      {!allGreen && repos.length > 0 && (
        <p className="muted">
          Merge unlocks when every repo's checks are green.
        </p>
      )}
    </section>
  );
}
