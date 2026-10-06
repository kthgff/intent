/**
 * wp-142 tests — Scope Creep Radar (PRD §15.5).
 *
 * Real PostgresStore on PGlite; covers:
 *   - metrics: scope added/removed vs frozen manifest + baseline doc
 *     drift, post-approval change count, rework events, affected
 *     running executions, cost rollups — all explainable from rows;
 *   - budgets: `scope_budgets:` breach → `scope-budget` escalation
 *     gate + `escalated` event + owner-scoped notifications;
 *   - fail-closed: approving decisions and apply refuse while the
 *     escalation is open; clearing it is the higher approval.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeBudgets } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChangesetError,
  SCOPE_BUDGET_GATE,
  addChangesetItem,
  analyzeChangeset,
  applyChangeset,
  computeScopeRadar,
  createChangeset,
  decideChangeset,
  verifyChangeset,
} from '../src/changes/index.js';
import type { ChangesCtx } from '../src/changes/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let dir: string;
let store: PostgresStore;
let clock: number;
let budgets: ScopeBudgets | null;
let notified: { type: string; payload: unknown }[];

function ctx(): ChangesCtx {
  return {
    store,
    workspace: WS,
    actor: 'test-actor',
    now: () => new Date(clock),
    notify: (e) => notified.push({ type: e.type, payload: e.payload }),
    scope_budgets: budgets,
  };
}

const tick = (ms = 60_000) => {
  clock += ms;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-radar-'));
  store = await PostgresStore.connect('pglite:');
  clock = T0;
  budgets = null;
  notified = [];
  await store.upsertProject({ workspace: WS, name: 'Team A' });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedTicket(id: string, over: Record<string, unknown> = {}) {
  await store.upsertTicket({
    workspace: WS,
    ticket_id: id,
    title: id,
    status: 'approved',
    priority: 'medium',
    repos: [],
    depends_on: [],
    updated_at: new Date(clock).toISOString(),
    ...over,
  });
}

async function seedDoc(
  subject: string,
  doc: 'rs.md' | 'ticket.md',
  content: string,
) {
  return store.appendDocVersion(
    { workspace: WS, subject, doc },
    content,
    'test-seed',
  );
}

async function seedEvent(over: {
  ticket_id?: string | null;
  event: string;
  ts?: string;
  data?: Record<string, unknown>;
  cost_usd?: number | null;
}) {
  return store.appendEvent({
    workspace: WS,
    ticket_id: over.ticket_id ?? null,
    ts: over.ts ?? new Date(clock).toISOString(),
    stage: null,
    actor_type: 'human',
    actor_id: 'test-seed',
    event: over.event as never,
    run: null,
    refs: [],
    data: over.data ?? {},
    cost_usd: over.cost_usd ?? null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    human_minutes: null,
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// metrics computation
// ---------------------------------------------------------------------------

describe('computeScopeRadar — metrics are explainable rows', () => {
  it('reports zeros on an empty workspace', async () => {
    const r = await computeScopeRadar(store, WS, iso(clock));
    expect(r.subjects).toEqual([]);
    expect(r.releases).toEqual([]);
    expect(r.totals).toMatchObject({
      changesets: 0,
      open_changesets: 0,
      post_approval_changes: 0,
      rework_events: 0,
      scope_added: 0,
      scope_removed: 0,
    });
  });

  it('measures baseline drift, post-approval changes and classification volume', async () => {
    await seedTicket('SR-0001');
    await seedDoc('SR-0001', 'rs.md', 'v1 requirements');
    await seedEvent({
      ticket_id: 'SR-0001',
      event: 'doc_approved',
      ts: iso(clock),
      data: { doc: 'rs.md' },
    });
    tick();

    // Post-approval set pinned at v1.
    const cs1 = await createChangeset(ctx(), {
      request: 'add SSO',
      classification: 'addition',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    await addChangesetItem(ctx(), {
      changesetId: cs1.changeset_id,
      input: { subject: 'SR-0001', doc: 'rs.md', change: { content: 'v2' } },
    });
    // A pre-approval set doesn't exist here (approval predates both);
    // a second addition set adds to volume.
    tick();
    await createChangeset(ctx(), {
      request: 'clarify AC-2',
      classification: 'clarification',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    // Baseline moved: spec drifted one version past the pin.
    await seedDoc('SR-0001', 'rs.md', 'v2 requirements');

    const r = await computeScopeRadar(store, WS, iso(clock));
    const sub = r.subjects.find((s) => s.subject === 'SR-0001');
    expect(sub).toBeDefined();
    expect(sub?.changesets.total).toBe(2);
    expect(sub?.changesets.open).toBe(2);
    expect(sub?.changesets.post_approval).toBe(2);
    expect(sub?.changesets.by_classification).toEqual({
      addition: 1,
      clarification: 1,
    });
    expect(sub?.items).toMatchObject({ added: 1, removed: 0, total: 1 });
    expect(sub?.drift_total).toBe(1);
    expect(sub?.baseline_age_days).not.toBeNull();
  });

  it('counts rework (changes-requested loops, fix rounds) and cost', async () => {
    await seedTicket('SR-0001');
    await seedDoc('SR-0001', 'rs.md', 'v1');
    await seedEvent({
      ticket_id: 'SR-0001',
      event: 'status_changed',
      data: { from: 'review', to: 'changes-requested' },
    });
    await seedEvent({
      ticket_id: 'SR-0001',
      event: 'fix_round_started',
      data: { round: 1 },
    });
    await seedEvent({
      ticket_id: 'SR-0001',
      event: 'run_finished',
      cost_usd: 1.5,
    });
    await seedEvent({
      ticket_id: 'SR-0001',
      event: 'run_finished',
      cost_usd: 0.25,
    });
    await createChangeset(ctx(), {
      request: 'scope touch',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });

    const r = await computeScopeRadar(store, WS, iso(clock));
    const sub = r.subjects[0];
    expect(sub?.rework).toMatchObject({
      changes_requested: 1,
      fix_rounds: 1,
      total: 2,
    });
    expect(sub.cost_usd).toBeCloseTo(1.75);
    expect(r.totals.rework_events).toBe(2);
  });

  it('lists live executions in the blast radius', async () => {
    await seedTicket('SR-0001');
    await seedDoc('SR-0001', 'rs.md', 'v1');
    await store.createRun({
      id: `${WS}/SR-0001/001-implement`,
      workspace: WS,
      subject: 'SR-0001',
      ticket_id: 'SR-0001',
      stage: 'implement',
      attempt: 1,
      status: 'running',
    } as never);
    await createChangeset(ctx(), {
      request: 'mid-run scope change',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });

    const r = await computeScopeRadar(store, WS, iso(clock));
    expect(r.subjects[0]?.affected_executions).toEqual([
      `${WS}/SR-0001/001-implement`,
    ]);
    expect(r.totals.affected_executions).toBe(1);
  });

  it('diffs live release items against the frozen v1 manifest', async () => {
    await seedTicket('SR-0001');
    await seedTicket('SR-0002');
    await seedTicket('SR-0003');
    await store.upsertRelease({
      workspace: WS,
      release_id: 'REL-0001',
      title: 'v1',
      status: 'ready',
    });
    await store.upsertReleaseItem({
      workspace: WS,
      release_id: 'REL-0001',
      item_kind: 'ticket',
      item_id: 'SR-0001',
    });
    await store.upsertReleaseItem({
      workspace: WS,
      release_id: 'REL-0001',
      item_kind: 'ticket',
      item_id: 'SR-0002',
    });
    // Frozen baseline = manifest v1 with both items.
    await store.appendReleaseManifest({
      workspace: WS,
      release_id: 'REL-0001',
      version: 1,
      digest: 'd'.repeat(64),
      items: [
        { item_kind: 'ticket', item_id: 'SR-0001', repos: [] },
        { item_kind: 'ticket', item_id: 'SR-0002', repos: [] },
      ],
    });
    // Post-freeze scope churn: SR-0002 out, SR-0003 in, recut v2.
    await store.removeReleaseItem(
      {
        workspace: WS,
        release_id: 'REL-0001',
        item_kind: 'ticket',
        item_id: 'SR-0002',
      },
      iso(clock),
    );
    await store.upsertReleaseItem({
      workspace: WS,
      release_id: 'REL-0001',
      item_kind: 'ticket',
      item_id: 'SR-0003',
    });
    await store.appendReleaseManifest({
      workspace: WS,
      release_id: 'REL-0001',
      version: 2,
      digest: 'e'.repeat(64),
      items: [
        { item_kind: 'ticket', item_id: 'SR-0001', repos: [] },
        { item_kind: 'ticket', item_id: 'SR-0003', repos: [] },
      ],
    });

    const r = await computeScopeRadar(store, WS, iso(clock));
    const rel = r.releases.find((x) => x.release_id === 'REL-0001');
    expect(rel).toBeDefined();
    expect(rel?.baseline_items).toBe(2);
    expect(rel?.live_items).toBe(2);
    expect(rel?.scope_added).toEqual(['ticket:SR-0003']);
    expect(rel?.scope_removed).toEqual(['ticket:SR-0002']);
    expect(rel?.scope_change_pct).toBeCloseTo(1.0); // 2 churned / 2 baseline
    expect(rel?.manifest_versions).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// budgets → escalation (fail-closed, evented, owner-scoped)
// ---------------------------------------------------------------------------

describe('scope budgets — escalation', () => {
  async function seedOwnedScope() {
    await seedTicket('SR-0001', { feature: 'F-0001' });
    await store.upsertFeature({
      workspace: WS,
      feature: 'F-0001',
      title: 'feat',
      status: 'active',
      owner: 'alice',
    } as never);
    await seedDoc('SR-0001', 'rs.md', 'v1');
    await seedEvent({
      ticket_id: 'SR-0001',
      event: 'doc_approved',
      ts: iso(clock),
      data: { doc: 'rs.md' },
    });
    tick();
  }

  it('escalates a breached set: gate + escalated event + owner notification', async () => {
    await seedOwnedScope();
    budgets = { post_approval_changes: 0 };
    const cs = await createChangeset(ctx(), {
      request: 'add SSO',
      classification: 'addition',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    await analyzeChangeset(ctx(), { changesetId: cs.changeset_id });

    const gate = await store.getGateItem({
      workspace: WS,
      subject: cs.changeset_id,
      gate: SCOPE_BUDGET_GATE,
    });
    expect(gate).not.toBeNull();
    expect(gate?.kind).toBe('escalation');
    expect(gate?.cleared_at).toBeNull();

    const events = await store.listEvents({
      workspace: WS,
      event: 'escalated',
    });
    expect(events).toHaveLength(1);
    expect(
      (events[0]?.data as { breaches: { metric: string }[] }).breaches[0]
        ?.metric,
    ).toBe('post_approval_changes');

    // Owner-scoped: alice (feature owner) gets the breach notification.
    const notes = await store.listNotifications({ workspace: WS });
    const breach = notes.filter(
      (n) =>
        n.kind === 'changeset:scope-budget-breach' &&
        (JSON.parse(n.payload) as { owner?: string }).owner === 'alice',
    );
    expect(breach.length).toBeGreaterThan(0);
    expect(notified.some((n) => n.type === 'gate_surfaced')).toBe(true);
  });

  it('blocks approving decisions while the escalation is open; clearing is the higher approval', async () => {
    await seedOwnedScope();
    budgets = { post_approval_changes: 0 };
    const cs = await createChangeset(ctx(), {
      request: 'add SSO',
      classification: 'addition',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    await addChangesetItem(ctx(), {
      changesetId: cs.changeset_id,
      input: { subject: 'SR-0001', doc: 'rs.md', change: { content: 'v2' } },
    });
    await analyzeChangeset(ctx(), { changesetId: cs.changeset_id });

    await expect(
      decideChangeset(ctx(), {
        changesetId: cs.changeset_id,
        decision: 'add-now',
      }),
    ).rejects.toThrow(ChangesetError);

    // Scope-reducing options stay available even under escalation.
    const declined = await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'decline',
      rationale: 'not this release',
    });
    expect(declined.status).toBe('rejected');
  });

  it('lets the decision land once the scope-budget gate is cleared', async () => {
    await seedOwnedScope();
    budgets = { post_approval_changes: 0 };
    const cs = await createChangeset(ctx(), {
      request: 'add SSO',
      classification: 'addition',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    await addChangesetItem(ctx(), {
      changesetId: cs.changeset_id,
      input: { subject: 'SR-0001', doc: 'rs.md', change: { content: 'v2' } },
    });
    await analyzeChangeset(ctx(), { changesetId: cs.changeset_id });
    await store.clearGateItem(
      { workspace: WS, subject: cs.changeset_id, gate: SCOPE_BUDGET_GATE },
      iso(clock),
    );
    const next = await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'add-now',
    });
    expect(next.status).toBe('approved');
    const applied = await applyChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(['applying', 'apply-failed']).toContain(applied.status);
    const done = await verifyChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(done.status).toBe('verified');
  });

  it('blocks apply when budgets are crossed post-approval (emergency path)', async () => {
    await seedOwnedScope();
    // No budgets at analyze/decide — a budget can only be crossed later.
    const cs = await createChangeset(ctx(), {
      request: 'add SSO',
      classification: 'addition',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    await addChangesetItem(ctx(), {
      changesetId: cs.changeset_id,
      input: { subject: 'SR-0001', doc: 'rs.md', change: { content: 'v2' } },
    });
    await analyzeChangeset(ctx(), { changesetId: cs.changeset_id });
    await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'add-now',
    });
    // Budgets appear (config change) before apply — apply re-evaluates.
    budgets = { post_approval_changes: 0 };
    await expect(
      applyChangeset(ctx(), { changesetId: cs.changeset_id }),
    ).rejects.toThrow(/scope-budget/);
    const gate = await store.getGateItem({
      workspace: WS,
      subject: cs.changeset_id,
      gate: SCOPE_BUDGET_GATE,
    });
    expect(gate).not.toBeNull();
    expect(gate?.cleared_at).toBeNull();
  });

  it('unbreached sets get no escalation (observation only)', async () => {
    await seedOwnedScope();
    budgets = { post_approval_changes: 99 };
    const cs = await createChangeset(ctx(), {
      request: 'clarify AC-2',
      classification: 'clarification',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    await analyzeChangeset(ctx(), { changesetId: cs.changeset_id });
    expect(
      await store.getGateItem({
        workspace: WS,
        subject: cs.changeset_id,
        gate: SCOPE_BUDGET_GATE,
      }),
    ).toBeNull();
    expect(
      await store.listEvents({ workspace: WS, event: 'escalated' }),
    ).toEqual([]);
  });
});
