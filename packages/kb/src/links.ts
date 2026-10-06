/**
 * links.ts — wp-111 traceability-link service (D37, INTELLIGENCE §1/§12,
 * DB-SCHEMA `relations`, SCHEMAS §12).
 *
 * Verification-state contract:
 *  - explicit workflow links (`source: explicit | human`) persist
 *    `verified` — the workflow's own declarations are authoritative.
 *  - model/tool links persist `suggested`, or `auto-verified` when
 *    confidence ≥ `intelligence.auto_verify_confidence` — visibly
 *    labeled automated, NEVER `verified` (a suggestion must not
 *    masquerade as verified).
 *  - human verify/reject is idempotent, evented (`link_verified` /
 *    `link_rejected`), and concurrency-safe: the OCC update carries the
 *    state the human saw (`expected`); a racing write loses with
 *    `conflict` → HTTP 409. Repeating the same action on an edge
 *    already in the target state is a `noop` — no duplicate event.
 *
 * Evidence guards (verify only): an edge that cites commit-pinned code
 * (`code:<repo>:<sha>:…` in `object`/`evidence`, or a sha `valid_at`)
 * can only land `verified` when the pin IS the repo's current index
 * head and the repo is inside the subject ticket's authorized scope
 * (ticket.repos ∩ config.repos). Stale → `stale`; out-of-scope →
 * `unauthorized`. Edges with no commit pin skip the freshness check.
 */
import type { Config, Relation, RelationVerification, Store } from '@veto/core';
import { RelationSchema } from '@veto/core';

export type LinkAction = 'verify' | 'reject';

/** Why a link operation failed — mapped to HTTP by the API layer. */
export type LinkErrorKind =
  | 'invalid' // 400 — bad edge/proposal shape
  | 'missing' // 404 — no such edge
  | 'conflict' // 409 — stale `expected` state
  | 'stale' // 409 — evidence pin is not the current index head
  | 'unauthorized'; // 403 — cited repo outside the subject's scope

export class LinkError extends Error {
  readonly kind: LinkErrorKind;
  /** The live verification state on a conflicted edge (OCC detail). */
  readonly current?: string | null | undefined;
  constructor(kind: LinkErrorKind, message: string, current?: string | null) {
    super(message);
    this.name = 'LinkError';
    this.kind = kind;
    this.current = current;
  }
}

/** `code:<repo>:<sha>:…` object_ref / evidence citation (SCHEMAS §17). */
const CODE_REF = /^code:([A-Za-z0-9_.\-/]+):([0-9a-f]{7,40}):/;
/** Bare commit-sha citation (`valid_at` boundary). */
const SHA = /^[0-9a-f]{7,40}$/;

interface CodePin {
  repo: string;
  sha: string;
}

/** Commit pins cited by an edge (`code:` refs in object/evidence). */
function codePins(edge: Pick<Relation, 'object' | 'evidence'>): CodePin[] {
  const pins: CodePin[] = [];
  for (const text of [edge.object, edge.evidence ?? '']) {
    const m = CODE_REF.exec(text ?? '');
    if (m?.[1] && m[2]) pins.push({ repo: m[1], sha: m[2] });
  }
  return pins;
}

/**
 * The verification a fresh proposal lands with (INTELLIGENCE §12):
 * explicit/human → `verified`; model/tool → `auto-verified` above the
 * configured confidence bar, else `suggested`. A model/tool proposal
 * WITHOUT confidence is invalid (DB-SCHEMA: confidence is required on
 * inferred links — fail closed).
 */
export function proposalVerification(
  source: Relation['source'],
  confidence: number | undefined,
  cfg: Pick<Config, 'intelligence'>,
): RelationVerification {
  if (source === 'explicit' || source === 'human') return 'verified';
  if (confidence === undefined) {
    throw new LinkError(
      'invalid',
      `inferred link (source: ${source ?? 'model'}) requires confidence`,
    );
  }
  return confidence >= cfg.intelligence.auto_verify_confidence
    ? 'auto-verified'
    : 'suggested';
}

/**
 * Record a workflow/model link. Idempotent: an existing edge keeps its
 * current verification state — a re-proposal never downgrades a
 * `verified`/`rejected` edge back to `suggested`. Returns the stored
 * edge + whether it was newly inserted.
 */
