/**
 * wp-151 tests — ticket taxonomy policy (PRD §15.7).
 *
 * The module is policy data + pure evaluation, so these tests pin the
 * *decisions* the conductor and API depend on:
 *   - bug ≠ scope change is semantic, not a label convention;
 *   - per-type intake/evidence requirements are data-driven;
 *   - severity ≠ priority, and is forbidden where it means nothing;
 *   - evidence evaluation is fail-closed (a missing slot is unsatisfied);
 *   - the prompt block stays a faithful projection of the policy.
 */
import { describe, expect, it } from 'vitest';
import { TICKET_ORIGINS, TICKET_WORK_TYPES } from '../src/enums.js';
import {
  APPROVED_SCOPE_ORIGINS,
  EVIDENCE_GATES,
  INTAKE_QUESTION_PREFIX,
  ORIGIN_EVIDENCE,
  SCOPE_VERDICTS,
  WORKBENCH_TABS,
  WORK_TYPE_POLICIES,
  checkSatisfied,
  directCreateAllowed,
  evaluateEvidence,
  evidenceFor,
  gatherEvidenceSnapshot,
  markdownSections,
  needsScopeApproval,
  normalizeRelationTarget,
  severityRule,
  taxonomyPromptBlock,
  ticketRef,
} from '../src/taxonomy.js';
import type { EvidenceSnapshot } from '../src/taxonomy.js';

const snapshot = (over: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  fields: {
    work_type: null,
    origin: null,
    severity: null,
    parent: null,
    feature: null,
  },
  intake: {},
  sections: new Set<string>(),
  docs: new Set<string>(),
  relations: new Set<string>(),
  verifyPass: false,
  ...over,
});

describe('work types × origins are separate dimensions', () => {
  it('every work type has a policy entry — adding a type is a table edit', () => {
    for (const t of TICKET_WORK_TYPES) {
      expect(WORK_TYPE_POLICIES[t], `missing policy for ${t}`).toBeDefined();
    }
    expect(Object.keys(WORK_TYPE_POLICIES).sort()).toEqual(
      [...TICKET_WORK_TYPES].sort(),
    );
  });

  it('direct creation is allowed for operational work, never for stories', () => {
    expect(directCreateAllowed('bug')).toBe(true);
    expect(directCreateAllowed('technical')).toBe(true);
    expect(directCreateAllowed('spike')).toBe(true);
    expect(directCreateAllowed('story')).toBe(false);
  });
});

describe('bug ≠ scope change (§15.7)', () => {
  it('a defect verdict never needs a scope proposal — it restores approved behavior', () => {
    expect(needsScopeApproval('bug', 'manual', 'defect', false)).toBe(false);
  });

  it('new capability and mixed requests ride the board/ChangeSet path', () => {
    expect(needsScopeApproval('story', 'rs', 'new-capability', false)).toBe(
      true,
    );
    expect(needsScopeApproval('bug', 'manual', 'mixed', false)).toBe(true);
  });

  it('a story needs approved scope unless it came from an approved origin', () => {
    for (const origin of APPROVED_SCOPE_ORIGINS) {
      expect(needsScopeApproval('story', origin, null, false)).toBe(false);
    }
    expect(needsScopeApproval('story', 'manual', null, false)).toBe(true);
  });

  it('a cleared scope proposal is the approval — no second gate', () => {
    expect(needsScopeApproval('story', 'manual', 'new-capability', true)).toBe(
      false,
    );
  });

  it('a bug filed from any origin stays a direct create (the verdict decides)', () => {
    for (const origin of TICKET_ORIGINS) {
      expect(needsScopeApproval('bug', origin, 'defect', false)).toBe(false);
    }
  });

  it('the verdict vocabulary is the intake classifier contract', () => {
    expect([...SCOPE_VERDICTS]).toEqual(['defect', 'new-capability', 'mixed']);
  });
});

describe('severity ≠ priority', () => {
  it('severity is required where impact drives triage (bugs/security)', () => {
    expect(severityRule('bug', null)).toBe('required');
    expect(severityRule('security', null)).toBe('required');
    expect(severityRule('technical', 'incident')).toBe('required');
  });

  it('severity is forbidden elsewhere — it can never quietly mean "importance"', () => {
    expect(severityRule('story', null)).toBe('forbidden');
    expect(severityRule('spike', 'manual')).toBe('forbidden');
  });
});

describe('per-type evidence is data-driven', () => {
  it('a bug must prove the defect at intake and at test-approved', () => {
    const reqs = evidenceFor('bug', 'manual');
    const gates = new Set(reqs.map((r) => r.gate));
    expect(gates.has('intake')).toBe(true);
    expect(gates.has('test-approved')).toBe(true);
    for (const r of reqs) {
      expect(EVIDENCE_GATES).toContain(r.gate);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });

  it('a spike closes on its findings, not on tests', () => {
    const reqs = evidenceFor('spike', 'manual');
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) expect(EVIDENCE_GATES).toContain(r.gate);
  });

  it('origin adds requirements on top of the type', () => {
    for (const origin of Object.keys(ORIGIN_EVIDENCE)) {
      const withOrigin = evidenceFor('story', origin as never);
      const without = evidenceFor('story', 'manual');
      expect(withOrigin.length).toBeGreaterThanOrEqual(without.length);
    }
  });
});

