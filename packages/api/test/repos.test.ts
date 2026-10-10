/**
 * repos API tests — POST /repos/clone (GitHub connect from Settings →
 * Code Repos). fastify inject only; the git layer is stubbed via the
 * `gitClone` ServerOptions seam — what we verify is argument
 * construction, secret handling, path safety, and config persistence.
 *
 *   - URL parsing accepts https/ssh/git@ GitHub forms, canonicalizes
 *     to https, rejects non-GitHub hosts;
 *   - the configured token_env secret reaches git through env +
 *     a credential.helper — never in argv;
 *   - dest lands under the managed repos dir, existing non-empty dirs
 *     and config collisions 409, failed clones clean up;
 *   - success persists `repos.<name>.{path,url}` via mergeConfigFile.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Conductor,
  type ConductorDeps,
  StubTransitionHandler,
} from '@veto/conductor';
import { resolveConfig } from '@veto/config';
import { GitError } from '@veto/gitops';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiServer,
  type ServerOptions,
  createServer,
} from '../src/index.js';
import { parseGithubRepo } from '../src/repos.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const WS = 'ws';
const GH_TOKEN = 'ghp_test-secret-token';

let dir: string;
let store: PostgresStore;

function makeConfig(secrets: Record<string, string> = {}) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      security: { scan_on_commit: false },
    },
    warnings: [],
    secrets,
    files: [],
  });
}

function makeConductor() {
  const deps: ConductorDeps = {
    store,
    adapters: {},
    config: makeConfig(),
    workspaces: [{ name: WS, rootPath: dir }],
    runsDir: join(dir, 'runs'),
    transitions: new StubTransitionHandler(),
  };
  return new Conductor(deps);
}

type GitCall = { args: string[]; env: Record<string, string> };

function makeServer(
  opts: Partial<ServerOptions> = {},
  config = makeConfig(),
): { app: ApiServer; calls: GitCall[] } {
  const calls: GitCall[] = [];
  // Always a per-test config path — persist must never touch the real
  // ~/.config/veto/config.yaml from a test.
  const globalConfigPath = join(dir, 'cfg', 'config.yaml');
  const app = createServer({
    store,
    conductor: makeConductor(),
    config,
    uiToken: TOKEN,
    reposDir: join(dir, 'managed-repos'),
    globalConfigPath,
    gitClone: async (args, env) => {
      calls.push({ args, env });
    },
    ...opts,
  });
  return { app, calls };
}

const clone = (
  app: ApiServer,
  payload: unknown,
  headers: Record<string, string> = AUTH,
) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/repos/clone',
    headers,
    payload: payload as Record<string, unknown>,
  });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-api-repos-'));
  store = await PostgresStore.connect('pglite:');
  await store.getSchemaVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseGithubRepo', () => {
  it('parses the accepted GitHub URL forms', () => {
    for (const [url, repo] of [
      ['https://github.com/org/repo', 'repo'],
      ['https://github.com/org/repo.git', 'repo'],
      ['https://github.com/org/repo/tree/main', 'repo'],
      ['https://www.github.com/org/repo', 'repo'],
      ['http://github.com/org/repo.git', 'repo'],
      ['ssh://git@github.com/org/repo.git', 'repo'],
      ['git@github.com:org/repo.git', 'repo'],
      ['git@github.com:org/repo', 'repo'],
    ] as const) {
      expect(parseGithubRepo(url)).toEqual({ owner: 'org', repo });
    }
  });

  it('rejects non-GitHub hosts and malformed input', () => {
    for (const url of [
      'https://gitlab.com/org/repo',
      'https://github.com.evil.com/org/repo',
      'https://github.com/org',
      'https://github.com/',
      'not a url',
      '',
      'https://github.com:443@evil.com/org/repo',
    ]) {
      expect(parseGithubRepo(url)).toBeNull();
    }
  });
});

describe('POST /repos/clone', () => {
  it('requires auth', async () => {
    const { app } = makeServer();
    const res = await clone(app, { url: 'https://github.com/org/repo' }, {});
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('400s on non-GitHub and malformed URLs', async () => {
    const { app } = makeServer();
    for (const url of [
      'https://gitlab.com/org/repo',
      'https://github.com/org',
      'nope',
    ]) {
      const res = await clone(app, { url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_request');
    }
    await app.close();
  });

  it('400s on unsafe names', async () => {
    const { app } = makeServer();
    for (const name of ['../x', 'a/b', 'a\\b', '.hidden', '-lead', '']) {
      const res = await clone(app, {
        url: 'https://github.com/org/repo',
        ...(name ? { name } : {}),
      });
      if (name === '') continue; // absent → defaults to repo name
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it('clones into the managed dir and registers path+url in config', async () => {
    const config = makeConfig({ GITHUB_TOKEN: GH_TOKEN });
    const { app, calls } = makeServer({}, config);
    const cfgPath = join(dir, 'cfg', 'config.yaml');

    const res = await clone(app, {
      url: 'git@github.com:org/widget.git',
    });
    expect(res.statusCode).toBe(201);
    const repo = res.json().repo;
    expect(repo.name).toBe('widget');
    expect(repo.url).toBe('https://github.com/org/widget');
    expect(repo.path).toBe(join(dir, 'managed-repos', 'widget'));

    // git argv: canonical https URL + dest, token only via helper env.
    const cloneCall = calls[0];
    expect(cloneCall?.args.at(-2)).toBe('https://github.com/org/widget.git');
    expect(cloneCall?.args.at(-1)).toBe(repo.path);
    expect(cloneCall?.args.join(' ')).not.toContain(GH_TOKEN);
    expect(cloneCall?.args.join(' ')).toContain('credential.helper');
    expect(cloneCall?.env.GITHUB_TOKEN).toBe(GH_TOKEN);
    expect(cloneCall?.env.GIT_TERMINAL_PROMPT).toBe('0');

    // Repo-local credential.helper persisted (mechanism, not secret).
    const cfgCall = calls[1];
    expect(cfgCall?.args).toEqual([
      '-C',
      repo.path,
      'config',
      'credential.helper',
      expect.stringContaining('$GITHUB_TOKEN'),
    ]);
    expect(cfgCall?.args.join(' ')).not.toContain(GH_TOKEN);

    // config.yaml got repos.widget.{path,url}; in-memory too.
    const yaml = readFileSync(cfgPath, 'utf8');
    expect(yaml).toContain('widget');
    expect(yaml).toContain('https://github.com/org/widget');
    expect(config.repos.widget?.path).toBe(repo.path);
    expect(config.repos.widget?.url).toBe('https://github.com/org/widget');
    await app.close();
  });

  it('honors an explicit name override', async () => {
    const { app, calls } = makeServer();
    const res = await clone(app, {
      url: 'https://github.com/org/repo',
      name: 'my-name',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().repo.name).toBe('my-name');
    expect(res.json().repo.path).toBe(join(dir, 'managed-repos', 'my-name'));
    // No token configured → plain clone, no helper env.
    expect(calls[0]?.args.join(' ')).not.toContain('credential.helper');
    expect(calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
    await app.close();
  });

  it('409s when repos.<name> already exists', async () => {
    const config = makeConfig();
    config.repos = { widget: { path: '/elsewhere' } };
    const { app, calls } = makeServer({}, config);
    const res = await clone(app, { url: 'https://github.com/org/widget' });
    expect(res.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('409s when the destination exists and is not empty', async () => {
    const { app, calls } = makeServer();
    const dest = join(dir, 'managed-repos', 'repo');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'preexisting.txt'), 'x');
    const res = await clone(app, { url: 'https://github.com/org/repo' });
    expect(res.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('502s on clone failure and cleans the partial dest', async () => {
    const { app } = makeServer({
      gitClone: async () => {
        throw new GitError(
          ['clone'],
          {},
          {
            message: 'failed',
            stdout: '',
            stderr:
              "remote: Repository not found.\nfatal: repository 'x' not found",
            code: 128,
          },
        );
      },
    });
    const res = await clone(app, { url: 'https://github.com/org/repo' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('clone_failed');
    // 5xx detail stays server-side (API.md scrub) — git stderr never
    // reaches the client.
    expect(res.json().message).toBe('internal error');
    expect(JSON.stringify(res.json())).not.toContain('Repository not found');
    expect(existsSync(join(dir, 'managed-repos', 'repo'))).toBe(false);
    await app.close();
  });

  it('never places the token in argv or the persisted helper', async () => {
    const config = makeConfig({ GITHUB_TOKEN: GH_TOKEN });
    const { app, calls } = makeServer({}, config);
    const res = await clone(app, { url: 'https://github.com/org/repo' });
    expect(res.statusCode).toBe(201);
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain(GH_TOKEN);
    }
    await app.close();
  });
});
