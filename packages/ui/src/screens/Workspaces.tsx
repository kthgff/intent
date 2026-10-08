/**
 * S-13 — project picker (Jira-style landing): one rich card per
 * project fed by GET /api/v1/projects/summary (single aggregate — no
 * per-project fan-out). Pinned projects first, then most-recently
 * used; a search box filters by name. "Add project" lives in the
 * header and reveals the inline registration form.
 */
import { Pin } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type ProjectSummary, client } from '../api';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  fmtAge,
  fmtTokens,
} from '../components';
import { useLoad, useStreamRefresh } from '../hooks';
import { projectMru, projectPath } from '../project';

const PIN_KEY = 'veto_pinned_projects';

function readPins(): Set<string> {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Picker ordering: pinned first, then most-recently-used, alpha as
 *  the never-visited tiebreak. `filter` matches workspace + display
 *  name, case-insensitive. */
export function orderProjects(
  projects: ProjectSummary[],
  opts: {
    pinned: Set<string>;
    mru: Record<string, number>;
    filter: string;
  },
): ProjectSummary[] {
  const q = opts.filter.trim().toLowerCase();
  return projects
    .filter(
      (p) =>
        !q ||
        p.workspace.toLowerCase().includes(q) ||
        (p.name ?? '').toLowerCase().includes(q),
    )
    .sort((a, b) => {
      const pa = opts.pinned.has(a.workspace) ? 0 : 1;
      const pb = opts.pinned.has(b.workspace) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ma = opts.mru[a.workspace] ?? 0;
      const mb = opts.mru[b.workspace] ?? 0;
      if (ma !== mb) return mb - ma;
      return a.workspace.localeCompare(b.workspace);
    });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="project-stat">
      <span className="project-stat-value">{value}</span>
      <span className="project-stat-label">{label}</span>
    </div>
  );
}

function ProjectCard({
  s,
  pinned,
  onTogglePin,
}: {
  s: ProjectSummary;
  pinned: boolean;
  onTogglePin: (ws: string) => void;
}) {
  const humanMin = Math.round(s.totals.human_minutes);
  const meta: string[] = [
    `${s.counts.tickets} ticket${s.counts.tickets === 1 ? '' : 's'}`,
    `${s.counts.features} feature${s.counts.features === 1 ? '' : 's'}`,
    `${s.counts.initiatives} initiative${s.counts.initiatives === 1 ? '' : 's'}`,
  ];
  const spend: string[] = [];
  if (s.totals.cost_usd > 0) spend.push(`$${s.totals.cost_usd.toFixed(2)}`);
  if (s.totals.tokens > 0) spend.push(`${fmtTokens(s.totals.tokens)} tok`);
  if (humanMin > 0) spend.push(`${humanMin}m human`);

  return (
    <Link className="card project-card" to={projectPath(s.workspace)}>
      <div className="card-title">
        <button
          type="button"
          className={`pin${pinned ? ' on' : ''}`}
          title={pinned ? 'Unpin project' : 'Pin project'}
          aria-label={pinned ? `Unpin ${s.workspace}` : `Pin ${s.workspace}`}
          aria-pressed={pinned}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTogglePin(s.workspace);
          }}
        >
          <Pin size={13} fill={pinned ? 'currentColor' : 'none'} />
        </button>
        <strong>{s.name ?? s.workspace}</strong>
        {s.name != null && s.name !== s.workspace && (
          <span className="mono muted">{s.workspace}</span>
        )}
        <span className="spacer" />
        {s.open_gate_items > 0 && (
          <span className="badge status-needs-info">
            {s.open_gate_items} open
          </span>
        )}
        {s.live_runs > 0 && (
          <span className="badge status-running">{s.live_runs} active</span>
        )}
      </div>
      <div className="project-stats">
        <Stat label="boards" value={String(s.boards)} />
        <Stat label="open items" value={String(s.open_gate_items)} />
        <Stat label="runs" value={String(s.live_runs)} />
        <Stat
          label="last active"
          value={s.last_active_at ? fmtAge(s.last_active_at) : '—'}
        />
      </div>
      <div className="card-meta">
        {meta.join(' · ')}
        {spend.length > 0 && ` — ${spend.join(' · ')}`}
      </div>
    </Link>
  );
}

export default function Workspaces() {
  const state = useLoad(() => client.projectSummaries(), []);
  useStreamRefresh(state.reload, [
    'gate_surfaced',
    'gate_cleared',
    'run_status',
    'ticket_updated',
  ]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('');
  const [pinned, setPinned] = useState<Set<string>>(readPins);

  const projects = useMemo(
    () =>
      orderProjects(state.data?.projects ?? [], {
        pinned,
        mru: projectMru(),
        filter,
      }),
    [state.data, pinned, filter],
  );

  const togglePin = (ws: string) => {
    setPinned((cur) => {
      const next = new Set(cur);
      if (next.has(ws)) next.delete(ws);
      else next.add(ws);
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.addWorkspace({ name, url });
      setName('');
      setUrl('');
      setShowAdd(false);
      state.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const total = state.data?.projects.length ?? 0;

  return (
    <section>
      <div className="picker-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">
            Pick a project to open its boards, runs, and settings.
          </p>
        </div>
        <div className="picker-actions">
          {total > 1 && (
            <input
              className="picker-search"
              type="search"
              placeholder="Filter projects…"
              aria-label="Filter projects"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          <button
            type="button"
            className="primary"
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? 'Cancel' : 'Add project'}
          </button>
        </div>
      </div>
      {showAdd && (
        <div className="card">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Name">
              <input
                value={name}
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                title="letters, digits, _ and -"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Tickets repo URL">
              <input
                value={url}
                required
                placeholder="git@github.com:org/tickets.git"
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <button
              type="button"
              className="primary"
              disabled={busy || !name || !url}
              title={
                !name || !url ? 'name and repo url are required' : undefined
              }
              onClick={() => void add()}
            >
              {busy ? 'Cloning…' : 'Add'}
            </button>
          </div>
        </div>
      )}
      {state.loading && <Loading />}
      {state.error != null && (
        <ErrorBox error={state.error} onRetry={state.reload} />
      )}
      {error != null && <ErrorBox error={error} />}
      {state.data && total === 0 && (
        <div className="state state-empty">
          No projects yet — add one to get started.
        </div>
      )}
      {total > 0 && projects.length === 0 && (
        <Empty label={`No projects match '${filter}'.`} />
      )}
      <div className="project-grid">
        {projects.map((s) => (
          <ProjectCard
            key={s.workspace}
            s={s}
            pinned={pinned.has(s.workspace)}
            onTogglePin={togglePin}
          />
        ))}
      </div>
    </section>
  );
}
