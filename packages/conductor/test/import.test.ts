import { execFileSync } from 'node:child_process';
/**
 * wp-061 GitHub importer tests — stub `gh` binaries (tmp scripts), a tmp
 * git tickets repo, and an in-memory SqliteStore.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchIssues,
  materialize,
  parseTicketFile,
  preview,
  runImport,
} from '../src/index.js';
import type { RawIssue } from '../src/index.js';

const WORKSPACE = 'import-ws';
const REPO_MAP = { backend: 'api-repo', frontend: 'web-repo' };

let dir: string;
let repo: string;
let store: SqliteStore;

function initTicketsRepo(): string {
  const dest = join(dir, 'tickets-repo');
  mkdirSync(join(dest, 'tickets'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dest });
  execFileSync('git', ['add', '-A'], { cwd: dest });
  execFileSync(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      'commit',
      '-qm',
      'seed',
      '--allow-empty',
    ],
    { cwd: dest },
  );
  return dest;
}

/** Stub `gh` that prints `stdoutJson` (or fails when exitCode != 0). */
function stubGh(stdoutJson: string, exitCode = 0): string {
  const path = join(dir, `gh-stub-${exitCode === 0 ? 'ok' : 'fail'}`);
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "${exitCode}" -ne 0 ]; then\n  echo "gh: boom" >&2\n  exit ${exitCode}\nfi\ncat <<'EOF'\n${stdoutJson}\nEOF\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const GH_ISSUES_JSON = JSON.stringify([
  {
    number: 42,
    title: 'Fix login redirect',
    body: 'Users land on /home instead of /dashboard.\n\n- [ ] Redirect after login\n- [ ] Preserve query params',
    labels: [{ name: 'backend' }, { name: 'priority:high' }],
    url: 'https://github.com/acme/app/issues/42',
    milestone: { title: 'v1.0' },
    state: 'OPEN',
  },
  {
    number: 43,
    title: 'Dark mode',
    body: '',
    labels: [{ name: 'design' }],
    url: 'https://github.com/acme/app/issues/43',
    milestone: null,
    state: 'OPEN',
  },
]);

