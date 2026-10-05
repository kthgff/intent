/**
 * wp-150 tests — the security review dimension (PRD §15.8).
 *
 * Real PostgresStore on PGlite; the engine functions are exercised
 * directly (the API layer is a thin shell over the same calls). Covers:
 *   - risk-tiered enforcement policy + severity → tier mapping;
 *   - security finding field completeness (fail-closed) + classification;
 *   - the gate: critical blocks merge AND release; resolved clears;
 *     an active owner+expiry exception unblocks; malformed fails closed;
 *   - exceptions: human-only, owner+expiry+rationale required, expiring
 *     LOUDLY (quality_debt security-exception + status flip + event);
 *   - design-time security gate on sensitive scope (threat model);
 *   - scanner results → findings (secrets never copied; errors fail
 *     closed — never a silent pass/fail);
 *   - the review approve path refuses to clear the gate (wp-148 wiring).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QualityDebtRow, ReviewFindingRow } from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeSecurityExceptions,
  classifySecurityCategory,
  deriveSecurityFields,
  designSecurityGate,
  enforcementFor,
  expireSecurityExceptions,
  findingsFromScanner,
  grantSecurityException,
  isSecurityFinding,
  listSecurityExceptions,
  revokeSecurityException,
  riskTierForSeverity,
  scannerGate,
  securityFieldReasons,
  securityGate,
  sensitiveScopeReasons,
  threatModelPresent,
} from '../src/review/index.js';
import {
  ensureSession,
  recordDecision,
  recordRevision,
  upsertFinding,
} from '../src/review/studio/index.js';
import type { StudioCtx } from '../src/review/studio/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let dir: string;
let store: PostgresStore;
let clock: number;

function ctx(): StudioCtx {
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
  dir = mkdtempSync(join(tmpdir(), 'sr-sec-'));
  store = await PostgresStore.connect('pglite:');
  clock = T0;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function findingRow(
  over: Partial<ReviewFindingRow> & { finding_id: string },
): ReviewFindingRow {
  return {
    workspace: WS,
    org: null,
    review_id: 'rv-SR-0001',
    revision: 1,
    subject: null,
    status: 'open',
    severity: 'blocker',
    category: 'security',
    kind: 'code-bug',
    thread_id: 'f-aaaa',
    file: 'src/auth.ts',
    line: 10,
    symbol: null,
    repo: 'code-repo',
    body: 'unauthenticated admin endpoint',
    evidence: 'app.get(/admin)',
    suggested_fix: null,
    confidence: 0.9,
    blocking: false,
    security_category: 'access-control',
    affected_asset: 'GET /admin',
    exposure: 'internet',
    policy_violated: 'authz-required',
    author: 'security-pass',
    created_at: null,
    updated_at: null,
    ...over,
  };
}

async function seedSession(subject = 'SR-0001'): Promise<string> {
  const s = await ensureSession(ctx(), { subject });
  return s.review_id;
}

// ---------------------------------------------------------------------------
// risk tiers + enforcement (pure)
// ---------------------------------------------------------------------------

describe('risk-tiered enforcement', () => {
  it('maps severity → tier (blocker is critical)', () => {
    expect(riskTierForSeverity('blocker')).toBe('critical');
    expect(riskTierForSeverity('major')).toBe('high');
    expect(riskTierForSeverity('minor')).toBe('medium');
    expect(riskTierForSeverity('nit')).toBe('low');
    expect(riskTierForSeverity('question')).toBe('low');
    expect(riskTierForSeverity(null)).toBe('low');
  });

  it('low → baseline scans; high → dedicated analysis; critical blocks', () => {
    const low = enforcementFor('low');
    expect(low.baseline_scans).toBe(true);
    expect(low.dedicated_analysis).toBe(false);
    expect(low.blocks_merge).toBe(false);

    const high = enforcementFor('high');
    expect(high.dedicated_analysis).toBe(true);
    expect(high.designated_reviewer).toBe(true);
    expect(high.blocks_merge).toBe(false);

    const critical = enforcementFor('critical');
    expect(critical.blocks_merge).toBe(true);
    expect(critical.blocks_release).toBe(true);
    expect(critical.exception_allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// field completeness + classification (pure)
// ---------------------------------------------------------------------------

describe('security finding fields', () => {
  it('detects security findings by category or security_category', () => {
    expect(isSecurityFinding({ category: 'security', security_category: null })).toBe(true);
    expect(
      isSecurityFinding({ category: 'correctness', security_category: 'secrets' }),
    ).toBe(true);
    expect(
      isSecurityFinding({ category: 'correctness', security_category: null }),
    ).toBe(false);
  });

  it('flags a security finding missing its field set (fail-closed)', () => {
    expect(
      securityFieldReasons({
        category: 'security',
        security_category: 'secrets',
        affected_asset: 'src/config.ts',
      }),
    ).toEqual([]);
    expect(
      securityFieldReasons({
        category: 'security',
        security_category: null,
        affected_asset: null,
      }),
    ).toEqual(['missing security_category', 'missing affected_asset']);
    // Non-security findings are never flagged.
    expect(
      securityFieldReasons({
        category: 'correctness',
        security_category: null,
        affected_asset: null,
      }),
    ).toEqual([]);
  });

  it('classifies free text into the taxonomy', () => {
    expect(classifySecurityCategory('SQL injection in the query builder')).toBe(
      'injection',
    );
    expect(classifySecurityCategory('hardcoded API key in config')).toBe(
      'secrets',
    );
    expect(classifySecurityCategory('missing ownership check → IDOR')).toBe(
      'access-control',
    );
    expect(classifySecurityCategory('logs the user PII')).toBe('data-exposure');
    expect(classifySecurityCategory('outdated dependency with a CVE')).toBe(
      'unsafe-deps',
    );
    expect(classifySecurityCategory('no obvious issue here')).toBeNull();
  });

  it('derives the field set from a review.json finding (SCHEMAS §6 unchanged)', () => {
    const derived = deriveSecurityFields({
      file: 'src/db.ts',
      body: 'string-concatenated SQL → injection',
    });
    expect(derived.security_category).toBe('injection');
    expect(derived.affected_asset).toBe('src/db.ts');
    expect(derived.exposure).toBeNull();
    // An explicit category wins; an unknown one falls back to text.
    expect(
      deriveSecurityFields({
        security_category: 'secrets',
        file: 'x',
        body: 'sql injection',
      }).security_category,
    ).toBe('secrets');
  });
});

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

describe('securityGate', () => {
  it('is clear when there are no security findings', async () => {
    const reviewId = await seedSession();
    await upsertFinding(
      ctx(),
      findingRow({
        finding_id: 'f-correct',
        category: 'correctness',
        security_category: null,
        affected_asset: null,
        severity: 'blocker',
      }),
    );
    const gate = await securityGate(ctx(), { reviewId });
    expect(gate.blocked).toBe(false);
    expect(gate.tier).toBe('low');
  });

  it('blocks merge AND release on an unresolved critical finding', async () => {
    const reviewId = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-crit' }));
    const merge = await securityGate(ctx(), { reviewId, phase: 'merge' });
    expect(merge.blocked).toBe(true);
    expect(merge.tier).toBe('critical');
    expect(merge.blocking_findings).toEqual(['f-crit']);
    expect(merge.reasons.join(' ')).toContain('block merge');

    const release = await securityGate(ctx(), { reviewId, phase: 'release' });
    expect(release.blocked).toBe(true);
  });

  it('a resolved critical finding no longer blocks', async () => {
    const reviewId = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-crit' }));
    await store.upsertReviewFinding({
      ...(await store.getReviewFinding({
        workspace: WS,
        finding_id: 'f-crit',
      }))!,
      status: 'resolved',
    });
    const gate = await securityGate(ctx(), { reviewId });
    expect(gate.blocked).toBe(false);
  });

  it('fails CLOSED on a malformed security finding', async () => {
    const reviewId = await seedSession();
    await upsertFinding(
      ctx(),
      findingRow({
        finding_id: 'f-malformed',
        severity: 'minor',
        security_category: null,
        affected_asset: null,
      }),
    );
    const gate = await securityGate(ctx(), { reviewId });
    expect(gate.blocked).toBe(true);
    expect(gate.malformed_findings).toEqual(['f-malformed']);
  });

  it('high tier does not block but requires a designated reviewer', async () => {
    const reviewId = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-high', severity: 'major' }));
    const gate = await securityGate(ctx(), { reviewId });
    expect(gate.blocked).toBe(false);
    expect(gate.tier).toBe('high');
    expect(gate.enforcement.designated_reviewer).toBe(true);
    expect(gate.reasons.join(' ')).toContain('designated reviewer');
  });
});

// ---------------------------------------------------------------------------
// exceptions — human-only, owner + expiry + rationale, expiring loudly
// ---------------------------------------------------------------------------

describe('security exceptions', () => {
  it('an agent may NEVER waive a blocking security finding', async () => {
    const reviewId = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-crit' }));
    await expect(
      grantSecurityException(ctx(), {
        reviewId,
        findingId: 'f-crit',
        owner: 'keith',
        expiresAt: new Date(clock + 86_400_000).toISOString(),
        rationale: 'temporary',
        actor: 'fix-bot',
        actorKind: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Nothing was written.
    expect(await listSecurityExceptions(ctx(), { reviewId })).toHaveLength(0);
  });

  it('requires owner + future expiry + rationale', async () => {
    const reviewId = await seedSession();
    const base = {
      reviewId,
      findingId: 'f-crit',
      actor: 'keith',
      actorKind: 'human' as const,
    };
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-crit' }));
    await expect(
      grantSecurityException(ctx(), { ...base, owner: '', expiresAt: '2999-01-01T00:00:00Z', rationale: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid-transition' });
    await expect(
      grantSecurityException(ctx(), { ...base, owner: 'keith', expiresAt: 'nope', rationale: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid-transition' });
    await expect(
      grantSecurityException(ctx(), { ...base, owner: 'keith', expiresAt: '2999-01-01T00:00:00Z', rationale: '  ' }),
    ).rejects.toMatchObject({ code: 'invalid-transition' });
    await expect(
      grantSecurityException(ctx(), {
        ...base,
        owner: 'keith',
        expiresAt: new Date(clock - 1000).toISOString(),
        rationale: 'past',
      }),
    ).rejects.toMatchObject({ code: 'invalid-transition' });
  });

  it('a human grant writes a quality_debt security-exception and unblocks the gate', async () => {
    const reviewId = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-crit' }));
    expect((await securityGate(ctx(), { reviewId })).blocked).toBe(true);

    const expiresAt = new Date(clock + 7 * 86_400_000).toISOString();
    const debt = await grantSecurityException(ctx(), {
      reviewId,
      findingId: 'f-crit',
      owner: 'keith',
      expiresAt,
      rationale: 'behind the VPN for one sprint',
      actor: 'keith',
      actorKind: 'human',
    });
    expect(debt.kind).toBe('security-exception');
    expect(debt.owner).toBe('keith');
    expect(debt.expires_at).toBe(expiresAt);
    expect(debt.approved_by).toBe('keith');
    expect(debt.status).toBe('acknowledged');

    const gate = await securityGate(ctx(), { reviewId });
    expect(gate.blocked).toBe(false);
    expect(gate.active_exceptions).toEqual([debt.debt_id]);

    // The audit event is present.
    const events = await store.listEvents({ workspace: WS, ticket_id: 'SR-0001' });
    expect(
      events.some(
        (e) => e.data?.reason === 'security-exception' && e.data?.finding_id === 'f-crit',
      ),
    ).toBe(true);
  });

  it('exceptions EXPIRE LOUDLY — the gate re-blocks after expiry', async () => {
    const reviewId = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-crit' }));
    const debt = await grantSecurityException(ctx(), {
      reviewId,
      findingId: 'f-crit',
      owner: 'keith',
      expiresAt: new Date(clock + 60_000).toISOString(),
      rationale: 'short window',
      actor: 'keith',
    });
    expect((await securityGate(ctx(), { reviewId })).blocked).toBe(false);

    // Time passes beyond the expiry.
    tick(120_000);
    const expired = await expireSecurityExceptions(ctx(), { reviewId });
    expect(expired.map((d) => d.debt_id)).toEqual([debt.debt_id]);
    expect(expired[0]?.status).toBe('expired');

    const persisted: QualityDebtRow | null = await store.getQualityDebt({
      workspace: WS,
      debt_id: debt.debt_id,
    });
    expect(persisted?.status).toBe('expired');

    // Expiry is loud + audited, and the finding blocks again.
    const events = await store.listEvents({ workspace: WS, ticket_id: 'SR-0001' });
    expect(
      events.some((e) => e.data?.reason === 'security-exception-expired'),
    ).toBe(true);
    expect((await securityGate(ctx(), { reviewId })).blocked).toBe(true);
    // Re-running expiry is a no-op.
    expect(await expireSecurityExceptions(ctx(), { reviewId })).toHaveLength(0);
  });

  it('revocation is human-only and settles the debt', async () => {
    const reviewId = await seedSession();
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-crit' }));
    await grantSecurityException(ctx(), {
      reviewId,
      findingId: 'f-crit',
      owner: 'keith',
      expiresAt: new Date(clock + 86_400_000).toISOString(),
      rationale: 'temp',
      actor: 'keith',
    });
    await expect(
      revokeSecurityException(ctx(), {
        reviewId,
        findingId: 'f-crit',
        actor: 'bot',
        actorKind: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const revoked = await revokeSecurityException(ctx(), {
      reviewId,
      findingId: 'f-crit',
      actor: 'keith',
    });
    expect(revoked.status).toBe('resolved');
    expect((await securityGate(ctx(), { reviewId })).blocked).toBe(true);
    expect(await activeSecurityExceptions(ctx(), { reviewId })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// design-time security gate
// ---------------------------------------------------------------------------

describe('designSecurityGate', () => {
  it('fires on sensitive scope with no threat model', () => {
    const reasons = sensitiveScopeReasons(['src/auth/login.ts']);
    expect(reasons).toContain('authentication/authorization');
    const gate = designSecurityGate({ files: ['src/auth/login.ts'], tddMd: '# TDD\n## Architecture\n' });
    expect(gate.required).toBe(true);
    expect(gate.satisfied).toBe(false);
    expect(gate.blocked).toBe(true);
    expect(gate.reasons.join(' ')).toContain('Threat model');
  });

  it('passes when the TDD carries a threat-model section', () => {
    const tdd = '# TDD\n## Architecture\n## Threat model\nassets: session tokens\n';
    expect(threatModelPresent(tdd)).toBe(true);
    const gate = designSecurityGate({ files: ['src/billing/checkout.ts'], tddMd: tdd });
    expect(gate.required).toBe(true);
    expect(gate.blocked).toBe(false);
  });

  it('does not fire on a non-sensitive change', () => {
    const gate = designSecurityGate({ files: ['docs/readme.md'], tddMd: '' });
    expect(gate.required).toBe(false);
    expect(gate.blocked).toBe(false);
    expect(threatModelPresent(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanner results → findings (never a silent pass/fail)
// ---------------------------------------------------------------------------

describe('scanner mapping', () => {
  it('maps gitleaks findings and never copies the secret', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const { blocked, findings } = scannerGate(
      {
        scanner: 'gitleaks',
        ok: true,
        findings: [
          {
            RuleID: 'aws-access-token',
            Description: 'AWS Access Token',
            File: 'src/config.ts',
            StartLine: 12,
            Secret: secret,
            Match: `key = "${secret}"`,
          },
        ],
      },
      { repo: 'code-repo' },
    );
    expect(blocked).toBe(false);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.category).toBe('security');
    expect(f.severity).toBe('blocker');
    expect(f.file).toBe('src/config.ts');
    expect(f.line).toBe(12);
    expect(f.evidence).toContain('src/config.ts:12');
    // Secrets never enter the finding.
    expect(f.body).not.toContain(secret);
    expect(f.evidence ?? '').not.toContain(secret);
    // …and the derived field set is complete.
    expect(deriveSecurityFields(f).security_category).toBe('secrets');
    expect(findingsFromScanner({ scanner: 'gitleaks', ok: true, findings: [] })).toEqual([]);
  });

  it('maps trufflehog findings (nested source metadata)', () => {
    const findings = findingsFromScanner({
      scanner: 'trufflehog',
      ok: true,
      findings: [
        {
          DetectorName: 'PrivateKey',
          Verified: true,
          Raw: '-----BEGIN PRIVATE KEY-----',
          SourceMetadata: { Data: { Filesystem: { file: 'deploy/key.pem', line: 3 } } },
        },
      ],
    });
    expect(findings[0]?.file).toBe('deploy/key.pem');
    expect(findings[0]?.line).toBe(3);
    expect(findings[0]?.confidence).toBe(0.95);
  });

  it('fails CLOSED on a scanner error or malformed output', () => {
    const errored = scannerGate({ scanner: 'gitleaks', ok: false, error: 'command not found' });
    expect(errored.blocked).toBe(true);
    expect(errored.reasons.join(' ')).toContain('fail-closed');
    expect(errored.findings).toEqual([]);

    const malformed = scannerGate({
      scanner: 'gitleaks',
      ok: true,
      findings: { not: 'an array' },
    });
    expect(malformed.blocked).toBe(true);

    // A clean scan is a legitimate, non-blocking pass.
    expect(scannerGate({ scanner: 'gitleaks', ok: true, findings: [] }).blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// approve-path wiring (wp-148 decision engine)
// ---------------------------------------------------------------------------

describe('review approve path', () => {
  it('refuses to approve while an unresolved critical security finding stands', async () => {
    const reviewId = await seedSession();
    await recordRevision(ctx(), {
      reviewId,
      headSha: 'sha-a',
      baseline: null,
    });
    await upsertFinding(ctx(), findingRow({ finding_id: 'f-crit' }));

    await expect(
      recordDecision(ctx(), {
        reviewId,
        decisionId: 'd-1',
        reviewer: 'keith',
        action: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // A granted exception lets the approval through.
    await grantSecurityException(ctx(), {
      reviewId,
      findingId: 'f-crit',
      owner: 'keith',
      expiresAt: new Date(clock + 86_400_000).toISOString(),
      rationale: 'accepted for the beta window',
      actor: 'keith',
    });
    const { session } = await recordDecision(ctx(), {
      reviewId,
      decisionId: 'd-2',
      reviewer: 'keith',
      action: 'approve',
    });
    expect(session.status).toBe('approved');
  });
});
