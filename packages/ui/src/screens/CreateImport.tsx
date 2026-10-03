/**
 * S-03 — Create / Import. Interview tab: seed text → interview run.
 * Import tab: source + query → preview rows → commit.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type ImportPreviewRow, client } from '../api';
import { Empty, ErrorBox, Field, Loading } from '../components';
import { useLoad } from '../hooks';

export default function CreateImport() {
  const [tab, setTab] = useState<'interview' | 'import'>('interview');
  const ws = useLoad(() => client.workspaces(), []);
  const workspaces = ws.data?.workspaces ?? [];

  return (
    <section>
      <h1 className="page-title">Create / Import</h1>
      <div className="tabs">
        <button
          type="button"
          className={tab === 'interview' ? 'active' : ''}
          onClick={() => setTab('interview')}
        >
          Interview
        </button>
        <button
          type="button"
          className={tab === 'import' ? 'active' : ''}
          onClick={() => setTab('import')}
        >
          Import
        </button>
      </div>
      {ws.loading && <Loading />}
      {ws.error != null && <ErrorBox error={ws.error} />}
      {ws.data && workspaces.length === 0 && (
        <Empty label="No workspaces — add one first." />
      )}
      {tab === 'interview' && (
        <InterviewTab workspaces={workspaces.map((w) => w.name)} />
      )}
      {tab === 'import' && (
        <ImportTab workspaces={workspaces.map((w) => w.name)} />
      )}
    </section>
  );
}

function InterviewTab({ workspaces }: { workspaces: string[] }) {
  const [workspace, setWorkspace] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ subject: string; run: string } | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await client.interview(workspace, text));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="page-sub">
        Rough idea in → agent interviews you through the Q&A wizard →
        well-formed ticket committed.
      </p>
      {error != null && <ErrorBox error={error} />}
      {result ? (
        <div className="card">
          <p>
            Interview started — subject <code>{result.subject}</code>, run{' '}
            <code>{result.run}</code>.
          </p>
          <Link to={`/runs/${encodeURIComponent(result.run)}`}>
            Watch the run →
          </Link>
        </div>
      ) : (
        <>
          <Field label="workspace">
            <select
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
            >
              <option value="">choose…</option>
              {workspaces.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Field label="seed text">
            <textarea
              value={text}
              rows={6}
              placeholder="Describe the ticket in rough terms…"
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <button
            type="button"
            className="primary"
            disabled={busy || !workspace || !text.trim()}
            onClick={() => void start()}
          >
            {busy ? 'Starting…' : 'Start interview'}
          </button>
        </>
      )}
    </div>
  );
}

function ImportTab({ workspaces }: { workspaces: string[] }) {
  const [workspace, setWorkspace] = useState('');
  const [source] = useState('github');
  const [repo, setRepo] = useState('');
  const [milestone, setMilestone] = useState('');
  const [labels, setLabels] = useState('');
  const [rows, setRows] = useState<ImportPreviewRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<string | null>(null);

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.importPreview({
        workspace,
        source,
        ...(repo ? { repo } : {}),
        ...(milestone ? { milestone } : {}),
        ...(labels
          ? {
              labels: labels
                .split(',')
                .map((l) => l.trim())
                .filter(Boolean),
            }
          : {}),
      });
      setRows(r.rows);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.importCommit(workspace, source);
      setCommitted(r.run);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="page-sub">
        Pull issues from a tracker → preview → commit. Imported tickets land at
        status <code>imported</code>.
      </p>
      {error != null && <ErrorBox error={error} />}
      <div className="row">
        <Field label="workspace">
          <select
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            <option value="">choose…</option>
            {workspaces.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </Field>
        <Field label="source">
          <select value={source} disabled>
            <option value="github">github milestone/issues</option>
          </select>
        </Field>
        <Field label="repo (org/repo)">
          <input value={repo} onChange={(e) => setRepo(e.target.value)} />
        </Field>
        <Field label="milestone">
          <input
            value={milestone}
            onChange={(e) => setMilestone(e.target.value)}
          />
        </Field>
        <Field label="labels (csv)">
          <input value={labels} onChange={(e) => setLabels(e.target.value)} />
        </Field>
      </div>
      <div className="row">
        <button
          type="button"
          disabled={busy || !workspace || !repo}
          onClick={() => void preview()}
        >
          {busy ? 'Fetching…' : 'Preview'}
        </button>
        {rows !== null && !committed && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void commit()}
          >
            Commit import
          </button>
        )}
      </div>
      {committed && (
        <div className="card">
          Import committed — run <code>{committed}</code>.{' '}
          <Link to={`/runs/${encodeURIComponent(committed)}`}>Watch →</Link>
        </div>
      )}
      {rows !== null &&
        (rows.length === 0 ? (
          <Empty label="No issues matched." />
        ) : (
          <table>
            <thead>
              <tr>
                {Object.keys(rows[0] ?? {}).map((k) => (
                  <th key={k}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no stable id guarantee
                <tr key={i}>
                  {Object.keys(rows[0] ?? {}).map((k) => (
                    <td key={k}>{JSON.stringify(r[k] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}