const ISSUES: RawIssue[] = [
  {
    number: 42,
    title: 'Fix login redirect',
    body: 'Users land on /home instead of /dashboard.\n\n- [ ] Redirect after login\n- [ ] Preserve query params',
    labels: ['backend', 'priority:high'],
    url: 'https://github.com/acme/app/issues/42',
    milestone: 'v1.0',
    state: 'OPEN',
    repo: 'acme/app',
  },
  {
    number: 43,
    title: 'Dark mode',
    body: '',
    labels: ['design'],
    url: 'https://github.com/acme/app/issues/43',
    milestone: null,
    state: 'OPEN',
    repo: 'acme/app',
  },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-import-'));
  store = new SqliteStore('sqlite:///:memory:');
  repo = initTicketsRepo();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('fetchIssues', () => {
  it('normalizes gh issue list --json output', async () => {
    const r = await fetchIssues({
      repo: 'acme/app',
      ghPath: stubGh(GH_ISSUES_JSON),
      env: { GITHUB_TOKEN: 'x' },
      tokenEnv: 'GITHUB_TOKEN',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]?.labels).toEqual(['backend', 'priority:high']);
    expect(r.issues[0]?.repo).toBe('acme/app');
    expect(r.issues[0]?.milestone).toBe('v1.0');
  });

  it('token_env unset → token-missing structured error', async () => {
    const r = await fetchIssues({
      repo: 'acme/app',
      ghPath: stubGh(GH_ISSUES_JSON),
      tokenEnv: 'SR_TEST_TOKEN_DEFINITELY_UNSET',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe('token-missing');
  });

  it('gh absent → gh-missing structured error', async () => {
    const r = await fetchIssues({
      repo: 'acme/app',
      ghPath: join(dir, 'no-such-gh'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe('gh-missing');
  });

  it('gh auth failure → auth-failed structured error', async () => {
    const r = await fetchIssues({
      repo: 'acme/app',
      ghPath: stubGh('', 4),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['auth-failed', 'fetch-failed']).toContain(r.error.reason);
  });
});

describe('preview', () => {
  it('maps labels → repos and priority, flags unmapped', () => {
    const rows = preview(ISSUES, REPO_MAP);
    expect(rows[0]?.priority).toBe('high');
    expect(rows[0]?.repos).toEqual(['api-repo']);
    expect(rows[0]?.id).toBe('GH-42');
    expect(rows[0]?.source).toBe('github:acme/app#42');
    expect(rows[1]?.priority).toBe('medium');
    expect(rows[1]?.repos).toEqual([]);
    expect(rows[1]?.flags).toContain('repo-map-unmapped');
    expect(rows[1]?.flags).toContain('empty-body');
  });
});

describe('materialize', () => {
  it('writes schema-1 ticket.md and commits', async () => {
    const r = await materialize(ISSUES, {
      ticketsRepoPath: repo,
      repoMap: REPO_MAP,
      workspace: WORKSPACE,
      store,
    });
    expect(r.imported.map((t) => t.id)).toEqual(['GH-42', 'GH-43']);
    expect(r.collisions).toEqual([]);
    expect(r.commit).toBeTruthy();

    const parsed = await parseTicketFile(
      join(repo, 'tickets', 'GH-42', 'ticket.md'),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fm = parsed.value.frontmatter;
    expect(fm.schema).toBe(1);
    expect(fm.status).toBe('imported');
    expect(fm.priority).toBe('high');
    expect(fm.repos).toEqual(['api-repo']);
    expect(fm.source).toBe('github:acme/app#42');
    expect(parsed.value.body).toContain('## Description');
    expect(parsed.value.body).toContain('Users land on /home');
    expect(parsed.value.body).toContain('- [ ] Redirect after login');

    const unmapped = await parseTicketFile(
      join(repo, 'tickets', 'GH-43', 'ticket.md'),
    );
    expect(unmapped.ok).toBe(true);
    if (!unmapped.ok) return;
    expect(unmapped.value.frontmatter.repos).toEqual([]);
    expect(unmapped.value.body).toContain('repo-map-unmapped');

    // committed, not just written
    const log = execFileSync('git', ['log', '--oneline'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(log).toContain('import:');
  });

  it('id collision → failure gate item + notification, original untouched', async () => {
    mkdirSync(join(repo, 'tickets', 'GH-42'), { recursive: true });
    writeFileSync(
      join(repo, 'tickets', 'GH-42', 'ticket.md'),
      'ORIGINAL — do not touch\n',
    );

    const r = await materialize(ISSUES, {
      ticketsRepoPath: repo,
      repoMap: REPO_MAP,
      workspace: WORKSPACE,
      store,
      commit: false,
    });
    expect(r.imported.map((t) => t.id)).toEqual(['GH-43']);
    expect(r.collisions.map((c) => c.id)).toEqual(['GH-42']);
    expect(
      readFileSync(join(repo, 'tickets', 'GH-42', 'ticket.md'), 'utf8'),
    ).toBe('ORIGINAL — do not touch\n');

    const gates = await store.listGateItems({ workspace: WORKSPACE });
    expect(gates).toHaveLength(1);
    expect(gates[0]?.subject).toBe('GH-42');
    expect(gates[0]?.kind).toBe('failure');
    const notes = await store.listNotifications({ workspace: WORKSPACE });
    // ≥1: store auto-generates on gate insert; ours carries the payload.
    expect(notes.some((n) => n.payload?.includes('id-collision'))).toBe(true);
  });
});

describe('runImport', () => {
  it('fetch → materialize → IMPORTED: <n>', async () => {
    const r = await runImport({
      subject: 'import:github',
      workspace: WORKSPACE,
      store,
      ticketsRepoPath: repo,
      repoMap: REPO_MAP,
      fetch: {
        repo: 'acme/app',
        ghPath: stubGh(GH_ISSUES_JSON),
      },
    });
    expect(r.sentinelLine).toBe('IMPORTED: 2');
    expect(r.outcome.sentinel).toBe('IMPORTED');
  });

  it('fetch failure → IMPORT-FAILED + failure gate item', async () => {
    const r = await runImport({
      subject: 'import:github',
      workspace: WORKSPACE,
      store,
      ticketsRepoPath: repo,
      repoMap: REPO_MAP,
      fetch: { repo: 'acme/app', ghPath: join(dir, 'missing-gh') },
    });
    expect(r.sentinelLine).toMatch(/^IMPORT-FAILED: gh-missing/);
    const gates = await store.listGateItems({ workspace: WORKSPACE });
    expect(gates[0]?.subject).toBe('import:github');
    expect(gates[0]?.kind).toBe('failure');
  });
});
