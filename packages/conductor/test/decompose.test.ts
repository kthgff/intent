/**
 * wp-154 tests — Work Decomposition Engine + contract-first tickets +
 * Integration Coordinator (PRD §15.7/§15.10).
 *
 * Covers the four acceptance criteria:
 *   - decomposition output → contracts + readiness/safety attrs on the
 *     materialized children (materializeSplit);
 *   - contracts pinned per run (`contract.json` doc_version →
 *     baseline.contract_ver) with drift → revalidation, never silent
 *     proceed (revalidateDependents);
 *   - dependency-aware sequencing observable in claim order —
 *     ClaimReport.skipped carries named coordinator reasons;
 *   - fail-closed: malformed/missing contract artifacts park the plan
 *     on doc-repair rather than materializing a guess.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter } from '@sprint-runner/adapters';
import { resolveConfig } from '@sprint-runner/config';
import {
  ContractDocSchema,
  type RunResult,
  type RunRow,
  type Stage,
  type TicketRow,
} from '@sprint-runner/core';
import { PostgresStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim } from '../src/claim/index.js';
import {
  type ApplyStatusOptions,
  type RunOutcome,
  type TransitionContext,
  type TransitionTools,
  applyTicketStatus,
} from '../src/contracts.js';
import {
  parseContractArtifact,
  promoteContracts,
  renderContractDoc,
} from '../src/decompose/contracts.js';
import {
  CONTRACT_MISSING_GATE,
  coordinateClaim,
  revalidateDependents,
} from '../src/decompose/coordinator.js';
import {
  type DecompositionRow,
  parseDecompositionPlan,
} from '../src/decompose/plan.js';
import { computeExecutionReadiness } from '../src/decompose/readiness.js';
import { computeParallelSafety } from '../src/decompose/safety.js';
import { parseTicketMd } from '../src/import/parse.js';
import { LeaseManager } from '../src/loop/lease.js';
import { transitionContext } from '../src/loop/tools.js';
import type { ToolCtx } from '../src/loop/tools.js';
import { RealTransitionHandler } from '../src/transitions/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_FIXTURE = join(HERE, '../../../fixtures/code-repo');
const WS = 'ws';
const NOW = '2026-10-05T00:00:00Z';
const NOOP_SCAN = async () => ({
  ok: true as const,
  scanner: 'stub',
  findings: [],
});

let dir: string;
let codeRepo: string;
let runsDir: string;
let store: PostgresStore;

function must<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

function ctx(): TransitionContext {
  return {
    workspace: WS,
    rootPath: dir,
    store,
    actor: 'test-bot',
    now: () => new Date(NOW),
  };
}

function gitInit(repo: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
}

/** Seed one ticket row + its ticket.md doc_version. `fm` adds raw
 *  frontmatter `key: value` lines; `row` overrides TicketRow fields
 *  (depends_on, parallel_safety, execution_readiness…). */
