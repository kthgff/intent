import { execFileSync } from 'node:child_process';
/**
 * wp-013 ticket projection tests — scan fixtures/tickets-repo copied into
 * a tmp git repo, project into an in-memory SqliteStore.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PARSE_FAILURE_GATE,
  parseTicketFile,
  projectTickets,
} from '../src/index.js';

const WORKSPACE = 'fixture-ws';
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/tickets-repo',
);

let dir: string;
let repo: string;
let store: SqliteStore;

function seedTicketsRepo(): string {
  const dest = join(dir, 'tickets-repo');
  cpSync(FIXTURE, dest, { recursive: true });
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
    ],
    { cwd: dest },
  );
  return dest;
}

function writeTicket(id: string, contents: string): string {
  const p = join(repo, 'tickets', id, 'ticket.md');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-projection-'));
  store = new SqliteStore('sqlite:///:memory:');
  repo = seedTicketsRepo();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseTicketFile', () => {
  it('parses fixture frontmatter with documented §1 defaults', async () => {
    const r = await parseTicketFile(
      join(repo, 'tickets', 'SR-0001', 'ticket.md'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.frontmatter.id).toBe('SR-0001');
    expect(r.value.frontmatter.depth).toBe('standard');
    expect(r.value.frontmatter.depends_on).toEqual([]);
    expect(r.value.body).toContain('## Description');
  });

  it('returns a structured error on malformed yaml, never throws', async () => {
    const p = writeTicket('SR-9999', '---\n: : not yaml\n---\nbody\n');
    const r = await parseTicketFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.path).toBe(p);
    expect(r.error.error.length).toBeGreaterThan(0);
  });

  it('errors when the frontmatter block is missing', async () => {
    const p = writeTicket('SR-9998', '# no frontmatter\n');
    const r = await parseTicketFile(p);
    expect(r.ok).toBe(false);
  });
});

describe('projectTickets', () => {
  it('projects all 3 fixture tickets with ticket_repos rows', async () => {
    const s = await projectTickets(repo, store, WORKSPACE);
    expect(s.projected.sort()).toEqual(['SR-0001', 'SR-0002', 'SR-0003']);
    expect(s.failed).toEqual([]);
    expect(s.removed).toEqual([]);

    const t = await store.getTicket({
      workspace: WORKSPACE,
      ticket_id: 'SR-0003',
    });
    expect(t).not.toBeNull();
    expect(t?.title).toBe('Add /healthz endpoint');
    expect(t?.status).toBe('ready');
    expect(t?.depth).toBe('light');
    expect(t?.spec_hash).toMatch(/^[0-9a-f]{64}$/);

    for (const id of ['SR-0001', 'SR-0002', 'SR-0003']) {
      const repos = await store.listTicketRepos({
        workspace: WORKSPACE,
        ticket_id: id,
      });
      expect(repos.map((r) => r.repo)).toEqual(['code-repo']);
      expect(repos[0]?.pr_url).toBeNull();
    }
  });

  it('malformed ticket → failure gate item; the rest still project', async () => {
    writeTicket('SR-9999', '---\nschema: 1\nid: SR-9999\nstatus: bogus\n---\n');
    const s = await projectTickets(repo, store, WORKSPACE);
    expect(s.projected.sort()).toEqual(['SR-0001', 'SR-0002', 'SR-0003']);
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]?.subject).toBe('SR-9999');
    expect(s.failed[0]?.error).toContain('schema:');

    const item = await store.getGateItem({
      workspace: WORKSPACE,
      subject: 'SR-9999',
      gate: PARSE_FAILURE_GATE,
    });
    expect(item).not.toBeNull();
    expect(item?.kind).toBe('failure');
    expect(item?.blocked_agent).toBe(true);
    expect(
      await store.getTicket({ workspace: WORKSPACE, ticket_id: 'SR-9999' }),
    ).toBeNull();
  });

  it('re-run is idempotent and preserves pr/ci run state', async () => {
    await projectTickets(repo, store, WORKSPACE);
    // Simulate a later stage writing pr/ci state onto the row.
    await store.upsertTicketRepo({
      workspace: WORKSPACE,
      ticket_id: 'SR-0003',
      repo: 'code-repo',
      branch: 'sr/sr-0003',
      worktree: '/tmp/wt',
      pr_url: 'https://github.com/x/y/pull/1',
      pr_state: 'open',
      ci_state: 'green',
      merged_sha: null,
    });

    const s = await projectTickets(repo, store, WORKSPACE);
    expect(s.projected).toHaveLength(3);

    const row = await store.getTicketRepo({
      workspace: WORKSPACE,
      ticket_id: 'SR-0003',
      repo: 'code-repo',
    });
    expect(row?.pr_url).toBe('https://github.com/x/y/pull/1');
    expect(row?.pr_state).toBe('open');
    expect(row?.ci_state).toBe('green');
    expect(row?.branch).toBe('sr/sr-0003');
    expect(row?.worktree).toBe('/tmp/wt');

    // tickets row still refreshed, still one row per repo.
    expect(
      await store.listTicketRepos({
        workspace: WORKSPACE,
        ticket_id: 'SR-0003',
      }),
    ).toHaveLength(1);
  });

  it('deletes projection rows when a ticket dir vanishes', async () => {
    await projectTickets(repo, store, WORKSPACE);
    rmSync(join(repo, 'tickets', 'SR-0002'), {
      recursive: true,
      force: true,
    });
    const s = await projectTickets(repo, store, WORKSPACE);
    expect(s.removed).toEqual(['SR-0002']);
    expect(
      await store.getTicket({ workspace: WORKSPACE, ticket_id: 'SR-0002' }),
    ).toBeNull();
    expect(
      await store.listTicketRepos({
        workspace: WORKSPACE,
        ticket_id: 'SR-0002',
      }),
    ).toEqual([]);
  });

  it('syncs ticket_repos to repos[] (shrinking repos drops stale rows)', async () => {
    writeTicket(
      'SR-0007',
      [
        '---',
        'schema: 1',
        'id: SR-0007',
        'title: multi',
        'status: imported',
        'priority: low',
        'repos: [a, b]',
        '---',
        'x',
      ].join('\n'),
    );
    await projectTickets(repo, store, WORKSPACE);
    expect(
      (
        await store.listTicketRepos({
          workspace: WORKSPACE,
          ticket_id: 'SR-0007',
        })
      ).map((r) => r.repo),
    ).toEqual(['a', 'b']);

    writeTicket(
      'SR-0007',
      [
        '---',
        'schema: 1',
        'id: SR-0007',
        'title: multi',
        'status: imported',
        'priority: low',
        'repos: [b]',
        '---',
        'x',
      ].join('\n'),
    );
    await projectTickets(repo, store, WORKSPACE);
    expect(
      (
        await store.listTicketRepos({
          workspace: WORKSPACE,
          ticket_id: 'SR-0007',
        })
      ).map((r) => r.repo),
    ).toEqual(['b']);
  });
});
