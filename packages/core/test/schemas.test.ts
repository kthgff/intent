import { describe, expect, it } from 'vitest';
import {
  AgentFindingSchema,
  ConfigSchema,
  DesignChecklistSchema,
  DesignSystemSchema,
  DossierEntrySchema,
  EmbeddingSchema,
  EntitySchema,
  EventSchema,
  GateItemSchema,
  MockupSchema,
  PROMPT_TEMPLATES,
  PROMPT_VERSION,
  PrBodySchema,
  RelationSchema,
  ReviewSchema,
  SENTINELS,
  SentinelSchema,
  TERMINAL_STATUSES,
  TICKET_STATUSES,
  TestReportSchema,
  TicketFrontmatterSchema,
  TriageSchema,
  UsageSchema,
} from '../src/index.js';

describe('ticket frontmatter (SCHEMAS §1)', () => {
  it('round-trips a minimal fixture', () => {
    const fm = TicketFrontmatterSchema.parse({
      schema: 1,
      id: 'ABC-123',
      title: 'Short title',
      status: 'imported',
      priority: 'high',
      repos: ['backend', 'frontend'],
      depth: 'standard',
      backend: 'aider',
      model: 'openrouter/anthropic/claude-sonnet-4',
      source: 'jira:PROJ-123',
      parent: null,
      depends_on: [],
      forced: false,
      blocked_reason: null,
    });
    expect(fm.id).toBe('ABC-123');
    expect(
      TicketFrontmatterSchema.parse(JSON.parse(JSON.stringify(fm))),
    ).toEqual(fm);
  });

  it('rejects an unknown status (fail-closed)', () => {
    expect(() =>
      TicketFrontmatterSchema.parse({
        schema: 1,
        id: 'X-1',
        title: 't',
        status: 'donezo',
        priority: 'high',
        repos: [],
        depth: 'light',
      }),
    ).toThrow();
  });

  it('status enum covers all spec statuses and terminals are a subset', () => {
    expect(TICKET_STATUSES).toContain('split');
    for (const t of TERMINAL_STATUSES) {
      expect(TICKET_STATUSES).toContain(t);
    }
  });
});

