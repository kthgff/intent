/**
 * Extraction ingest pipeline (wp-143, PRD §15.3/§15.9) — turns one
 * batch of evidence sources + the LLM's `statements.json` output into
 * persisted semantic_statements with full provenance.
 *
 * Fail-closed contract (AGENTS.md — malformed structured output blocks
 * the pipeline):
 *  - the output must satisfy {@link ExtractionOutputSchema};
 *  - every statement's `source_text` must appear VERBATIM in its
 *    source (span-checked when `span` is given, located otherwise);
 *  - relation targets must resolve to a batch key or an existing
 *    statement_id;
 *  - no self-edges, no duplicate batch keys.
 * Any violation throws {@link StatementError} and writes nothing
 * (single transaction).
 *
 * Lifecycle rules applied on write (never silent truth):
 *  - extracted statements land `proposed` + `source-backed` (the span
 *    was verified against the evidence) — `inferred` never
 *    auto-approves, and nothing an AI emits lands `confirmed` or
 *    `stakeholder-verified`;
 *  - CONSEQUENTIAL statements (binding intents prohibits|requires|
 *    constraint|decision, or strength `must`) get an open
 *    statement_decisions row — the human confirmation request;
 *  - extractor-flagged ambiguities and preservation-lint violations
 *    get statement_clarifications rows;
 *  - `contradicts` edges flip a live target to `disputed` + open a
 *    decision item (§15.9 — disagreement is a decision, not a merge);
 *  - `supersedes` edges against CONFIRMED targets open a decision
 *    item — an unconfirmed draft never silently retires confirmed
 *    truth (authority rule, INTELLIGENCE §5).
 */
import { randomUUID } from 'node:crypto';
import type {
  ExtractedStatement,
  StatementRelationRow,
  StatementRow,
  Store,
} from '@sprint-runner/core';
import { ExtractionOutputSchema } from '@sprint-runner/core';
import {
  type PreservationViolation,
  extractionPreservationLint,
  locateQuote,
} from '@sprint-runner/lints';
import { EXTRACT_PROMPT_VERSION, buildExtractionPrompt } from './prompt.js';
import { type ExtractionSource, StatementError } from './types.js';

/** Binding intents whose assertions shape what may be built — these
 *  are "consequential interpretations" (§15.3) that require a human
 *  confirmation request rather than silently becoming truth. */
export const CONSEQUENTIAL_INTENTS = new Set([
  'prohibits',
  'requires',
  'constraint',
  'decision',
]);

/** True when the statement must route through human confirmation —
 *  a binding intent or `must` strength (risk-based confirmation,
 *  §15.9). */
export function isConsequential(
  s: Pick<ExtractedStatement, 'intent' | 'strength'>,
): boolean {
  return (
    (s.intent != null && CONSEQUENTIAL_INTENTS.has(s.intent)) ||
    s.strength === 'must'
  );
}

/** `[start, end)` char offsets — statement.source_ref.span. */
export type SourceSpan = [number, number];

export interface IngestExtractionArgs {
  workspace: string;
  org?: string | null;
  /** What the batch was extracted from — e.g. `board:<slug>`,
   *  `session:<id>`, `import:<key>`, `doc:<subject>:<doc>` (stamped on
   *  semantic_extraction_runs.subject). */
  subject?: string | null;
  /** Evidence documents, in the same order the extractor saw them —
   *  `ExtractedStatement.source` indexes this array. */
  sources: ExtractionSource[];
  /** The extractor's `statements.json` payload — raw JSON text or an
   *  already-parsed value; validated fail-closed. */
  output: unknown;
  /** runs.id that produced the extraction (provenance). */
  run?: string | null;
  /** Model that produced the output (semantic_extraction_runs.model). */
  model?: string | null;
  /** Prompt version (semantic_extraction_runs.prompt_version). */
  promptVersion?: string | null;
  /** Caller-assigned extraction_run id — default `xr-<uuid8>`. Reusing
   *  an existing id fails on the PK (a run is one batch). */
  extractionRunId?: string;
  /** statement_id prefix — default `st`. */
  idPrefix?: string;
  /** created_by on every written row. */
  actor: string;
  now?: () => Date;
}

export interface IngestExtractionResult {
  extraction_run_id: string;
  /** Head rows written, in batch order. */
  statements: StatementRow[];
  /** key → statement_id mapping for the batch. */
  ids: Record<string, string>;
  relations: StatementRelationRow[];
  /** Clarifications opened (extractor ambiguity + lint violations). */
  clarifications: string[];
  /** Decision items opened (consequential confirms + conflicts). */
  decisions: string[];
  /** Preservation-lint violations observed (also in run stats). */
  violations: PreservationViolation[];
}

