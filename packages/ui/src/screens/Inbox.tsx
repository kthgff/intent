/**
 * S-01 — needs-attention inbox (home). Grouped gate_items ranked
 * blocking-first → priority → age; kind badges; claim/release;
 * workspace filter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type InboxItem, client } from '../api';
import { Empty, ErrorBox, KindBadge, Loading, fmtAge } from '../components';
import { useStreamRefresh } from '../hooks';

const KIND_ORDER = [
  'question',
  'escalation',
  'failure',
  'approval',
  'review',
  'split-plan',
  'repair',
];

const KIND_HEADING: Record<string, string> = {
  question: 'Questions',
  approval: 'Approvals',
  review: 'Reviews',
  failure: 'Failures',
  escalation: 'Escalations',
  'split-plan': 'Split plans',
  repair: 'Repairs',
};

/** Where an inbox item lands when opened. */
export function itemTarget(item: InboxItem): string {
  const base = `/tickets/${encodeURIComponent(item.workspace)}/${encodeURIComponent(item.subject)}`;
  if (item.gate === 'needs-info' || item.gate === 'design-qa')
    return `${base}/wizard`;
  if (item.gate.endsWith('-review') && item.kind === 'approval')
    return `${base}/docs/${item.gate.replace('-review', '')}`;
  if (item.gate === 'changes-requested' || item.gate === 'approved')
    return `${base}/review`;
  if (item.gate === 'ci-watch' || item.gate === 'merge') return `${base}/pr`;
  if (item.gate === 'split-plan') return `${base}/docs/split-plan`;
  return base;
}

/** Blocking-first → priority → age (mirrors server ranking — items
 *  arrive pre-sorted, this keeps render order explicit/testable). */
export function rankInbox(items: InboxItem[]): InboxItem[] {
  const prank = (p?: string | null) => (p === 'high' ? 0 : p === 'low' ? 2 : 1);
  return [...items].sort(
    (a, b) =>
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
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [workspace, setWorkspace] = useState<string>('');
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(() => {
    client
      .inbox(workspace || undefined)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch(setError);
  }, [workspace]);

  useEffect(() => {
    load();
    client
      .workspaces()
      .then((r) => setWorkspaces(r.workspaces.map((w) => w.name)))
      .catch(() => {});
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
    <section>
      <h1 className="page-title">Inbox</h1>
      <p className="page-sub">
        Everything that needs your move, blocking first.
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="muted" htmlFor="ws-filter">
          Workspace
        </label>
        <select
          id="ws-filter"
          style={{ width: 'auto' }}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          <option value="">all</option>
          {workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <button type="button" className="small" onClick={load}>
          Refresh
        </button>
      </div>
      {error != null && <ErrorBox error={error} />}
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
          {list.map((item) => {
            const key = `${item.workspace}/${item.subject}/${item.gate}`;
            return (
              <div className="card" key={key} data-blocked={item.blocked_agent}>
                <div className="card-title">
                  <KindBadge kind={item.kind} />
                  <Link to={itemTarget(item)}>
                    {item.subject} · {item.gate}
                  </Link>
                  {item.blocked_agent && (
                    <span className="badge spec-bad">blocking agent</span>
                  )}
                  {item.priority && (
                    <span className="badge">p:{item.priority}</span>
                  )}
                  <span className="muted">{fmtAge(item.surfaced_at)}</span>
                  <span className="spacer" />
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
                      release ({item.claim.claimed_by})
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="small"
                      disabled={busy === key}
                      onClick={() =>
                        void act(key, () =>
                          client.claim(item.workspace, item.subject, item.gate),
                        )
                      }
                    >
                      claim
                    </button>
                  )}
                </div>
                <div className="card-meta">
                  workspace {item.workspace} · surfaced {item.surfaced_at}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
