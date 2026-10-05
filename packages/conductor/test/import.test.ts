/**
 * wp-061 GitHub importer tests (wp-093 D29) — stub `gh` binaries (tmp
 * scripts) + a PGlite PostgresStore.
 *
 * `materialize` writes `tickets` truth rows + `ticket.md` doc_versions
 * + `ticket_repos` rows directly — there is no tickets repo, no git
 * commit, no filesystem output. Ids come from `store.allocTicketId`
 * (`SR-NNNN` via `projects.next_ticket_seq`); the tracker key survives
 * in the `source` column (`github:org/repo#N`) and re-imports of an
 * already-seen source surface `import` gate items instead of dirs.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TicketRow } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IMPORT_FAILURE_GATE,
  fetchIssues,
  materialize,
  parseTicketMd,
  preview,
  runImport,
} from '../src/index.js';
import type { RawIssue } from '../src/index.js';

const WORKSPACE = 'import-ws';
const REPO_MAP = { backend: 'api-repo', frontend: 'web-repo' };

let dir: string;
let store: PostgresStore;

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

async function getTicket(id: string): Promise<TicketRow | null> {
  return store.getTicket({ workspace: WORKSPACE, ticket_id: id });
}

async function getDoc(subject: string, doc: 'ticket.md') {
  return store.getDoc({ workspace: WORKSPACE, subject, doc });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-import-'));
  store = await PostgresStore.connect('pglite:');
});

afterEach(async () => {
  await store.close();
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
  it('writes tickets rows + ticket.md doc_versions + ticket_repos (D29)', async () => {
    const r = await materialize(ISSUES, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    // allocTicketId assigns SR-NNNN in issue order.
    expect(r.imported.map((t) => t.id)).toEqual(['SR-0001', 'SR-0002']);
    expect(r.imported.map((t) => t.source)).toEqual([
      'github:acme/app#42',
      'github:acme/app#43',
    ]);
    expect(r.imported[0]?.docVersion).toBe(1);
    expect(r.collisions).toEqual([]);

    // The tickets truth row.
    const row = await getTicket('SR-0001');
    expect(row?.status).toBe('imported');
    expect(row?.priority).toBe('high');
    expect(row?.repos).toEqual(['api-repo']);
    expect(row?.source).toBe('github:acme/app#42');
    expect(row?.spec_hash).toMatch(/^[0-9a-f]{64}$/);

    // The ticket.md doc_version — schema-1 frontmatter + issue body.
    const doc = await getDoc('SR-0001', 'ticket.md');
    expect(doc?.version).toBe(1);
    const parsed = parseTicketMd(doc?.content ?? '', 'SR-0001/ticket.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fm = parsed.value.frontmatter;
    expect(fm.schema).toBe(1);
    expect(fm.id).toBe('SR-0001');
    expect(fm.status).toBe('imported');
    expect(fm.priority).toBe('high');
    expect(fm.repos).toEqual(['api-repo']);
    expect(fm.source).toBe('github:acme/app#42');
    expect(parsed.value.body).toContain('## Description');
    expect(parsed.value.body).toContain('Users land on /home');
    // Task-list lines double as ## Acceptance criteria (verbatim).
    expect(parsed.value.body).toContain('- [ ] Redirect after login');

    const unmappedDoc = await getDoc('SR-0002', 'ticket.md');
    const unmapped = parseTicketMd(unmappedDoc?.content ?? '');
    expect(unmapped.ok).toBe(true);
    if (!unmapped.ok) return;
    expect(unmapped.value.frontmatter.repos).toEqual([]);
    expect(unmapped.value.body).toContain('repo-map-unmapped');

    // One ticket_repos row per mapped repo — branch/worktree/pr land
    // later when a stage claims them.
    const repos = await store.listTicketRepos({
      workspace: WORKSPACE,
      ticket_id: 'SR-0001',
    });
    expect(repos.map((t) => t.repo)).toEqual(['api-repo']);
    expect(repos[0]?.branch).toBeNull();
    expect(repos[0]?.pr_url).toBeNull();
    expect(
      await store.listTicketRepos({
        workspace: WORKSPACE,
        ticket_id: 'SR-0002',
      }),
    ).toEqual([]);
  });

  it('source collision → failure gate item + notification, original untouched', async () => {
    // Seed the already-imported source: a first import of issue #42.
    const first = await materialize([ISSUES[0] as RawIssue], {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    const existingId = first.imported[0]?.id as string;
    const before = await getTicket(existingId);
    const docBefore = await getDoc(existingId, 'ticket.md');

    const r = await materialize(ISSUES, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    expect(r.imported.map((t) => t.id)).toEqual(['SR-0002']);
    expect(r.collisions).toEqual([
      { source: 'github:acme/app#42', existing: existingId },
    ]);

    // The original row + doc are untouched (never renumbered/rewritten).
    expect(before).not.toBeNull();
    expect(await getTicket(existingId)).toEqual(before);
    expect((await getDoc(existingId, 'ticket.md'))?.version).toBe(
      docBefore?.version,
    );

    const gates = await store.listGateItems({ workspace: WORKSPACE });
    expect(gates).toHaveLength(1);
    expect(gates[0]?.subject).toBe(existingId);
    expect(gates[0]?.gate).toBe(IMPORT_FAILURE_GATE);
    expect(gates[0]?.kind).toBe('failure');
    const notes = await store.listNotifications({ workspace: WORKSPACE });
    // ≥1: the store auto-generates on gate insert; ours carries the payload.
    expect(notes.some((n) => n.payload?.includes('id-collision'))).toBe(true);
  });
});

describe('runImport', () => {
  it('fetch → materialize → IMPORTED: <n>', async () => {
    const r = await runImport({
      subject: 'import:github',
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
      fetch: {
        repo: 'acme/app',
        ghPath: stubGh(GH_ISSUES_JSON),
      },
    });
    expect(r.sentinelLine).toBe('IMPORTED: 2');
    expect(r.outcome.sentinel).toBe('IMPORTED');
    // The tickets landed as rows this time, not files.
    expect((await getTicket('SR-0001'))?.status).toBe('imported');
    expect((await getTicket('SR-0002'))?.status).toBe('imported');
  });

  it('fetch failure → IMPORT-FAILED + failure gate item', async () => {
    const r = await runImport({
      subject: 'import:github',
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
      fetch: { repo: 'acme/app', ghPath: join(dir, 'missing-gh') },
    });
    expect(r.sentinelLine).toMatch(/^IMPORT-FAILED: gh-missing/);
    const gates = await store.listGateItems({ workspace: WORKSPACE });
    expect(gates[0]?.subject).toBe('import:github');
    expect(gates[0]?.gate).toBe(IMPORT_FAILURE_GATE);
    expect(gates[0]?.kind).toBe('failure');
  });
});
