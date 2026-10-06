/**
 * S-17 — Feature Workspace (PRD §15.7, wp-152). The operational hub
 * for one delivery unit: six tabs — Overview / Requirements / Design /
 * Tickets / Quality / Release — over the server-computed detail
 * rollup. Feature Health renders as an explainable findings list
 * (evidence refs, never an opaque score); the Feature Acceptance
 * Package lives on the Release tab behind the explicit human
 * acceptance gate; "Ask About This Feature" is a chat-to-edit session
 * scoped to the feature's own docs (answers/diffs from feature
 * evidence only).
 */
import type { TicketRow } from '@sprint-runner/core';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ChatEdit from '../ChatEdit';
import {
  type AcceptancePackage,
  type DocResponse,
  type FeatureAcRow,
  type FeatureDetail,
  type FeatureHealthFinding,
  client,
} from '../api';
import {
  DiffView,
  Empty,
  ErrorBox,
  Loading,
  Markdown,
  StatusBadge,
  fmtAge,
} from '../components';
import { useLoad, useStreamRefresh } from '../hooks';

type TabId =
  | 'overview'
  | 'requirements'
  | 'design'
  | 'tickets'
  | 'quality'
  | 'release';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'requirements', label: 'Requirements' },
  { id: 'design', label: 'Design' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'quality', label: 'Quality' },
  { id: 'release', label: 'Release' },
];

const SEV_LABEL: Record<FeatureHealthFinding['severity'], string> = {
  blocker: 'blocker',
  warning: 'warning',
  info: 'note',
};

