/**
 * S-01 — needs-attention inbox (home tab 2). Grouped gate_items ranked
 * human-anxiety-first (failures/escalations before routine Q&A — D21),
 * then priority → age; kind badges; claim/release/snooze; workspace
 * filter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type InboxItem, client } from '../api';
import {
  Empty,
  ErrorBox,
  KindBadge,
  Loading,
  fmtAge,
  gateLabel,
  humanize,
} from '../components';
import { useStreamRefresh } from '../hooks';
import { useProject } from '../project';

/** Human-anxiety-first kind order (D21 — failures/escalations first). */
const KIND_ORDER = [
  'failure',
  'escalation',
  'repair',
  'question',
  'review',
  'approval',
  'split-plan',
  'verify',
];

const KIND_HEADING: Record<string, string> = {
  question: 'Questions',
  approval: 'Approvals',
  review: 'Reviews',
  failure: 'Failures',
  escalation: 'Escalations',
  'split-plan': 'Split plans',
  repair: 'Repairs',
  verify: 'Verifications',
};

/** Where an inbox item lands when opened. */
export function itemTarget(item: InboxItem): string {
  const base = `/projects/${encodeURIComponent(item.workspace)}/tickets/${encodeURIComponent(item.subject)}`;
  if (item.gate === 'needs-info' || item.gate === 'design-qa')
    return `${base}/wizard`;
  if (item.gate.endsWith('-review') && item.kind === 'approval') {
    // Gate ids keep pre-rename vocabulary; doc routes use rs.md/vs.md.
    const legacy: Record<string, string> = { prd: 'rs', test: 'vs' };
    const gateDoc = item.gate.replace('-review', '');
    return `${base}/docs/${legacy[gateDoc] ?? gateDoc}`;
  }
  if (item.gate === 'changes-requested' || item.gate === 'approved')
    return `${base}/review`;
  if (item.gate === 'ci-watch' || item.gate === 'merge') return `${base}/pr`;
  if (item.gate === 'split-plan') return `${base}/docs/split-plan`;
  return base;
}

/** Human-anxiety-first (D21): failure/escalation/repair before routine
 *  question/approval rows; within a class, a blocked agent breaks ties
 *  ahead of priority → age. Mirrors the server's ANXIETY_RANK — items
 *  arrive pre-sorted, this keeps render order explicit/testable. */
const ANXIETY_RANK: Record<string, number> = Object.fromEntries(
  KIND_ORDER.map((k, i) => [k, i]),
);

export function rankInbox(items: InboxItem[]): InboxItem[] {
  const prank = (p?: string | null) => (p === 'high' ? 0 : p === 'low' ? 2 : 1);
  return [...items].sort(
    (a, b) =>
      (ANXIETY_RANK[a.kind] ?? 8) - (ANXIETY_RANK[b.kind] ?? 8) ||
      Number(b.blocked_agent ?? false) - Number(a.blocked_agent ?? false) ||
      prank(a.priority) - prank(b.priority) ||
      a.surfaced_at.localeCompare(b.surfaced_at),
  );
}

export function groupByKind(items: InboxItem[]): [string, InboxItem[]][] {
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) {
    const list = groups.get(item.kind) ?? [];
    list.push(item);
    groups.set(item.kind, list);
  }
  const ordered = KIND_ORDER.filter((k) => groups.has(k)).map(
    (k) => [k, groups.get(k) ?? []] as [string, InboxItem[]],
  );
  for (const [k, v] of groups)
    if (!KIND_ORDER.includes(k)) ordered.push([k, v]);
  return ordered;
}

export default function Inbox() {
  const workspace = useProject();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(() => {
    client
      .inbox(workspace)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch(setError);
  }, [workspace]);

  useEffect(() => {
    load();
  }, [load]);

  useStreamRefresh(load, ['gate_surfaced', 'gate_cleared']);

  const groups = useMemo(() => groupByKind(rankInbox(items ?? [])), [items]);

  const act = async (
    key: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    setBusy(key);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="inbox-screen">
      <h1 className="page-title">Inbox</h1>
      <p className="page-sub">
        Everything that needs your move, blocking first.
      </p>
      <div className="row screen-toolbar">
        <span className="muted">project {workspace}</span>
        <span className="spacer" />
        <button type="button" className="small" onClick={load}>
          Refresh
        </button>
      </div>
      {error != null && <ErrorBox error={error} onRetry={load} />}
      {items === null && error == null && <Loading />}
      {items !== null && items.length === 0 && (
        <Empty label="Inbox zero — nothing needs you." />
      )}
      {groups.map(([kind, list]) => (
        <div key={kind}>
          <h2 className="group-title">
            {KIND_HEADING[kind] ?? kind}
            <span className="badge">{list.length}</span>
          </h2>
          <ul className="inbox-list">
            {list.map((item) => {
              const key = `${item.workspace}/${item.subject}/${item.gate}`;
              const snoozed =
                typeof item.snoozed_until === 'string' &&
                item.snoozed_until > new Date().toISOString();
              return (
                <li
                  className={`card${snoozed ? ' snoozed' : ''}`}
                  key={key}
                  data-blocked={item.blocked_agent ?? false}
                >
                  <div className="card-title">
                    <KindBadge kind={item.kind} />
                    <Link to={itemTarget(item)}>
                      {item.subject} · {gateLabel(item.gate)}
                    </Link>
                    {item.blocked_agent && (
                      <span className="badge spec-bad">blocking agent</span>
                    )}
                    {item.priority && (
                      <span className="badge" title="priority">
                        {humanize(item.priority)}
                      </span>
                    )}
                    {snoozed && (
                      <span className="badge">
                        snoozed → {item.snoozed_until?.slice(0, 16)}
                      </span>
                    )}
                    <span className="muted" title={item.surfaced_at}>
                      {fmtAge(item.surfaced_at)}
                    </span>
                    <span className="spacer" />
                    {snoozed ? (
                      <button
                        type="button"
                        className="small"
                        disabled={busy === key}
                        onClick={() =>
                          void act(key, () =>
                            client.unsnooze(
                              item.workspace,
                              item.subject,
                              item.gate,
                            ),
                          )
                        }
                      >
                        Unsnooze
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="small"
                        disabled={busy === key}
                        title="snooze 24h — leaves the board until then"
                        onClick={() =>
                          void act(key, () =>
                            client.snooze(
                              item.workspace,
                              item.subject,
                              item.gate,
                              {},
                            ),
                          )
                        }
                      >
                        Snooze 24h
                      </button>
                    )}
                    {item.claim ? (
                      <button
                        type="button"
                        className="small"
                        disabled={busy === key}
                        onClick={() =>
                          void act(key, () =>
                            client.release(
                              item.workspace,
                              item.subject,
                              item.gate,
                            ),
                          )
                        }
                      >
                        Release ({item.claim.claimed_by})
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="small primary"
                        disabled={busy === key}
                        onClick={() =>
                          void act(key, () =>
                            client.claim(
                              item.workspace,
                              item.subject,
                              item.gate,
                            ),
                          )
                        }
                      >
                        Claim
                      </button>
                    )}
                  </div>
                  <div className="card-meta">
                    project {item.workspace} · surfaced{' '}
                    {fmtAge(item.surfaced_at)} ago
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
