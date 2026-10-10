/**
 * S-01 Home — Board (default) + Inbox tabs (D21). Tab choice persists
 * per session/user. The capture tray input (D27) rides the header —
 * one box, POST /capture → the item lands in the project tray.
 */
import { useEffect, useState } from 'react';
import { client } from '../api';
import { ErrorBox, TabPanel, Tabs } from '../components';
import { DictationField } from '../dictation';
import { useProject } from '../project';
import Board from './Board';
import Inbox from './Inbox';

const TAB_KEY = 'veto_home_tab';
/** wp-100 rename — one-time migration from the pre-rename key. */
const LEGACY_TAB_KEY = 'sr_home_tab';
type HomeTab = 'board' | 'inbox';

function savedTab(): HomeTab {
  try {
    const legacy = localStorage.getItem(LEGACY_TAB_KEY);
    if (legacy != null && localStorage.getItem(TAB_KEY) == null) {
      localStorage.setItem(TAB_KEY, legacy);
    }
    localStorage.removeItem(LEGACY_TAB_KEY);
    return localStorage.getItem(TAB_KEY) === 'inbox' ? 'inbox' : 'board';
  } catch {
    return 'board';
  }
}

export default function Home() {
  const ws = useProject();
  const [tab, setTab] = useState<HomeTab>(savedTab);
  // Inbox count on the tab itself — the nav badge isn't visible
  // context once you're on the Board tab (audit H1).
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  useEffect(() => {
    client
      .inbox(ws)
      .then((r) => {
        const now = new Date().toISOString();
        setInboxCount(
          r.items.filter((i) => !i.snoozed_until || i.snoozed_until <= now)
            .length,
        );
      })
      .catch(() => setInboxCount(null));
  }, [ws]);
  const pick = (t: string) => {
    setTab(t as HomeTab);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <section className="home-screen">
      <div className="row home-header">
        <h1 className="page-title">Home</h1>
        <Tabs
          inline
          ariaLabel="home view"
          active={tab}
          onChange={pick}
          tabs={[
            { id: 'board', label: 'Board' },
            {
              id: 'inbox',
              label: (
                <>
                  Inbox
                  {inboxCount !== null && inboxCount > 0 && (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      {inboxCount}
                    </span>
                  )}
                </>
              ),
            },
          ]}
        />
        <span className="spacer" />
        <CaptureTray />
      </div>
      <TabPanel id={tab}>{tab === 'board' ? <Board /> : <Inbox />}</TabPanel>
    </section>
  );
}

/** D27 quick capture — minimal ingress into the project tray. */
function CaptureTray() {
  const ws = useProject();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

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
    <span className="row quick-capture">
      {note && <output className="muted">{note}</output>}
      {open ? (
        <>
          <DictationField style={{ width: 220, flex: '0 0 auto' }}>
            <input
              aria-label="capture title"
              placeholder="Capture an idea…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              // biome-ignore lint/a11y/noAutofocus: opening the tray is an explicit user action
              autoFocus
            />
          </DictationField>
          <span className="muted">→ {ws} tray</span>
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
            aria-label="close capture"
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
