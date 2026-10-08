/**
 * S-12 — metrics dashboard: aggregates from /metrics (tickets by
 * status funnel, runs by status, token/cost totals, events mix,
 * human-minutes).
 */
import { useEffect, useState } from 'react';
import { client } from '../api';
import {
  Empty,
  ErrorBox,
  Loading,
  fmtAge,
  fmtTokens,
  humanize,
} from '../components';
import { useLoad } from '../hooks';
import { useProject } from '../project';

export default function Metrics() {
  const workspace = useProject();
  const [asOf, setAsOf] = useState<number>(0);
  const state = useLoad(() => client.metrics(workspace), [workspace]);
  useEffect(() => {
    if (state.data) setAsOf(Date.now());
  }, [state.data]);

  if (state.loading) return <Loading />;
  if (state.error)
    return <ErrorBox error={state.error} onRetry={state.reload} />;
  const m = state.data;
  if (!m) return <Empty />;

  const merged = m.tickets_by_status.merged ?? 0;
  const totalTickets = Object.values(m.tickets_by_status).reduce(
    (a, b) => a + b,
    0,
  );
  const costPerMerge =
    merged > 0 && m.totals.cost_usd > 0
      ? `$${(m.totals.cost_usd / merged).toFixed(2)}`
      : '—';
  const successRate =
    totalTickets > 0 ? `${Math.round((merged / totalTickets) * 100)}%` : '—';

  return (
    <section>
      <h1 className="page-title">Metrics</h1>
      <p className="page-sub">
        ROI for {workspace}
        {asOf > 0 && (
          <>
            {' '}
            · updated {fmtAge(new Date(asOf).toISOString())} ago{' '}
            <button
              type="button"
              className="link"
              onClick={() => void state.reload()}
            >
              refresh
            </button>
          </>
        )}
      </p>
      <div className="counters" style={{ marginBottom: 16 }}>
        <Counter label="merge rate" value={successRate} />
        <Counter label="cost / merge" value={costPerMerge} />
        <Counter label="tokens in" value={fmtTokens(m.totals.tokens_in)} />
        <Counter label="tokens out" value={fmtTokens(m.totals.tokens_out)} />
        <Counter label="cached" value={fmtTokens(m.totals.tokens_cached)} />
        <Counter label="human min" value={Math.round(m.totals.human_minutes)} />
        <Counter label="open gates" value={m.open_gate_items} />
        <Counter
          label="total cost"
          value={m.totals.cost_usd ? `$${m.totals.cost_usd.toFixed(2)}` : '—'}
        />
      </div>

      <div className="split">
        <div className="grow">
          <h2 className="group-title">Stage funnel (tickets by status)</h2>
          {Object.keys(m.tickets_by_status).length === 0 && (
            <Empty label="No tickets." />
          )}
          <table>
            <tbody>
              {Object.entries(m.tickets_by_status)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <tr key={k}>
                    <td>{humanize(k)}</td>
                    <td className="mono">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="grow">
          <h2 className="group-title">Runs by status</h2>
          <table>
            <tbody>
              {Object.entries(m.runs_by_status)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <tr key={k}>
                    <td>{humanize(k)}</td>
                    <td className="mono">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <h2 className="group-title">Events</h2>
          <table>
            <tbody>
              {Object.entries(m.events_by_name)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([k, v]) => (
                  <tr key={k}>
                    <td>{humanize(k)}</td>
                    <td className="mono">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {Object.keys(m.events_by_name).length > 20 && (
            <p className="muted">
              Showing 20 of {Object.keys(m.events_by_name).length} event types
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Counter({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="counter">
      <div className="v">{value}</div>
      <div className="k">{label}</div>
    </div>
  );
}
