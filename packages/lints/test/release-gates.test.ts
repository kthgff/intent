/**
 * release-gates.ts — pure gate evaluation + manifest digest
 * (DELIVERY §3–§4, wp-134). No store, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  type ReleaseGateFacts,
  canonicalManifestItems,
  evaluateReleaseGates,
  isMaterialCorrection,
  releaseGatesGreen,
  releaseManifestDigest,
} from '../src/release-gates.js';

const ITEM_A = {
  item_kind: 'ticket' as const,
  item_id: 'SR-0001',
  repos: [{ repo: 'api', ticket: 'SR-0001', merged_sha: 'abc' }],
};
const ITEM_B = {
  item_kind: 'feature' as const,
  item_id: 'F-0001',
  repos: [
    { repo: 'api', ticket: 'SR-0002', merged_sha: 'def' },
    { repo: 'web', ticket: 'SR-0003', merged_sha: 'ghi' },
  ],
};

function facts(patch: Partial<ReleaseGateFacts> = {}): ReleaseGateFacts {
  return {
    manifest: {
      version: 1,
      digest: releaseManifestDigest([ITEM_A, ITEM_B]),
      items: [ITEM_A, ITEM_B],
    },
    approvals: [{ approver: 'keith', decision: 'approved' }],
    items: [
      {
        item_kind: 'ticket',
        item_id: 'SR-0001',
        partial_ac: null,
        approved_by: null,
      },
    ],
    members: [
      { ticket_id: 'SR-0001', status: 'merged' },
      { ticket_id: 'SR-0002', status: 'merged' },
      { ticket_id: 'SR-0003', status: 'released' },
    ],
    corrections: [],
    waived: [],
    ...patch,
  };
}

describe('releaseManifestDigest', () => {
  it('is order-insensitive and stable', () => {
    const shuffled = [
      {
        ...ITEM_B,
        repos: [...ITEM_B.repos].reverse(),
      },
      ITEM_A,
    ];
    expect(releaseManifestDigest(shuffled)).toBe(
      releaseManifestDigest([ITEM_A, ITEM_B]),
    );
    expect(releaseManifestDigest([ITEM_A])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when scope, sha, or partial_ac changes', () => {
    const base = releaseManifestDigest([ITEM_A]);
    expect(
      releaseManifestDigest([
        {
          ...ITEM_A,
          repos: [{ repo: 'api', ticket: 'SR-0001', merged_sha: 'zzz' }],
        },
      ]),
    ).not.toBe(base);
    expect(
      releaseManifestDigest([{ ...ITEM_A, partial_ac: ['AC-1'] }]),
    ).not.toBe(base);
    expect(releaseManifestDigest([ITEM_A, ITEM_B])).not.toBe(base);
  });
});

describe('isMaterialCorrection', () => {
  it('blocker|critical|major|ungraded are material; minor|trivial are not', () => {
    for (const s of ['blocker', 'critical', 'major']) {
      expect(isMaterialCorrection(s)).toBe(true);
    }
    expect(isMaterialCorrection(null)).toBe(true); // fail-closed
    expect(isMaterialCorrection(undefined)).toBe(true);
    for (const s of ['minor', 'trivial']) {
      expect(isMaterialCorrection(s)).toBe(false);
    }
  });
});

describe('evaluateReleaseGates', () => {
  it('all green → every gate passes', () => {
    const checks = evaluateReleaseGates(facts());
    expect(releaseGatesGreen(checks)).toBe(true);
    expect(checks.map((c) => c.verdict)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
  });

  it('no manifest → manifest/approved/merged all fail', () => {
    const checks = evaluateReleaseGates(facts({ manifest: null, members: [] }));
    const byId = Object.fromEntries(checks.map((c) => [c.gate, c]));
    expect(byId.manifest?.verdict).toBe('fail');
    expect(byId.approved?.verdict).toBe('fail');
    expect(byId.merged?.verdict).toBe('fail');
    expect(byId.corrections?.verdict).toBe('pass');
  });

  it('a rejected decision defeats approval; approvals on other versions do not apply (caller filters)', () => {
    const checks = evaluateReleaseGates(
      facts({ approvals: [{ approver: 'keith', decision: 'rejected' }] }),
    );
    const approved = checks.find((c) => c.gate === 'approved');
    expect(approved?.verdict).toBe('fail');
    expect(approved?.detail).toContain('rejected');
  });

  it('unmerged repo entries and non-merged members fail the merged gate', () => {
    const checks = evaluateReleaseGates(
      facts({
        manifest: {
          version: 1,
          digest: 'sha256:x',
          items: [
            {
              item_kind: 'ticket',
              item_id: 'SR-0001',
              repos: [{ repo: 'api', ticket: 'SR-0001', merged_sha: null }],
            },
          ],
        },
        members: [{ ticket_id: 'SR-0001', status: 'ci-watch' }],
      }),
    );
    const merged = checks.find((c) => c.gate === 'merged');
    expect(merged?.verdict).toBe('fail');
    expect(merged?.detail).toContain('unmerged');
    expect(merged?.detail).toContain('ci-watch');
  });

  it('partial_ac without approved_by fails the partial-ac gate (invariant 5)', () => {
    const checks = evaluateReleaseGates(
      facts({
        items: [
          {
            item_kind: 'ticket',
            item_id: 'SR-0001',
            partial_ac: ['AC-1'],
            approved_by: null,
          },
        ],
      }),
    );
    expect(checks.find((c) => c.gate === 'partial-ac')?.verdict).toBe('fail');
  });

  it('open material corrections block; closed or minor ones do not', () => {
    const blocking = evaluateReleaseGates(
      facts({
        corrections: [
          {
            parent: 'SR-0002',
            correction_id: 'SR-0099',
            severity: 'critical',
            open: true,
          },
        ],
      }),
    );
    expect(blocking.find((c) => c.gate === 'corrections')?.verdict).toBe(
      'fail',
    );

    const ok = evaluateReleaseGates(
      facts({
        corrections: [
          {
            parent: 'SR-0002',
            correction_id: 'SR-0099',
            severity: 'critical',
            open: false,
          },
          {
            parent: 'SR-0003',
            correction_id: 'SR-0100',
            severity: 'minor',
            open: true,
          },
        ],
      }),
    );
    expect(ok.find((c) => c.gate === 'corrections')?.verdict).toBe('pass');
  });

  it('a waiver bound to the current version turns a fail into waived', () => {
    const checks = evaluateReleaseGates(
      facts({
        manifest: {
          version: 2,
          digest: 'sha256:x',
          items: [
            {
              item_kind: 'ticket',
              item_id: 'SR-0001',
              repos: [{ repo: 'api', ticket: 'SR-0001', merged_sha: null }],
            },
          ],
        },
        members: [{ ticket_id: 'SR-0001', status: 'merged' }],
        waived: ['merged'],
      }),
    );
    const merged = checks.find((c) => c.gate === 'merged');
    expect(merged?.verdict).toBe('waived');
    expect(releaseGatesGreen(checks)).toBe(true);
  });
});

describe('canonicalManifestItems', () => {
  it('sorts items + repos and drops empty partial_ac', () => {
    const out = canonicalManifestItems([{ ...ITEM_B, partial_ac: [] }, ITEM_A]);
    // 'feature' < 'ticket' — the feature item sorts first.
    expect(out.map((i) => i.item_id)).toEqual(['F-0001', 'SR-0001']);
    expect(out[0]?.repos.map((r) => r.repo)).toEqual(['api', 'web']);
    expect(out[0]?.partial_ac).toBeUndefined();
  });
});
