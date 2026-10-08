/**
 * S-22 — Release Center (DELIVERY §3–§7, wp-137).
 *
 * Release list (`/releases`) + detail (`/releases/:ws/:rel`):
 * scope membership (feature/ticket, partial-AC badge), immutable
 * manifest cuts, the five release gates (manifest/approved/merged/
 * partial-ac/corrections), human approve/reject bound to the latest
 * digest, freeze + ship writes (expected_status OCC), manual
 * deployment evidence (invariant 4), per-feature exposure control,
 * three-audience notes draft→approve→publish, and the retro trigger +
 * retro.md view.
 *
 * AI output is ai-suggested until a human approval event exists —
 * draft notes render visually distinct from approved/published notes.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  type DocResponse,
  type ReleaseDetail,
  type ReleaseNoteAudience,
  client,
} from '../api';
import {
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Markdown,
  StatusBadge,
  TabPanel,
  Tabs,
  fmtAge,
} from '../components';
import { useLoad, useStreamRefresh } from '../hooks';
import { projectPath, useProject } from '../project';

const AUDIENCES: ReleaseNoteAudience[] = [
  'customer',
  'stakeholder',
  'technical',
];

const GATE_ORDER = [
  'manifest',
  'approved',
  'merged',
  'partial-ac',
  'corrections',
] as const;

/** statuses in which scope is editable (DELIVERY §4.1). */
const SCOPE_MUTABLE = new Set(['draft', 'ready', 'approved']);

// ---------------------------------------------------------------------------
// list view — /releases
// ---------------------------------------------------------------------------

export default function ReleaseCenter() {
  const ws = useProject();
  const { rel } = useParams();

  if (rel) return <ReleaseDetailView ws={ws} rel={rel} />;

  return (
    <section>
      <h1 className="page-title">Release Center</h1>
      <p className="page-sub">
        draft → ready → approved → released → closed (DELIVERY §3).
      </p>
      <ReleaseList ws={ws} />
    </section>
  );
}

