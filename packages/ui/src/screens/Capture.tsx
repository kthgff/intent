import type { BoardItem } from '@veto/core';
/**
 * S-19 — Quick Capture (s-19-capture-tray.md). Minimal, mobile-safe
 * ingress: one input, guessed type with one-tap correction, project,
 * board-or-tray destination, immediate durable confirmation. The
 * exported `CaptureForm` is the same component the global ⌘⇧C modal
 * hosts — capture must never turn into an interview.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type IdeaBoardRow, client } from '../api';
import { ErrorBox, Loading } from '../components';
import { guessCaptureKind, noteKindMeta } from '../discovery';

export function CaptureForm({
  workspaces,
  boards,
  noteKinds,
  defaultWorkspace,
  compact = false,
  onSaved,
}: {
  workspaces: string[];
  boards: IdeaBoardRow[];
  noteKinds: string[];
  defaultWorkspace?: string;
  compact?: boolean;
  onSaved?: (item: BoardItem, destination: string) => void;
}) {
  const [workspace, setWorkspace] = useState(
    defaultWorkspace ?? workspaces[0] ?? '',
  );
  // Boards are per-workspace — the parent may only have fetched the
  // first workspace's set, so the form refetches on workspace change
  // (never offer another workspace's boards as a destination).
  const [localBoards, setLocalBoards] = useState<IdeaBoardRow[]>(boards);
  const [text, setText] = useState('');
  const [kind, setKind] = useState('idea');
  const [kindTouched, setKindTouched] = useState(false);
  const [destination, setDestination] = useState<string>('tray');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<BoardItem | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Type is guessed live until the user corrects it (one-tap).
  useEffect(() => {
    if (!kindTouched) setKind(guessCaptureKind(text));
  }, [text, kindTouched]);

  useEffect(() => setLocalBoards(boards), [boards]);

  useEffect(() => {
    if (!workspace) return;
    let live = true;
    client
      .ideaBoards(workspace)
      .then((r) => {
        if (live) setLocalBoards(r.boards);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspace]);

  // A chosen board destination belongs to the previous workspace —
  // reset to tray when the workspace changes under it.
  useEffect(() => {
    setDestination((d) =>
      d !== 'tray' && !localBoards.some((b) => b.board === d) ? 'tray' : d,
    );
  }, [localBoards]);

  const save = async () => {
    if (!workspace || !text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const title = text.trim().split('\n')[0]?.slice(0, 140) ?? 'capture';
      let item: BoardItem;
      let dest: string;
      if (destination === 'tray') {
        item = (
          await client.capture({
            workspace,
            title,
            kind: 'note',
            body: text.trim(),
          })
        ).item;
        // Kind lands via the OCC-fenced patch so the guess is durable.
        item = (
          await client.patchBoardItem(item.id, {
            workspace,
            ...(item.updated_at != null
              ? { expected_updated_at: item.updated_at }
              : {}),
            note_kind: kind,
          })
        ).item;
        dest = 'tray';
      } else {
        item = (
          await client.addBoardItem(destination, {
            workspace,
            title,
            body: text.trim(),
            note_kind: kind,
          })
        ).item;
        dest = destination;
      }
      setSaved(item);
      setText('');
      setKindTouched(false);
      onSaved?.(item, dest);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={compact ? 'capture-form compact' : 'capture-form'}>
      {error != null && <ErrorBox error={error} />}
      <textarea
        aria-label="capture text"
        rows={compact ? 3 : 5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Idea, want, problem, question, feedback…"
      />
      <fieldset
        className="row"
        aria-label="type"
        style={{ border: 'none', padding: 0, margin: 0 }}
      >
        {noteKinds.map((k) => (
          <button
            key={k}
            type="button"
            className={kind === k ? 'small primary' : 'small'}
            onClick={() => {
              setKind(k);
              setKindTouched(true);
            }}
          >
            {noteKindMeta(k).icon} {noteKindMeta(k).label}
          </button>
        ))}
      </fieldset>
      <div className="row">
        <label className="muted" htmlFor="cap-ws">
          project
        </label>
        <select
          id="cap-ws"
          style={{ width: 'auto' }}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <label className="muted" htmlFor="cap-dest">
          to
        </label>
        <select
          id="cap-dest"
          style={{ width: 'auto' }}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        >
          <option value="tray">Tray</option>
          {localBoards.map((b) => (
            <option key={b.board} value={b.board}>
              {b.name ?? b.board}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="primary"
          disabled={saving || !workspace || !text.trim()}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {saved && (
        <output className="save-banner">
          Saved to {destination === 'tray' ? 'the tray' : destination}.{' '}
          <button
            type="button"
            className="small"
            onClick={() => setSaved(null)}
          >
            add another
          </button>{' '}
          <Link
            to={
              destination === 'tray'
                ? '/tray'
                : `/boards/${workspace}/${destination}`
            }
          >
            open destination →
          </Link>
        </output>
      )}
    </div>
  );
}

export default function Capture() {
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [boards, setBoards] = useState<IdeaBoardRow[]>([]);
  const [noteKinds, setNoteKinds] = useState<string[]>([]);
  const [ws, setWs] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([client.workspaces(), client.boardTaxonomy()])
      .then(([w, t]) => {
        const names = w.workspaces.map((x) => x.name);
        setWorkspaces(names);
        setNoteKinds(t.note_kinds);
        if (names.length > 0) setWs(names[0] ?? '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!ws) return;
    client
      .ideaBoards(ws)
      .then((r) => setBoards(r.boards))
      .catch(() => {});
  }, [ws]);

  const wsBoards = useMemo(() => boards, [boards]);

  if (loading) return <Loading />;
  return (
    <section>
      <h1 className="page-title">Quick capture</h1>
      <p className="page-sub">
        Record an idea or production signal — decide where it belongs later
        (S-19).
      </p>
      <div className="card" style={{ maxWidth: 640 }}>
        <CaptureForm
          workspaces={workspaces}
          boards={wsBoards}
          noteKinds={noteKinds}
          defaultWorkspace={ws}
        />
      </div>
    </section>
  );
}
