/**
 * S-05 — Ticket focus page (s-05-ticket-focus.md; replaces
 * TicketDetail, D24/D25). Two-column operational hub: workbench with a
 * pinned Next-action panel + tabs (Overview · Documentation · Activity
 * · Runs + one status-conditional spotlight — Code review / Failure /
 * Split plan), and a narrow Status / What's-left / Key-facts rail.
 * Contextual AI (ChatEdit) appears only beside editable docs.
 */
import type { GateItem, TicketRow, TriageQuestion } from '@veto/core';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Alignment from '../Alignment';
import ChatEdit, { type ChatEditTarget } from '../ChatEdit';
import RsQualityPanel from '../RsQuality';
import Traceability from '../Traceability';
import { type TicketDetail as Detail, client } from '../api';
import { PHASE_LABEL } from '../board';
import {
  DiffView,
  Empty,
  ErrorBox,
  Loading,
  Markdown,
  SpecScore,
  StatusBadge,
  fmtAge,
} from '../components';
import { useLoad, useStreamRefresh } from '../hooks';
import { defaultAnswer } from '../wizard';
import CodeReview from './CodeReview';

// ---------------------------------------------------------------------------
// Roadmap — the focus rail's "What's left" (s-05 §roadmap derivation).
// Derived from server-owned status; failed/blocked retain the last
// meaningful milestone via the event ledger.
// ---------------------------------------------------------------------------

export const ROADMAP = [
  'Ticket definition',
  'Product requirements',
  'Technical design',
  'Test plan',
  'Implementation',
  'Code review',
  'Merge',
  'Verify',
  'Released',
] as const;

const STATUS_STEP: Record<string, number> = {
  imported: 0,
  triage: 0,
  'needs-info': 0,
  escalated: 0,
  'prd-draft': 1,
  'prd-review': 1,
  'prd-approved': 1,
  'design-qa': 1,
  'tdd-draft': 2,
  'tdd-review': 2,
  'tdd-approved': 2,
  'test-draft': 3,
  'test-review': 3,
  'test-approved': 4,
  ready: 4,
  'in-progress': 4,
  review: 5,
  'changes-requested': 5,
  approved: 6,
  'pr-open': 6,
  'ci-watch': 6,
  merged: 7,
  verifying: 7,
  verify_failed: 7,
  released: 8,
};

/** Terminal/failure statuses keep the milestone they died on. */
export function roadmapIndex(
  status: string,
  events: { event: string; data: Record<string, unknown> }[],
): number {
  const direct = STATUS_STEP[status];
  if (direct !== undefined) return direct;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.event !== 'status_changed') continue;
    const to = e.data?.to;
    if (typeof to !== 'string') continue;
    const idx = STATUS_STEP[to];
    if (idx !== undefined) return idx;
  }
  return 0;
}

/** Anxiety-first ordering for the open-gate list (mirrors /inbox). */
const GATE_RANK: Record<string, number> = {
  failure: 0,
  escalation: 1,
  repair: 2,
  question: 3,
  review: 4,
  approval: 5,
  'split-plan': 6,
  verify: 7,
};

function rankGates(gates: GateItem[]): GateItem[] {
  return [...gates].sort(
    (a, b) =>
      (GATE_RANK[a.kind] ?? 8) - (GATE_RANK[b.kind] ?? 8) ||
      a.surfaced_at.localeCompare(b.surfaced_at),
  );
}

type TabId =
  | 'overview'
  | 'docs'
  | 'activity'
  | 'runs'
  | 'links'
  | 'alignment'
  | 'review'
  | 'failure'
  | 'split';

const TERMINAL = new Set([
  'merged',
  'released',
  'wont-do',
  'aborted',
  'reverted',
  'split',
  'discarded',
]);

