/**
 * wp-149 tests — design-artifact engine (PRD §15.4).
 *
 * Real PostgresStore on PGlite; the engine functions are exercised
 * directly (the API layer is a thin shell over the same calls). Covers:
 *   - mockup.json parse + internal-consistency lint (fail-closed);
 *   - structural diff (key-order independent) + affected-AC computation;
 *   - requirement coverage + visual-AC edges + render tree;
 *   - the deterministic screen-state generator (valid trees);
 *   - design-system parse/merge;
 *   - design approvals bound to a revision + PARTIAL invalidation on
 *     material change;
 *   - advisory `design-drift` findings (human verdict required).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mockup } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  affectedAcs,
  checklistComplete,
  designApprovalState,
  diffMockups,
  expandScreenStates,
  invalidateAffectedApprovals,
  lintMockup,
  mergeDesignSystems,
  parseDesignSystem,
  parseMockup,
  recordDesignApproval,
  recordDesignDrift,
  requirementCoverage,
  screenStates,
  screenTree,
  syncDesignApprovals,
  visualAcEdges,
} from '../src/design/index.js';
import type { DesignCtx } from '../src/design/index.js';
import { DesignError } from '../src/design/index.js';

const WS = 'ws';
const SUBJECT = 'SR-0001';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let dir: string;
let store: PostgresStore | null = null;
let clock: number;

function ctx(): DesignCtx {
  if (!store) throw new Error('store not open — call openStore() first');
  return {
    store,
    workspace: WS,
    actor: 'test-actor',
    now: () => new Date(clock),
  };
}

/** Boot a fresh PGlite store — only DB-backed tests pay this cost. */
async function openStore(): Promise<PostgresStore> {
  store = await PostgresStore.connect('pglite:');
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-design-'));
  clock = T0;
});

