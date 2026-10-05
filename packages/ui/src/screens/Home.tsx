/**
 * S-01 Home — Board (default) + Inbox tabs (D21). Tab choice persists
 * per session/user. The capture tray input (D27) rides the header —
 * one box, POST /capture → the item lands in the project tray.
 */
import { useEffect, useState } from 'react';
import { client } from '../api';
import { ErrorBox } from '../components';
import Board from './Board';
import Inbox from './Inbox';

const TAB_KEY = 'sr_home_tab';
type HomeTab = 'board' | 'inbox';

function savedTab(): HomeTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'inbox' ? 'inbox' : 'board';
  } catch {
    return 'board';
  }
}

export default function Home() {
  const [tab, setTab] = useState<HomeTab>(savedTab);
  const pick = (t: HomeTab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <section>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1 className="page-title" style={{ marginRight: 12 }}>
          Home
        </h1>
        <div className="tabs" role="tablist" style={{ border: 'none' }}>
          {(['board', 'inbox'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => pick(t)}
            >
              {t === 'board' ? 'Board' : 'Inbox'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <CaptureTray />
      </div>
      {tab === 'board' ? <Board /> : <Inbox />}
    </section>
  );
}

/** D27 quick capture — minimal ingress into the project tray. */
function CaptureTray() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [ws, setWs] = useState('');
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    client
      .workspaces()
      .then((r) => {
        const names = r.workspaces.map((w) => w.name);
        setWorkspaces(names);
        setWs((cur) => cur || (names[0] ?? ''));
      })
      .catch(() => {});
  }, [open]);

  const submit = async () => {
    if (!title.trim() || !ws) return;
    setBusy(true);
    setError(null);
    try {
      await client.capture({ workspace: ws, title: title.trim() });
      setTitle('');
      setNote('Captured to tray.');
      setTimeout(() => setNote(null), 4000);
      setOpen(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="row" style={{ gap: 6 }}>
      {note && <span className="muted">{note}</span>}
      {open ? (
        <>
          <input
            aria-label="capture title"
            placeholder="Capture an idea…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={{ width: 220 }}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          <select
            aria-label="capture workspace"
            style={{ width: 'auto' }}
            value={ws}
            onChange={(e) => setWs(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="small primary"
            disabled={busy || !title.trim() || !ws}
            onClick={() => void submit()}
          >
            Capture
          </button>
          <button
            type="button"
            className="small"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            ✕
          </button>
          {error != null && <ErrorBox error={error} />}
        </>
      ) : (
        <button
          type="button"
          className="small"
          onClick={() => setOpen(true)}
          title="quick capture → project tray"
        >
          + Capture
        </button>
      )}
    </span>
  );
}
