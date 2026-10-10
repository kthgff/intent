import type { EventRow } from '@veto/core';
/**
 * S-11 — ledger browser. Per-ticket event timeline (filterable
 * by event name / stage / actor). At `/ledger` a ticket picker lists
 * all tickets; at `/tickets/:ws/:id/ledger` the timeline shows inline.
 */
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { client } from '../api';
import {
  Empty,
  ErrorBox,
  Loading,
  StatusBadge,
  fmtAge,
  fmtTokens,
  humanize,
} from '../components';
import { DictationField } from '../dictation';
import { useLoad } from '../hooks';
import { projectPath, useProject } from '../project';

export default function Ledger() {
  const { id } = useParams();
  const ws = useProject();
  if (id) return <TicketLedger ws={ws} id={id} />;
  return <TicketPicker ws={ws} />;
}

function TicketPicker({ ws }: { ws: string }) {
  const state = useLoad(() => client.tickets({ workspace: ws }), [ws]);
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
            to={projectPath(
              t.workspace,
              `/tickets/${encodeURIComponent(t.ticket_id)}/ledger`,
            )}
          >
            {t.ticket_id} — {t.title}
          </Link>{' '}
          <StatusBadge status={t.status} />
        </div>
      ))}
    </section>
  );
}

export function TicketLedger({ ws, id }: { ws: string; id: string }) {
  const ev = useLoad(() => client.ticketEvents(ws, id), [ws, id]);
  const [eventFilter, setEventFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [search, setSearch] = useState('');
  const events = ev.data?.events ?? [];

  const names = useMemo(
    () => [...new Set(events.map((e) => e.event))].sort(),
    [events],
  );
  const stages = useMemo(
    () => [...new Set(events.map((e) => e.stage).filter(Boolean))].sort(),
    [events],
  ) as string[];
  const q = search.trim().toLowerCase();
  const shown = events.filter(
    (e) =>
      (!eventFilter || e.event === eventFilter) &&
      (!stageFilter || e.stage === stageFilter) &&
      (!q ||
        e.event.toLowerCase().includes(q) ||
        (e.stage ?? '').toLowerCase().includes(q) ||
        (e.actor_id ?? '').toLowerCase().includes(q) ||
        JSON.stringify(e.data ?? {})
          .toLowerCase()
          .includes(q)),
  );

  return (
    <section>
      <h1 className="page-title">Ledger — {id}</h1>
      <p className="page-sub">
        <Link to={projectPath(ws, `/tickets/${id}`)}>← ticket</Link> ·{' '}
        {events.length} events (durable DB rows)
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
        <DictationField style={{ width: 200, flex: '0 0 auto' }}>
          <input
            aria-label="search events"
            type="search"
            placeholder="search events…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </DictationField>
        {(eventFilter || stageFilter || q) && (
          <span className="muted">
            {shown.length} of {events.length}
          </span>
        )}
      </div>
      {shown.length === 0 && !ev.loading && <Empty label="No events match." />}
      {shown.map((e) => (
        <EventCard key={e.seq ?? `${e.ts}-${e.event}`} e={e} ws={ws} />
      ))}
    </section>
  );
}

function EventCard({ e, ws }: { e: EventRow; ws: string }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const dataEntries = Object.entries(e.data ?? {});
  return (
    <div className="card">
      <div className="card-title">
        <span className="mono muted" title={e.ts}>
          {fmtAge(e.ts)}
        </span>
        <strong>{humanize(e.event)}</strong>
        {e.stage && <span className="badge">{e.stage}</span>}
        <span className="badge">{e.actor_type}</span>
        <span className="muted mono">{e.actor_id}</span>
        {e.run && (
          <Link
            className="mono"
            to={projectPath(ws, `/runs/${encodeURIComponent(e.run)}`)}
          >
            run {e.run.slice(0, 12)}
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
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {open ? ' Hide' : ' Details'}
        </button>
      </div>
      {open &&
        (raw ? (
          <pre className="terminal" style={{ maxHeight: 240 }}>
            {JSON.stringify({ refs: e.refs, data: e.data }, null, 2)}
          </pre>
        ) : (
          <table className="kv-table">
            <tbody>
              {(e.refs ?? []).length > 0 && (
                <tr>
                  <td className="muted">refs</td>
                  <td className="mono">{e.refs.join(', ')}</td>
                </tr>
              )}
              {dataEntries.map(([k, v]) => (
                <tr key={k}>
                  <td className="muted">{k}</td>
                  <td className="mono">
                    {typeof v === 'object' && v !== null
                      ? JSON.stringify(v)
                      : String(v ?? '—')}
                  </td>
                </tr>
              ))}
              {dataEntries.length === 0 && (e.refs ?? []).length === 0 && (
                <tr>
                  <td className="muted">no payload</td>
                </tr>
              )}
            </tbody>
          </table>
        ))}
      {open && (dataEntries.length > 0 || (e.refs ?? []).length > 0) && (
        <button
          type="button"
          className="link small"
          onClick={() => setRaw((r) => !r)}
        >
          {raw ? 'as fields' : 'raw JSON'}
        </button>
      )}
    </div>
  );
}
