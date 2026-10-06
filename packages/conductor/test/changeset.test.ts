/**
 * wp-140 tests — ChangeSet lifecycle engine (PRD §15.5).
 *
 * Real PostgresStore on PGlite; engine functions exercised directly
 * (the API layer is a thin shell over the same calls). Covers:
 *   - create: CS-NNNN allocation, verbatim request, baseline pinning;
 *   - review-comment routing (out-of-scope only, exactly once);
 *   - analysis: affected artifacts + conflicts;
 *   - decisions: state legality, stated consequences, decision →
 *     status mapping, release consequences (swap-scope / next-release);
 *   - emergency route: expedited decision + mandatory retro;
 *   - apply: doc-version proposals apply, partial application visible;
 *   - verification + expiry sweep + abandon/reopen.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChangesetError,
  abandonChangeset,
  addChangesetItem,
  analyzeChangeset,
  applyChangeset,
  attachRetro,
  createChangeset,
  decideChangeset,
  reopenChangeset,
  sweepChangesetExpiry,
  verifyChangeset,
} from '../src/changes/index.js';
import type { ChangesCtx } from '../src/changes/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let dir: string;
let store: PostgresStore;
let clock: number;

function ctx(): ChangesCtx {
  return {
    store,
    workspace: WS,
    actor: 'test-actor',
    now: () => new Date(clock),
  };
}

const tick = (ms = 60_000) => {
  clock += ms;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-changeset-'));
  store = await PostgresStore.connect('pglite:');
  clock = T0;
  await store.upsertProject({ workspace: WS, name: 'Team A' });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

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

async function seedRelease(releaseId: string, itemId: string) {
  await store.upsertRelease({
    workspace: WS,
    release_id: releaseId,
    title: releaseId,
    status: 'draft',
  });
  await store.upsertReleaseItem({
    workspace: WS,
    release_id: releaseId,
    item_kind: 'ticket',
    item_id: itemId,
  });
}

/** Create + analyze a set that is ready for a decision. */
async function awaiting(
  over: Parameters<typeof createChangeset>[1] = { request: 'Also support SSO' },
) {
  const cs = await createChangeset(ctx(), over);
  await addChangesetItem(ctx(), {
    changesetId: cs.changeset_id,
    input: {
      subject: 'SR-0001',
      doc: 'rs.md',
      change: { content: 'v2 requirements + SSO' },
    },
  });
  await analyzeChangeset(ctx(), { changesetId: cs.changeset_id });
  return cs;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('createChangeset', () => {
  it('allocates CS-NNNN ids transactionally and keeps the request verbatim', async () => {
    const a = await createChangeset(ctx(), {
      request: 'Also support SSO for enterprise customers',
      title: 'SSO',
      createdBy: 'keith',
    });
    expect(a.changeset_id).toMatch(/^CS-\d{4}$/);
    expect(a.status).toBe('draft');
    expect(a.request).toBe('Also support SSO for enterprise customers');

    tick();
    const b = await createChangeset(ctx(), {
      request: 'Add audit log export',
    });
    expect(Number(b.changeset_id.slice(3))).toBe(
      Number(a.changeset_id.slice(3)) + 1,
    );
  });

  it('rejects an empty request — the verbatim text is the artifact', async () => {
    await expect(createChangeset(ctx(), { request: '   ' })).rejects.toThrow(
      /verbatim/,
    );
  });

  it('pins the baseline to a concrete doc version at create time', async () => {
    await seedDoc('SR-0001', 'rs.md', 'v1 requirements');
    await seedDoc('SR-0001', 'rs.md', 'v2 requirements');
    const cs = await createChangeset(ctx(), {
      request: 'clarify AC-2',
      classification: 'clarification',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    expect(cs.baseline).toEqual({
      subject: 'SR-0001',
      doc: 'rs.md',
      version: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// review-comment routing (§15.8 handoff)
// ---------------------------------------------------------------------------

describe('review-comment routing', () => {
  const comment = (over: Record<string, unknown> = {}) => ({
    workspace: WS,
    comment_id: 'cm-1',
    review_id: 'rv-1',
    revision: 1,
    subject: 'SR-0001',
    file: null,
    line: null,
    type: 'out-of-scope' as const,
    disposition: 'suggestion' as const,
    ai_classification: null,
    body: 'This is really a separate ticket',
    author: 'keith',
    changeset_id: null,
    created_at: new Date(T0).toISOString(),
    ...over,
  });

  it('routes an out-of-scope comment exactly once', async () => {
    await store.upsertReviewComment(comment());
    const cs = await createChangeset(ctx(), {
      request: 'This is really a separate ticket',
      review_comment_id: 'cm-1',
    });
    const linked = (
      await store.listReviewComments({ workspace: WS, review_id: 'rv-1' })
    )[0];
    expect(linked?.changeset_id).toBe(cs.changeset_id);

    await expect(
      createChangeset(ctx(), { request: 'again', review_comment_id: 'cm-1' }),
    ).rejects.toThrow(/already routed/);
  });

  it('refuses non-out-of-scope comments — a comment is an instruction, not authorization', async () => {
    await store.upsertReviewComment(comment({ type: 'defect' }));
    await expect(
      createChangeset(ctx(), { request: 'x', review_comment_id: 'cm-1' }),
    ).rejects.toThrow(/only 'out-of-scope' routes/);
  });

  it('unknown comment → not found', async () => {
    await expect(
      createChangeset(ctx(), { request: 'x', review_comment_id: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

describe('analyzeChangeset', () => {
  it('records affected artifacts and reaches awaiting-decision', async () => {
    await seedDoc('SR-0001', 'rs.md', 'v1 requirements');
    const cs = await createChangeset(ctx(), {
      request: 'Also support SSO',
      classification: 'addition',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    await addChangesetItem(ctx(), {
      changesetId: cs.changeset_id,
      input: {
        subject: 'SR-0001',
        doc: 'rs.md',
        change: { content: 'v2 requirements with SSO' },
      },
    });
    tick();
    const analyzed = await analyzeChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(analyzed.status).toBe('awaiting-decision');
    const items = await store.listChangesetItems({
      workspace: WS,
      changeset_id: cs.changeset_id,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.base_version).toBe(1);
    expect(items[0]?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

describe('decideChangeset', () => {
  it('maps decisions to statuses (add-now → approved)', async () => {
    const cs = await awaiting();
    tick();
    const decided = await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'add-now',
      decidedBy: 'keith',
    });
    expect(decided.status).toBe('approved');
    expect(decided.decision).toBe('add-now');
    expect(decided.decided_by).toBe('keith');
  });

  it('decline requires a stated consequence', async () => {
    const cs = await awaiting();
    await expect(
      decideChangeset(ctx(), {
        changesetId: cs.changeset_id,
        decision: 'decline',
      }),
    ).rejects.toThrow(/stated consequence/);
    const decided = await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'decline',
      rationale: 'Out of product scope for this release train',
    });
    expect(decided.status).toBe('rejected');
  });

  it('swap-scope removes the displaced release items and records the consequence', async () => {
    await seedRelease('REL-0001', 'SR-0009');
    const cs = await awaiting();
    tick();
    const decided = await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'swap-scope',
      rationale: 'SR-0009 slips; SSO takes its slot',
      consequences: {
        swap_out: [
          { release_id: 'REL-0001', item_kind: 'ticket', item_id: 'SR-0009' },
        ],
      },
    });
    expect(decided.status).toBe('approved');
    expect(
      await store.listReleaseItems({ workspace: WS, release_id: 'REL-0001' }),
    ).toHaveLength(0);
    const events = await store.listEvents({ workspace: WS });
    expect(events.map((e) => e.event)).toContain('release_items_changed');
  });

  it('swap-scope without stated displacements fails closed', async () => {
    const cs = await awaiting();
    await expect(
      decideChangeset(ctx(), {
        changesetId: cs.changeset_id,
        decision: 'swap-scope',
        rationale: 'trust me',
      }),
    ).rejects.toThrow(/swap_out/);
  });

  it('next-release defers to an open release', async () => {
    await seedRelease('REL-0002', 'SR-0010');
    const cs = await awaiting();
    const decided = await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'next-release',
      consequences: { target_release: 'REL-0002' },
    });
    expect(decided.status).toBe('deferred');
  });

  it('a decided set cannot be re-decided', async () => {
    const cs = await awaiting();
    await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'add-now',
    });
    await expect(
      decideChangeset(ctx(), {
        changesetId: cs.changeset_id,
        decision: 'decline',
        rationale: 'changed my mind',
      }),
    ).rejects.toMatchObject({ code: 'bad_state' });
  });

  it('normalizes approval expiry to UTC ISO', async () => {
    const cs = await awaiting();
    const decided = await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'add-now',
      expiresOn: '2026-11-01T12:00:00+02:00',
    });
    expect(decided.expires_on).toBe('2026-11-01T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// emergency route
// ---------------------------------------------------------------------------

describe('emergency route', () => {
  it('decides before analysis completes; the retro is mandatory before verify', async () => {
    const cs = await createChangeset(ctx(), {
      request: 'HOTFIX: auth bypass',
      emergency: true,
      classification: 'correction',
    });
    expect(cs.status).toBe('draft');
    // The item lands while the set is still draft (the expedited path
    // decides before analysis completes, not before the proposal).
    await addChangesetItem(ctx(), {
      changesetId: cs.changeset_id,
      input: {
        subject: 'SR-0001',
        doc: 'rs.md',
        change: { content: 'hotfix note' },
      },
    });
    tick();
    const decided = await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'add-now',
      rationale: 'security fix, expedited',
    });
    expect(decided.status).toBe('approved');
    tick();
    const applied = await applyChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(applied.status).toBe('applying');

    // Verify refuses while the mandatory retro is missing.
    await expect(
      verifyChangeset(ctx(), { changesetId: cs.changeset_id }),
    ).rejects.toThrow(/retro/);

    const retro = await attachRetro(ctx(), {
      changesetId: cs.changeset_id,
      content: 'retro: expedited security fix',
    });
    expect(retro.retro_ref).toBeTruthy();
    const verified = await verifyChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(verified.status).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// apply + verify
// ---------------------------------------------------------------------------

describe('applyChangeset', () => {
  it('applies a doc proposal as a new immutable version', async () => {
    await seedDoc('SR-0001', 'rs.md', 'v1 requirements');
    const cs = await createChangeset(ctx(), {
      request: 'Add SSO requirement',
      classification: 'addition',
      baseline: { subject: 'SR-0001', doc: 'rs.md' },
    });
    await addChangesetItem(ctx(), {
      changesetId: cs.changeset_id,
      input: {
        subject: 'SR-0001',
        doc: 'rs.md',
        change: { content: 'v2 requirements + SSO' },
      },
    });
    await analyzeChangeset(ctx(), { changesetId: cs.changeset_id });
    await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'add-now',
    });
    tick();
    const applied = await applyChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(applied.status).toBe('applying');

    const head = await store.getDoc({
      workspace: WS,
      subject: 'SR-0001',
      doc: 'rs.md',
    });
    expect(head?.version).toBe(2);
    expect(head?.content).toContain('v2 requirements + SSO');
    const items = await store.listChangesetItems({
      workspace: WS,
      changeset_id: cs.changeset_id,
    });
    expect(items[0]?.status).toBe('applied');

    const verified = await verifyChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(verified.status).toBe('verified');
    // Terminal — a second apply is refused.
    await expect(
      applyChangeset(ctx(), { changesetId: cs.changeset_id }),
    ).rejects.toMatchObject({ code: 'bad_state' });
  });

  it('an undeclared decision blocks apply — approved is required', async () => {
    const cs = await createChangeset(ctx(), { request: 'x' });
    await expect(
      applyChangeset(ctx(), { changesetId: cs.changeset_id }),
    ).rejects.toMatchObject({ code: 'bad_state' });
  });
});

// ---------------------------------------------------------------------------
// expiry + terminal moves
// ---------------------------------------------------------------------------

describe('sweep + terminal moves', () => {
  it('an expired approval revalidates loudly', async () => {
    const cs = await awaiting();
    await decideChangeset(ctx(), {
      changesetId: cs.changeset_id,
      decision: 'add-now',
      expiresOn: new Date(T0 + 60_000).toISOString(),
    });
    clock = T0 + 10 * 60_000;
    const report = await sweepChangesetExpiry(ctx());
    expect(report.expired).toContain(cs.changeset_id);
    const after = await store.getChangeset({
      workspace: WS,
      changeset_id: cs.changeset_id,
    });
    expect(after?.status).toBe('awaiting-decision');
  });

  it('abandon retires a draft; reopen brings it back', async () => {
    const cs = await createChangeset(ctx(), { request: 'later' });
    const abandoned = await abandonChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(abandoned.status).toBe('abandoned');
    tick();
    const reopened = await reopenChangeset(ctx(), {
      changesetId: cs.changeset_id,
    });
    expect(reopened.status).not.toBe('abandoned');
  });

  it('unknown set → typed not_found (the API layer maps it to 404)', async () => {
    await expect(
      analyzeChangeset(ctx(), { changesetId: 'CS-9999' }),
    ).rejects.toBeInstanceOf(ChangesetError);
  });
});
