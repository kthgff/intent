/**
 * wp-050 tests — review pipeline: 4-pass merge + fingerprints,
 * severity-gated fix rounds, re-review lifecycle, dismissal cap,
 * discuss replies. Pure-function coverage plus one handler-level
 * dismissal-cap-breach path (the escalation gate item).
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '@sprint-runner/config';
import type {
  AgentFinding,
  RunResult,
  RunRow,
  Stage,
} from '@sprint-runner/core';
import { SqliteStore } from '@sprint-runner/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApplyStatusOptions,
  type RunOutcome,
  type TransitionContext,
  type TransitionTools,
  applyTicketStatus,
} from '../src/contracts.js';
import {
  applyFixResults,
  discussReply,
  dismissalClaimsFromDeviations,
  mergePasses,
  parseFixesPayload,
  planReviewRound,
  reReview,
} from '../src/review/index.js';
import type { ReviewDocument } from '../src/review/index.js';
import { RealTransitionHandler } from '../src/transitions/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TICKETS_FIXTURE = join(HERE, '../../../fixtures/tickets-repo');
const WS = 'ws';

/** Minimal valid AgentFinding. */
function af(p: Partial<AgentFinding> & { body: string }): AgentFinding {
  return {
    severity: 'major',
    category: 'correctness',
    kind: 'code-bug',
    file: 'src/a.ts',
    line: 40,
    repo: 'code-repo',
    ...p,
  } as AgentFinding;
}

// ---------------------------------------------------------------------------
// mergePasses — cross-pass dedupe
// ---------------------------------------------------------------------------

describe('mergePasses', () => {
  it('two passes flagging the same bug dedupe to one finding with both provenances', () => {
    const review = mergePasses(
      {
        correctness: [af({ body: 'off-by-one drops last row', line: 40 })],
        security: [
          // Same file+category, reworded report of the same site
          // (line within ±5) — same thread per matchThread.
          af({
            body: 'the final row is skipped by the loop bounds',
            line: 44,
            evidence: 'for (i = 0; i < n - 1; i++)',
          }),
        ],
        'spec-compliance': [],
        'test-gap': [],
      },
      { ticket: 'SR-0001', round: 1 },
    );
    expect(review.findings).toHaveLength(1);
    const f = review.findings[0] as NonNullable<(typeof review.findings)[0]>;
    expect(f.passes.sort()).toEqual(['correctness', 'security']);
    expect(f.evidence).toContain('[security]');
    expect(f.thread_id).toMatch(/^f-[0-9a-f]{4}$/);
    expect(review.passes).toEqual([
      'correctness',
      'security',
      'spec-compliance',
      'test-gap',
    ]);
  });

  it('distinct bugs keep distinct thread_ids; categories preserved', () => {
    const review = mergePasses(
      {
        correctness: [
          af({ body: 'off-by-one drops last row', line: 40 }),
          af({
            body: 'sql string built without escaping',
            category: 'security',
            severity: 'blocker',
            file: 'src/db.ts',
            line: 12,
          }),
        ],
      },
      { ticket: 'SR-0001' },
    );
    expect(review.findings).toHaveLength(2);
    expect(new Set(review.findings.map((f) => f.thread_id)).size).toBe(2);
    expect(review.findings.map((f) => f.category).sort()).toEqual([
      'correctness',
      'security',
    ]);
  });

  it('deduped findings keep the higher severity', () => {
    const review = mergePasses(
      {
        correctness: [
          af({ body: 'loop bound is wrong', line: 40, severity: 'nit' }),
        ],
        security: [
          af({ body: 'loop bound wrong here', line: 41, severity: 'blocker' }),
        ],
      },
      { ticket: 'SR-0001' },
    );
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.severity).toBe('blocker');
  });
});

// ---------------------------------------------------------------------------
// reReview — thread lifecycle across rounds
// ---------------------------------------------------------------------------