/** Health findings — explainable, evidence-linked, no score. */
export function FindingsList({
  findings,
}: {
  findings: FeatureHealthFinding[];
}) {
  if (findings.length === 0) return <Empty label="No open findings." />;
  return (
    <ul className="findings" aria-label="feature health findings">
      {findings.map((f) => (
        <li key={f.id} className={`finding sev-${f.severity}`}>
          <span className="badge">{SEV_LABEL[f.severity]}</span> {f.message}{' '}
          {f.refs.length > 0 && (
            <span className="muted">[{f.refs.join(' · ')}]</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function FeatureWorkspace() {
  const { ws = '', id = '' } = useParams();
  const detail = useLoad(() => client.feature(ws, id), [ws, id]);
  const [tab, setTab] = useState<TabId>('overview');
  const [ask, setAsk] = useState(false);
  useStreamRefresh(detail.reload, [
    'gate_surfaced',
    'gate_cleared',
    'run_status',
    'notification',
  ]);

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  const d = detail.data as FeatureDetail | null;
  if (!d) return <Empty label="Feature not found." />;
  const f = d.feature;

  return (
    <section className="page feature-workspace">
      <h1>
        {f.feature} — {f.title}
      </h1>
      <p className="page-sub">
        <StatusBadge status={f.status} /> {f.workspace} · priority{' '}
        {f.priority ?? 'medium'}
        {f.owner ? ` · owner ${f.owner}` : ''}
        {d.initiative && (
          <>
            {' '}
            · initiative <strong>{d.initiative.initiative}</strong> (
            {d.initiative.status})
          </>
        )}{' '}
        · updated {f.updated_at ? `${fmtAge(f.updated_at)} ago` : '—'}
      </p>
      {f.serves && f.serves.length > 0 && (
        <p className="page-sub">
          serves:{' '}
          {f.serves.map((g) => (
            <span key={g} className="badge">
              {g}
            </span>
          ))}
        </p>
      )}
      <p className="row page-sub">
        <button type="button" onClick={() => setAsk((a) => !a)}>
          {ask ? 'Close assistant' : 'Ask About This Feature'}
        </button>
      </p>
      {ask && (
        <ChatEdit
          ws={ws}
          subjectRef={f.feature}
          target="feature"
          onApplied={detail.reload}
          onClose={() => setAsk(false)}
        />
      )}

      <div className="split">
        <div className="grow">
          <div className="tabs" role="tablist">
            {TABS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={tab === x.id}
                className={tab === x.id ? 'active' : ''}
                onClick={() => setTab(x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>
          {tab === 'overview' && <OverviewTab ws={ws} d={d} />}
          {tab === 'requirements' && <RequirementsTab d={d} />}
          {tab === 'design' && <DesignTab ws={ws} d={d} />}
          {tab === 'tickets' && <TicketsTab ws={ws} d={d} />}
          {tab === 'quality' && <QualityTab ws={ws} d={d} />}
          {tab === 'release' && (
            <ReleaseTab ws={ws} d={d} onDone={detail.reload} />
          )}
        </div>
        <aside className="rail">
          <div className="panel">
            <h2>Health</h2>
            <FindingsList findings={d.health} />
          </div>
          <div className="panel">
            <h2>Acceptance</h2>
            {d.acceptance.accepted ? (
              <p>
                Accepted{' '}
                {d.acceptance.at ? `${fmtAge(d.acceptance.at)} ago` : ''} by{' '}
                {d.acceptance.by}
                {d.acceptance.exclusions?.length ? (
                  <> — exclusions: {d.acceptance.exclusions.join('; ')}</>
                ) : null}
              </p>
            ) : (
              <p className="muted">
                Not accepted — release assignment is blocked until the
                acceptance package is human-approved (Release tab).
              </p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function OverviewTab({ ws, d }: { ws: string; d: FeatureDetail }) {
  const doc = useLoad(
    () => client.featureDoc(ws, d.feature.feature, 'feature'),
    [ws, d.feature.feature],
  );
  return (
    <div className="panel">
      <h2>Objective</h2>
      {doc.loading && <Loading />}
      {doc.error != null ? (
        <Empty label="No feature.md yet — the feature has no scope doc." />
      ) : (
        doc.data && <Markdown text={doc.data.content} />
      )}
      <h2>Facts</h2>
      <table>
        <tbody>
          <tr>
            <td>Status</td>
            <td>
              <StatusBadge status={d.feature.status} />
            </td>
          </tr>
          <tr>
            <td>Owner</td>
            <td>{d.feature.owner ?? '—'}</td>
          </tr>
          <tr>
            <td>Priority</td>
            <td>{d.feature.priority ?? 'medium'}</td>
          </tr>
          <tr>
            <td>Initiative</td>
            <td>
              {d.initiative
                ? `${d.initiative.initiative} — ${d.initiative.title}`
                : '— (unparented)'}
            </td>
          </tr>
          <tr>
            <td>Member tickets</td>
            <td>{d.tickets.length}</td>
          </tr>
          <tr>
            <td>Accepted</td>
            <td>{d.acceptance.accepted ? `yes (${d.acceptance.by})` : 'no'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function RequirementsTab({ d }: { d: FeatureDetail }) {
  const { primary, edges } = d.requirements;
  return (
    <div className="panel">
      <h2>Requirement links</h2>
      <p className="muted">
        Multi-RS links with one primary — edges out of the feature subject.
        Suggested links are labeled, never treated as verified.
      </p>
      {edges.length === 0 && (
        <Empty label="No requirement links recorded for this feature." />
      )}
      <table>
        <thead>
          <tr>
            <th>role</th>
            <th>predicate</th>
            <th>object</th>
            <th>verification</th>
            <th>valid_at</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((e) => (
            <tr key={`${e.predicate}:${e.object}`}>
              <td>
                {primary &&
                e.predicate === primary.predicate &&
                e.object === primary.object ? (
                  <span className="badge">primary</span>
                ) : (
                  ''
                )}
              </td>
              <td>{e.predicate}</td>
              <td>{e.object}</td>
              <td>{e.verification ?? 'explicit'}</td>
              <td>{e.valid_at ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DesignTab({ ws, d }: { ws: string; d: FeatureDetail }) {
  const [sel, setSel] = useState<string | null>(null);
  const doc = useLoad(
    () =>
      sel
        ? client.featureDoc(ws, d.feature.feature, sel)
        : Promise.resolve(null as DocResponse | null),
    [ws, d.feature.feature, sel],
  );
  const designDocs = d.docs.filter((x) =>
    ['feature.md', 'vs.md', 'mockup.json', 'adr.md', 'ac.md'].includes(x.doc),
  );
  return (
    <div className="panel">
      <h2>Design docs</h2>
      {designDocs.length === 0 && (
        <Empty label="No design docs (feature.md / vs.md / mockup.json / adr.md) yet." />
      )}
      <table>
        <thead>
          <tr>
            <th>doc</th>
            <th>version</th>
            <th>edited_by</th>
            <th>updated</th>
          </tr>
        </thead>
        <tbody>
          {designDocs.map((x) => (
            <tr key={x.doc}>
              <td>
                <button
                  type="button"
                  className="link"
                  onClick={() => setSel(x.doc)}
                >
                  {x.doc}
                </button>
              </td>
              <td>v{x.version}</td>
              <td>{x.edited_by ?? '—'}</td>
              <td>{x.created_at ? `${fmtAge(x.created_at)} ago` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sel && (
        <div className="panel">
          <h3>{sel}</h3>
          {doc.loading && <Loading />}
          {doc.error != null && <ErrorBox error={doc.error} />}
          {doc.data && (
            <>
              <Markdown text={doc.data.content} />
              {doc.data.diffs.length > 0 && (
                <details>
                  <summary>Version diffs ({doc.data.diffs.length})</summary>
                  {doc.data.diffs.map((x) => (
                    <div key={x.from + x.to}>
                      <h4>
                        {x.from} → {x.to}
                      </h4>
                      <DiffView diff={x.diff} />
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ticketLink(ws: string, t: TicketRow) {
  return `/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(t.ticket_id)}`;
}

function TicketsTab({ ws, d }: { ws: string; d: FeatureDetail }) {
  const types = Object.keys(d.tickets_by_type).sort();
  return (
    <div className="panel">
      <h2>Tickets</h2>
      {d.tickets.length === 0 && (
        <Empty label="No member tickets — the feature has no delivery work yet." />
      )}
      {types.map((wt) => (
        <div key={wt}>
          <h3>
            {wt}{' '}
            <span className="muted">
              (
              {Object.entries(d.tickets_by_type[wt] ?? {})
                .map(([s, n]) => `${n} ${s}`)
                .join(', ')}
              )
            </span>
          </h3>
          <table>
            <tbody>
              {d.tickets
                .filter((t) => (t.work_type ?? 'untyped') === wt)
                .map((t) => (
                  <tr key={t.ticket_id}>
                    <td>
                      <Link to={ticketLink(ws, t)}>{t.ticket_id}</Link>
                    </td>
                    <td>{t.title}</td>
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                    <td>{t.priority}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function QualityTab({ ws, d }: { ws: string; d: FeatureDetail }) {
  const acs = useLoad(
    () => client.featureAcs(ws, d.feature.feature),
    [ws, d.feature.feature],
  );
  const corrections = d.tickets.filter(
    (t) =>
      t.work_type === 'bug' ||
      t.origin === 'review' ||
      t.origin === 'ai-finding',
  );
  return (
    <div className="panel">
      <h2>AC evidence matrix</h2>
      {acs.loading && <Loading />}
      {acs.error != null && <ErrorBox error={acs.error} />}
      {acs.data && acs.data.acs.length === 0 && (
        <Empty label="No ac.md slice — the feature has no parsed acceptance criteria." />
      )}
      {acs.data && acs.data.acs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>ac_id</th>
              <th>criterion</th>
              <th>verified</th>
              <th>evidence</th>
            </tr>
          </thead>
          <tbody>
            {acs.data.acs.map((a: FeatureAcRow) => (
              <tr key={a.ac_id}>
                <td>{a.ac_id}</td>
                <td>{a.criterion}</td>
                <td>{a.verified ? 'verified' : 'unverified'}</td>
                <td>
                  {a.evidence.length === 0
                    ? '—'
                    : a.evidence
                        .map(
                          (e) =>
                            `${e.predicate}→${e.object}${e.verification ? ` (${e.verification})` : ''}`,
                        )
                        .join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Open findings</h2>
      <FindingsList findings={d.health} />

      <h2>Correction tickets</h2>
      {corrections.length === 0 ? (
        <Empty label="No bug/review-origin correction tickets." />
      ) : (
        <table>
          <tbody>
            {corrections.map((t) => (
              <tr key={t.ticket_id}>
                <td>
                  <Link to={ticketLink(ws, t)}>{t.ticket_id}</Link>
                </td>
                <td>{t.title}</td>
                <td>{t.work_type ?? '—'}</td>
                <td>
                  <StatusBadge status={t.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReleaseTab({
  ws,
  d,
  onDone,
}: {
  ws: string;
  d: FeatureDetail;
  onDone: () => void;
}) {
  const pkg = useLoad(
    () => client.featureAcceptance(ws, d.feature.feature),
    [ws, d.feature.feature, d.feature.status],
  );
  const [exclusions, setExclusions] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const accept = async () => {
    setBusy(true);
    setErr(null);
    try {
      await client.featureAccept(ws, d.feature.feature, {
        expected_status: d.feature.status,
        exclusions: exclusions
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const p = pkg.data as AcceptancePackage | null;
  return (
    <div className="panel">
      <h2>Release membership</h2>
      {d.release.memberships.length === 0 && (
        <Empty label="Not assigned to any release — assignment requires acceptance below." />
      )}
      <table>
        <tbody>
          {d.release.memberships.map((m) => (
            <tr key={m.release.release_id}>
              <td>{m.release.release_id}</td>
              <td>{m.release.title}</td>
              <td>
                <StatusBadge status={m.release.status} />
              </td>
              <td>{m.item.delivery_state}</td>
              <td>
                {m.item.removed_at
                  ? `removed ${fmtAge(m.item.removed_at)} ago`
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Exposure</h2>
      {d.release.exposure.length === 0 ? (
        <Empty label="No environment exposure recorded." />
      ) : (
        <table>
          <tbody>
            {d.release.exposure.map((x) => (
              <tr key={x.environment}>
                <td>{x.environment}</td>
                <td>{x.state}</td>
                <td>{x.deployment_id ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Deployments</h2>
      {d.release.deployments.length === 0 ? (
        <Empty label="No deployments recorded." />
      ) : (
        <table>
          <tbody>
            {d.release.deployments.map((x) => (
              <tr key={x.deployment_id}>
                <td>{x.deployment_id}</td>
                <td>{x.release_id}</td>
                <td>{x.environment}</td>
                <td>
                  {x.confirmed_at
                    ? `confirmed by ${x.confirmed_by ?? '?'} ${fmtAge(x.confirmed_at)} ago`
                    : 'unconfirmed'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Feature Acceptance Package</h2>
      {pkg.loading && <Loading />}
      {pkg.error != null && <ErrorBox error={pkg.error} />}
      {p && (
        <>
          <table>
            <tbody>
              <tr>
                <td>Scope doc</td>
                <td>
                  {p.scope.doc ? `feature.md v${p.scope.doc.version}` : 'none'}
                  {p.scope.approved_at
                    ? ` — approved by ${p.scope.approved_by} ${fmtAge(p.scope.approved_at)} ago`
                    : ' (never approved)'}
                </td>
              </tr>
              <tr>
                <td>Acceptance criteria</td>
                <td>
                  {p.acceptance_criteria.length === 0
                    ? 'none parsed'
                    : `${p.acceptance_criteria.filter((a) => a.verified).length}/${p.acceptance_criteria.length} verified`}
                </td>
              </tr>
              <tr>
                <td>Member tickets</td>
                <td>
                  {p.tickets.length === 0
                    ? 'none'
                    : `${p.tickets.filter((t) => t.delivered).length}/${p.tickets.length} delivered`}
                </td>
              </tr>
            </tbody>
          </table>
          <h3>Findings (visible to the human judging this package)</h3>
          <FindingsList findings={p.findings} />
          {p.accepted ? (
            <p>
              Accepted by {p.accepted.by} {fmtAge(p.accepted.at)} ago
              {p.accepted.exclusions.length > 0 &&
                ` — exclusions: ${p.accepted.exclusions.join('; ')}`}
            </p>
          ) : (
            <div className="accept-box">
              <label htmlFor="feature-exclusions">
                Known exclusions (one per line — recorded verbatim):
              </label>
              <textarea
                id="feature-exclusions"
                rows={3}
                value={exclusions}
                onChange={(e) => setExclusions(e.target.value)}
              />
              {err != null && <ErrorBox error={err} />}
              <button type="button" disabled={busy} onClick={accept}>
                Accept feature (gate to release assignment)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