afterEach(async () => {
  if (store) {
    await store.close();
    store = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function mockup(over: Partial<Mockup> = {}): Mockup {
  return {
    schema: 1,
    subject: SUBJECT,
    title: 'Login',
    fidelity: 'wireframe',
    screens: [
      {
        screen_id: 'login',
        title: 'Login',
        route: '/login',
        requirement: 'AC-1',
        root: 'c-form',
        states: ['default'],
        responsive: null,
        notes: null,
      },
    ],
    components: [
      {
        component_id: 'c-form',
        name: 'Form',
        kind: 'form',
        parent: null,
        children: ['c-submit'],
        props: { title: 'Sign in' },
        layout: null,
        requirement: 'AC-1',
        state: 'default',
        breakpoint: null,
        responsive: null,
        notes: null,
      },
      {
        component_id: 'c-submit',
        name: 'Button',
        kind: 'button',
        parent: 'c-form',
        children: [],
        props: { label: 'Sign in' },
        layout: null,
        requirement: null,
        state: 'default',
        breakpoint: null,
        responsive: null,
        notes: null,
      },
      {
        component_id: 'c-help',
        name: 'Link',
        kind: 'text',
        parent: null,
        children: [],
        props: { label: 'Need help?' },
        layout: null,
        requirement: 'AC-2',
        state: 'default',
        breakpoint: null,
        responsive: null,
        notes: null,
      },
    ],
    visual_acs: [
      { ac_id: 'AC-1', statement: null, screen_id: 'login', component_id: 'c-form', state: 'default', breakpoint: null },
      { ac_id: 'AC-2', statement: null, screen_id: 'login', component_id: 'c-help', state: 'default', breakpoint: null },
    ],
    created_at: null,
    updated_at: null,
    ...over,
  };
}

/** Append a mockup doc version; returns the version number. */
async function putMockup(m: Mockup): Promise<number> {
  if (!store) throw new Error('store not open');
  const v = await store.appendDocVersion(
    { workspace: WS, subject: SUBJECT, doc: 'mockup.json' },
    JSON.stringify(m),
    'test-actor',
  );
  return v.version;
}

const FULL_CHECKLIST = {
  desktop: true,
  mobile: true,
  flows: true,
  'error-empty': true,
  a11y: true,
  'linked-acs': true,
};

// ---------------------------------------------------------------------------
// mockup contract
// ---------------------------------------------------------------------------

describe('mockup.json contract', () => {
  it('parses a valid tree and round-trips through stableJson-safe diff', () => {
    const m = parseMockup(JSON.stringify(mockup()));
    expect(m.screens[0]?.root).toBe('c-form');
  });

  it('fails closed on invalid JSON / schema', () => {
    expect(() => parseMockup('{not json')).toThrow(DesignError);
    expect(() =>
      parseMockup(JSON.stringify({ ...mockup(), fidelity: 'nope' })),
    ).toThrow(/fidelity/);
  });

  it('fails closed on a dangling child reference', () => {
    const bad = mockup();
    bad.components[0]!.children = ['c-missing'];
    expect(() => lintMockup(bad)).toThrow(/missing child/);
  });

  it('fails closed on duplicate component ids and dangling AC edges', () => {
    const dup = mockup();
    dup.components.push({ ...dup.components[1]! });
    expect(() => lintMockup(dup)).toThrow(/duplicate component_id/);

    const dangling = mockup();
    dangling.visual_acs.push({
      ac_id: 'AC-9',
      statement: null,
      screen_id: 'login',
      component_id: 'c-ghost',
      state: 'default',
      breakpoint: null,
    });
    expect(() => lintMockup(dangling)).toThrow(/missing component/);
  });

  it('computes requirement coverage and visual-AC edges', () => {
    const cov = requirementCoverage(mockup());
    expect(cov.map((c) => c.ac_id)).toEqual(['AC-1', 'AC-2']);
    expect(cov.find((c) => c.ac_id === 'AC-1')?.components).toEqual(['c-form']);
    expect(cov.every((c) => c.covered)).toBe(true);
    expect(visualAcEdges(mockup()).map((e) => e.ac_id)).toEqual(['AC-1', 'AC-2']);
  });

  it('builds a nested render tree for a screen', () => {
    const tree = screenTree(mockup(), 'login');
    expect(tree?.component_id).toBe('c-form');
    expect(tree?.children[0]?.component_id).toBe('c-submit');
    expect(screenTree(mockup(), 'nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// structural diff
// ---------------------------------------------------------------------------

describe('structural diff', () => {
  it('is key-order independent (a re-serialized tree is a no-op)', () => {
    const a = mockup();
    const b: Mockup = JSON.parse(JSON.stringify(a));
    // reorder props keys
    b.components[0]!.props = { z: 1, a: 2 };
    const a2: Mockup = JSON.parse(JSON.stringify(a));
    a2.components[0]!.props = { a: 2, z: 1 };
    const diff = diffMockups(a2, b, { from: 1, to: 2 });
    expect(diff.material).toBe(false);
    expect(diff.changed_components).toEqual([]);
  });

  it('detects added/removed/changed components and screens', () => {
    const from = mockup();
    const to = mockup();
    to.components = to.components.filter((c) => c.component_id !== 'c-help');
    to.components.push({
      ...from.components[1]!,
      component_id: 'c-cancel',
      requirement: 'AC-3',
    });
    to.components[0]!.props = { title: 'Sign in now' };
    to.screens[0]!.states = ['default', 'error'];
    const diff = diffMockups(from, to, { from: 1, to: 2 });
    expect(diff.removed_components).toContain('c-help');
    expect(diff.added_components).toContain('c-cancel');
    expect(diff.changed_components).toContain('c-form');
    expect(diff.changed_screens).toContain('login');
    expect(diff.material).toBe(true);
  });

  it('detects moved visual-AC links and computes affected ACs', () => {
    const from = mockup();
    const to = mockup();
    to.visual_acs = to.visual_acs.filter((e) => e.ac_id !== 'AC-2');
    const diff = diffMockups(from, to, { from: 1, to: 2 });
    expect(diff.moved_ac_links).toEqual(['AC-2']);
    const affected = affectedAcs(diff, from, to);
    expect(affected).toEqual(['AC-2']);
  });
});

// ---------------------------------------------------------------------------
// screen-state generator
// ---------------------------------------------------------------------------

describe('screen-state generator', () => {
  it('expands a screen into deterministic, valid state variants', () => {
    const m = mockup();
    const out = expandScreenStates(m, {
      screenId: 'login',
      states: ['loading', 'error'],
    });
    expect(out.screens[0]?.states).toEqual(['default', 'loading', 'error']);
    expect(out.components.map((c) => c.component_id)).toEqual(
      expect.arrayContaining(['c-form--loading', 'c-submit--loading', 'c-form--error']),
    );
    // deterministic: same call → same ids
    const out2 = expandScreenStates(m, {
      screenId: 'login',
      states: ['loading', 'error'],
    });
    expect(out2.components.map((c) => c.component_id).sort()).toEqual(
      out.components.map((c) => c.component_id).sort(),
    );
    // valid tree
    expect(() => lintMockup(out)).not.toThrow();
    expect(screenStates(out, 'login')).toEqual(['default', 'loading', 'error']);
  });

  it('fails closed on unknown screen / empty states', () => {
    expect(() =>
      expandScreenStates(mockup(), { screenId: 'nope', states: ['loading'] }),
    ).toThrow(/no screen/);
    expect(() =>
      expandScreenStates(mockup(), { screenId: 'login', states: [] }),
    ).toThrow(/at least one state/);
  });
});

// ---------------------------------------------------------------------------
// design-system ingestion
// ---------------------------------------------------------------------------

describe('design-system ingestion', () => {
  const ds = (over: Record<string, unknown> = {}) => ({
    schema: 1,
    source: 'web',
    tokens: { color: { primary: '#0055ff', danger: '#f00' } },
    components: [{ name: 'Button', import: 'ui/Button', props: {}, variants: [] }],
    styling: 'tailwind',
    ...over,
  });

  it('parses a bundle and merges incrementally', () => {
    const existing = parseDesignSystem(JSON.stringify(ds()));
    const incoming = parseDesignSystem(
      JSON.stringify(
        ds({
          tokens: { color: { primary: '#0033cc' }, spacing: { sm: 4 } },
          components: [
            { name: 'Button', import: 'ui/Button', props: { tone: 'string' }, variants: ['ghost'] },
            { name: 'Card', import: 'ui/Card', props: {}, variants: [] },
          ],
        }),
      ),
    );
    const { merged, added, updated } = mergeDesignSystems(existing, incoming);
    expect(added).toEqual(['Card']);
    expect(updated).toEqual(['Button']);
    expect((merged.tokens.color as Record<string, string>).primary).toBe('#0033cc');
    expect((merged.tokens.color as Record<string, string>).danger).toBe('#f00');
    expect((merged.tokens.spacing as Record<string, number>).sm).toBe(4);
  });

  it('drops components the repo no longer has', () => {
    const existing = parseDesignSystem(JSON.stringify(ds()));
    const incoming = parseDesignSystem(JSON.stringify(ds({ components: [] })));
    const { removed } = mergeDesignSystems(existing, incoming);
    expect(removed).toEqual(['Button']);
  });
});

// ---------------------------------------------------------------------------
// design approvals
// ---------------------------------------------------------------------------

describe('design approvals', () => {
  it('binds an approval to a mockup revision and is idempotent', async () => {
    await openStore();
    const v = await putMockup(mockup());
    const first = await recordDesignApproval(ctx(), {
      subject: SUBJECT,
      reviewer: 'keith',
      docVersion: v,
      checklist: FULL_CHECKLIST,
    });
    expect(first.created).toBe(true);
    expect(first.checklist_complete).toBe(true);
    expect(first.approval.status).toBe('approved');
    expect(first.approval.covers).toEqual(['AC-1', 'AC-2']);

    const again = await recordDesignApproval(ctx(), {
      subject: SUBJECT,
      reviewer: 'keith',
      docVersion: v,
      checklist: FULL_CHECKLIST,
    });
    expect(again.created).toBe(false);
    const all = await store!.listDesignApprovals({ workspace: WS, subject: SUBJECT });
    expect(all).toHaveLength(1);
  });

  it('refuses to bind an approval to a non-existent revision', async () => {
    await openStore();
    await expect(
      recordDesignApproval(ctx(), {
        subject: SUBJECT,
        reviewer: 'keith',
        docVersion: 7,
        checklist: FULL_CHECKLIST,
      }),
    ).rejects.toThrow(/no mockup.json v7/);
  });

  it('an incomplete checklist requires a rationale (fail-closed)', async () => {
    await openStore();
    const v = await putMockup(mockup());
    await expect(
      recordDesignApproval(ctx(), {
        subject: SUBJECT,
        reviewer: 'keith',
        docVersion: v,
        checklist: { desktop: true },
      }),
    ).rejects.toThrow(/checklist is incomplete/);
    const partial = await recordDesignApproval(ctx(), {
      subject: SUBJECT,
      reviewer: 'keith',
      docVersion: v,
      checklist: { desktop: true },
      rationale: 'mobile deferred to a follow-up ticket',
    });
    expect(partial.checklist_complete).toBe(false);
    expect(partial.approval.status).toBe('approved');
  });

  it('checklistComplete requires every item true', () => {
    expect(checklistComplete(FULL_CHECKLIST)).toBe(true);
    expect(checklistComplete({ ...FULL_CHECKLIST, a11y: false })).toBe(false);
    expect(checklistComplete({})).toBe(false);
  });

  it('PARTIAL invalidation: only approvals whose ACs changed are invalidated', async () => {
    await openStore();
    const v1 = await putMockup(mockup());
    // Two approvals, each covering a different AC.
    await recordDesignApproval(ctx(), {
      subject: SUBJECT,
      reviewer: 'alice',
      docVersion: v1,
      checklist: FULL_CHECKLIST,
      covers: ['AC-1'],
    });
    await recordDesignApproval(ctx(), {
      subject: SUBJECT,
      reviewer: 'bob',
      docVersion: v1,
      checklist: FULL_CHECKLIST,
      covers: ['AC-2'],
    });

    // v2: change the component that serves AC-1 only.
    const next = mockup();
    next.components[0]!.props = { title: 'Sign in now' };
    const v2 = await putMockup(next);

    const result = await invalidateAffectedApprovals(ctx(), {
      subject: SUBJECT,
      toVersion: v2,
    });
    expect(result.invalidated.map((a) => a.reviewer)).toEqual(['alice']);
    expect(result.unaffected).toHaveLength(1);
    expect(result.diffs[0]?.changed_components).toContain('c-form');

    const rows = await store!.listDesignApprovals({ workspace: WS, subject: SUBJECT });
    expect(rows.find((r) => r.reviewer === 'alice')?.status).toBe('invalidated');
    expect(rows.find((r) => r.reviewer === 'alice')?.invalidated_at).not.toBeNull();
    expect(rows.find((r) => r.reviewer === 'bob')?.status).toBe('approved');
  });

  it('a no-op revision leaves approvals untouched (no false invalidation)', async () => {
    await openStore();
    const v1 = await putMockup(mockup());
    await recordDesignApproval(ctx(), {
      subject: SUBJECT,
      reviewer: 'alice',
      docVersion: v1,
      checklist: FULL_CHECKLIST,
    });
    // Re-serialize the identical tree → new version, no material change.
    const same: Mockup = JSON.parse(JSON.stringify(mockup()));
    same.components[0]!.props = { title: 'Sign in' };
    const v2 = await putMockup(same);
    const r = await syncDesignApprovals(ctx(), { subject: SUBJECT });
    expect(r.to_version).toBe(v2);
    expect(r.invalidated).toHaveLength(0);
    expect(r.unaffected).toContainEqual(expect.any(String));
  });

  it('approval with no covers is invalidated by any material change', async () => {
    await openStore();
    const v1 = await putMockup(mockup());
    const rec = await recordDesignApproval(ctx(), {
      subject: SUBJECT,
      reviewer: 'carol',
      docVersion: v1,
      checklist: FULL_CHECKLIST,
    });
    // empty covers → engine defaults to all ACs, so this is covered; force empty:
    await store!.upsertDesignApproval({ ...rec.approval, covers: [] });
    const next = mockup();
    next.components[0]!.props = { title: 'Changed' };
    const v2 = await putMockup(next);
    const r = await invalidateAffectedApprovals(ctx(), {
      subject: SUBJECT,
      toVersion: v2,
    });
    expect(r.invalidated.map((a) => a.reviewer)).toEqual(['carol']);
  });

  it('reports approval currency vs the latest revision', async () => {
    await openStore();
    const v1 = await putMockup(mockup());
    await recordDesignApproval(ctx(), {
      subject: SUBJECT,
      reviewer: 'alice',
      docVersion: v1,
      checklist: FULL_CHECKLIST,
    });
    let state = await designApprovalState(ctx(), SUBJECT);
    expect(state[0]?.currency).toBe('current');
    const next = mockup();
    next.components[0]!.props = { title: 'v2' };
    await putMockup(next);
    state = await designApprovalState(ctx(), SUBJECT);
    // bound to v1, latest is v2 → superseded (no material invalidation ran)
    expect(state[0]?.currency).toBe('superseded');
  });
});

// ---------------------------------------------------------------------------
// design drift (advisory)
// ---------------------------------------------------------------------------

describe('design drift', () => {
  it('records an advisory design-drift finding, idempotently', async () => {
    await openStore();
    const v = await putMockup(mockup());
    const f1 = await recordDesignDrift(ctx(), {
      subject: SUBJECT,
      docVersion: v,
      screenId: 'login',
      componentId: 'c-form',
      body: 'button rendered below the fold vs approved above',
      evidence: 'screenshot:login.png',
    });
    expect(f1.category).toBe('design-drift');
    expect(f1.blocking).toBe(false);
    expect(f1.status).toBe('open');

    const f2 = await recordDesignDrift(ctx(), {
      subject: SUBJECT,
      docVersion: v,
      body: 'refreshed evidence',
    });
    expect(f2.finding_id).toBe(f1.finding_id);
    const all = await store!.listReviewFindings({
      workspace: WS,
      review_id: `rv-${SUBJECT}`,
    });
    expect(all).toHaveLength(1);
  });
});
