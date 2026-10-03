/**
 * S-13 — workspace switcher: tickets repos with per-repo queue counts;
 * add workspace (name + git url → clone).
 */
import { useState } from 'react';
import { client } from '../api';
import { Empty, ErrorBox, Field, Loading } from '../components';
import { useLoad, useStreamRefresh } from '../hooks';

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
      <h1 className="page-title">Workspaces</h1>
      <p className="page-sub">
        Tickets repos this conductor serves — the inbox unifies them.
      </p>
      {state.loading && <Loading />}
      {state.error != null && <ErrorBox error={state.error} />}
      {error != null && <ErrorBox error={error} />}
      {state.data && state.data.workspaces.length === 0 && (
        <Empty label="No workspaces registered." />
      )}
      {(state.data?.workspaces ?? []).map((w) => (
        <div className="card" key={w.name}>
          <div className="card-title">
            <strong>{w.name}</strong>
            <span className="mono muted">{w.tickets_repo_path}</span>
            <span className="spacer" />
            <span className="badge">{w.open_gate_items} open items</span>
            <span className="badge">{w.queue_depth} queued runs</span>
          </div>
        </div>
      ))}
      <h2 className="group-title">Add workspace</h2>
      <div className="row">
        <Field label="name">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="tickets repo url">
          <input
            value={url}
            placeholder="git@github.com:org/tickets.git"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <button
          type="button"
          className="primary"
          disabled={busy || !name || !url}
          onClick={() => void add()}
        >
          {busy ? 'Cloning…' : 'Add'}
        </button>
      </div>
    </section>
  );
}
