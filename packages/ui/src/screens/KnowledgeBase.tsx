import type { DossierEntry } from '@sprint-runner/core';
import { DOSSIER_SECTIONS } from '@sprint-runner/core';
/**
 * S-14 — knowledge base browser. Repo/product tabs; dossier sections;
 * gap report; per-section edit → PUT /kb/<scope>; manual Sync.
 */
import { useMemo, useState } from 'react';
import { client } from '../api';
import { Empty, ErrorBox, Field, Loading, Markdown } from '../components';
import { useLoad } from '../hooks';

const SECTION_LABEL: Record<string, string> = {
  'architecture-map': 'Architecture',
  'domain-model': 'Domain model',
  'user-workflows': 'Workflows',
  personas: 'Personas',
  'docs-digest': 'Docs',
  'ui-map': 'UI map',
  glossary: 'Glossary',
  landmines: 'Landmines',
  'gap-report': 'Gap report',
};

export default function KnowledgeBase() {
  const [scope, setScope] = useState<'repo' | 'product'>('repo');
  const [name, setName] = useState<string | null>(null);
  const list = useLoad(() => client.kbList(scope), [scope]);

  const names = useMemo(() => {
    const set = new Map<string, DossierEntry[]>();
    for (const d of list.data?.dossiers ?? []) {
      const arr = set.get(d.name) ?? [];
      arr.push(d);
      set.set(d.name, arr);
    }
    return [...set.keys()];
  }, [list.data]);

  const current = name ?? names[0] ?? null;

  return (
    <section>
      <h1 className="page-title">Knowledge base</h1>
      <p className="page-sub">
        Product dossiers — surveyed by agents, corrected by you.
      </p>
      <div className="tabs">
        {(['repo', 'product'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={scope === s ? 'active' : ''}
            onClick={() => {
              setScope(s);
              setName(null);
            }}
          >
            {s}
          </button>
        ))}
      </div>
      {list.loading && <Loading />}
      {list.error != null && <ErrorBox error={list.error} />}
      {list.data && names.length === 0 && (
        <Empty label="No dossiers surveyed yet." />
      )}
      <div className="split">
        {names.length > 0 && (
          <aside className="rail">
            {names.map((n) => (
              <div className="card" key={n}>
                <button
                  type="button"
                  className={current === n ? 'primary' : ''}
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => setName(n)}
                >
                  {n}
                </button>
              </div>
            ))}
          </aside>
        )}
        <div className="grow">
          {current && <Dossier scope={scope} name={current} />}
        </div>
      </div>
    </section>
  );
}

function Dossier({ scope, name }: { scope: string; name: string }) {
  const sections = useLoad(() => client.kbGet(scope, name), [scope, name]);
  const [section, setSection] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const list = sections.data?.sections ?? [];
  const bySection = new Map(list.map((s) => [s.section, s]));
  const current = section ?? list[0]?.section ?? null;
  const entry = current ? bySection.get(current as never) : undefined;
  const gap = bySection.get('gap-report' as never);

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const r = await client.kbSync(scope, name);
      setSyncMsg(`survey run queued: ${r.run}`);
    } catch (e) {
      setError(e);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <strong>{name}</strong>
        <span className="muted">{list.length} sections</span>
        <span className="spacer" />
        <button
          type="button"
          className="small"
          disabled={syncing}
          onClick={() => void sync()}
        >
          {syncing ? 'Queuing…' : 'Sync (re-survey)'}
        </button>
      </div>
      {syncMsg && <div className="card">{syncMsg}</div>}
      {error != null && <ErrorBox error={error} />}
      {sections.loading && <Loading />}
      {sections.error != null && <ErrorBox error={sections.error} />}
      {list.length === 0 && !sections.loading && (
        <Empty label="No sections for this dossier." />
      )}
      <div className="tabs">
        {DOSSIER_SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className={current === s ? 'active' : ''}
            onClick={() => setSection(s)}
          >
            {SECTION_LABEL[s] ?? s}
            {bySection.has(s as never) ? '' : ' ·'}
          </button>
        ))}
      </div>
      {entry ? (
        <SectionEditor
          scope={scope}
          name={name}
          entry={entry}
          onSaved={sections.reload}
        />
      ) : (
        current && <Empty label={`No ${current} section yet.`} />
      )}
      {current !== 'gap-report' && gap && (
        <p className="muted">Gap report available — see the Gap report tab.</p>
      )}
    </div>
  );
}

function SectionEditor({
  scope,
  name,
  entry,
  onSaved,
}: {
  scope: string;
  name: string;
  entry: DossierEntry;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.kbPut({
        scope,
        name,
        section: entry.section,
        content: draft,
      });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title">
        <span className="badge">v{entry.version}</span>
        {entry.stale && <span className="badge spec-bad">stale</span>}
        <span className="muted">
          surveyed {entry.surveyed_at.slice(0, 10)}
          {entry.edited_by ? ` · edited by ${entry.edited_by}` : ''}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="small"
          onClick={() => {
            setDraft(entry.content);
            setEditing(!editing);
          }}
        >
          {editing ? 'cancel' : 'edit'}
        </button>
      </div>
      {error != null && <ErrorBox error={error} />}
      {editing ? (
        <div>
          <Field label="markdown">
            <textarea
              rows={14}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      ) : (
        <Markdown text={entry.content} />
      )}
    </div>
  );
}
