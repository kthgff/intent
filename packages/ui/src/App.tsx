/**
 * App shell — nav, inbox badge, SSE-driven toasts (UI-INVENTORY: the
 * app is a needs-attention inbox; badge counts drive the daily loop).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  matchPath,
  useLocation,
} from 'react-router-dom';
import { CaptureForm } from './CaptureForm';
import { type IdeaBoardRow, client } from './api';
import { Modal } from './components';
import DemoApp, { isDemoMode } from './demo/DemoApp';
import {
  FlatRedirect,
  IndexRedirect,
  LegacyProjectRedirect,
  LegacyRunRedirect,
  ProjectLayout,
  projectPath,
} from './project';
import Boards from './screens/Boards';
import CodeReview from './screens/CodeReview';
import CreateImport from './screens/CreateImport';
import DiscoverySession from './screens/DiscoverySession';
import DocReview from './screens/DocReview';
import Escalations from './screens/Escalations';
import FeatureWorkspace from './screens/FeatureWorkspace';
import Home from './screens/Home';
import IdeaBoard from './screens/IdeaBoard';
import Inbox from './screens/Inbox';
import KnowledgeBase from './screens/KnowledgeBase';
import Ledger from './screens/Ledger';
import MergeCenter from './screens/MergeCenter';
import Metrics from './screens/Metrics';
import PrPanel from './screens/PrPanel';
import ReleaseCenter from './screens/ReleaseCenter';
import RunMonitor, { RunsList } from './screens/RunMonitor';
import Settings from './screens/Settings';
import TicketFocus from './screens/TicketFocus';
import Tray from './screens/Tray';
import Wizard from './screens/Wizard';
import Workspaces from './screens/Workspaces';
import type { StreamEventMap } from './sse';
import { notificationToastText, subscribeStream } from './sse';

interface Toast {
  id: number;
  text: string;
}

/** Primary nav — grouped by workflow phase (mirrors the demo shell's
 *  d-nav-group structure). Items are project-relative; the shell
 *  prefixes them with the current project. */
