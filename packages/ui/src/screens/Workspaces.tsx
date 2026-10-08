/**
 * S-13 — project picker (Jira-style landing): tickets repos rendered
 * as cards with per-repo queue counts; selecting a card enters that
 * project. Add workspace (name + git url → clone) at the bottom.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api';
import { Empty, ErrorBox, Field, Loading } from '../components';
import { useLoad, useStreamRefresh } from '../hooks';
import { projectPath } from '../project';

export default function Workspaces() {
  const state = useLoad(() => client.workspaces(), []);
  useStreamRefresh(state.reload, ['gate_surfaced', 'gate_cleared']);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.addWorkspace({ name, url });
      setName('');
      setUrl('');
      state.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1 className="page-title">Projects</h1>
      <p className="page-sub">
        Pick a project to open its boards, runs, and settings.
      </p>
      {state.loading && <Loading />}
      {state.error != null && <ErrorBox error={state.error} />}
      {error != null && <ErrorBox error={error} />}
      {state.data && state.data.workspaces.length === 0 && (
        <Empty label="No workspaces registered." />
      )}
      <div className="cards">
        {(state.data?.workspaces ?? []).map((w) => (
          <Link className="card" key={w.name} to={projectPath(w.name)}>
            <div className="card-title">
              <strong>{w.name}</strong>
              <span className="mono muted">{w.root_path}</span>
              <span className="spacer" />
              <span className="badge">{w.open_gate_items} open items</span>
              <span className="badge">{w.queue_depth} queued runs</span>
            </div>
          </Link>
        ))}
      </div>
      <h2 className="group-title">Add project</h2>
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
          title={!name || !url ? 'name and repo url are required' : undefined}
          onClick={() => void add()}
        >
          {busy ? 'Cloning…' : 'Add'}
        </button>
      </div>
    </section>
  );
}
