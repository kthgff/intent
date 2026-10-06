/**
 * wp-153 process machinery — DoR engine, Assumption Register,
 * Quality Debt, Delivery Commitments, per-check DoD (PRD §15.10).
 *
 * Drives `RealTransitionHandler.nextStage` directly against PGlite
 * (same harness shape as transitions.test.ts); register units are
 * exercised through conductor/registers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@veto/config';
import type { TicketRow } from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransitionContext } from '../src/contracts.js';
import { parseTicketMd } from '../src/import/parse.js';
import {
  advanceCommitment,
  auditCommitments,
  captureAssumption,
  commitScope,
  commitmentDrift,
  confirmAssumption,
  evaluateDor,
  expireQualityDebt,
  formatAssumptionContext,
  pinDocVersions,
  recordGateWaiver,
} from '../src/registers/index.js';
import {
  dodCheckStatuses,
  dodChecksClear,
  parseDodRows,
} from '../src/shepherd/dod.js';
import { RealTransitionHandler } from '../src/transitions/index.js';

const WS = 'ws';
const NOW = '2026-10-05T00:00:00Z';

let dir: string;
let store: PostgresStore;
let handler: RealTransitionHandler;
let nowMs = Date.parse(NOW);

function makeConfig(
  gates: 'full' | 'plan-package' | 'minimal' = 'full',
  overrides: Record<string, unknown> = {},
) {
  return resolveConfig(null, {
    config: {
      actor: 'test-bot',
      backend: 'mock',
      gates,
      repos: { 'code-repo': { path: join(dir, 'code-repo') } },
      security: { scan_on_commit: false },
      ...overrides,
    },
    warnings: [],
    secrets: {},
    files: [],
  });
}

function ctx(): TransitionContext {
  return {
    workspace: WS,
    rootPath: dir,
    store,
    actor: 'test-bot',
    now: () => new Date(nowMs),
  };
}

const rctx = () => ({
  store,
  workspace: WS,
  actor: 'test-bot',
  now: () => new Date(nowMs),
});

async function seedTicket(
  id: string,
  status: TicketRow['status'],
  opts: {
    body?: string;
    extraFm?: Record<string, string>;
    row?: Partial<TicketRow>;
  } = {},
): Promise<TicketRow> {
  const raw = [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${status}`,
    'priority: medium',
    ...('repos' in (opts.extraFm ?? {}) ? [] : ['repos: [code-repo]']),
    ...Object.entries(opts.extraFm ?? {}).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    opts.body ??
      [
        '## Description',
        'A sufficiently long description for spec lint purposes.',
        '',
        '## Acceptance criteria',
        '- [ ] Something verifiable happens',
        '',
      ].join('\n'),
  ].join('\n');
  const parsed = parseTicketMd(raw, `${id}/ticket.md`);
  if (!parsed.ok) throw new Error(`seed ${id}: ${parsed.error.error}`);
  const fm = parsed.value.frontmatter;
  const ts = new Date(nowMs).toISOString();
  const row: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature: fm.feature ?? null,
    title: fm.title,
    status: fm.status,
    priority: fm.priority,
    depth: fm.depth ?? null,
    backend: fm.backend ?? null,
    model: fm.model ?? null,
    repos: fm.repos,
    parent: fm.parent ?? null,
    depends_on: fm.depends_on,
    serves: null,
    source: fm.source ?? null,
    forced: fm.forced ?? false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: fm.blocked_reason ?? null,
    created_at: ts,
    updated_at: ts,
    ...(opts.row ?? {}),
  };
  await store.upsertTicket(row);
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    raw,
    'test-seed',
  );
  return row;
}

const ticket = (id: string) =>
  store.getTicket({ workspace: WS, ticket_id: id });
const gate = (subject: string, g: string) =>
  store.getGateItem({ workspace: WS, subject, gate: g });

/** gate_items carry no payload column — the named missing checks ride
 *  the notification the surface emits (JSON of the surfaceGateItem). */
