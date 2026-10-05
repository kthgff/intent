/**
 * wp-139 import reconciliation tests — provenance tri-state, clustering,
 * drift detection, reconciled-before-autonomy.
 *
 * Pure unit tests (clustering / provenance / source_ref) need no store;
 * the store-backed tests drive `reconcileImport` against a PGlite
 * PostgresStore through the real import pipeline (materialize → tickets
 * rows + ticket.md doc_versions).
 */
import type { TicketRow } from '@sprint-runner/core';
import {
  PROVENANCE_AUTO_APPROVABLE,
  provenanceAllowsAutoApproval,
} from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_IMPORT_BOARD,
  IMPORT_RECONCILE_GATE,
  clusterItems,
  convertImportBoard,
  cosine,
  defaultSimilarity,
  detectDrift,
  issueKind,
  materialize,
  reconcileImport,
  resolveReconciliationFinding,
  sourceRefFor,
  ticketCardId,
} from '../src/index.js';
import type { RawIssue } from '../src/index.js';

const WORKSPACE = 'recon-ws';
const REPO_MAP = { backend: 'api-repo' };

function issue(overrides: Partial<RawIssue> & { number: number }): RawIssue {
  return {
    title: `Issue ${overrides.number}`,
    body: 'Some description body.',
    labels: ['backend'],
    url: `https://github.com/acme/app/issues/${overrides.number}`,
    milestone: null,
    state: 'OPEN',
    repo: 'acme/app',
    ...overrides,
  };
}

describe('source_ref — original tracker identity (wp-139)', () => {
  it('classifies GitHub issues vs pull requests by URL', () => {
    expect(issueKind(issue({ number: 1 }))).toBe('issue');
    expect(
      issueKind(
        issue({ number: 2, url: 'https://github.com/acme/app/pull/2' }),
      ),
    ).toBe('pull-request');
    // An explicit kind always wins over the URL heuristic.
    expect(
      issueKind(issue({ number: 3, url: 'https://x/pull/3', kind: 'issue' })),
    ).toBe('issue');
  });

  it('builds {system, kind, url, imported_at, original_status}', () => {
    const ref = sourceRefFor(issue({ number: 7, state: 'CLOSED' }), 'T0');
    expect(ref).toEqual({
      system: 'github',
      kind: 'issue',
      url: 'https://github.com/acme/app/issues/7',
      imported_at: 'T0',
      original_status: 'CLOSED',
    });
  });
});

describe('provenance tri-state', () => {
  it('only source-backed / stakeholder-verified may auto-approve', () => {
    expect(provenanceAllowsAutoApproval('inferred')).toBe(false);
    expect(provenanceAllowsAutoApproval(null)).toBe(false);
    expect(provenanceAllowsAutoApproval('source-backed')).toBe(true);
    expect(provenanceAllowsAutoApproval('stakeholder-verified')).toBe(true);
    expect(PROVENANCE_AUTO_APPROVABLE).toEqual([
      'source-backed',
      'stakeholder-verified',
    ]);
  });
});

