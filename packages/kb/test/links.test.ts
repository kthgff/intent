/**
 * wp-111 traceability-link service tests (INTELLIGENCE §1/§12, D37).
 *
 * Verification-state contract under test:
 *  - explicit/human proposals land `verified`; model/tool land
 *    `suggested` (or `auto-verified` ≥ auto_verify_confidence) — a
 *    suggestion can never masquerade as `verified`;
 *  - human verify/reject is idempotent, evented (link_verified /
 *    link_rejected), and OCC-safe (stale `expected` → `conflict`);
 *  - stale commit pins (not the current index head) and out-of-scope
 *    repos can never mark an edge `verified`.
 */
import {
  type Config,
  IntelligenceConfigSchema,
  type Relation,
  type RepoIndexRow,
  type TicketRow,
} from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideLink,
  LinkError,
  proposeLink,
  proposalVerification,
} from '../src/links.js';

const WS = 'ws';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

let store: PostgresStore;

/** Full intelligence config with zod defaults; `repos` is the
 *  configured-repo map the authorization checks read. */
const cfg = {
  intelligence: IntelligenceConfigSchema.parse({}),
  repos: {
    api: { path: '/nowhere/api' },
    secret: { path: '/nowhere/secret' },
  },
} as Pick<Config, 'intelligence' | 'repos'>;

function edge(over: Partial<Relation> = {}): Relation {
  return {
    subject: 'SR-L1',
    predicate: 'implements',
    object: 'doc:SR-L1:rs.md',
    source: 'model',
    confidence: 0.5,
    ...over,
  };
}

async function head(repo: string, sha: string): Promise<void> {
  const row: RepoIndexRow = {
    workspace: WS,
    repo,
    commit_sha: sha,
    status: 'current',
    parser_version: 'test',
    indexed_at: '2026-10-05T00:00:00Z',
    stats: {},
  };
  await store.upsertRepoIndex(row);
}

/** A ticket row — subject prefix scopes the edge's authorized repos. */
async function ticket(id: string, repos: string[]): Promise<void> {
  const ts = '2026-10-05T00:00:00Z';
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `${id} title`,
    status: 'in-progress',
    priority: 'medium',
    depth: null,
    backend: null,
    model: null,
    repos,
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: ts,
    updated_at: ts,
  };
  await store.upsertTicket(row);
}

const linkEvents = () => store.listEvents({ workspace: WS });

beforeEach(async () => {
  store = await PostgresStore.connect('pglite:');
});
afterEach(async () => {
  await store.close();
});

describe('proposalVerification — suggested never masquerades as verified', () => {
  it('explicit and human proposals are authoritative (verified)', () => {
    expect(proposalVerification('explicit', undefined, cfg)).toBe('verified');
    expect(proposalVerification('human', undefined, cfg)).toBe('verified');
  });

  it('model/tool proposals land suggested or auto-verified — never verified', () => {
    expect(proposalVerification('model', 0.5, cfg)).toBe('suggested');
    expect(proposalVerification('tool', 0.2, cfg)).toBe('suggested');
    expect(proposalVerification('model', 0.9, cfg)).toBe('auto-verified');
    expect(proposalVerification('tool', 0.95, cfg)).toBe('auto-verified');
  });

  it('an inferred proposal without confidence is invalid (fail-closed)', () => {
    expect(() => proposalVerification('model', undefined, cfg)).toThrow(
      LinkError,
    );
    expect(() => proposalVerification('model', undefined, cfg)).toThrow(
      /requires confidence/,
    );
  });
});

describe('proposeLink', () => {
  it('persists verification per provenance + confidence', async () => {
    const a = await proposeLink(store, cfg, edge({ source: 'explicit' }));
    expect(a.created).toBe(true);
    expect(a.edge.verification).toBe('verified');

    const b = await proposeLink(
      store,
      cfg,
      edge({ object: 'doc:SR-L1:tdd.md', source: 'model', confidence: 0.3 }),
    );
    expect(b.edge.verification).toBe('suggested');

    const c = await proposeLink(
      store,
      cfg,
      edge({ object: 'doc:SR-L1:vs.md', source: 'tool', confidence: 0.99 }),
    );
    expect(c.edge.verification).toBe('auto-verified');
  });

  it('is idempotent — a re-proposal keeps the existing edge (no downgrade)', async () => {
    const first = await proposeLink(
      store,
      cfg,
      edge({ source: 'model', confidence: 0.2 }),
    );
    expect(first.edge.verification).toBe('suggested');
    await decideLink(store, cfg, {
      workspace: WS,
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      action: 'verify',
      expected: 'suggested',
      actor: 'alice',
    });
    // A model re-proposal must not demote the human-verified edge.
    const again = await proposeLink(
      store,
      cfg,
      edge({ source: 'model', confidence: 0.1 }),
    );
    expect(again.created).toBe(false);
    expect(again.edge.verification).toBe('verified');
  });

  it('rejects a malformed edge (400-class invalid)', async () => {
    await expect(
      proposeLink(store, cfg, {
        ...edge(),
        predicate: 'not-a-predicate' as never,
      }),
    ).rejects.toThrow(LinkError);
  });
});

