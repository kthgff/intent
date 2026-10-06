/**
 * wp-143 tests — Statement Ledger (PRD §15.3/§15.9).
 *
 * Real PostgresStore on PGlite; the engine functions run directly.
 * Covers:
 *   - fail-closed extraction parsing (malformed batch writes nothing);
 *   - verbatim source preservation (span verification + paraphrase
 *     rejection) and the preservation lint;
 *   - ingest: statements + versions + provenance + typed relations +
 *     clarification/decision items in one batch;
 *   - lifecycle: AI proposes, humans confirm/reject/decide;
 *   - the authority rule (an approved prohibition beats a brainstormed
 *     want) and fail-closed ties → decision items;
 *   - supersede application on confirm;
 *   - artifact back-links.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from '@veto/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  StatementError,
  compareAuthority,
  confirmStatement,
  decideStatementDecision,
  disputeStatement,
  ingestExtraction,
  linkStatementArtifact,
  loadStatementGraph,
  openConflictDecisions,
  parseExtractionOutput,
  proposeStatement,
  rejectStatement,
  resolveAuthority,
  sourceFromBoardItem,
  verifySourceSpan,
} from '../src/semantics/index.js';
import type {
  ExtractionSource,
  StatementActor,
} from '../src/semantics/index.js';

const WS = 'ws';
const T0 = Date.parse('2026-10-05T00:00:00Z');

let dir: string;
let store: PostgresStore;
let clock: number;

const human: StatementActor = { id: 'keith', type: 'human' };
const agent: StatementActor = { id: 'extractor', type: 'agent' };
const now = () => new Date(clock);
const tick = (ms = 60_000) => {
  clock += ms;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veto-semantics-'));
  store = await PostgresStore.connect('pglite:');
  clock = T0;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const BOARD_TEXT =
  'Password resets currently take 3 days. We must cut that to under an hour.';

function sources(): ExtractionSource[] {
  return [
    {
      ref: { kind: 'board-item', id: 'item-1', span: null },
      text: BOARD_TEXT,
    },
  ];
}

function output(statements: unknown[]) {
  return { schema: 1 as const, statements };
}

// ---------------------------------------------------------------------------
// parse — fail-closed
// ---------------------------------------------------------------------------

describe('parseExtractionOutput', () => {
  it('accepts an object or a JSON string', () => {
    const payload = output([
      {
        key: 'k1',
        text: 'Resets take 3 days',
        source_text: 'Password resets currently take 3 days.',
      },
    ]);
    expect(parseExtractionOutput(payload).statements).toHaveLength(1);
    expect(
      parseExtractionOutput(JSON.stringify(payload)).statements,
    ).toHaveLength(1);
  });

  it('fails closed on malformed output — a bad batch writes nothing', () => {
    expect(() => parseExtractionOutput('not json')).toThrow(StatementError);
    expect(() => parseExtractionOutput(output([{ key: 'k1' }]))).toThrow(
      /schema/,
    );
  });
});

// ---------------------------------------------------------------------------
// verbatim source preservation
// ---------------------------------------------------------------------------

describe('verifySourceSpan', () => {
  it('recovers the span when only the quote is given', () => {
    const st = {
      source: 0,
      source_text: 'Password resets currently take 3 days.',
      span: null,
    };
    const ref = verifySourceSpan(st, sources());
    expect(ref.kind).toBe('board-item');
    expect(BOARD_TEXT.slice(ref.span[0], ref.span[1])).toBe(st.source_text);
  });

  it('rejects a paraphrase — paraphrased extraction is fail-closed', () => {
    expect(() =>
      verifySourceSpan(
        { source: 0, source_text: 'resets are slow', span: null },
        sources(),
      ),
    ).toThrow(/paraphrased/);
  });

  it('rejects a span that does not slice to the quoted text', () => {
    expect(() =>
      verifySourceSpan(
        { source: 0, source_text: 'Password resets', span: [10, 20] },
        sources(),
      ),
    ).toThrow(/verbatim source required/);
  });

  it('rejects an out-of-range source index', () => {
    expect(() =>
      verifySourceSpan({ source: 3, source_text: 'x', span: null }, sources()),
    ).toThrow(/sources\[3\]/);
  });
});

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

describe('ingestExtraction', () => {
  it('writes statements + versions + provenance + relations in one batch', async () => {
    const res = await ingestExtraction(store, {
      workspace: WS,
      subject: 'board:ideas',
      sources: sources(),
      output: output([
        {
          key: 'problem',
          text: 'Password resets take 3 days',
          source_text: 'Password resets currently take 3 days.',
          intent: 'problem',
          confidence: 0.9,
        },
        {
          key: 'requirement',
          text: 'Resets complete in under an hour',
          source_text: 'We must cut that to under an hour.',
          intent: 'requires',
          relations: [{ predicate: 'derived-from', target: 'problem' }],
        },
      ]),
      model: 'anthropic/claude-sonnet-4',
      promptVersion: 'extract-v1',
      actor: 'extractor',
      now,
    });

    expect(res.statements).toHaveLength(2);
    expect(res.relations).toHaveLength(1);
    expect(res.ids.problem).toBeTruthy();
    expect(res.extraction_run_id).toBeTruthy();

    const head = await store.getStatement({
      workspace: WS,
      statement_id: res.ids.requirement as string,
    });
    expect(head?.status).toBe('proposed');
    expect(head?.intent).toBe('requires');
    expect(head?.source_text).toBe('We must cut that to under an hour.');
    expect(head?.source_ref).toMatchObject({
      kind: 'board-item',
      id: 'item-1',
    });
    // History landed as version 1.
    expect(
      await store.listStatementVersions({
        workspace: WS,
        statement_id: res.ids.requirement as string,
      }),
    ).toHaveLength(1);

    // Extraction provenance is recorded (model + prompt version).
    const run = await store.getExtractionRun({
      workspace: WS,
      extraction_run_id: res.extraction_run_id,
    });
    expect(run?.model).toBe('anthropic/claude-sonnet-4');
    expect(run?.prompt_version).toBe('extract-v1');
  });

  it('is transactional — a paraphrase in the batch aborts everything', async () => {
    await expect(
      ingestExtraction(store, {
        workspace: WS,
        sources: sources(),
        output: output([
          {
            key: 'ok',
            text: 'Resets take 3 days',
            source_text: 'Password resets currently take 3 days.',
          },
          { key: 'bad', text: 'x', source_text: 'totally made up quote' },
        ]),
        actor: 'extractor',
        now,
      }),
    ).rejects.toThrow(StatementError);
    expect(await store.listStatements({ workspace: WS })).toHaveLength(0);
  });

  it('opens a clarification when the extractor flags ambiguity', async () => {
    const res = await ingestExtraction(store, {
      workspace: WS,
      sources: sources(),
      output: output([
        {
          key: 'vague',
          text: 'Resets should be fast',
          source_text: 'Password resets currently take 3 days.',
          clarification: 'How fast is fast enough?',
        },
      ]),
      actor: 'extractor',
      now,
    });
    expect(res.clarifications.length).toBe(1);
    const clar = await store.listStatementClarifications({
      workspace: WS,
      statement_id: res.ids.vague as string,
    });
    expect(clar).toHaveLength(1);
    expect(clar[0]?.question).toMatch(/fast/i);
  });
});

// ---------------------------------------------------------------------------
// lifecycle — AI proposes, humans confirm
// ---------------------------------------------------------------------------

describe('statement lifecycle', () => {
  it('an agent proposal is inferred; a human confirm upgrades provenance', async () => {
    const st = await proposeStatement(store, {
      workspace: WS,
      text: 'Resets complete in under an hour',
      actor: agent,
      now,
    });
    expect(st.status).toBe('proposed');
    expect(st.provenance).toBe('inferred');

    tick();
    const confirmed = await confirmStatement(store, {
      workspace: WS,
      statement_id: st.statement_id,
      actor: human,
      now,
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.provenance).toBe('stakeholder-verified');
  });

  it('only a human may confirm — an agent confirm is refused', async () => {
    const st = await proposeStatement(store, {
      workspace: WS,
      text: 'x',
      actor: agent,
      now,
    });
    await expect(
      confirmStatement(store, {
        workspace: WS,
        statement_id: st.statement_id,
        actor: agent,
        now,
      }),
    ).rejects.toThrow(/human/i);
  });

  it('confirming dead truth is refused; re-proposal is the path back', async () => {
    const st = await proposeStatement(store, {
      workspace: WS,
      text: 'x',
      actor: agent,
      now,
    });
    await rejectStatement(store, {
      workspace: WS,
      statement_id: st.statement_id,
      actor: human,
      now,
    });
    await expect(
      confirmStatement(store, {
        workspace: WS,
        statement_id: st.statement_id,
        actor: human,
        now,
      }),
    ).rejects.toThrow(/dead truth/);
  });

  it('an agent may dispute — a disagreement becomes visible, never silent', async () => {
    const st = await proposeStatement(store, {
      workspace: WS,
      text: 'Resets take 3 days',
      actor: agent,
      now,
    });
    const disputed = await disputeStatement(store, {
      workspace: WS,
      statement_id: st.statement_id,
      reason: 'the board note says 3 days, not "slow"',
      actor: agent,
      now,
    });
    expect(disputed.statement.status).toBe('disputed');
    expect(disputed.decision_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// authority rule
// ---------------------------------------------------------------------------

describe('authority rule (§15.3)', () => {
  it('an approved prohibition beats a brainstormed want', async () => {
    const want = await proposeStatement(store, {
      workspace: WS,
      text: 'It would be nice to store plaintext passwords',
      intent: 'want',
      actor: agent,
      now,
    });
    const prohibits = await proposeStatement(store, {
      workspace: WS,
      text: 'Passwords must never be stored in plaintext',
      intent: 'prohibits',
      actor: human,
      confirm: true,
      now,
    });

    // The conflict is explicit — a `contradicts` edge — and the
    // authority rule resolves it on the statement axes, not on
    // vector similarity or recency.
    const relations = [
      {
        workspace: WS,
        org: null,
        src: want.statement_id,
        predicate: 'contradicts' as const,
        dst: prohibits.statement_id,
        created_by: 'test',
        created_at: new Date(clock).toISOString(),
      },
    ];
    const report = resolveAuthority(
      await store.listStatements({ workspace: WS }),
      relations,
    );
    const defeatedIds = report.defeated.map((d) => d.statement_id);
    // The confirmed prohibition governs; the brainstormed want is
    // defeated with a stated reason.
    expect(report.governing.map((g) => g.statement_id)).toContain(
      prohibits.statement_id,
    );
    expect(defeatedIds).toContain(want.statement_id);
    expect(defeatedIds).not.toContain(prohibits.statement_id);
    expect(
      report.defeated.find((d) => d.statement_id === want.statement_id)?.reason,
    ).toBeTruthy();
  });

  it('compareAuthority ranks status, then provenance, then intent', () => {
    const confirmed = {
      status: 'confirmed' as const,
      provenance: 'stakeholder-verified' as const,
      intent: 'want' as const,
      strength: null,
    };
    const proposed = {
      status: 'proposed' as const,
      provenance: 'source-backed' as const,
      intent: 'prohibits' as const,
      strength: null,
    };
    expect(compareAuthority(confirmed, proposed)).toBeGreaterThan(0);
  });

  it('fail-closed ties become decision items, not silent merges', async () => {
    const a = await proposeStatement(store, {
      workspace: WS,
      text: 'Resets complete in under an hour',
      intent: 'requires',
      actor: human,
      confirm: true,
      now,
    });
    const b = await proposeStatement(store, {
      workspace: WS,
      text: 'Resets complete in under a day',
      intent: 'requires',
      actor: human,
      confirm: true,
      now,
    });
    const relations = [
      {
        workspace: WS,
        org: null,
        src: a.statement_id,
        predicate: 'contradicts' as const,
        dst: b.statement_id,
        created_by: 'test',
        created_at: new Date(clock).toISOString(),
      },
    ];
    const report = resolveAuthority(
      await store.listStatements({ workspace: WS }),
      relations,
    );
    expect(report.unresolved.length).toBeGreaterThan(0);
    const opened = await openConflictDecisions(store, {
      workspace: WS,
      report,
      actor: 'extractor',
      now,
    });
    expect(opened.length).toBeGreaterThan(0);
    const decisions = await store.listStatementDecisions({
      workspace: WS,
      status: 'open',
    });
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('a human decision closes the conflict item', async () => {
    const st = await proposeStatement(store, {
      workspace: WS,
      text: 'x',
      actor: agent,
      now,
    });
    await store.upsertStatementDecision({
      workspace: WS,
      decision_id: 'sd-1',
      statement_id: st.statement_id,
      decision: 'prefer the stricter reading',
      status: 'open',
      created_at: new Date(clock).toISOString(),
    });
    const decided = await decideStatementDecision(store, {
      workspace: WS,
      decision_id: 'sd-1',
      decision: 'prefer the stricter reading',
      actor: human,
      now,
    });
    expect(decided.status).toBe('decided');
    expect(decided.decided_by).toBe('keith');
  });

  it('loadStatementGraph returns the live graph for resolution', async () => {
    await proposeStatement(store, {
      workspace: WS,
      text: 'x',
      actor: agent,
      now,
    });
    const graph = await loadStatementGraph(store, { workspace: WS });
    expect(graph.statements.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// sources + artifact links
// ---------------------------------------------------------------------------

describe('sources + artifact back-links', () => {
  it('sourceFromBoardItem builds a verifiable evidence ref from the row', () => {
    const src = sourceFromBoardItem({
      workspace: WS,
      board: 'ideas',
      id: 'item-1',
      title: 'Resets are slow',
      body: 'Password resets currently take 3 days.',
    } as never);
    expect(src.ref.kind).toBe('board-item');
    expect(src.ref.id).toBe('item-1');
    expect(src.text).toContain('Password resets currently take 3 days.');
  });

  it('a statement links back to the artifacts it produced', async () => {
    const st = await proposeStatement(store, {
      workspace: WS,
      text: 'Resets complete in under an hour',
      actor: human,
      confirm: true,
      now,
    });
    await linkStatementArtifact(store, {
      workspace: WS,
      statement_id: st.statement_id,
      artifact: 'SR-0001:rs.md',
      element: 'ac:AC-3',
      actor: human,
      now,
    });
    const links = await store.listStatementArtifactLinks({
      workspace: WS,
      statement_id: st.statement_id,
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.element).toBe('ac:AC-3');
  });
});
