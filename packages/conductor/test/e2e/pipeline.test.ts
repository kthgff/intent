/**
 * wp-040 — E2E vertical: the full conductor spine on fixture repos with
 * zero LLM spend (ScriptedAdapter → real detached `mock-agent.mjs`
 * children, SqliteStore on tmp, file:// bare remote for pull/push).
 *
 * Happy path: SR-0001 imported → spec-lint → triage → needs-info →
 * (answers) → ready → prd-draft → prd-review → design-qa → (answers) →
 * tdd-draft → tdd-review → test-draft → test-review → test-approved →
 * (go_implement) → in-progress → review → verify + 4 review passes →
 * changes-requested → (approve) → approved → (open PR) → pr-open.
 *
 * Negative paths: garbage sentinel → run_failed → retry ladder;
 * fail-lint artifact → doc-repair run → repair gate; hang + short
 * timeout → run_killed → retry.
 *
 * Gate modes: `minimal` and `plan-package` chains (full is the happy
 * path) — assert only the mode's gates surface.
 */
import { join } from 'node:path';
import { REVIEW_PASSES } from '@sprint-runner/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FixtureWorld,
  type MockScript,
  type ScriptedRunInfo,
  WS,
  findingsFragment,
  makeFixtureWorld,
  rsDoc,
  tddDoc,
  vsDoc,
  testReport,
  ticketMd,
} from '../helpers/fixtures.js';

let world: FixtureWorld | null = null;
afterEach(async () => {
  await world?.dispose();
  world = null;
});

const T = 'SR-0001';

/** Generic happy-path script — works for any ticket id (SR-0001 and
 *  SR-0003 both flow under it). */
function happyScript(r: ScriptedRunInfo): MockScript {
  const td = r.ticketDir as string;
  const id = r.ticketId ?? r.subject;
  switch (r.stage) {
    case 'triage':
      if (r.attempt === 1) {
        return {
          sentinel: 'NEEDS-INFO: 2',
          files: {
            [join(td, 'triage.json')]: {
              round: 1,
              questions: [
                { id: 'q1', text: 'Backoff ceiling?', status: 'open' },
                { id: 'q2', text: 'Retry 4xx?', status: 'open' },
              ],
            },
          },
        };
      }
      return {
        sentinel: 'READY',
        files: {
          [join(td, 'triage.json')]: {
            round: r.attempt,
            questions: [],
            suggestions: { depth: 'standard' },
          },
        },
      };
    case 'prd':
      return {
        sentinel: 'PRD-WRITTEN',
        files: { [join(td, 'rs.md')]: rsDoc(id) },
      };
    case 'design':
      if (r.attempt === 1) {
        return {
          sentinel: 'DESIGN-QA: 1',
          files: {
            [join(td, 'design.json')]: {
              questions: [
                { id: 'd1', text: 'Cap max backoff at?', status: 'open' },
              ],
            },
          },
        };
      }
      return {
        sentinel: 'TDD-WRITTEN',
        files: { [join(td, 'tdd.md')]: tddDoc(id) },
      };
    case 'testplan':
      return {
        sentinel: 'TESTPLAN-WRITTEN',
        files: { [join(td, 'vs.md')]: vsDoc(id) },
      };
    case 'implement':
      return { sentinel: 'DONE', artifacts: { 'result.json': { ok: true } } };
    case 'verify':
      return {
        sentinel: 'DONE',
        artifacts: { 'test-report.json': testReport() },
      };
    case 'review': {
      const pass = REVIEW_PASSES[
        (r.attempt - 1) % REVIEW_PASSES.length
      ] as string;
      return {
        sentinel: `PASS-COMPLETE: ${pass}`,
        artifacts: {
          [`findings-${pass}.json`]: findingsFragment([
            {
              file: 'src/app.ts',
              line: 1,
              severity: 'nit',
              category: 'style',
              body: `nit from ${pass} pass`,
            },
          ]),
        },
      };
    }
    case 'fix':
      return { sentinel: 'FIXES-COMPLETE: 1/1' };
    case 'doc-repair':
      return { sentinel: 'REPAIRED' };
    default:
      return 'done';
  }
}

/** Doc stages with zero Q&A — used under compressed gate modes. */
function straightThroughScript(r: ScriptedRunInfo): MockScript {
  if (r.stage === 'design') {
    return {
      sentinel: 'TDD-WRITTEN',
      files: {
        [join(r.ticketDir as string, 'tdd.md')]: tddDoc(
          r.ticketId ?? r.subject,
        ),
      },
    };
  }
  return happyScript(r);
}

const FULL_GATES = [
  'needs-info',
  'prd-review',
  'design-qa',
  'tdd-review',
  'test-review',
  'test-approved',
  'changes-requested',
  'approved',
];