describe('decideLink — idempotent, evented, OCC 409', () => {
  async function suggested(object = 'doc:SR-L1:rs.md'): Promise<Relation> {
    const { edge: e } = await proposeLink(
      store,
      cfg,
      edge({ object, source: 'model', confidence: 0.4 }),
    );
    return e;
  }

  it('verify flips suggested → verified and emits link_verified once', async () => {
    await suggested();
    const decided = await decideLink(store, cfg, {
      workspace: WS,
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      action: 'verify',
      expected: 'suggested',
      actor: 'alice',
      run: 'ws/SR-L1/001-review',
    });
    expect(decided.verification).toBe('verified');
    const evs = (await linkEvents()).filter(
      (e) => e.event === 'link_verified',
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]?.actor_type).toBe('human');
    expect(evs[0]?.actor_id).toBe('alice');
    expect(evs[0]?.ticket_id).toBe('SR-L1');
    expect((evs[0]?.data as { verification?: string }).verification).toBe(
      'verified',
    );
  });

  it('repeating the same decision is a noop — no duplicate event', async () => {
    await suggested();
    const args = {
      workspace: WS,
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      action: 'reject' as const,
      expected: 'suggested' as const,
      actor: 'alice',
    };
    await decideLink(store, cfg, args);
    // Same action, edge already at target — idempotent noop.
    const again = await decideLink(store, cfg, args);
    expect(again.verification).toBe('rejected');
    const evs = (await linkEvents()).filter(
      (e) => e.event === 'link_rejected',
    );
    expect(evs).toHaveLength(1);
  });

  it('a racing decision against a stale expected state loses 409', async () => {
    await suggested();
    // Human A verifies the edge they saw as `suggested`.
    await decideLink(store, cfg, {
      workspace: WS,
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      action: 'verify',
      expected: 'suggested',
      actor: 'alice',
    });
    // Human B's stale page tries to REJECT the edge they also saw as
    // `suggested` — the OCC write conflicts (edge is now `verified`).
    const err = await decideLink(store, cfg, {
      workspace: WS,
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:SR-L1:rs.md',
      action: 'reject',
      expected: 'suggested',
      actor: 'bob',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).kind).toBe('conflict');
    expect((err as LinkError).current).toBe('verified');
    // Exactly one decision landed — one event, one state.
    const evs = await linkEvents();
    expect(
      evs.filter((e) => e.event === 'link_verified' || e.event === 'link_rejected'),
    ).toHaveLength(1);
    const edgeNow = (
      await store.listRelations({
        subject: 'SR-L1',
        predicate: 'implements',
        object: 'doc:SR-L1:rs.md',
      })
    )[0];
    expect(edgeNow?.verification).toBe('verified');
  });

  it('missing edge → missing (404-class)', async () => {
    const err = await decideLink(store, cfg, {
      workspace: WS,
      subject: 'SR-L1',
      predicate: 'implements',
      object: 'doc:nowhere',
      action: 'verify',
      expected: 'suggested',
      actor: 'alice',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).kind).toBe('missing');
  });
});

describe('decideLink — stale/unauthorized evidence can never verify', () => {
  async function pinnedEdge(object: string, over: Partial<Relation> = {}) {
    const { edge: e } = await proposeLink(
      store,
      cfg,
      edge({
        object,
        source: 'model',
        confidence: 0.4,
        ...over,
      }),
    );
    return e;
  }

  const verify = (object: string, subject = 'SR-L1') =>
    decideLink(store, cfg, {
      workspace: WS,
      subject,
      predicate: 'implements',
      object,
      action: 'verify',
      expected: 'suggested',
      actor: 'alice',
    });

  it('a commit-pinned citation verifies only at the current index head', async () => {
    await head('api', SHA2);
    await pinnedEdge(`code:api:${SHA1}:src/app.ts:main`);
    const err = await verify(`code:api:${SHA1}:src/app.ts:main`).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).kind).toBe('stale');
    // The edge stays suggested — the failed verify wrote nothing.
    const e = (
      await store.listRelations({ subject: 'SR-L1', predicate: 'implements' })
    )[0];
    expect(e?.verification).toBe('suggested');

    // The CURRENT head verifies cleanly.
    await pinnedEdge(`code:api:${SHA2}:src/app.ts:main`);
    const ok = await verify(`code:api:${SHA2}:src/app.ts:main`);
    expect(ok.verification).toBe('verified');
  });

  it('a repo outside the ticket scope is unauthorized — even at head', async () => {
    await ticket('SR-L1', ['api']); // ticket does not touch `secret`
    await head('secret', SHA1);
    await pinnedEdge(`code:secret:${SHA1}:src/x.ts:sneaky`);
    const err = await verify(`code:secret:${SHA1}:src/x.ts:sneaky`).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).kind).toBe('unauthorized');
  });

  it('an unconfigured repo is unauthorized too', async () => {
    await pinnedEdge(`code:ghost:${SHA1}:src/x.ts:s`);
    const err = await verify(`code:ghost:${SHA1}:src/x.ts:s`).catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).kind).toBe('unauthorized');
  });

  it('a sha valid_at boundary must pin a current head', async () => {
    await head('api', SHA2);
    await pinnedEdge('doc:SR-L1:rs.md#AC-1', { valid_at: SHA1 });
    const err = await verify('doc:SR-L1:rs.md#AC-1').catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).kind).toBe('stale');

    await pinnedEdge('doc:SR-L1:rs.md#AC-2', { valid_at: SHA2 });
    const ok = await verify('doc:SR-L1:rs.md#AC-2');
    expect(ok.verification).toBe('verified');
  });

  it('doc↔doc edges with no commit pin skip the freshness check', async () => {
    await pinnedEdge('doc:SR-L1:rs.md');
    const ok = await verify('doc:SR-L1:rs.md');
    expect(ok.verification).toBe('verified');
  });

  it('reject is never guarded — a stale edge can still be rejected', async () => {
    await head('api', SHA2);
    await pinnedEdge(`code:api:${SHA1}:src/app.ts:main`);
    const decided = await decideLink(store, cfg, {
      workspace: WS,
      subject: 'SR-L1',
      predicate: 'implements',
      object: `code:api:${SHA1}:src/app.ts:main`,
      action: 'reject',
      expected: 'suggested',
      actor: 'alice',
    });
    expect(decided.verification).toBe('rejected');
  });
});
