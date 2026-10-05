/**
 * App shell — nav, inbox badge, SSE-driven toasts (UI-INVENTORY: the
 * app is a needs-attention inbox; badge counts drive the daily loop).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { client } from './api';
import DemoApp, { isDemoMode } from './demo/DemoApp';
import CodeReview from './screens/CodeReview';
import CreateImport from './screens/CreateImport';
import DocReview from './screens/DocReview';
import Escalations from './screens/Escalations';
import Inbox from './screens/Inbox';
import KnowledgeBase from './screens/KnowledgeBase';
import Ledger from './screens/Ledger';
import Metrics from './screens/Metrics';
import PrPanel from './screens/PrPanel';
import RunMonitor, { RunsList } from './screens/RunMonitor';
import Settings from './screens/Settings';
import TicketDetail from './screens/TicketDetail';
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
  const toastSeq = useRef(0);
  const location = useLocation();

  const refreshBadge = useCallback(() => {
    client
      .inbox()
      .then((r) => setOpenCount(r.items.length))
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
          Inbox
          {openCount !== null && openCount > 0 && (
            <span className="count" aria-label="open items">
              {openCount}
            </span>
          )}
        </NavLink>
        <NavLink to="/new">Create / Import</NavLink>
        <NavLink to="/runs">Runs</NavLink>
        <NavLink to="/queue">Failures</NavLink>
        <NavLink to="/workspaces">Workspaces</NavLink>
        <NavLink to="/kb">Knowledge base</NavLink>
        <NavLink to="/metrics">Metrics</NavLink>
        <NavLink to="/ledger">Ledger</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <main className="main" key={location.key}>
        <Routes>
          <Route path="/" element={<Inbox />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/new" element={<CreateImport />} />
          <Route path="/tickets/:ws/:id" element={<TicketDetail />} />
          <Route path="/tickets/:ws/:id/wizard" element={<Wizard />} />
          <Route path="/tickets/:ws/:id/docs/:name" element={<DocReview />} />
          <Route path="/tickets/:ws/:id/review" element={<CodeReview />} />
          <Route path="/tickets/:ws/:id/pr" element={<PrPanel />} />
          <Route path="/tickets/:ws/:id/ledger" element={<Ledger />} />
          <Route path="/runs" element={<RunsList />} />
          <Route path="/runs/:id" element={<RunMonitor />} />
          <Route path="/queue" element={<Escalations />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/workspaces" element={<Workspaces />} />
          <Route path="/kb" element={<KnowledgeBase />} />
          <Route path="*" element={<Inbox />} />
        </Routes>
      </main>
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