describe('evidence evaluation is fail-closed', () => {
  it('a null row field is never satisfied', () => {
    expect(
      checkSatisfied({ kind: 'field', field: 'severity' }, snapshot()),
    ).toBe(false);
    expect(
      checkSatisfied(
        { kind: 'field', field: 'severity' },
        snapshot({ fields: { ...snapshot().fields, severity: 'high' } }),
      ),
    ).toBe(true);
  });

  it('an answered intake slot satisfies an intake check', () => {
    expect(checkSatisfied({ kind: 'intake', key: 'repro' }, snapshot())).toBe(
      false,
    );
    expect(
      checkSatisfied(
        { kind: 'intake', key: 'repro' },
        snapshot({ intake: { repro: 'click login twice' } }),
      ),
    ).toBe(true);
  });

  it('blank intake answers do not count — whitespace is not evidence', () => {
    expect(
      checkSatisfied(
        { kind: 'intake', key: 'repro' },
        snapshot({ intake: { repro: '   ' } }),
      ),
    ).toBe(false);
  });

  it('a missing doc/section is unsatisfied; present ones pass', () => {
    expect(
      checkSatisfied({ kind: 'section', section: 'repro steps' }, snapshot()),
    ).toBe(false);
    expect(
      checkSatisfied(
        { kind: 'section', section: 'repro steps' },
        snapshot({ sections: new Set(['repro steps']) }),
      ),
    ).toBe(true);
    expect(checkSatisfied({ kind: 'doc', doc: 'vs.md' }, snapshot())).toBe(
      false,
    );
    expect(
      checkSatisfied(
        { kind: 'doc', doc: 'vs.md' },
        snapshot({ docs: new Set(['vs.md']) }),
      ),
    ).toBe(true);
  });

  it('a doc-contains check reads the gathered (doc, needle) index', () => {
    // The gatherer precomputes `<doc>\0<needle-lowercased>` keys.
    expect(
      checkSatisfied(
        { kind: 'doc-contains', doc: 'vs.md', needle: 'repro' },
        snapshot({ docs: new Set(['vs.md\0repro']) }),
      ),
    ).toBe(true);
    expect(
      checkSatisfied(
        { kind: 'doc-contains', doc: 'vs.md', needle: 'repro' },
        snapshot({ docs: new Set(['vs.md\0something-else']) }),
      ),
    ).toBe(false);
  });

  it('relation + verify-pass checks read their gathered signals', () => {
    expect(
      checkSatisfied(
        { kind: 'relation', predicate: 'implements' as never },
        snapshot({ relations: new Set(['implements']) }),
      ),
    ).toBe(true);
    expect(checkSatisfied({ kind: 'verify-pass' }, snapshot())).toBe(false);
    expect(
      checkSatisfied({ kind: 'verify-pass' }, snapshot({ verifyPass: true })),
    ).toBe(true);
  });

  it('evaluateEvidence reports every unmet requirement (never a silent pass)', () => {
    const verdict = evaluateEvidence('bug', 'manual', 'intake', snapshot());
    expect(verdict.missing.length).toBeGreaterThan(0);
    expect(verdict.satisfied).toHaveLength(0);

    const partial = evaluateEvidence(
      'bug',
      'manual',
      'intake',
      snapshot({
        fields: { ...snapshot().fields, severity: 'high' },
        intake: { repro: 'steps' },
      }),
    );
    expect(partial.satisfied.length).toBeGreaterThan(0);
    expect(partial.missing.length).toBeLessThan(verdict.missing.length);
  });

  it('gate scoping: only the requested gate’s requirements are evaluated', () => {
    const intake = evaluateEvidence('bug', 'manual', 'intake', snapshot());
    for (const r of [...intake.satisfied, ...intake.missing]) {
      expect(r.gate).toBe('intake');
    }
  });
});

describe('markdownSections', () => {
  it('collects lowercased headings and tolerates null', () => {
    const sections = markdownSections('## Repro Steps\n\n## Notes\n');
    expect(sections.has('repro steps')).toBe(true);
    expect(sections.has('notes')).toBe(true);
    expect(markdownSections(null).size).toBe(0);
  });
});

describe('relation targets + refs', () => {
  it('builds stable ticket refs', () => {
    expect(ticketRef('ws', 'SR-0001')).toBe('ticket:ws:SR-0001');
  });

  it('keeps kind:id refs verbatim and resolves bare ids in-workspace', () => {
    expect(normalizeRelationTarget('ws', 'feature:F-0002')).toBe(
      'feature:F-0002',
    );
    expect(normalizeRelationTarget('ws', 'SR-0001')).toBe('ticket:ws:SR-0001');
  });
});

describe('workbench tabs', () => {
  it('the shared type tab exists and the tab vocabulary is unique', () => {
    expect(WORKBENCH_TABS[0]).toBe('type');
    expect(new Set(WORKBENCH_TABS).size).toBe(WORKBENCH_TABS.length);
  });
});

describe('taxonomyPromptBlock', () => {
  it('projects the policy faithfully (types, direct-create rules, intake)', () => {
    const block = taxonomyPromptBlock();
    for (const t of TICKET_WORK_TYPES) expect(block).toContain(t);
    expect(block).toContain(INTAKE_QUESTION_PREFIX);
    expect(block.toLowerCase()).toContain('scope');
  });
});

describe('gatherEvidenceSnapshot', () => {
  it('is exported for the conductor/API to gather once per evaluation', () => {
    expect(typeof gatherEvidenceSnapshot).toBe('function');
  });
});
