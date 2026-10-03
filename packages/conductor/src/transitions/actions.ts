/**
 * transitions/actions.ts — the mechanical helpers behind the
 * sentinel→transition table rows (wp-031).
 *
 * CONDUCTOR "Special paths" implemented here:
 *   - Suggestions application (triage READY → write backend/model/
 *     priority/depth into frontmatter; human-set fields win).
 *   - Split materialization (split-plan approve → reserve child ids,
 *     rewrite child frontmatter, move drafts, parent → `split`).
 *   - Stale-spec check (implement launch re-hashes spec inputs vs the
 *     hash recorded at spec completion → `stale-spec` inbox item).
 *   - Review merge (findings-<pass>.json fragments → review.json
 *     envelope with runner-computed fingerprints + thread ids, §6).
 *   - Doc lint routing (structuredDocLint/coverageLint fail-closed →
 *     doc-repair run → repair gate).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FindingSeverity,
  REVIEW_PASSES,
  type Stage,
  type TicketRow,
} from '@sprint-runner/core';
import { commitAll, git, push, reserveNextId } from '@sprint-runner/gitops';
import { fingerprint, matchThread, threadIdFor } from '@sprint-runner/lints';
import type { TransitionContext, TransitionTools } from '../contracts.js';

export const FRONTMATTER_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function gitActor(ctx: TransitionContext): {
  name: string;
  email: string;
} {
  return { name: ctx.actor, email: `${ctx.actor}@sprint-runner.local` };
}

/** Read a file, or null when absent. */
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

