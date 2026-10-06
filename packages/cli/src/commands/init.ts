/**
 * `init` — onboard this install (wp-099):
 *
 *   1. scaffold `~/.config/veto/` — config.yaml, .env (0600),
 *      ui-token (0600, auto-generated per API.md);
 *   2. detect PATH deps (git, gitleaks, gh, docker, backend CLIs) and
 *      print a readable report — a missing REQUIRED dep is a nonzero
 *      exit + named remediation;
 *   3. register the current repo as a project: a `projects` row whose
 *      `settings.path` is the workspace root (DB is truth, D29) plus a
 *      `repos.<name>.path` entry in config.yaml; a structural probe
 *      reports detected verify/lint/build commands — the conductor's
 *      own `probe:<repo>` run verifies the card (SETTINGS auto-probe).
 *
 * Idempotent: existing files/rows are kept, never rewritten blindly.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { loadOrCreateToken } from '@veto/api';
import {
  ConfigError,
  type LoadedConfig,
  defaultGlobalConfigPath,
  loadGlobalConfig,
} from '@veto/config';
import type { PartialConfig } from '@veto/config';
import { ConfigSchema } from '@veto/core';
import { PostgresStore } from '@veto/store';
import YAML from 'yaml';
import { formatDepsReport, missingRequired, probeDeps } from '../deps.js';
import { defaultWorkspaceRoot } from '../paths.js';

/** Schema-level defaults (no actor) — used for storage_url fallback
 *  when the effective config can't fully resolve yet. */
const DEFAULTS = ConfigSchema.parse({ schema: 1 });

export interface InitOptions {
  /** `--config <path>` — also selects the scaffolded directory. */
  configPath?: string;
  /** Project/workspace name (default: repo dir basename). */
  project?: string;
  /** Repo dir to register (default: cwd). */
  path?: string;
  /** Skip project registration entirely. */
  noProject?: boolean;
  io: { out(s: string): void; err(s: string): void };
  /** Injectable dep probe (tests). */
  probe?: typeof probeDeps;
}

// ---------------------------------------------------------------------------
// Scaffold templates
// ---------------------------------------------------------------------------

function defaultActor(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? 'veto';
  }
}

function configTemplate(actor: string): string {
  return `# veto configuration — spec: docs/SETTINGS.md
schema: 1
actor: ${actor}          # REQUIRED — this install's identity (machine commits,
                       # claims, event attribution)
backend: devin           # devin | aider
# permission_mode: smart # smart | bypass | accept-edits
# main_model: null       # null = backend default
# repos:                 # code repos tickets may target — init registers
#   myrepo:              #   entries here
#     path: /abs/path
# storage_url: ${DEFAULTS.storage_url}
#                        # Postgres is the system of record (D29)
# ui:
#   bind: 127.0.0.1      # loopback only — agents exec arbitrary code
#   port: 4711
`;
}

const ENV_TEMPLATE = `# Secrets only — never committed, never logged (SETTINGS.md).
# OPENROUTER_API_KEY=
# GITHUB_TOKEN=
# JIRA_TOKEN=
`;

// ---------------------------------------------------------------------------
// Repo probing (structural — real verification is the probe run's job)
// ---------------------------------------------------------------------------

export interface RepoProbe {
  path: string;
  git: boolean;
  branch?: string;
  remote?: string;
  detected: { test?: string; lint?: string; build?: string };
}