const NAV_GROUPS: {
  label: string;
  items: { sub: string; label: string }[];
}[] = [
  {
    label: 'Discover',
    items: [
      { sub: '/boards', label: 'Boards' },
      { sub: '/tray', label: 'Tray' },
      { sub: '/new', label: 'Create / Import' },
    ],
  },
  {
    label: 'Deliver',
    items: [
      { sub: '/runs', label: 'Runs' },
      { sub: '/queue', label: 'Failures' },
      { sub: '/merge-center', label: 'Merge' },
      { sub: '/releases', label: 'Releases' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { sub: '/kb', label: 'Knowledge base' },
      { sub: '/metrics', label: 'Metrics' },
      { sub: '/ledger', label: 'Ledger' },
    ],
  },
  {
    label: 'System',
    items: [{ sub: '/settings', label: 'Settings' }],
  },
];

/** Current project from the URL — every project route lives under
 *  `/projects/:ws/…`. */
function currentProject(pathname: string): string | null {
  const m = matchPath('/projects/:ws/*', pathname);
  return m?.params.ws ? decodeURIComponent(m.params.ws) : null;
}

function ProductionApp() {
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureData, setCaptureData] = useState<{
    workspaces: string[];
    boards: IdeaBoardRow[];
    noteKinds: string[];
  } | null>(null);
  const [captureErr, setCaptureErr] = useState(false);
  const [live, setLive] = useState<boolean | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const toastSeq = useRef(0);
  const location = useLocation();
  const ws = currentProject(location.pathname);

  // ⌘⇧C — the compact Quick Capture modal (S-19; same component the
  // Easy Edit capture section hosts, kept free of the canvas runtime).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'c'
      ) {
        e.preventDefault();
        setCaptureOpen((o) => !o);
        return;
      }
      // `?` — shortcut help (skipped while typing in a field).
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
      if (!typing && e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setHelpOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loadCaptureData = useCallback(() => {
    setCaptureErr(false);
    client
      .workspaces()
      .then(async (r) => {
        const names = r.workspaces.map((w) => w.name);
        const t = await client.boardTaxonomy();
        const boardsWs = ws ?? names[0];
        let boards: IdeaBoardRow[] = [];
        if (boardsWs) {
          boards = (await client.ideaBoards(boardsWs)).boards;
        }
        setCaptureData({
          workspaces: ws ? [ws] : names,
          boards,
          noteKinds: t.note_kinds,
        });
      })
      .catch(() => setCaptureErr(true));
  }, [ws]);

  // Project switch invalidates the cached capture destinations.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ws is the invalidation trigger, not a value read inside
  useEffect(() => setCaptureData(null), [ws]);

  useEffect(() => {
    if (!captureOpen || captureData) return;
    loadCaptureData();
  }, [captureOpen, captureData, loadCaptureData]);

  const refreshBadge = useCallback(() => {
    client
      .inbox(ws ?? undefined)
      .then((r) => {
        // D20: snoozed items stay open but leave the badge count.
        const now = new Date().toISOString();
        setOpenCount(
          r.items.filter((i) => !i.snoozed_until || i.snoozed_until <= now)
            .length,
        );
      })
      .catch(() => setOpenCount(null));
  }, [ws]);

  const pushToast = useCallback((text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);

  // Single SSE stream for the app lifetime (API.md live channel).
  useEffect(() => {
    return subscribeStream({
      onOpen: refreshBadge, // reconnect → re-read durable state
      onState: setLive,
      onEvent: (type, payload) => {
        if (type === 'gate_surfaced' || type === 'gate_cleared') {
          refreshBadge();
        } else if (type === 'notification') {
          const n = payload as StreamEventMap['notification'];
          // Only durable notification rows are user-facing —
          // `board_item_updated` hint frames carry no `subject` and
          // the affected surfaces already refresh from the hint.
          const text = notificationToastText(n);
          if (text) pushToast(text);
        }
      },
    });
  }, [refreshBadge, pushToast]);

  return (
    <div className="shell">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <nav className="nav" aria-label="primary">
        <div className="brand">veto</div>
        <NavLink to="/projects" end>
          Projects
        </NavLink>
        {ws && (
          <NavLink to={projectPath(ws)} end>
            Home
            {openCount !== null && openCount > 0 && (
              <span className="count" aria-label="open items">
                {openCount}
              </span>
            )}
          </NavLink>
        )}
        {ws &&
          NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink key={item.sub} to={projectPath(ws, item.sub)}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        {live !== null && (
          <output
            className={`conn${live ? '' : ' off'}`}
            title={
              live
                ? 'live — stream connected'
                : 'offline — stream disconnected, retrying'
            }
          >
            <span className="conn-dot" aria-hidden="true" />
            {live ? 'live' : 'offline'}
          </output>
        )}
        <button
          type="button"
          className="link nav-help"
          title="keyboard shortcuts"
          aria-label="keyboard shortcuts"
          onClick={() => setHelpOpen(true)}
        >
          ?
        </button>
      </nav>
      <main
        id="main"
        className={`main${
          matchPath('/projects/:ws/boards/:board', location.pathname)
            ? ' route-board'
            : ''
        }`}
        key={location.pathname}
      >
        <Routes>
          <Route path="/" element={<IndexRedirect />} />
          <Route path="/projects" element={<Workspaces />} />
          <Route path="/projects/:ws" element={<ProjectLayout />}>
            <Route index element={<Home />} />
            <Route path="boards" element={<Boards />} />
            <Route path="boards/:board" element={<IdeaBoard />} />
            {/* /capture retired (D67) — S-19 lives on Easy Edit. */}
            <Route path="capture" element={<Navigate to="boards" replace />} />
            <Route path="tray" element={<Tray />} />
            <Route path="new" element={<CreateImport />} />
            <Route path="discovery/:session" element={<DiscoverySession />} />
            <Route path="features/:id" element={<FeatureWorkspace />} />
            <Route path="tickets/:id" element={<TicketFocus />} />
            <Route path="tickets/:id/wizard" element={<Wizard />} />
            <Route path="tickets/:id/docs/:name" element={<DocReview />} />
            <Route path="tickets/:id/review" element={<CodeReview />} />
            <Route path="tickets/:id/pr" element={<PrPanel />} />
            <Route path="tickets/:id/ledger" element={<Ledger />} />
            <Route path="runs" element={<RunsList />} />
            <Route path="runs/:id" element={<RunMonitor />} />
            <Route path="queue" element={<Escalations />} />
            <Route path="merge-center" element={<MergeCenter />} />
            <Route path="releases" element={<ReleaseCenter />} />
            <Route path="releases/:rel" element={<ReleaseCenter />} />
            <Route path="ledger" element={<Ledger />} />
            <Route path="metrics" element={<Metrics />} />
            <Route path="kb" element={<KnowledgeBase />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          {/* Pre-project-first URLs: ws-bearing paths map 1:1, flat
              paths land in the remembered project (or the picker). */}
          <Route path="/boards" element={<FlatRedirect to="boards" />} />
          <Route path="/boards/:ws/*" element={<LegacyProjectRedirect />} />
          <Route path="/capture" element={<FlatRedirect to="boards" />} />
          <Route path="/tray" element={<FlatRedirect to="tray" />} />
          <Route path="/new" element={<FlatRedirect to="new" />} />
          <Route path="/discovery/:ws/*" element={<LegacyProjectRedirect />} />
          <Route path="/features/:ws/*" element={<LegacyProjectRedirect />} />
          <Route path="/tickets/:ws/*" element={<LegacyProjectRedirect />} />
          <Route path="/runs" element={<FlatRedirect to="runs" />} />
          <Route path="/runs/:id" element={<LegacyRunRedirect />} />
          <Route path="/queue" element={<FlatRedirect to="queue" />} />
          <Route
            path="/merge-center"
            element={<FlatRedirect to="merge-center" />}
          />
          <Route path="/releases" element={<FlatRedirect to="releases" />} />
          <Route path="/releases/:ws/*" element={<LegacyProjectRedirect />} />
          <Route path="/ledger" element={<FlatRedirect to="ledger" />} />
          <Route path="/metrics" element={<FlatRedirect to="metrics" />} />
          <Route path="/kb" element={<FlatRedirect to="kb" />} />
          <Route path="/settings" element={<FlatRedirect to="settings" />} />
          <Route
            path="/workspaces"
            element={<Navigate to="/projects" replace />}
          />
          <Route path="*" element={<IndexRedirect />} />
        </Routes>
      </main>
      {captureOpen && (
        <Modal label="quick capture" onClose={() => setCaptureOpen(false)} wide>
          <strong>Quick capture</strong>
          {captureData ? (
            <CaptureForm
              compact
              workspaces={captureData.workspaces}
              boards={captureData.boards}
              noteKinds={captureData.noteKinds}
              onSaved={() => pushToast('captured → tray')}
              onNavigate={() => setCaptureOpen(false)}
            />
          ) : captureErr ? (
            <p className="muted">
              couldn't load projects —{' '}
              <button type="button" className="link" onClick={loadCaptureData}>
                retry
              </button>
            </p>
          ) : (
            <p className="muted">
              <span className="spinner" aria-hidden="true" />
              Loading…
            </p>
          )}
        </Modal>
      )}
      {helpOpen && (
        <Modal label="keyboard shortcuts" onClose={() => setHelpOpen(false)}>
          <strong>Keyboard shortcuts</strong>
          <table className="kv-table">
            <tbody>
              <tr>
                <td className="mono">⌘⇧C</td>
                <td>quick capture — open/close the capture modal</td>
              </tr>
              <tr>
                <td className="mono">?</td>
                <td>this help</td>
              </tr>
              <tr>
                <td className="mono">Esc</td>
                <td>close modal / inspector / dialog</td>
              </tr>
              <tr>
                <td className="mono">← →</td>
                <td>switch tabs (when a tab bar is focused)</td>
              </tr>
            </tbody>
          </table>
          <p className="muted">
            Buttons and links are fully keyboard-reachable — Tab moves, Enter
            activates.
          </p>
        </Modal>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
            {import.meta.env.DEV && <Link to="/"> →</Link>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return isDemoMode() ? <DemoApp /> : <ProductionApp />;
}