describe('events.jsonl (SCHEMAS §7)', () => {
  it('round-trips the spec example', () => {
    const ev = EventSchema.parse({
      v: 1,
      ts: '2026-10-03T14:22:10Z',
      ticket: 'ABC-123',
      stage: 'review',
      actor: { type: 'agent', id: 'aider/openrouter-sonnet' },
      event: 'finding_created',
      run: '003-review',
      refs: ['runs/003-review/review.json'],
      data: {},
      cost_usd: 0.12,
      tokens_in: 41200,
      tokens_out: 4010,
      tokens_cached: 30000,
      usage_source: 'reported',
      duration_s: 310,
      human_minutes: 0,
    });
    expect(ev.event).toBe('finding_created');
    expect(EventSchema.parse(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
  });

  it('allows null usage fields (non-token billing)', () => {
    const ev = EventSchema.parse({
      v: 1,
      ts: '2026-10-03T14:22:10Z',
      ticket: 'ABC-123',
      stage: 'implement',
      actor: { type: 'runner', id: 'keith' },
      event: 'run_finished',
      cost_usd: null,
    });
    expect(ev.cost_usd).toBeNull();
  });
});

describe('triage.json (SCHEMAS §5)', () => {
  it('round-trips a fixture with questions', () => {
    const t = TriageSchema.parse({
      schema: 1,
      ticket: 'ABC-123',
      round: 2,
      spec_lint: {
        score: 72,
        flags: ["ac2 vague verb: 'handles'", 'no out-of-scope section'],
      },
      suggestions: {
        backend: 'aider',
        model: 'openrouter/anthropic/claude-sonnet-4',
        priority: 'high',
        depth: 'standard',
      },
      files_likely_touched: [
        { repo: 'backend', file: 'internal/etl/worker.go' },
      ],
      entities_referenced: [
        { term: 'job', entity: 'IngestionJob', confidence: 0.9 },
      ],
      risk_summary: 'one honest paragraph',
      self_answered: [{ question: 'q?', answer: 'a', evidence: 'file:line' }],
      questions: [
        {
          id: 'q3',
          question: 'Which approach?',
          why: 'ambiguity',
          format: 'single',
          options: [{ key: 'A', label: 'first', recommended: true }],
          default: 'A',
          allow_other: true,
          status: 'open',
          answer: null,
          answered_by: 'keith',
          answered_at: null,
          auto: false,
        },
      ],
    });
    expect(t.questions[0]?.format).toBe('single');
    expect(TriageSchema.parse(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });
});

describe('review.json (SCHEMAS §6)', () => {
  it('round-trips a review envelope with a finding', () => {
    const r = ReviewSchema.parse({
      schema: 1,
      ticket: 'ABC-123',
      round: 1,
      passes: ['correctness', 'security', 'spec-compliance', 'test-gap'],
      findings: [
        {
          thread_id: 'f-8f3a',
          status: 'open',
          fingerprint: {
            file: 'src/a.ts',
            symbol: 'foo',
            category: 'correctness',
            line_range: [40, 52],
            text_hash: 'sha1:abc',
          },
          severity: 'blocker',
          category: 'correctness',
          kind: 'code-bug',
          file: 'src/a.ts',
          line: 40,
          repo: 'backend',
          body: 'npe',
          evidence: 'trace',
          suggested_fix: 'null check',
          confidence: 0.8,
          rounds_seen: [1],
          author: 'review',
          replies: [
            { actor: 'human', body: 'ack', ts: '2026-10-03T15:00:00Z' },
          ],
        },
      ],
    });
    expect(r.findings[0]?.thread_id).toBe('f-8f3a');
    expect(ReviewSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it('accepts agent findings without runner-computed fields', () => {
    const f = AgentFindingSchema.parse({
      severity: 'minor',
      category: 'style',
      kind: 'code-bug',
      file: 'x.ts',
      line: 3,
      repo: 'backend',
      body: 'naming',
    });
    expect('fingerprint' in f).toBe(false);
  });
});

describe('test-report.json (SCHEMAS §10)', () => {
  it('round-trips the spec example', () => {
    const tr = TestReportSchema.parse({
      schema: 1,
      ticket: 'ABC-123',
      ts: '2026-10-03T14:30:00Z',
      command: 'make verify',
      cases: [
        {
          case_id: 'c1',
          implemented: true,
          file: 't/x.test.ts',
          result: 'pass',
        },
      ],
      pass_pct: 94.1,
      planned: 17,
      implemented: 16,
      risks: ['c4 unwritable: needs staging'],
    });
    expect(tr.pass_pct).toBe(94.1);
  });
});

describe('usage.json (SCHEMAS §13)', () => {
  it('round-trips a per-call ledger', () => {
    const u = UsageSchema.parse({
      schema: 1,
      ticket: 'ABC-123',
      run: '003-implement',
      backend: 'aider',
      model: 'openrouter/anthropic/claude-sonnet-4',
      granularity: 'per-call',
      totals: {
        tokens_in: 41200,
        tokens_out: 4010,
        tokens_cached: 30000,
        cost_usd: 0.12,
        duration_s: 310,
      },
      calls: [
        {
          seq: 1,
          ts: '2026-10-03T14:22:10Z',
          model: 'openrouter/anthropic/claude-sonnet-4',
          tokens_in: 8000,
          tokens_out: 900,
          tokens_cached: 6000,
          latency_s: 12.4,
          source: 'reported',
        },
      ],
      source: 'reported',
      notes: 'ok',
    });
    expect(u.calls[0]?.seq).toBe(1);
    expect(UsageSchema.parse(JSON.parse(JSON.stringify(u)))).toEqual(u);
  });

  it('accepts run-aggregate with null cost_usd (non-token billing)', () => {
    const u = UsageSchema.parse({
      schema: 1,
      ticket: 'ABC-123',
      run: '001-implement',
      backend: 'devin',
      model: 'devin-default',
      granularity: 'run-aggregate',
      totals: {
        tokens_in: 100,
        tokens_out: 10,
        tokens_cached: 0,
        cost_usd: null,
        duration_s: 5,
      },
      calls: [],
      source: 'estimated',
    });
    expect(u.totals.cost_usd).toBeNull();
  });
});

describe('gate items (DB-SCHEMA gate_items)', () => {
  it('round-trips a gate item', () => {
    const g = GateItemSchema.parse({
      workspace: 'team-a',
      subject: 'ABC-123',
      gate: 'prd-review',
      kind: 'approval',
      surfaced_at: '2026-10-03T14:00:00Z',
      cleared_at: null,
      blocked_agent: true,
      priority: 'high',
    });
    expect(g.kind).toBe('approval');
  });

  it('accepts non-ticket subjects', () => {
    const g = GateItemSchema.parse({
      workspace: 'team-a',
      subject: 'probe:backend',
      gate: 'repair',
      kind: 'repair',
      surfaced_at: '2026-10-03T14:00:00Z',
    });
    expect(g.subject).toBe('probe:backend');
  });
});

describe('sentinels (CONDUCTOR sentinel table)', () => {
  it('covers every sentinel name from the spec table', () => {
    const expected = [
      'INTERVIEW-QA',
      'TICKET-AUTHORED',
      'WONT-DRAFT',
      'IMPORTED',
      'IMPORT-FAILED',
      'CARD-WRITTEN',
      'PROBE-FAILED',
      'READY',
      'NEEDS-INFO',
      'ESCALATE',
      'SPLIT-PROPOSED',
      'UNSPLITTABLE',
      'PRD-WRITTEN',
      'DESIGN-QA',
      'TDD-WRITTEN',
      'TESTPLAN-WRITTEN',
      'DONE',
      'PASS-COMPLETE',
      'PASS-FAILED',
      'FIXES-COMPLETE',
      'REPLIED',
      'NEEDS-FIX-RUN',
      'CI-FIXED',
      'COMMENTS-PROCESSED',
      'REBASED',
      'REVERT-READY',
      'REPAIRED',
      'REPAIR-FAILED',
      'ESCALATION-WRITTEN',
      'SURVEY-COMPLETE',
      'SURVEY-FAILED',
      'BLOCKED',
      'EDIT-PROPOSED',
      'EDIT-CLARIFY',
      'EDIT-REFUSED',
    ];
    for (const s of expected) expect(SENTINELS).toContain(s);
    expect(SENTINELS.length).toBe(expected.length);
  });

  it('parses a sentinel with a payload', () => {
    const s = SentinelSchema.parse({
      name: 'FIXES-COMPLETE',
      arg: '3/4',
      raw: 'FIXES-COMPLETE: 3/4',
    });
    expect(s.arg).toBe('3/4');
  });
});

describe('dossier + semantic layer (SCHEMAS §11-§12)', () => {
  it('round-trips a dossier entry', () => {
    const d = DossierEntrySchema.parse({
      scope: 'repo',
      name: 'backend',
      section: 'gap-report',
      version: 2,
      content: '| gap | kind | evidence | severity |',
      surveyed_at: '2026-10-03T00:00:00Z',
      sources_used: ['code', 'docs'],
      stale: false,
      edited_by: null,
      edited_at: null,
    });
    expect(d.section).toBe('gap-report');
  });

  it('round-trips entity, relation, embedding', () => {
    const e = EntitySchema.parse({
      id: 'e1',
      product: 'myApp',
      kind: 'entity',
      name: 'Job',
      canonical: 'IngestionJob',
      aliases: ['job', 'ingestion job'],
      source: 'confirmed',
      evidence: 'src/jobs.ts:12',
    });
    expect(e.kind).toBe('entity');
    const r = RelationSchema.parse({
      subject: 'IngestionJob',
      predicate: 'part-of',
      object: 'Pipeline',
      evidence: 'x',
      source: 'model',
      confidence: 0.7,
    });
    expect(r.predicate).toBe('part-of');
    const em = EmbeddingSchema.parse({
      object_ref: 'ticket:ABC-123',
      model: 'minilm',
      vector: [0.1, 0.2],
    });
    expect(em.model).toBe('minilm');
  });
});

describe('pr-body (SCHEMAS §9)', () => {
  it('round-trips parsed sections', () => {
    const p = PrBodySchema.parse({
      summary: 'does x',
      acceptance_criteria_map: 'ac1 → src/a.ts',
      deviations: 'none',
      test_results: '94% pass',
      risks_rollout_notes: 'low',
    });
    expect(p.deviations).toBe('none');
  });
});

describe('config.yaml (SETTINGS)', () => {
  it('round-trips a minimal config with defaults', () => {
    const c = ConfigSchema.parse({ schema: 1, actor: 'keith' });
    expect(c.backend).toBe('devin');
    expect(c.permission_mode).toBe('smart');
    expect(c.gates).toBe('full');
    expect(c.spec_depth).toBe('standard');
  });

  it('round-trips a fuller config', () => {
    const c = ConfigSchema.parse({
      schema: 1,
      actor: 'keith',
      backend: 'aider',
      repos: {
        backend: {
          path: '/abs/path/backend',
          card: { test: 'make verify', verified: true },
        },
      },
      tickets_repos: [{ name: 'team-a', url: 'git@github.com:org/t.git' }],
      capabilities: {
        aider: { can_exec: true, can_write_outside_tree: false, has_gh: false },
      },
      timeouts: { implement: 7200 },
    });
    expect(c.repos.backend?.card?.verified).toBe(true);
  });
});

describe('prompt templates', () => {
  it('ships all 25 templates at PROMPT_VERSION 3', () => {
    // v2: wp-081 added interview-edit (chat-to-edit, s-01 D25).
    // v3: wp-111 prd template emits rs-quality.json (INTELLIGENCE §5).
    expect(PROMPT_VERSION).toBe(3);
    expect(Object.keys(PROMPT_TEMPLATES).length).toBe(25);
    expect(PROMPT_TEMPLATES.retro.length).toBeGreaterThan(0);
    expect(PROMPT_TEMPLATES['solution-brief'].length).toBeGreaterThan(0);
    expect(PROMPT_TEMPLATES.triage.length).toBeGreaterThan(0);
    expect(PROMPT_TEMPLATES['review-passes'].length).toBeGreaterThan(0);
    expect(PROMPT_TEMPLATES.mockup.length).toBeGreaterThan(0);
    expect(PROMPT_TEMPLATES['design-ingest'].length).toBeGreaterThan(0);
    expect(PROMPT_TEMPLATES['interview-edit'].length).toBeGreaterThan(0);
  });
});

describe('design artifacts (PRD §15.4, wp-149)', () => {
  const mockupFixture = {
    schema: 1,
    subject: 'SR-0001',
    title: 'Login',
    fidelity: 'wireframe',
    screens: [
      {
        screen_id: 'login',
        title: 'Login',
        route: '/login',
        requirement: 'AC-1',
        root: 'c-form',
        states: ['default', 'error'],
      },
    ],
    components: [
      {
        component_id: 'c-form',
        name: 'Form',
        kind: 'form',
        children: ['c-submit'],
        props: { title: 'Sign in' },
        requirement: 'AC-1',
      },
      {
        component_id: 'c-submit',
        name: 'Button',
        parent: 'c-form',
        kind: 'button',
        props: { label: 'Sign in' },
      },
    ],
    visual_acs: [{ ac_id: 'AC-1', component_id: 'c-form', state: 'default' }],
  };

  it('parses a valid mockup tree and applies defaults', () => {
    const m = MockupSchema.parse(mockupFixture);
    expect(m.fidelity).toBe('wireframe');
    expect(m.components[0]?.children).toEqual(['c-submit']);
    expect(m.components[1]?.children).toEqual([]);
    expect(m.visual_acs[0]?.state).toBe('default');
  });

  it('rejects an unknown fidelity tier', () => {
    expect(
      MockupSchema.safeParse({ ...mockupFixture, fidelity: 'photoreal' })
        .success,
    ).toBe(false);
  });

  it('parses a design-system bundle', () => {
    const ds = DesignSystemSchema.parse({
      schema: 1,
      source: 'web',
      tokens: { color: { primary: '#0055ff' } },
      components: [
        { name: 'Button', import: 'ui/Button', props: { tone: 'string' } },
      ],
      styling: 'tailwind',
    });
    expect(ds.components[0]?.name).toBe('Button');
    expect(ds.components[0]?.variants).toEqual([]);
  });

  it('design checklist keys are constrained to the item enum', () => {
    expect(DesignChecklistSchema.safeParse({ desktop: true }).success).toBe(
      true,
    );
    expect(DesignChecklistSchema.safeParse({ bogus: true }).success).toBe(
      false,
    );
  });
});