describe('clusterItems — metadata + relations + embeddings', () => {
  it('groups near-identical titles as duplicates', () => {
    const clusters = clusterItems([
      { id: 'SR-0001', title: 'Fix login redirect bug' },
      { id: 'SR-0002', title: 'Fix the login redirect bug' },
      { id: 'SR-0003', title: 'Add dark mode theme' },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual(['SR-0001', 'SR-0002']);
    expect(clusters[0]?.duplicate).toBe(true);
    expect(clusters[0]?.reason).toBe('metadata');
  });

  it('groups explicit relations without any similarity', () => {
    const clusters = clusterItems([
      { id: 'A', title: 'alpha', relations: ['B'] },
      { id: 'B', title: 'beta' },
      { id: 'C', title: 'gamma' },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual(['A', 'B']);
    expect(clusters[0]?.reason).toBe('relation');
  });

  it('groups by embedding cosine when vectors are present', () => {
    const clusters = clusterItems([
      { id: 'A', title: 'totally unrelated', embedding: [1, 0, 0] },
      { id: 'B', title: 'nothing alike', embedding: [0.99, 0.01, 0] },
      { id: 'C', title: 'other', embedding: [0, 1, 0] },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual(['A', 'B']);
    expect(clusters[0]?.reason).toBe('embedding');
  });

  it('cosine + defaultSimilarity are sane', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(
      defaultSimilarity(
        { id: 'a', title: 'login redirect bug' },
        { id: 'b', title: 'login redirect bug' },
      ),
    ).toBeCloseTo(1);
    expect(
      defaultSimilarity(
        { id: 'a', title: 'login redirect bug' },
        { id: 'b', title: 'dark mode theme' },
      ),
    ).toBeLessThan(0.2);
  });
});

describe('detectDrift', () => {
  it('flags title + description + status drift, and is empty when clean', () => {
    const ticket = {
      title: 'Fix login redirect',
      source_ref: { system: 'github', original_status: 'OPEN' },
    } as unknown as TicketRow;
    const doc =
      '---\n---\n\n## Description\n\nUsers land on /home.\n\n## Acceptance criteria\n';
    expect(
      detectDrift(
        ticket,
        doc,
        issue({
          number: 1,
          title: 'Fix login redirect',
          body: 'Users land on /home.',
        }),
      ),
    ).toEqual([]);

    const drift = detectDrift(
      ticket,
      doc,
      issue({
        number: 1,
        title: 'Fix login redirect v2',
        body: 'Different body.',
        state: 'CLOSED',
      }),
    );
    expect(drift.map((d) => d.field).sort()).toEqual([
      'description',
      'status',
      'title',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Store-backed tests
// ---------------------------------------------------------------------------

describe('reconcileImport (PGlite)', () => {
  let store: PostgresStore;

  async function getTicket(id: string): Promise<TicketRow | null> {
    return store.getTicket({ workspace: WORKSPACE, ticket_id: id });
  }

  beforeEach(async () => {
    store = await PostgresStore.connect('pglite:');
  });

  afterEach(async () => {
    await store.close();
  });

  it('materialize persists source_ref on the ticket row', async () => {
    const r = await materialize([issue({ number: 42 })], {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    expect(r.imported[0]?.sourceRef.system).toBe('github');
    const row = await getTicket('SR-0001');
    expect(row?.source_ref).toMatchObject({
      system: 'github',
      kind: 'issue',
      original_status: 'OPEN',
    });
  });

  it('creates the import board and auto-reconciles a clean import', async () => {
    const issues = [issue({ number: 42, title: 'Fix login redirect' })];
    await materialize(issues, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });

    const r = await reconcileImport({ workspace: WORKSPACE, store, issues });
    expect(r.boardCreated).toBe(true);
    expect(r.board).toBe(DEFAULT_IMPORT_BOARD);
    expect(r.reconciled).toEqual(['SR-0001']);
    expect(r.blocked).toEqual([]);
    expect(r.findings).toEqual([]);

    const board = await store.getBoard(WORKSPACE, DEFAULT_IMPORT_BOARD);
    expect(board?.board_type).toBe('import');

    // The ticket card carries source-backed provenance (it came from a
    // source of record).
    const card = await store.getBoardItem(ticketCardId('SR-0001'));
    expect(card?.kind).toBe('ticket');
    expect(card?.provenance).toBe('source-backed');

    // No findings → no open reconcile gate (the reconciled flag).
    const gate = await store.getGateItem({
      workspace: WORKSPACE,
      subject: 'SR-0001',
      gate: IMPORT_RECONCILE_GATE,
    });
    expect(gate).toBeNull();
  });

  it('surfaces a clarification finding + blocks on the reconcile gate', async () => {
    // No label → repo-map-unmapped → repos [] → clarification needed.
    const issues = [issue({ number: 43, title: 'Dark mode', labels: [] })];
    await materialize(issues, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });

    const r = await reconcileImport({ workspace: WORKSPACE, store, issues });
    expect(r.blocked).toEqual(['SR-0001']);
    expect(r.reconciled).toEqual([]);
    const finding = r.findings.find((f) => f.kind === 'clarification');
    expect(finding).toBeDefined();
    expect(finding?.provenance).toBe('inferred');

    const gate = await store.getGateItem({
      workspace: WORKSPACE,
      subject: 'SR-0001',
      gate: IMPORT_RECONCILE_GATE,
    });
    expect(gate?.kind).toBe('review');
    expect(gate?.blocked_agent).toBe(true);
    expect(gate?.cleared_at ?? null).toBeNull();
  });

  it('detects drift vs the source of record without overwriting the import', async () => {
    const original = issue({ number: 44, title: 'Original title' });
    await materialize([original], {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    const before = await getTicket('SR-0001');

    // The tracker moved on — the imported artifact is now stale.
    const drifted = issue({ number: 44, title: 'Renamed in the tracker' });
    const r = await reconcileImport({
      workspace: WORKSPACE,
      store,
      issues: [drifted],
    });
    const finding = r.findings.find((f) => f.kind === 'drift');
    expect(finding?.detail).toContain('title');
    expect(finding?.provenance).toBe('inferred');
    // Never silently overwritten.
    expect(await getTicket('SR-0001')).toEqual(before);

    // A drift event was recorded (provenance trail).
    const events = await store.listEvents({
      workspace: WORKSPACE,
      ticket_id: 'SR-0001',
      event: 'import_drift_detected',
    });
    expect(events).toHaveLength(1);
  });

  it('surfaces duplicate clusters as reviewable items', async () => {
    const issues = [
      issue({ number: 50, title: 'Fix login redirect bug' }),
      issue({ number: 51, title: 'Fix the login redirect bug' }),
    ];
    await materialize(issues, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });

    const r = await reconcileImport({ workspace: WORKSPACE, store, issues });
    const dup = r.findings.find((f) => f.kind === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup?.provenance).toBe('inferred');
    expect(dup?.related.length).toBeGreaterThan(0);

    // The duplicate finding is a board note on the import board.
    const card = await store.getBoardItem(dup?.id as string);
    expect(card?.kind).toBe('note');
    expect(card?.topic).toBe('duplicate');
    expect(card?.note_status).toBe('open');
  });

  it('flags completed work when the source closed but the ticket is live', async () => {
    const issues = [issue({ number: 52, title: 'Ship it', state: 'CLOSED' })];
    await materialize(issues, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });

    const r = await reconcileImport({ workspace: WORKSPACE, store, issues });
    const done = r.findings.find((f) => f.kind === 'completed');
    expect(done).toBeDefined();
    expect(r.blocked).toEqual(['SR-0001']);
  });

  it('is idempotent — re-running upserts the same findings', async () => {
    const issues = [issue({ number: 53, title: 'Dark mode', labels: [] })];
    await materialize(issues, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    const first = await reconcileImport({
      workspace: WORKSPACE,
      store,
      issues,
    });
    const second = await reconcileImport({
      workspace: WORKSPACE,
      store,
      issues,
    });
    expect(second.findings.map((f) => f.id)).toEqual(
      first.findings.map((f) => f.id),
    );
    const items = await store.listBoardItems({
      workspace: WORKSPACE,
      board: DEFAULT_IMPORT_BOARD,
    });
    // ticket card + one clarification note — no duplicates.
    expect(items).toHaveLength(2);
  });

  it('rejects an automatic resolution of an inferred finding', async () => {
    const issues = [issue({ number: 60, title: 'Dark mode', labels: [] })];
    await materialize(issues, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    const r = await reconcileImport({ workspace: WORKSPACE, store, issues });
    const findingId = r.findings[0]?.id as string;
    await expect(
      resolveReconciliationFinding({
        workspace: WORKSPACE,
        store,
        findingId,
        decision: 'dismissed',
        human: false,
      }),
    ).rejects.toThrow(/inferred findings cannot be auto-resolved/);
  });

  it('a human resolution re-proves the item and clears the gate', async () => {
    const issues = [issue({ number: 61, title: 'Dark mode', labels: [] })];
    await materialize(issues, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    const r = await reconcileImport({ workspace: WORKSPACE, store, issues });
    const findingId = r.findings[0]?.id as string;

    const out = await resolveReconciliationFinding({
      workspace: WORKSPACE,
      store,
      findingId,
      decision: 'imported-kept',
      actor: 'keith',
      human: true,
    });
    expect(out.finding.provenance).toBe('stakeholder-verified');
    expect(out.gateCleared).toBe(true);

    const card = await store.getBoardItem(findingId);
    expect(card?.note_status).toBe('resolved');
    expect(card?.provenance).toBe('stakeholder-verified');

    const gate = await store.getGateItem({
      workspace: WORKSPACE,
      subject: 'SR-0001',
      gate: IMPORT_RECONCILE_GATE,
    });
    expect(gate?.cleared_at).not.toBeNull();
  });

  it('converts to an enhancement board with import history preserved', async () => {
    const issues = [issue({ number: 70, title: 'Fix login redirect' })];
    await materialize(issues, {
      workspace: WORKSPACE,
      store,
      repoMap: REPO_MAP,
    });
    await reconcileImport({ workspace: WORKSPACE, store, issues });

    const before = await store.listBoardItems({
      workspace: WORKSPACE,
      board: DEFAULT_IMPORT_BOARD,
    });

    const out = await convertImportBoard({ workspace: WORKSPACE, store });
    expect(out.board_type).toBe('enhancement');
    const board = await store.getBoard(WORKSPACE, DEFAULT_IMPORT_BOARD);
    expect(board?.board_type).toBe('enhancement');
    expect(board?.status).toBe('approved');

    // History preserved.
    const after = await store.listBoardItems({
      workspace: WORKSPACE,
      board: DEFAULT_IMPORT_BOARD,
    });
    expect(after.map((i) => i.id)).toEqual(before.map((i) => i.id));
  });
});