async function dorMissing(
  id: string,
): Promise<{ id: string; detail?: string }[]> {
  const notes = await store.listNotifications({ workspace: WS });
  for (const n of [...notes].reverse()) {
    if (n.subject !== id || n.kind !== 'gate:failure') continue;
    const item = JSON.parse(n.payload ?? '{}') as {
      gate?: string;
      payload?: { missing?: { id: string; detail?: string }[] };
    };
    if (item.gate === 'dor') return item.payload?.missing ?? [];
  }
  return [];
}
const events = (ticketId?: string) =>
  store.listEvents({
    workspace: WS,
    ...(ticketId ? { ticket_id: ticketId } : {}),
  });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-wp153-'));
  store = await PostgresStore.connect('pglite:');
  handler = new RealTransitionHandler(makeConfig());
  nowMs = Date.parse(NOW);
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DoR engine
// ---------------------------------------------------------------------------

describe('DoR engine (ready gate)', () => {
  it('a complete ready ticket advances to prd-draft', async () => {
    const t = await seedTicket('SR-0100', 'ready');
    const next = await handler.nextStage(t, ctx());
    expect(next?.stage).toBe('prd');
    expect((await ticket('SR-0100'))?.status).toBe('prd-draft');
    expect(await gate('SR-0100', 'dor')).toBeNull();
  });

  it('blocks ready with the missing checks NAMED on a dor gate item', async () => {
    const t = await seedTicket('SR-0101', 'ready', {
      body: ['## Description', 'Only a description, no ACs.', ''].join('\n'),
    });
    const next = await handler.nextStage(t, ctx());
    expect(next).toBeNull();
    expect((await ticket('SR-0101'))?.status).toBe('ready');
    const item = await gate('SR-0101', 'dor');
    expect(item?.cleared_at).toBeNull();
    const missing = (await dorMissing('SR-0101')).map((m) => m.id);
    expect(missing).toContain('acceptance-criteria');
  });

  it('names an unknown repo + an undelivered dependency', async () => {
    const t = await seedTicket('SR-0102', 'ready', {
      extraFm: { repos: '[ghost-repo]', depends_on: '[SR-0999]' },
    });
    const next = await handler.nextStage(t, ctx());
    expect(next).toBeNull();
    const missing = await dorMissing('SR-0102');
    expect(missing.map((m) => m.id)).toEqual(
      expect.arrayContaining(['dependencies', 'repo-context']),
    );
  });

  it('re-evaluates after the human fixes the doc and clears the gate', async () => {
    const t = await seedTicket('SR-0103', 'ready', {
      body: ['## Description', 'No ACs yet.', ''].join('\n'),
    });
    expect(await handler.nextStage(t, ctx())).toBeNull();
    // Human fixes the ticket doc (a new doc_version, never in-place)
    // and clears the gate — the next tick re-evaluates and proceeds.
    const current = await store.getDoc({
      workspace: WS,
      subject: 'SR-0103',
      doc: 'ticket.md',
    });
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0103', doc: 'ticket.md' },
      `${current?.content}\n## Acceptance criteria\n- [ ] works\n`,
      'human',
    );
    await store.clearGateItem(
      { workspace: WS, subject: 'SR-0103', gate: 'dor' },
      new Date(nowMs).toISOString(),
    );
    const next = await handler.nextStage(
      (await ticket('SR-0103')) as TicketRow,
      ctx(),
    );
    expect(next?.stage).toBe('prd');
  });

  it('a forced ticket proceeds on failed checks — and the waiver feeds quality debt', async () => {
    const t = await seedTicket('SR-0104', 'ready', {
      extraFm: { forced: 'true' },
      body: ['## Description', 'No ACs — forced through.', ''].join('\n'),
    });
    const next = await handler.nextStage(t, ctx());
    expect(next?.stage).toBe('prd');
    const debt = await store.getQualityDebt({
      workspace: WS,
      debt_id: 'waiver:SR-0104:dor',
    });
    expect(debt?.kind).toBe('accepted-risk');
    const evs = await events('SR-0104');
    expect(
      evs.some(
        (e) =>
          e.event === 'gate_overridden' &&
          (e.data as { gate?: string }).gate === 'dor',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Assumption Register
// ---------------------------------------------------------------------------

describe('Assumption Register', () => {
  it('a high-impact unverified assumption gates ready', async () => {
    const t = await seedTicket('SR-0110', 'ready');
    await captureAssumption(rctx(), {
      assumption_id: 'as-1',
      subject: 'SR-0110',
      statement: 'The S3 API stays eventual-consistent',
      impact: 'high',
      source: 'run:ws/SR-0110/001-triage',
      affected: await pinDocVersions(store, WS, 'SR-0110'),
    });
    expect(await handler.nextStage(t, ctx())).toBeNull();
    const missing = (await dorMissing('SR-0110')).map((m) => m.id);
    expect(missing).toContain('assumptions');
  });

  it('a human risk-acceptance unblocks; an agent can never risk-accept', async () => {
    await seedTicket('SR-0111', 'ready');
    await captureAssumption(rctx(), {
      assumption_id: 'as-2',
      subject: 'SR-0111',
      statement: 'Downstream tolerates the new field',
      impact: 'high',
      source: 'test',
    });
    await expect(
      confirmAssumption(rctx(), {
        assumption_id: 'as-2',
        status: 'risk-accepted',
        actor: 'bot',
        actorKind: 'agent',
      }),
    ).rejects.toThrow(/only a human/);
    await confirmAssumption(rctx(), {
      assumption_id: 'as-2',
      status: 'risk-accepted',
      actor: 'keith',
      actorKind: 'human',
    });
    expect(
      (await store.getAssumption({ workspace: WS, assumption_id: 'as-2' }))
        ?.status,
    ).toBe('risk-accepted');
    const dor = await evaluateDor({
      ctx: ctx(),
      config: makeConfig(),
      ticket: (await ticket('SR-0111')) as TicketRow,
    });
    expect(dor.ok).toBe(true);
  });

  it('medium-impact assumptions surface in context but do not gate', async () => {
    const t = await seedTicket('SR-0112', 'ready');
    await captureAssumption(rctx(), {
      assumption_id: 'as-3',
      subject: 'SR-0112',
      statement: 'A minor unverified thing',
      impact: 'medium',
      source: 'test',
      evidence_needed: 'a log line',
    });
    const next = await handler.nextStage(t, ctx());
    expect(next?.stage).toBe('prd');
    const ctx2 = formatAssumptionContext(
      await store.listAssumptions({ workspace: WS, subject: 'SR-0112' }),
    );
    expect(ctx2).toContain('## Assumption register');
    expect(ctx2).toContain('as-3');
    expect(ctx2).toContain('a log line');
  });

  it('stale assumptions revalidate LOUDLY (event, deduped)', async () => {
    await seedTicket('SR-0113', 'ready');
    await captureAssumption(rctx(), {
      assumption_id: 'as-4',
      subject: 'SR-0113',
      statement: 'Spec v1 says X',
      impact: 'medium',
      source: 'test',
      affected: ['doc:ticket.md#v1'],
    });
    // Spec moves on — the assumption's pinned baseline is stale.
    const doc = await store.getDoc({
      workspace: WS,
      subject: 'SR-0113',
      doc: 'ticket.md',
    });
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0113', doc: 'ticket.md' },
      `${doc?.content}\nmore\n`,
      'human',
    );
    const r1 = await evaluateDor({
      ctx: ctx(),
      config: makeConfig(),
      ticket: (await ticket('SR-0113')) as TicketRow,
    });
    expect(r1.staleAssumptions).toBe(1);
    let stale = (await events('SR-0113')).filter(
      (e) => e.event === 'assumption_stale',
    );
    expect(stale).toHaveLength(1);
    expect((stale[0]?.data as { head?: number }).head).toBe(2);
    // Same drift → no ledger spam on the next tick.
    await evaluateDor({
      ctx: ctx(),
      config: makeConfig(),
      ticket: (await ticket('SR-0113')) as TicketRow,
    });
    stale = (await events('SR-0113')).filter(
      (e) => e.event === 'assumption_stale',
    );
    expect(stale).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Quality Debt
// ---------------------------------------------------------------------------

describe('Quality Debt', () => {
  it('records debt with owner + revisit, expires loudly past expires_at', async () => {
    await recordGateWaiver(rctx(), {
      subject: 'SR-0120',
      gate: 'rs-quality',
      actor: 'keith',
      reason: 'waived for launch',
    });
    const debt = await store.getQualityDebt({
      workspace: WS,
      debt_id: 'waiver:SR-0120:rs-quality',
    });
    expect(debt?.kind).toBe('accepted-risk');
    expect(debt?.owner).toBe('keith');
    expect(debt?.status).toBe('open');
    expect(
      (await events('SR-0120')).some(
        (e) => e.event === 'quality_debt_recorded',
      ),
    ).toBe(true);

    // Give it an expiry and push the clock past it — loud flip.
    if (!debt) throw new Error('waiver debt not recorded');
    await store.upsertQualityDebt({
      ...debt,
      expires_at: '2026-10-06T00:00:00Z',
    });
    nowMs = Date.parse('2026-10-07T00:00:00Z');
    const expired = await expireQualityDebt(rctx());
    expect(expired.map((d) => d.debt_id)).toEqual([
      'waiver:SR-0120:rs-quality',
    ]);
    expect(
      (
        await store.getQualityDebt({
          workspace: WS,
          debt_id: 'waiver:SR-0120:rs-quality',
        })
      )?.status,
    ).toBe('expired');
    expect(
      (await events('SR-0120')).some((e) => e.event === 'quality_debt_expired'),
    ).toBe(true);
    // No double-flip on a second pass.
    expect(await expireQualityDebt(rctx())).toHaveLength(0);
  });

  it('an rs-quality override at prd-review feeds the register', async () => {
    // minimal mode: prd-review auto-approves — the only hold is the
    // rs-quality item, which a forced ticket overrides.
    handler = new RealTransitionHandler(makeConfig('minimal'));
    const t = await seedTicket('SR-0121', 'prd-review', {
      extraFm: { forced: 'true' },
    });
    await store.upsertGateItem({
      workspace: WS,
      subject: 'SR-0121',
      gate: 'rs-quality',
      kind: 'review',
      surfaced_at: NOW,
      cleared_at: NOW,
      blocked_agent: false,
      priority: null,
    });
    const next = await handler.nextStage(t, ctx());
    expect(next?.stage).toBe('design'); // prd-approved → tdd-draft
    const debt = await store.getQualityDebt({
      workspace: WS,
      debt_id: 'waiver:SR-0121:rs-quality',
    });
    expect(debt?.kind).toBe('accepted-risk');
  });
});

// ---------------------------------------------------------------------------
// DoD per-check engine
// ---------------------------------------------------------------------------

describe('DoD per-check engine', () => {
  const vs = [
    '## Definition of Done',
    '| criterion | verified_by |',
    '| --- | --- |',
    '| tests pass | cmd:make test |',
    '| ux reviewed | manual |',
    '| mystery | voodoo |',
    '',
  ].join('\n');

  it('evaluates each check — cmd/manual/unknown all named', () => {
    const rows = parseDodRows(vs);
    const checks = dodCheckStatuses(
      rows,
      { 'tests pass': { status: 'verified' } },
      [{ criterion: 'ux reviewed', attested_by: 'keith' }],
    );
    expect(checks.map((c) => [c.criterion, c.status])).toEqual([
      ['tests pass', 'verified'],
      ['ux reviewed', 'attested'],
      ['mystery', 'unknown'], // fail-closed — never counts as done
    ]);
    expect(dodChecksClear(checks)).toBe(false);
  });

  it('unattested manual + unverified cmd hold the flag', () => {
    const rows = parseDodRows(vs).filter((r) => r.criterion !== 'mystery');
    expect(
      dodChecksClear(
        dodCheckStatuses(rows, { 'tests pass': { status: 'verified' } }, []),
      ),
    ).toBe(false); // manual row unattested
    expect(
      dodChecksClear(
        dodCheckStatuses(rows, {}, [
          { criterion: 'ux reviewed', attested_by: 'k' },
        ]),
      ),
    ).toBe(false); // cmd row never ran
    expect(
      dodChecksClear(
        dodCheckStatuses(rows, { 'tests pass': { status: 'verified' } }, [
          { criterion: 'ux reviewed' },
        ]),
      ),
    ).toBe(true);
    // a FAILED cmd row is unmet too — it is not retried silently
    expect(
      dodChecksClear(
        dodCheckStatuses(rows, { 'tests pass': { status: 'failed' } }, [
          { criterion: 'ux reviewed' },
        ]),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delivery Commitments
// ---------------------------------------------------------------------------

describe('Delivery Commitments', () => {
  it('versions committed scope; lifecycle transitions append versions', async () => {
    const c1 = await commitScope(rctx(), {
      commitment_id: 'dc-1',
      scope: {
        requirement_versions: { 'SR-0130/rs.md': 1 },
        tickets: ['SR-0130'],
      },
      target: 'REL-0001',
      owner: 'keith',
      org: null,
      created_by: 'keith',
    });
    expect(c1.version).toBe(1);
    expect(c1.status).toBe('committed');

    const c2 = await advanceCommitment(rctx(), {
      commitment_id: 'dc-1',
      status: 'implemented',
    });
    expect(c2.version).toBe(2);
    expect(c2.status).toBe('implemented');
    expect(c2.scope).toEqual(c1.scope); // history carried, not rewritten
    expect(
      await store.listDeliveryCommitmentVersions({
        workspace: WS,
        commitment_id: 'dc-1',
      }),
    ).toHaveLength(2);
  });

  it('rejects illegal transitions (fail-closed, no silent rewrite)', async () => {
    await commitScope(rctx(), {
      commitment_id: 'dc-2',
      scope: {},
      org: null,
      created_by: 'k',
    });
    await expect(
      advanceCommitment(rctx(), {
        commitment_id: 'dc-2',
        status: 'delivered', // committed → delivered skips verified
      }),
    ).rejects.toThrow(/illegal transition/);
    await expect(
      advanceCommitment(rctx(), {
        commitment_id: 'nope',
        status: 'implemented',
      }),
    ).rejects.toThrow(/no delivery commitment/);
  });

  it('drift vs plan is computed and surfaces as commitment_drift events', async () => {
    await seedTicket('SR-0131', 'ready');
    // Pin the ticket doc head as committed requirement v1.
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0131', doc: 'rs.md' },
      '# rs\n',
      'k',
    );
    await commitScope(rctx(), {
      commitment_id: 'dc-3',
      scope: {
        requirement_versions: { 'SR-0131/rs.md': 1 },
        tickets: ['SR-0131'],
      },
      org: null,
      created_by: 'k',
    });
    // Plan moves: rs.md advances + the ticket is still undelivered.
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0131', doc: 'rs.md' },
      '# rs v2\n',
      'k',
    );
    const head = await store.getDeliveryCommitment({
      workspace: WS,
      commitment_id: 'dc-3',
    });
    if (!head) throw new Error('commitment dc-3 missing');
    const drift = await commitmentDrift(store, WS, head);
    expect(drift.map((d) => d.kind).sort()).toEqual([
      'doc-advanced',
      'ticket-undelivered',
    ]);

    const flagged = await auditCommitments(rctx());
    expect(flagged).toHaveLength(1);
    let evs = (await events()).filter((e) => e.event === 'commitment_drift');
    expect(evs).toHaveLength(1);
    // Same drift signature → deduped on the next audit.
    await auditCommitments(rctx());
    evs = (await events()).filter((e) => e.event === 'commitment_drift');
    expect(evs).toHaveLength(1);
  });
});
