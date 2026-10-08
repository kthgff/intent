/**
 * Project-first navigation (Jira-style). Every app screen lives under
 * `/projects/:ws/…`; `ProjectLayout` validates the workspace, remembers
 * it as the last-used project, and exposes it via `useProject()`.
 * Legacy flat routes redirect into the remembered project (or the
 * picker when none is known).
 */
import { createContext, useContext, useEffect } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useParams,
} from 'react-router-dom';
import { client } from './api';
import { ErrorBox, Loading } from './components';
import { useLoad } from './hooks';

const LAST_KEY = 'veto_last_project';
const MRU_KEY = 'veto_project_mru';

const ProjectContext = createContext<string | null>(null);

/** Current project (workspace) name — only valid inside
 *  `/projects/:ws/…` routes. */
export function useProject(): string {
  const ws = useContext(ProjectContext);
  if (ws == null) {
    throw new Error('useProject used outside a project route');
  }
  return ws;
}

/** The remembered project, or null on first visit. */
export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** workspace → last-entered epoch ms — drives MRU ordering on the
 *  /projects picker. Read-once per render; writes only happen here. */
export function projectMru(): Record<string, number> {
  try {
    const raw = localStorage.getItem(MRU_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function rememberProject(ws: string): void {
  try {
    localStorage.setItem(LAST_KEY, ws);
    localStorage.setItem(
      MRU_KEY,
      JSON.stringify({ ...projectMru(), [ws]: Date.now() }),
    );
  } catch {
    /* storage unavailable */
  }
}

/** `/projects/<ws>[<sub>]` — `sub` starts with `/`. */
export function projectPath(ws: string, sub = ''): string {
  return `/projects/${encodeURIComponent(ws)}${sub}`;
}

/** `/` → the remembered project's home, or the picker. */
export function IndexRedirect() {
  const last = lastProject();
  return <Navigate to={last ? projectPath(last) : '/projects'} replace />;
}

/** Legacy flat list route (`/boards`, `/metrics`, …) → the same screen
 *  inside the remembered project, or the picker. */
export function FlatRedirect({ to }: { to: string }) {
  const last = lastProject();
  const { search, hash } = useLocation();
  return (
    <Navigate
      to={last ? `${projectPath(last, `/${to}`)}${search}${hash}` : '/projects'}
      replace
    />
  );
}

/** Legacy route that already carried `:ws` (`/tickets/:ws/:id`,
 *  `/boards/:ws/:board`, …) → the identical path under `/projects/:ws`. */
export function LegacyProjectRedirect() {
  const { pathname, search, hash } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  const [, ws, ...rest] = parts;
  if (!ws) return <Navigate to="/projects" replace />;
  return (
    <Navigate
      to={`/projects/${ws}/${parts[0]}${
        rest.length ? `/${rest.join('/')}` : ''
      }${search}${hash}`}
      replace
    />
  );
}

/** Legacy `/runs/:id` (run ids carry no workspace) → the run inside the
 *  remembered project. */
export function LegacyRunRedirect() {
  const { id = '' } = useParams();
  const last = lastProject();
  return (
    <Navigate
      to={last ? projectPath(last, `/runs/${id}`) : '/projects'}
      replace
    />
  );
}

/** Route element for `/projects/:ws/*` — validates the workspace, pins
 *  it as last-used, renders the project breadcrumb + child route. */
export function ProjectLayout() {
  const { ws = '' } = useParams();
  const state = useLoad(() => client.workspaces(), []);

  useEffect(() => {
    if (ws) rememberProject(ws);
  }, [ws]);

  if (state.loading && !state.data) return <Loading />;
  if (state.error != null) {
    return <ErrorBox error={state.error} onRetry={state.reload} />;
  }
  if (state.data && !state.data.workspaces.some((w) => w.name === ws)) {
    return <Navigate to="/projects" replace />;
  }
  return (
    <ProjectContext.Provider value={ws}>
      <nav className="crumb" aria-label="project">
        <Link to="/projects">← all projects</Link>
        <span className="muted"> / </span>
        <strong>{ws}</strong>
      </nav>
      <Outlet />
    </ProjectContext.Provider>
  );
}
