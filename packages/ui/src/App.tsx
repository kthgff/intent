/**
 * App shell — nav, inbox badge, SSE-driven toasts (UI-INVENTORY: the
 * app is a needs-attention inbox; badge counts drive the daily loop).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { type IdeaBoardRow, client } from './api';
import DemoApp, { isDemoMode } from './demo/DemoApp';
import Boards from './screens/Boards';
import Capture, { CaptureForm } from './screens/Capture';
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
import { subscribeStream } from './sse';

interface Toast {
  id: number;
  text: string;
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
  const toastSeq = useRef(0);
  const location = useLocation();

  // ⌘⇧C — the compact Quick Capture modal (S-19; same component as
  // /capture, loaded lazily so it never carries the canvas runtime).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'c'
      ) {
        e.preventDefault();
        setCaptureOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!captureOpen || captureData) return;
    client
      .workspaces()
      .then(async (r) => {
        const names = r.workspaces.map((w) => w.name);
        const t = await client.boardTaxonomy();
        let boards: IdeaBoardRow[] = [];
        if (names[0]) {
          boards = (await client.ideaBoards(names[0])).boards;
        }
        setCaptureData({
          workspaces: names,
          boards,
          noteKinds: t.note_kinds,
        });
      })
      .catch(() =>
        setCaptureData({ workspaces: [], boards: [], noteKinds: [] }),
      );
  }, [captureOpen, captureData]);

  const refreshBadge = useCallback(() => {
    client
      .inbox()
      .then((r) => {
        // D20: snoozed items stay open but leave the badge count.
        const now = new Date().toISOString();
        setOpenCount(
          r.items.filter((i) => !i.snoozed_until || i.snoozed_until <= now)
            .length,
        );
      })
      .catch(() => setOpenCount(null));
  }, []);

  const pushToast = useCallback((text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);

  // Single SSE stream for the app lifetime (API.md live channel).
  useEffect(() => {
    return subscribeStream({
      onOpen: refreshBadge, // reconnect → re-read durable state
      onEvent: (type, payload) => {
        if (type === 'gate_surfaced' || type === 'gate_cleared') {
          refreshBadge();
        } else if (type === 'notification') {
          const n = payload as StreamEventMap['notification'];
          pushToast(`${n.kind}: ${n.subject}`);
        }
      },
    });
  }, [refreshBadge, pushToast]);

  return (
    <div className="shell">
      <nav className="nav" aria-label="primary">
        <div className="brand">veto</div>
        <NavLink to="/" end>
          Home
          {openCount !== null && openCount > 0 && (
            <span className="count" aria-label="open items">
              {openCount}
            </span>
          )}
        </NavLink>
        <NavLink to="/boards">Boards</NavLink>
        <NavLink to="/capture">Capture</NavLink>
        <NavLink to="/tray">Tray</NavLink>
        <NavLink to="/new">Create / Import</NavLink>
        <NavLink to="/runs">Runs</NavLink>
        <NavLink to="/queue">Failures</NavLink>
        <NavLink to="/merge-center">Merge</NavLink>
        <NavLink to="/releases">Releases</NavLink>
        <NavLink to="/workspaces">Workspaces</NavLink>
        <NavLink to="/kb">Knowledge base</NavLink>
        <NavLink to="/metrics">Metrics</NavLink>
        <NavLink to="/ledger">Ledger</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <main className="main" key={location.key}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/new" element={<CreateImport />} />
          <Route path="/boards" element={<Boards />} />
          <Route path="/boards/:ws/:board" element={<IdeaBoard />} />
          <Route path="/capture" element={<Capture />} />
          <Route path="/tray" element={<Tray />} />
          <Route
            path="/discovery/:ws/:session"
            element={<DiscoverySession />}
          />
          <Route path="/features/:ws/:id" element={<FeatureWorkspace />} />
          <Route path="/tickets/:ws/:id" element={<TicketFocus />} />
          <Route path="/tickets/:ws/:id/wizard" element={<Wizard />} />
          <Route path="/tickets/:ws/:id/docs/:name" element={<DocReview />} />
          <Route path="/tickets/:ws/:id/review" element={<CodeReview />} />
          <Route path="/tickets/:ws/:id/pr" element={<PrPanel />} />
          <Route path="/tickets/:ws/:id/ledger" element={<Ledger />} />
          <Route path="/runs" element={<RunsList />} />
          <Route path="/runs/:id" element={<RunMonitor />} />
          <Route path="/queue" element={<Escalations />} />
          <Route path="/merge-center" element={<MergeCenter />} />
          <Route path="/releases" element={<ReleaseCenter />} />
          <Route path="/releases/:ws/:rel" element={<ReleaseCenter />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/workspaces" element={<Workspaces />} />
          <Route path="/kb" element={<KnowledgeBase />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      {captureOpen && (
        <div
          className="modal-back"
          role="presentation"
          onClick={() => setCaptureOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setCaptureOpen(false)}
        >
          <dialog
            open
            className="modal"
            aria-label="quick capture"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Escape must still dismiss — swallowing every keydown
              // here blocked the backdrop's handler.
              e.stopPropagation();
              if (e.key === 'Escape') setCaptureOpen(false);
            }}
          >
            <strong>Quick capture</strong>
            {captureData ? (
              <CaptureForm
                compact
                workspaces={captureData.workspaces}
                boards={captureData.boards}
                noteKinds={captureData.noteKinds}
                onSaved={() => pushToast('captured → tray')}
              />
            ) : (
              <p className="muted">Loading…</p>
            )}
          </dialog>
        </div>
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
