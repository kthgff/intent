/**
 * align/engine.ts — wp-112 continuous alignment (D37 Phase B,
 * SCHEMAS §18, INTELLIGENCE §5).
 *
 * Deterministic intended/implemented/verified comparison over the
 * evidence plane wp-110/111 landed:
 *
 *   intended    — the scope's ticket ACs (parsed from ticket.md) plus
 *                 the relation graph's `ac:` edges;
 *   implemented — `implements|documents` edges onto commit-pinned
 *                 `code:<repo>:<sha>:…` refs and merged `ticket_repos`
 *                 rows;
 *   verified    — `tests|verified-by` edges and `test-report.json`
 *                 run artifacts.
 *
 * Output is a validated `alignment-findings.json` artifact persisted
 * on the `alignment_runs` row (durable), plus `alignment_findings`
 * rows whose status only ever moves through the human OCC decide
 * path. Findings are reviewable hypotheses — the engine writes no
 * spec, verifies no link, clears no gate, and files no ticket.
 *
 * `on-merge` runs coalesce: the (workspace, scope, trigger_sha)
 * unique index means a duplicated merge event returns the existing
 * run rather than forking history.
 */
import { createHash } from 'node:crypto';
import type { EffectiveConfig } from '@veto/config';
import {
  type AlignmentFinding,
  type AlignmentFindingRow,
  type AlignmentFindings,
  type AlignmentRunRow,
  type AlignmentTrigger,
  type IndexHead,
  type Relation,
  type Store,
  type TicketRow,
  validateAlignmentFindings,
} from '@veto/core';
import { resolveManifestMembers } from '../release/manifest.js';
import { ReleaseError } from '../release/types.js';

/** Everything a comparison/decision needs — same shape as ReleaseCtx. */
export interface AlignCtx {
  store: Store;
  workspace: string;
  actor: string;
  now: () => Date;
  /** Workspace root — only needed when the scope resolves through
   *  release machinery (TransitionContext parity). */
  rootPath?: string;
}

/** Why an alignment operation failed — mapped to HTTP by the API. */
export type AlignmentErrorKind =
  | 'invalid' // 400 — bad scope/artifact shape
  | 'missing' // 404 — no such scope/finding/run
  | 'conflict' // 409 — stale OCC `expected`
  | 'disabled' // 409 — intelligence.alignment: off
  | 'budget'; // 429 — configured token/spend cap already reached

export class AlignmentServiceError extends Error {
  readonly kind: AlignmentErrorKind;
  readonly current?: string | null | undefined;
  constructor(
    kind: AlignmentErrorKind,
    message: string,
    current?: string | null,
  ) {
    super(message);
    this.name = 'AlignmentServiceError';
    this.kind = kind;
    this.current = current;
  }
}

// ---------------------------------------------------------------------------
// ids + scope resolution
// ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Deterministic finding id — re-runs re-emit the same id for the same
 *  (scope, kind, anchor) so the upsert refreshes evidence while the
 *  human's status survives (SCHEMAS §18 + wp-112 DoD). */
export function alignmentFindingId(
  scope: string,
  kind: string,
  anchor: string,
): string {
  return `aln_${sha256(`${scope}|${kind}|${anchor}`).slice(0, 16)}`;
}

/** `on-merge` runs derive their id from the merged head — a replayed
 *  merge event hashes to the SAME run_id and the PK/dedupe index does
 *  the rest. Manual runs take a nonce so repeated requests each land. */
function alignmentRunId(
  workspace: string,
  scope: string,
  trigger: AlignmentTrigger,
  triggerSha: string | null,
  nonce: string,
): string {
  const key = `${workspace}|${scope}|${trigger}|${triggerSha ?? ''}|${trigger === 'on-merge' ? '' : nonce}`;
  return `alnrun_${sha256(key).slice(0, 16)}`;
}

