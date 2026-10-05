import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/index.js';

let dir: string;
let store: PostgresStore;
const WS = 'ws1';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-c3-'));
  store = await PostgresStore.connect('pglite:');
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('delivery — releases', () => {
  it('release lifecycle: upsert → items → manifest → approvals → gates', async () => {
    await store.upsertRelease({
      workspace: WS,
      release_id: 'REL-0001',
      title: 'v1.0',
      status: 'draft',
      created_at: '2026-10-05T00:00:00Z',
    });
    await store.upsertReleaseItem({
      workspace: WS,
      release_id: 'REL-0001',
      item_kind: 'ticket',
      item_id: 'SR-0001',
      added_at: '2026-10-05T00:05:00Z',
    });
    await store.upsertReleaseItem({
      workspace: WS,
      release_id: 'REL-0001',
      item_kind: 'feature',
      item_id: 'F-0002',
      partial_ac: ['AC-1'],
      approved_by: 'keith',
      added_at: '2026-10-05T00:06:00Z',
    });
    const items = await store.listReleaseItems({
      workspace: WS,
      release_id: 'REL-0001',
    });
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.item_id === 'F-0002')?.partial_ac).toEqual([
      'AC-1',
    ]);

    await store.removeReleaseItem(
      {
        workspace: WS,
        release_id: 'REL-0001',
        item_kind: 'feature',
        item_id: 'F-0002',
      },
      '2026-10-05T00:10:00Z',
    );
    expect(
      await store.listReleaseItems({ workspace: WS, release_id: 'REL-0001' }),
    ).toHaveLength(1);

    // Manifest v1 then v2 — versions append, never mutate.
    await store.appendReleaseManifest({
      workspace: WS,
      release_id: 'REL-0001',
      version: 1,
      digest: 'sha256:aaa',
      items: [{ item_kind: 'ticket', item_id: 'SR-0001', repos: [] }],
      created_at: '2026-10-05T01:00:00Z',
    });
    await store.appendReleaseManifest({
      workspace: WS,
      release_id: 'REL-0001',
      version: 2,
      digest: 'sha256:bbb',
      items: [
        {
          item_kind: 'ticket',
          item_id: 'SR-0001',
          repos: [{ repo: 'r', merged_sha: 'x' }],
        },
      ],
      created_at: '2026-10-05T02:00:00Z',
    });
    const head = await store.getReleaseManifest({
      workspace: WS,
      release_id: 'REL-0001',
    });
    expect(head?.version).toBe(2);
    expect(
      await store.listReleaseManifests({
        workspace: WS,
        release_id: 'REL-0001',
      }),
    ).toHaveLength(2);

    // Immutability trigger (0002) — UPDATE on a manifest throws.
    await expect(
      store.db.query(
        `UPDATE release_manifests SET digest='x'
         WHERE workspace=$1 AND release_id=$2 AND version=1`,
        [WS, 'REL-0001'],
      ),
    ).rejects.toThrow();

    // Approvals are append-only and bind to a manifest version.
    await store.appendReleaseApproval({
      workspace: WS,
      release_id: 'REL-0001',
      manifest_version: 2,
      approver: 'keith',
      decision: 'approved',
      created_at: '2026-10-05T03:00:00Z',
    });
    expect(
      await store.listReleaseApprovals({
        workspace: WS,
        release_id: 'REL-0001',
      }),
    ).toHaveLength(1);

    const gateId = await store.appendReleaseGateResult({
      workspace: WS,
      release_id: 'REL-0001',
      gate: 'tests-green',
      result: 'pass',
      checked_at: '2026-10-05T03:30:00Z',
    });
    expect(gateId).toBeGreaterThan(0);
    expect(
      (
        await store.listReleaseGateResults({
          workspace: WS,
          release_id: 'REL-0001',
        })
      )[0]?.gate,
    ).toBe('tests-green');

    await store.upsertRelease({
      workspace: WS,
      release_id: 'REL-0001',
      title: 'v1.0',
      status: 'approved',
      updated_at: '2026-10-05T04:00:00Z',
    });
    expect(
      (await store.getRelease({ workspace: WS, release_id: 'REL-0001' }))
        ?.status,
    ).toBe('approved');
  });

  it('deployments + feature exposure + outcomes + notes', async () => {
    await store.insertDeployment({
      workspace: WS,
      deployment_id: 'dep-1',
      release_id: 'REL-0001',
      environment: 'prod',
      sha: 'abc123',
      evidence: { type: 'manual', by: 'ops', note: 'deployed by ops' },
      created_at: '2026-10-05T05:00:00Z',
    });
    expect(
      (await store.listDeployments({ workspace: WS }))[0]?.confirmed_by,
    ).toBeNull();
    await store.confirmDeployment(
      { workspace: WS, deployment_id: 'dep-1' },
      'keith',
      '2026-10-05T05:30:00Z',
    );
    expect(
      (await store.listDeployments({ workspace: WS }))[0]?.confirmed_by,
    ).toBe('keith');

    await store.upsertFeatureExposure({
      workspace: WS,
      feature_id: 'F-0001',
      environment: 'prod',
      state: 'available',
      deployment_id: 'dep-1',
      updated_at: '2026-10-05T06:00:00Z',
    });
    const exp = await store.getFeatureExposure({
      workspace: WS,
      feature_id: 'F-0001',
      environment: 'prod',
    });
    expect(exp?.state).toBe('available');
    expect(exp?.deployment_id).toBe('dep-1');

    await store.upsertReleaseOutcome({
      workspace: WS,
      release_id: 'REL-0001',
      kpi: 'password-reset-resolution-days',
      data: { baseline: 3, target: 0.5, observed: 0.4, unit: 'days' },
      measured_at: '2026-10-05T07:00:00Z',
    });
    expect(
      (
        await store.listReleaseOutcomes({
          workspace: WS,
          release_id: 'REL-0001',
        })
      )[0]?.data.observed,
    ).toBe(0.4);

    await store.upsertReleaseNote({
      workspace: WS,
      release_id: 'REL-0001',
      audience: 'customer',
      doc_version: 3,
      published_at: '2026-10-05T06:30:00Z',
    });
    expect(
      (
        await store.getReleaseNote({
          workspace: WS,
          release_id: 'REL-0001',
          audience: 'customer',
        })
      )?.doc_version,
    ).toBe(3);
  });
});

