/**
 * wp-134 Release Center tests (DELIVERY §3–§4) — the lifecycle engine
 * over a real PGlite PostgresStore.
 *
 * Covers: the full draft→ready→approved→released→closed lifecycle;
 * manifest immutability + scope-change re-cut resetting approvals
 * (invariant 3); the transactional `release_released` member flip;
 * the partial-release `approved_by` rule (invariant 5) at engine AND
 * DB level; the human-only approval rule (invariant 6); the merged_sha
 * gate (invariant 2); the material open correction block; gate waivers;
 * and the abandoned/closed terminals.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  FeatureRow,
  ReleaseRow,
  TicketRepoRow,
  TicketRow,
  TicketStatus,
} from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReleaseCtx } from '../src/release/index.js';
import {
  ReleaseError,
  abandonRelease,
  addReleaseItem,
  approveRelease,
  closeRelease,
  createRelease,
  evaluateRelease,
  fileCorrection,
  freezeRelease,
  getReleaseDetail,
  markReleased,
  removeReleaseItem,
  waiveReleaseGate,
} from '../src/release/index.js';

const WS = 'ws';
let dir: string;
let store: PostgresStore;
let ctx: ReleaseCtx;

function ticketRow(
  id: string,
  status: TicketStatus,
  patch: Partial<TicketRow> = {},
): TicketRow {
  const now = new Date().toISOString();
  return {
    workspace: WS,
    ticket_id: id,
    feature: null,
    title: `Ticket ${id}`,
    status,
    priority: 'medium',
    depth: 'standard',
    backend: 'mock',
    model: null,
    repos: ['api'],
    parent: null,
    depends_on: [],
    serves: null,
    source: null,
    work_type: null,
    origin: null,
    severity: null,
    forced: false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: null,
    created_at: now,
    updated_at: now,
    ...patch,
  };
}

async function seedMergedTicket(
  id: string,
  opts: {
    status?: TicketStatus;
    feature?: string | null;
    repos?: string[];
    mergedSha?: string | null;
  } = {},
): Promise<void> {
  const status = opts.status ?? 'merged';
  const repos = opts.repos ?? ['api'];
  await store.upsertTicket(
    ticketRow(id, status, { feature: opts.feature ?? null, repos }),
  );
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    [
      '---',
      'schema: 1',
      `id: ${id}`,
      `title: Ticket ${id}`,
      `status: ${status}`,
      'priority: medium',
      `repos: [${repos.join(', ')}]`,
      '---',
      '',
      '## Description',
      'seed',
      '',
    ].join('\n'),
    'test-seed',
  );
  for (const repo of repos) {
    const row: TicketRepoRow = {
      workspace: WS,
      ticket_id: id,
      repo,
      branch: `ticket/${id}`,
      worktree: null,
      pr_url: `https://example.com/pr/${id}/${repo}`,
      pr_state: 'merged',
      ci_state: 'green',
      merged_sha:
        opts.mergedSha === undefined ? `sha-${id}-${repo}` : opts.mergedSha,
    };
    await store.upsertTicketRepo(row);
  }
}

async function seedFeature(id: string, members: string[]): Promise<void> {
  const row: FeatureRow = {
    workspace: WS,
    feature: id,
    title: `Feature ${id}`,
    status: 'done',
  } as FeatureRow;
  await store.upsertFeature(row);
  for (const m of members) {
    await seedMergedTicket(m, { feature: id });
  }
}

async function getRel(id: string): Promise<ReleaseRow> {
  const r = await store.getRelease({ workspace: WS, release_id: id });
  if (!r) throw new Error(`missing release ${id}`);
  return r;
}

async function releaseEvents(id: string): Promise<string[]> {
  return (await store.listEvents({ workspace: WS, subject: id })).map(
    (e) => e.event,
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-rel-'));
  store = await PostgresStore.connect('pglite:');
  ctx = {
    workspace: WS,
    rootPath: dir,
    store,
    actor: 'keith',
    now: () => new Date('2026-10-06T12:00:00Z'),
  };
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('release center — lifecycle', () => {
  it('draft → ready → approved → released → closed end to end', async () => {
    await seedFeature('F-0001', ['SR-0101', 'SR-0102']);
    await seedMergedTicket('SR-0200');

    const rel = await createRelease(ctx, { title: 'v1.0' });
    expect(rel.release_id).toMatch(/^REL-\d+$/);
    expect(rel.status).toBe('draft');

    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'feature',
      itemId: 'F-0001',
    });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0200',
    });

    const manifest = await freezeRelease(ctx, rel.release_id);
    expect(manifest.version).toBe(1);
    expect(manifest.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.items).toHaveLength(2);
    const fItem = manifest.items.find((i) => i.item_id === 'F-0001');
    expect(fItem?.repos).toHaveLength(2); // one per member ticket
    expect(fItem?.repos.every((r) => r.merged_sha)).toBe(true);
    expect(
      (await store.getRelease({ workspace: WS, release_id: rel.release_id }))
        ?.status,
    ).toBe('ready');

    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    expect(
      (await store.getRelease({ workspace: WS, release_id: rel.release_id }))
        ?.status,
    ).toBe('approved');

    const { tickets, manifest_version } = await markReleased(
      ctx,
      rel.release_id,
    );
    expect(manifest_version).toBe(1);
    expect(tickets.sort()).toEqual(['SR-0101', 'SR-0102', 'SR-0200']);
    for (const t of tickets) {
      const row = await store.getTicket({
        workspace: WS,
        ticket_id: t,
      });
      expect(row?.status).toBe('released');
      // ticket.md frontmatter kept in step (D24 doc version).
      const doc = await store.getDoc({
        workspace: WS,
        subject: t,
        doc: 'ticket.md',
      });
      expect(doc?.content).toContain('status: released');
    }
    const items = await store.listReleaseItems({
      workspace: WS,
      release_id: rel.release_id,
    });
    expect(items.every((i) => i.delivery_state === 'released')).toBe(true);

    const evs = await releaseEvents(rel.release_id);
    expect(evs).toContain('release_created');
    expect(evs).toContain('release_items_changed');
    expect(evs).toContain('manifest_cut');
    expect(evs).toContain('release_approved');
    expect(evs).toContain('release_released');
    // member tickets got their own status_changed events.
    for (const t of tickets) {
      const tevs = await store.listEvents({
        workspace: WS,
        ticket_id: t,
        event: 'status_changed',
      });
      expect(tevs.some((e) => e.data.to === 'released')).toBe(true);
    }

    await closeRelease(ctx, rel.release_id);
    expect(
      (await store.getRelease({ workspace: WS, release_id: rel.release_id }))
        ?.status,
    ).toBe('closed');
  });

  it('rejects transitions from terminal/illegal statuses', async () => {
    await seedMergedTicket('SR-0301');
    const rel = await createRelease(ctx, { title: 'x' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0301',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    await markReleased(ctx, rel.release_id);

    await expect(
      addReleaseItem(ctx, rel.release_id, {
        itemKind: 'ticket',
        itemId: 'SR-0301',
      }),
    ).rejects.toMatchObject({ code: 'bad-state' });
    await expect(freezeRelease(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });
    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });
    await expect(abandonRelease(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });
  });

  it('abandon is terminal; draft/ready/approved can abandon', async () => {
    const rel = await createRelease(ctx, { title: 'doomed' });
    await abandonRelease(ctx, rel.release_id, { reason: 'superseded' });
    expect(
      (await store.getRelease({ workspace: WS, release_id: rel.release_id }))
        ?.status,
    ).toBe('abandoned');
    await expect(
      addReleaseItem(ctx, rel.release_id, {
        itemKind: 'ticket',
        itemId: 'SR-0999',
      }),
    ).rejects.toMatchObject({ code: 'bad-state' });
    await expect(freezeRelease(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });
    const evs = await releaseEvents(rel.release_id);
    expect(evs).toContain('discarded');
  });
});

describe('release center — manifest freeze', () => {
  it('freeze on an empty scope fails closed', async () => {
    const rel = await createRelease(ctx, { title: 'empty' });
    await expect(freezeRelease(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'empty-manifest',
    });
  });

  it('scope change after a cut appends a new version and resets approvals (invariant 3)', async () => {
    await seedMergedTicket('SR-0401');
    await seedMergedTicket('SR-0402');
    const rel = await createRelease(ctx, { title: 'v2' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0401',
    });
    const m1 = await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    expect(
      (await store.getRelease({ workspace: WS, release_id: rel.release_id }))
        ?.status,
    ).toBe('approved');

    // Scope change on an approved release → new manifest version, and
    // the release falls back to `ready` (pending re-approval).
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0402',
    });
    const manifests = await store.listReleaseManifests({
      workspace: WS,
      release_id: rel.release_id,
    });
    expect(manifests.map((m) => m.version)).toEqual([1, 2]);
    expect(manifests[1]?.digest).not.toBe(m1.digest);
    expect(
      (await store.getRelease({ workspace: WS, release_id: rel.release_id }))
        ?.status,
    ).toBe('ready');

    // The v1 approval stays as audit but does NOT count for v2 —
    // releasing now fails the `approved` gate.
    const { checks } = await evaluateRelease(ctx, await getRel(rel.release_id));
    const approved = checks.find((c) => c.gate === 'approved');
    expect(approved?.verdict).toBe('fail');
    // Status is `ready`, not `approved` — markReleased stops at the
    // status check before the gates even run.
    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });

    // Re-approve the new digest → release succeeds.
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    const approvals = await store.listReleaseApprovals({
      workspace: WS,
      release_id: rel.release_id,
    });
    expect(approvals).toHaveLength(2); // audit keeps both versions
    const { tickets } = await markReleased(ctx, rel.release_id);
    expect(tickets.sort()).toEqual(['SR-0401', 'SR-0402']);
    const evs = await releaseEvents(rel.release_id);
    expect(evs.filter((e) => e === 'manifest_cut')).toHaveLength(2);
  });

  it('item removal post-freeze also re-cuts; re-freeze with unchanged digest is a no-op', async () => {
    await seedMergedTicket('SR-0501');
    await seedMergedTicket('SR-0502');
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0501',
    });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0502',
    });
    await freezeRelease(ctx, rel.release_id);
    await removeReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0502',
    });
    let manifests = await store.listReleaseManifests({
      workspace: WS,
      release_id: rel.release_id,
    });
    expect(manifests).toHaveLength(2);
    expect(manifests[1]?.items).toHaveLength(1);

    // Re-freeze: same scope → same digest → same version, no new row.
    const again = await freezeRelease(ctx, rel.release_id);
    expect(again.version).toBe(2);
    manifests = await store.listReleaseManifests({
      workspace: WS,
      release_id: rel.release_id,
    });
    expect(manifests).toHaveLength(2);
  });
});

describe('release center — approvals', () => {
  it('an agent can never approve (invariant 6); AI may still propose membership', async () => {
    await seedMergedTicket('SR-0601');
    const rel = await createRelease(ctx, { title: 'v' });
    // AI-proposed membership is fine.
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0601',
      addedBy: 'agent:planner',
      actorType: 'agent',
    });
    await freezeRelease(ctx, rel.release_id);
    await expect(
      approveRelease(ctx, rel.release_id, {
        approver: 'agent:planner',
        actorType: 'agent',
        decision: 'approved',
      }),
    ).rejects.toMatchObject({ code: 'ai-approval' });
    await expect(
      approveRelease(ctx, rel.release_id, {
        approver: 'runner',
        actorType: 'runner',
        decision: 'approved',
      }),
    ).rejects.toMatchObject({ code: 'ai-approval' });
    expect(
      await store.listReleaseApprovals({
        workspace: WS,
        release_id: rel.release_id,
      }),
    ).toHaveLength(0);
  });

  it('rejection returns the release to draft', async () => {
    await seedMergedTicket('SR-0602');
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0602',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'rejected',
      rationale: 'scope too big',
    });
    expect(
      (await store.getRelease({ workspace: WS, release_id: rel.release_id }))
        ?.status,
    ).toBe('draft');
    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'bad-state',
    });
  });
});

describe('release center — partial releases (invariant 5)', () => {
  it('partial_ac without approved_by fails closed — engine AND database', async () => {
    await seedMergedTicket('SR-0701');
    const rel = await createRelease(ctx, { title: 'v' });
    await expect(
      addReleaseItem(ctx, rel.release_id, {
        itemKind: 'ticket',
        itemId: 'SR-0701',
        partialAc: ['AC-1'],
      }),
    ).rejects.toMatchObject({ code: 'partial-unapproved' });

    // Engine-level: an empty ac_ids list is malformed, not "full".
    await expect(
      addReleaseItem(ctx, rel.release_id, {
        itemKind: 'ticket',
        itemId: 'SR-0701',
        partialAc: [],
      }),
    ).rejects.toMatchObject({ code: 'bad-item' });

    // Agent-supplied approval is rejected (invariant 6 at item level).
    await expect(
      addReleaseItem(ctx, rel.release_id, {
        itemKind: 'ticket',
        itemId: 'SR-0701',
        partialAc: ['AC-1'],
        approvedBy: 'bot',
        actorType: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'ai-approval' });

    // DB-level backstop (0006 CHECK constraint).
    await expect(
      store.upsertReleaseItem({
        workspace: WS,
        release_id: rel.release_id,
        item_kind: 'ticket',
        item_id: 'SR-0701',
        partial_ac: ['AC-1'],
        approved_by: null,
      }),
    ).rejects.toThrow();

    // The legal path: human-approved partial release.
    const row = await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0701',
      partialAc: ['AC-1'],
      approvedBy: 'keith',
    });
    expect(row.partial_ac).toEqual(['AC-1']);
    expect(row.approved_by).toBe('keith');
    // …and it survives the partial-ac gate at release time.
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    const { checks } = await evaluateRelease(ctx, await getRel(rel.release_id));
    expect(checks.find((c) => c.gate === 'partial-ac')?.verdict).toBe('pass');
  });
});

describe('release center — merged gate (invariant 2)', () => {
  it('released requires every manifest item→repo to carry merged_sha', async () => {
    await seedMergedTicket('SR-0801', { mergedSha: null });
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0801',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'gate-failed',
    });
    // The failed attempt is audited with the manifest binding.
    const gates = await store.listReleaseGateResults({
      workspace: WS,
      release_id: rel.release_id,
      gate: 'merged',
    });
    expect(gates.at(-1)?.result).toBe('fail');
    expect(
      (gates.at(-1)?.evidence as { manifest_version: number }).manifest_version,
    ).toBe(1);
    // …and the ticket was NOT flipped.
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: 'SR-0801' }))?.status,
    ).toBe('merged');
  });

  it('a member ticket that is not merged blocks even when sha exists', async () => {
    await seedMergedTicket('SR-0802', { status: 'review' });
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0802',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    const { checks } = await evaluateRelease(ctx, await getRel(rel.release_id));
    const merged = checks.find((c) => c.gate === 'merged');
    expect(merged?.verdict).toBe('fail');
    expect(merged?.detail).toContain('SR-0802');
  });
});

describe('release center — corrections', () => {
  it('fileCorrection creates origin:correction child + correction_filed event', async () => {
    await seedMergedTicket('SR-0901');
    const row = await fileCorrection(ctx, {
      parent: 'SR-0901',
      title: 'NPE in prod',
      severity: 'critical',
    });
    expect(row.ticket_id).toMatch(/^SR-/);
    expect(row.origin).toBe('correction');
    expect(row.work_type).toBe('bug');
    expect(row.parent).toBe('SR-0901');
    expect(row.status).toBe('imported');
    expect(row.severity).toBe('critical');

    const doc = await store.getDoc({
      workspace: WS,
      subject: row.ticket_id,
      doc: 'ticket.md',
    });
    expect(doc?.content).toContain('origin: correction');
    const evs = await store.listEvents({
      workspace: WS,
      ticket_id: 'SR-0901',
      event: 'correction_filed',
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]?.refs).toEqual([row.ticket_id]);
  });

  it('corrections only attach to merged|released parents', async () => {
    await seedMergedTicket('SR-0902', { status: 'in-progress' });
    await expect(
      fileCorrection(ctx, { parent: 'SR-0902', title: 'x' }),
    ).rejects.toMatchObject({ code: 'bad-state' });
    await expect(
      fileCorrection(ctx, { parent: 'SR-NOPE', title: 'x' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a material open correction blocks the release; minor does not; closing unblocks', async () => {
    await seedMergedTicket('SR-0903');
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0903',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });

    const minor = await fileCorrection(ctx, {
      parent: 'SR-0903',
      title: 'typo in toast',
      severity: 'minor',
    });
    // Non-material → gate still green.
    const rel0 = await getRel(rel.release_id);
    let { checks } = await evaluateRelease(ctx, rel0);
    expect(checks.find((c) => c.gate === 'corrections')?.verdict).toBe('pass');

    const blocker = await fileCorrection(ctx, {
      parent: 'SR-0903',
      title: 'data loss',
      severity: 'blocker',
    });
    ({ checks } = await evaluateRelease(ctx, rel0));
    const corr = checks.find((c) => c.gate === 'corrections');
    expect(corr?.verdict).toBe('fail');
    expect(corr?.detail).toContain(blocker.ticket_id);

    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'gate-failed',
    });

    // Closing the material correction (terminal status) unblocks.
    const closed = await store.getTicket({
      workspace: WS,
      ticket_id: blocker.ticket_id,
    });
    await store.upsertTicket({
      ...(closed as TicketRow),
      status: 'released',
    });
    const { tickets } = await markReleased(ctx, rel.release_id);
    expect(tickets).toEqual(['SR-0903']);
    // The minor correction's own lifecycle is untouched (invariant 7 —
    // it carries its own ACs, the parent's history is never rewritten).
    expect(
      (await store.getTicket({ workspace: WS, ticket_id: minor.ticket_id }))
        ?.status,
    ).toBe('imported');
  });

  it('ungraded corrections count as material (fail-closed)', async () => {
    await seedMergedTicket('SR-0904');
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-0904',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    const c = await fileCorrection(ctx, {
      parent: 'SR-0904',
      title: 'unknown severity defect',
    });
    expect(c.severity).toBeNull();
    await expect(markReleased(ctx, rel.release_id)).rejects.toMatchObject({
      code: 'gate-failed',
    });
  });
});

describe('release center — gate waivers', () => {
  it('a waived gate counts as pass for the bound manifest version only', async () => {
    await seedMergedTicket('SR-1001', { mergedSha: null });
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-1001',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    const current = await getRel(rel.release_id);

    // Waiving a passing gate is rejected; no rationale is rejected.
    await expect(
      waiveReleaseGate(ctx, current, 'corrections', {
        by: 'keith',
        rationale: 'x',
      }),
    ).rejects.toMatchObject({ code: 'bad-state' });
    await expect(
      waiveReleaseGate(ctx, current, 'merged', { by: 'keith', rationale: ' ' }),
    ).rejects.toMatchObject({ code: 'bad-item' });

    await waiveReleaseGate(ctx, current, 'merged', {
      by: 'keith',
      rationale: 'hotfix ship — sha recorded manually',
    });
    const { tickets } = await markReleased(ctx, rel.release_id);
    expect(tickets).toEqual(['SR-1001']);
    const gates = await store.listReleaseGateResults({
      workspace: WS,
      release_id: rel.release_id,
      gate: 'merged',
    });
    expect(gates.map((g) => g.result)).toContain('waived');
  });
});

describe('release center — read surface', () => {
  it('getReleaseDetail aggregates items+manifest+approvals+gates', async () => {
    await seedMergedTicket('SR-1101');
    const rel = await createRelease(ctx, { title: 'v' });
    await addReleaseItem(ctx, rel.release_id, {
      itemKind: 'ticket',
      itemId: 'SR-1101',
    });
    await freezeRelease(ctx, rel.release_id);
    await approveRelease(ctx, rel.release_id, {
      approver: 'keith',
      actorType: 'human',
      decision: 'approved',
    });
    const d = await getReleaseDetail(ctx, rel.release_id);
    expect(d.release.status).toBe('approved');
    expect(d.items).toHaveLength(1);
    expect(d.manifest?.version).toBe(1);
    expect(d.approvals).toHaveLength(1);
    expect(d.approvals[0]?.approver).toBe('keith');
    await expect(getReleaseDetail(ctx, 'REL-9999')).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
