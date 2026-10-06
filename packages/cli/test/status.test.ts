import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdStatus } from '../src/commands/status.js';

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
  root = mkdtempSync(join(tmpdir(), 'veto-cli-status-'));
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

async function seed(): Promise<void> {
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
    mkdirSync(join(root, 'ws', 'w1'), { recursive: true });
    const ts = new Date().toISOString();
    await store.upsertTicket({
      workspace: 'w1',
      ticket_id: 'W1-1',
      title: 'demo',
      status: 'prd-review',
      priority: 'medium',
      repos: [],
      depends_on: [],
      created_at: ts,
      updated_at: ts,
    });
    await store.upsertGateItem({
      workspace: 'w1',
      subject: 'W1-1',
      gate: 'prd-review',
      kind: 'review',
      surfaced_at: ts,
    });
    await store.createRun({
      id: 'w1/W1-1/001-implement',
      workspace: 'w1',
      subject: 'W1-1',
      ticket_id: 'W1-1',
      stage: 'implement',
      attempt: 1,
      status: 'running',
      backend: 'mock',
      container_id: 'abc123',
      started_at: ts,
    });
  } finally {
    await store.close();
  }
}

describe('cmdStatus', () => {
  it('prints a queue snapshot (text)', async () => {
    await seed();
    const code = await cmdStatus({ configPath, io });
    expect(code, errs.join('\n')).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('workspace w1');
    expect(out).toContain('prd-review');
    expect(out).toContain('review×1');
    expect(out).toContain('001-implement');
    expect(out).toContain('abc123');
  }, 30_000);

  it('--json emits parseable gate/run/container fields', async () => {
    await seed();
    const code = await cmdStatus({ configPath, json: true, io });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as {
      workspaces: {
        workspace: string;
        gate_items_by_kind: Record<string, number>;
        open_gate_items: { gate: string; subject: string; kind: string }[];
        live_runs: { id: string; status: string }[];
        containers: { container_id: string }[];
        tickets_by_status: Record<string, number>;
      }[];
    };
    const ws = parsed.workspaces.find((w) => w.workspace === 'w1');
    expect(ws).toBeDefined();
    expect(ws?.gate_items_by_kind.review).toBe(1);
    expect(ws?.open_gate_items[0]?.gate).toBe('prd-review');
    expect(ws?.live_runs[0]?.id).toBe('w1/W1-1/001-implement');
    expect(ws?.containers[0]?.container_id).toBe('abc123');
    expect(ws?.tickets_by_status['prd-review']).toBe(1);
  }, 30_000);

  it('reports no workspaces on an empty store', async () => {
    const code = await cmdStatus({ configPath, io });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('no workspaces');
  }, 30_000);
});
