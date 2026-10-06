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
import { Empty, ErrorBox, Loading, StatusBadge, fmtAge } from '../components';
import { useLoad, useStreamRefresh } from '../hooks';

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
  const [filter, setFilter] = useState<string>('all');
  const tickets = useLoad(() => client.tickets({}), []);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<unknown>(null);
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
            className={`small ${filter === f ? 'primary' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
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
              <Link to={`/tickets/${t.workspace}/${t.ticket_id}`}>
                {t.ticket_id} — {t.title}
              </Link>
              <span className="muted">{t.workspace}</span>
              <span className="muted">{fmtAge(t.updated_at)}</span>
              <span className="spacer" />
              <button
                type="button"
                className="small"
                disabled={busy === key}
                onClick={() => void act(t, 'retry')}
              >
                retry
              </button>
              <button
                type="button"
                className="small"
                disabled={busy === key}
                onClick={() => void act(t, 'resume')}
              >
                resume
              </button>
              <button
                type="button"
                className="small danger"
                disabled={busy === key}
                onClick={() => void act(t, 'wont_do')}
              >
                wont-do
              </button>
            </div>
            {t.blocked_reason && (
              <div className="card-meta">reason: {t.blocked_reason}</div>
            )}
          </div>
        );
      })}
    </section>
  );
}
