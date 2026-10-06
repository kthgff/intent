/**
 * transitions/actions.ts — the mechanical helpers behind the
 * sentinel→transition table rows (wp-031; rewired wp-092 for D29).
 *
 * CONDUCTOR "Special paths" implemented here:
 *   - Suggestions application (triage READY → write backend/model/
 *     priority/depth into frontmatter; human-set fields win).
 *   - Split materialization (split-plan approve → allocate child ids,
 *     insert child tickets rows + ticket.md doc_versions, parent →
 *     `split`).
 *   - Stale-spec check (implement launch re-hashes spec inputs vs the
 *     hash recorded at spec completion → `stale-spec` inbox item).
 *   - Review merge (findings-<pass>.json fragments → review.json
 *     envelope with runner-computed fingerprints + thread ids, §6).
 *
 * D29: docs live in `doc_versions`, structured stage output in
 * `run_artifacts`, ids come from `projects.next_ticket_seq` — there is
 * no tickets repo and no ticket.md files on disk. The only filesystem
 * read left is the live `.veto/card.json` inside a CODE repo
 * (git-for-code is still real).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type DocKind,
  type FindingSeverity,
  REVIEW_PASSES,
  type TicketRow,
} from '@veto/core';
import { git, push } from '@veto/gitops';
import { fingerprint, matchThread, threadIdFor } from '@veto/lints';
import type { TransitionContext } from '../contracts.js';
import { promoteContracts } from '../decompose/contracts.js';
import type { DecompositionRow, PlanContract } from '../decompose/plan.js';
import { computeExecutionReadiness } from '../decompose/readiness.js';
import { computeParallelSafety } from '../decompose/safety.js';

export const FRONTMATTER_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Read a file, or null when absent. Used ONLY for files inside code
 *  repos (e.g. `.veto/card.json`) — ticket docs/artifacts are
 *  DB rows now. */
export async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Upsert flat `key: value` lines inside the frontmatter block,
 * preserving everything else (comments, order, body). Values are
 * written as plain scalars — callers pass pre-formatted scalars.
 */
export function upsertFrontmatterKeys(
  raw: string,
  entries: Record<string, string>,
): string {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m || m[1] === undefined) {
    throw new Error('missing or malformed --- frontmatter block');
  }
  const lines = m[1].split('\n');
  const remaining = new Map(Object.entries(entries));
  const out: string[] = [];
  for (const line of lines) {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
    if (key && remaining.has(key)) {
      out.push(`${key}: ${remaining.get(key)}`);
      remaining.delete(key);
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of remaining) out.push(`${k}: ${v}`);
  return raw.replace(m[1], out.join('\n'));
}

/** Parse flat `key: scalar` frontmatter lines into a string map
 *  (line-level — no YAML dependency in the hot path). */
