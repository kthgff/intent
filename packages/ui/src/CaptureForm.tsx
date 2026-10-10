/**
 * S-19 — Quick Capture form (s-19-capture-tray.md). Minimal, mobile-safe
 * ingress: one input, guessed type with one-tap correction, project,
 * board-or-tray destination, immediate durable confirmation. Shared by
 * the global ⌘⇧C modal (App.tsx, `compact`) and the Easy Edit capture
 * section — capture must never turn into an interview.
 */
import type { BoardItem } from '@veto/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { type IdeaBoardRow, client } from './api';
import { ErrorBox } from './components';
import { DictationField } from './dictation';
import { guessCaptureKind, noteKindMeta } from './discovery';
import { projectPath } from './project';

export function CaptureForm({
  workspaces,
  boards,
  noteKinds,
  defaultWorkspace,
  defaultDestination,
  compact = false,
  onSaved,
  onNavigate,
}: {
  workspaces: string[];
  boards: IdeaBoardRow[];
  noteKinds: string[];
  defaultWorkspace?: string;
  /** Pre-selected destination slug — a board the caller knows belongs to
   *  `defaultWorkspace` (Easy Edit passes the current board). Falls back
   *  to the tray when absent or when the fetched board list doesn't carry
   *  the slug. */
  defaultDestination?: string;
  compact?: boolean;
  onSaved?: (item: BoardItem, destination: string) => void;
  /** Fired when the save-banner destination link is followed — the
   *  hosting modal uses it to close before navigating. */
  onNavigate?: () => void;
}) {
  const [workspace, setWorkspace] = useState(
    defaultWorkspace ?? workspaces[0] ?? '',
  );
  // Boards are per-workspace — the parent may only have fetched the
  // first workspace's set, so the form refetches on workspace change
  // (never offer another workspace's boards as a destination).
  const [localBoards, setLocalBoards] = useState<IdeaBoardRow[]>(boards);
  // True while the authoritative board list is in flight — the
  // destination-reset check below must not fire on the cleared interim
  // list or a valid `defaultDestination` collapses to tray on mount.
  const [boardsPending, setBoardsPending] = useState(boards.length === 0);
  const [text, setText] = useState('');
  const [kind, setKind] = useState('idea');
  const [kindTouched, setKindTouched] = useState(false);
  const [destination, setDestination] = useState<string>(
    defaultDestination ?? 'tray',
  );
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
    // Clear immediately — the previous workspace's boards are not valid
    // destinations while the new list is in flight.
    setLocalBoards([]);
    setBoardsPending(true);
    let live = true;
    client
      .ideaBoards(workspace)
      .then((r) => {
        if (live) setLocalBoards(r.boards);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setBoardsPending(false);
      });
    return () => {
      live = false;
    };
  }, [workspace]);

  // A chosen board destination belongs to the previous workspace —
  // reset to tray when the workspace changes under it. The check waits
  // for a settled list so an in-flight refetch never falsifies it.
  useEffect(() => {
    if (boardsPending) return;
    setDestination((d) =>
      d !== 'tray' && !localBoards.some((b) => b.board === d) ? 'tray' : d,
    );
  }, [localBoards, boardsPending]);

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
      <DictationField>
        <textarea
          aria-label="capture text"
          rows={compact ? 3 : 5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Idea, want, problem, question, feedback…"
          // biome-ignore lint/a11y/noAutofocus: modal opens on an explicit ⌘⇧C — focus belongs inside
          autoFocus={compact}
        />
      </DictationField>
      <fieldset className="row capture-kind-picker" aria-label="type">
        <span className="muted capture-kind-label">type</span>
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
      <div className="row capture-destination">
        <label className="muted" htmlFor="cap-ws">
          project
        </label>
        <select
          id="cap-ws"
          className="auto"
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
          className="auto"
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
            to={projectPath(
              workspace,
              destination === 'tray'
                ? '/tray'
                : `/boards/${encodeURIComponent(destination)}`,
            )}
            onClick={onNavigate}
          >
            open destination →
          </Link>
        </output>
      )}
    </div>
  );
}