describe('changesets', () => {
  it('upsert + items + decision lifecycle', async () => {
    await store.upsertChangeset({
      workspace: WS,
      changeset_id: 'CS-1',
      title: 'Add OAuth requirement',
      request: 'Also support OAuth login',
      status: 'draft',
      created_by: 'reviewer',
      created_at: '2026-10-05T00:00:00Z',
    });
    await store.upsertChangesetItem({
      workspace: WS,
      changeset_id: 'CS-1',
      seq: 1,
      subject: 'SR-0001',
      doc: 'rs.md',
      base_version: 3,
      status: 'pending',
    });
    expect(
      await store.listChangesetItems({ workspace: WS, changeset_id: 'CS-1' }),
    ).toHaveLength(1);
    await store.upsertChangeset({
      workspace: WS,
      changeset_id: 'CS-1',
      request: 'Also support OAuth login',
      status: 'approved',
      decision: 'add-now',
      decided_by: 'keith',
      decided_at: '2026-10-05T01:00:00Z',
    });
    const cs = await store.getChangeset({
      workspace: WS,
      changeset_id: 'CS-1',
    });
    expect(cs?.status).toBe('approved');
    expect(cs?.decision).toBe('add-now');
    expect(
      await store.listChangesets({ workspace: WS, status: 'approved' }),
    ).toHaveLength(1);
  });
});

