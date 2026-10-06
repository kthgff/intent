import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdTick, formatTickReport } from '../src/commands/tick.js';

let root: string;
let configPath: string;
let dbUrl: string;
let lines: string[];
let errs: string[];

const io = {
  out: (s: string) => lines.push(s),
  err: (s: string) => errs.push(s),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veto-cli-tick-'));
  configPath = join(root, 'config.yaml');
  dbUrl = `pglite://${join(root, 'db')}`;
  writeFileSync(
    configPath,
    `schema: 1\nactor: tester\nbackend: mock\nstorage_url: ${dbUrl}\n`,
    'utf8',
  );
  lines = [];
  errs = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('cmdTick', () => {
  it('runs one reconcile/claim pass and prints a summary', async () => {
    // Seed one workspace so the tick has a pass to report.
    const store = await PostgresStore.connect(dbUrl);
    try {
      await store.upsertProject({
        workspace: 'w1',
        name: 'w1',
        next_ticket_seq: 1,
        next_feature_seq: 1,
        next_initiative_seq: 1,
        settings: { path: join(root, 'ws', 'w1') },
        created_at: new Date().toISOString(),
      });
    } finally {
      await store.close();
    }

    const code = await cmdTick({ configPath, io });
    expect(code, errs.join('\n')).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('w1:');
    expect(out).toContain('reconcile collected=0');
    expect(out).toContain('claim launched=0');
  }, 30_000);

  it('empty install → "no workspaces" summary, exit 0', async () => {
    const code = await cmdTick({ configPath, io });
    expect(code, errs.join('\n')).toBe(0);
    expect(lines.join('\n')).toContain('no workspaces');
  }, 30_000);

  it('fails closed on missing config (exit != 0)', async () => {
    const code = await cmdTick({
      configPath: join(root, 'absent.yaml'),
      io,
    });
    // no actor anywhere → ConfigError propagates out of cmdTick's boot
    expect(code).not.toBe(0);
  });
});

describe('formatTickReport', () => {
  it('renders per-workspace counts + warnings', () => {
    const text = formatTickReport({
      reconcile: [
        { stalled: [], killed: [], collected: ['r1'], warnings: ['w!'] },
      ],
      claim: [{ launched: [], skipped: [{ ticket: 'T-1', reason: 'cap' }] }],
      shepherd: [{ workspace: 'w1', polled: [], actions: [], warnings: [] }],
    });
    expect(text).toContain('w1:');
    expect(text).toContain('collected=1');
    expect(text).toContain('w!');
    expect(text).toContain('skipped T-1: cap');
  });
});