describe('reReview', () => {
  const round1 = (): ReviewDocument =>
    mergePasses(
      {
        correctness: [af({ body: 'off-by-one drops last row', line: 40 })],
        security: [],
        'spec-compliance': [],
        'test-gap': [],
      },
      { ticket: 'SR-0001', round: 1 },
    );

  it('shifted lines still match — same thread_id, rounds_seen grows', () => {
    const prior = round1();
    const res = reReview(
      {
        correctness: [af({ body: 'off-by-one drops last row', line: 58 })],
        security: [],
        'spec-compliance': [],
        'test-gap': [],
      },
      prior,
      { round: 2 },
    );
    expect(res.created).toBe(0);
    expect(res.review.findings).toHaveLength(1);
    const f = res.review.findings[0] as NonNullable<
      (typeof res.review.findings)[0]
    >;
    expect(f.thread_id).toBe(prior.findings[0]?.thread_id);
    expect(f.rounds_seen).toEqual([1, 2]);
    expect(f.status).toBe('open');
  });

  it('fixed finding reappearing → reopened on the same thread', () => {
    const prior = round1();
    (prior.findings[0] as { status: string }).status = 'fixed';
    const res = reReview(
      {
        correctness: [af({ body: 'off-by-one drops last row', line: 42 })],
        security: [],
        'spec-compliance': [],
        'test-gap': [],
      },
      prior,
      { round: 2 },
    );
    expect(res.reopened).toBe(1);
    expect(res.review.findings[0]?.status).toBe('reopened');
    expect(res.review.findings[0]?.thread_id).toBe(
      prior.findings[0]?.thread_id,
    );
  });

  it('open finding absent from a complete new scan → fixed', () => {
    const res = reReview(
      { correctness: [], security: [], 'spec-compliance': [], 'test-gap': [] },
      round1(),
      { round: 2 },
    );
    expect(res.fixed).toBe(1);
    expect(res.review.findings[0]?.status).toBe('fixed');
  });

  it('partial round (missing pass) cannot conclude absence → stays open', () => {
    const res = reReview({ correctness: [] }, round1(), { round: 2 });
    expect(res.fixed).toBe(0);
    expect(res.review.findings[0]?.status).toBe('open');
  });

  it('dismissed findings never reopen on their own', () => {
    const prior = round1();
    (prior.findings[0] as { status: string }).status = 'dismissed';
    const res = reReview(
      {
        correctness: [af({ body: 'off-by-one drops last row', line: 41 })],
        security: [],
        'spec-compliance': [],
        'test-gap': [],
      },
      prior,
      { round: 2 },
    );
    expect(res.review.findings[0]?.status).toBe('dismissed');
    expect(res.review.findings[0]?.rounds_seen).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// planReviewRound — severity gating matrix
// ---------------------------------------------------------------------------

describe('planReviewRound', () => {
  const cfg = { auto_fix_severities: ['blocker', 'major'], auto_fix_rounds: 2 };
  const review = (severity: string | null, round = 1, status = 'open') => ({
    round,
    findings:
      severity === null ? [] : [{ status, severity: severity as never }],
  });

  it('blocker/major open → fix-run; minor/nit/question → gate; clean → gate', () => {
    expect(planReviewRound(review('blocker'), cfg)).toBe('fix-run');
    expect(planReviewRound(review('major'), cfg)).toBe('fix-run');
    expect(planReviewRound(review('minor'), cfg)).toBe('gate');
    expect(planReviewRound(review('nit'), cfg)).toBe('gate');
    expect(planReviewRound(review('question'), cfg)).toBe('gate');
    expect(planReviewRound(review(null), cfg)).toBe('gate');
  });

  it('reopened findings behave like open ones', () => {
    expect(planReviewRound(review('major', 2, 'reopened'), cfg)).toBe(
      'fix-run',
    );
  });

  it('fix-round counter respected: round > auto_fix_rounds → gate', () => {
    expect(planReviewRound(review('blocker', 3), cfg)).toBe('gate');
    expect(planReviewRound(review('blocker', 2), cfg)).toBe('fix-run');
  });

  it('settled findings (fixed/dismissed/wontfix) never trigger a fix run', () => {
    for (const status of ['fixed', 'dismissed', 'wontfix']) {
      expect(planReviewRound(review('blocker', 1, status), cfg)).toBe('gate');
    }
  });
});

// ---------------------------------------------------------------------------
// applyFixResults — FIXES-COMPLETE + dismissal cap
// ---------------------------------------------------------------------------

describe('applyFixResults', () => {
  const review = (): ReviewDocument =>
    mergePasses(
      {
        correctness: [
          af({ body: 'bug one', line: 10 }),
          af({ body: 'bug two', line: 20 }),
          af({ body: 'bug three', line: 30 }),
          af({ body: 'bug four', line: 50 }),
        ],
      },
      { ticket: 'SR-0001' },
    );

  it('parses <f>/<t> payloads', () => {
    expect(parseFixesPayload('3/5')).toEqual({ fixed: 3, total: 5 });
    expect(parseFixesPayload('noise')).toBeNull();
  });

  it('parses DEVIATIONS.md self-dismissal rows', () => {
    const md = [
      '| planned | did | reason | file |',
      '| finding f-aaaa | not fixed | not a real issue: spec already allows it |',
      '| finding f-bb12 | not fixed | not a real issue: test-only path |',
    ].join('\n');
    expect(dismissalClaimsFromDeviations(md)).toEqual(['f-aaaa', 'f-bb12']);
  });

  it('honors dismissals up to the cap', () => {
    const r = review();
    const ids = r.findings.map((f) => f.thread_id);
    const res = applyFixResults(
      { payload: '4/4', dismissed_thread_ids: ids.slice(0, 2) },
      r,
      { fix_dismissal_cap: 2 },
      { ts: '2026-10-05T00:00:00Z' },
    );
    expect(res.dismissed).toBe(2);
    expect(res.escalated).toBe(false);
    expect(res.review.findings[0]?.status).toBe('dismissed');
    expect(res.review.findings[1]?.status).toBe('dismissed');
    // payload f===t claims the rest resolved.
    expect(res.review.findings[2]?.status).toBe('fixed');
    expect(res.review.findings[3]?.status).toBe('fixed');
  });

  it('cap breach → over-cap claims stay open and the batch escalates', () => {
    const r = review();
    const ids = r.findings.map((f) => f.thread_id);
    const res = applyFixResults(
      {
        dismissed_thread_ids: ids.slice(0, 3),
      },
      r,
      { fix_dismissal_cap: 2 },
    );
    expect(res.escalated).toBe(true);
    expect(res.dismissed).toBe(2);
    expect(res.overCap).toEqual([ids[2]]);
    expect(res.review.findings[2]?.status).toBe('open');
    expect(res.review.findings[3]?.status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// discussReply
// ---------------------------------------------------------------------------

describe('discussReply', () => {
  it('REPLIED appends to the thread replies', () => {
    const r = mergePasses(
      { correctness: [af({ body: 'bug one' })] },
      { ticket: 'SR-0001' },
    );
    const id = r.findings[0]?.thread_id;
    const res = discussReply(r, {
      sentinel: 'REPLIED',
      thread_id: id,
      body: 'intentional: the index is inclusive by spec',
      ts: '2026-10-05T00:00:00Z',
    });
    expect(res.kind).toBe('appended');
    if (res.kind === 'appended') {
      expect(res.finding.replies).toHaveLength(1);
      expect(res.finding.replies[0]?.body).toContain('intentional');
    }
  });

  it('NEEDS-FIX-RUN → fix-run request; unknown thread → missing-thread', () => {
    const r = mergePasses(
      { correctness: [af({ body: 'bug one' })] },
      { ticket: 'SR-0001' },
    );
    const id = r.findings[0]?.thread_id;
    expect(
      discussReply(r, {
        sentinel: 'NEEDS-FIX-RUN',
        thread_id: id,
        ts: '2026-10-05T00:00:00Z',
      }).kind,
    ).toBe('fix-run');
    expect(
      discussReply(r, {
        sentinel: 'REPLIED',
        thread_id: 'f-zzzz',
        ts: '2026-10-05T00:00:00Z',
      }).kind,
    ).toBe('missing-thread');
  });
});

// ---------------------------------------------------------------------------
// Handler-level: dismissal cap breach surfaces the escalation gate item
// ---------------------------------------------------------------------------

let dir: string;
let ticketsRepo: string;
let store: SqliteStore;
let handler: RealTransitionHandler;
let requestedRuns: { subject: string; stage: string }[];

function gitInit(repo: string): void {
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
}

function ctx(): TransitionContext {
  return {
    workspace: WS,
    ticketsRepoPath: ticketsRepo,
    store,
    actor: 'test-bot',
    now: () => new Date('2026-10-05T00:00:00Z'),
  };
}

function tools(c = ctx()): TransitionTools {
  return {
    ...c,
    applyTicketStatus: (opts: ApplyStatusOptions) =>
      applyTicketStatus({
        ctx: c,
        opts,
        actor: { name: c.actor, email: `${c.actor}@sprint-runner.local` },
      }),
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
      await store.insertNotification({
        workspace: WS,
        subject: item.subject,
        kind: `gate:${item.kind}`,
        payload: JSON.stringify(item),
        created_at: ts,
        read_at: null,
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
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        usage_source: null,
        duration_s: null,
        human_minutes: null,
      }),
    requestRun: async (req) => {
      requestedRuns.push(req);
      return `${WS}/${req.subject}/001-${req.stage}`;
    },
  };
}

let runSeq = 0;
async function makeRun(
  subject: string,
  stage: Stage,
  sentinel: string | null,
  ticketId?: string,
): Promise<RunRow> {
  const attempt = ++runSeq;
  const row: RunRow = {
    id: `${WS}/${subject}/${String(attempt).padStart(3, '0')}-${stage}`,
    workspace: WS,
    subject,
    ticket_id: ticketId ?? null,
    stage,
    attempt,
    backend: 'mock',
    model: null,
    depth: null,
    pid: null,
    worktree: null,
    status: 'done',
    started_at: '2026-10-05T00:00:00Z',
    heartbeat_at: null,
    exited_at: '2026-10-05T00:01:00Z',
    sentinel,
    sentinel_raw: sentinel,
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

function outcome(
  run: RunRow,
  sentinelRaw: string,
  artifacts: string[] = [],
): RunOutcome {
  const result: RunResult = {
    sentinel: sentinelRaw.split(':')[0] ?? sentinelRaw,
    sentinel_raw: sentinelRaw,
    artifacts,
    usage: null,
    exit_code: 0,
  };
  return { run, result, usagePath: null };
}

describe('handler: fix dismissal cap breach', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sr-wp050-'));
    ticketsRepo = join(dir, 'tickets-repo');
    cpSync(TICKETS_FIXTURE, ticketsRepo, { recursive: true });
    gitInit(ticketsRepo);
    store = new SqliteStore(':memory:');
    requestedRuns = [];
    handler = new RealTransitionHandler(
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
      }),
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('FIXES-COMPLETE over cap → escalation gate item + honored dismissals land', async () => {
    const ticketDir = join(ticketsRepo, 'tickets', 'SR-0001');
    mkdirSync(ticketDir, { recursive: true });
    const seed = mergePasses(
      {
        correctness: [
          af({ body: 'bug one', line: 10 }),
          af({ body: 'bug two', line: 20 }),
          af({ body: 'bug three', line: 30 }),
        ],
        security: [],
        'spec-compliance': [],
        'test-gap': [],
      },
      { ticket: 'SR-0001', round: 1 },
    );
    const ids = seed.findings.map((f) => f.thread_id);
    writeFileSync(
      join(ticketDir, 'review.json'),
      `${JSON.stringify(seed, null, 2)}\n`,
    );
    // DEVIATIONS.md with 3 self-dismissals (cap default = 2).
    const deviations = join(dir, 'DEVIATIONS.md');
    writeFileSync(
      deviations,
      [
        '# Deviations — SR-0001',
        '| planned | did | reason | file |',
        `| finding ${ids[0]} | not fixed | not a real issue: a |`,
        `| finding ${ids[1]} | not fixed | not a real issue: b |`,
        `| finding ${ids[2]} | not fixed | not a real issue: c |`,
        '',
      ].join('\n'),
    );

    const run = await makeRun('SR-0001', 'fix', 'FIXES-COMPLETE', 'SR-0001');
    await handler.onRunComplete(
      outcome(run, 'FIXES-COMPLETE: 0/3', [deviations]),
      tools(),
    );

    // Escalation gate item surfaced for the whole batch.
    const gate = (await store.listGateItems({ workspace: WS })).find(
      (g) => g.gate === 'fix-dismissal-breach',
    );
    expect(gate?.kind).toBe('escalation');
    // First two dismissals honored; the third stays open.
    const stored = JSON.parse(
      readFileSync(join(ticketDir, 'review.json'), 'utf8'),
    ) as ReviewDocument;
    expect(
      stored.findings.filter((f) => f.status === 'dismissed'),
    ).toHaveLength(2);
    expect(stored.findings.filter((f) => f.status === 'open')).toHaveLength(1);
    // Re-review still queued (verify leg → 4 passes).
    expect(requestedRuns).toContainEqual(
      expect.objectContaining({ subject: 'SR-0001', stage: 'verify' }),
    );
  });
});
