/**
 * S-02 — Settings. GET /settings → form → PUT /settings. Secrets are
 * write-only fields (never read back — API.md). Tabs per UI-INVENTORY:
 * General · Code Repos · Backends & Keys · Models · Gates & Budgets ·
 * Merge · UI.
 */
import { useEffect, useState } from 'react';
import { ApiError, client } from '../api';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  TabPanel,
  Tabs,
} from '../components';
import { DictationField } from '../dictation';
import { useLoad } from '../hooks';

type ThemeMode = 'system' | 'dark' | 'light';

/** Client-side theme apply — mirrors the index.html bootstrap so a
 *  change takes effect without reload. `ui.theme` in config is the
 *  durable source (SETTINGS.md D34); localStorage is the FOUC cache. */
function applyTheme(mode: ThemeMode) {
  try {
    localStorage.setItem('veto.theme', mode);
  } catch {
    /* private mode — apply for this session only */
  }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme =
    mode === 'system' ? (dark ? 'dark' : 'light') : mode;
}

function themeNow(): ThemeMode {
  try {
    const s = localStorage.getItem('veto.theme');
    return s === 'dark' || s === 'light' ? s : 'system';
  } catch {
    return 'system';
  }
}

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
  min,
  step,
}: {
  label: string;
  path: string;
  config: Config;
  onChange: (path: string, v: unknown) => void;
  type?: string;
  placeholder?: string;
  min?: string;
  step?: string;
}) {
  const v = get(config, path);
  return (
    <Field label={label}>
      <DictationField>
        <input
          type={type}
          value={v === null || v === undefined ? '' : String(v)}
          placeholder={placeholder}
          min={min}
          step={step}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(path, null);
            if (type === 'number') return onChange(path, Number(raw));
            return onChange(path, raw);
          }}
        />
      </DictationField>
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
  const { data, error, loading, reload } = useLoad(() => client.settings(), []);
  const [draft, setDraft] = useState<Config | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<(typeof TABS)[number]>('General');
  const [saved, setSaved] = useState<string[] | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const config = draft ?? (data?.config as Config | undefined) ?? {};
  // ui.theme in config is durable truth — sync the client cache once
  // settings land so other sessions inherit the operator's choice.
  useEffect(() => {
    const t = get(config, 'ui.theme');
    if (
      (t === 'dark' || t === 'light' || t === 'system') &&
      t !== themeNow()
    ) {
      applyTheme(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const dirty = draft !== null || Object.keys(secrets).length > 0;
  // Warn before abandoning an unsaved draft.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
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

  const repos =
    (config.repos as Record<string, { path?: string; url?: string }>) ?? {};
  // Repos present only in the draft are new — flag them unsaved.
  const savedRepos =
    ((data?.config as Config | undefined)?.repos as Record<string, unknown>) ??
    {};

  return (
    <section>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Writes merge into the global config.yaml; secrets land in .env and are
        never read back.
      </p>
      <Tabs
        ariaLabel="settings sections"
        active={tab}
        onChange={(t) => setTab(t as (typeof TABS)[number])}
        tabs={TABS.map((t) => ({ id: t, label: t }))}
      />
      <TabPanel id={tab}>
      {saved?.map((w) => (
        <div key={w} className={w === 'Saved.' ? 'card' : 'warn-banner'}>
          {w}
        </div>
      ))}
      {saveError != null && <ErrorBox error={saveError} />}

      {tab === 'General' && (
        <div>
          <TextField
            label="Actor (this install's identity)"
            path="actor"
            config={config}
            onChange={onChange}
          />
          <SelectField
            label="Backend"
            path="backend"
            options={['devin', 'aider']}
            config={config}
            onChange={onChange}
          />
          <SelectField
            label="Permission mode"
            path="permission_mode"
            options={['smart', 'bypass', 'accept-edits']}
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Storage URL"
            path="storage_url"
            config={config}
            onChange={onChange}
          />
          <SelectField
            label="Voice"
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
                {savedRepos[name] === undefined && (
                  <span className="badge spec-warn">unsaved</span>
                )}
                {r.url && (
                  <a
                    className="muted mono"
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.url}
                  </a>
                )}
                <span className="muted mono">{r.path}</span>
              </div>
            </div>
          ))}
          <h3 className="group-title">Add from GitHub</h3>
          <p className="muted">
            Paste a GitHub URL — Veto clones it into its managed data dir and
            registers it. Private repos need GITHUB_TOKEN (Backends &amp; Keys).
          </p>
          <GithubAdder onCloned={() => reload()} />
          <h3 className="group-title">Add repo</h3>
          <RepoAdder
            onAdd={(name, path) => onChange(`repos.${name}.path`, path)}
          />
          <h3 className="group-title">Products</h3>
          <details>
            <summary className="muted">
              Managed products (read-only mapping)
            </summary>
            <pre className="terminal">
              {JSON.stringify(config.products ?? {}, null, 2)}
            </pre>
          </details>
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
            label="GitHub token env var"
            path="importers.github.token_env"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Jira base URL"
            path="importers.jira.base_url"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Jira token env var"
            path="importers.jira.token_env"
            config={config}
            onChange={onChange}
          />
        </div>
      )}

      {tab === 'Models' && (
        <div>
          <TextField
            label="Main model"
            path="main_model"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Review model"
            path="review_model"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Escalation model"
            path="escalation_model"
            config={config}
            onChange={onChange}
          />
          <SelectField
            label="Spec depth"
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
            label="Gates"
            path="gates"
            options={['full', 'plan-package', 'minimal']}
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Spend cap (USD per ticket)"
            path="budgets.spend_cap_usd_per_ticket"
            type="number"
            min="0"
            step="0.01"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Tokens cap per ticket"
            path="budgets.tokens_cap_per_ticket"
            type="number"
            min="0"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Shepherd max cycles"
            path="budgets.shepherd_max_cycles"
            type="number"
            min="0"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Fix dismissal cap"
            path="budgets.fix_dismissal_cap"
            type="number"
            min="0"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Split max children"
            path="budgets.split_max_children"
            type="number"
            min="1"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Implement concurrency"
            path="concurrency.implement"
            type="number"
            min="1"
            config={config}
            onChange={onChange}
          />
        </div>
      )}

      {tab === 'Merge & UI' && (
        <div>
          <SelectField
            label="Merge strategy"
            path="merge_strategy"
            options={['squash', 'merge', 'rebase']}
            config={config}
            onChange={onChange}
          />
          <TextField
            label="Worktree root"
            path="worktree_root"
            config={config}
            onChange={onChange}
          />
          <h3 className="group-title">UI</h3>
          <Field label="Theme">
            <select
              value={String(get(config, 'ui.theme') ?? themeNow())}
              onChange={(e) => {
                const v = e.target.value as ThemeMode;
                onChange('ui.theme', v);
                applyTheme(v);
              }}
              style={{ width: 'auto' }}
            >
              <option value="system">system</option>
              <option value="dark">dark</option>
              <option value="light">light</option>
            </select>
          </Field>
          <TextField
            label="UI bind host"
            path="ui.bind"
            config={config}
            onChange={onChange}
          />
          <TextField
            label="UI port"
            path="ui.port"
            type="number"
            min="1"
            config={config}
            onChange={onChange}
          />
          <Field label="Remote access (widens bind — warns on save)">
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
          <h3 className="group-title">Board</h3>
          <p className="muted">
            Per-column WIP soft caps — the board column count renders amber
            when exceeded. Empty = no limit.
          </p>
          <div className="row">
            {(['backlog', 'spec', 'build', 'review', 'done'] as const).map(
              (phase) => (
                <Field
                  key={phase}
                  label={phase.slice(0, 1).toUpperCase() + phase.slice(1)}
                >
                  <DictationField style={{ width: 90, flex: '0 0 auto' }}>
                    <input
                      type="number"
                      min={1}
                      value={String(
                        get(config, `ui.wip_limits.${phase}`) ?? '',
                      )}
                      onChange={(e) =>
                        onChange(
                          `ui.wip_limits.${phase}`,
                          e.target.value === ''
                            ? undefined
                            : Number(e.target.value),
                        )
                      }
                    />
                  </DictationField>
                </Field>
              ),
            )}
          </div>
          <TextField
            label="Shepherd poll interval (seconds)"
            path="shepherd.poll_interval_s"
            type="number"
            config={config}
            onChange={onChange}
          />
        </div>
      )}

      </TabPanel>

      <div className="save-bar">
        <button
          type="button"
          className="primary"
          disabled={saving || (!draft && Object.keys(secrets).length === 0)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {(draft || Object.keys(secrets).length > 0) && (
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              setSecrets({});
            }}
          >
            Discard changes
          </button>
        )}
        {(draft || Object.keys(secrets).length > 0) && (
          <span className="badge spec-warn">
            unsaved{Object.keys(secrets).length > 0 ? ' (+ secrets)' : ''}
          </span>
        )}
      </div>
    </section>
  );
}