export function flatFrontmatter(raw: string): Record<string, string> {
  const m = FRONTMATTER_RE.exec(raw);
  const out: Record<string, string> = {};
  if (!m?.[1]) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined && kv[2] !== undefined) {
      out[kv[1]] = kv[2].trim();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// doc_versions / run_artifacts access (D29)
//
// These take a bare `TransitionContext` (not TransitionTools) so the
// claim path — which has ctx but no tools — uses the same read path as
// reconcile. TransitionTools extends the context, so either works.
// ---------------------------------------------------------------------------

/** Latest content of a `doc_versions` doc for a subject, or null. */
export async function getDocText(
  ctx: TransitionContext,
  subject: string,
  doc: DocKind,
): Promise<string | null> {
  const v = await ctx.store.getDoc({
    workspace: ctx.workspace,
    subject,
    doc,
  });
  return v?.content ?? null;
}

/** Append a new immutable doc version; returns the version number. */
export async function putDocText(
  ctx: TransitionContext,
  subject: string,
  doc: DocKind,
  content: string,
): Promise<number> {
  const v = await ctx.store.appendDocVersion(
    { workspace: ctx.workspace, subject, doc },
    content,
    ctx.actor,
  );
  return v.version;
}

/** Content of one `run_artifacts` row, or null. */
export async function getArtifactText(
  ctx: TransitionContext,
  runId: string,
  name: string,
): Promise<string | null> {
  const a = await ctx.store.getArtifact(runId, name);
  return a?.content ?? null;
}

/** Write/replace a `run_artifacts` row. */
export async function putArtifactText(
  ctx: TransitionContext,
  runId: string,
  name: string,
  content: string,
): Promise<void> {
  await ctx.store.putArtifact({
    run_id: runId,
    name,
    content,
    created_at: ctx.now().toISOString(),
  });
}

/**
 * Latest artifact `name` across a ticket's runs, newest-first —
 * the read for output produced by an EARLIER run (triage's
 * split-plan.md read at gate clear, the review.json a later pass
 * accumulates over).
 */
export async function latestArtifactText(
  ctx: TransitionContext,
  name: string,
  filter: { ticketId: string },
): Promise<string | null> {
  const runs = (
    await ctx.store.listRuns({
      workspace: ctx.workspace,
      ticket_id: filter.ticketId,
    })
  ).sort((a, b) => b.id.localeCompare(a.id));
  for (const r of runs) {
    const a = await ctx.store.getArtifact(r.id, name);
    if (a) return a.content;
  }
  return null;
}

/**
 * Ticket-scoped artifact read with the nested-path fallback: agents
 * write under `<runDir>/<ticket_id>/` (TICKET_DIR), so the ingest often
 * stores `<ticketId>/<name>` — try the bare name first, then the
 * nested relpath. For THIS run's output prefer {@link runArtifactText}.
 */
export async function ticketArtifactText(
  ctx: TransitionContext,
  ticketId: string,
  name: string,
): Promise<string | null> {
  return (
    (await latestArtifactText(ctx, name, { ticketId })) ??
    (await latestArtifactText(ctx, `${ticketId}/${name}`, { ticketId }))
  );
}

/** Same bare→nested fallback for an artifact produced by the CURRENT
 *  run (it was ingested under whichever relpath the run wrote). */
export async function runArtifactText(
  ctx: TransitionContext,
  runId: string,
  ticketId: string | null,
  name: string,
): Promise<string | null> {
  const bare = await getArtifactText(ctx, runId, name);
  if (bare !== null) return bare;
  return ticketId === null
    ? null
    : await getArtifactText(ctx, runId, `${ticketId}/${name}`);
}

// ---------------------------------------------------------------------------
// Suggestions application (CONDUCTOR "Suggestions application")
// ---------------------------------------------------------------------------

export interface TriageSuggestions {
  backend?: string;
  model?: string;
  priority?: string;
  depth?: string;
}

export const SUGGESTION_KEYS = [
  'backend',
  'model',
  'priority',
  'depth',
] as const;

/**
 * Apply triage `suggestions` to ticket.md frontmatter. "Anything the
 * human set explicitly in the wizard wins" — a field is treated as
 * human-set when it carries a value that differs from what we last
 * applied (recorded under `suggested_<key>:`); absent fields and
 * fields still holding our last suggestion are machine-owned and may
 * be (re)written. Returns the applied map.
 */
export function applySuggestionsToTicketMd(
  raw: string,
  suggestions: TriageSuggestions,
): { content: string; applied: Record<string, string> } {
  const fm = flatFrontmatter(raw);
  const entries: Record<string, string> = {};
  const applied: Record<string, string> = {};
  for (const key of SUGGESTION_KEYS) {
    const suggestion = suggestions[key];
    if (!suggestion) continue;
    const current = fm[key];
    const lastApplied = fm[`suggested_${key}`];
    const humanSet =
      current !== undefined &&
      current !== '' &&
      current !== 'null' &&
      current !== lastApplied;
    if (humanSet) continue;
    entries[key] = suggestion;
    entries[`suggested_${key}`] = suggestion;
    applied[key] = suggestion;
  }
  if (Object.keys(entries).length === 0) {
    return { content: raw, applied };
  }
  return { content: upsertFrontmatterKeys(raw, entries), applied };
}

/** Read the triage run's `triage.json` run_artifacts row, tolerating
 *  absence. */
export async function readTriageJson(
  ctx: TransitionContext,
  ticketId: string,
): Promise<Record<string, unknown> | null> {
  const raw = await ticketArtifactText(ctx, ticketId, 'triage.json');
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stale-spec check (CONDUCTOR "Stale-spec check")
// ---------------------------------------------------------------------------

const SPEC_INPUTS = ['ticket.md', 'rs.md', 'tdd.md', 'vs.md'] as const;

/** sha256 over the spec inputs' doc_versions contents — the value
 *  recorded on `tickets.spec_hash` at spec completion. */
export async function specInputsHash(
  ctx: TransitionContext,
  ticketId: string,
): Promise<string> {
  const h = createHash('sha256');
  for (const name of SPEC_INPUTS) {
    let raw = await getDocText(ctx, ticketId, name);
    if (name === 'ticket.md' && raw !== null) {
      // Exclude the `spec_hash:` frontmatter line entirely —
      // recordSpecHash used to append it to ticket.md AFTER computing
      // the baseline; hashing the doc with the line present (even
      // emptied) self-invalidates on the next check and the ticket
      // parks at test-approved forever.
      raw = raw
        .split('\n')
        .filter((l) => !/^spec_hash\s*:/.test(l))
        .join('\n');
    }
    if (raw !== null) h.update(`${name}\n${raw}\n`);
  }
  return `sha256:${h.digest('hex')}`;
}

/**
 * Record the spec-completion hash on `tickets.spec_hash` (CONDUCTOR
 * "Stale-spec check": `tickets.spec_hash` = hash of ticket.md + spec
 * inputs recorded at spec completion). Call when the spec package
 * becomes test-approved.
 */
export async function recordSpecHash(
  ctx: TransitionContext,
  ticketId: string,
): Promise<string> {
  const hash = await specInputsHash(ctx, ticketId);
  // Fresh row read — the caller's TicketRow may predate status writes
  // this tick already made.
  const row = await ctx.store.getTicket({
    workspace: ctx.workspace,
    ticket_id: ticketId,
  });
  if (row) {
    await ctx.store.upsertTicket({
      ...row,
      spec_hash: hash,
      updated_at: ctx.now().toISOString(),
    });
  }
  return hash;
}

/** True when the stored spec inputs still match the recorded hash.
 *  Missing baseline → not stale (record it now for next time). */
export async function specIsStale(
  ctx: TransitionContext,
  ticketId: string,
): Promise<boolean> {
  const row = await ctx.store.getTicket({
    workspace: ctx.workspace,
    ticket_id: ticketId,
  });
  let recorded = row?.spec_hash ?? null;
  if (!recorded) {
    // Legacy baseline: a ticket.md doc written before the spec_hash
    // column existed may still carry `spec_hash:` in frontmatter.
    const raw = await getDocText(ctx, ticketId, 'ticket.md');
    if (raw !== null) {
      recorded = flatFrontmatter(raw).spec_hash ?? null;
    }
  }
  if (!recorded) {
    await recordSpecHash(ctx, ticketId);
    return false;
  }
  return (await specInputsHash(ctx, ticketId)) !== recorded;
}

// ---------------------------------------------------------------------------
// Split materialization (CONDUCTOR "Split materialization", SCHEMAS §14)
// ---------------------------------------------------------------------------

export interface SplitChild {
  label: string;
  title: string;
  repos: string[];
  dependsOn: string[]; // sibling labels
  covers: string[];
}

/** Parse the `## Children` table of split-plan.md (SCHEMAS §14 pinned
 *  columns: child | title | repos | depends_on | covers). Fail-closed:
 *  unparseable → null. */
export function parseSplitPlan(md: string): SplitChild[] | null {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s+Children\b/.test(l));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const section = lines.slice(start + 1, end === -1 ? undefined : end);
  const rows: SplitChild[] = [];
  for (const line of section) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    if (cells[0] === 'child' || /^-+$/.test(cells[0] ?? '')) continue;
    const list = (s: string) =>
      s === '' || s === '-' || s.toLowerCase() === 'none'
        ? []
        : s
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
    rows.push({
      label: cells[0] ?? '',
      title: cells[1] ?? '',
      repos: list(cells[2] ?? ''),
      dependsOn: list(cells[3] ?? ''),
      covers: list(cells[4] ?? ''),
    });
  }
  return rows.length > 0 ? rows : null;
}

