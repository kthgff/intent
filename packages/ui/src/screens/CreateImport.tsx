/**
 * S-03 — Create / Import. Interview tab: seed text → interview run.
 * Import tab: source + query → preview rows → commit.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type ImportPreviewRow, client } from '../api';
import { Empty, ErrorBox, Field, Loading, TabPanel, Tabs } from '../components';
import { DictationField } from '../dictation';
import { projectPath, useProject } from '../project';

export default function CreateImport() {
  const ws = useProject();
  const [tab, setTab] = useState<'interview' | 'import'>('interview');

  return (
    <section className="create-import-screen">
      <h1 className="page-title">Create / Import</h1>
      <Tabs
        ariaLabel="create or import"
        active={tab}
        onChange={(t) => setTab(t as 'interview' | 'import')}
        tabs={[
          { id: 'interview', label: 'Interview' },
          { id: 'import', label: 'Import' },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'interview' ? (
          <InterviewTab workspace={ws} />
        ) : (
          <ImportTab workspace={ws} />
        )}
      </TabPanel>
    </section>
  );
}

function InterviewTab({ workspace }: { workspace: string }) {
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
    <div className="create-panel interview-panel">
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
          <div className="row">
            <Link
              className="btn"
              to={projectPath(
                workspace,
                `/runs/${encodeURIComponent(result.run)}`,
              )}
            >
              Watch the run →
            </Link>
            <button
              type="button"
              className="small"
              onClick={() => {
                setResult(null);
                setText('');
              }}
            >
              Start another
            </button>
          </div>
        </div>
      ) : (
        <>
          <Field label="seed text">
            <DictationField>
              <textarea
                value={text}
                rows={6}
                placeholder="Describe the ticket in rough terms…"
                onChange={(e) => setText(e.target.value)}
              />
            </DictationField>
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

function ImportTab({ workspace }: { workspace: string }) {
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
    <div className="create-panel import-panel">
      <p className="page-sub">
        Pull issues from a tracker → preview → commit. Imported tickets land at
        status <code>imported</code>.
      </p>
      {error != null && <ErrorBox error={error} />}
      <div className="row import-fields">
        <Field label="source">
          <select value={source} disabled>
            <option value="github">github milestone/issues</option>
          </select>
        </Field>
        <Field label="repo (org/repo)">
          <DictationField>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} />
          </DictationField>
        </Field>
        <Field label="milestone">
          <DictationField>
            <input
              value={milestone}
              onChange={(e) => setMilestone(e.target.value)}
            />
          </DictationField>
        </Field>
        <Field label="labels (csv)">
          <DictationField>
            <input value={labels} onChange={(e) => setLabels(e.target.value)} />
          </DictationField>
        </Field>
      </div>
      <div className="row import-actions">
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
            Commit preview ({rows.length}{' '}
            {rows.length === 1 ? 'issue' : 'issues'})
          </button>
        )}
      </div>
      {committed && (
        <div className="card">
          Import committed — run <code>{committed}</code>.{' '}
          <Link
            to={projectPath(
              workspace,
              `/runs/${encodeURIComponent(committed)}`,
            )}
          >
            Watch →
          </Link>
        </div>
      )}
      {rows !== null &&
        (rows.length === 0 ? (
          <Empty label="No issues matched." />
        ) : (
          <>
            <p className="muted">
              {rows.length} {rows.length === 1 ? 'issue' : 'issues'} matched
            </p>
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
                    {Object.keys(rows[0] ?? {}).map((k) => {
                      const v = r[k];
                      return (
                        <td key={k}>
                          {v === null || v === undefined
                            ? ''
                            : typeof v === 'object'
                              ? JSON.stringify(v)
                              : String(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ))}
    </div>
  );
}