/** Tickets inside an alignment scope (`SR-…|F-…|I-…|release:<id>`). */
export async function scopeTickets(
  ctx: AlignCtx,
  scope: string,
): Promise<TicketRow[]> {
  if (scope.startsWith('release:')) {
    const releaseId = scope.slice('release:'.length);
    const items = (
      await ctx.store.listReleaseItems({
        workspace: ctx.workspace,
        release_id: releaseId,
      })
    ).filter((i) => !i.removed_at);
    if (items.length === 0) {
      const release = await ctx.store.getRelease({
        workspace: ctx.workspace,
        release_id: releaseId,
      });
      if (!release) {
        throw new AlignmentServiceError(
          'missing',
          `no release '${releaseId}' in ${ctx.workspace}`,
        );
      }
      return [];
    }
    return resolveManifestMembers(
      { ...ctx, rootPath: ctx.rootPath ?? '' },
      items,
    );
  }
  if (/^I-[A-Za-z0-9-]+$/.test(scope)) {
    const features = await ctx.store.listFeatures({
      workspace: ctx.workspace,
      initiative: scope,
    });
    const names = new Set(features.map((f) => f.feature));
    const tickets = await ctx.store.listTickets({ workspace: ctx.workspace });
    return tickets.filter((t) => t.feature != null && names.has(t.feature));
  }
  if (/^F-[A-Za-z0-9-]+$/.test(scope)) {
    const tickets = await ctx.store.listTickets({ workspace: ctx.workspace });
    return tickets.filter((t) => t.feature === scope);
  }
  const ticket = await ctx.store.getTicket({
    workspace: ctx.workspace,
    ticket_id: scope,
  });
  if (!ticket) {
    throw new AlignmentServiceError(
      'missing',
      `no ticket '${scope}' in ${ctx.workspace}`,
    );
  }
  return [ticket];
}

// ---------------------------------------------------------------------------
// AC extraction (intended set)
// ---------------------------------------------------------------------------

export interface ScopeAc {
  /** `AC-1`, `AC-2`, … — checklist order is the id (§1 convention). */
  ac_id: string;
  ticket_id: string;
  text: string;
  /** `- [x]` items are already human-checked — still only intent. */
  checked: boolean;
}

/** `## Acceptance criteria` checklist → ordered AC ids. */
export function parseAcceptanceCriteria(
  ticketMd: string,
  ticketId: string,
): ScopeAc[] {
  const lines = ticketMd.split(/\r?\n/);
  let inSection = false;
  const acs: ScopeAc[] = [];
  for (const line of lines) {
    const h = /^#{2,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      inSection = (h[1] ?? '').trim().toLowerCase() === 'acceptance criteria';
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (m?.[2]) {
      acs.push({
        ac_id: `AC-${acs.length + 1}`,
        ticket_id: ticketId,
        text: m[2].trim(),
        checked: m[1] !== ' ',
      });
    }
  }
  return acs;
}

// ---------------------------------------------------------------------------
// the three evidence sets → findings
// ---------------------------------------------------------------------------

const CODE_REF = /^code:([A-Za-z0-9_.\-/]+):([0-9a-f]{7,40}):/;
const IMPL_PREDICATES = new Set(['implements', 'documents']);
const TEST_PREDICATES = new Set(['tests', 'verified-by']);
/** Ticket states where behavior was already approved/shipped — drift
 *  against them is `affected-approved-behavior`, not just `likely-drift`. */
const APPROVED_BEHAVIOR = new Set([
  'merged',
  'verifying',
  'verify_failed',
  'released',
]);

/** Edges whose verification a human/model rejected don't count as
 *  evidence FOR anything; `suggested` edges count weakly (they lower
 *  confidence and double as disconfirming refs on gap findings). */
const SETTLED_POSITIVE = new Set(['verified', 'auto-verified']);

function edgeRef(e: Relation): string {
  return `rel:${e.subject}:${e.predicate}:${e.object}`;
}

interface Pin {
  repo: string;
  sha: string;
}