/** Slug a batch key for use inside a statement_id. */
function slugKey(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'x';
}

/** Parse + schema-validate the extractor output. Throws on anything
 *  malformed — a bad batch writes nothing. */
export function parseExtractionOutput(output: unknown): {
  statements: ExtractedStatement[];
} {
  let raw = output;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      throw new StatementError(
        `extraction output is not valid JSON: ${(e as Error).message}`,
      );
    }
  }
  const parsed = ExtractionOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StatementError(
      `extraction output fails the statements.json schema: ${parsed.error.message}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/**
 * Verify + resolve the statement's source span: `source_text` must be
 * a verbatim substring of `sources[source].text` — when `span` is
 * supplied it must slice to exactly `source_text`; otherwise the quote
 * is located and the span recovered. Returns the stored source_ref.
 */
export function verifySourceSpan(
  st: Pick<ExtractedStatement, 'source' | 'source_text' | 'span'>,
  sources: ExtractionSource[],
): { kind: ExtractionSource['ref']['kind']; id: string; span: SourceSpan } {
  const src = sources[st.source];
  if (!src) {
    throw new StatementError(
      `statement references sources[${st.source}] but only ${sources.length} source(s) were provided`,
    );
  }
  if (st.span) {
    const [start, end] = st.span;
    const sliced = src.text.slice(start, end);
    if (sliced !== st.source_text) {
      throw new StatementError(
        `source_text does not match span [${start},${end}) of ${src.ref.kind}:${src.ref.id} — verbatim source required (§15.3), got a paraphrase`,
        { expected: sliced, got: st.source_text },
      );
    }
    return { kind: src.ref.kind, id: src.ref.id, span: [start, end] };
  }
  const span = locateQuote(src.text, st.source_text);
  if (span === null) {
    throw new StatementError(
      `source_text is not a verbatim substring of ${src.ref.kind}:${src.ref.id} — paraphrased extraction is fail-closed (§15.3)`,
      { got: st.source_text },
    );
  }
  return { kind: src.ref.kind, id: src.ref.id, span };
}

/**
 * Ingest one extraction batch. One transaction: the extraction_run
 * provenance row, every statement head+version, typed relations, and
 * the clarification/decision items the batch surfaced.
 */
export async function ingestExtraction(
  store: Store,
  args: IngestExtractionArgs,
): Promise<IngestExtractionResult> {
  if (args.sources.length === 0) {
    throw new StatementError('ingestExtraction: at least one source required');
  }
  const out = parseExtractionOutput(args.output);
  const runId = args.extractionRunId ?? `xr-${randomUUID().slice(0, 8)}`;
  const prefix = args.idPrefix ?? 'st';
  const actor = args.actor;
  const ts = (args.now?.() ?? new Date()).toISOString();

  // ---- validate the whole batch before writing anything -----------
  const keys = new Set<string>();
  const ids: Record<string, string> = {};
  const idSet = new Set<string>();
  for (const st of out.statements) {
    if (keys.has(st.key)) {
      throw new StatementError(`duplicate batch key '${st.key}'`);
    }
    keys.add(st.key);
    const id = `${prefix}-${runId}-${slugKey(st.key)}`;
    if (idSet.has(id)) {
      throw new StatementError(
        `batch keys collide on statement_id '${id}' (distinct keys must slug distinctly)`,
      );
    }
    idSet.add(id);
    ids[st.key] = id;
  }

  interface PlannedStatement {
    st: ExtractedStatement;
    id: string;
    sourceRef: { kind: string; id: string; span: SourceSpan };
  }
  const planned: PlannedStatement[] = out.statements.map((st) => ({
    st,
    id: ids[st.key] as string,
    sourceRef: verifySourceSpan(st, args.sources),
  }));

  // Resolve relation targets: batch key → new id; otherwise an
  // existing ledger statement_id (must exist — fail-closed).
  const plannedRelations: StatementRelationRow[] = [];
  for (const { st, id } of planned) {
    for (const rel of st.relations ?? []) {
      let dst = rel.target;
      if (rel.target in ids) {
        dst = ids[rel.target] as string;
      } else {
        const existing = await store.getStatement({
          workspace: args.workspace,
          statement_id: rel.target,
        });
        if (!existing) {
          throw new StatementError(
            `statement '${st.key}' ${rel.predicate} unknown target '${rel.target}' — not a batch key nor an existing statement_id`,
          );
        }
      }
      if (dst === id) {
        throw new StatementError(
          `statement '${st.key}' carries a self-edge (${rel.predicate}) — malformed output`,
        );
      }
      plannedRelations.push({
        workspace: args.workspace,
        org: args.org ?? null,
        src: id,
        predicate: rel.predicate,
        dst,
        created_by: actor,
        created_at: ts,
      });
    }
  }

  // ---- preservation lint per source (§15.9 eval gate) -------------
  const violations: PreservationViolation[] = [];
  const lintByKey = new Map<string, PreservationViolation[]>();
  args.sources.forEach((src, i) => {
    const members = planned.filter((p) => p.st.source === i);
    const found = extractionPreservationLint(
      src.text,
      members.map((p) => ({
        key: p.st.key,
        text: p.st.text,
        source_text: p.st.source_text,
        polarity: p.st.polarity ?? null,
        intent: p.st.intent ?? null,
      })),
    );
    for (const f of found) {
      violations.push(f);
      if (f.statement !== undefined) {
        const list = lintByKey.get(f.statement) ?? [];
        list.push(f);
        lintByKey.set(f.statement, list);
      }
    }
  });

  // ---- one transaction: run provenance + statements + relations ---
  const decisions: string[] = [];
  const clarifications: string[] = [];
  const relations: StatementRelationRow[] = [];
  const statements: StatementRow[] = [];

  return store.transaction(async (s) => {
    await s.insertExtractionRun({
      workspace: args.workspace,
      org: args.org ?? null,
      extraction_run_id: runId,
      run: args.run ?? null,
      subject: args.subject ?? null,
      model: args.model ?? null,
      prompt_version: args.promptVersion ?? null,
      stats: {
        sources: args.sources.length,
        statements: planned.length,
        relations: plannedRelations.length,
        violations: violations.map((v) => ({
          rule: v.rule,
          cue: v.cue,
          statement: v.statement ?? null,
        })),
      },
      created_at: ts,
    });

    // Statement heads — `proposed`/`source-backed` always: AI
    // proposes, humans confirm; the span was verified verbatim.
    for (const { st, id, sourceRef } of planned) {
      const head = await s.upsertStatement({
        workspace: args.workspace,
        org: args.org ?? null,
        statement_id: id,
        text: st.text,
        source_text: st.source_text,
        source_ref: sourceRef,
        intent: st.intent ?? null,
        polarity: st.polarity ?? null,
        subject: st.subject ?? null,
        strength: st.strength ?? null,
        scope: st.scope ?? null,
        scope_ref: st.scope_ref ?? null,
        status: 'proposed',
        confidence: st.confidence ?? null,
        provenance: 'source-backed',
        extraction_run: runId,
        created_by: actor,
        created_at: ts,
        updated_at: ts,
      });
      statements.push(head);

      // Consequential interpretation → open decision item (the
      // confirmation request) — never silent truth.
      if (isConsequential(st)) {
        const decisionId = `sd-${id}-confirm`;
        await s.upsertStatementDecision({
          workspace: args.workspace,
          org: args.org ?? null,
          decision_id: decisionId,
          statement_id: id,
          decision: null,
          status: 'open',
          rationale: `AI-proposed ${st.intent ?? 'statement'}${
            st.strength === 'must' ? ' (must)' : ''
          } requires human confirmation — consequential interpretations never land silently (§15.9)`,
          decided_by: null,
          decided_at: null,
          created_by: actor,
          created_at: ts,
        });
        decisions.push(decisionId);
      }

      if (st.clarification) {
        const cid = `cl-${id}`;
        await s.upsertStatementClarification({
          workspace: args.workspace,
          org: args.org ?? null,
          clarification_id: cid,
          statement_id: id,
          question: st.clarification,
          answer: null,
          asked_by: actor,
          answered_by: null,
          created_at: ts,
          answered_at: null,
        });
        clarifications.push(cid);
      }

      // Preservation-lint violations bound to this statement → a
      // clarification each (the meaning is contested, not corrected).
      const bound = lintByKey.get(st.key) ?? [];
      for (let i = 0; i < bound.length; i++) {
        const cid = `cl-${id}-lint${i}`;
        await s.upsertStatementClarification({
          workspace: args.workspace,
          org: args.org ?? null,
          clarification_id: cid,
          statement_id: id,
          question: `[extraction lint] ${bound[i]?.message}`,
          answer: null,
          asked_by: 'extraction-lint',
          answered_by: null,
          created_at: ts,
          answered_at: null,
        });
        clarifications.push(cid);
      }
    }

    // Typed edges + their authority side-effects.
    for (const rel of plannedRelations) {
      await s.upsertStatementRelation(rel);
      relations.push(rel);

      if (rel.predicate === 'contradicts') {
        // A live target is now contested — flag it disputed and open
        // a decision item (§15.9: disagreement → decision, never a
        // silent merge). Dead targets stay dead.
        const dst = await s.getStatement({
          workspace: args.workspace,
          statement_id: rel.dst,
        });
        if (dst && (dst.status === 'proposed' || dst.status === 'confirmed')) {
          await s.upsertStatement({
            ...stripVersion(dst),
            status: 'disputed',
            created_by: actor,
            updated_at: ts,
          });
          const decisionId = `sd-${rel.dst}-dispute-${slugKey(rel.src)}`;
          await s.upsertStatementDecision({
            workspace: args.workspace,
            org: args.org ?? null,
            decision_id: decisionId,
            statement_id: rel.dst,
            decision: null,
            status: 'open',
            rationale: `contradicted by ${rel.src}`,
            decided_by: null,
            decided_at: null,
            created_by: actor,
            created_at: ts,
          });
          decisions.push(decisionId);
        }
      } else if (rel.predicate === 'supersedes') {
        // Only a confirmed target is protected — drafts supersede
        // provisionally (the edge records the claim; confirmation of
        // src applies it via the lifecycle).
        const dst = await s.getStatement({
          workspace: args.workspace,
          statement_id: rel.dst,
        });
        if (dst?.status === 'confirmed') {
          const decisionId = `sd-${rel.dst}-supersede-${slugKey(rel.src)}`;
          await s.upsertStatementDecision({
            workspace: args.workspace,
            org: args.org ?? null,
            decision_id: decisionId,
            statement_id: rel.dst,
            decision: null,
            status: 'open',
            rationale: `proposed ${rel.src} claims to supersede a confirmed statement — human ruling required (fail-closed)`,
            decided_by: null,
            decided_at: null,
            created_by: actor,
            created_at: ts,
          });
          decisions.push(decisionId);
        }
      }
    }

    return {
      extraction_run_id: runId,
      statements,
      ids,
      relations,
      clarifications,
      decisions,
      violations,
    };
  });
}

/** Strip `version` off a head row for re-upsert (upsertStatement
 *  assigns max+1 itself). */
function stripVersion(row: StatementRow): Omit<StatementRow, 'version'> {
  const { version: _v, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// runExtraction — the LLM-assist seam (§15.9 "LLM interprets/proposes")
// ---------------------------------------------------------------------------

export interface RunExtractionArgs
  extends Omit<IngestExtractionArgs, 'output' | 'promptVersion'> {
  /**
   * The caller's LLM surface — receives the deterministic extraction
   * prompt, returns raw model text. wp-145's interview orchestrator
   * and wp-139's import pass inject their model call here; the ingest
   * pipeline stays identical either way.
   */
  extract: (prompt: string) => Promise<string>;
  /** Existing statements for relation/dedup context in the prompt. */
  knownStatements?: { id: string; text: string; status?: string }[];
  /** Prompt version override — defaults to the shipped builder's. */
  promptVersion?: string;
}

/**
 * Full extraction pass: build the deterministic prompt → call the
 * injected LLM surface → fail-closed ingest (validate → span-verify →
 * persist → lifecycle side-effects). `prompt_version` recorded on the
 * extraction run is the builder's unless overridden.
 */
export async function runExtraction(
  store: Store,
  args: RunExtractionArgs,
): Promise<IngestExtractionResult> {
  const prompt = buildExtractionPrompt({
    sources: args.sources,
    ...(args.knownStatements ? { knownStatements: args.knownStatements } : {}),
  });
  const raw = await args.extract(prompt);
  return ingestExtraction(store, {
    ...args,
    output: raw,
    promptVersion: args.promptVersion ?? EXTRACT_PROMPT_VERSION,
  });
}

/**
 * Ingest a collected `statements.json` run artifact — the `extract`
 * agent stage's output path. Reads the artifact row, then runs the
 * same ingest. The caller supplies the `sources` the agent read —
 * spans are verified against them, not trusted from the model.
 */
export async function ingestStatementsArtifact(
  store: Store,
  args: Omit<IngestExtractionArgs, 'output'> & {
    runId: string;
    artifactName?: string;
  },
): Promise<IngestExtractionResult> {
  const name = args.artifactName ?? 'statements.json';
  const artifact = await store.getArtifact(args.runId, name);
  if (!artifact) {
    throw new StatementError(
      `ingestStatementsArtifact: run ${args.runId} has no artifact '${name}'`,
    );
  }
  return ingestExtraction(store, { ...args, output: artifact.content });
}