describe('e2e pipeline (wp-040)', () => {
  it(
    'happy path: imported → pr-open across every gate',
    { timeout: 240_000 },
    async () => {
      world = await makeFixtureWorld({ script: happyScript });

      await world.runToStatus(T, 'needs-info');
      const ni = await world.store.getGateItem({
        workspace: world.workspace,
        subject: T,
        gate: 'needs-info',
      });
      expect(ni?.kind).toBe('question');
      await world.clearGate(T, 'needs-info', {
        answers: ['30s ceiling', 'no'],
      });

      await world.runToStatus(T, 'prd-review');
      expect(
        await world.store.getDoc({ workspace: WS, subject: T, doc: 'rs.md' }),
      ).not.toBeNull();
      await world.clearGate(T, 'prd-review');

      await world.runToStatus(T, 'design-qa');
      await world.clearGate(T, 'design-qa', { answers: ['cap at 30s'] });

      await world.runToStatus(T, 'tdd-review');
      await world.clearGate(T, 'tdd-review');

      await world.runToStatus(T, 'test-review');
      await world.clearGate(T, 'test-review');

      // spend checkpoint — status test-approved, THEN the gate surfaces.
      await world.runToStatus(T, 'test-approved');
      await world.waitForGate(T, 'test-approved');
      await world.clearGate(T, 'test-approved'); // human "go implement"

      await world.runToStatus(T, 'in-progress');
      await world.runToStatus(T, 'changes-requested');
      await world.clearGate(T, 'changes-requested'); // approve findings

      await world.runToStatus(T, 'approved');
      await world.waitForGate(T, 'approved');
      await world.clearGate(T, 'approved'); // "approve & open PR"

      await world.runToStatus(T, 'pr-open');

      // ---- assertions: row truth + doc_versions + artifacts (D29) ----
      expect(await world.docStatus(T)).toBe('pr-open');
      for (const doc of ['rs.md', 'tdd.md', 'vs.md'] as const) {
        expect(
          await world.store.getDoc({ workspace: WS, subject: T, doc }),
          `missing doc ${doc}`,
        ).not.toBeNull();
      }
      // Structured output lives in run_artifacts — review.json,
      // test-report.json, triage.json, design.json land on their runs.
      const artifactNames = new Set<string>();
      for (const r of await world.runsFor(T)) {
        for (const a of await world.store.listArtifacts(r.id)) {
          artifactNames.add(a.name.split('/').pop() as string);
        }
      }
      for (const name of [
        'review.json',
        'test-report.json',
        'triage.json',
        'design.json',
      ]) {
        expect(artifactNames, `missing artifact ${name}`).toContain(name);
      }

      // Ordered event chain — the events table is the ledger (D29).
      const events = await world.eventsFor(T);
      const names = events.map((e) => e.event);
      const idx = (n: string) => names.indexOf(n);
      const lastIdx = (n: string) => names.lastIndexOf(n);
      for (const e of [
        'spec_scored',
        'run_started',
        'run_finished',
        'question_asked',
        'question_answered',
        'doc_drafted',
        'doc_approved',
        'ci_green',
        'gate_approved',
        'pr_opened',
      ]) {
        expect(names, `missing event ${e}`).toContain(e);
      }
      expect(idx('spec_scored')).toBeLessThan(idx('run_started'));
      expect(idx('question_asked')).toBeLessThan(idx('question_answered'));
      expect(idx('doc_drafted')).toBeLessThan(lastIdx('doc_approved'));
      expect(idx('ci_green')).toBeLessThan(lastIdx('pr_opened'));

      // Every full-mode gate surfaced and was cleared.
      const items = await world.gateItems();
      const surfaced = new Set(
        items.filter((g) => g.subject === T).map((g) => g.gate),
      );
      for (const g of FULL_GATES)
        expect(surfaced, `gate ${g} never surfaced`).toContain(g);
      expect(
        items.filter((g) => g.subject === T && g.cleared_at === null),
        'un-cleared gates remain',
      ).toHaveLength(0);

      // 4 review passes each merged findings; verify ran the suite.
      const runs = await world.runsFor(T);
      const reviewRuns = runs.filter((r) => r.stage === 'review');
      expect(reviewRuns).toHaveLength(REVIEW_PASSES.length);
      expect(runs.find((r) => r.stage === 'verify')?.status).toBe('done');
      expect(
        runs.every((r) => r.status === 'done'),
        `non-done runs: ${runs.map((r) => `${r.stage}#${r.attempt}:${r.status}`).join(',')}`,
      ).toBe(true);
    },
  );

  it(
    'garbage sentinel → run_failed → retry ladder → ticket failed',
    { timeout: 120_000 },
    async () => {
      world = await makeFixtureWorld({
        script: (r) =>
          r.subject === T && r.stage === 'triage' ? 'garbage-sentinel' : 'done',
        tickets: { 'SR-0002': null, 'SR-0003': null },
      });
      await world.runToStatus(T, 'failed');
      const runs = await world.runsFor(T);
      const triageRuns = runs.filter((r) => r.stage === 'triage');
      // 1 transient retry, then exhausted.
      expect(triageRuns).toHaveLength(2);
      expect(triageRuns.every((r) => r.status === 'failed')).toBe(true);
      expect(await world.docStatus(T)).toBe('failed');
      const names = (await world.eventsFor(T)).map((e) => e.event);
      expect(names.filter((e) => e === 'run_failed')).toHaveLength(2);
    },
  );

  it(
    'lint-failing doc → doc-repair run → repair gate',
    { timeout: 120_000 },
    async () => {
      world = await makeFixtureWorld({
        tickets: {
          'SR-0001': null,
          'SR-0002': null,
          'SR-0003': null,
          'SR-0009': ticketMd({ id: 'SR-0009', status: 'prd-approved' }),
        },
        script: (r) => {
          const td = r.ticketDir as string;
          if (r.stage === 'design') {
            return {
              sentinel: 'TDD-WRITTEN',
              files: {
                [join(td, 'tdd.md')]: '# TDD\n\nno file plan table at all\n',
              },
            };
          }
          // doc-repair "fixes" nothing — the re-lint still fails.
          if (r.stage === 'doc-repair') return { sentinel: 'REPAIRED' };
          return 'done';
        },
      });
      const gate = await world.waitForGate('SR-0009', 'repair');
      expect(gate.kind).toBe('repair');
      expect(gate.blocked_agent).toBe(true);
      const runs = await world.runsFor('SR-0009');
      expect(runs.find((r) => r.stage === 'doc-repair')?.status).toBe('done');
      const names = (await world.eventsFor('SR-0009')).map((e) => e.event);
      expect(names).toContain('doc_feedback');
      expect(names).toContain('doc_repaired');
      // ticket stays tdd-draft — the repair gate waits for a human.
      expect((await world.readTicket('SR-0009')).status).toBe('tdd-draft');
    },
  );

  it(
    'hang + short timeout → run_killed → auto retry succeeds',
    { timeout: 120_000 },
    async () => {
      world = await makeFixtureWorld({
        configOverrides: { timeouts: { triage: 1 } },
        tickets: { 'SR-0002': null, 'SR-0003': null },
        script: (r) =>
          r.subject === T && r.stage === 'triage' && r.attempt === 1
            ? { hang: true }
            : {
                sentinel: 'NEEDS-INFO: 1',
                files: {
                  [join(r.ticketDir as string, 'triage.json')]: {
                    questions: [{ id: 'q1', text: 'q?', status: 'open' }],
                  },
                },
              },
      });
      // Attempt 1 hangs; the timeout sweep kills it (run_killed), the
      // retry ladder re-queues triage, and attempt 2 lands NEEDS-INFO.
      await world.runToStatus(T, 'needs-info');
      const runs = await world.runsFor(T);
      const triage = runs.filter((r) => r.stage === 'triage');
      expect(triage.map((r) => r.status)).toEqual(['killed', 'done']);
      const names = (await world.eventsFor(T)).map((e) => e.event);
      expect(names).toContain('run_killed');
      expect(names).toContain('question_asked');
      expect(await world.docStatus(T)).toBe('needs-info');
    },
  );

  it(
    'gates: minimal — only answer/review/approval gates surface',
    { timeout: 240_000 },
    async () => {
      world = await makeFixtureWorld({
        configOverrides: { gates: 'minimal' },
        tickets: { 'SR-0001': null, 'SR-0002': null },
        script: straightThroughScript,
      });
      // SR-0003 (ready) flows with zero doc gates until the spend-less
      // tail: changes-requested + approved are the only surfaces.
      await world.runToStatus('SR-0003', 'changes-requested');
      await world.clearGate('SR-0003', 'changes-requested');
      await world.waitForGate('SR-0003', 'approved');
      await world.clearGate('SR-0003', 'approved');
      await world.runToStatus('SR-0003', 'pr-open');

      const surfaced = new Set((await world.gateItems()).map((g) => g.gate));
      for (const suppressed of [
        'prd-review',
        'tdd-review',
        'test-review',
        'test-approved',
        'ci-watch',
        'plan-package',
      ]) {
        expect(
          surfaced,
          `${suppressed} must not surface in minimal`,
        ).not.toContain(suppressed);
      }
      expect(surfaced).toEqual(new Set(['changes-requested', 'approved']));
      expect(await world.docStatus('SR-0003')).toBe('pr-open');
    },
  );

  it(
    'gates: plan-package — the three doc reviews collapse into one gate',
    { timeout: 240_000 },
    async () => {
      world = await makeFixtureWorld({
        configOverrides: { gates: 'plan-package' },
        tickets: { 'SR-0001': null, 'SR-0002': null },
        script: straightThroughScript,
      });
      // Docs auto-approve until the single plan-package gate at
      // test-review; clearing it IS the go-implement checkpoint.
      const gate = await world.waitForGate('SR-0003', 'plan-package');
      expect(gate.kind).toBe('review');
      await world.clearGate('SR-0003', 'plan-package');

      await world.runToStatus('SR-0003', 'changes-requested');
      await world.clearGate('SR-0003', 'changes-requested');
      await world.waitForGate('SR-0003', 'approved');
      await world.clearGate('SR-0003', 'approved');
      await world.runToStatus('SR-0003', 'pr-open');

      const surfaced = new Set((await world.gateItems()).map((g) => g.gate));
      expect(surfaced).toEqual(
        new Set(['plan-package', 'changes-requested', 'approved']),
      );
    },
  );
});
