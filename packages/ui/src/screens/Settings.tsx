/**
 * S-02 — Settings. GET /settings → form → PUT /settings. Secrets are
 * write-only fields (never read back — API.md). Tabs per UI-INVENTORY:
 * General · Code Repos · Backends & Keys · Models · Gates & Budgets ·
 * Merge · UI.
 */
import { useState } from 'react';
import { client } from '../api';
import { Empty, ErrorBox, Field, Loading } from '../components';
import { useLoad } from '../hooks';

type Config = Record<string, unknown>;

function get(c: Config, path: string): unknown {
  let cur: unknown = c;
  for (const k of path.split('.')) {
    if (cur && typeof cur === 'object') cur = (cur as Config)[k];
    else return undefined;
  }
  return cur;
}

function set(c: Config, path: string, value: unknown): Config {
  const [head, ...rest] = path.split('.');
  if (!head) return c;
  const out: Config = { ...c };
  if (rest.length === 0) {
    if (value === undefined) delete out[head];
    else out[head] = value;
    return out;
  }
  out[head] = set((out[head] as Config) ?? {}, rest.join('.'), value);
  return out;
}

function TextField({
  label,
  path,
  config,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  path: string;
  config: Config;
  onChange: (path: string, v: unknown) => void;
  type?: string;
  placeholder?: string;
}) {
  const v = get(config, path);
  return (
    <Field label={label}>
      <input
        type={type}
        value={v === null || v === undefined ? '' : String(v)}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(path, null);
          if (type === 'number') return onChange(path, Number(raw));
          return onChange(path, raw);
        }}
      />
    </Field>
  );
}

function SelectField({
  label,
  path,
  options,
  config,
  onChange,
}: {
  label: string;
  path: string;
  options: string[];
  config: Config;
  onChange: (path: string, v: unknown) => void;
}) {
  const v = get(config, path);
  return (
    <Field label={label}>
      <select
        value={v === null || v === undefined ? '' : String(v)}
        onChange={(e) => onChange(path, e.target.value || null)}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Field>
  );
}

const TABS = [
  'General',
  'Code Repos',
  'Backends & Keys',
  'Models',
  'Gates & Budgets',
  'Merge & UI',
] as const;

