/**
 * S-21 — Merge Center (DELIVERY §2, wp-137).
 *
 * Per-ticket merge readiness for every `ci-watch` ticket in the
 * workspace: the deterministic checklist (approval/scope/ac-evidence/
 * checks/security/depends-on/conflict/branch-protection/dod), blocking
 * gates, branch-protection state, and — only when the checklist is
 * green — the execute-merge action plus the revert affordance.
 * Conflicts link to the ticket (the `rebase` run owns the rewrite).
 *
 * Read model: GET /api/v1/merge-center/:workspace. Merge execution is
 * the ticket action `merge` (expected_status OCC); the conductor's
 * merge queue picks the FIFO order — the UI renders ready tickets
 * first, oldest evaluation first.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type MergeChecklistItem, type MergeReadiness, client } from '../api';
import { Empty, ErrorBox, Loading, fmtAge } from '../components';
import { useLoad, useStreamRefresh } from '../hooks';

/** Checklist presentation order (DELIVERY §2 sequence). */
const ITEM_ORDER = [
  'approval',
  'scope',
  'ac-evidence',
  'checks',
  'security',
  'depends-on',
  'conflict',
  'branch-protection',
  'dod',
];

export function orderedItems(r: MergeReadiness): MergeChecklistItem[] {
  return [...r.items].sort(
    (a, b) =>
      (ITEM_ORDER.indexOf(a.id) === -1 ? 99 : ITEM_ORDER.indexOf(a.id)) -
      (ITEM_ORDER.indexOf(b.id) === -1 ? 99 : ITEM_ORDER.indexOf(b.id)),
  );
}

/** Queue order: ready first (FIFO by evaluation time), then blocked. */
export function queueOrder(tickets: MergeReadiness[]): MergeReadiness[] {
  return [...tickets].sort(
    (a, b) => Number(b.ready) - Number(a.ready) || a.at.localeCompare(b.at),
  );
}

export default function MergeCenter() {
  const workspaces = useLoad(() => client.workspaces(), []);
  const [ws, setWs] = useState('');
  const effective = ws || workspaces.data?.workspaces[0]?.name || '';
  const state = useLoad(
    () => (effective ? client.mergeCenter(effective) : Promise.resolve(null)),
    [effective],
  );
  useStreamRefresh(state.reload, [
    'merge_ready',
    'merge_attempted',
    'merge_conflict',
    'gate_surfaced',
    'gate_cleared',
    'run_status',
    'ticket_updated',
  ]);

  return (
    <section>
      <h1 className="page-title">Merge Center</h1>
      <p className="page-sub">
        Per-ticket merge readiness — Veto executes the merge when every check is
        green (DELIVERY §2).
      </p>
      <div className="row">
        <select
          aria-label="workspace"
          value={effective}
          onChange={(e) => setWs(e.target.value)}
        >
          {(workspaces.data?.workspaces ?? []).map((w) => (
            <option key={w.name} value={w.name}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      {state.loading && <Loading label="Evaluating readiness…" />}
      {state.error != null && <ErrorBox error={state.error} />}
      {state.data && state.data.tickets.length === 0 && (
        <Empty label="No tickets in ci-watch — the merge queue is empty." />
      )}
      {state.data && (
        <ol className="merge-queue" aria-label="merge order">
          {queueOrder(state.data.tickets).map((r) => (
            <ReadinessCard
              key={r.ticket_id}
              ws={effective}
              r={r}
              onDone={state.reload}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

export function ReadinessCard({
  ws,
  r,
  onDone,
}: {
  ws: string;
  r: MergeReadiness;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const act = async (action: 'merge') => {
    setBusy(true);
    setErr(null);
    try {
      await client.action(ws, r.ticket_id, {
        action,
        expected_status: 'ci-watch',
      });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const conflict = r.blockers.find((b) => b.id === 'conflict');
  const protection = r.items.find((i) => i.id === 'branch-protection');

  return (
    <li className={`card merge-card${r.ready ? ' merge-ready' : ''}`}>
      <div className="card-title">
        <strong>
          <Link
            to={`/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(r.ticket_id)}`}
          >
            {r.ticket_id}
          </Link>
        </strong>
        {r.ready ? (
          <span className="badge spec-good">ready</span>
        ) : (
          <span className="badge spec-bad">
            blocked — {r.blockers.length} gate
            {r.blockers.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="spacer" />
        <span className="muted">evaluated {fmtAge(r.at)} ago</span>
      </div>
      {err != null && <ErrorBox error={err} />}

      <ul className="checklist" aria-label="readiness checklist">
        {orderedItems(r).map((item) => (
          <li key={item.id} className={`check-${item.ok ? 'ok' : 'blocked'}`}>
            <span aria-hidden>{item.ok ? '✓' : '✗'}</span> {item.label}
            {item.detail ? (
              <span className="muted"> — {item.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>

      {protection && !protection.ok && (
        <p className="muted">
          Branch protection blocks the merge — a `merge` escalation gate is
          surfaced on the ticket; Veto never bypasses protection.
        </p>
      )}
      {conflict && (
        <div className="card conflict-card">
          <div className="card-title">
            <strong>Merge conflict</strong>
            <span className="badge kind-escalation">merge_conflict</span>
          </div>
          <p className="muted">
            {conflict.detail ?? 'git conflict against the target branch'} — a
            `rebase` run owns the rewrite (never a silent force-push).
          </p>
          <Link
            to={`/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(r.ticket_id)}`}
          >
            Open ticket / rebase run →
          </Link>
        </div>
      )}

      {Object.keys(r.heads).length > 0 && (
        <p className="mono muted" style={{ fontSize: '0.85em' }}>
          {Object.entries(r.heads)
            .map(([repo, sha]) => `${repo}@${sha ? sha.slice(0, 8) : '—'}`)
            .join('  ')}
        </p>
      )}

      <div className="row">
        {r.ready && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            title="execute merge — gh pr merge via the ticket action"
            onClick={() => void act('merge')}
          >
            Merge now
          </button>
        )}
        {/* Revert lives on the PR panel — this payload only carries
            ci-watch tickets, so a merged-work action can never belong
            here. */}
        <Link
          className="btn small"
          to={`/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(r.ticket_id)}/pr`}
        >
          PR panel →
        </Link>
      </div>
    </li>
  );
}
