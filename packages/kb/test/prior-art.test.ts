import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexTicket, priorArt, recordTicketFiles } from '../src/index.js';
import type { Embedder } from '../src/index.js';

let dir: string;
let store: PostgresStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-kb-pa-'));
  store = await PostgresStore.connect('pglite:');
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ws = 'team-a';

describe('priorArt', () => {
  it('finds file-overlap with a past ticket plan', async () => {
    await recordTicketFiles(store, { workspace: ws, ticket_id: 'SR-0001' }, [
      'src/api/login.ts',
      'src/api/session.ts',
    ]);
    await recordTicketFiles(store, { workspace: ws, ticket_id: 'SR-0002' }, [
      'src/jobs/cron.ts',
    ]);
    await store.upsertTicket({
      workspace: ws,
      ticket_id: 'SR-0001',
      title: 'Login flow',
      status: 'done',
      priority: 'medium',
      repos: [],
      updated_at: '2026-10-01T00:00:00Z',
    });
    const block = await priorArt(
      {
        workspace: ws,
        ticket_id: 'SR-0003',
        title: 'Session timeout fix',
        files: ['src/api/session.ts', 'src/api/timeout.ts'],
      },
      store,
      { enabled: true },
    );
    expect(block).toContain('Prior art');
    expect(block).toContain('SR-0001');
    expect(block).toContain('file-overlap');
    expect(block).toContain('src/api/session.ts');
    expect(block).toContain('Login flow');
    expect(block).not.toContain('SR-0002');
  });

  it('excludes the ticket itself and returns "" when nothing matches', async () => {
    await recordTicketFiles(store, { workspace: ws, ticket_id: 'SR-0003' }, [
      'src/api/session.ts',
    ]);
    const block = await priorArt(
      {
        workspace: ws,
        ticket_id: 'SR-0003',
        title: 'x',
        files: ['src/api/session.ts'],
      },
      store,
      { enabled: true },
    );
    expect(block).toBe('');
  });

  it('prior_art_recall: false → empty block', async () => {
    await recordTicketFiles(store, { workspace: ws, ticket_id: 'SR-0001' }, [
      'src/api/session.ts',
    ]);
    const block = await priorArt(
      {
        workspace: ws,
        ticket_id: 'SR-0003',
        title: 'x',
        files: ['src/api/session.ts'],
      },
      store,
      { enabled: false },
    );
    expect(block).toBe('');
  });

  it('embedding similarity via a stub embedder', async () => {
    // Deterministic stub: vectors point "near" for related titles.
    const embedder: Embedder = {
      model: 'stub',
      dims: 3,
      embed: async (text) =>
        Float32Array.from(text.includes('login') ? [1, 0, 0] : [0.99, 0.01, 0]),
    };
    await indexTicket(store, embedder, {
      workspace: ws,
      ticket_id: 'SR-0009',
      title: 'login bug',
    });
    const block = await priorArt(
      { workspace: ws, ticket_id: 'SR-0010', title: 'login' },
      store,
      { enabled: true, embedder },
    );
    expect(block).toContain('SR-0009');
    expect(block).toContain('similar');
  });
});