export default function Settings() {
  const { data, error, loading } = useLoad(() => client.settings(), []);
  const [draft, setDraft] = useState<Config | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<(typeof TABS)[number]>('General');
  const [saved, setSaved] = useState<string[] | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const config = draft ?? (data?.config as Config | undefined) ?? {};
  const onChange = (path: string, v: unknown) => {
    setDraft((d) => set(d ?? { ...(data?.config as Config) }, path, v));
    setSaved(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await client.putSettings({
        ...(draft ? { config: draft } : {}),
        ...(Object.keys(secrets).length ? { secrets } : {}),
      });
      setSaved(res.warnings.length ? res.warnings : ['Saved.']);
      setDraft(null);
      setSecrets({});
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty />;

  const repos = (config.repos as Record<string, { path?: string }>) ?? {};

  return (
    <section>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Writes merge into the global config.yaml; secrets land in .env and are
        never read back.
      </p>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {saved?.map((w) => (
        <div key={w} className={w === 'Saved.' ? 'card' : 'warn-banner'}>
          {w}
        </div>
      ))}
      {saveError != null && <ErrorBox error={saveError} />}

      {tab === 'General' && (
        <div>
          <TextField
            label="actor (this install's identity)"
            path="actor"
            config={config}
            onChange={onChange}
          />
          <SelectField
            label="backend"
            path="backend"
            options={['devin', 'aider']}
            config={config}
            onChange={onChange}
          />
          <SelectField
            label="permission_mode"
            path="permission_mode"
            options={['smart', 'bypass', 'accept-edits']}
            config={config}
            onChange={onChange}
          />
          <TextField
            label="storage_url"
            path="storage_url"
            config={config}
            onChange={onChange}
          />
          <SelectField
            label="voice"
            path="voice"
            options={['auto', 'off']}
            config={config}
            onChange={onChange}
          />
        </div>
      )}

      {tab === 'Code Repos' && (
        <div>
          {Object.keys(repos).length === 0 && (
            <Empty label="No code repos configured." />
          )}
          {Object.entries(repos).map(([name, r]) => (
            <div className="card" key={name}>
              <div className="card-title">
                <strong>{name}</strong>
                <span className="muted mono">{r.path}</span>
              </div>
            </div>
          ))}
          <h3 className="group-title">Add repo</h3>
          <RepoAdder
            onAdd={(name, path) => onChange(`repos.${name}.path`, path)}
          />
          <h3 className="group-title">Products</h3>
          <pre className="terminal">
            {JSON.stringify(config.products ?? {}, null, 2)}
          </pre>
        </div>
      )}

      {tab === 'Backends & Keys' && (
        <div>
          <p className="muted">
            Keys are write-only — they go to .env and are never returned by the
            API.
          </p>
          {['OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'JIRA_TOKEN'].map((k) => (
            <Field key={k} label={`${k} (write-only)`}>
              <input
                type="password"
                value={secrets[k] ?? ''}
                placeholder="••••••••"
                onChange={(e) =>
                  setSecrets((s) => ({ ...s, [k]: e.target.value }))
                }
              />
            </Field>
          ))}
          <TextField
            label="github token_env"
            path="importers.github.token_env"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="jira base_url"
            path="importers.jira.base_url"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="jira token_env"
            path="importers.jira.token_env"
            config={config}
            onChange={onChange}
          />
        </div>
      )}

      {tab === 'Models' && (
        <div>
          <TextField
            label="main_model"
            path="main_model"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="review_model"
            path="review_model"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="escalation_model"
            path="escalation_model"
            config={config}
            onChange={onChange}
          />
          <SelectField
            label="spec_depth"
            path="spec_depth"
            options={['light', 'standard', 'deep']}
            config={config}
            onChange={onChange}
          />
        </div>
      )}

      {tab === 'Gates & Budgets' && (
        <div>
          <SelectField
            label="gates"
            path="gates"
            options={['full', 'plan-package', 'minimal']}
            config={config}
            onChange={onChange}
          />
          <TextField
            label="spend cap usd / ticket"
            path="budgets.spend_cap_usd_per_ticket"
            type="number"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="tokens cap / ticket"
            path="budgets.tokens_cap_per_ticket"
            type="number"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="shepherd max cycles"
            path="budgets.shepherd_max_cycles"
            type="number"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="fix dismissal cap"
            path="budgets.fix_dismissal_cap"
            type="number"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="split max children"
            path="budgets.split_max_children"
            type="number"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="implement concurrency"
            path="concurrency.implement"
            type="number"
            config={config}
            onChange={onChange}
          />
        </div>
      )}

      {tab === 'Merge & UI' && (
        <div>
          <SelectField
            label="merge_strategy"
            path="merge_strategy"
            options={['squash', 'merge', 'rebase']}
            config={config}
            onChange={onChange}
          />
          <TextField
            label="worktree_root"
            path="worktree_root"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="ui.bind"
            path="ui.bind"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="ui.port"
            path="ui.port"
            type="number"
            config={config}
            onChange={onChange}
          />
          <Field label="ui.remote_access (widens bind — warns on save)">
            <select
              value={String(get(config, 'ui.remote_access') ?? false)}
              onChange={(e) =>
                onChange('ui.remote_access', e.target.value === 'true')
              }
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </Field>
          <TextField
            label="shepherd poll interval (s)"
            path="shepherd.poll_interval_s"
            type="number"
            config={config}
            onChange={onChange}
          />
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="primary"
          disabled={saving || (!draft && Object.keys(secrets).length === 0)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {draft && (
          <button type="button" onClick={() => setDraft(null)}>
            Discard changes
          </button>
        )}
      </div>
    </section>
  );
}

function RepoAdder({ onAdd }: { onAdd: (name: string, path: string) => void }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  return (
    <div className="row">
      <input
        aria-label="repo name"
        placeholder="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ width: 160 }}
      />
      <input
        aria-label="repo path"
        placeholder="/abs/path"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <button
        type="button"
        disabled={!name || !path}
        onClick={() => {
          onAdd(name, path);
          setName('');
          setPath('');
        }}
      >
        Add
      </button>
    </div>
  );
}
