import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_TIMEOUTS,
  loadGlobalConfig,
  loadWorkspaceConfig,
  parseEnv,
  resolveConfig,
} from '../src/index.js';

let root: string;
let globalDir: string;
let ticketsRepo: string;

const globalConfigPath = () => join(globalDir, 'config.yaml');
const repoConfigDir = () => join(ticketsRepo, '.sprint-runner');
const repoConfigPath = () => join(repoConfigDir(), 'config.yaml');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sr-config-test-'));
  globalDir = join(root, 'global');
  ticketsRepo = join(root, 'tickets');
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(repoConfigDir(), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('precedence — frontmatter > repo > global > defaults', () => {
  it('applies all four levels in order', () => {
    writeFileSync(
      globalConfigPath(),
      [
        'schema: 1',
        'actor: global-bot',
        'backend: aider',
        'gates: minimal',
        'spec_depth: light',
        'timeouts:',
        '  implement: 100',
      ].join('\n'),
    );
    writeFileSync(
      repoConfigPath(),
      ['schema: 1', 'actor: repo-bot', 'gates: full', 'spec_depth: deep'].join(
        '\n',
      ),
    );

    const global = loadGlobalConfig(globalConfigPath());
    const ws = loadWorkspaceConfig(ticketsRepo, global);

    // repo overrides global; untouched keys keep global values
    expect(ws.config.actor).toBe('repo-bot');
    expect(ws.config.gates).toBe('full');
    expect(ws.config.backend).toBe('aider');
    expect(ws.config.spec_depth).toBe('deep');

    // resolved, no frontmatter: repo values stand, defaults fill rest
    const eff = resolveConfig(null, ws);
    expect(eff.actor).toBe('repo-bot');
    expect(eff.gates).toBe('full');
    expect(eff.backend).toBe('aider');
    expect(eff.spec_depth).toBe('deep');
    expect(eff.merge_strategy).toBe('squash'); // schema default
    expect(eff.timeouts.implement).toBe(100); // global override
    expect(eff.timeouts.interview).toBe(DEFAULT_TIMEOUTS.interview); // SETTINGS default

    // frontmatter beats everything (model → main_model, depth → spec_depth)
    const eff2 = resolveConfig(
      { model: 'openrouter/org/model', depth: 'light', gates: 'minimal' },
      ws,
    );
    expect(eff2.main_model).toBe('openrouter/org/model');
    expect(eff2.spec_depth).toBe('light');
    expect(eff2.gates).toBe('minimal');
    expect(eff2.actor).toBe('repo-bot');
  });

  it('defaults match SETTINGS.md literally', () => {
    const eff = resolveConfig(null, {
      config: { schema: 1, actor: 'bot' },
      warnings: [],
      secrets: {},
      files: [],
    });
    expect(eff.backend).toBe('devin');
    expect(eff.permission_mode).toBe('smart');
    expect(eff.gates).toBe('full');
    expect(eff.spec_depth).toBe('standard');
    expect(eff.merge_strategy).toBe('squash');
    expect(eff.concurrency.implement).toBe(1);
    expect(eff.worktree_root).toBe('sibling');
    expect(eff.survey).toMatchObject({ refresh: 'weekly', timeout: 7200 });
    expect(eff.survey.sources).toEqual([
      'code',
      'docs',
      'screenshots',
      'crawl',
    ]);
    expect(eff.budgets).toMatchObject({
      shepherd_max_cycles: 5,
      fix_dismissal_cap: 2,
      split_max_children: 5,
    });
    expect(eff.prior_art_recall).toBe(true);
    expect(eff.semantic).toMatchObject({
      embeddings: 'local',
      entity_linking: true,
      dedupe: true,
    });
    expect(eff.storage_url).toBe(
      'sqlite://~/.local/share/sprint-runner/state.db',
    );
    expect(eff.leases_via).toBe('auto');
    expect(eff.security).toMatchObject({
      scanner: 'gitleaks',
      scan_on_commit: true,
    });
    expect(eff.ui).toMatchObject({
      bind: '127.0.0.1',
      port: 4711,
      remote_access: false,
    });
    expect(eff.voice).toBe('auto');
    expect(eff.notifications).toMatchObject({ desktop: true, badge: true });
    expect(eff.review).toMatchObject({ auto_fix_rounds: 2 });
    expect(eff.review.auto_fix_severities).toEqual(['blocker', 'major']);
    expect(eff.shepherd.poll_interval_s).toBe(60);
    expect(eff.timeouts.verify).toBe(3600);
    expect(eff.capabilities.devin).toEqual({
      can_exec: true,
      can_write_outside_tree: true,
      has_gh: true,
    });
    expect(eff.capabilities.aider).toEqual({
      can_exec: true,
      can_write_outside_tree: false,
      has_gh: false,
    });
    expect(eff.importers.github?.token_env).toBe('GITHUB_TOKEN');
    expect(eff.ui.token_file).toContain('ui-token');
  });
});

describe('unknown keys', () => {
  it('rejects an unknown top-level key and lists valid paths', () => {
    writeFileSync(
      globalConfigPath(),
      'schema: 1\nactor: bot\nbogus_key: true\n',
    );
    expect(() => loadGlobalConfig(globalConfigPath())).toThrowError(
      ConfigError,
    );
    try {
      loadGlobalConfig(globalConfigPath());
    } catch (e) {
      const err = e as ConfigError;
      expect(err.message).toContain('bogus_key');
      expect(err.message).toContain('actor');
      expect(err.message).toContain('ui.remote_access');
    }
  });

  it('rejects unknown nested keys', () => {
    writeFileSync(
      repoConfigPath(),
      'schema: 1\nui:\n  bind: 0.0.0.0\n  nope: 1\n',
    );
    expect(() =>
      loadWorkspaceConfig(ticketsRepo, {
        config: {},
        warnings: [],
        secrets: {},
        files: [],
      }),
    ).toThrowError(/ui\.nope/);
  });
});

describe('ui.remote_access', () => {
  it('surfaces a warning in the resolved config', () => {
    writeFileSync(
      globalConfigPath(),
      'schema: 1\nactor: bot\nui:\n  remote_access: true\n',
    );
    const eff = resolveConfig(null, loadGlobalConfig(globalConfigPath()));
    expect(eff.ui.remote_access).toBe(true);
    expect(eff.warnings.some((w) => w.includes('remote_access'))).toBe(true);
  });

  it('no warning when remote_access is off', () => {
    writeFileSync(globalConfigPath(), 'schema: 1\nactor: bot\n');
    const eff = resolveConfig(null, loadGlobalConfig(globalConfigPath()));
    expect(eff.warnings).toEqual([]);
  });
});

describe('actor', () => {
  it('throws a helpful error when actor is missing', () => {
    writeFileSync(globalConfigPath(), 'schema: 1\nbackend: devin\n');
    try {
      resolveConfig(null, loadGlobalConfig(globalConfigPath()));
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigError;
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('actor');
      expect(err.message).toContain('config.yaml');
      expect(err.message).toContain('frontmatter');
    }
  });

  it('accepts actor from frontmatter-adjacent config keys', () => {
    const eff = resolveConfig({ actor: 'ticket-bot' }, null);
    expect(eff.actor).toBe('ticket-bot');
  });
});

describe('.env parsing', () => {
  it('parses plain, quoted, exported, commented lines', () => {
    const env = parseEnv(
      [
        '# a comment',
        '',
        'GITHUB_TOKEN=ghp_abc123',
        'export JIRA_TOKEN=jira!xyz',
        'QUOTED="hello world"',
        "SQUOTED='single # not a comment'",
        'TRAILING=abc # trailing comment',
        'ESCAPED="line1\\nline2"',
        'EMPTY=',
        'not a valid line',
      ].join('\n'),
    );
    expect(env).toEqual({
      GITHUB_TOKEN: 'ghp_abc123',
      JIRA_TOKEN: 'jira!xyz',
      QUOTED: 'hello world',
      SQUOTED: 'single # not a comment',
      TRAILING: 'abc',
      ESCAPED: 'line1\nline2',
      EMPTY: '',
    });
  });

  it('loads global + repo .env files; repo secrets win', () => {
    writeFileSync(globalConfigPath(), 'schema: 1\nactor: bot\n');
    writeFileSync(
      join(globalDir, '.env'),
      'GITHUB_TOKEN=global_tok\nSHARED=global\n',
    );
    writeFileSync(join(repoConfigDir(), '.env'), 'SHARED=repo\nJIRA_TOKEN=j\n');
    const ws = loadWorkspaceConfig(
      ticketsRepo,
      loadGlobalConfig(globalConfigPath()),
    );
    const eff = resolveConfig(null, ws);
    expect(eff.secrets).toEqual({
      GITHUB_TOKEN: 'global_tok',
      SHARED: 'repo',
      JIRA_TOKEN: 'j',
    });
  });

  it('never leaks secret values into error messages', () => {
    writeFileSync(globalConfigPath(), 'schema: 1\nactor: bot\nbogus: 1\n');
    writeFileSync(join(globalDir, '.env'), 'GITHUB_TOKEN=super-secret-v4lue\n');
    try {
      loadGlobalConfig(globalConfigPath());
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-v4lue');
    }
  });
});

describe('file handling', () => {
  it('missing files are fine — defaults apply, actor still required', () => {
    const ws = loadWorkspaceConfig(ticketsRepo, {
      config: {},
      warnings: [],
      secrets: {},
      files: [],
    });
    expect(ws.config).toEqual({});
    expect(() => resolveConfig(null, ws)).toThrowError(ConfigError);
  });

  it('rejects a non-mapping YAML document', () => {
    writeFileSync(globalConfigPath(), '- just\n- a\n- list\n');
    expect(() => loadGlobalConfig(globalConfigPath())).toThrowError(
      ConfigError,
    );
  });
});