/**
 * Transactional `SR-NNNN` allocation (DB-SCHEMA `projects.next_ticket_seq`
 * — D29; replaces the git-ref CAS + `.veto/next-id` file).
 */
export async function reserveId(ctx: TransitionContext): Promise<string> {
  return ctx.store.allocTicketId(ctx.workspace);
}

/**
 * Materialize split children (CONDUCTOR special path): allocate real
 * ids transactionally, insert each child `tickets` row (`imported`,
 * `parent`, `depends_on` → sibling ids, repos/feature inherited), and
 * append its `ticket.md` doc_version (frontmatter rewritten from the
 * split run's `children/<label>.md` run_artifact draft). Returns the
 * label→id map. The parent's `→ split` status write is the caller's
 * job.
 */
export async function materializeSplit(args: {
  ctx: TransitionContext;
  ticketId: string;
  children: SplitChild[];
  /** wp-154 decomposition pass (`## Decomposition` rows, keyed by
   *  child label) — drives `parallel_safety` per child. Absent →
   *  every child lands `unknown` (the conservative verdict). */
  decomposition?: DecompositionRow[];
  /** wp-154 contract-first (`## Contracts` rows) — each row's
   *  `contracts/<name>.json` run artifact promotes to a
   *  `contract.json` doc_version on every consuming child INSIDE this
   *  transaction; consuming children's ticket.md gains a `contract:`
   *  frontmatter list. A missing/invalid artifact throws (fail-closed
   *  — never a half-promoted split). */
  contracts?: PlanContract[];
}): Promise<Record<string, string>> {
  const { ctx, ticketId } = args;
  const contracts = args.contracts ?? [];
  // Contract names per child label (the `contract:` frontmatter list +
  // the readiness check's declared set).
  const contractsByLabel = new Map<string, string[]>();
  for (const c of contracts) {
    for (const label of c.consumers) {
      const list = contractsByLabel.get(label) ?? [];
      list.push(c.name);
      contractsByLabel.set(label, list);
    }
  }
  // wp-154 parallel-safety verdicts from the decomposition table.
  const safety = computeParallelSafety({
    children: args.children,
    decomposition: args.decomposition ?? [],
  });
  // ids + rows + doc versions in ONE transaction (CONDUCTOR split
  // materialization: "allocates child ids transactionally").
  return ctx.store.transaction(async (store) => {
    const tx: TransitionContext = { ...ctx, store };
    const parent = await store.getTicket({
      workspace: ctx.workspace,
      ticket_id: ticketId,
    });
    const ts = ctx.now().toISOString();
    const ids: Record<string, string> = {};
    for (const child of args.children) {
      ids[child.label] = await store.allocTicketId(ctx.workspace);
    }
    for (const child of args.children) {
      const newId = ids[child.label] as string;
      const depIds = child.dependsOn
        .map((l) => ids[l])
        .filter((x): x is string => x !== undefined);
      // The split run's per-child draft — a run_artifact, never a
      // doc_version (`c1.md` isn't a DOC_KIND).
      const draft = await ticketArtifactText(
        tx,
        ticketId,
        `children/${child.label}.md`,
      );
      if (draft === null) {
        throw new Error(
          `materializeSplit: no children/${child.label}.md draft artifact for ${ticketId} (fail-closed — a missing draft must not silently materialize)`,
        );
      }
      const declaredContracts = contractsByLabel.get(child.label) ?? [];
      const next = upsertFrontmatterKeys(draft, {
        id: newId,
        status: 'imported',
        parent: ticketId,
        depends_on: `[${depIds.join(', ')}]`,
        ...(child.repos.length > 0
          ? { repos: `[${child.repos.join(', ')}]` }
          : {}),
        // contract-first: the consuming child's pinned contract names
        // (wp-154 — the coordinator reads these at claim time).
        ...(declaredContracts.length > 0
          ? { contract: `[${declaredContracts.join(', ')}]` }
          : {}),
      });
      await store.appendDocVersion(
        { workspace: ctx.workspace, subject: newId, doc: 'ticket.md' },
        next,
        ctx.actor,
      );
      await store.upsertTicket({
        workspace: ctx.workspace,
        ticket_id: newId,
        feature: parent?.feature ?? null,
        title: child.title,
        status: 'imported',
        priority: parent?.priority ?? 'medium',
        depth: parent?.depth ?? null,
        backend: parent?.backend ?? null,
        model: parent?.model ?? null,
        repos: child.repos.length > 0 ? child.repos : (parent?.repos ?? []),
        parent: ticketId,
        depends_on: depIds,
        source: parent?.source ?? null,
        // §15.7 (wp-151): children inherit the parent's taxonomy —
        // a split does not silently re-classify the work.
        work_type: parent?.work_type ?? null,
        origin: parent?.origin ?? null,
        severity: parent?.severity ?? null,
        // wp-154 decomposition attrs — readiness lands below once
        // every sibling row exists (dep statuses resolve).
        parallel_safety: safety.get(child.label) ?? 'unknown',
        forced: false,
        spec_score: null,
        spec_hash: null,
        blocked_reason: null,
        created_at: ts,
        updated_at: ts,
      } satisfies TicketRow);
    }
    // contract-first (wp-154): promote `contracts/<name>.json` run
    // artifacts to `contract.json` doc_versions on each consuming
    // child — BEFORE any implement run can pin
    // `runs.request.baseline.contract_ver`. Throws on a missing/
    // invalid artifact → the whole materialization rolls back.
    if (contracts.length > 0) {
      await promoteContracts({
        ctx: tx,
        ticketId,
        contracts,
        ids,
        readArtifact: (name) => ticketArtifactText(tx, ticketId, name),
      });
    }
    // wp-154 readiness verdict per child — computed last so dep rows +
    // promoted contract docs are all visible inside the transaction.
    for (const child of args.children) {
      const newId = ids[child.label] as string;
      const row = await store.getTicket({
        workspace: ctx.workspace,
        ticket_id: newId,
      });
      if (!row) continue;
      const res = await computeExecutionReadiness({
        ctx: tx,
        ticket: {
          ticket_id: newId,
          depends_on: row.depends_on,
        },
        contracts: contractsByLabel.get(child.label) ?? [],
      });
      if (row.execution_readiness !== res.readiness) {
        await store.upsertTicket({
          ...row,
          execution_readiness: res.readiness,
          updated_at: ts,
        });
      }
    }
    return ids;
  });
}