describe('statement ledger', () => {
  it('upsertStatement versions append-only; head wins', async () => {
    const base = {
      workspace: WS,
      statement_id: 'ST-1',
      text: 'The system shall reset passwords in <5 min',
      intent: 'requires' as const,
      status: 'proposed' as const,
      confidence: 0.9,
      created_by: 'extractor',
      created_at: '2026-10-05T00:00:00Z',
    };
    const v1 = await store.upsertStatement(base);
    expect(v1.version).toBe(1);
    const v2 = await store.upsertStatement({
      ...base,
      text: 'The system shall reset passwords in <1 min',
      status: 'confirmed',
      updated_at: '2026-10-05T01:00:00Z',
    });
    expect(v2.version).toBe(2);

    const head = await store.getStatement({
      workspace: WS,
      statement_id: 'ST-1',
    });
    expect(head?.text).toBe('The system shall reset passwords in <1 min');
    expect(head?.version).toBe(2);
    const versions = await store.listStatementVersions({
      workspace: WS,
      statement_id: 'ST-1',
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    // statement_versions is append-only at the DB layer.
    await expect(
      store.db.query(
        `UPDATE statement_versions SET text='x'
         WHERE workspace=$1 AND statement_id=$2 AND version=1`,
        [WS, 'ST-1'],
      ),
    ).rejects.toThrow();

    // Relations (src/predicate/dst).
    await store.upsertStatement({
      workspace: WS,
      statement_id: 'ST-2',
      text: 'Password resets currently take 3 days',
      intent: 'problem',
      status: 'confirmed',
    });
    await store.upsertStatementRelation({
      workspace: WS,
      src: 'ST-2',
      predicate: 'supports',
      dst: 'ST-1',
      created_by: 'extractor',
    });
    expect(
      await store.listStatementRelations({ workspace: WS, src: 'ST-2' }),
    ).toHaveLength(1);
    await store.deleteStatementRelation({
      workspace: WS,
      src: 'ST-2',
      predicate: 'supports',
      dst: 'ST-1',
    });
    expect(
      await store.listStatementRelations({ workspace: WS, src: 'ST-2' }),
    ).toHaveLength(0);

    // Clarifications.
    await store.upsertStatementClarification({
      workspace: WS,
      clarification_id: 'cl-1',
      statement_id: 'ST-1',
      question: 'which auth provider?',
      answer: 'oauth2',
      asked_by: 'agent',
      answered_by: 'keith',
      answered_at: '2026-10-05T02:00:00Z',
    });
    expect(
      await store.listStatementClarifications({
        workspace: WS,
        statement_id: 'ST-1',
      }),
    ).toHaveLength(1);

    // Decisions.
    await store.upsertStatementDecision({
      workspace: WS,
      decision_id: 'sd-1',
      statement_id: 'ST-1',
      decision: 'ratified — keep <1 min target',
      status: 'decided',
      decided_by: 'keith',
      decided_at: '2026-10-05T03:00:00Z',
    });
    expect(
      (await store.getStatementDecision({ workspace: WS, decision_id: 'sd-1' }))
        ?.status,
    ).toBe('decided');

    // Artifact links.
    await store.upsertStatementArtifactLink({
      workspace: WS,
      statement_id: 'ST-1',
      artifact: 'SR-0001:rs.md',
      element: 'ac:AC-3',
    });
    expect(
      await store.listStatementArtifactLinks({
        workspace: WS,
        statement_id: 'ST-1',
      }),
    ).toHaveLength(1);
    await store.deleteStatementArtifactLink({
      workspace: WS,
      statement_id: 'ST-1',
      artifact: 'SR-0001:rs.md',
      element: 'ac:AC-3',
    });
    expect(
      await store.listStatementArtifactLinks({
        workspace: WS,
        statement_id: 'ST-1',
      }),
    ).toHaveLength(0);

    // Extraction provenance.
    await store.insertExtractionRun({
      workspace: WS,
      extraction_run_id: 'xr-1',
      subject: 'board:ws1/ideas',
      model: 'anthropic/claude-sonnet-4',
      prompt_version: 'extract-v2',
      stats: { statements: 2 },
      created_at: '2026-10-05T04:00:00Z',
    });
    expect(
      (
        await store.getExtractionRun({
          workspace: WS,
          extraction_run_id: 'xr-1',
        })
      )?.stats,
    ).toEqual({ statements: 2 });
  });
});

describe('interview orchestrator', () => {
  it('sessions, branches, messages (auto-seq), slots, snapshots', async () => {
    await store.upsertWizardDefinition({
      workspace: WS,
      wizard_id: 'wz-1',
      name: 'Solution discovery',
      current_version: 1,
    });
    await store.appendWizardVersion({
      workspace: WS,
      wizard_id: 'wz-1',
      version: 1,
      definition: { slots: [{ slot: 'problem', required: true }] },
      created_at: '2026-10-05T00:00:00Z',
    });
    expect(
      (await store.getWizardVersion({ workspace: WS, wizard_id: 'wz-1' }, 1))
        ?.definition,
    ).toEqual({ slots: [{ slot: 'problem', required: true }] });

    await store.upsertInterviewSession({
      workspace: WS,
      session_id: 'iv-1',
      wizard_id: 'wz-1',
      wizard_version: 1,
      subject: 'SR-0001',
      mode: 'conversation',
      status: 'active',
      created_at: '2026-10-05T01:00:00Z',
    });
    await store.upsertInterviewBranch({
      workspace: WS,
      session_id: 'iv-1',
      branch: 'security',
      role: 'security-officer',
      status: 'active',
    });
    expect(
      await store.listInterviewBranches({ workspace: WS, session_id: 'iv-1' }),
    ).toHaveLength(1);

    // appendInterviewMessage auto-allocates seq, returns the number.
    const s1 = await store.appendInterviewMessage({
      workspace: WS,
      session_id: 'iv-1',
      branch: 'main',
      role: 'assistant',
      content: 'What problem are we solving?',
      created_at: '2026-10-05T01:01:00Z',
    });
    const s2 = await store.appendInterviewMessage({
      workspace: WS,
      session_id: 'iv-1',
      branch: 'main',
      role: 'user',
      content: 'Password resets take 3 days.',
      created_at: '2026-10-05T01:02:00Z',
    });
    expect([s1, s2]).toEqual([1, 2]);
    // Incremental read: only rows with seq > 1.
    expect(
      await store.listInterviewMessages({
        workspace: WS,
        session_id: 'iv-1',
        after: 1,
      }),
    ).toHaveLength(1);

    await store.upsertKnowledgeSlot({
      workspace: WS,
      session_id: 'iv-1',
      slot: 'problem',
      state: 'known',
      value: 'Password resets take 3 days',
      statement_refs: ['ST-2'],
      confidence: 0.95,
      updated_at: '2026-10-05T01:02:00Z',
    });
    const slot = await store.getKnowledgeSlot({
      workspace: WS,
      session_id: 'iv-1',
      slot: 'problem',
    });
    expect(slot?.state).toBe('known');
    expect(slot?.statement_refs).toEqual(['ST-2']);

    await store.upsertQuestionCandidate({
      workspace: WS,
      session_id: 'iv-1',
      question_id: 'q-1',
      slot: 'constraints',
      question: 'Any compliance constraints?',
      scores: { impact: 0.8, uncertainty: 0.6 },
      status: 'proposed',
    });
    expect(
      await store.listQuestionCandidates({ workspace: WS, session_id: 'iv-1' }),
    ).toHaveLength(1);

    await store.appendSessionSnapshot({
      workspace: WS,
      session_id: 'iv-1',
      version: 1,
      snapshot: { filled: ['problem'], pending: ['constraints'] },
      reason: 'checkpoint',
      created_at: '2026-10-05T01:05:00Z',
    });
    expect(
      (await store.getSessionSnapshot({ workspace: WS, session_id: 'iv-1' }))
        ?.snapshot,
    ).toEqual({ filled: ['problem'], pending: ['constraints'] });
  });
});

describe('review studio', () => {
  it('sessions → revisions → findings → decisions → resolutions', async () => {
    await store.upsertReviewSession({
      workspace: WS,
      review_id: 'rv-1',
      subject: 'SR-0001',
      status: 'open',
      created_by: 'keith',
      created_at: '2026-10-05T00:00:00Z',
    });
    await store.appendReviewRevision({
      workspace: WS,
      review_id: 'rv-1',
      revision: 1,
      head_sha: 'abc123',
      baseline: { rs_version: 3, ac_ids: ['AC-1'] },
      created_at: '2026-10-05T00:10:00Z',
    });
    expect(
      (await store.getReviewRevision({ workspace: WS, review_id: 'rv-1' }))
        ?.revision,
    ).toBe(1);

    await store.upsertReviewFinding({
      workspace: WS,
      finding_id: 'fd-1',
      review_id: 'rv-1',
      revision: 1,
      status: 'open',
      severity: 'major',
      category: 'correctness',
      kind: 'code-bug',
      body: 'Missing null check',
      blocking: true,
      author: 'reviewer-agent',
      created_at: '2026-10-05T00:20:00Z',
    });
    const f = await store.getReviewFinding({
      workspace: WS,
      finding_id: 'fd-1',
    });
    expect(f?.blocking).toBe(true);
    expect(f?.severity).toBe('major');

    await store.appendFindingResolution({
      workspace: WS,
      finding_id: 'fd-1',
      seq: 1,
      status: 'triaged',
      actor: 'keith',
      created_at: '2026-10-05T00:30:00Z',
    });
    // finding_resolutions is append-only.
    await expect(
      store.db.query(
        'DELETE FROM finding_resolutions WHERE workspace=$1 AND finding_id=$2',
        [WS, 'fd-1'],
      ),
    ).rejects.toThrow();

    await store.upsertReviewComment({
      workspace: WS,
      comment_id: 'cm-1',
      review_id: 'rv-1',
      revision: 1,
      type: 'out-of-scope',
      body: 'This should be a separate ticket',
      author: 'keith',
      changeset_id: 'CS-1',
      created_at: '2026-10-05T00:25:00Z',
    });
    expect(
      (await store.listReviewComments({ workspace: WS, review_id: 'rv-1' }))[0]
        ?.changeset_id,
    ).toBe('CS-1');

    await store.appendReviewDecision({
      workspace: WS,
      decision_id: 'rd-1',
      review_id: 'rv-1',
      revision: 1,
      reviewer: 'keith',
      action: 'approve',
      head_sha: 'abc123',
      created_at: '2026-10-05T00:40:00Z',
    });
    expect(
      await store.listReviewDecisions({ workspace: WS, review_id: 'rv-1' }),
    ).toHaveLength(1);

    // Evidence links idempotent on PK.
    const link = {
      workspace: WS,
      review_id: 'rv-1',
      finding_id: 'fd-1',
      evidence_ref: 'run:ws1/r1/tests',
      kind: 'test',
    };
    await store.insertReviewEvidenceLink(link);
    await store.insertReviewEvidenceLink(link);
    expect(
      await store.listReviewEvidenceLinks({ workspace: WS, review_id: 'rv-1' }),
    ).toHaveLength(1);

    await store.upsertExternalReviewMapping({
      workspace: WS,
      review_id: 'rv-1',
      finding_id: 'fd-1',
      external_kind: 'github-pr-review',
      external_id: 'PRR_abc',
    });
    expect(
      await store.listExternalReviewMappings({
        workspace: WS,
        review_id: 'rv-1',
      }),
    ).toHaveLength(1);

    await store.upsertDesignApproval({
      workspace: WS,
      approval_id: 'da-1',
      subject: 'F-0001',
      doc: 'mockup.json',
      doc_version: 2,
      checklist: { desktop: true, mobile: true },
      covers: ['AC-1', 'AC-2'],
      reviewer: 'keith',
      status: 'approved',
      created_at: '2026-10-05T01:00:00Z',
    });
    const da = await store.getDesignApproval({
      workspace: WS,
      approval_id: 'da-1',
    });
    expect(da?.status).toBe('approved');
    expect(da?.covers).toEqual(['AC-1', 'AC-2']);
  });
});

describe('process machinery', () => {
  it('assumptions, quality debt, versioned commitments', async () => {
    await store.upsertAssumption({
      workspace: WS,
      assumption_id: 'as-1',
      statement: 'Users have email access',
      impact: 'high',
      status: 'unverified',
      source: 'run:ws1/r1:design',
      created_at: '2026-10-05T00:00:00Z',
    });
    expect(
      (await store.listAssumptions({ workspace: WS, status: 'unverified' }))[0]
        ?.impact,
    ).toBe('high');

    await store.upsertQualityDebt({
      workspace: WS,
      debt_id: 'qd-1',
      kind: 'deferred-refactor',
      title: 'N+1 in board list',
      owner: 'keith',
      status: 'open',
      created_at: '2026-10-05T00:00:00Z',
    });
    expect(
      (await store.getQualityDebt({ workspace: WS, debt_id: 'qd-1' }))?.kind,
    ).toBe('deferred-refactor');

    // commitDeliveryCommitment allocates versions transactionally.
    const c1 = await store.commitDeliveryCommitment({
      workspace: WS,
      commitment_id: 'dc-1',
      scope: { features: ['F-0001'] },
      target: 'REL-0001',
      status: 'committed',
      owner: 'keith',
      created_by: 'keith',
      created_at: '2026-10-05T00:00:00Z',
    });
    expect(c1.version).toBe(1);
    const c2 = await store.commitDeliveryCommitment({
      workspace: WS,
      commitment_id: 'dc-1',
      scope: { features: ['F-0001', 'F-0002'] },
      target: 'REL-0001',
      status: 'committed',
      owner: 'keith',
      created_by: 'keith',
      created_at: '2026-10-05T01:00:00Z',
    });
    expect(c2.version).toBe(2);
    const head = await store.getDeliveryCommitment({
      workspace: WS,
      commitment_id: 'dc-1',
    });
    expect(head?.version).toBe(2);
    expect(head?.scope).toEqual({ features: ['F-0001', 'F-0002'] });
    expect(
      await store.listDeliveryCommitmentVersions({
        workspace: WS,
        commitment_id: 'dc-1',
      }),
    ).toHaveLength(2);
    // delivery_commitments is append-only at the DB layer.
    await expect(
      store.db.query(
        `UPDATE delivery_commitments SET status='delivered'
         WHERE workspace=$1 AND commitment_id=$2 AND version=1`,
        [WS, 'dc-1'],
      ),
    ).rejects.toThrow();
  });
});

describe('eval lab', () => {
  it('runs + cases + append-only results', async () => {
    await store.upsertEvalCase({
      workspace: WS,
      family: 'extraction',
      case_id: 'negation-1',
      input: { text: 'not required' },
      expected: { kind: 'constraint', polarity: 'negated' },
      tags: ['negation'],
    });
    expect(
      (await store.listEvalCases({ workspace: WS, family: 'extraction' }))[0]
        ?.tags,
    ).toEqual(['negation']);

    await store.upsertEvalRun({
      workspace: WS,
      eval_run_id: 'er-1',
      family: 'extraction',
      model: 'anthropic/claude-sonnet-4',
      status: 'running',
      created_by: 'eval-lab',
      created_at: '2026-10-05T00:00:00Z',
    });
    await store.appendEvalResult({
      workspace: WS,
      eval_run_id: 'er-1',
      family: 'extraction',
      case_id: 'negation-1',
      verdict: 'pass',
      scores: { exact: 1 },
      created_at: '2026-10-05T00:10:00Z',
    });
    expect(
      (await store.listEvalResults({ workspace: WS, eval_run_id: 'er-1' }))[0]
        ?.verdict,
    ).toBe('pass');
    await store.upsertEvalRun({
      workspace: WS,
      eval_run_id: 'er-1',
      family: 'extraction',
      status: 'completed',
      metrics: { pass_rate: 1.0 },
      completed_at: '2026-10-05T00:15:00Z',
    });
    const run = await store.getEvalRun({ workspace: WS, eval_run_id: 'er-1' });
    expect(run?.status).toBe('completed');
    expect(run?.metrics).toEqual({ pass_rate: 1.0 });
    // eval_results append-only.
    await expect(
      store.db.query(
        `UPDATE eval_results SET verdict='fail' WHERE workspace=$1`,
        [WS],
      ),
    ).rejects.toThrow();
  });
});