function GithubAdder({ onCloned }: { onCloned: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const { repo } = await client.cloneRepo({
        url,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setDone(`Cloned ${repo.url} → ${repo.path}`);
      setUrl('');
      setName('');
      onCloned();
    } catch (e) {
      // 5xx bodies carry a generic 'internal error' message (API.md
      // scrub) — map the code to something actionable.
      setErr(
        e instanceof ApiError && e.code === 'clone_failed'
          ? new Error(
              'Clone failed — check the URL; for a private repo set ' +
                'GITHUB_TOKEN under Backends & Keys.',
            )
          : e,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="row">
        <DictationField style={{ flex: 1, minWidth: 280 }}>
          <input
            aria-label="github repo url"
            placeholder="https://github.com/org/repo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </DictationField>
        <DictationField style={{ width: 200, flex: '0 0 auto' }}>
          <input
            aria-label="repo name (optional)"
            placeholder="name (defaults to repo)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </DictationField>
        <button
          type="button"
          className="primary"
          disabled={busy || !url.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'Cloning…' : 'Clone'}
        </button>
      </div>
      {err != null && <ErrorBox error={err} />}
      {done && <p className="muted">{done}</p>}
    </div>
  );
}

function RepoAdder({ onAdd }: { onAdd: (name: string, path: string) => void }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  return (
    <div className="row">
      <DictationField style={{ width: 160, flex: '0 0 auto' }}>
        <input
          aria-label="repo name"
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </DictationField>
      <DictationField>
        <input
          aria-label="repo path"
          placeholder="/abs/path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
      </DictationField>
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
