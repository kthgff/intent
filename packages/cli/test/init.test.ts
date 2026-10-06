import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cmdInit,
  probeRepo,
  registerRepoInConfig,
} from '../src/commands/init.js';
import type { DepCheck, ProbeRun } from '../src/deps.js';

let root: string;
let configPath: string;
let lines: string[];
let errs: string[];

const io = {
  out: (s: string) => lines.push(s),
  err: (s: string) => errs.push(s),
};

const allOkRun: ProbeRun = (bin) => ({ ok: true, stdout: `${bin} 1.0` });
const okProbe = () =>
  [
    { name: 'git', ok: true, required: true, why: 'w' },
    { name: 'gitleaks', ok: true, required: true, why: 'w' },
    { name: 'gh', ok: true, required: true, why: 'w' },
    { name: 'docker', ok: true, required: false, why: 'w' },
    { name: 'devin', ok: true, required: true, why: 'w' },
  ] satisfies DepCheck[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veto-cli-init-'));
  configPath = join(root, 'cfg', 'config.yaml');
  lines = [];
  errs = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('cmdInit scaffold', () => {
  it('writes config.yaml, .env (0600), ui-token (0600)', async () => {
    const code = await cmdInit({
      configPath,
      noProject: true,
      io,
      probe: okProbe,
    });
    expect(code, errs.join('\n')).toBe(0);

    const cfg = join(root, 'cfg');
    expect(existsSync(join(cfg, 'config.yaml'))).toBe(true);
    expect(existsSync(join(cfg, '.env'))).toBe(true);
    expect(existsSync(join(cfg, 'ui-token'))).toBe(true);
    const token = readFileSync(join(cfg, 'ui-token'), 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // 0600 — secrets never group/world-readable
    expect(statSync(join(cfg, '.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(cfg, 'ui-token')).mode & 0o777).toBe(0o600);
    // config.yaml carries a scaffolded actor so resolveConfig passes
    expect(readFileSync(configPath, 'utf8')).toMatch(/^actor: /m);
  });

  it('is idempotent — existing files are kept, never clobbered', async () => {
    await cmdInit({ configPath, noProject: true, io, probe: okProbe });
    const before = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, `${before}\n# edited\n`, 'utf8');
    const code = await cmdInit({
      configPath,
      noProject: true,
      io,
      probe: okProbe,
    });
    expect(code).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(`${before}\n# edited\n`);
  });

  it('fails closed on a malformed pre-existing config.yaml', async () => {
    mkdirSync(join(root, 'cfg'), { recursive: true });
    writeFileSync(configPath, 'bogus_key: 1\n', 'utf8');
    const code = await cmdInit({
      configPath,
      noProject: true,
      io,
      probe: okProbe,
    });
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('bogus_key');
  });

  it('exits 1 with remediation when a required dep is missing', async () => {
    const code = await cmdInit({
      configPath,
      noProject: true,
      io,
      probe: () =>
        [
          { name: 'git', ok: true, required: true, why: 'w' },
          {
            name: 'gitleaks',
            ok: false,
            required: true,
            why: 'sanitizer',
            remediation: 'brew install gitleaks',
          },
        ] satisfies DepCheck[],
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('MISSING: gitleaks');
  });
});

describe('cmdInit project registration', () => {
  it('registers a project row + config repo entry for a git repo', async () => {
    const repo = join(root, 'myrepo');
    mkdirSync(repo, { recursive: true });
    const init = spawnSync('git', ['init', '-q', repo]);
    expect(init.status).toBe(0);
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'biome check' } }),
    );

    // pglite storage — embedded, no postgres needed in tests
    mkdirSync(join(root, 'cfg'), { recursive: true });
    writeFileSync(
      configPath,
      `schema: 1\nactor: tester\nbackend: mock\nstorage_url: pglite://${join(root, 'db')}\n`,
      'utf8',
    );

    const code = await cmdInit({ configPath, path: repo, io, probe: okProbe });
    expect(code, errs.join('\n')).toBe(0);

    // project row with settings.path
    const store = await PostgresStore.connect(`pglite://${join(root, 'db')}`);
    try {
      const proj = await store.getProject('myrepo');
      expect(proj).not.toBeNull();
      expect(proj?.settings.path).toMatch(/workspaces\/myrepo$/);
    } finally {
      await store.close();
    }

    // repos.<name>.path in config.yaml
    const cfgText = readFileSync(configPath, 'utf8');
    expect(cfgText).toContain('myrepo');
    expect(cfgText).toContain(repo);
    const report = lines.join('\n');
    expect(report).toContain('project: myrepo');
    expect(report).toContain('registered');
  }, 30_000);

  it('skips registration outside a git repo (no --project)', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    const code = await cmdInit({
      configPath,
      path: plain,
      io,
      probe: okProbe,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('not a git repo');
  });
});

describe('registerRepoInConfig', () => {
  it('adds, keeps, and flags conflicting repo paths', async () => {
    const cfg = join(root, 'c.yaml');
    writeFileSync(cfg, 'schema: 1\nactor: t\n', 'utf8');
    expect(await registerRepoInConfig(cfg, 'r1', '/a')).toBe('added');
    expect(await registerRepoInConfig(cfg, 'r1', '/a')).toBe('kept');
    expect(await registerRepoInConfig(cfg, 'r1', '/b')).toBe('conflict');
    const text = readFileSync(cfg, 'utf8');
    expect(text).toContain('/a');
    expect(text).not.toContain('/b');
  });
});

describe('probeRepo', () => {
  it('detects test/lint/build scripts from package.json', async () => {
    const repo = join(root, 'p');
    mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q', repo]);
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', build: 'tsc -b' } }),
    );
    writeFileSync(join(repo, 'Makefile'), 'lint:\n\techo lint\n');
    const probe = await probeRepo(repo);
    expect(probe.git).toBe(true);
    expect(probe.detected.test).toBe('npm test');
    expect(probe.detected.build).toBe('npm run build');
    expect(probe.detected.lint).toBe('make lint');
  });

  it('handles non-git dirs without throwing', async () => {
    const plain = join(root, 'x');
    mkdirSync(plain, { recursive: true });
    const probe = await probeRepo(plain);
    expect(probe.git).toBe(false);
    expect(probe.detected).toEqual({});
  });
});
