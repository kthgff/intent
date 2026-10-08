/**
 * S-15 — Boards list (UI-INVENTORY §2). Board cards with type/status
 * and per-type capability hints, a create form with the board-type
 * picker (board types are config, not pipelines — §15.3), plus the
 * workspace's discovery sessions (entry into the §15.9 wizard
 * surface).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api';
import type { IdeaBoardRow } from '../api';
import { Empty, ErrorBox, Field, Loading, StatusBadge } from '../components';
import { useBoardItemRefresh, useStreamRefresh } from '../hooks';
import { projectPath, useProject } from '../project';

export function BoardTypePicker({
  value,
  onChange,
  types,
}: {
  value: string;
  onChange: (v: string) => void;
  types: string[];
}) {
  return (
    <select
      aria-label="board type"
      className="auto"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">(no type)</option>
      {types.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

export default function Boards() {
  const workspace = useProject();
  const [boards, setBoards] = useState<IdeaBoardRow[] | null>(null);
  const [sessions, setSessions] = useState<
    Awaited<ReturnType<typeof client.interviewSessions>>['sessions'] | null
  >(null);
  const [taxonomy, setTaxonomy] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ board: '', name: '', board_type: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  const load = useCallback(() => {
    if (!workspace) {
      setBoards([]);
      setSessions([]);
      setLoading(false);
      return;
    }
    Promise.all([
      client.ideaBoards(workspace),
      client.interviewSessions(workspace),
    ])
      .then(([b, s]) => {
        setBoards(b.boards);
        setSessions(s.sessions);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [workspace]);

  useEffect(() => {
    load();
    client
      .boardTaxonomy()
      .then((t) => setTaxonomy(t.board_types))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useStreamRefresh(load, ['interview_updated']);
  useBoardItemRefresh(load);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const create = async () => {
    if (!workspace || !form.board.trim()) return;
    setCreating(true);
    try {
      await client.createIdeaBoard({
        workspace,
        board: form.board.trim(),
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        ...(form.board_type ? { board_type: form.board_type } : {}),
        status: 'discovery',
      });
      setForm({ board: '', name: '', board_type: '' });
      load();
    } catch (e) {
      setToast(`Create failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section>
      <h1 className="page-title">Boards</h1>
      <p className="page-sub">
        Idea boards — capture raw intent, synthesize it into governed work
        (S-15/S-16).
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="spacer" />
        <Link className="btn" to={projectPath(workspace, '/capture')}>
          + Quick capture
        </Link>
        <Link className="btn" to={projectPath(workspace, '/tray')}>
          Tray →
        </Link>
      </div>

      {error != null && <ErrorBox error={error} onRetry={load} />}
      {toast && <output className="warn-banner">{toast}</output>}
      {loading && !boards && <Loading />}

      {boards && boards.length === 0 && workspace && (
        <Empty label="No idea boards yet — create one below." />
      )}

      {boards && boards.length > 0 && (
        <div className="cards" aria-label="idea boards">
          {boards.map((b) => (
            <Link
              key={`${b.org ?? b.workspace}/${b.board}`}
              className="card board-card-link"
              to={projectPath(
                b.org ?? b.workspace,
                `/boards/${encodeURIComponent(b.board)}`,
              )}
            >
              <div className="row">
                <strong>{b.name ?? b.board}</strong>
                {b.board_type && <span className="badge">{b.board_type}</span>}
                {b.status && <StatusBadge status={b.status} />}
                {b.org && <span className="badge">org</span>}
              </div>
              <div className="muted" style={{ marginTop: 4 }}>
                {b.board}
                {b.type_config?.outputs?.length
                  ? ` · outputs: ${b.type_config.outputs.join(' · ')}`
                  : ''}
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>New board</h2>
        <div className="row">
          <Field label="slug">
            <input
              aria-label="board slug"
              value={form.board}
              onChange={(e) => {
                setSlugTouched(true);
                setForm({ ...form, board: e.target.value });
              }}
              placeholder="q1-goals"
            />
          </Field>
          <Field label="name">
            <input
              aria-label="board name"
              value={form.name}
              onChange={(e) =>
                setForm({
                  ...form,
                  name: e.target.value,
                  // auto-derive the slug until the user overrides it
                  ...(slugTouched ? {} : { board: slugify(e.target.value) }),
                })
              }
              placeholder="Q1 goals"
            />
          </Field>
          <Field label="type">
            <BoardTypePicker
              value={form.board_type}
              onChange={(v) => setForm({ ...form, board_type: v })}
              types={taxonomy}
            />
          </Field>
          <button
            type="button"
            className="primary"
            disabled={creating || !workspace || !form.board.trim()}
            onClick={() => void create()}
          >
            {creating ? 'Creating…' : 'Create board'}
          </button>
        </div>
        <p className="muted">
          Board type is config — inputs/capabilities/outputs/approval policy,
          not a pipeline (§15.3).
        </p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Discovery sessions</h2>
        {sessions && sessions.length > 0 ? (
          <ul className="list">
            {sessions.map((s) => (
              <li key={s.session_id} className="row">
                <Link
                  to={projectPath(
                    workspace,
                    `/discovery/${encodeURIComponent(s.session_id)}`,
                  )}
                >
                  {s.subject ?? s.session_id}
                </Link>
                <span className="muted">
                  {s.wizard_id} v{s.wizard_version ?? '?'} · {s.mode ?? '?'}
                </span>
                <StatusBadge status={s.status} />
                {s.draft_ready && <span className="badge">draft-ready</span>}
                {s.approval_ready && (
                  <span className="badge">approval-ready</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No discovery sessions yet —{' '}
            <Link to={projectPath(workspace, '/new')}>
              start an interview →
            </Link>
          </p>
        )}
      </div>
    </section>
  );
}
