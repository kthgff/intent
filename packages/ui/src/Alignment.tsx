/**
 * wp-112 — continuous-alignment panel (S-05 ticket focus, SCHEMAS §18).
 *
 * Findings are reviewable hypotheses: every card shows the claim,
 * confidence, freshness, ALL evidence refs, any disconfirming refs
 * (never hidden), and the suggested next check. Human decisions —
 * dismiss/verify/resolve (reopen for settled) — go through
 * POST /alignment/decide with `expected` = the status the human saw;
 * a racing write surfaces a visible 409 and the panel reloads.
 * Findings cannot mutate specs, verify links, or clear gates — this
 * panel only records the human's call.
 */
import { useState } from 'react';
import { type AlignmentFinding, client } from './api';
import { Empty, ErrorBox, Loading } from './components';
import { useLoad } from './hooks';

const SEV_CLASS: Record<string, string> = {
  blocker: 'spec-bad',
  major: 'spec-bad',
  minor: 'spec-warn',
  info: 'spec-dim',
};
const STATUS_CLASS: Record<string, string> = {
  open: 'spec-warn',
  dismissed: 'spec-dim',
  verified: 'spec-good',
  resolved: 'spec-good',
};

function RefList({ label, refs }: { label: string; refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <div className="align-refs">
      <span className="dim">{label}:</span>
      <ul>
        {refs.map((r) => (
          <li key={r}>
            <code>{r}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Alignment({
  ws,
  scope,
}: {
  ws: string;
  scope: string;
}) {
  const view = useLoad(() => client.alignment(ws, scope), [ws, scope]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const decide = async (
    f: AlignmentFinding,
    action: 'dismiss' | 'verify' | 'resolve' | 'reopen',
  ) => {
    setBusy(f.id);
    setErr(null);
    try {
      await client.decideAlignment({
        workspace: ws,
        id: f.id,
        action,
        expected: f.status,
      });
      await view.reload();
    } catch (e) {
      await view.reload();
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    setRequesting(true);
    setErr(null);
    try {
      await client.requestAlignment(ws, scope);
      await view.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setRequesting(false);
    }
  };

  if (view.loading) return <Loading />;
  if (view.error) return <ErrorBox error={view.error} />;
  const data = view.data;
  if (!data) return <Empty label="No alignment data" />;

  return (
    <div className="alignment-panel">
      <div className="row spread">
        <h3>Alignment findings</h3>
        <button type="button" disabled={requesting} onClick={() => void run()}>
          {requesting ? 'Comparing…' : 'Run comparison'}
        </button>
      </div>
      {data.latest_run && (
        <p className="dim">
          last run {data.latest_run.run_id} · {data.latest_run.trigger} ·{' '}
          {data.latest_run.status} · {data.latest_run.finding_count} finding(s)
          · {data.latest_run.finished_at ?? 'in flight'}
        </p>
      )}
      {err != null && <ErrorBox error={err} />}
      {data.findings.length === 0 && (
        <Empty label="No findings — intent, implementation, and verification align on current evidence" />
      )}
      {data.findings.map((f) => (
        <div key={f.id} className="card align-finding">
          <div className="row spread">
            <span className={`badge ${SEV_CLASS[f.severity] ?? ''}`}>
              {f.severity}
            </span>
            <span className="dim">{f.kind}</span>
            <span className={`badge ${STATUS_CLASS[f.status] ?? ''}`}>
              {f.status}
            </span>
          </div>
          <p>{f.claim}</p>
          <p className="dim">
            confidence {f.confidence.toFixed(2)} · freshness {f.freshness} ·
            next: {f.suggested_next_check}
          </p>
          <RefList label="evidence" refs={f.evidence_refs} />
          <RefList label="disconfirming" refs={f.disconfirming_refs} />
          <div className="row">
            {f.status === 'open' && (
              <>
                <button
                  type="button"
                  disabled={busy === f.id}
                  onClick={() => void decide(f, 'verify')}
                >
                  verify
                </button>
                <button
                  type="button"
                  disabled={busy === f.id}
                  onClick={() => void decide(f, 'resolve')}
                >
                  resolve
                </button>
                <button
                  type="button"
                  disabled={busy === f.id}
                  onClick={() => void decide(f, 'dismiss')}
                >
                  dismiss
                </button>
              </>
            )}
            {f.status !== 'open' && (
              <button
                type="button"
                disabled={busy === f.id}
                onClick={() => void decide(f, 'reopen')}
              >
                reopen
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
