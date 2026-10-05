import type { TicketRow } from '@sprint-runner/core';
/**
 * S-05 — ticket detail: status stepper, tabs (Overview / Documents /
 * Activity / Runs), family rail for split children, right-rail action
 * panel driven by open gates.
 *
 * wp-151 adds the **Ticket Workbench**: per-type tabs (§15.7) rendered
 * from the ticket's taxonomy policy — the tab set comes from the server
 * workbench payload (`WORK_TYPE_POLICIES[work_type].tabs`), never a
 * hardcoded per-type branch.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  type TicketDetail as Detail,
  type Workbench,
  type WorkbenchEvidence,
  client,
} from '../api';
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

/** Per-type workbench tab labels (§15.7). Content sections are matched
 *  case-insensitively against ticket.md headings. */
const WORKBENCH_TAB_META: Record<
  string,
  { label: string; section?: string; doc?: string; hint: string }
> = {
  type: {
    label: 'Type & policy',
    hint: 'work type × origin, per-type intake and completion evidence',
  },
  repro: {
    label: 'Repro',
    section: 'repro',
    hint: 'expected / actual / repro steps + the repro test case',
  },
  telemetry: {
    label: 'Telemetry',
    section: 'telemetry',
    hint: 'logs, error signatures, incident links',
  },
  findings: {
    label: 'Findings',
    doc: 'notes.md',
    hint: 'the spike output — a notes.md findings doc',
  },
  'migration-checks': {
    label: 'Migration checks',
    section: 'migration',
    hint: 'schema/data change + rollback + migration test plan',
  },
  'ac-design': {
    label: 'ACs & design',
    section: 'acceptance criteria',
    hint: 'acceptance criteria + design (tdd.md)',
  },
};

type BaseTab = 'overview' | 'docs' | 'activity' | 'runs';

export default function TicketDetail() {
  const { ws = '', id = '' } = useParams();
  const state = useLoad(() => client.ticket(ws, id), [ws, id]);
  const [tab, setTab] = useState<BaseTab | string>('overview');
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
  const baseTabs: BaseTab[] = ['overview', 'docs', 'activity', 'runs'];
  // The per-type workbench tabs (empty for unclassified tickets).
  const wbTabs = d.workbench?.tabs ?? [];

  return (
    <section>
      <h1 className="page-title">
        {t.ticket_id} — {t.title} <SpecScore score={t.spec_score} />
      </h1>
      <p className="page-sub">
        {t.workspace} · priority {t.priority}
        {d.workbench?.work_type ? ` · type ${d.workbench.work_type}` : ''}
        {d.workbench?.origin ? ` · origin ${d.workbench.origin}` : ''} · updated{' '}
        {fmtAge(t.updated_at)} ago
        {t.blocked_reason ? ` · blocked: ${t.blocked_reason}` : ''}
      </p>
      <StatusStepper status={t.status} />
      <div className="split">
        <div className="grow">
          <div className="tabs">
            {baseTabs.map((x) => (
              <button
                key={x}
                type="button"
                className={tab === x ? 'active' : ''}
                onClick={() => setTab(x)}
              >
                {x}
              </button>
            ))}
            {wbTabs.map((x) => (
              <button
                key={`wb-${x}`}
                type="button"
                className={tab === `wb-${x}` ? 'active' : ''}
                onClick={() => setTab(`wb-${x}`)}
              >
                {WORKBENCH_TAB_META[x]?.label ?? x}
              </button>
            ))}
          </div>
          {tab === 'overview' && <Overview d={d} />}
          {tab === 'docs' && <DocsTab ws={ws} id={id} />}
          {tab === 'activity' && <ActivityTab ws={ws} id={id} />}
          {tab === 'runs' && <RunsTab ws={ws} id={id} />}
          {typeof tab === 'string' &&
            tab.startsWith('wb-') &&
            d.workbench &&
            (tab === 'wb-type' ? (
              <WorkbenchTypeTab wb={d.workbench} />
            ) : (
              <WorkbenchSectionTab
                tab={tab.slice(3)}
                wb={d.workbench}
                ticketMd={d.ticket_md}
              />
            ))}
        </div>
        <aside className="rail">
          <ActionPanel ws={ws} d={d} onDone={state.reload} />
          <FamilyRail ws={ws} ticket={t} family={d.family} />
        </aside>
      </div>
    </section>
  );
}