async function seedTicket(
  id: string,
  status: TicketRow['status'],
  opts: {
    fm?: Record<string, string>;
    row?: Partial<TicketRow>;
  } = {},
): Promise<TicketRow> {
  const { fm = {}, row = {} } = opts;
  const { priority = 'medium', ...rest } = fm;
  const raw = [
    '---',
    'schema: 1',
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${status}`,
    `priority: ${priority}`,
    'repos: [code-repo]',
    ...Object.entries(rest).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '## Description',
    'A sufficiently long description for spec lint purposes, detailing the work.',
    '',
    '## Acceptance criteria',
    '- [ ] Something verifiable happens',
    '',
  ].join('\n');
  const parsed = parseTicketMd(raw, `${id}/ticket.md`);
  if (!parsed.ok) throw new Error(`seed ${id}: ${parsed.error.error}`);
  const fmv = parsed.value.frontmatter;
  const ts = new Date().toISOString();
  const ticket: TicketRow = {
    workspace: WS,
    ticket_id: id,
    feature: fmv.feature ?? null,
    title: fmv.title,
    status: fmv.status,
    priority: fmv.priority,
    depth: fmv.depth ?? null,
    backend: fmv.backend ?? null,
    model: fmv.model ?? null,
    repos: fmv.repos,
    parent: fmv.parent ?? null,
    depends_on: fmv.depends_on,
    serves: null,
    source: fmv.source ?? null,
    forced: fmv.forced ?? false,
    spec_score: null,
    spec_hash: null,
    blocked_reason: fmv.blocked_reason ?? null,
    created_at: ts,
    updated_at: ts,
    ...row,
  };
  await store.upsertTicket(ticket);
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    raw,
    'test-seed',
  );
  return ticket;
}

let runSeq = 0;

async function makeRun(
  subject: string,
  stage: Stage,
  opts: {
    ticketId?: string;
    status?: RunRow['status'];
    baseline?: object;
  } = {},
): Promise<RunRow> {
  const attempt = ++runSeq;
  const row: RunRow = {
    id: `${WS}/${subject}/${String(attempt).padStart(3, '0')}-${stage}`,
    workspace: WS,
    subject,
    ticket_id: opts.ticketId ?? null,
    stage,
    attempt,
    backend: 'mock',
    model: null,
    depth: null,
    pid: null,
    worktree: null,
    container_id: null,
    request: opts.baseline ? { baseline: opts.baseline } : null,
    status: opts.status ?? 'done',
    started_at: '2026-10-05T00:00:00Z',
    heartbeat_at: null,
    exited_at: '2026-10-05T00:01:00Z',
    sentinel: null,
    sentinel_raw: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    usage_source: null,
    duration_s: null,
    run_dir: null,
  };
  await store.createRun(row);
  return row;
}

async function putRunArtifact(
  runId: string,
  name: string,
  content: string,
): Promise<void> {
  await store.putArtifact({
    run_id: runId,
    name,
    content,
    created_at: NOW,
  });
}

const ticketMd = async (id: string) =>
  (await store.getDoc({ workspace: WS, subject: id, doc: 'ticket.md' }))
    ?.content ?? '';

const events = (ticketId: string) =>
  store.listEvents({ workspace: WS, ticket_id: ticketId });

const gates = () => store.listGateItems({ workspace: WS });

// ---------------------------------------------------------------------------

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-wp154-'));
  runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  codeRepo = join(dir, 'code-repo');
  cpSync(CODE_FIXTURE, codeRepo, { recursive: true });
  gitInit(codeRepo);
  store = await PostgresStore.connect('pglite:');
  await store.upsertProject({
    workspace: WS,
    name: 'test',
    next_ticket_seq: 10,
    next_feature_seq: 1,
    next_initiative_seq: 1,
    settings: {},
    created_at: NOW,
  });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// plan.ts — the split-plan.md decomposition parse (fail-closed)
// ---------------------------------------------------------------------------

const PLAN_BASE = [
  '# Split plan — SR-0001',
  '## Children',
  '| child | title | repos | depends_on | covers |',
  '| --- | --- | --- | --- | --- |',
  '| c1 | part one | code-repo | | ac1 |',
  '| c2 | part two | code-repo | c1 | ac2 |',
].join('\n');

const CONTRACT_SPEC = JSON.stringify({
  schema: 1,
  name: 'billing-api',
  kind: 'api',
  version: 1,
  summary: 'POST /billing/charge shape',
  terms: { endpoints: ['POST /billing/charge'] },
});

describe('parseDecompositionPlan', () => {
  it('parses children-only plans (optional sections absent)', () => {
    const p = parseDecompositionPlan(PLAN_BASE);
    expect(p).not.toBeNull();
    expect(p?.children).toHaveLength(2);
    expect(p?.children[1]?.dependsOn).toEqual(['c1']);
    expect(p?.contracts).toEqual([]);
    expect(p?.decomposition).toEqual([]);
  });

  it('parses Contracts + Decomposition sections', () => {
    const p = parseDecompositionPlan(
      `${PLAN_BASE}
## Contracts
| contract | kind | consumers | artifact |
| --- | --- | --- | --- |
| billing-api | api | c1, c2 | contracts/billing-api.json |
## Decomposition
| child | boundary | ownership | tests | security | complexity | shared_files |
| --- | --- | --- | --- | --- | --- | --- |
| c1 | charge writes | backend/billing | unit | sensitive | high | code-repo:src/billing.ts |
| c2 | charge reads | backend/billing | unit | standard | low | |
`,
    );
    expect(p?.contracts).toEqual([
      {
        name: 'billing-api',
        kind: 'api',
        consumers: ['c1', 'c2'],
        artifact: 'contracts/billing-api.json',
      },
    ]);
    expect(p?.decomposition).toHaveLength(2);
    expect(p?.decomposition[0]?.security).toBe('sensitive');
    expect(p?.decomposition[0]?.sharedFiles).toEqual([
      'code-repo:src/billing.ts',
    ]);
  });

  it('fails closed: malformed optional section → null', () => {
    expect(
      parseDecompositionPlan(
        `${PLAN_BASE}\n## Contracts\nno table here, just prose\n`,
      ),
    ).toBeNull();
    expect(
      parseDecompositionPlan(
        `${PLAN_BASE}\n## Contracts\n| wrong | header |\n| --- | --- |\n| x | y |\n`,
      ),
    ).toBeNull();
  });

  it('fails closed: enum cells outside the pinned vocabularies → null', () => {
    expect(
      parseDecompositionPlan(
        `${PLAN_BASE}\n## Contracts\n| contract | kind | consumers | artifact |\n| --- | --- | --- | --- |\n| billing-api | rpc | c1 | contracts/b.json |\n`,
      ),
    ).toBeNull();
    expect(
      parseDecompositionPlan(
        `${PLAN_BASE}\n## Decomposition\n| child | boundary | ownership | tests | security | complexity | shared_files |\n| --- | --- | --- | --- | --- | --- | --- |\n| c1 | x | y | z | scary | low | |\n`,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// safety.ts — parallel_safety verdicts
// ---------------------------------------------------------------------------

describe('computeParallelSafety', () => {
  const children = [
    {
      label: 'c1',
      title: 'a',
      repos: ['code-repo'],
      dependsOn: [],
      covers: [],
    },
    {
      label: 'c2',
      title: 'b',
      repos: ['code-repo'],
      dependsOn: [],
      covers: [],
    },
    { label: 'c3', title: 'c', repos: ['ui-repo'], dependsOn: [], covers: [] },
  ];
  const row = (r: Partial<DecompositionRow>): DecompositionRow => ({
    child: '',
    boundary: '',
    ownership: '',
    tests: '',
    security: 'standard',
    complexity: 'low',
    sharedFiles: [],
    ...r,
  });

  it('sensitive → exclusive; shared file → exclusive; shared repo → caution; disjoint → safe; unrowed → unknown', () => {
    const m = computeParallelSafety({
      children,
      decomposition: [
        row({ child: 'c1', security: 'sensitive' }),
        row({ child: 'c2' }),
        // c3 has no row.
      ],
    });
    expect(m.get('c1')).toBe('exclusive');
    expect(m.get('c2')).toBe('caution'); // shares code-repo with c1
    expect(m.get('c3')).toBe('unknown');
  });

  it('declared shared-file overlap → exclusive even for standard work', () => {
    const m = computeParallelSafety({
      children,
      decomposition: [
        row({ child: 'c1', sharedFiles: ['code-repo:src/x.ts'] }),
        row({ child: 'c2', sharedFiles: ['code-repo:src/x.ts'] }),
        row({ child: 'c3' }),
      ],
    });
    expect(m.get('c1')).toBe('exclusive');
    expect(m.get('c2')).toBe('exclusive');
    expect(m.get('c3')).toBe('safe');
  });
});

// ---------------------------------------------------------------------------
// contracts.ts — artifact parse + promotion (fail-closed)
// ---------------------------------------------------------------------------

describe('contract artifacts', () => {
  it('parseContractArtifact accepts a ContractSpec and rejects junk', () => {
    expect(parseContractArtifact(CONTRACT_SPEC)?.name).toBe('billing-api');
    expect(parseContractArtifact('not json')).toBeNull();
    expect(parseContractArtifact('{"schema":1}')).toBeNull();
  });

  it('renderContractDoc emits a ContractDocSchema-valid envelope', () => {
    const spec = must(parseContractArtifact(CONTRACT_SPEC), 'spec');
    const doc = renderContractDoc([spec]);
    expect(ContractDocSchema.safeParse(JSON.parse(doc)).success).toBe(true);
  });

  it('promoteContracts writes contract.json per consumer inside the tx', async () => {
    await seedTicket('SR-0001', 'triage');
    const splitRun = await makeRun('SR-0001', 'split', {
      ticketId: 'SR-0001',
    });
    await putRunArtifact(
      splitRun.id,
      'contracts/billing-api.json',
      CONTRACT_SPEC,
    );
    const consumers = ['SR-0010', 'SR-0011'];
    for (const id of consumers) await seedTicket(id, 'imported');
    const promoted = await promoteContracts({
      ctx: ctx(),
      ticketId: 'SR-0001',
      contracts: [
        {
          name: 'billing-api',
          kind: 'api',
          consumers: ['c1', 'c2'],
          artifact: 'contracts/billing-api.json',
        },
      ],
      ids: { c1: 'SR-0010', c2: 'SR-0011' },
      readArtifact: async (name) =>
        (await store.getArtifact(splitRun.id, name))?.content ?? null,
    });
    expect(promoted).toHaveLength(2);
    for (const id of consumers) {
      const doc = await store.getDoc({
        workspace: WS,
        subject: id,
        doc: 'contract.json',
      });
      expect(doc?.version).toBe(1);
      const parsed = ContractDocSchema.safeParse(
        JSON.parse(must(doc, 'contract doc').content),
      );
      expect(parsed.success).toBe(true);
      expect(parsed.data?.contracts[0]?.name).toBe('billing-api');
    }
  });

  it('promoteContracts throws on a missing artifact or unknown consumer (fail-closed)', async () => {
    await seedTicket('SR-0001', 'triage');
    await seedTicket('SR-0010', 'imported');
    await expect(
      promoteContracts({
        ctx: ctx(),
        ticketId: 'SR-0001',
        contracts: [
          {
            name: 'x',
            kind: 'api',
            consumers: ['c1'],
            artifact: 'contracts/x.json',
          },
        ],
        ids: { c1: 'SR-0010' },
        readArtifact: async () => null,
      }),
    ).rejects.toThrow(/missing or invalid/);
    await expect(
      promoteContracts({
        ctx: ctx(),
        ticketId: 'SR-0001',
        contracts: [
          {
            name: 'x',
            kind: 'api',
            consumers: ['ghost'],
            artifact: 'contracts/x.json',
          },
        ],
        ids: { c1: 'SR-0010' },
        readArtifact: async () => CONTRACT_SPEC,
      }),
    ).rejects.toThrow(/unknown consumer/);
  });
});

// ---------------------------------------------------------------------------
// readiness.ts — execution_readiness over deps + contracts + slots +
// statements
// ---------------------------------------------------------------------------

describe('computeExecutionReadiness', () => {
  it('no deps, no contracts, no slots → ready', async () => {
    const t = await seedTicket('SR-0001', 'ready');
    const res = await computeExecutionReadiness({
      ctx: ctx(),
      ticket: t,
    });
    expect(res.readiness).toBe('ready');
    expect(res.reasons).toEqual([]);
  });

  it('undelivered dep → incomplete; dead dep → blocked', async () => {
    const dep = await seedTicket('SR-0001', 'triage');
    const t = await seedTicket('SR-0002', 'ready', {
      row: { depends_on: [dep.ticket_id] },
    });
    expect(
      (await computeExecutionReadiness({ ctx: ctx(), ticket: t })).readiness,
    ).toBe('incomplete');
    await store.upsertTicket({ ...dep, status: 'wont-do' });
    const res = await computeExecutionReadiness({ ctx: ctx(), ticket: t });
    expect(res.readiness).toBe('blocked');
    expect(res.reasons.join(' ')).toMatch(/cannot deliver/);
  });

  it('declared contract without a contract.json doc → blocked; pinned → ready', async () => {
    const t = await seedTicket('SR-0001', 'ready');
    const res = await computeExecutionReadiness({
      ctx: ctx(),
      ticket: t,
      contracts: ['billing-api'],
    });
    expect(res.readiness).toBe('blocked');
    expect(res.reasons[0]).toMatch(/contract\.json/);
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0001', doc: 'contract.json' },
      renderContractDoc([must(parseContractArtifact(CONTRACT_SPEC))]),
      'test-seed',
    );
    expect(
      (
        await computeExecutionReadiness({
          ctx: ctx(),
          ticket: t,
          contracts: ['billing-api'],
        })
      ).readiness,
    ).toBe('ready');
  });

  it('missing/conflicted knowledge slots + disputed statements → incomplete', async () => {
    const t = await seedTicket('SR-0001', 'ready');
    await store.upsertInterviewSession({
      workspace: WS,
      session_id: 'sess-1',
      subject: t.ticket_id,
      status: 'active',
      draft_ready: false,
      approval_ready: false,
    });
    await store.upsertKnowledgeSlot({
      workspace: WS,
      session_id: 'sess-1',
      slot: 'target-users',
      state: 'missing',
    });
    await store.upsertStatement({
      workspace: WS,
      statement_id: 'st-1',
      text: 'billing charges monthly',
      scope: 'ticket',
      scope_ref: t.ticket_id,
      status: 'disputed',
    });
    const res = await computeExecutionReadiness({ ctx: ctx(), ticket: t });
    expect(res.readiness).toBe('incomplete');
    expect(res.reasons.join(' ')).toMatch(/target-users.*missing/);
    expect(res.reasons.join(' ')).toMatch(/st-1.*disputed/);
  });
});

// ---------------------------------------------------------------------------
// coordinator.ts — claim-time coordination (exclusive fencing,
// shared-file conflict prediction, contract-first pinning)
// ---------------------------------------------------------------------------

const TDD_FILE_PLAN = (files: string[]) =>
  [
    '# TDD',
    '## File plan',
    '| file | repo | change | why |',
    '| --- | --- | --- | --- |',
    ...files.map((f) => `| ${f} | code-repo | modify | test |`),
    '',
  ].join('\n');

describe('coordinateClaim', () => {
  it('non-repo-executing stages pass through uncoordinated', async () => {
    const t = await seedTicket('SR-0001', 'ready', {
      row: { parallel_safety: 'exclusive' },
    });
    expect(
      await coordinateClaim({
        ctx: ctx(),
        ticket: t,
        stage: 'triage',
        live: [],
      }),
    ).toBeNull();
  });

  it('exclusive ticket parks while any repo-executing run is live', async () => {
    const t = await seedTicket('SR-0001', 'ready', {
      row: { parallel_safety: 'exclusive' },
    });
    const other = await seedTicket('SR-0002', 'in-progress');
    const live = [
      await makeRun('SR-0002', 'implement', {
        ticketId: other.ticket_id,
        status: 'running',
      }),
    ];
    expect(
      await coordinateClaim({
        ctx: ctx(),
        ticket: t,
        stage: 'implement',
        live,
      }),
    ).toBe('exclusive-in-flight');
  });

  it('a live exclusive run fences every other claim (both directions)', async () => {
    const exclusive = await seedTicket('SR-0001', 'in-progress', {
      row: { parallel_safety: 'exclusive' },
    });
    const t = await seedTicket('SR-0002', 'ready');
    const live = [
      await makeRun('SR-0001', 'implement', {
        ticketId: exclusive.ticket_id,
        status: 'running',
      }),
    ];
    expect(
      await coordinateClaim({
        ctx: ctx(),
        ticket: t,
        stage: 'implement',
        live,
      }),
    ).toBe('exclusive-in-flight:SR-0001');
  });

  it('predicted shared-file overlap parks the claim with a named reason', async () => {
    const a = await seedTicket('SR-0001', 'in-progress');
    const b = await seedTicket('SR-0002', 'ready');
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0001', doc: 'tdd.md' },
      TDD_FILE_PLAN(['src/shared.ts', 'src/a.ts']),
      'test-seed',
    );
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0002', doc: 'tdd.md' },
      TDD_FILE_PLAN(['src/shared.ts', 'src/b.ts']),
      'test-seed',
    );
    const live = [
      await makeRun('SR-0001', 'implement', {
        ticketId: a.ticket_id,
        status: 'running',
      }),
    ];
    const reason = await coordinateClaim({
      ctx: ctx(),
      ticket: b,
      stage: 'implement',
      live,
    });
    expect(reason).toBe('shared-file-conflict:SR-0001(1)');
    // Disjoint file plans → no conflict.
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0002', doc: 'tdd.md' },
      TDD_FILE_PLAN(['src/only-b.ts']),
      'test-seed',
    );
    expect(
      await coordinateClaim({
        ctx: ctx(),
        ticket: b,
        stage: 'implement',
        live,
      }),
    ).toBeNull();
  });

  it('declared contract without contract.json → contract-unpinned + gate', async () => {
    const t = await seedTicket('SR-0001', 'ready', {
      fm: { contract: '[billing-api]' },
    });
    expect(
      await coordinateClaim({
        ctx: ctx(),
        ticket: t,
        stage: 'implement',
        live: [],
      }),
    ).toBe('contract-unpinned');
    const gate = (await gates()).find(
      (g) => g.subject === 'SR-0001' && g.gate === CONTRACT_MISSING_GATE,
    );
    expect(gate?.blocked_agent).toBe(true);
    // Pin the doc → the claim may proceed.
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0001', doc: 'contract.json' },
      renderContractDoc([must(parseContractArtifact(CONTRACT_SPEC))]),
      'test-seed',
    );
    expect(
      await coordinateClaim({
        ctx: ctx(),
        ticket: t,
        stage: 'implement',
        live: [],
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revalidateDependents — post-merge readiness recompute + contract drift
// ---------------------------------------------------------------------------

describe('revalidateDependents', () => {
  it('recomputes dependents after a dep merges + emits dependent_revalidated', async () => {
    const dep = await seedTicket('SR-0001', 'merged');
    const child = await seedTicket('SR-0002', 'ready', {
      row: { depends_on: [dep.ticket_id], execution_readiness: 'incomplete' },
    });
    const out = await revalidateDependents({
      ctx: ctx(),
      mergedTicketId: dep.ticket_id,
    });
    expect(out).toEqual([
      { ticket_id: 'SR-0002', readiness: 'ready', drift: null },
    ]);
    const after = await store.getTicket({
      workspace: WS,
      ticket_id: child.ticket_id,
    });
    expect(after?.execution_readiness).toBe('ready');
    const ev = (await events('SR-0002')).find(
      (e) => e.event === 'dependent_revalidated',
    );
    expect(ev?.data).toMatchObject({ merged: 'SR-0001', readiness: 'ready' });
  });

  it('pinned contract drift → baseline-drift gate, never silent proceed', async () => {
    const dep = await seedTicket('SR-0001', 'merged');
    const child = await seedTicket('SR-0002', 'ready', {
      fm: { contract: '[billing-api]' },
      row: { depends_on: [dep.ticket_id] },
    });
    // The child's implement run pinned contract_ver 1 at launch.
    await makeRun('SR-0002', 'implement', {
      ticketId: child.ticket_id,
      baseline: {
        rs_version: null,
        ticket_rev: null,
        design_rev: null,
        ac_ids: [],
        base_sha: null,
        contract_ver: 1,
      },
    });
    // …then the approved contract moved to v2 (re-approved interface).
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0002', doc: 'contract.json' },
      renderContractDoc([must(parseContractArtifact(CONTRACT_SPEC))]),
      'test-seed',
    );
    await store.appendDocVersion(
      { workspace: WS, subject: 'SR-0002', doc: 'contract.json' },
      renderContractDoc([
        { ...must(parseContractArtifact(CONTRACT_SPEC)), version: 2 },
      ]),
      'test-seed',
    );
    const out = await revalidateDependents({
      ctx: ctx(),
      mergedTicketId: dep.ticket_id,
    });
    expect(out[0]?.drift).toEqual({ pinned: 1, head: 2 });
    expect(out[0]?.readiness).toBe('incomplete');
    const gate = (await gates()).find(
      (g) => g.subject === 'SR-0002' && g.gate === 'baseline-drift',
    );
    expect(gate?.kind).toBe('approval');
    const ev = (await events('SR-0002')).find(
      (e) => e.event === 'dependent_revalidated',
    );
    expect(ev?.data).toMatchObject({ drift: { pinned: 1, head: 2 } });
  });

  it('a dead dep marks the dependent blocked (deps recompute)', async () => {
    const dep = await seedTicket('SR-0001', 'reverted');
    await seedTicket('SR-0002', 'ready', {
      row: { depends_on: [dep.ticket_id], execution_readiness: 'ready' },
    });
    const out = await revalidateDependents({
      ctx: ctx(),
      mergedTicketId: dep.ticket_id,
    });
    expect(out[0]?.readiness).toBe('blocked');
    const after = await store.getTicket({
      workspace: WS,
      ticket_id: 'SR-0002',
    });
    expect(after?.execution_readiness).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// materialization integration — approved split-plan → children carry
// contracts + readiness/safety attrs
// ---------------------------------------------------------------------------

describe('split materialization (decomposition pass)', () => {
  const handler = () =>
    new RealTransitionHandler(
      resolveConfig(null, {
        config: {
          actor: 'test-bot',
          backend: 'mock',
          gates: 'full',
          repos: {},
          security: { scan_on_commit: false },
        },
        warnings: [],
        secrets: {},
        files: [],
      }) as never,
    );

  /** Minimal TransitionTools mirror of transitions.test.ts. */
  let requestedRuns: { subject: string; stage: string; ticketId?: string }[];
  function tools(c = ctx()): TransitionTools {
    return {
      ...c,
      applyTicketStatus: (opts: ApplyStatusOptions) =>
        applyTicketStatus({ ctx: c, opts }),
      surfaceGateItem: async (item) => {
        const ts = c.now().toISOString();
        await store.upsertGateItem({
          workspace: WS,
          subject: item.subject,
          gate: item.gate,
          kind: item.kind,
          surfaced_at: ts,
          cleared_at: null,
          blocked_agent: item.blockedAgent ?? false,
          priority: item.priority ?? null,
        });
      },
      appendEvent: (e) =>
        store.appendEvent({
          workspace: WS,
          ticket_id: e.ticketId ?? null,
          ts: c.now().toISOString(),
          stage: e.stage ?? null,
          actor_type: e.actorType ?? 'runner',
          actor_id: c.actor,
          event: e.event,
          run: e.run ?? null,
          refs: e.refs ?? [],
          data: e.data ?? {},
          cost_usd: e.costUsd ?? null,
          tokens_in: e.tokensIn ?? null,
          tokens_out: e.tokensOut ?? null,
          tokens_cached: e.tokensCached ?? null,
          usage_source: e.usageSource ?? null,
          duration_s: e.durationS ?? null,
          human_minutes: e.humanMinutes ?? null,
        }),
      requestRun: async (req) => {
        requestedRuns.push(req);
        return `${WS}/${req.subject}/001-${req.stage}`;
      },
      getDocText: async (subject, doc) =>
        (await store.getDoc({ workspace: WS, subject, doc }))?.content ?? null,
      putDoc: async (subject, doc, content) =>
        (
          await store.appendDocVersion(
            { workspace: WS, subject, doc },
            content,
            c.actor,
          )
        ).version,
      getArtifactText: async (runId, name) =>
        (await store.getArtifact(runId, name))?.content ?? null,
      putArtifact: async (runId, name, content) => {
        await store.putArtifact({
          run_id: runId,
          name,
          content,
          created_at: c.now().toISOString(),
        });
      },
      getLatestArtifactText: async (name, filter) => {
        const runs = (
          await store.listRuns(
            filter.ticketId
              ? { workspace: WS, ticket_id: filter.ticketId }
              : { workspace: WS },
          )
        ).sort((a, b) => b.id.localeCompare(a.id));
        for (const r of runs) {
          const a = await store.getArtifact(r.id, name);
          if (a) return a.content;
        }
        return null;
      },
      allocTicketId: () => store.allocTicketId(WS),
    };
  }

  function outcome(run: RunRow, sentinelRaw: string): RunOutcome {
    const result: RunResult = {
      sentinel: sentinelRaw.split(':')[0] ?? sentinelRaw,
      sentinel_raw: sentinelRaw,
      artifacts: [],
      usage: null,
      exit_code: 0,
    };
    return { run, result };
  }

  async function seedSplitRun(
    plan: string,
    opts: { contracts?: boolean } = {},
  ) {
    await seedTicket('SR-0001', 'triage');
    const sRun = await makeRun('SR-0001', 'split', { ticketId: 'SR-0001' });
    await putRunArtifact(sRun.id, 'split-plan.md', plan);
    for (const label of ['c1', 'c2']) {
      await putRunArtifact(
        sRun.id,
        `children/${label}.md`,
        [
          '---',
          'schema: 1',
          `id: SR-0001-${label}`,
          `title: part ${label}`,
          'status: imported',
          'priority: medium',
          'repos: [code-repo]',
          'parent: SR-0001',
          'depends_on: []',
          '---',
          '',
          '## Description',
          'child draft',
          '',
        ].join('\n'),
      );
    }
    if (opts.contracts) {
      await putRunArtifact(
        sRun.id,
        'contracts/billing-api.json',
        CONTRACT_SPEC,
      );
    }
    return sRun;
  }

  const PLAN_WITH_CONTRACTS = [
    '# Split plan — SR-0001',
    '## Children',
    '| child | title | repos | depends_on | covers |',
    '| --- | --- | --- | --- | --- |',
    '| c1 | charge writes | code-repo | | ac1 |',
    '| c2 | charge reads | code-repo | c1 | ac2 |',
    '## Contracts',
    '| contract | kind | consumers | artifact |',
    '| --- | --- | --- | --- |',
    '| billing-api | api | c1, c2 | contracts/billing-api.json |',
    '## Decomposition',
    '| child | boundary | ownership | tests | security | complexity | shared_files |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| c1 | charge write path | backend/billing | unit | sensitive | high | code-repo:src/billing.ts |',
    '| c2 | charge read path | backend/billing | unit | standard | low | code-repo:src/read.ts |',
    '',
  ].join('\n');

  it('approved plan → contract.json promoted, readiness + safety on the rows, contract frontmatter set', async () => {
    const h = handler();
    requestedRuns = [];
    const sRun = await seedSplitRun(PLAN_WITH_CONTRACTS, { contracts: true });
    await h.onRunComplete(outcome(sRun, 'SPLIT-PROPOSED: 2'), tools());
    expect((await gates()).some((g) => g.gate === 'split-plan')).toBe(true);

    // Approve → materialize.
    await store.clearGateItem(
      { workspace: WS, subject: 'SR-0001', gate: 'split-plan' },
      new Date().toISOString(),
    );
    const ticket = await store.getTicket({
      workspace: WS,
      ticket_id: 'SR-0001',
    });
    expect(await h.nextStage(must(ticket, 'parent ticket'), ctx())).toBeNull();

    const children = (await store.listTickets({ workspace: WS })).filter(
      (t) => t.parent === 'SR-0001',
    );
    expect(children).toHaveLength(2);
    const c1 = must(
      children.find((t) => t.depends_on.length === 0),
      'c1 child',
    );
    const c2 = must(
      children.find((t) => t.depends_on.length === 1),
      'c2 child',
    );

    // parallel_safety from ## Decomposition: sensitive → exclusive;
    // shared repo + disjoint shared_files → caution.
    expect(c1.parallel_safety).toBe('exclusive');
    expect(c2.parallel_safety).toBe('caution');

    // execution_readiness: c1 ready (deps empty, contract pinned);
    // c2 incomplete (c1 not yet delivered).
    expect(c1.execution_readiness).toBe('ready');
    expect(c2.execution_readiness).toBe('incomplete');

    // contract-first: contract.json doc promoted on both consumers +
    // `contract:` frontmatter on their ticket.md.
    for (const t of [c1, c2]) {
      const doc = await store.getDoc({
        workspace: WS,
        subject: t.ticket_id,
        doc: 'contract.json',
      });
      expect(doc?.version).toBe(1);
      const parsed = ContractDocSchema.safeParse(
        JSON.parse(must(doc, 'contract doc').content),
      );
      expect(parsed.data?.contracts[0]?.name).toBe('billing-api');
      expect(await ticketMd(t.ticket_id)).toMatch(
        /^contract: \[billing-api\]$/m,
      );
    }
    const names = (await events('SR-0001')).map((e) => e.event);
    expect(names).toContain('split_approved');
    expect(names).toContain('split_materialized');
  });

  it('a Contracts row naming a missing artifact → doc-repair, never a gate', async () => {
    const h = handler();
    requestedRuns = [];
    const sRun = await seedSplitRun(PLAN_WITH_CONTRACTS, { contracts: false });
    await h.onRunComplete(outcome(sRun, 'SPLIT-PROPOSED: 2'), tools());
    expect(requestedRuns.some((r) => r.stage === 'doc-repair')).toBe(true);
    expect((await gates()).some((g) => g.gate === 'split-plan')).toBe(false);
  });

  it('a contract consumer naming a non-child label → doc-repair', async () => {
    const h = handler();
    requestedRuns = [];
    const plan = PLAN_WITH_CONTRACTS.replace('c1, c2', 'c1, ghost');
    const sRun = await seedSplitRun(plan, { contracts: true });
    await h.onRunComplete(outcome(sRun, 'SPLIT-PROPOSED: 2'), tools());
    expect(requestedRuns.some((r) => r.stage === 'doc-repair')).toBe(true);
    expect((await gates()).some((g) => g.gate === 'split-plan')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// claim() integration — dependency-aware sequencing is observable in
// ClaimReport.skipped reasons
// ---------------------------------------------------------------------------

describe('claim order (integration coordinator)', () => {
  it('dependency + exclusive + contract-unpinned skips land in ClaimReport.skipped', async () => {
    const deps = {
      store,
      adapters: { mock: new MockAdapter({ delayMs: 50 }) },
      config: resolveConfig(null, {
        config: {
          actor: 'test-bot',
          backend: 'mock',
          concurrency: { implement: 4 },
          repos: {
            'code-repo': {
              path: codeRepo,
              card: {
                test: 'make test',
                lint: 'make lint',
                build: 'make build',
                forbidden_paths: [],
                probed_at: '2026-10-03T00:00:00Z',
                verified: true,
              },
            },
          },
          security: { scan_on_commit: false },
        },
        warnings: [],
        secrets: {},
        files: [],
      }),
      workspaces: [{ name: WS, rootPath: dir }],
      runsDir,
      transitions: {
        nextStage: (t: TicketRow) =>
          t.status === 'ready' ? { stage: 'implement' as Stage } : null,
        onRunComplete: async () => {},
      },
      scan: NOOP_SCAN,
    };
    const toolCtx: ToolCtx = {
      deps: deps as never,
      ws: { name: WS, rootPath: dir },
      leases: new LeaseManager(deps as never),
      handles: new Map(),
      killedForCap: new Set(),
    };

    // Ordering via updated_at: contract ticket first, then the
    // exclusive one (which launches), then the safe sibling (fenced by
    // the just-launched exclusive run), then the dependent.
    const t0 = '2026-10-05T00:00:00Z';
    const c = await seedTicket('SR-0003', 'ready', {
      fm: { contract: '[billing-api]' },
      row: { updated_at: t0 },
    });
    const a = await seedTicket('SR-0001', 'ready', {
      row: {
        parallel_safety: 'exclusive',
        updated_at: '2026-10-05T00:01:00Z',
      },
    });
    const d = await seedTicket('SR-0004', 'ready', {
      row: { parallel_safety: 'safe', updated_at: '2026-10-05T00:02:00Z' },
    });
    const b = await seedTicket('SR-0002', 'ready', {
      row: {
        depends_on: [a.ticket_id],
        updated_at: '2026-10-05T00:03:00Z',
      },
    });

    const report = await claim(toolCtx);
    // A's exclusive run launched; every skip reason is named.
    expect(report.launched).toHaveLength(1);
    const skipped = new Map(report.skipped.map((s) => [s.ticket, s.reason]));
    expect(skipped.get(c.ticket_id)).toBe('contract-unpinned');
    expect(skipped.get(b.ticket_id)).toBe('depends_on-unmerged');
    expect(skipped.get(d.ticket_id)).toBe('exclusive-in-flight:SR-0001');
    // The contract-missing gate item surfaced for the unpinned claim.
    expect(
      (await gates()).some(
        (g) => g.subject === 'SR-0003' && g.gate === CONTRACT_MISSING_GATE,
      ),
    ).toBe(true);
  });
});