export async function proposeLink(
  store: Store,
  cfg: Pick<Config, 'intelligence'>,
  input: Relation,
): Promise<{ edge: Relation; created: boolean }> {
  const parsed = RelationSchema.safeParse(input);
  if (!parsed.success) {
    throw new LinkError(
      'invalid',
      `link proposal failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    );
  }
  const key = {
    subject: parsed.data.subject,
    predicate: parsed.data.predicate,
    object: parsed.data.object,
  };
  const existing = await store.listRelations(key);
  const head = existing[0];
  if (head) return { edge: head, created: false };
  // Verification is always DERIVED — a caller can never self-declare
  // `verified`; verified arrives only via explicit/human source or the
  // guarded decideLink path.
  const edge: Relation = {
    ...parsed.data,
    verification: proposalVerification(
      parsed.data.source,
      parsed.data.confidence,
      cfg,
    ),
  };
  await store.upsertRelation(edge);
  return { edge, created: true };
}

/** Ticket-scoped authorized repos for an edge subject (a subject may
 *  carry a suffix like `SR-0001:ac:AC-2` — the ticket id is the first
 *  segment). No ticket row → the configured repo set (workspace-level
 *  subjects aren't ticket-bounded). */
async function authorizedRepos(
  store: Store,
  cfg: Pick<Config, 'repos'>,
  workspace: string,
  subject: string,
): Promise<Set<string>> {
  const configured = new Set(Object.keys(cfg.repos ?? {}));
  const ticketId = subject.split(':')[0] ?? subject;
  const ticket = await store.getTicket({
    workspace,
    ticket_id: ticketId,
  });
  if (!ticket) return configured;
  return new Set([...configured].filter((r) => ticket.repos.includes(r)));
}

/**
 * Staleness/unauthorized guards for a verify decision (INTELLIGENCE
 * "stale or unauthorized evidence can never verify"). Skipped for
 * edges with no commit pin (doc↔doc links aren't index-bound).
 */
async function guardVerify(
  store: Store,
  cfg: Pick<Config, 'repos'>,
  workspace: string,
  edge: Relation,
): Promise<void> {
  const pins = codePins(edge);
  const shaBoundary =
    edge.valid_at && SHA.test(edge.valid_at) ? edge.valid_at : null;
  if (pins.length === 0 && shaBoundary === null) return;

  const allowed = await authorizedRepos(store, cfg, workspace, edge.subject);
  const shas = pins.map((p) => p.sha);
  if (shaBoundary) shas.push(shaBoundary);
  const pinMatchesHead = (pinSha: string, headSha: string) =>
    pinSha === headSha || headSha.startsWith(pinSha);

  // Every cited repo must be in scope AND its pin must be the current
  // head; a sha boundary must pin SOME in-scope repo's current head.
  let boundaryMatched = shaBoundary === null;
  for (const repo of new Set(pins.map((p) => p.repo))) {
    if (!allowed.has(repo)) {
      throw new LinkError(
        'unauthorized',
        `edge cites repo '${repo}' outside the authorized scope`,
      );
    }
    const pin = pins.find((p) => p.repo === repo);
    const head = await store.getCurrentRepoIndex(workspace, repo);
    if (!head || !pin || !pinMatchesHead(pin.sha, head.commit_sha)) {
      throw new LinkError(
        'stale',
        `edge pin for '${repo}' is not the current index head ` +
          `(${head?.commit_sha.slice(0, 12) ?? 'no current head'})`,
      );
    }
    if (shaBoundary && pinMatchesHead(shaBoundary, head.commit_sha)) {
      boundaryMatched = true;
    }
  }
  if (!boundaryMatched) {
    // A sha boundary that matches no cited repo's head must pin one of
    // the other in-scope repos' current heads, else it is stale.
    for (const repo of allowed) {
      const head = await store.getCurrentRepoIndex(workspace, repo);
      if (shaBoundary && head && pinMatchesHead(shaBoundary, head.commit_sha)) {
        boundaryMatched = true;
        break;
      }
    }
    if (!boundaryMatched) {
      throw new LinkError(
        'stale',
        `valid_at boundary '${shaBoundary}' matches no current index head`,
      );
    }
  }
}

export interface DecideLinkArgs {
  workspace: string;
  subject: string;
  predicate: string;
  object: string;
  action: LinkAction;
  /** OCC — the verification state the human saw (`null` for an edge
   *  the human saw with no verification column set). */
  expected: Relation['verification'];
  actor: string;
  run?: string;
}

/**
 * Human verify/reject (wp-111 acceptance: idempotent + evented +
 * 409-stale). Returns the edge after the decision.
 */
export async function decideLink(
  store: Store,
  cfg: Pick<Config, 'repos'>,
  args: DecideLinkArgs,
): Promise<Relation> {
  const key = {
    subject: args.subject,
    predicate: args.predicate,
    object: args.object,
  };
  const edge = (await store.listRelations(key))[0];
  if (!edge) {
    throw new LinkError(
      'missing',
      `no relation edge ${args.subject} -[${args.predicate}]-> ${args.object}`,
    );
  }
  const next: RelationVerification =
    args.action === 'verify' ? 'verified' : 'rejected';
  if (args.action === 'verify') {
    // Stale/unauthorized guards run BEFORE the write — a rejected or
    // suggested edge can't be flipped verified off stale evidence.
    await guardVerify(store, cfg, args.workspace, edge);
  }

  const result = await store.transaction(async (tx) => {
    const r = await tx.decideRelation(key, args.expected, next);
    if (r.state !== 'updated') return r;
    // ticket_id on the event is the ticket-shaped first subject segment
    // (SR-12, SR-12:ac:* → SR-12); workspace-level subjects (board:x,
    // feature:y) carry none — null, never a garbage segment.
    const seg = edge.subject.split(':')[0] ?? '';
    const ticketId = /^[A-Z]+-[A-Z0-9]+$/.test(seg) ? seg : null;
    await tx.appendEvent({
      workspace: args.workspace,
      ticket_id: ticketId,
      ts: new Date().toISOString(),
      stage: null,
      actor_type: 'human',
      actor_id: args.actor,
      event: args.action === 'verify' ? 'link_verified' : 'link_rejected',
      run: args.run ?? null,
      refs: [`relation:${key.subject}:${key.predicate}`],
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      usage_source: null,
      duration_s: null,
      human_minutes: null,
      data: {
        subject: key.subject,
        predicate: key.predicate,
        object: key.object,
        prior: edge.verification ?? null,
        verification: next,
        source: edge.source ?? null,
        confidence: edge.confidence ?? null,
        valid_at: edge.valid_at ?? null,
      },
    });
    return r;
  });

  if (result.state === 'missing') {
    throw new LinkError(
      'missing',
      `no relation edge ${args.subject} -[${args.predicate}]-> ${args.object}`,
    );
  }
  if (result.state === 'conflict') {
    throw new LinkError(
      'conflict',
      `stale write: expected verification '${args.expected}', edge is ` +
        `'${result.current ?? 'unset'}'`,
      result.current,
    );
  }
  // updated | noop (already at target — idempotent, no event emitted).
  return { ...edge, verification: next };
}