/** `## <heading>` body from a markdown doc (case-insensitive), or null. */
function sectionOf(md: string | null, heading: string): string | null {
  if (!md) return null;
  const lines = md.split('\n');
  const want = heading.toLowerCase();
  const start = lines.findIndex(
    (l) =>
      /^##\s+/.test(l) &&
      l
        .replace(/^##\s+/, '')
        .trim()
        .toLowerCase() === want,
  );
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
  return body === '' ? null : body;
}

/** Evidence requirements that belong to a per-type tab (matched on the
 *  policy check, not a per-type branch). */
function tabEvidence(tab: string, wb: Workbench): WorkbenchEvidence[] {
  return wb.evidence.filter((e) => {
    const c = e.check as {
      kind?: string;
      key?: string;
      doc?: string;
      needle?: string;
      section?: string;
    };
    switch (tab) {
      case 'repro':
        return (
          (c.kind === 'intake' && c.key === 'repro') ||
          (c.kind === 'doc-contains' && c.needle?.toLowerCase() === 'repro')
        );
      case 'telemetry':
        return c.kind === 'intake' && c.key === 'telemetry';
      case 'findings':
        return c.kind === 'doc' && c.doc === 'notes.md';
      case 'migration-checks':
        return (
          c.kind === 'doc-contains' && c.needle?.toLowerCase() === 'migration'
        );
      case 'ac-design':
        return (
          c.kind === 'section' &&
          c.section?.toLowerCase() === 'acceptance criteria'
        );
      default:
        return false;
    }
  });
}

function EvidenceList({ items }: { items: WorkbenchEvidence[] }) {
  if (items.length === 0) return <Empty label="No policy requirements." />;
  return (
    <ul>
      {items.map((e) => (
        <li key={e.id}>
          <span className={e.satisfied ? 'spec-good' : 'spec-bad'}>
            {e.satisfied ? '✓' : '✗'}
          </span>{' '}
          {e.label} <span className="muted">({e.gate})</span>
        </li>
      ))}
    </ul>
  );
}

/** `type` tab — the taxonomy + the full intake/evidence checklist. */
function WorkbenchTypeTab({ wb }: { wb: Workbench }) {
  return (
    <div>
      <div className="card">
        <strong>{wb.work_type ?? 'unclassified'}</strong>
        <div className="card-meta">
          origin {wb.origin ?? '—'} · severity {wb.severity ?? '—'} (
          {wb.severity_rule})
          {wb.scope_verdict ? ` · scope verdict ${wb.scope_verdict}` : ''}
        </div>
        {wb.summary && <div className="card-meta">{wb.summary}</div>}
        <div className="card-meta">
          direct-create: {wb.direct_create ? 'allowed' : 'needs approved scope'}
          {wb.scope_approval_needed ? ' · scope proposal pending' : ''}
        </div>
      </div>
      <div className="card">
        <strong>Intake</strong>
        {wb.intake.length === 0 ? (
          <Empty label="No per-type intake fields." />
        ) : (
          <ul>
            {wb.intake.map((f) => (
              <li key={f.key}>
                <span className="mono">{f.key}</span> — {f.question}{' '}
                {f.required ? '' : <span className="muted">(optional)</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card">
        <strong>Evidence</strong>
        {wb.missing.length > 0 && (
          <div className="card-meta spec-warn">
            missing: {wb.missing.join(', ')}
          </div>
        )}
        <EvidenceList items={wb.evidence} />
      </div>
    </div>
  );
}

/** A per-type content tab — the matching ticket.md section + the
 *  requirements the tab is responsible for. */
function WorkbenchSectionTab({
  tab,
  wb,
  ticketMd,
}: {
  tab: string;
  wb: Workbench;
  ticketMd: string | null;
}) {
  const meta = WORKBENCH_TAB_META[tab];
  const section = meta?.section ? sectionOf(ticketMd, meta.section) : null;
  const reqs = tabEvidence(tab, wb);
  return (
    <div>
      <p className="page-sub">{meta?.hint ?? ''}</p>
      {meta?.doc && (
        <div className="card">
          <strong>{meta.doc}</strong>
          <div className="card-meta">
            the deliverable for this type lives in the {meta.doc} doc — see the
            Docs tab.
          </div>
        </div>
      )}
      {meta?.section && (
        <div className="card">
          <strong>{meta.section}</strong>
          {section ? (
            <Markdown text={section} />
          ) : (
            <Empty label={`No ## ${meta.section} section in ticket.md.`} />
          )}
        </div>
      )}
      <div className="card">
        <strong>Required evidence</strong>
        <EvidenceList items={reqs} />
      </div>
    </div>
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
        {gates.includes('scope-proposal') && (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void act('approve_scope')}
            >
              Approve scope proposal
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void act('reject_scope')}
            >
              Decline scope (out of scope)
            </button>
          </>
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
