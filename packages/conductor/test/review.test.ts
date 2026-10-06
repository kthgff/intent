/**
 * wp-050 tests — review pipeline: 4-pass merge + fingerprints,
 * severity-gated fix rounds, re-review lifecycle, dismissal cap,
 * discuss replies. Pure-function coverage plus one handler-level
 * dismissal-cap-breach path (the escalation gate item).
 *
 * D29: review.json / DEVIATIONS.md are `run_artifacts` rows, not files
 * in a ticket dir — the handler reads the ticket's latest artifact
 * (newest-first across its runs) and writes the updated review.json
 * back onto the current run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@veto/config';
import type {
  AgentFinding,
  RunResult,
  RunRow,
  Stage,
  TicketRow,
} from '@veto/core';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApplyStatusOptions,
  type RunOutcome,
  type TransitionContext,
  type TransitionTools,
  applyTicketStatus,
} from '../src/contracts.js';
import { parseTicketMd } from '../src/import/parse.js';
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

const WS = 'ws';
const NOW = '2026-10-05T00:00:00Z';

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
let store: PostgresStore;
let handler: RealTransitionHandler;
let requestedRuns: { subject: string; stage: string }[];

function ctx(): TransitionContext {
  return {
    workspace: WS,
    rootPath: dir,
    store,
    actor: 'test-bot',
    now: () => new Date(NOW),
  };
}

/** A TransitionTools wired straight onto the store — mirrors the
 *  conductor's factory (loop/tools.ts) minus leases/launch, with
 *  requestRun recorded instead of queued. */
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
      if (filter.runId && !filter.ticketId) {
        const a = await store.getArtifact(filter.runId, name);
        return a?.content ?? null;
      }
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

/** Seed one ticket: a `tickets` truth row + the `ticket.md` doc_version
 *  (D29). `extraFm` keys land in the frontmatter as `key: value` lines. */
async function seedTicket(
  id: string,
  status: TicketRow['status'],
  extraFm: Record<string, string> = {},
): Promise<TicketRow> {
  const { priority = 'medium', ...rest } = extraFm;
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
  const fm = parsed.value.frontmatter;
  const ts = new Date().toISOString();
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
  };
  await store.upsertTicket(row);
  await store.appendDocVersion(
    { workspace: WS, subject: id, doc: 'ticket.md' },
    raw,
    'test-seed',
  );
  return row;
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
    container_id: null,
    request: null,
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
  return { run, result };
}

describe('handler: fix dismissal cap breach', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'veto-wp050-'));
    store = await PostgresStore.connect('pglite:');
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

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('FIXES-COMPLETE over cap → escalation gate item + honored dismissals land', async () => {
    await seedTicket('SR-0001', 'review');
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

    // review.json lives on the review run's run_artifacts row (D29 —
    // was tickets/<id>/review.json on disk).
    const rRun = await makeRun('SR-0001', 'review', 'PASS-COMPLETE', 'SR-0001');
    await store.putArtifact({
      run_id: rRun.id,
      name: 'review.json',
      content: `${JSON.stringify(seed, null, 2)}\n`,
      created_at: NOW,
    });

    // DEVIATIONS.md with 3 self-dismissals (cap default = 2) — a
    // run_artifact the fix run reports in its artifacts list.
    const fRun = await makeRun('SR-0001', 'fix', 'FIXES-COMPLETE', 'SR-0001');
    await store.putArtifact({
      run_id: fRun.id,
      name: 'DEVIATIONS.md',
      content: [
        '# Deviations — SR-0001',
        '| planned | did | reason | file |',
        `| finding ${ids[0]} | not fixed | not a real issue: a |`,
        `| finding ${ids[1]} | not fixed | not a real issue: b |`,
        `| finding ${ids[2]} | not fixed | not a real issue: c |`,
        '',
      ].join('\n'),
      created_at: NOW,
    });
    await handler.onRunComplete(
      outcome(fRun, 'FIXES-COMPLETE: 0/3', ['DEVIATIONS.md']),
      tools(),
    );

    // Escalation gate item surfaced for the whole batch.
    const gate = (await store.listGateItems({ workspace: WS })).find(
      (g) => g.gate === 'fix-dismissal-breach',
    );
    expect(gate?.kind).toBe('escalation');
    // First two dismissals honored; the third stays open. The updated
    // review.json was written back as a run_artifacts row on the fix run.
    const stored = JSON.parse(
      (await store.getArtifact(fRun.id, 'review.json'))?.content ?? '',
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