/** Read `tickets/<id>/triage.json` suggestions, tolerating absence. */
export async function readTriageJson(
  ticketDir: string,
): Promise<Record<string, unknown> | null> {
  const raw = await readOrNull(join(ticketDir, 'triage.json'));
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

const SPEC_INPUTS = ['ticket.md', 'prd.md', 'tdd.md', 'test.md'] as const;

/** sha256 over the spec inputs present in the ticket dir — the value
 *  recorded in frontmatter `spec_hash:` at spec completion. */
export async function specInputsHash(ticketDir: string): Promise<string> {
  const h = createHash('sha256');
  for (const name of SPEC_INPUTS) {
    let raw = await readOrNull(join(ticketDir, name));
    if (name === 'ticket.md' && raw !== null) {
      // Exclude the `spec_hash:` frontmatter line entirely —
      // recordSpecHash appends it to ticket.md AFTER computing the
      // baseline; hashing the file with the line present (even emptied)
      // self-invalidates on the next check and the ticket parks at
      // test-approved forever.
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
 * Record the spec-completion hash into ticket.md frontmatter
 * (`spec_hash:` — additive §1 key; the projection's spec_hash column
 * covers ticket.md alone, so the baseline for spec *inputs* lives in
 * frontmatter). Call when the spec package becomes test-approved.
 */
export async function recordSpecHash(ticketDir: string): Promise<string> {
  const file = join(ticketDir, 'ticket.md');
  const raw = await readFile(file, 'utf8');
  const hash = await specInputsHash(ticketDir);
  await writeFile(
    file,
    upsertFrontmatterKeys(raw, { spec_hash: hash }),
    'utf8',
  );
  return hash;
}

/** True when the on-disk spec inputs still match the recorded hash.
 *  Missing baseline → not stale (record it now for next time). */
export async function specIsStale(ticketDir: string): Promise<boolean> {
  const raw = await readOrNull(join(ticketDir, 'ticket.md'));
  if (raw === null) return false;
  const recorded = flatFrontmatter(raw).spec_hash;
  if (!recorded) {
    await recordSpecHash(ticketDir);
    return false;
  }
  return (await specInputsHash(ticketDir)) !== recorded;
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
 * Reserve the next `SR-NNNN` id via next-id CAS (gitops
 * `reserveNextId`); when the tickets repo has no `origin` remote the
 * push CAS can't run — fall back to a local increment+commit (same
 * file, same format; the CAS only matters across installs).
 */
export async function reserveId(
  repo: string,
  actor: { name: string; email: string },
): Promise<string> {
  try {
    return await reserveNextId(repo, 'SR', actor);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (!/origin|fetch|remote/i.test(msg)) throw e;
  }
  const file = join(repo, '.sprint-runner', 'next-id');
  const current = existsSync(file)
    ? Number.parseInt((await readFile(file, 'utf8')).trim(), 10) || 0
    : 0;
  const next = current + 1;
  await mkdir(join(repo, '.sprint-runner'), { recursive: true });
  await writeFile(file, `${next}\n`, 'utf8');
  await commitAll(repo, `reserve SR-${next}`, actor);
  return `SR-${String(next).padStart(4, '0')}`;
}

/**
 * Materialize split children: reserve real ids, rewrite each
 * `children/<label>.md` frontmatter (`id`, `depends_on` → sibling ids),
 * move drafts to `tickets/<new-id>/ticket.md`. Returns the label→id map.
 * The parent's `→ split` status write is the caller's job.
 */
export async function materializeSplit(args: {
  ctx: TransitionContext;
  ticketId: string;
  children: SplitChild[];
}): Promise<Record<string, string>> {
  const { ctx, ticketId } = args;
  const ticketDir = join(ctx.ticketsRepoPath, 'tickets', ticketId);
  const actor = gitActor(ctx);
  const ids: Record<string, string> = {};
  for (const child of args.children) {
    ids[child.label] = await reserveId(ctx.ticketsRepoPath, actor);
  }
  for (const child of args.children) {
    const draftPath = join(ticketDir, 'children', `${child.label}.md`);
    const raw = await readFile(draftPath, 'utf8');
    const newId = ids[child.label] as string;
    const depIds = child.dependsOn.map((l) => ids[l]).filter(Boolean);
    const next = upsertFrontmatterKeys(raw, {
      id: newId,
      status: 'imported',
      parent: ticketId,
      depends_on: `[${depIds.join(', ')}]`,
      ...(child.repos.length > 0
        ? { repos: `[${child.repos.join(', ')}]` }
        : {}),
    });
    const destDir = join(ctx.ticketsRepoPath, 'tickets', newId);
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, 'ticket.md'), next, 'utf8');
  }
  await commitAll(
    ctx.ticketsRepoPath,
    `conductor: materialize split ${ticketId} → ${Object.values(ids).join(', ')}`,
    actor,
  );
  return ids;
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

export async function readReviewJson(
  ticketDir: string,
): Promise<ReviewEnvelope | null> {
  const raw = await readOrNull(join(ticketDir, 'review.json'));
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
 * Merge one pass's `findings-<pass>.json` fragment into
 * `tickets/<id>/review.json`: runner-computed fingerprints +
 * thread_ids (§6 — agents never emit either), `rounds_seen` growth +
 * `open → fixed → reopened` thread transitions via `matchThread`.
 * Returns {merged, newFindings, reopened} counts.
 */
export async function mergeFindingsPass(args: {
  ticketDir: string;
  ticketId: string;
  pass: string;
  findingsPath: string;
  round: number;
}): Promise<{
  merged: number;
  created: number;
  reopened: number;
  fixed: number;
}> {
  const { ticketDir, ticketId, pass, findingsPath, round } = args;
  const raw = await readFile(findingsPath, 'utf8');
  const fragment = JSON.parse(raw) as RawFinding[];
  if (!Array.isArray(fragment)) {
    throw new Error(`findings-${pass}.json is not a JSON array — fail-closed`);
  }

  const review =
    (await readReviewJson(ticketDir)) ??
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

  await writeFile(
    join(ticketDir, 'review.json'),
    `${JSON.stringify(review, null, 2)}\n`,
    'utf8',
  );
  return { merged: fragment.length, created, reopened, fixed };
}

/** Find `findings-<pass>.json` among a run's collected artifacts. */
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
// in tests → warning, never a stranded ticket).
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
