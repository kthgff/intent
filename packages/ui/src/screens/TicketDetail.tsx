import type { TicketRow } from '@sprint-runner/core';
/**
 * S-05 — ticket detail: status stepper, tabs (Overview / Documents /
 * Activity / Runs), family rail for split children, right-rail action
 * panel driven by open gates.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type TicketDetail as Detail, client } from '../api';
import {
  DiffView,
  Empty,
  ErrorBox,
  Loading,
  Markdown,
  SpecScore,
  StatusBadge,
  StatusStepper,
  fmtAge,
} from '../components';
import { useLoad, useStreamRefresh } from '../hooks';

const DOCS = ['prd', 'tdd', 'test'] as const;

export default function TicketDetail() {
  const { ws = '', id = '' } = useParams();
  const state = useLoad(() => client.ticket(ws, id), [ws, id]);
  const [tab, setTab] = useState<'overview' | 'docs' | 'activity' | 'runs'>(
    'overview',
  );
  useStreamRefresh(state.reload, [
    'gate_surfaced',
    'gate_cleared',
    'run_status',
  ]);

  if (state.loading) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} />;
  const d = state.data;
  if (!d) return <Empty />;
  const t = d.ticket;

  return (
    <section>
      <h1 className="page-title">
        {t.ticket_id} — {t.title} <SpecScore score={t.spec_score} />
      </h1>
      <p className="page-sub">
        {t.workspace} · priority {t.priority} · updated {fmtAge(t.updated_at)}{' '}
        ago
        {t.blocked_reason ? ` · blocked: ${t.blocked_reason}` : ''}
      </p>
      <StatusStepper status={t.status} />
      <div className="split">
        <div className="grow">
          <div className="tabs">
            {(['overview', 'docs', 'activity', 'runs'] as const).map((x) => (
              <button
                key={x}
                type="button"
                className={tab === x ? 'active' : ''}
                onClick={() => setTab(x)}
              >
                {x}
              </button>
            ))}
          </div>
          {tab === 'overview' && <Overview d={d} />}
          {tab === 'docs' && <DocsTab ws={ws} id={id} />}
          {tab === 'activity' && <ActivityTab ws={ws} id={id} />}
          {tab === 'runs' && <RunsTab ws={ws} id={id} />}
        </div>
        <aside className="rail">
          <ActionPanel ws={ws} d={d} onDone={state.reload} />
          <FamilyRail ws={ws} ticket={t} family={d.family} />
        </aside>
      </div>
    </section>
  );
}

function Overview({ d }: { d: Detail }) {
  return (
    <div>
      {d.ticket_md ? (
        <Markdown text={d.ticket_md} />
      ) : (
        <Empty label="No ticket.md content." />
      )}
      {d.triage && (
        <div className="card">
          <strong>triage</strong>
          <div className="card-meta">
            spec lint score {d.triage.spec_lint.score} · round {d.triage.round}
          </div>
          {d.triage.spec_lint.flags.map((f) => (
            <div key={f} className="muted">
              ⚑ {f}
            </div>
          ))}
          <div className="card-meta">
            open questions:{' '}
            {d.triage.questions.filter((q) => q.status === 'open').length}
          </div>
        </div>
      )}
    </div>
  );
}

function DocsTab({ ws, id }: { ws: string; id: string }) {
  const [name, setName] = useState<string>(DOCS[0]);
  const doc = useLoad(() => client.ticketDoc(ws, id, name), [ws, id, name]);
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        {DOCS.map((n) => (
          <button
            key={n}
            type="button"
            className={`small ${name === n ? 'primary' : ''}`}
            onClick={() => setName(n)}
          >
            {n}.md
          </button>
        ))}
      </div>
      {doc.loading && <Loading />}
      {doc.error != null && <ErrorBox error={doc.error} />}
      {doc.data && (
        <>
          <Markdown text={doc.data.content} />
          {doc.data.diffs.map((dd) => (
            <details key={dd.to} className="card">
              <summary>
                version diff {dd.from} → {dd.to}
              </summary>
              <DiffView diff={dd.diff} />
            </details>
          ))}
          <p>
            <Link to={`/tickets/${ws}/${id}/docs/${name}`}>
              Open in doc reviewer →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

function ActivityTab({ ws, id }: { ws: string; id: string }) {
  const ev = useLoad(() => client.ticketEvents(ws, id), [ws, id]);
  if (ev.loading) return <Loading />;
  if (ev.error) return <ErrorBox error={ev.error} />;
  const events = ev.data?.events ?? [];
  if (events.length === 0) return <Empty label="No events yet." />;
  return (
    <table>
      <thead>
        <tr>
          <th>ts</th>
          <th>event</th>
          <th>stage</th>
          <th>actor</th>
          <th>tokens</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.seq ?? `${e.ts}-${e.event}`}>
            <td className="mono">{e.ts.slice(0, 19)}</td>
            <td>{e.event}</td>
            <td className="muted">{e.stage ?? '—'}</td>
            <td className="muted">{e.actor_id}</td>
            <td className="mono muted">
              {e.tokens_in ?? 0}→{e.tokens_out ?? 0}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunsTab({ ws, id }: { ws: string; id: string }) {
  const runs = useLoad(
    () => client.runs({ workspace: ws, ticket_id: id }),
    [ws, id],
  );
  if (runs.loading) return <Loading />;
  if (runs.error) return <ErrorBox error={runs.error} />;
  const list = runs.data?.runs ?? [];
  if (list.length === 0) return <Empty label="No runs recorded." />;
  return (
    <table>
      <thead>
        <tr>
          <th>run</th>
          <th>stage</th>
          <th>status</th>
          <th>tokens in/out</th>
          <th>cost</th>
        </tr>
      </thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.id}>
            <td>
              <Link to={`/runs/${encodeURIComponent(r.id)}`} className="mono">
                {r.id}
              </Link>
            </td>
            <td>{r.stage}</td>
            <td>
              <StatusBadge status={r.status} />
            </td>
            <td className="mono">
              {r.tokens_in ?? '—'}→{r.tokens_out ?? '—'}
            </td>
            <td className="mono">
              {r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Right rail — the current gate's action panel. */