function codePins(text: string | null | undefined): Pin[] {
  const pins: Pin[] = [];
  const seen = new Set<string>();
  const re = new RegExp(CODE_REF.source, 'g');
  for (const m of (text ?? '').matchAll(re)) {
    if (m[1] && m[2]) {
      const key = `${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pins.push({ repo: m[1], sha: m[2] });
    }
  }
  return pins;
}

async function latestTestReportRef(
  ctx: AlignCtx,
  ticketId: string,
): Promise<{ ref: string; passed: boolean } | null> {
  const runs = (
    await ctx.store.listRuns({ workspace: ctx.workspace, subject: ticketId })
  ).sort((a, b) => b.id.localeCompare(a.id));
  for (const r of runs) {
    for (const a of await ctx.store.listArtifacts(r.id)) {
      if (
        a.name === 'test-report.json' ||
        a.name.endsWith('/test-report.json')
      ) {
        let passed = false;
        try {
          const parsed = JSON.parse(a.content) as {
            cases?: { result?: string; status?: string }[];
            summary?: { failed?: number };
          };
          const cases = parsed.cases ?? [];
          const failed =
            parsed.summary?.failed ??
            cases.filter(
              (c) =>
                (c.result ?? c.status) !== 'pass' &&
                (c.result ?? c.status) !== 'passed',
            ).length;
          passed = cases.length > 0 && failed === 0;
        } catch {
          passed = false; // malformed report is not verification evidence
        }
        return { ref: `run:${r.id}:${a.name}`, passed };
      }
    }
  }
  return null;
}

/**
 * Compare one scope. Pure read path — writes nothing. Findings carry
 * `status: 'open'` always; persistence preserves a settled status via
 * the upsert's "never touch status" contract.
 */
export async function compareAlignment(
  ctx: AlignCtx,
  scope: string,
): Promise<AlignmentFindings> {
  const tickets = await scopeTickets(ctx, scope);
  const repos = [...new Set(tickets.flatMap((t) => t.repos))].sort();
  const index_heads: IndexHead[] = [];
  const headByRepo = new Map<string, string>();
  for (const repo of repos) {
    const head = await ctx.store.getCurrentRepoIndex(ctx.workspace, repo);
    if (head) {
      index_heads.push({ repo, commit_sha: head.commit_sha });
      headByRepo.set(repo, head.commit_sha);
    }
  }

  const findings: AlignmentFinding[] = [];
  const push = (
    kind: AlignmentFinding['kind'],
    severity: AlignmentFinding['severity'],
    anchor: string,
    claim: string,
    confidence: number,
    evidence_refs: string[],
    opts: {
      disconfirming_refs?: string[];
      freshness?: 'current' | 'stale';
      next: string;
    },
  ) => {
    findings.push({
      id: alignmentFindingId(scope, kind, anchor),
      kind,
      severity,
      claim,
      confidence,
      evidence_refs,
      disconfirming_refs: opts.disconfirming_refs ?? [],
      freshness: opts.freshness ?? 'current',
      suggested_next_check: opts.next,
      status: 'open',
    });
  };

  for (const ticket of tickets) {
    const tid = ticket.ticket_id;
    const doc = await ctx.store.getDoc({
      workspace: ctx.workspace,
      subject: tid,
      doc: 'ticket.md',
    });
    const acs = parseAcceptanceCriteria(doc?.content ?? '', tid);

    // All edges on the ticket — subject_prefix catches `SR-1:ac:*`.
    const ticketEdges = await ctx.store.listRelations({
      subject_prefix: tid,
    });
    // AC-scoped global edges (`ac:AC-n` subjects).
    const acEdges: Relation[] = [];
    for (const ac of acs) {
      acEdges.push(
        ...(await ctx.store.listRelations({ subject: `ac:${ac.ac_id}` })),
      );
      acEdges.push(
        ...(await ctx.store.listRelations({
          subject: `${tid}:ac:${ac.ac_id}`,
        })),
      );
    }
    // Dedupe — subject_prefix already covers `SR-x:ac:*` edges that the
    // per-AC lookups also return; the same edge twice would emit the
    // same deterministic finding id twice (fail-closed dup check).
    const edges = [
      ...new Map(
        [...ticketEdges, ...acEdges].map((e) => [
          `${e.subject}${e.predicate}${e.object}`,
          e,
        ]),
      ).values(),
    ];
    const edgeText = edges
      .map((e) => `${e.object} ${e.evidence ?? ''} ${e.valid_at ?? ''}`)
      .join('\n');
    const approved = APPROVED_BEHAVIOR.has(ticket.status);

    for (const ac of acs) {
      const acRefs = new Set([`ac:${ac.ac_id}`, `${tid}:ac:${ac.ac_id}`]);
      const acEdgeSet = edges.filter((e) => acRefs.has(e.subject));
      const impl = acEdgeSet.filter((e) => IMPL_PREDICATES.has(e.predicate));
      const test = acEdgeSet.filter((e) => TEST_PREDICATES.has(e.predicate));
      const implSettled = impl.filter(
        (e) => e.verification && SETTLED_POSITIVE.has(e.verification),
      );
      const implSuggested = impl.filter(
        (e) => !e.verification || e.verification === 'suggested',
      );
      const testSettled = test.filter(
        (e) => e.verification && SETTLED_POSITIVE.has(e.verification),
      );
      const testRejected = test.filter((e) => e.verification === 'rejected');
      const acRef = `ac:${tid}:${ac.ac_id}`;

      // --- missing-implementation-evidence --------------------------
      if (implSettled.length === 0) {
        push(
          'missing-implementation-evidence',
          'major',
          acRef,
          `${acRef} ("${ac.text.slice(0, 120)}") has no settled implements/documents edge — the intent may be unbuilt.`,
          implSuggested.length > 0 ? 0.6 : 0.75,
          [acRef, `doc:${tid}:ticket.md#acceptance-criteria`],
          {
            // A suggested-but-unverified link is evidence the gap may
            // already be closing — disclosed, never hidden.
            disconfirming_refs: implSuggested.map(edgeRef),
            next: `link the implementing code unit for ${acRef} or run /evidence/search to locate it`,
          },
        );
        continue;
      }

      // --- stale implementation pins → drift / affected-approved -----
      for (const e of implSettled) {
        for (const pin of codePins(`${e.object} ${e.evidence ?? ''}`)) {
          const head = headByRepo.get(pin.repo);
          if (!head) continue; // unindexed repo: no freshness claim
          if (head === pin.sha || head.startsWith(pin.sha)) continue;
          push(
            approved ? 'affected-approved-behavior' : 'likely-drift',
            approved ? 'major' : 'minor',
            `${acRef}:${pin.repo}:${pin.sha}`,
            approved
              ? `${acRef} implementation evidence pins ${pin.repo}@${pin.sha.slice(0, 12)} but head moved to ${head.slice(0, 12)} — a merged change may affect previously approved behavior.`
              : `${acRef} implementation evidence pins ${pin.repo}@${pin.sha.slice(0, 12)}, superseded by ${head.slice(0, 12)} — likely spec/code drift.`,
            approved ? 0.8 : 0.7,
            [acRef, edgeRef(e), `repo-index:${pin.repo}@${head}`],
            {
              disconfirming_refs: testSettled.map(edgeRef),
              freshness: 'stale',
              next: `re-index or re-link ${pin.repo}@${head.slice(0, 12)} and re-verify ${acRef}`,
            },
          );
        }
      }

      // --- unverified-ac ---------------------------------------------
      const report = await latestTestReportRef(ctx, tid);
      const hasTestEvidence =
        testSettled.length > 0 || (report?.passed ?? false);
      if (!hasTestEvidence) {
        const disconfirming = [
          // A report exists but isn't green — disclose it; the claim
          // stays a hypothesis either way.
          ...(report ? [report.ref] : []),
          // Suggested (unsettled) test edges may yet verify the AC.
          ...test
            .filter((e) => !e.verification || e.verification === 'suggested')
            .map(edgeRef),
        ];
        push(
          'unverified-ac',
          'major',
          acRef,
          `${acRef} has implementation evidence but no settled test/` +
            `verified-by edge${report ? ' and its latest test report is not green' : ' and no passing test-report.json'} — verification is unproven.`,
          report && !report.passed ? 0.8 : 0.65,
          [acRef, ...implSettled.map(edgeRef), ...testRejected.map(edgeRef)],
          {
            disconfirming_refs: disconfirming,
            freshness: report ? 'current' : 'stale',
            next: `attach test evidence for ${acRef} (tests/verified-by edge or a green test-report.json)`,
          },
        );
      }
    }

    // --- unlinked-change ----------------------------------------------
    for (const tr of await ctx.store.listTicketRepos({
      workspace: ctx.workspace,
      ticket_id: tid,
    })) {
      if (tr.pr_state !== 'merged' || !tr.merged_sha) continue;
      if (edgeText.includes(tr.merged_sha)) continue; // cited → linked
      push(
        'unlinked-change',
        'info',
        `change:${tid}:${tr.repo}:${tr.merged_sha}`,
        `${tid}/${tr.repo} merged ${tr.merged_sha.slice(0, 12)} with no traceability edge citing the SHA — the change may lack linked intent.`,
        0.55,
        [`ticket-repo:${tid}:${tr.repo}`, `commit:${tr.repo}@${tr.merged_sha}`],
        {
          next: `record an implements/documents edge citing ${tr.repo}@${tr.merged_sha.slice(0, 12)} or confirm the merge was out-of-scope`,
        },
      );
    }
  }

  return validateAlignmentFindings({
    schema: 1,
    workspace: ctx.workspace,
    scope,
    index_heads,
    findings,
    generated_at: ctx.now().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// run lifecycle (dedupe + budgets + durable artifact + event)
// ---------------------------------------------------------------------------

export interface RunAlignmentArgs {
  scope: string;
  trigger: AlignmentTrigger;
  /** The merged head that fired an `on-merge` run — the dedupe key. */
  triggerSha?: string | null;
  runNonce?: string;
  notify?: (event: { type: 'alignment_status'; payload: unknown }) => void;
}

/**
 * Accumulated alignment spend for a scope, checked BEFORE a run when
 * the operator configured caps — deterministic comparison costs no
 * tokens today, but the honor-the-limit contract is enforced here so a
 * future model-assisted pass can't silently overrun (wp-112 AC).
 */
async function assertBudget(
  ctx: AlignCtx,
  cfg: EffectiveConfig,
  scope: string,
): Promise<void> {
  const tokenCap = cfg.budgets.tokens_cap_per_ticket;
  const usdCap = cfg.budgets.spend_cap_usd_per_ticket;
  if (tokenCap == null && usdCap == null) return;
  const prior = await ctx.store.listAlignmentRuns({
    workspace: ctx.workspace,
    scope,
  });
  const tokens = prior.reduce(
    (s, r) => s + (r.tokens_in ?? 0) + (r.tokens_out ?? 0),
    0,
  );
  const usd = prior.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  if (tokenCap != null && tokens >= tokenCap) {
    throw new AlignmentServiceError(
      'budget',
      `alignment token cap reached for ${scope}: ${tokens} >= ${tokenCap}`,
    );
  }
  if (usdCap != null && usd >= usdCap) {
    throw new AlignmentServiceError(
      'budget',
      `alignment spend cap reached for ${scope}: $${usd} >= $${usdCap}`,
    );
  }
}

/**
 * Execute one comparison and persist it. Idempotent for `on-merge`:
 * the same (scope, trigger_sha) returns the existing run untouched.
 */
export async function runAlignment(
  ctx: AlignCtx,
  cfg: EffectiveConfig,
  args: RunAlignmentArgs,
): Promise<{
  run: AlignmentRunRow;
  artifact: AlignmentFindings | null;
  created: boolean;
}> {
  const mode = cfg.intelligence.alignment;
  if (mode === 'off') {
    throw new AlignmentServiceError(
      'disabled',
      'intelligence.alignment is off — enable manual or on-merge',
    );
  }
  if (args.trigger === 'on-merge' && mode !== 'on-merge') {
    throw new AlignmentServiceError(
      'disabled',
      `intelligence.alignment is '${mode}' — on-merge runs require on-merge mode`,
    );
  }
  await assertBudget(ctx, cfg, args.scope);

  const nowIso = ctx.now().toISOString();
  const run: AlignmentRunRow = {
    workspace: ctx.workspace,
    run_id: alignmentRunId(
      ctx.workspace,
      args.scope,
      args.trigger,
      args.triggerSha ?? null,
      args.runNonce ?? nowIso,
    ),
    scope: args.scope,
    trigger: args.trigger,
    trigger_sha: args.triggerSha ?? null,
    index_heads: [],
    status: 'running',
    finding_count: 0,
    artifact: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    created_at: nowIso,
    finished_at: null,
  };

  const inserted = await ctx.store.insertAlignmentRun(run);
  if (inserted.state === 'existing') {
    const prev = inserted.run;
    return {
      run: prev,
      artifact: prev.artifact
        ? validateAlignmentFindings(JSON.parse(prev.artifact))
        : null,
      created: false,
    };
  }
  args.notify?.({
    type: 'alignment_status',
    payload: { scope: args.scope, run_id: run.run_id, status: 'running' },
  });

  try {
    const artifact = await compareAlignment(ctx, args.scope);
    const ts = ctx.now().toISOString();
    for (const f of artifact.findings) {
      const row: AlignmentFindingRow = {
        ...f,
        workspace: ctx.workspace,
        run_id: run.run_id,
        scope: args.scope,
        created_at: ts,
        updated_at: ts,
      };
      await ctx.store.upsertAlignmentFinding(row);
    }
    const artifactJson = `${JSON.stringify(artifact, null, 2)}\n`;
    await ctx.store.updateAlignmentRun(
      { workspace: ctx.workspace, run_id: run.run_id },
      {
        status: 'done',
        finding_count: artifact.findings.length,
        artifact: artifactJson,
        index_heads: artifact.index_heads,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        finished_at: ts,
      },
    );
    const done: AlignmentRunRow = {
      ...run,
      status: 'done',
      finding_count: artifact.findings.length,
      artifact: artifactJson,
      index_heads: artifact.index_heads,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      finished_at: ts,
    };
    await ctx.store.appendEvent({
      workspace: ctx.workspace,
      ticket_id: /^SR-|^T-/.test(args.scope) ? args.scope : null,
      ts,
      stage: null,
      actor_type: 'system',
      actor_id: ctx.actor,
      event: 'alignment_run_completed',
      run: run.run_id,
      refs: artifact.findings.map((f) => `alignment:${f.id}`),
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
      data: {
        scope: args.scope,
        trigger: args.trigger,
        trigger_sha: args.triggerSha ?? null,
        finding_count: artifact.findings.length,
        index_heads: artifact.index_heads,
      },
    });
    args.notify?.({
      type: 'alignment_status',
      payload: {
        scope: args.scope,
        run_id: run.run_id,
        status: 'done',
        finding_count: artifact.findings.length,
      },
    });
    return { run: done, artifact, created: true };
  } catch (e) {
    await ctx.store.updateAlignmentRun(
      { workspace: ctx.workspace, run_id: run.run_id },
      { status: 'failed', finished_at: ctx.now().toISOString() },
    );
    throw e;
  }
}

// ---------------------------------------------------------------------------
// human decisions — inspect/dismiss/verify/resolve (OCC + audit + event)
// ---------------------------------------------------------------------------

const ACTION_TARGET: Record<string, AlignmentFindingRow['status']> = {
  dismiss: 'dismissed',
  verify: 'verified',
  resolve: 'resolved',
  reopen: 'open',
};

export interface DecideFindingArgs {
  id: string;
  action: 'dismiss' | 'verify' | 'resolve' | 'reopen';
  /** OCC — the status the human saw. */
  expected: AlignmentFindingRow['status'] | null | undefined;
  rationale?: string | null;
}

/**
 * Human decision on a finding. Idempotent (repeat = noop, no event),
 * OCC-guarded (racing write → 'conflict' → 409), append-only audited
 * (`alignment_finding_decisions` + `alignment_finding_decided` event),
 * and the finding row's original claim/evidence is never rewritten.
 */
export async function decideAlignmentFinding(
  ctx: AlignCtx,
  args: DecideFindingArgs,
): Promise<AlignmentFindingRow> {
  const next = ACTION_TARGET[args.action];
  if (!next) {
    throw new AlignmentServiceError(
      'invalid',
      `unknown alignment action '${args.action}'`,
    );
  }
  const prior = await ctx.store.getAlignmentFinding({
    workspace: ctx.workspace,
    id: args.id,
  });
  if (!prior) {
    throw new AlignmentServiceError(
      'missing',
      `no alignment finding '${args.id}' in ${ctx.workspace}`,
    );
  }
  // Idempotent: already at the target status → noop, no event, no
  // audit row (the same contract decideRelation exposes).
  if (prior.status === next) return prior;
  const at = ctx.now().toISOString();
  const result = await ctx.store.transaction(async (tx) => {
    const r = await tx.decideAlignmentFinding(
      { workspace: ctx.workspace, id: args.id },
      args.expected ?? null,
      next,
      at,
    );
    if (r.state !== 'updated') return r;
    const seq =
      (
        await tx.listAlignmentFindingDecisions({
          workspace: ctx.workspace,
          finding_id: args.id,
        })
      ).length + 1;
    await tx.appendAlignmentFindingDecision({
      workspace: ctx.workspace,
      finding_id: args.id,
      seq,
      status: next,
      actor: ctx.actor,
      rationale: args.rationale ?? null,
      at,
    });
    await tx.appendEvent({
      workspace: ctx.workspace,
      ticket_id: /^SR-|^T-/.test(prior.scope) ? prior.scope : null,
      ts: at,
      stage: null,
      actor_type: 'human',
      actor_id: ctx.actor,
      event: 'alignment_finding_decided',
      run: prior.run_id,
      refs: [`alignment:${args.id}`],
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
      data: {
        id: args.id,
        scope: prior.scope,
        kind: prior.kind,
        action: args.action,
        prior: prior.status,
        status: next,
        rationale: args.rationale ?? null,
      },
    });
    return r;
  });
  if (result.state === 'missing') {
    throw new AlignmentServiceError(
      'missing',
      `no alignment finding '${args.id}' in ${ctx.workspace}`,
    );
  }
  if (result.state === 'conflict') {
    throw new AlignmentServiceError(
      'conflict',
      `stale write: expected status '${args.expected}', finding is '${result.current ?? 'unset'}'`,
      result.current,
    );
  }
  return { ...prior, status: next };
}

/** Re-exported for API error mapping without reaching into release/. */
export { ReleaseError };