function ReleaseList({ ws }: { ws: string }) {
  const state = useLoad(() => client.releases(ws), [ws]);
  useStreamRefresh(state.reload, [
    'release_created',
    'release_items_changed',
    'manifest_cut',
    'release_approved',
    'release_released',
  ]);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const nav = useNavigate();

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await client.createRelease(ws, {
        title,
        ...(target ? { target } : {}),
      });
      nav(
        projectPath(
          ws,
          `/releases/${encodeURIComponent(r.release.release_id)}`,
        ),
      );
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };

  return (
    <>
      {state.loading && <Loading />}
      {state.error != null && <ErrorBox error={state.error} />}
      {state.data && state.data.releases.length === 0 && (
        <Empty label="No releases yet — create the first draft below." />
      )}
      {(state.data?.releases ?? []).map((r) => (
        <div className="card" key={r.release_id}>
          <div className="card-title">
            <strong>
              <Link
                to={projectPath(
                  ws,
                  `/releases/${encodeURIComponent(r.release_id)}`,
                )}
              >
                {r.release_id}
              </Link>{' '}
              — {r.title}
            </strong>
            <StatusBadge status={r.status} />
            {r.target && <span className="badge">{r.target}</span>}
            <span className="spacer" />
            <span className="muted">{fmtAge(r.created_at ?? '')} ago</span>
          </div>
        </div>
      ))}
      <h2 className="group-title">New release</h2>
      {err != null && <ErrorBox error={err} />}
      <div className="row">
        <Field label="title">
          <input
            aria-label="release title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="target">
          <input
            aria-label="release target"
            placeholder="v1.4 / 2026-11 train"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
        <button
          type="button"
          className="primary"
          disabled={busy || !title.trim()}
          onClick={() => void create()}
        >
          Create draft
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// detail view
// ---------------------------------------------------------------------------

type TabId = 'scope' | 'gates' | 'deploy' | 'notes' | 'retro';

function ReleaseDetailView({ ws, rel }: { ws: string; rel: string }) {
  const detail = useLoad(() => client.releaseDetail(ws, rel), [ws, rel]);
  useStreamRefresh(detail.reload, [
    'release_items_changed',
    'manifest_cut',
    'release_approved',
    'release_released',
    'deployment_confirmed',
    'feature_exposed',
    'release_note_approved',
    'retro_completed',
    'run_status',
  ]);
  const [tab, setTab] = useState<TabId>('scope');

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  const d = detail.data;
  if (!d) return <Empty />;
  const r = d.release;
  // A re-cut or a `rejected` decision leaves stale approvals behind —
  // `approvals` (bound to the latest manifest) is what counts.
  const approvedOnCurrent = d.approvals.filter(
    (a) => a.decision === 'approved',
  );
  const staleApprovals = d.approvalHistory.length - d.approvals.length;

  const tabs: { id: TabId; label: string }[] = [
    { id: 'scope', label: 'Scope & manifest' },
    { id: 'gates', label: 'Gates & approvals' },
    { id: 'deploy', label: 'Deployments & exposure' },
    { id: 'notes', label: 'Notes' },
    { id: 'retro', label: 'Retro' },
  ];

  return (
    <section>
      <p className="page-sub" style={{ marginBottom: 2 }}>
        <Link to={projectPath(ws, '/releases')}>← Release Center</Link>
      </p>
      <h1 className="page-title">
        {r.release_id} — {r.title}
      </h1>
      <p className="page-sub">
        <StatusBadge status={r.status} /> {ws} · target {r.target ?? '—'} ·
        manifest{' '}
        {d.manifest
          ? `v${d.manifest.version} (${d.manifest.digest.slice(0, 12)}…)`
          : 'not cut'}
        {staleApprovals > 0 && (
          <span
            className="badge spec-warn"
            title="approvals bound to superseded manifest versions"
          >
            {' '}
            {staleApprovals} stale approval{staleApprovals === 1 ? '' : 's'}
          </span>
        )}
      </p>

      <ReleaseActions
        ws={ws}
        d={d}
        onDone={detail.reload}
        onGotoGates={() => setTab('gates')}
      />

      <Tabs
        ariaLabel="release sections"
        active={tab}
        onChange={(x) => setTab(x as TabId)}
        tabs={tabs}
      />
      <TabPanel id={tab}>
        {tab === 'scope' && <ScopeTab ws={ws} d={d} onDone={detail.reload} />}
        {tab === 'gates' && (
          <GatesTab
            ws={ws}
            d={d}
            approved={approvedOnCurrent}
            onDone={detail.reload}
          />
        )}
        {tab === 'deploy' && <DeployTab ws={ws} d={d} onDone={detail.reload} />}
        {tab === 'notes' && <NotesTab ws={ws} d={d} onDone={detail.reload} />}
        {tab === 'retro' && <RetroTab ws={ws} d={d} onDone={detail.reload} />}
      </TabPanel>
    </section>
  );
}

// ---------------------------------------------------------------------------
// lifecycle actions
// ---------------------------------------------------------------------------

function ReleaseActions({
  ws,
  d,
  onDone,
  onGotoGates,
}: {
  ws: string;
  d: ReleaseDetail;
  onDone: () => void;
  onGotoGates: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const r = d.release;

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card next-action">
      <div className="card-title">
        <strong>Next action</strong>
      </div>
      {err != null && <ErrorBox error={err} />}
      <div className="row">
        {r.status === 'draft' && (
          <button
            type="button"
            className="primary"
            disabled={busy || d.items.length === 0}
            title={
              d.items.length === 0
                ? 'add scope items first — freeze on empty scope is refused'
                : 'cut an immutable manifest (draft → ready)'
            }
            onClick={() =>
              void call(() => client.freezeRelease(ws, r.release_id, r.status))
            }
          >
            Freeze manifest
          </button>
        )}
        {r.status === 'approved' && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            title="ship — all five release gates must pass"
            onClick={() =>
              void call(() => client.shipRelease(ws, r.release_id, r.status))
            }
          >
            Ship release
          </button>
        )}
        {(r.status === 'released' || r.status === 'closed') && (
          <button
            type="button"
            disabled={busy}
            title="queue a retro run on this release"
            onClick={() =>
              void call(() => client.retroRelease(ws, r.release_id))
            }
          >
            Run retrospective
          </button>
        )}
        {SCOPE_MUTABLE.has(r.status) && (
          <span className="muted">
            Scope is editable — a post-freeze change re-cuts the manifest and
            drops approvals (invariant 3).
          </span>
        )}
        {r.status === 'ready' && (
          <span className="muted">
            Awaiting human approval —{' '}
            <button type="button" className="link" onClick={onGotoGates}>
              Gates tab →
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scope & manifest
// ---------------------------------------------------------------------------

function ScopeTab({
  ws,
  d,
  onDone,
}: {
  ws: string;
  d: ReleaseDetail;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<'feature' | 'ticket'>('feature');
  const [itemId, setItemId] = useState('');
  const [partialAc, setPartialAc] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [confirmRemove, setConfirmRemove] = useState<{
    kind: string;
    id: string;
  } | null>(null);
  const r = d.release;
  const editable = SCOPE_MUTABLE.has(r.status);
  const live = d.items.filter((i) => !i.removed_at);
  const removed = d.items.filter((i) => i.removed_at);

  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      const partial = partialAc
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await client.addReleaseItem(ws, r.release_id, {
        item_kind: kind,
        item_id: itemId.trim(),
        ...(partial.length ? { partial_ac: partial } : {}),
        ...(partial.length ? { approved_by: approvedBy.trim() } : {}),
        expected_status: r.status,
      });
      setItemId('');
      setPartialAc('');
      setApprovedBy('');
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (itemKind: string, itemIdv: string) => {
    setBusy(true);
    setErr(null);
    try {
      await client.removeReleaseItem(ws, r.release_id, {
        item_kind: itemKind as 'feature' | 'ticket',
        item_id: itemIdv,
        expected_status: r.status,
      });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {err != null && <ErrorBox error={err} />}
      <h2 className="group-title">Scope — {live.length} item(s)</h2>
      {live.length === 0 && <Empty label="Empty scope — add an item below." />}
      {live.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>kind</th>
              <th>item</th>
              <th>delivery</th>
              <th>partial AC</th>
              <th>added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live.map((i) => (
              <tr key={`${i.item_kind}:${i.item_id}`}>
                <td>{i.item_kind}</td>
                <td>
                  {i.item_kind === 'ticket' ? (
                    <Link
                      to={projectPath(
                        ws,
                        `/tickets/${encodeURIComponent(i.item_id)}`,
                      )}
                    >
                      {i.item_id}
                    </Link>
                  ) : (
                    <Link
                      to={projectPath(
                        ws,
                        `/features/${encodeURIComponent(i.item_id)}`,
                      )}
                    >
                      {i.item_id}
                    </Link>
                  )}
                </td>
                <td>
                  <span className={`badge delivery-${i.delivery_state}`}>
                    {i.delivery_state}
                  </span>
                </td>
                <td>
                  {i.partial_ac && i.partial_ac.length > 0 ? (
                    <span
                      className="badge spec-warn"
                      title={`partial release — approved by ${i.approved_by ?? '?'}`}
                    >
                      partial ({i.partial_ac.join(', ')})
                    </span>
                  ) : (
                    'full'
                  )}
                </td>
                <td className="muted">
                  {i.added_by ?? '—'}
                  {i.added_at ? ` · ${fmtAge(i.added_at)} ago` : ''}
                </td>
                <td>
                  {editable && (
                    <button
                      type="button"
                      className="small danger"
                      disabled={busy}
                      onClick={() =>
                        setConfirmRemove({ kind: i.item_kind, id: i.item_id })
                      }
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {removed.length > 0 && (
        <p className="muted">
          {removed.length} removed item(s) retained for audit.
        </p>
      )}

      {editable && (
        <>
          <h3 className="group-title">Add item</h3>
          <div className="row">
            <select
              aria-label="item kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'feature' | 'ticket')}
            >
              <option value="feature">feature</option>
              <option value="ticket">ticket</option>
            </select>
            <input
              aria-label="item id"
              placeholder="F-0001 or SR-1234"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
            />
            <input
              aria-label="partial ACs"
              placeholder="partial ACs (csv, optional)"
              value={partialAc}
              onChange={(e) => setPartialAc(e.target.value)}
            />
            {partialAc.trim() && (
              <input
                aria-label="partial approved by"
                placeholder="approved_by (required for partial)"
                value={approvedBy}
                onChange={(e) => setApprovedBy(e.target.value)}
              />
            )}
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                !itemId.trim() ||
                (!!partialAc.trim() && !approvedBy.trim())
              }
              onClick={() => void add()}
            >
              Add
            </button>
          </div>
        </>
      )}

      <h3 className="group-title">Manifest cuts</h3>
      {d.manifests.length === 0 ? (
        <Empty label="No manifest cut yet — freeze scope to cut v1." />
      ) : (
        d.manifests.map((m) => (
          <div className="card" key={m.version}>
            <div className="card-title">
              <strong>
                v{m.version}{' '}
                {d.manifest?.version === m.version && (
                  <span className="badge spec-good">latest</span>
                )}
              </strong>
              <span className="mono muted">{m.digest.slice(0, 16)}…</span>
              <span className="spacer" />
              <span className="muted">{fmtAge(m.created_at ?? '')} ago</span>
            </div>
            <ul>
              {m.items.map((it) => (
                <li key={`${it.item_kind}:${it.item_id}`}>
                  {it.item_kind} {it.item_id}
                  {it.partial_ac?.length
                    ? ` (partial: ${it.partial_ac.join(', ')})`
                    : ''}
                  {' — '}
                  {it.repos
                    .map(
                      (repo) =>
                        `${repo.repo}${repo.ticket ? `/${repo.ticket}` : ''}@${
                          repo.merged_sha
                            ? repo.merged_sha.slice(0, 8)
                            : 'unmerged'
                        }`,
                    )
                    .join(', ') || 'no repos'}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${confirmRemove.id} from scope?`}
          body={
            r.status === 'draft'
              ? 'Drops the item from the release scope.'
              : 'Post-freeze removal re-cuts the manifest and drops all approvals bound to the current cut (invariant 3).'
          }
          confirmLabel="Remove"
          danger
          busy={busy}
          onConfirm={() => {
            const c = confirmRemove;
            setConfirmRemove(null);
            void remove(c.kind, c.id);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gates & approvals
// ---------------------------------------------------------------------------

export function gateTone(result: string | undefined): string {
  if (result === 'pass') return 'spec-good';
  if (result === 'waived') return 'spec-warn';
  if (result === 'fail') return 'spec-bad';
  return 'spec-warn'; // unchecked — unknown is never green
}

function GatesTab({
  ws,
  d,
  approved,
  onDone,
}: {
  ws: string;
  d: ReleaseDetail;
  approved: ReleaseDetail['approvals'];
  onDone: () => void;
}) {
  const [rationale, setRationale] = useState('');
  const [approver, setApprover] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const r = d.release;
  const approvable = r.status === 'ready' || r.status === 'approved';

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setErr(null);
    try {
      await client.approveRelease(ws, r.release_id, {
        decision,
        ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
        ...(approver.trim() ? { approver: approver.trim() } : {}),
        expected_status: r.status,
      });
      setRationale('');
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {err != null && <ErrorBox error={err} />}
      <h2 className="group-title">Release gates</h2>
      <div className="row">
        {GATE_ORDER.map((g) => {
          const v = d.gates[g];
          return (
            <span
              key={g}
              className={`badge ${gateTone(v?.result)}`}
              title={
                v
                  ? `checked ${fmtAge(v.checked_at)} ago`
                  : 'not yet evaluated — gates run on ship'
              }
            >
              {g}: {v?.result ?? 'unchecked'}
            </span>
          );
        })}
      </div>
      {!d.manifest && (
        <p className="muted">
          No manifest cut — gates evaluate at ship time against the latest cut.
        </p>
      )}

      <h3 className="group-title">
        Approvals on manifest v{d.manifest?.version ?? '—'}
      </h3>
      {d.approvals.length === 0 ? (
        <Empty label="No approvals bound to the current cut." />
      ) : (
        <table className="table">
          <tbody>
            {d.approvals.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only audit rows have no id
              <tr key={i}>
                <td>
                  <span
                    className={`badge ${a.decision === 'approved' ? 'spec-good' : 'spec-bad'}`}
                  >
                    {a.decision}
                  </span>
                </td>
                <td>{a.approver}</td>
                <td className="muted">{a.rationale ?? '—'}</td>
                <td className="muted">
                  {a.created_at ? fmtAge(a.created_at) : '—'} ago
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.approvalHistory.length > d.approvals.length && (
        <p className="muted">
          {d.approvalHistory.length - d.approvals.length} decision(s) on
          superseded manifest versions — stale approvals do not count (invariant
          3).
        </p>
      )}

      {approvable && (
        <div>
          <h3 className="group-title">Decide</h3>
          <div className="row">
            <input
              aria-label="approver"
              placeholder="approver (defaults to you)"
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
            />
            <input
              aria-label="rationale"
              placeholder="rationale"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={busy || !d.manifest}
              onClick={() => void decide('approved')}
            >
              Approve manifest v{d.manifest?.version}
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void decide('rejected')}
            >
              Reject → draft
            </button>
          </div>
        </div>
      )}
      {approved.length > 0 && r.status === 'approved' && (
        <p className="muted">
          Approved on v{d.manifest?.version} — ship from the action panel when
          all gates pass.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deployments & feature exposure
// ---------------------------------------------------------------------------

function DeployTab({
  ws,
  d,
  onDone,
}: {
  ws: string;
  d: ReleaseDetail;
  onDone: () => void;
}) {
  const [env, setEnv] = useState('');
  const [sha, setSha] = useState('');
  const [by, setBy] = useState('');
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const r = d.release;
  const deployable = r.status === 'released' || r.status === 'closed';
  const features = d.items.filter(
    (i) => i.item_kind === 'feature' && !i.removed_at,
  );

  const record = async () => {
    setBusy(true);
    setErr(null);
    try {
      await client.recordDeployment(ws, r.release_id, {
        env: env.trim(),
        sha: sha.trim(),
        evidence: {
          type: 'manual',
          by: by.trim(),
          note: note.trim(),
          url: url.trim(),
        },
      });
      setEnv('');
      setSha('');
      setNote('');
      setUrl('');
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {err != null && <ErrorBox error={err} />}
      <h2 className="group-title">Deployments</h2>
      {d.deployments.length === 0 ? (
        <Empty label="No confirmed deployments." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>env</th>
              <th>sha</th>
              <th>evidence</th>
              <th>confirmed</th>
            </tr>
          </thead>
          <tbody>
            {d.deployments.map((dep) => (
              <tr key={dep.deployment_id}>
                <td>{dep.environment}</td>
                <td className="mono">{dep.sha.slice(0, 8)}</td>
                <td>
                  {dep.evidence.type}: {dep.evidence.note}
                  {dep.evidence.url ? (
                    /^https?:/i.test(dep.evidence.url) ? (
                      <>
                        {' '}
                        <a href={dep.evidence.url} rel="noreferrer">
                          link
                        </a>
                      </>
                    ) : (
                      // Same policy as renderMarkdown links — only
                      // http(s) URLs become anchors (no javascript:).
                      <span className="muted"> {dep.evidence.url}</span>
                    )
                  ) : null}
                </td>
                <td className="muted">
                  {dep.confirmed_by ?? '—'}
                  {dep.confirmed_at ? ` · ${fmtAge(dep.confirmed_at)} ago` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deployable && (
        <>
          <h3 className="group-title">Record a deployment (manual evidence)</h3>
          <div className="row">
            <input
              aria-label="env"
              placeholder="env (staging/prod)"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            />
            <input
              aria-label="sha"
              placeholder="deployed sha"
              value={sha}
              onChange={(e) => setSha(e.target.value)}
            />
            <input
              aria-label="by"
              placeholder="confirmed by"
              value={by}
              onChange={(e) => setBy(e.target.value)}
            />
            <input
              aria-label="note"
              placeholder="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <input
              aria-label="url"
              placeholder="evidence url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                !env.trim() ||
                !sha.trim() ||
                !by.trim() ||
                !note.trim() ||
                !url.trim()
              }
              title="all evidence fields are required (invariant 4)"
              onClick={() => void record()}
            >
              Record
            </button>
          </div>
        </>
      )}
      {!deployable && (
        <p className="muted">
          Deployments attach to released|closed work — ship first.
        </p>
      )}

      {features.length > 0 && (
        <>
          <h3 className="group-title">Feature exposure</h3>
          {features.map((f) => (
            <ExposureControl
              key={f.item_id}
              ws={ws}
              feature={f.item_id}
              deployments={d.deployments}
              onDone={onDone}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ExposureControl({
  ws,
  feature,
  deployments,
  onDone,
}: {
  ws: string;
  feature: string;
  deployments: ReleaseDetail['deployments'];
  onDone: () => void;
}) {
  const [env, setEnv] = useState('');
  const [state, setState] = useState<'hidden' | 'limited' | 'available'>(
    'hidden',
  );
  const [audience, setAudience] = useState('');
  const [deploymentId, setDeploymentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const set = async () => {
    setBusy(true);
    setErr(null);
    try {
      await client.setFeatureExposure(ws, feature, {
        env: env.trim(),
        state,
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(deploymentId ? { deployment_id: deploymentId } : {}),
      });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title">
        <strong>
          <Link
            to={projectPath(ws, `/features/${encodeURIComponent(feature)}`)}
          >
            {feature}
          </Link>
        </strong>
      </div>
      {err != null && <ErrorBox error={err} />}
      <div className="row">
        <input
          aria-label="exposure env"
          placeholder="env"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
        />
        <select
          aria-label="exposure state"
          value={state}
          onChange={(e) => setState(e.target.value as typeof state)}
        >
          <option value="hidden">hidden</option>
          <option value="limited">limited</option>
          <option value="available">available</option>
        </select>
        <input
          aria-label="exposure audience"
          placeholder="audience (optional)"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
        />
        {state === 'available' && (
          <select
            aria-label="deployment"
            value={deploymentId}
            onChange={(e) => setDeploymentId(e.target.value)}
          >
            <option value="">link confirmed deployment…</option>
            {deployments.map((dep) => (
              <option key={dep.deployment_id} value={dep.deployment_id}>
                {dep.environment}@{dep.sha.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="primary"
          disabled={
            busy || !env.trim() || (state === 'available' && !deploymentId)
          }
          title={
            state === 'available'
              ? 'available requires a confirmed deployment of a release carrying this feature in the same env (invariant 4)'
              : undefined
          }
          onClick={() => void set()}
        >
          Set exposure
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes — draft → human approve → publish, per audience (DELIVERY §5)
// ---------------------------------------------------------------------------

/** Note state for an audience: draft (unapproved / newer than the
 *  approved pin), approved (pinned doc_version), published. Distinct
 *  visuals are load-bearing — ai-suggested never looks shipped. */
export function noteState(
  note: ReleaseDetail['notes'][number] | undefined,
  draft: { version: number } | null | undefined,
): 'none' | 'draft' | 'unapproved-draft' | 'approved' | 'published' {
  if (note?.published_at) return 'published';
  if (!draft) return 'none';
  if (!note?.doc_version) return 'draft';
  return draft.version > note.doc_version ? 'unapproved-draft' : 'approved';
}

const NOTE_LABEL: Record<ReturnType<typeof noteState>, string> = {
  none: 'no draft',
  draft: 'draft — unapproved',
  'unapproved-draft': 'newer draft — approval stale',
  approved: 'approved',
  published: 'published',
};

function NotesTab({
  ws,
  d,
  onDone,
}: {
  ws: string;
  d: ReleaseDetail;
  onDone: () => void;
}) {
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const r = d.release;

  const draftRun = async () => {
    setBusy(true);
    setErr(null);
    try {
      await client.draftReleaseNotes(ws, r.release_id);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {err != null && <ErrorBox error={err} />}
      <div className="row">
        <button
          type="button"
          disabled={busy || !d.manifest}
          title={
            d.manifest
              ? 'queue a release-notes run — drafts all three audiences from the frozen manifest'
              : 'freeze a manifest first — notes describe the approved cut'
          }
          onClick={() => void draftRun()}
        >
          Draft notes (AI)
        </button>
        <span className="muted">
          AI drafts are ai-suggested until a human approves per audience
          (invariant 6).
        </span>
      </div>
      {AUDIENCES.map((a) => (
        <NotePanel key={a} ws={ws} d={d} audience={a} onDone={onDone} />
      ))}
    </div>
  );
}

function NotePanel({
  ws,
  d,
  audience,
  onDone,
}: {
  ws: string;
  d: ReleaseDetail;
  audience: ReleaseNoteAudience;
  onDone: () => void;
}) {
  const doc = useLoad(
    () =>
      client
        .releaseDoc(ws, d.release.release_id, `notes-${audience}`)
        .catch((e: unknown) =>
          e instanceof Error &&
          'status' in e &&
          (e as { status: number }).status === 404
            ? null
            : Promise.reject(e),
        ),
    [ws, d.release.release_id, audience, d.noteDrafts[audience]?.version],
  );
  const [edit, setEdit] = useState<string | null>(null);
  const [approver, setApprover] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const note = d.notes.find((n) => n.audience === audience);
  const draft = d.noteDrafts[audience];
  const st = noteState(note, draft);

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setEdit(null);
      doc.reload();
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title">
        <strong>{audience}</strong>
        <span
          className={`badge ${st === 'published' ? 'spec-good' : st === 'approved' ? '' : 'spec-warn'}`}
        >
          {NOTE_LABEL[st]}
        </span>
        {note?.doc_version != null && (
          <span className="muted">approved v{note.doc_version}</span>
        )}
        {draft && <span className="muted">draft v{draft.version}</span>}
        <span className="spacer" />
        <input
          aria-label={`${audience} approver`}
          placeholder="approver"
          value={approver}
          onChange={(e) => setApprover(e.target.value)}
          style={{ width: 140 }}
        />
        <button
          type="button"
          className="small"
          disabled={busy || !draft}
          title="pin the current draft as the approved doc_version"
          onClick={() =>
            void call(() =>
              client.approveReleaseNote(
                ws,
                d.release.release_id,
                audience,
                approver.trim() || undefined,
              ),
            )
          }
        >
          Approve
        </button>
        <button
          type="button"
          className="small"
          disabled={busy || st === 'published' || note?.doc_version == null}
          title="publish requires a human-approved doc_version"
          onClick={() =>
            void call(() =>
              client.publishReleaseNote(ws, d.release.release_id, audience),
            )
          }
        >
          Publish
        </button>
      </div>
      {err != null && <ErrorBox error={err} />}
      {doc.loading && <Loading />}
      {doc.error != null && <ErrorBox error={doc.error} />}
      {doc.data === null && <Empty label="No draft yet." />}
      {doc.data && edit === null && (
        <>
          <Markdown text={doc.data.content} />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="small"
              onClick={() => setEdit(doc.data?.content ?? '')}
            >
              Edit draft
            </button>
          </div>
        </>
      )}
      {edit !== null && (
        <div>
          <textarea
            aria-label={`${audience} notes draft`}
            rows={12}
            style={{ width: '100%' }}
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
          />
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !edit.trim()}
              title="append a new doc_version — the pinned approved revision never mutates"
              onClick={() =>
                void call(() =>
                  client.saveReleaseNoteDraft(
                    ws,
                    d.release.release_id,
                    audience,
                    edit,
                  ),
                )
              }
            >
              Save draft
            </button>
            <button
              type="button"
              className="small"
              onClick={() => setEdit(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retro — trigger the run, render retro.md when it lands
// ---------------------------------------------------------------------------

function RetroTab({
  ws,
  d,
  onDone,
}: {
  ws: string;
  d: ReleaseDetail;
  onDone: () => void;
}) {
  const retroable =
    d.release.status === 'released' || d.release.status === 'closed';
  const doc = useLoad(
    () =>
      retroable
        ? client
            .releaseDoc(ws, d.release.release_id, 'retro')
            .catch((e: unknown) =>
              e instanceof Error &&
              'status' in e &&
              (e as { status: number }).status === 404
                ? null
                : Promise.reject(e),
            )
        : Promise.resolve(null),
    [ws, d.release.release_id, retroable, d.release.updated_at],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await client.retroRelease(ws, d.release.release_id);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {err != null && <ErrorBox error={err} />}
      {!retroable && (
        <Empty label="Retrospectives run on released|closed releases." />
      )}
      {retroable && (
        <>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void run()}>
              Run retrospective
            </button>
            <span className="muted">
              compares delivered behavior vs the approved RS scope and KPI
              outcomes; proposals land as draft board items.
            </span>
          </div>
          {doc.loading && <Loading />}
          {doc.error != null && <ErrorBox error={doc.error} />}
          {doc.data === null && (
            <Empty label="No retro.md yet — run the retrospective." />
          )}
          {doc.data && <RetroDoc doc={doc.data} />}
        </>
      )}
    </div>
  );
}

function RetroDoc({ doc }: { doc: DocResponse }) {
  return (
    <div className="card">
      <div className="card-title">
        <strong>retro.md — v{doc.version}</strong>
      </div>
      <Markdown text={doc.content} />
    </div>
  );
}