export default function TicketFocus() {
  const { ws = '', id = '' } = useParams();
  const detail = useLoad(() => client.ticket(ws, id), [ws, id]);
  // The rail needs the ledger only to recover the milestone of a
  // failed/blocked/terminal ticket — skip the fetch otherwise.
  const needsEvents =
    detail.data !== null &&
    STATUS_STEP[detail.data.ticket.status] === undefined;
  const events = useLoad(
    () =>
      needsEvents
        ? client.ticketEvents(ws, id)
        : Promise.resolve({ events: [] }),
    [ws, id, needsEvents],
  );
  const [tab, setTab] = useState<TabId>('overview');
  useStreamRefresh(() => {
    detail.reload();
    events.reload();
  }, ['gate_surfaced', 'gate_cleared', 'run_status', 'ticket_updated']);

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  const d = detail.data;
  if (!d) return <Empty />;
  const t = d.ticket;

  const openGates = rankGates(d.open_gates.filter((g) => !g.cleared_at));
  const spotlight: TabId | null =
    openGates.some((g) => g.gate === 'split-plan') || t.status === 'split'
      ? 'split'
      : d.flagged !== null
        ? 'failure'
        : [
              'review',
              'changes-requested',
              'approved',
              'pr-open',
              'ci-watch',
            ].includes(t.status)
          ? 'review'
          : null;
  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'docs', label: 'Documentation' },
    { id: 'activity', label: 'Activity' },
    { id: 'runs', label: 'Runs' },
    { id: 'links', label: 'Traceability' },
    { id: 'alignment', label: 'Alignment' },
    ...(spotlight === 'review'
      ? [{ id: 'review' as TabId, label: 'Code review' }]
      : []),
    ...(spotlight === 'failure'
      ? [{ id: 'failure' as TabId, label: 'Failure' }]
      : []),
    ...(spotlight === 'split'
      ? [{ id: 'split' as TabId, label: 'Split plan' }]
      : []),
  ];

  return (
    <section>
      <p className="page-sub" style={{ marginBottom: 2 }}>
        <Link to="/">← Board</Link>
      </p>
      <h1 className="page-title">
        {t.ticket_id} — {t.title} <SpecScore score={t.spec_score} />
      </h1>
      <p className="page-sub">
        <span className="badge">{PHASE_LABEL[d.phase]}</span>{' '}
        <StatusBadge status={t.status} /> {t.workspace} · priority {t.priority}{' '}
        · updated {fmtAge(t.updated_at)} ago
        {t.blocked_reason ? ` · blocked: ${t.blocked_reason}` : ''}
      </p>
      <p className="row page-sub">
        {t.feature && (
          <Link to={`/features/${ws}/${t.feature}`}>Feature {t.feature}</Link>
        )}
        <Link to={`/tickets/${ws}/${id}/pr`}>PR panel</Link>
        <Link to={`/tickets/${ws}/${id}/ledger`}>Ledger</Link>
        <Link to={`/runs?subject=${encodeURIComponent(t.ticket_id)}`}>
          Runs
        </Link>
        {(t.status === 'merged' || t.status === 'released') && (
          <FileCorrection ws={ws} d={d} onDone={detail.reload} />
        )}
      </p>

      <div className="split">
        <div className="grow">
          <NextAction ws={ws} d={d} onDone={detail.reload} />
          <div className="tabs" role="tablist">
            {tabs.map((x) => (
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
          {tab === 'overview' && (
            <OverviewTab ws={ws} d={d} onApplied={detail.reload} />
          )}
          {tab === 'docs' && (
            <DocsTab ws={ws} d={d} onApplied={detail.reload} />
          )}
          {tab === 'activity' && <ActivityTab ws={ws} id={id} />}
          {tab === 'runs' && <RunsTab ws={ws} id={id} />}
          {tab === 'links' && <Traceability ws={ws} subject={id} />}
          {tab === 'alignment' && <Alignment ws={ws} scope={id} />}
          {tab === 'review' && <CodeReview embedded />}
          {tab === 'failure' && (
            <FailureTab ws={ws} d={d} onDone={detail.reload} />
          )}
          {tab === 'split' && <SplitTab ws={ws} d={d} onDone={detail.reload} />}
        </div>
        <aside className="rail">
          <StatusRail
            d={d}
            gates={openGates}
            step={roadmapIndex(t.status, events.data?.events ?? [])}
          />
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Next action — the current move, completed inline (s-05 §next-action).
// ---------------------------------------------------------------------------

function NextAction({
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
  const [editSession, setEditSession] = useState<string | null>(null);
  const t = d.ticket;
  const gates = rankGates(d.open_gates.filter((g) => !g.cleared_at));
  const runs = useLoad(
    () => client.runs({ workspace: ws, ticket_id: t.ticket_id }),
    [ws, t.ticket_id],
  );
  const live = (runs.data?.runs ?? []).find((r) =>
    ['pending', 'leased', 'running', 'paused'].includes(r.status),
  );

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

  const claim = async (gate: string) => {
    setBusy(true);
    setErr(null);
    try {
      await client.claim(ws, t.ticket_id, gate);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const approveDoc = async (doc: string) => {
    setBusy(true);
    setErr(null);
    try {
      await client.docApprove(ws, t.ticket_id, doc);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const primary = gates[0];
  const ref = `/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(t.ticket_id)}`;
  const owner =
    gates.length > 0
      ? primary?.kind === 'failure' || primary?.kind === 'escalation'
        ? 'Recovery required'
        : 'Waiting on you'
      : live
        ? 'Veto is working'
        : TERMINAL.has(t.status)
          ? 'No action needed'
          : 'No action needed';

  return (
    <div className="card next-action">
      <div className="card-title">
        <strong>
          Next action — {owner}
          {primary ? ` · ${primary.kind}` : ''}
        </strong>
      </div>
      {err != null && <ErrorBox error={err} />}

      {editSession && (
        <ChatEdit
          ws={ws}
          ticketRef={t.ticket_id}
          target="ticket"
          expectedStatus={t.status}
          resume={editSession}
          onApplied={onDone}
          onClose={() => setEditSession(null)}
        />
      )}

      {!editSession && primary && renderGateAction()}
      {!editSession && !primary && live && (
        <p className="muted">
          Run {live.id} is {live.status} ({live.stage}) —{' '}
          <Link to={`/runs/${encodeURIComponent(live.id)}`}>Watch run →</Link>
        </p>
      )}
      {!editSession && !primary && !live && TERMINAL.has(t.status) && (
        <p className="muted">{t.status} — outcome is recorded in the ledger.</p>
      )}
      {!editSession && !primary && !live && !TERMINAL.has(t.status) && (
        <p className="muted">Nothing needs you right now.</p>
      )}
      {gates.length > 1 && (
        <div className="card-meta">
          also open:{' '}
          {gates
            .slice(1)
            .map((g) => g.gate)
            .join(' · ')}
        </div>
      )}
    </div>
  );

  // Rendered as a plain call (not <GateAction/>) so the gate panel
  // doesn't remount — and drop inline question state — on each render.
  function renderGateAction() {
    const g = primary;
    if (!g) return null;
    const gate = g.gate;

    // Agent Q&A — answer inline (S-04 surface embedded for the current
    // question only; the full wizard stays one click away).
    if (
      gate === 'needs-info' ||
      gate === 'design-qa' ||
      g.kind === 'question'
    ) {
      const q = (d.triage?.questions ?? []).find(
        (x: TriageQuestion) => x.status === 'open',
      );
      return (
        <div>
          {q ? (
            <InlineQuestion
              q={q}
              ws={ws}
              id={t.ticket_id}
              expectedStatus={t.status}
              disabled={busy}
              onDone={onDone}
            />
          ) : (
            <p className="muted">Question gate open — no question payload.</p>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <Link className="btn small" to={`${ref}/wizard`}>
              Open full wizard →
            </Link>
          </div>
        </div>
      );
    }

    // wp-111 — rs-quality gate: the cited AI quality pass surfaces
    // critical findings here; clearing is a human waive (an honest
    // gate_overridden ledger entry — never a doc approval).
    if (gate === 'rs-quality') {
      return (
        <div>
          <RsQualityPanel ws={ws} id={t.ticket_id} severity="critical" />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void act('waive_quality')}
            >
              Waive quality findings
            </button>
            <Link className="btn small" to={`${ref}/docs/rs`}>
              Review rs.md →
            </Link>
          </div>
        </div>
      );
    }

    // Document approval gates → approve inline, request changes via the
    // doc reviewer.
    const docForGate: Record<string, string> = {
      'prd-review': 'rs',
      'tdd-review': 'tdd',
      'test-review': 'vs',
    };
    const doc = docForGate[gate];
    if (doc) {
      return (
        <div className="row">
          <span className="muted">{doc}.md awaits approval</span>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void approveDoc(doc)}
          >
            Approve {doc}.md
          </button>
          <Link className="btn small" to={`${ref}/docs/${doc}`}>
            Review / request changes →
          </Link>
        </div>
      );
    }
    if (gate === 'plan-package') {
      const docs = (d.docs ?? [])
        .map((x) => x.doc)
        .filter((x) => ['rs.md', 'tdd.md', 'vs.md'].includes(x));
      return (
        <div>
          <p className="muted">Plan package approval — per doc:</p>
          <div className="row">
            {docs.map((x) => (
              <button
                key={x}
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void approveDoc(x.replace('.md', ''))}
              >
                Approve {x}
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (gate === 'test-approved') {
      return (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act('go_implement')}
        >
          Go implement (spend checkpoint)
        </button>
      );
    }
    if (gate === 'approved') {
      return (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act('open_pr')}
        >
          Open PR
        </button>
      );
    }
    if (gate === 'ci-watch' || gate === 'merge') {
      return (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act('merge')}
        >
          Merge
        </button>
      );
    }
    if (gate === 'split-plan') {
      return (
        <div className="row">
          <span className="muted">Split plan proposed — see tab below.</span>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act('approve_split')}
          >
            Approve split
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void act('approve_split', { decision: 'reject' })}
          >
            Reject split
          </button>
        </div>
      );
    }
    if (gate === 'escalated') {
      return (
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void claim('escalated')}
          >
            Claim escalation
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('resume')}
          >
            Resume pipeline
          </button>
        </div>
      );
    }
    if (gate === 'changes-requested') {
      return (
        <div className="row">
          <Link className="btn small" to={`${ref}/review`}>
            Open code review →
          </Link>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('resume')}
          >
            Resume pipeline
          </button>
        </div>
      );
    }
    if (gate.startsWith('edit:')) {
      const session = gate.slice('edit:'.length);
      return (
        <div className="row">
          <span className="muted">AI edit proposal pending ({session})</span>
          <button
            type="button"
            className="primary"
            onClick={() => setEditSession(session)}
          >
            Review proposal
          </button>
        </div>
      );
    }
    if (g.kind === 'failure') {
      return (
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act('retry')}
          >
            Retry last run
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void act('wont_do')}
          >
            Won't do
          </button>
        </div>
      );
    }
    if (g.kind === 'verify' || gate === 'verify-confirm' || gate === 'uat') {
      return (
        <div className="row">
          <span className="muted">
            Verification {gate} is open — confirm in the run surface.
          </span>
          {live && (
            <Link
              className="btn small"
              to={`/runs/${encodeURIComponent(live.id)}`}
            >
              Watch run →
            </Link>
          )}
        </div>
      );
    }
    // Generic open gate — claim it, then work the linked surface.
    return (
      <div className="row">
        <span className="muted">
          {g.kind} · {gate}
        </span>
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={() => void claim(gate)}
        >
          claim
        </button>
      </div>
    );
  }
}

/** One inline triage question — the gate clears when answered (S-04
 *  semantics: recommended badge, skip = accept default). */
function InlineQuestion({
  q,
  ws,
  id,
  expectedStatus,
  disabled,
  onDone,
}: {
  q: TriageQuestion;
  ws: string;
  id: string;
  expectedStatus: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const [other, setOther] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const send = async (value: string | string[]) => {
    setBusy(true);
    setErr(null);
    try {
      await client.answers(ws, id, {
        id: q.id,
        answer: value,
        expected_status: expectedStatus,
      });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const off = disabled || busy;
  return (
    <div>
      <p style={{ margin: '4px 0' }}>{q.question}</p>
      {q.why && <p className="wizard-why">{q.why}</p>}
      {err != null && <ErrorBox error={err} />}
      {q.format === 'text' ? (
        <div className="row">
          <input
            aria-label="answer"
            placeholder={q.default ?? 'Type your answer…'}
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
          <button
            type="button"
            className="primary"
            disabled={off || !other.trim()}
            onClick={() => void send(other.trim())}
          >
            Answer
          </button>
        </div>
      ) : (
        <div className="option-list">
          {(q.format === 'yesno'
            ? [
                { key: 'yes', label: 'yes' },
                { key: 'no', label: 'no' },
              ]
            : q.options
          ).map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={off}
              onClick={() => void send(o.key)}
            >
              {o.label}
              {(o.recommended || defaultAnswer(q) === o.key) && (
                <span className="badge recommended">recommended</span>
              )}
            </button>
          ))}
        </div>
      )}
      {q.format !== 'text' && q.format !== 'yesno' && q.allow_other && (
        <div className="row">
          <input
            aria-label="other answer"
            placeholder="Other…"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
          <button
            type="button"
            disabled={off || !other.trim()}
            onClick={() => void send(other.trim())}
          >
            Other
          </button>
        </div>
      )}
      <button
        type="button"
        className="small"
        disabled={off}
        onClick={() => void send(defaultAnswer(q))}
      >
        Skip (accept: {defaultAnswer(q) || 'default'})
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function OverviewTab({
  ws,
  d,
  onApplied,
}: {
  ws: string;
  d: Detail;
  onApplied: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const t = d.ticket;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="spacer" />
        {!edit && (
          <button type="button" className="small" onClick={() => setEdit(true)}>
            Improve with AI
          </button>
        )}
      </div>
      {edit && (
        <ChatEdit
          ws={ws}
          ticketRef={t.ticket_id}
          target="ticket"
          expectedStatus={t.status}
          onApplied={() => {
            setEdit(false);
            onApplied();
          }}
          onClose={() => setEdit(false)}
        />
      )}
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
      {d.repos.length > 0 && (
        <div className="card">
          <strong>Repos</strong>
          {d.repos.map((r) => (
            <div key={r.repo} className="card-meta mono">
              {r.repo} · {r.branch ?? '—'}{' '}
              {r.pr_url && (
                <a href={r.pr_url} rel="noreferrer">
                  PR ↗
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DocsTab({
  ws,
  d,
  onApplied,
}: {
  ws: string;
  d: Detail;
  onApplied: () => void;
}) {
  const id = d.ticket.ticket_id;
  const docNames = useMemo(() => {
    const names = (d.docs ?? []).map((x) => x.doc);
    return names.length > 0 ? names : ['ticket.md'];
  }, [d.docs]);
  const [name, setName] = useState<string>(docNames[0] ?? 'ticket.md');
  const doc = useLoad(() => client.ticketDoc(ws, id, name), [ws, id, name]);
  const [edit, setEdit] = useState(false);
  const target = name.replace(/\.md$/, '') as ChatEditTarget;
  const editable = ['ticket', 'rs', 'tdd', 'vs'].includes(target);
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        {docNames.map((n) => (
          <button
            key={n}
            type="button"
            className={`small ${name === n ? 'primary' : ''}`}
            onClick={() => {
              setName(n);
              setEdit(false);
            }}
          >
            {n}
            <span className="muted">
              {' '}
              v{d.docs.find((x) => x.doc === n)?.version ?? '?'}
            </span>
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
          <div className="row" style={{ marginTop: 10 }}>
            {editable && !edit && (
              <button
                type="button"
                className="small"
                onClick={() => setEdit(true)}
              >
                Revise with Veto
              </button>
            )}
            <Link to={`/tickets/${ws}/${id}/docs/${name}`}>
              Open in doc reviewer →
            </Link>
          </div>
          {edit && editable && (
            <ChatEdit
              ws={ws}
              ticketRef={id}
              target={target}
              expectedStatus={d.ticket.status}
              onApplied={() => {
                setEdit(false);
                doc.reload();
                onApplied();
              }}
              onClose={() => setEdit(false)}
            />
          )}
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
          <th>refs</th>
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
              {(e.refs ?? []).slice(0, 3).join(', ')}
            </td>
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

/** Spotlight: failure detail (status failed/blocked/verify_failed). */
function FailureTab({
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
  const runs = useLoad(
    () => client.runs({ workspace: ws, ticket_id: t.ticket_id }),
    [ws, t.ticket_id],
  );
  const lastBad = (runs.data?.runs ?? [])
    .filter((r) => ['failed', 'killed', 'stalled'].includes(r.status))
    .sort((a, b) => b.id.localeCompare(a.id))[0];
  const act = async (action: string) => {
    setBusy(true);
    setErr(null);
    try {
      await client.action(ws, t.ticket_id, {
        action,
        expected_status: t.status,
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
      <div className="warn-banner">
        {t.status}
        {t.blocked_reason ? ` — ${t.blocked_reason}` : ''}
      </div>
      {err != null && <ErrorBox error={err} />}
      {lastBad && (
        <div className="card">
          <div className="card-title">
            <Link to={`/runs/${encodeURIComponent(lastBad.id)}`}>
              {lastBad.id}
            </Link>
            <StatusBadge status={lastBad.status} />
            <span className="muted">{lastBad.stage}</span>
          </div>
          {lastBad.sentinel && (
            <div className="card-meta">sentinel: {lastBad.sentinel}</div>
          )}
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act('retry')}
        >
          Retry last run
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('resume')}
        >
          Resume pipeline
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void act('wont_do')}
        >
          Won't do
        </button>
      </div>
    </div>
  );
}

/** Spotlight: proposed split plan (split-plan gate or split status). */
function SplitTab({
  ws,
  d,
  onDone,
}: {
  ws: string;
  d: Detail;
  onDone: () => void;
}) {
  const id = d.ticket.ticket_id;
  const doc = useLoad(() => client.ticketDoc(ws, id, 'split-plan'), [ws, id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const act = async (decision?: string) => {
    setBusy(true);
    setErr(null);
    try {
      await client.action(ws, id, {
        action: 'approve_split',
        expected_status: d.ticket.status,
        ...(decision ? { decision } : {}),
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
      {doc.loading && <Loading />}
      {doc.error != null && <ErrorBox error={doc.error} />}
      {doc.data && <Markdown text={doc.data.content} />}
      {err != null && <ErrorBox error={err} />}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act()}
        >
          Approve split
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void act('reject')}
        >
          Reject — re-triage
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Focus rail — Status + What's left + Key facts.
// ---------------------------------------------------------------------------

function StatusRail({
  d,
  gates,
  step,
}: {
  d: Detail;
  gates: GateItem[];
  step: number;
}) {
  const t = d.ticket;
  return (
    <div>
      <div className="card">
        <strong>Status</strong>
        <div className="card-meta">{PHASE_LABEL[d.phase]}</div>
        <div style={{ margin: '6px 0' }}>
          <StatusBadge status={t.status} />
        </div>
        <div className="card-meta">
          {gates.length > 0
            ? `waiting on you · ${gates[0]?.kind}`
            : TERMINAL.has(t.status)
              ? 'terminal'
              : 'pipeline is moving'}
        </div>
      </div>
      <div className="card">
        <strong>What's left</strong>
        <ol className="roadmap">
          {ROADMAP.map((m, i) => (
            <li
              key={m}
              className={i < step ? 'done' : i === step ? 'current' : 'later'}
            >
              {i < step ? '✓ ' : ''}
              {m}
            </li>
          ))}
        </ol>
      </div>
      <div className="card">
        <strong>Key facts</strong>
        <div className="card-meta">project: {t.workspace}</div>
        <div className="card-meta">priority: {t.priority}</div>
        {t.spec_score != null && (
          <div className="card-meta">spec score: {t.spec_score}</div>
        )}
        {t.repos.length > 0 && (
          <div className="card-meta">repos: {t.repos.join(', ')}</div>
        )}
        {t.parent && (
          <div className="card-meta">
            parent:{' '}
            <Link to={`/tickets/${t.workspace}/${t.parent}`}>{t.parent}</Link>
          </div>
        )}
        {d.family.map((f: TicketRow) => (
          <div key={f.ticket_id} className="card-meta">
            {f.parent === t.ticket_id ? 'child: ' : 'dep: '}
            <Link to={`/tickets/${f.workspace}/${f.ticket_id}`}>
              {f.ticket_id}
            </Link>
          </div>
        ))}
        <div className="card-meta">
          opened {t.created_at ? `${fmtAge(t.created_at)} ago` : '—'} · updated{' '}
          {fmtAge(t.updated_at)} ago
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File correction — DELIVERY §2 post-merge defect entry point. The new
// ticket is origin:'correction', work_type:'bug', parent: this ticket;
// the merged ticket's history and AC verdicts are never rewritten.
// ---------------------------------------------------------------------------

function FileCorrection({
  ws,
  d,
  onDone,
}: {
  ws: string;
  d: Detail;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const t = d.ticket;

  if (filed) {
    return (
      <span className="muted">
        correction{' '}
        <Link
          to={`/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(filed)}`}
        >
          {filed}
        </Link>{' '}
        filed
      </span>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        className="small"
        title="file a post-merge defect — correction ticket, parented here"
        onClick={() => setOpen(true)}
      >
        File correction…
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await client.fileCorrection(ws, t.ticket_id, {
        title: title.trim(),
        ...(severity ? { severity } : {}),
        ...(t.repos.length ? { repos: t.repos } : {}),
        ...(t.feature ? { feature: t.feature } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setFiled(r.ticket.ticket_id);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ flexBasis: '100%' }}>
      <div className="card-title">
        <strong>File correction on {t.ticket_id}</strong>
        <span className="muted">origin: correction · work_type: bug</span>
      </div>
      {err != null && <ErrorBox error={err} />}
      <div className="row">
        <input
          aria-label="correction title"
          placeholder="defect title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <select
          aria-label="severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          <option value="">severity (ungraded = material)</option>
          {['blocker', 'critical', 'major', 'minor', 'trivial'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="primary"
          disabled={busy || !title.trim()}
          onClick={() => void submit()}
        >
          File
        </button>
        <button type="button" className="small" onClick={() => setOpen(false)}>
          cancel
        </button>
      </div>
      <input
        aria-label="correction description"
        placeholder="description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
    </div>
  );
}