function gitProbe(dir: string): {
  ok: boolean;
  toplevel?: string;
  branch?: string;
  remote?: string;
} {
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (top.error || top.status !== 0) return { ok: false };
  const toplevel = top.stdout.toString().trim();
  const branch = spawnSync(
    'git',
    ['-C', toplevel, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const remote = spawnSync(
    'git',
    ['-C', toplevel, 'config', '--get', 'remote.origin.url'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const out: {
    ok: boolean;
    toplevel: string;
    branch?: string;
    remote?: string;
  } = {
    ok: true,
    toplevel,
  };
  if (branch.status === 0 && branch.stdout.toString().trim()) {
    out.branch = branch.stdout.toString().trim();
  }
  if (remote.status === 0 && remote.stdout.toString().trim()) {
    out.remote = remote.stdout.toString().trim();
  }
  return out;
}

/** Detect verify/lint/build command candidates from repo files. */
async function detectCommands(dir: string): Promise<RepoProbe['detected']> {
  const out: RepoProbe['detected'] = {};
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const pm = existsSync(join(dir, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(join(dir, 'yarn.lock'))
          ? 'yarn'
          : 'npm';
      const run = (s: string) =>
        s === 'test' ? `${pm} test` : `${pm} run ${s}`;
      if (scripts.test) out.test = run('test');
      if (scripts.lint) out.lint = run('lint');
      if (scripts.build) out.build = run('build');
    } catch {
      /* malformed package.json — the probe agent judges later */
    }
  }
  const makefile = join(dir, 'Makefile');
  if (existsSync(makefile)) {
    const text = await readFile(makefile, 'utf8').catch(() => '');
    for (const [target, key] of [
      ['test', 'test'],
      ['lint', 'lint'],
      ['build', 'build'],
    ] as const) {
      if (new RegExp(`^${target}:`, 'm').test(text) && out[key] === undefined) {
        out[key] = `make ${target}`;
      }
    }
  }
  return out;
}

export async function probeRepo(dir: string): Promise<RepoProbe> {
  const git = gitProbe(dir);
  const path = git.toplevel ?? resolve(dir);
  const probe: RepoProbe = {
    path,
    git: git.ok,
    detected: git.ok ? await detectCommands(path) : {},
  };
  if (git.branch !== undefined) probe.branch = git.branch;
  if (git.remote !== undefined) probe.remote = git.remote;
  return probe;
}

// ---------------------------------------------------------------------------
// config.yaml repo write-back — YAML Document edits preserve comments
// ---------------------------------------------------------------------------

/** Set `repos.<name>.path` in config.yaml, preserving comments/format.
 *  Returns 'added' | 'kept' | 'conflict' (existing path differs). */
export async function registerRepoInConfig(
  configPath: string,
  name: string,
  path: string,
): Promise<'added' | 'kept' | 'conflict'> {
  const text = existsSync(configPath) ? await readFile(configPath, 'utf8') : '';
  const doc = YAML.parseDocument(text || '{}');
  const existing = doc.getIn(['repos', name, 'path']);
  if (typeof existing === 'string') {
    return existing === path ? 'kept' : 'conflict';
  }
  if (doc.get('repos') == null || doc.get('repos') === undefined) {
    doc.set('repos', doc.createNode({}));
  }
  doc.setIn(['repos', name, 'path'], path);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, String(doc), 'utf8');
  return 'added';
}

// ---------------------------------------------------------------------------
// Project registration
// ---------------------------------------------------------------------------

/** Workspace-name rule (server.ts WorkspaceNameSchema — slug-shaped). */
const WS_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function slugifyWorkspace(raw: string): string {
  const slug = raw
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/-+$/, '');
  return slug.slice(0, 64);
}

async function registerProject(
  store: PostgresStore,
  name: string,
  rootPath: string,
): Promise<void> {
  const existing = await store.getProject(name);
  await store.upsertProject({
    workspace: name,
    name,
    next_ticket_seq: existing?.next_ticket_seq ?? 1,
    next_feature_seq: existing?.next_feature_seq ?? 1,
    next_initiative_seq: existing?.next_initiative_seq ?? 1,
    next_release_seq: existing?.next_release_seq ?? 1,
    // `settings.path` persists the workspace root so `daemon` can
    // reconstruct ConductorWorkspaces after restart (spec gap —
    // projects has no path column; see TRACKER wp-099 decision).
    settings: { ...(existing?.settings ?? {}), path: rootPath },
    created_at: existing?.created_at ?? new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// cmdInit
// ---------------------------------------------------------------------------

export async function cmdInit(opts: InitOptions): Promise<number> {
  const { io } = opts;
  const probe = opts.probe ?? probeDeps;
  const configPath = opts.configPath ?? defaultGlobalConfigPath();
  const dir = dirname(configPath);
  let failures = 0;
  const fail = (msg: string) => {
    io.err(`error: ${msg}`);
    failures += 1;
  };

  io.out(`init — config dir ${dir}`);

  // --- 1. scaffold files ---
  await mkdir(dir, { recursive: true });
  if (existsSync(configPath)) {
    io.out('  config.yaml  exists — kept');
  } else {
    await writeFile(configPath, configTemplate(defaultActor()), 'utf8');
    io.out(
      `  config.yaml  written (actor: ${defaultActor()} — edit to change)`,
    );
  }
  const envPath = join(dir, '.env');
  if (existsSync(envPath)) {
    io.out('  .env         exists — kept');
  } else {
    await writeFile(envPath, ENV_TEMPLATE, { mode: 0o600 });
    io.out('  .env         written (0600)');
  }

  // Token file path: config.ui.token_file wins; else the config dir.
  // A malformed pre-existing config.yaml fails closed here.
  let loaded: LoadedConfig;
  try {
    loaded = loadGlobalConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const tokenFile = loaded.config.ui?.token_file ?? join(dir, 'ui-token');
  try {
    loadOrCreateToken(tokenFile);
    io.out(`  ui-token     ${tokenFile} (0600)`);
  } catch (e) {
    fail((e as Error).message);
  }

  // --- 2. dep detection report ---
  const partial: PartialConfig = loaded.config;
  const checks = probe({
    backend: partial.backend ?? 'devin',
    scanOnCommit: partial.security?.scan_on_commit ?? true,
  });
  io.out('');
  io.out('dependencies:');
  io.out(formatDepsReport(checks));

  // --- 3. project registration ---
  if (opts.noProject) {
    io.out('');
    io.out('project: skipped (--no-project)');
  } else {
    const target = resolve(opts.path ?? process.cwd());
    const repoProbe = await probeRepo(target);
    if (
      !repoProbe.git &&
      opts.project === undefined &&
      opts.path === undefined
    ) {
      io.out('');
      io.out(
        'project: cwd is not a git repo — skipped registration ' +
          '(run `veto init` inside a code repo, or pass --project/--path)',
      );
    } else {
      const name = opts.project ?? slugifyWorkspace(basename(repoProbe.path));
      if (!name || !WS_NAME_RE.test(name)) {
        fail(
          `invalid project name '${name}' — must match ${WS_NAME_RE.source}`,
        );
      } else {
        const rootPath = defaultWorkspaceRoot(name);
        await mkdir(rootPath, { recursive: true });
        io.out('');
        io.out(`project: ${name} (workspace root ${rootPath})`);
        if (repoProbe.git) {
          const repoName = slugifyWorkspace(basename(repoProbe.path));
          const reg = await registerRepoInConfig(
            configPath,
            repoName,
            repoProbe.path,
          );
          if (reg === 'conflict') {
            io.err(
              `  repo ${repoName}  config.yaml already maps a different path — kept`,
            );
          } else {
            io.out(
              `  repo ${repoName}  ${repoProbe.path}${reg === 'kept' ? ' (already registered)' : ''}`,
            );
          }
          const det = Object.entries(repoProbe.detected)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          io.out(
            `  probe        git repo${repoProbe.branch ? ` on ${repoProbe.branch}` : ''}${det ? ` — detected ${det}` : ' — no test/lint/build commands detected'} (unverified; the first repo-executing run queues 'probe')`,
          );
        } else {
          io.out(`  ${repoProbe.path} is not a git repo — no repo registered`);
        }

        // DB: project row with settings.path (fail-soft — init still
        // succeeds without storage; daemon can't boot until fixed).
        try {
          const store = await PostgresStore.connect(
            partial.storage_url ?? DEFAULTS.storage_url,
          );
          try {
            await registerProject(store, name, rootPath);
            io.out(`  registered   projects row → settings.path=${rootPath}`);
          } finally {
            await store.close();
          }
        } catch (e) {
          io.err(
            `  warning: storage_url unreachable — project row not written (${(e as Error).message.split('\n')[0]}). Fix storage_url and re-run init to register.`,
          );
        }
      }
    }
  }

  // --- exit code: missing REQUIRED deps → nonzero + remediation ---
  const missing = missingRequired(checks);
  if (missing.length > 0 || failures > 0) {
    io.out('');
    for (const c of missing) {
      io.out(`MISSING: ${c.name} — ${c.remediation ?? 'install it'}`);
    }
    return 1;
  }
  io.out('');
  io.out('init complete — `veto daemon` boots the conductor + UI.');
  return 0;
}
