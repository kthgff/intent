import type { EventRow } from '@veto/core';
/**
 * S-11 — ledger browser. Per-ticket event timeline (filterable
 * by event name / stage / actor). At `/ledger` a ticket picker lists
 * all tickets; at `/tickets/:ws/:id/ledger` the timeline shows inline.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { client } from '../api';
import { Empty, ErrorBox, Loading, fmtTokens } from '../components';
import { useLoad } from '../hooks';

export default function Ledger() {
  const { ws, id } = useParams();
  if (ws && id) return <TicketLedger ws={ws} id={id} />;
  return <TicketPicker />;
}

function TicketPicker() {
  const state = useLoad(() => client.tickets({}), []);
  if (state.loading) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} />;
  const tickets = state.data?.tickets ?? [];
  return (
    <section>
      <h1 className="page-title">Ledger</h1>
      <p className="page-sub">Pick a ticket to audit its event history.</p>
      {tickets.length === 0 && <Empty label="No tickets." />}
      {tickets.map((t) => (
        <div className="card" key={`${t.workspace}/${t.ticket_id}`}>
          <Link
            to={`/tickets/${encodeURIComponent(t.workspace)}/${encodeURIComponent(
              t.ticket_id,
            )}/ledger`}
          >
            {t.workspace}/{t.ticket_id} — {t.title}
          </Link>
          <span className="muted"> · {t.status}</span>
        </div>
      ))}
    </section>
  );
}

export function TicketLedger({ ws, id }: { ws: string; id: string }) {
  const ev = useLoad(() => client.ticketEvents(ws, id), [ws, id]);
  const [eventFilter, setEventFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const events = ev.data?.events ?? [];

  const names = useMemo(
    () => [...new Set(events.map((e) => e.event))].sort(),
    [events],
  );
  const stages = useMemo(
    () => [...new Set(events.map((e) => e.stage).filter(Boolean))].sort(),
    [events],
  ) as string[];
  const shown = events.filter(
    (e) =>
      (!eventFilter || e.event === eventFilter) &&
      (!stageFilter || e.stage === stageFilter),
  );

  return (
    <section>
      <h1 className="page-title">Ledger — {id}</h1>
      <p className="page-sub">
        <Link to={`/tickets/${ws}/${id}`}>← ticket</Link> · {events.length}{' '}
        events (durable DB rows)
      </p>
      {ev.loading && <Loading />}
      {ev.error != null && <ErrorBox error={ev.error} />}
      <div className="row" style={{ marginBottom: 10 }}>
        <select
          aria-label="event filter"
          style={{ width: 'auto' }}
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value)}
        >
          <option value="">all events</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select
          aria-label="stage filter"
          style={{ width: 'auto' }}
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
        >
          <option value="">all stages</option>
          {stages.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 && !ev.loading && <Empty label="No events match." />}
      {shown.map((e) => (
        <EventCard key={e.seq ?? `${e.ts}-${e.event}`} e={e} />
      ))}
    </section>
  );
}

function EventCard({ e }: { e: EventRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-title">
        <span className="mono muted">{e.ts.slice(0, 19)}</span>
        <strong>{e.event}</strong>
        {e.stage && <span className="badge">{e.stage}</span>}
        <span className="muted">
          {e.actor_type}:{e.actor_id}
        </span>
        {e.run && (
          <Link className="mono" to={`/runs/${encodeURIComponent(e.run)}`}>
            run
          </Link>
        )}
        <span className="spacer" />
        <span className="mono muted">
          {fmtTokens(e.tokens_in)}→{fmtTokens(e.tokens_out)}
          {e.cost_usd != null && ` · $${e.cost_usd.toFixed(4)}`}
          {e.usage_source && ` (${e.usage_source})`}
        </span>
        <button
          type="button"
          className="small"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? 'less' : 'more'}
        </button>
      </div>
      {open && (
        <pre className="terminal" style={{ maxHeight: 240 }}>
          {JSON.stringify({ refs: e.refs, data: e.data }, null, 2)}
        </pre>
      )}
    </div>
  );
}