function ActionPanel({
  ws,
  d,
  onDone,
}: {
  ws: string;
  d: Detail;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const t = d.ticket;
  const act = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await client.action(ws, t.ticket_id, {
        action,
        expected_status: t.status,
        ...extra,
      });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const gates = d.open_gates.map((g) => g.gate);
  const ref = `${ws}/${t.ticket_id}`;
  return (
    <div className="card">
      <strong>Actions</strong>
      {err != null && <ErrorBox error={err} />}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          marginTop: 8,
        }}
      >
        {(gates.includes('needs-info') || gates.includes('design-qa')) && (
          <Link className="btn" to={`/tickets/${ref}/wizard`}>
            Answer questions
          </Link>
        )}
        {gates.includes('test-approved') && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act('go_implement')}
          >
            Go implement (spend checkpoint)
          </button>
        )}
        {gates.includes('approved') && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act('open_pr')}
          >
            Open PR
          </button>
        )}
        {gates.includes('ci-watch') && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act('merge')}
          >
            Merge
          </button>
        )}
        {gates.includes('split-plan') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('approve_split')}
          >
            Approve split
          </button>
        )}
        {['failed', 'blocked', 'aborted'].includes(t.status) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('retry')}
          >
            Retry
          </button>
        )}
        {['changes-requested', 'escalated'].includes(t.status) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('resume')}
          >
            Resume pipeline
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('handoff')}
        >
          Hand off to human
        </button>
        {!['merged', 'wont-do', 'aborted'].includes(t.status) && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act('force_ready')}
            >
              Force ready
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void act('wont_do')}
            >
              Won't do
            </button>
          </>
        )}
        {t.status === 'merged' && (
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
      <div className="card-meta">status: {t.status}</div>
    </div>
  );
}

/** Family rail — parent / children / depends_on for split families. */
function FamilyRail({
  ws,
  ticket,
  family,
}: {
  ws: string;
  ticket: TicketRow;
  family: TicketRow[];
}) {
  if (!ticket.parent && family.length === 0 && ticket.depends_on.length === 0)
    return null;
  return (
    <div className="card">
      <strong>Family</strong>
      {ticket.parent && (
        <div className="card-meta">
          parent:{' '}
          <Link to={`/tickets/${ws}/${ticket.parent}`}>{ticket.parent}</Link>
        </div>
      )}
      {ticket.depends_on.map((dep) => (
        <div key={dep} className="card-meta">
          depends on: <Link to={`/tickets/${ws}/${dep}`}>{dep}</Link>
        </div>
      ))}
      {family.map((f) => (
        <div key={f.ticket_id} className="card-meta">
          {f.parent === ticket.ticket_id ? 'child: ' : ''}
          <Link to={`/tickets/${ws}/${f.ticket_id}`}>
            {f.ticket_id} — {f.title}
          </Link>{' '}
          <StatusBadge status={f.status} />
        </div>
      ))}
    </div>
  );
}