// ---------------------------------------------------------------------------
// Review merge — findings-<pass>.json fragments → review.json (§6)
// ---------------------------------------------------------------------------

interface RawFinding {
  file?: string;
  line?: number | null;
  repo?: string;
  body?: string;
  evidence?: string;
  suggested_fix?: string;
  severity?: string;
  category?: string;
  kind?: string;
  confidence?: number;
  symbol?: string | null;
  line_range?: [number, number] | null;
}

interface ReviewEnvelope {
  schema: 1;
  ticket: string;
  round: number;
  passes: string[];
  findings: Array<Record<string, unknown> & { thread_id: string }>;
}

/** The accumulated review.json — the newest `review.json` run_artifact
 *  across the ticket's runs (written per-pass/per-round by this merge,
 *  fix-claims application, and discuss replies). */
export async function readReviewJson(
  ctx: TransitionContext,
  ticketId: string,
): Promise<ReviewEnvelope | null> {
  const raw = await ticketArtifactText(ctx, ticketId, 'review.json');
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as ReviewEnvelope;
    return parsed.schema === 1 && Array.isArray(parsed.findings)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Merge one pass's `findings-<pass>.json` fragment into the ticket's
 * review.json: runner-computed fingerprints + thread_ids (§6 — agents
 * never emit either), `rounds_seen` growth + `open → fixed → reopened`
 * thread transitions via `matchThread`. The merged document is written
 * as a `review.json` run_artifacts row on the current run (newest-
 * first scan picks it up for the next pass/round). `findingsText` is
 * the raw fragment content — a non-array is a malformed structured
 * output and throws (fail-closed). Returns the merge counts.
 */
export async function mergeFindingsPass(args: {
  ctx: TransitionContext;
  runId: string;
  ticketId: string;
  pass: string;
  findingsText: string;
  round: number;
}): Promise<{
  merged: number;
  created: number;
  reopened: number;
  fixed: number;
}> {
  const { ctx, runId, ticketId, pass, findingsText, round } = args;
  const fragment = JSON.parse(findingsText) as RawFinding[];
  if (!Array.isArray(fragment)) {
    throw new Error(`findings-${pass}.json is not a JSON array — fail-closed`);
  }

  const review =
    (await readReviewJson(ctx, ticketId)) ??
    ({
      schema: 1,
      ticket: ticketId,
      round,
      passes: [],
      findings: [],
    } as ReviewEnvelope);
  review.round = Math.max(review.round, round);
  if (!review.passes.includes(pass)) review.passes.push(pass);
  const previousOpen = new Map(
    review.findings
      .filter((f) => f.status === 'open')
      .map((f) => [f.thread_id, f]),
  );

  let created = 0;
  let reopened = 0;
  for (const f of fragment) {
    const input = {
      file: f.file ?? '',
      category: f.category ?? 'correctness',
      body: f.body ?? '',
      line: f.line ?? null,
      line_range: f.line_range ?? null,
    };
    const fp = fingerprint(input);
    const thread = matchThread(
      input,
      review.findings.map((e) => ({
        thread_id: e.thread_id,
        fingerprint: e.fingerprint as never,
      })),
    );
    if (thread) {
      const existing = review.findings.find((e) => e.thread_id === thread) as
        | Record<string, unknown>
        | undefined;
      if (existing) {
        const seen = (existing.rounds_seen as number[] | undefined) ?? [];
        if (!seen.includes(round)) seen.push(round);
        existing.rounds_seen = seen;
        // Cross-pass provenance (wp-050): which passes flagged the
        // thread + later passes' evidence joins tagged.
        const passList = (existing.passes as string[] | undefined) ?? [];
        if (!passList.includes(pass)) passList.push(pass);
        existing.passes = passList;
        if (f.evidence) {
          existing.evidence = existing.evidence
            ? `${existing.evidence}\n[${pass}] ${f.evidence}`
            : `[${pass}] ${f.evidence}`;
        }
        if (existing.status === 'fixed') {
          existing.status = 'reopened';
          reopened += 1;
        }
        previousOpen.delete(thread);
        continue;
      }
    }
    review.findings.push({
      thread_id: threadIdFor(fp),
      status: 'open',
      fingerprint: fp,
      severity: (f.severity ?? 'minor') as string,
      category: (f.category ?? 'correctness') as string,
      kind: (f.kind ?? 'code-bug') as string,
      file: f.file ?? '',
      line: f.line ?? 0,
      repo: f.repo ?? '',
      body: f.body ?? '',
      evidence: f.evidence ?? '',
      suggested_fix: f.suggested_fix ?? '',
      confidence: f.confidence ?? null,
      rounds_seen: [round],
      author: 'review',
      replies: [],
      passes: [pass],
    });
    created += 1;
    previousOpen.delete(threadIdFor(fp));
  }

  // Threads absent from this round's reports and still open → fixed
  // (only when every pass has reported — partial rounds can't conclude).
  let fixed = 0;
  if (REVIEW_PASSES.every((p) => review.passes.includes(p))) {
    for (const [, f] of previousOpen) {
      f.status = 'fixed';
      fixed += 1;
    }
  }

  await putArtifactText(
    ctx,
    runId,
    'review.json',
    `${JSON.stringify(review, null, 2)}\n`,
  );
  return { merged: fragment.length, created, reopened, fixed };
}

/** Find `findings-<pass>.json` among a run's reported artifact paths. */
export function findingsArtifact(
  artifacts: string[],
  pass: string,
): string | null {
  const suffix = `findings-${pass}.json`;
  return (
    artifacts.find((a) => a.endsWith(`/${suffix}`) || a.endsWith(suffix)) ??
    null
  );
}

/** Severities among open findings that trigger an auto-fix round. */
export function openBlockingSeverities(
  review: ReviewEnvelope,
  autoFixSeverities: string[],
): FindingSeverity[] {
  const want = new Set(autoFixSeverities);
  const out = new Set<FindingSeverity>();
  for (const f of review.findings) {
    if (f.status === 'open' && want.has(String(f.severity))) {
      out.add(f.severity as FindingSeverity);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Push helper — shepherd-bound transitions push best-effort (no remote
// in tests → warning, never a stranded ticket). CODE-repo pushes —
// git-for-code is still real under D29.
// ---------------------------------------------------------------------------

export async function pushBranches(
  ctx: TransitionContext,
  ticket: TicketRow | null,
  opts: { force?: boolean } = {},
): Promise<string[]> {
  const pushed: string[] = [];
  const repos = ticket
    ? await ctx.store.listTicketRepos({
        workspace: ctx.workspace,
        ticket_id: ticket.ticket_id,
      })
    : [];
  for (const tr of repos) {
    if (!tr.worktree || !tr.branch) continue;
    try {
      const args = ['push', 'origin', tr.branch];
      if (opts.force) args.splice(1, 0, '--force-with-lease');
      await git(args, { cwd: tr.worktree });
      pushed.push(tr.repo);
    } catch {
      // no remote / offline — the shepherd retries on its own cycle
    }
  }
  return pushed;
}

/** Convenience: fire `push` from gitops for callers holding a repo path. */
export { push };
