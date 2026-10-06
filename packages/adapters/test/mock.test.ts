/**
 * MockAdapter tests (wp-021) — real detached spawns for every scenario.
 * Each test is fast (<2s) except the hang/kill test (~3s max).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectContext, PrepareContext } from '@veto/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAdapter, parseArtifactDir } from '../src/mock/index.js';

let root: string;
let worktree: string;
let runDir: string;

const RUN_ID = 'run-mock-0001';

function makeCtx(): { prepare: PrepareContext; collect: CollectContext } {
  return {
    prepare: {
      workspace: worktree,
      run_dir: runDir,
      run_id: RUN_ID,
      backend: 'devin',
      tokens: {
        TICKET_MD: '# ticket',
        REPO_CARDS: '',
        RS_MD: '',
        TDD_MD: '',
        VS_MD: '',
        BRANCH: 'SR-0001',
        DEPTH: 'light',
      },
    },
    collect: { workspace: worktree, run_dir: runDir, run_id: RUN_ID },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'veto-mock-test-'));
  worktree = join(root, 'worktree');
  runDir = join(root, 'runs', RUN_ID);
  mkdirSync(worktree, { recursive: true });
  mkdirSync(runDir, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('MockAdapter', () => {
  it('has default capabilities and mock name', () => {
    const a = new MockAdapter();
    expect(a.name).toBe('mock');
    expect(a.capabilities.can_exec).toBe(true);
    expect(a.capabilities.can_write_outside_tree).toBe(true);
    expect(a.capabilities.has_gh).toBe(false);
  });

  it('prepare() renders the stage template via @veto/prompts', () => {
    const a = new MockAdapter();
    const { prepare } = makeCtx();
    const rendered = a.prepare('SR-0001', 'implement', prepare);
    expect(rendered.tokens.TICKET_ID).toBe('SR-0001');
    expect(rendered.template).toBe('implement');
    expect(rendered.text).not.toContain('{{');
    expect(parseArtifactDir(rendered.text, worktree)).toBe(runDir);
  });

  it('done: parses DONE sentinel, collects artifacts, real pid + log', async () => {
    const a = new MockAdapter({ scenario: 'done' });
    const { collect } = makeCtx();
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const handle = a.run(worktree, rendered, 0, { artifactDir: runDir });
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.log_path).toContain('.log');

    const result = await a.collect(handle, collect);
    expect(result.sentinel).toBe('DONE');
    expect(result.sentinel_raw).toBe('DONE');
    expect(result.exit_code).toBe(0);
    expect(result.artifacts.map((p) => p.split('/').pop())).toContain(
      'result.json',
    );
    expect(
      JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')).status,
    ).toBe('done');
    expect(result.usage?.source).toBe('estimated');
  });

  it('blocked / needs-info sentinels parse with payload', async () => {
    const a = new MockAdapter();
    const { collect } = makeCtx();
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const b = await a.collect(
      a.run(worktree, rendered, 0, {
        scenario: 'blocked:missing creds',
        artifactDir: runDir,
      }),
      collect,
    );
    expect(b.sentinel).toBe('BLOCKED');
    expect(b.sentinel_raw).toBe('BLOCKED: missing creds');
    const n = await a.collect(
      a.run(worktree, rendered, 0, {
        scenario: 'needs-info:3',
        artifactDir: runDir,
      }),
      collect,
    );
    expect(n.sentinel).toBe('NEEDS-INFO');
    expect(n.sentinel_raw).toBe('NEEDS-INFO: 3');
  });

  it('garbage-sentinel and no-sentinel → sentinel null (run_failed mapping)', async () => {
    const a = new MockAdapter({ heartbeatMs: 0 });
    const { collect } = makeCtx();
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const g = await a.collect(
      a.run(worktree, rendered, 0, {
        scenario: 'garbage-sentinel',
        artifactDir: runDir,
      }),
      collect,
    );
    expect(g.sentinel).toBeNull();
    expect(g.sentinel_raw).toContain('not a sentinel');

    const n = await a.collect(
      a.run(worktree, rendered, 0, {
        scenario: 'no-sentinel',
        artifactDir: runDir,
      }),
      collect,
    );
    expect(n.sentinel).toBeNull();
    // last line is a MOCK/heartbeat noise line — not a known sentinel
    expect(n.sentinel_raw).not.toBeNull();
  });

  it('kill ends a hung child (SIGTERM → dead pid)', async () => {
    const a = new MockAdapter({ killGraceMs: 300 });
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const handle = a.run(worktree, rendered, 0, {
      scenario: 'hang',
      artifactDir: runDir,
    });
    expect(pidAlive(handle.pid)).toBe(true);
    await a.control(handle, 'kill');
    await sleep(100);
    expect(pidAlive(handle.pid)).toBe(false);
    const { collect } = makeCtx();
    const result = await a.collect(handle, collect);
    expect(result.sentinel).toBeNull();
    expect(result.exit_code).toBe(143);
  }, 5000);

  it('SIGKILL escalation when SIGTERM is ignored', async () => {
    const a = new MockAdapter({ killGraceMs: 200 });
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const handle = a.run(worktree, rendered, 0, {
      scenario: 'hang',
      artifactDir: runDir,
      ignoreTerm: true,
    });
    expect(pidAlive(handle.pid)).toBe(true);
    await a.control(handle, 'kill');
    expect(pidAlive(handle.pid)).toBe(false);
  }, 5000);

  it('pause (SIGSTOP) and resume (SIGCONT)', async () => {
    const a = new MockAdapter();
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const handle = a.run(worktree, rendered, 0, {
      scenario: 'hang',
      artifactDir: runDir,
    });
    await a.control(handle, 'pause');
    // SIGSTOPped process is still "alive" — check /proc-ish via signal 0
    expect(pidAlive(handle.pid)).toBe(true);
    await a.control(handle, 'resume');
    expect(pidAlive(handle.pid)).toBe(true);
    await a.control(handle, 'kill');
    await sleep(100);
    expect(pidAlive(handle.pid)).toBe(false);
  }, 5000);

  it('usage: on_usage fires partials and collect aggregates usage', async () => {
    const a = new MockAdapter({ usagePollMs: 20 });
    const { collect } = makeCtx();
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const handle = a.run(worktree, rendered, 0, {
      scenario: 'usage',
      artifactDir: runDir,
      delayMs: 120,
      heartbeatMs: 0,
    });
    const partials: number[] = [];
    a.on_usage(handle, (u) => partials.push(u.tokens_in));
    const result = await a.collect(handle, collect);
    await sleep(50); // let the tailer drain
    expect(result.sentinel).toBe('DONE');
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(result.usage?.source).toBe('reported');
    expect(result.usage?.granularity).toBe('per-call');
    expect(result.usage?.totals.tokens_in).toBe(250);
    expect(result.usage?.totals.tokens_out).toBe(50);
    expect(result.usage?.calls.length).toBe(2);
  });

  it('artifacts:<json> writes a custom artifact map', async () => {
    const a = new MockAdapter();
    const { collect } = makeCtx();
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const map = { 'findings-1.json': '{"a":1}', 'notes/LOG.md': '# log' };
    const handle = a.run(worktree, rendered, 0, {
      scenario: `artifacts:${JSON.stringify(map)}`,
      artifactDir: runDir,
    });
    const result = await a.collect(handle, collect);
    expect(result.sentinel).toBe('DONE');
    expect(existsSync(join(runDir, 'findings-1.json'))).toBe(true);
    expect(existsSync(join(runDir, 'notes', 'LOG.md'))).toBe(true);
  });

  it('fail-lint writes a malformed artifact but still exits DONE', async () => {
    const a = new MockAdapter();
    const { collect } = makeCtx();
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const handle = a.run(worktree, rendered, 0, {
      scenario: 'fail-lint',
      artifactDir: runDir,
    });
    const result = await a.collect(handle, collect);
    expect(result.sentinel).toBe('DONE');
    expect(() =>
      JSON.parse(readFileSync(join(runDir, 'review.json'), 'utf8')),
    ).toThrow();
  });

  it('scratch dir (can_write_outside_tree:false) is collected into run_dir and purged', async () => {
    const a = new MockAdapter({
      capabilities: { can_write_outside_tree: false },
    });
    const scratch = join(worktree, '.veto', RUN_ID);
    const rendered = {
      template: 'mock',
      text: `.veto/${RUN_ID}/ (worktree-relative scratch dir — write all\nrun artifacts under it.)`,
      tokens: {},
    };
    const { collect } = makeCtx();
    const handle = a.run(worktree, rendered, 0, { scenario: 'done' });
    const result = await a.collect(handle, collect);
    expect(result.sentinel).toBe('DONE');
    expect(existsSync(join(runDir, 'result.json'))).toBe(true);
    expect(existsSync(scratch)).toBe(false); // purged
  });

  it('self-timeout exits 124 with no sentinel', async () => {
    const a = new MockAdapter();
    const rendered = { template: 'mock', text: 'x', tokens: {} };
    const { collect } = makeCtx();
    const handle = a.run(worktree, rendered, 0.2, {
      scenario: 'done',
      artifactDir: runDir,
      delayMs: 2000,
      heartbeatMs: 0,
    });
    const result = await a.collect(handle, collect);
    expect(result.exit_code).toBe(124);
    expect(result.sentinel).toBeNull();
  }, 5000);
});

describe('parseSentinel', () => {
  it('accepts known sentinels with/without payload', () => {
    expect(MockAdapter.parseSentinel('DONE')).toBe('DONE');
    expect(MockAdapter.parseSentinel('BLOCKED: reason here')).toBe('BLOCKED');
    expect(MockAdapter.parseSentinel('NEEDS-INFO: 3')).toBe('NEEDS-INFO');
  });
  it('rejects unknown/malformed lines', () => {
    expect(MockAdapter.parseSentinel('?? garbage')).toBeNull();
    expect(MockAdapter.parseSentinel('USAGE {"tokens_in":1}')).toBeNull();
    expect(MockAdapter.parseSentinel('NOT-A-SENTINEL: x')).toBeNull();
    expect(MockAdapter.parseSentinel('HEARTBEAT 2026-01-01')).toBeNull();
  });
});
