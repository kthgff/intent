import type { TicketRow } from '@veto/core';
/**
 * S-10 — escalations & failures queue. Tickets in failed / blocked /
 * escalated / aborted / changes-requested plus gate items of kind
 * failure/escalation. Actions: retry, edit+retry (link), wont-do,
 * claim.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
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
import { projectPath, useProject } from '../project';

const FILTERS = [
  'all',
  'failed',
  'blocked',
  'escalated',
  'aborted',
  'changes-requested',
] as const;
const BROKEN = FILTERS.slice(1) as readonly string[];

export default function Escalations() {
  const ws = useProject();
  const [filter, setFilter] = useState<string>('all');
  const tickets = useLoad(() => client.tickets({ workspace: ws }), [ws]);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<unknown>(null);
  const [confirmKill, setConfirmKill] = useState<TicketRow | null>(null);
  useStreamRefresh(tickets.reload, ['gate_surfaced', 'gate_cleared']);

  const list = (tickets.data?.tickets ?? []).filter((t) =>
    BROKEN.includes(t.status),
  );
  const shown =
    filter === 'all' ? list : list.filter((t) => t.status === filter);

  const act = async (t: TicketRow, action: string) => {
    const key = `${t.workspace}/${t.ticket_id}`;
    setBusy(key);
    setError(null);
    try {
      await client.action(t.workspace, t.ticket_id, {
        action,
        expected_status: t.status,
      });
      tickets.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy('');
    }
  };

  return (
    <section>
      <h1 className="page-title">Failures & escalations</h1>
      <p className="page-sub">
        Everything broken or bounced to a human — retry, fix the env, or shut it
        down.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            className={`small ${filter === f ? 'primary' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'all' : f} (
            {f === 'all'
              ? list.length
              : list.filter((t) => t.status === f).length}
            )
          </button>
        ))}
      </div>
      {tickets.loading && <Loading />}
      {tickets.error != null && <ErrorBox error={tickets.error} />}
      {error != null && <ErrorBox error={error} />}
      {tickets.data && shown.length === 0 && (
        <Empty label="Nothing broken. Nice." />
      )}
      {shown.map((t) => {
        const key = `${t.workspace}/${t.ticket_id}`;
        return (
          <div className="card" key={key}>
            <div className="card-title">
              <StatusBadge status={t.status} />
              <Link to={projectPath(t.workspace, `/tickets/${t.ticket_id}`)}>
                {t.ticket_id} — {t.title}
              </Link>
              <span className="muted">{t.workspace}</span>
              <span className="muted">{fmtAge(t.updated_at)}</span>
              <span className="spacer" />
              <button
                type="button"
                className="small"
                title="Re-run the last failed run"
                disabled={busy === key}
                onClick={() => void act(t, 'retry')}
              >
                Retry run
              </button>
              <button
                type="button"
                className="small"
                title="Resume the ticket's pipeline without re-running"
                disabled={busy === key}
                onClick={() => void act(t, 'resume')}
              >
                Resume ticket
              </button>
              <button
                type="button"
                className="small danger"
                title="Abandon this ticket — leaves the pipeline"
                disabled={busy === key}
                onClick={() => setConfirmKill(t)}
              >
                Won't do
              </button>
            </div>
            {t.blocked_reason && (
              <div className="card-meta">Blocked: {t.blocked_reason}</div>
            )}
          </div>
        );
      })}
      {confirmKill && (
        <ConfirmDialog
          title={`Won't do ${confirmKill.ticket_id}?`}
          body={`"${confirmKill.title}" leaves the pipeline — recorded in the ledger.`}
          confirmLabel="Won't do"
          danger
          busy={busy === `${confirmKill.workspace}/${confirmKill.ticket_id}`}
          onConfirm={() => {
            const t = confirmKill;
            setConfirmKill(null);
            void act(t, 'wont_do');
          }}
          onCancel={() => setConfirmKill(null)}
        />
      )}
    </section>
  );
}
