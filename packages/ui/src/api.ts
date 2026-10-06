/**
 * REST client for the conductor surface (API.md).
 *
 * Auth: bearer token on EVERY request. Browser bootstrap is the
 * loopback `GET /?token=` flow — the server sets a `veto_session`
 * cookie; we also keep the token in sessionStorage so fetch calls and
 * the SSE stream authenticate through either channel (EventSource
 * cannot set headers; it sends the cookie same-origin).
 */
import type {
  BoardItem,
  Claim,
  DeploymentRow,
  DossierEntry,
  EventRow,
  FeatureExposureRow,
  FeatureRow,
  GateItem,
  InterviewBranchRow,
  InterviewMessageRow,
  InterviewSessionRow,
  KnowledgeSlotRow,
  QuestionCandidateRow,
  Relation,
  RelationVerification,
  ReleaseApprovalRow,
  ReleaseItemRow,
  ReleaseManifestRow,
  ReleaseNoteRow,
  ReleaseRow,
  RsQuality,
  RunRow,
  StatementArtifactLinkRow,
  StatementClarificationRow,
  StatementDecisionRow,
  StatementRelationRow,
  StatementRow,
  StatementVersionRow,
  TicketRepoRow,
  TicketRow,
  Triage,
} from '@veto/core';

const TOKEN_KEY = 'veto_ui_token';
/** wp-100 rename — one-time migration from the pre-rename key. */
const LEGACY_TOKEN_KEY = 'sr_ui_token';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly refs?: string[];

  constructor(status: number, code: string, message: string, refs?: string[]) {
    super(message);
    this.status = status;
    this.code = code;
    if (refs) this.refs = refs;
  }
}

export function getToken(): string | null {
  try {
    const token =
      sessionStorage.getItem(TOKEN_KEY) ??
      localStorage.getItem(TOKEN_KEY) ??
      sessionStorage.getItem(LEGACY_TOKEN_KEY) ??
      localStorage.getItem(LEGACY_TOKEN_KEY);
    if (token) setToken(token); // migrate legacy key forward
    return token;
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(TOKEN_KEY, token);
      sessionStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

/**
 * Bootstrap flow (API.md auth): if the page was opened with
 * `?token=<token>`, exchange it for the session cookie via
 * `GET /?token=` (loopback-only server-side), stash the token for the
 * Authorization header, and strip it from the URL.
 */
export async function bootstrapAuth(
  search: string = window.location.search,
): Promise<string | null> {
  const params = new URLSearchParams(search);
  const token = params.get('token');
  if (!token) return getToken();
  try {
    // Sets veto_session cookie (HttpOnly, SameSite=Strict). Loopback only.
    await fetch(`/?token=${encodeURIComponent(token)}`, {
      credentials: 'same-origin',
    });
  } catch {
    /* cookie bootstrap is best-effort; bearer header still applies */
  }
  setToken(token);
  params.delete('token');
  const rest = params.toString();
  const url = `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
  return token;
}

function authHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: authHeaders(init),
  });
  if (!res.ok) {
    let code = 'request_failed';
    let message = `${res.status} ${res.statusText}`;
    let refs: string[] | undefined;
    try {
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        refs?: string[];
      };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
      if (body.refs) refs = body.refs;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message, refs);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---- response shapes (server.ts routes; DB-SCHEMA row payloads) ----

export interface InboxItem extends GateItem {
  claim: Claim | null;
}
export interface InboxResponse {
  items: InboxItem[];
}

// ---- /board — S-01 pipeline board (API.md) ----

/** The five phase columns collapsing the status enum (s-01-board §4). */
export type BoardPhase = 'backlog' | 'spec' | 'build' | 'review' | 'done';

/**
 * Server-computed valid drop for a card (s-01 DnD table). The board is
 * authoritative — the UI highlights `drop_targets` columns only and
 * never infers transitions.
 */
export interface DropTarget {
  /** The column this card may be dropped onto. */
  column: BoardPhase;
  /** 'wont_do'|'abort'|'retry' → POST …/actions; 'claim' → claim gate. */
  action: 'wont_do' | 'abort' | 'retry' | 'claim';
  /** For claim — the gate item name to claim. */
  gate?: string;
  /** Whether the UI must confirm before posting. */
  confirm: boolean;
  /** Human copy for the confirm modal / column hint. */
  label: string;
}

/** A gate_item riding a board card, with its claim (badge initials). */
export interface BoardAttention extends GateItem {
  claim: Claim | null;
}

export interface BoardCard {
  ticket: TicketRow;
  /** `${workspace}/${ticket_id}` — the ref used in routes/actions. */
  ref: string;
  /** Derived column — for failed/blocked, the phase it died in. */
  phase: BoardPhase;
  flagged: 'failed' | 'blocked' | null;
  /** Every open gate snoozed → the card leaves the board (D20/D22). */
  snoozed: boolean;
  snoozed_until: string | null;
  /** Delivery dimension (DELIVERY §8 — two-dimension card display):
   *  the ticket's strongest release_item state + its release, or null
   *  when the ticket is in no release scope. */
  delivery: { release_id: string; state: string } | null;
  /** Open gate items, ranked human-anxiety-first server-side. */
  attention: BoardAttention[];
  live_run: { id: string; stage: string; status: string } | null;
  drop_targets: DropTarget[];
}

export interface BoardResponse {
  cards: BoardCard[];
  /** Non-ticket open gate items (survey/import/interview subjects). */
  ops: BoardAttention[];
  /** Configured per-column soft limits (ui.wip_limits — S-02). */
  wip_limits: Partial<Record<BoardPhase, number>>;
  generated_at: string;
}

// ---- Delivery (DELIVERY.md, wp-136/wp-137) ----

/** One Merge Center checklist row (conductor merge/types ChecklistItem). */
export interface MergeChecklistItem {
  /** `approval` | `scope` | `ac-evidence` | `checks` | `security` |
   *  `depends-on` | `conflict` | `branch-protection` | `dod`. */
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  /** Gate surfaced when this item blocks (`merge` | `merge_conflict`). */
  gate?: string;
}

/** GET /merge-center/:workspace — per-ticket readiness rollup. */
export interface MergeReadiness {
  ticket_id: string;
  ready: boolean;
  items: MergeChecklistItem[];
  blockers: MergeChecklistItem[];
  /** repo → current PR head SHA. */
  heads: Record<string, string | null>;
  at: string;
}

/** GET /releases/:ws/:rel — the release detail payload (API.md). */
export interface ReleaseDetail {
  release: ReleaseRow;
  items: ReleaseItemRow[];
  manifests: ReleaseManifestRow[];
  /** Latest manifest — what approvals/gates bind to. */
  manifest: ReleaseManifestRow | null;
  /** Approvals bound to the latest manifest version. */
  approvals: ReleaseApprovalRow[];
  /** All approval rows incl. superseded versions (audit). */
  approvalHistory: ReleaseApprovalRow[];
  /** Latest verdict per release gate (manifest|approved|merged|
   *  partial-ac|corrections → pass|fail|waived). */
  gates: Record<string, { result: string; checked_at: string }>;
  /** Publication metadata per audience. */
  notes: ReleaseNoteRow[];
  /** Confirmed deployments (manual evidence, invariant 4). */
  deployments: DeploymentRow[];
  /** Latest draft doc_version per audience — a draft newer than the
   *  note's pinned `doc_version` is unapproved content. */
  noteDrafts: Record<
    string,
    { version: number; created_at: string | null } | null
  >;
}

export type ReleaseNoteAudience = 'customer' | 'stakeholder' | 'technical';

export interface TicketDocMeta {
  doc: string;
  version: number;
  edited_by: string | null;
  created_at: string | null;
}

export interface TicketDetail {
  ticket: TicketRow;
  ticket_md: string | null;
  triage: Triage | null;
  repos: TicketRepoRow[];
  /** Latest doc_versions metadata per doc on the subject (D29). */
  docs: TicketDocMeta[];
  /** Derived board phase — same rule as /board (wp-081). */
  phase: BoardPhase;
  flagged: 'failed' | 'blocked' | null;
  open_gates: GateItem[];
  family: TicketRow[];
  /** §15.7 Ticket Workbench (wp-151) — per-type tabs + policy evidence. */
  workbench?: Workbench | null;
}

/** One policy evidence requirement as the workbench renders it. */
export interface WorkbenchEvidence {
  id: string;
  gate: string;
  label: string;
  satisfied: boolean;
  check: Record<string, unknown>;
}

/** The workbench payload server-computed from taxonomy.ts (the same
 *  policy the conductor enforces at its gates). */
export interface Workbench {
  work_type: string | null;
  origin: string | null;
  severity: string | null;
  severity_rule: 'required' | 'optional' | 'forbidden';
  direct_create: boolean;
  scope_verdict: string | null;
  scope_approval_needed: boolean;
  summary: string | null;
  tabs: string[];
  intake: { key: string; title: string; question: string; required: boolean }[];
  evidence: WorkbenchEvidence[];
  missing: string[];
}

/** Chat-to-edit session (GET /interview/<session> — API.md §16). */
export interface EditSessionTurn {
  ts: string;
  kind: 'session' | 'turn' | 'applied' | 'discarded';
  subject?: string;
  target?: string;
  message?: string;
  run?: string | null;
  outcome?: string;
  doc?: string;
  version?: number;
}

export interface InterviewSession {
  session: string;
  workspace: string;
  subject: string;
  /** Target doc kind (ticket.md | rs.md | tdd.md | vs.md). */
  target: string;
  status:
    | 'queued'
    | 'running'
    | 'proposal'
    | 'clarify'
    | 'refused'
    | 'applied'
    | 'discarded';
  turns: EditSessionTurn[];
  proposal: { run: string; diff: string } | null;
  gate: { kind: string; surfaced_at: string } | null;
}

// ---- Feature Workspace (PRD §15.7, wp-152) ----

export interface FeatureHealthFinding {
  id: string;
  kind:
    | 'blocked_ticket'
    | 'failed_ticket'
    | 'open_gate'
    | 'unverified_ac'
    | 'stale_approval'
    | 'undelivered_ticket'
    | 'not_accepted'
    | 'no_tickets';
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  refs: string[];
}

export interface FeatureAcRow {
  ac_id: string;
  criterion: string;
  evidence: Relation[];
  verified: boolean;
}

export interface FeatureDocMeta {
  doc: string;
  version: number;
  edited_by: string | null;
  created_at: string | null;
}

export interface FeatureAcceptance {
  accepted: boolean;
  at?: string;
  by?: string;
  exclusions?: string[];
}

export interface FeatureReleaseInfo {
  memberships: {
    release: {
      release_id: string;
      title: string;
      status: string;
    };
    item: {
      item_kind: string;
      item_id: string;
      partial_ac: string[] | null;
      delivery_state: string;
      approved_by: string | null;
      removed_at: string | null;
    };
  }[];
  exposure: {
    environment: string;
    state: string;
    deployment_id: string | null;
  }[];
  deployments: {
    deployment_id: string;
    release_id: string;
    environment: string;
    confirmed_by: string | null;
    confirmed_at: string | null;
  }[];
}

export interface FeatureDetail {
  feature: FeatureRow;
  initiative: { initiative: string; title: string; status: string } | null;
  docs: FeatureDocMeta[];
  tickets: TicketRow[];
  /** work_type → status → count (Tickets tab grouping). */
  tickets_by_type: Record<string, Record<string, number>>;
  requirements: {
    /** First verified `documents` edge, else first documents edge —
     *  server-chosen; the UI never re-derives primacy. */
    primary: Relation | null;
    edges: Relation[];
  };
  /** Explainable findings list — never an opaque score. */
  health: FeatureHealthFinding[];
  acceptance: FeatureAcceptance;
  release: FeatureReleaseInfo;
  events: EventRow[];
}

export interface AcceptancePackage {
  feature: FeatureRow;
  scope: {
    doc: { version: number; content: string; created_at: string | null } | null;
    approved_at: string | null;
    approved_by: string | null;
  };
  acceptance_criteria: FeatureAcRow[];
  docs: { doc: string; version: number; created_at: string | null }[];
  tickets: {
    ticket_id: string;
    title: string;
    status: string;
    delivered: boolean;
    merged_refs: string[];
  }[];
  exclusions: string[];
  accepted: { at: string; by: string; exclusions: string[] } | null;
  findings: FeatureHealthFinding[];
}

export interface DocResponse {
  name: string;
  doc: string;
  content: string;
  /** Latest doc_versions version number (D29). */
  version?: number;
  versions: {
    version: number;
    edited_by: string | null;
    created_at: string | null;
  }[];
  /** Consecutive-version diffs, computed server-side (from/to are vN). */
  diffs: { from: string; to: string; diff: string }[];
}

// ---- wp-111 — traceability links + pinned citations -----------------

/** POST /links/decide body — OCC `expected` is the state the human saw. */
export interface LinkDecisionBody {
  workspace: string;
  subject: string;
  predicate: string;
  object: string;
  action: 'verify' | 'reject';
  expected: RelationVerification | null;
  run?: string | null;
}

// ---- wp-112 — continuous alignment (SCHEMAS §18) -------------------

/** One alignment finding — a reviewable hypothesis, never a verdict.
 *  All evidence refs render; nothing is hidden. */
export interface AlignmentFinding {
  id: string;
  workspace: string;
  run_id: string;
  scope: string;
  kind: string;
  severity: string;
  claim: string;
  confidence: number;
  evidence_refs: string[];
  disconfirming_refs: string[];
  freshness: 'current' | 'stale';
  suggested_next_check: string;
  status: 'open' | 'dismissed' | 'verified' | 'resolved';
}

export interface AlignmentView {
  scope: string;
  latest_run: {
    run_id: string;
    status: string;
    trigger: string;
    finding_count: number;
    created_at: string;
    finished_at: string | null;
  } | null;
  artifact: { schema: number; index_heads: unknown[] } | null;
  findings: AlignmentFinding[];
}

/** POST /alignment/decide body — OCC `expected` is the status the
 *  human saw (same contract as link decisions). */
export interface AlignmentDecisionBody {
  workspace: string;
  id: string;
  action: 'dismiss' | 'verify' | 'resolve' | 'reopen';
  expected: AlignmentFinding['status'] | null;
  rationale?: string | null;
}

/** GET /evidence/source — a `code:` citation resolved to its pinned
 *  unit. `freshness: 'stale'` means the index head has moved past the
 *  pin — render as historical evidence, never as current. */
export interface EvidenceSource {
  ref: string;
  repo: string;
  commit_sha: string;
  path: string;
  freshness: 'current' | 'stale';
  current_head: string | null;
  unit: {
    symbol: string | null;
    symbol_kind: string | null;
    start_line: number;
    end_line: number;
    content_hash: string;
    content: string;
  } | null;
}

/** GET /repositories/<ws>/<repo>/index — index heads. */
export interface RepoIndexState {
  repo: string;
  current: { commit_sha: string } | null;
  heads: { commit_sha: string }[];
}

/** GET …/rs-quality — latest cited AI quality pass for the PRD. */
export interface RsQualityResponse {
  run_id: string;
  name: string;
  quality: RsQuality;
}

// ---- Discovery surface (PRD §15.3/§15.9, wp-147) ----

/** Idea-board list row (GET /boards) — the type's capabilities ride
 *  the row so the UI never re-derives them. */
export interface IdeaBoardRow {
  workspace: string;
  org?: string | null;
  board: string;
  name?: string | null;
  board_type?: string | null;
  status?: string | null;
  created_at?: string | null;
  type_config?: {
    inputs: string[];
    capabilities: string[];
    outputs: string[];
    approval: string;
  } | null;
}

export interface BoardTaxonomy {
  board_types: string[];
  note_kinds: string[];
  note_importances: string[];
  note_statuses: string[];
  type_config: Record<
    string,
    {
      inputs: string[];
      capabilities: string[];
      outputs: string[];
      approval: string;
    }
  >;
}

export interface IdeaBoardDetail {
  board: IdeaBoardRow;
  type_config: IdeaBoardRow['type_config'];
  items: { item: BoardItem; statements: StatementRow[] }[];
}

/** Versioned wizard catalog entry (GET /interview-wizards). */
export interface InterviewWizard {
  wizard_id: string;
  name: string | null;
  description: string | null;
  version: number;
  current_version: number | null;
  slots: {
    slot: string;
    label: string | null;
    required: boolean;
    scope: string | null;
    question: string | null;
  }[];
  thresholds: { draft: string[]; approval: string[] };
}

export interface ReadinessBlocker {
  slot: string;
  state: string;
  reason: string;
}

/** Explainable readiness report (§15.9) — indicators, never a score. */
export interface ReadinessReport {
  draft_ready: boolean;
  approval_ready: boolean;
  required_total: number;
  states: Record<string, number>;
  draft_blockers: ReadinessBlocker[];
  approval_blockers: ReadinessBlocker[];
  open_decisions: string[];
  summary: string;
}

export interface InterviewSessionDetail {
  session: InterviewSessionRow;
  slots: KnowledgeSlotRow[];
  questions: QuestionCandidateRow[];
  pending_question: QuestionCandidateRow | null;
  transcript: InterviewMessageRow[];
  readiness: ReadinessReport;
  branches: InterviewBranchRow[];
}

/** A statement decorated with its open decision item, when any. */
export type PanelStatement = StatementRow & {
  open_decision?: StatementDecisionRow | null;
  open_decisions?: number;
};

/** Understanding Panel payload (wp-146 contract): four buckets +
 *  slots + explainable readiness — never an opaque percentage. */
export interface Understanding {
  session: InterviewSessionRow;
  readiness: ReadinessReport;
  confirmed: { slots: KnowledgeSlotRow[]; statements: PanelStatement[] };
  interpretation: {
    slots: KnowledgeSlotRow[];
    statements: PanelStatement[];
  };
  needs_clarification: {
    slots: KnowledgeSlotRow[];
    clarifications: StatementClarificationRow[];
  };
  decision_required: {
    slots: KnowledgeSlotRow[];
    decisions: (StatementDecisionRow & { statement: StatementRow | null })[];
    statements: PanelStatement[];
  };
}

export interface AnswerResult {
  message: InterviewMessageRow;
  statements: StatementRow[];
  slots: KnowledgeSlotRow[];
  next: {
    candidate: QuestionCandidateRow;
    message: InterviewMessageRow;
  } | null;
  readiness: ReadinessReport;
}

export interface ResumeBriefing {
  session_id: string;
  from_version: number | null;
  to_version: number;
  changed_slots: { slot: string; from: string | null; to: string }[];
  new_messages: InterviewMessageRow[];
  readiness_before: ReadinessReport | null;
  readiness_after: ReadinessReport;
  summary: string;
}

export interface StatementDetail {
  statement: StatementRow;
  versions: StatementVersionRow[];
  relations: {
    outgoing: StatementRelationRow[];
    incoming: StatementRelationRow[];
  };
  decisions: StatementDecisionRow[];
  clarifications: StatementClarificationRow[];
  artifact_links: StatementArtifactLinkRow[];
}

export interface WorkspaceInfo {
  name: string;
  root_path: string;
  queue_depth: number;
  open_gate_items: number;
}

export interface MetricsResponse {
  workspaces: string[];
  tickets_by_status: Record<string, number>;
  runs_by_status: Record<string, number>;
  events_by_name: Record<string, number>;
  open_gate_items: number;
  totals: {
    cost_usd: number;
    tokens_in: number;
    tokens_out: number;
    tokens_cached: number;
    human_minutes: number;
  };
}

export interface ImportPreviewRow {
  [key: string]: unknown;
}

export interface SettingsResponse {
  config: Record<string, unknown>;
}

/** wp-142 Scope Creep Radar — mirrors the conductor's computed report
 *  (PRD §15.5). Metrics only; no opaque score. */
export interface ScopeRadarReport {
  workspace: string;
  computed_at: string;
  subjects: {
    subject: string;
    drift: { doc: string; baseline: number | null; head: number | null }[];
    drift_total: number;
    changesets: {
      total: number;
      open: number;
      post_approval: number;
      by_classification: Record<string, number>;
      changeset_ids: string[];
    };
    items: { added: number; removed: number; other: number; total: number };
    rework: {
      changes_requested: number;
      fix_rounds: number;
      revalidations: number;
      total: number;
    };
    affected_executions: string[];
    cost_usd: number | null;
    baseline_age_days: number | null;
  }[];
  releases: {
    release_id: string;
    status: string;
    baseline_items: number;
    live_items: number;
    scope_added: string[];
    scope_removed: string[];
    scope_change_pct: number | null;
    manifest_versions: number;
    changeset_ids: string[];
  }[];
  totals: {
    changesets: number;
    open_changesets: number;
    post_approval_changes: number;
    rework_events: number;
    affected_executions: number;
    cost_usd: number;
    scope_added: number;
    scope_removed: number;
  };
}

const ticketPath = (ws: string, id: string) =>
  `/api/v1/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`;

const releasePath = (ws: string, rel: string) =>
  `/api/v1/releases/${encodeURIComponent(ws)}/${encodeURIComponent(rel)}`;

export const client = {
  inbox: (workspace?: string) =>
    api<InboxResponse>(`/api/v1/inbox${qs({ workspace })}`),
  board: (workspace?: string) =>
    api<BoardResponse>(`/api/v1/board${qs({ workspace })}`),
  tickets: (f?: { workspace?: string; status?: string; repo?: string }) =>
    api<{ tickets: TicketRow[] }>(
      `/api/v1/tickets${qs({
        workspace: f?.workspace,
        status: f?.status,
        repo: f?.repo,
      })}`,
    ),
  ticket: (ws: string, id: string) => api<TicketDetail>(ticketPath(ws, id)),
  // ---- Feature Workspace (wp-152) ----
  features: (f?: {
    workspace?: string;
    initiative?: string;
    status?: string;
  }) =>
    api<{ features: FeatureRow[] }>(
      `/api/v1/features${qs({
        workspace: f?.workspace,
        initiative: f?.initiative,
        status: f?.status,
      })}`,
    ),
  feature: (ws: string, id: string) =>
    api<FeatureDetail>(
      `/api/v1/features/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`,
    ),
  featureDoc: (ws: string, id: string, name: string) =>
    api<DocResponse>(
      `/api/v1/features/${encodeURIComponent(ws)}/${encodeURIComponent(
        id,
      )}/docs/${encodeURIComponent(name)}`,
    ),
  featureAcceptance: (ws: string, id: string) =>
    api<AcceptancePackage>(
      `/api/v1/features/${encodeURIComponent(ws)}/${encodeURIComponent(
        id,
      )}/acceptance`,
    ),
  featureAcs: (ws: string, id: string) =>
    api<{ acs: FeatureAcRow[] }>(
      `/api/v1/features/${encodeURIComponent(ws)}/${encodeURIComponent(id)}/acs`,
    ),
  /** The explicit human acceptance gate — the only path to 'done'. */
  featureAccept: (
    ws: string,
    id: string,
    body?: { exclusions?: string[]; expected_status?: string },
  ) =>
    post<{ accepted: boolean; feature: FeatureRow }>(
      `/api/v1/features/${encodeURIComponent(ws)}/${encodeURIComponent(
        id,
      )}/accept`,
      body ?? {},
    ),
  ticketDoc: (ws: string, id: string, name: string) =>
    api<DocResponse>(`${ticketPath(ws, id)}/docs/${encodeURIComponent(name)}`),
  ticketEvents: (ws: string, id: string) =>
    api<{ events: EventRow[] }>(`${ticketPath(ws, id)}/events`),
  answers: (ws: string, id: string, body: Record<string, unknown>) =>
    post<{ answered: string[]; commit: string; gate_cleared: string | null }>(
      `${ticketPath(ws, id)}/answers`,
      body,
    ),
  docFeedback: (ws: string, id: string, name: string, comment: string) =>
    post<{ accepted: boolean; run: string }>(
      `${ticketPath(ws, id)}/docs/${encodeURIComponent(name)}/feedback`,
      { comment },
    ),
  docApprove: (ws: string, id: string, name: string) =>
    post<{ approved: boolean; gate_cleared: string }>(
      `${ticketPath(ws, id)}/docs/${encodeURIComponent(name)}/approve`,
      {},
    ),
  verdict: (ws: string, id: string, fid: string, verdict: string) =>
    post(`${ticketPath(ws, id)}/findings/${encodeURIComponent(fid)}/verdict`, {
      verdict,
    }),
  action: (ws: string, id: string, body: Record<string, unknown>) =>
    post<Record<string, unknown>>(`${ticketPath(ws, id)}/actions`, body),
  runs: (f?: {
    workspace?: string;
    subject?: string;
    ticket_id?: string;
    status?: string;
  }) =>
    api<{ runs: RunRow[] }>(
      `/api/v1/runs${qs({
        workspace: f?.workspace,
        subject: f?.subject,
        ticket_id: f?.ticket_id,
        status: f?.status,
      })}`,
    ),
  run: (id: string) =>
    api<{ run: RunRow; artifacts: string[] }>(
      `/api/v1/runs/${encodeURIComponent(id)}`,
    ),
  runOp: (id: string, op: 'kill' | 'pause' | 'resume') =>
    post<{ op: string; run: string }>(
      `/api/v1/runs/${encodeURIComponent(id)}/${op}`,
    ),
  workspaces: () => api<{ workspaces: WorkspaceInfo[] }>('/api/v1/workspaces'),
  addWorkspace: (body: { name: string; url: string; path?: string }) =>
    post('/api/v1/workspaces', body),
  interview: (workspace: string, text: string) =>
    post<{ subject: string; run: string }>('/api/v1/interview', {
      workspace,
      text,
    }),
  importPreview: (body: {
    workspace: string;
    source: string;
    repo?: string;
    milestone?: string;
    labels?: string[];
  }) =>
    post<{ rows: ImportPreviewRow[] }>('/api/v1/import', {
      ...body,
      commit: false,
    }),
  importCommit: (workspace: string, source: string) =>
    post<{ run: string; subject: string }>('/api/v1/import', {
      workspace,
      source,
      commit: true,
    }),
  settings: () => api<SettingsResponse>('/api/v1/settings'),
  putSettings: (body: {
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
  }) =>
    api<{ ok: boolean; warnings: string[] }>('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  kbList: (scope: string) =>
    api<{ dossiers: DossierEntry[] }>(
      `/api/v1/kb/${encodeURIComponent(scope)}`,
    ),
  kbGet: (scope: string, name: string) =>
    api<{ sections: DossierEntry[] }>(
      `/api/v1/kb/${encodeURIComponent(scope)}${qs({ name })}`,
    ),
  kbPut: (body: {
    scope: string;
    name: string;
    section: string;
    content: string;
    workspace?: string;
  }) =>
    api<{ entry: DossierEntry }>(
      `/api/v1/kb/${encodeURIComponent(body.scope)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  kbSync: (scope: string, name: string, workspace?: string) =>
    post<{ run: string; subject: string }>(
      `/api/v1/kb/${encodeURIComponent(scope)}/sync`,
      { name, workspace },
    ),
  metrics: (workspace?: string) =>
    api<MetricsResponse>(`/api/v1/metrics${qs({ workspace })}`),
  claim: (ws: string, subject: string, gate: string) =>
    post<{ claim: Claim }>(
      `/api/v1/gate-items/${encodeURIComponent(ws)}/${encodeURIComponent(
        subject,
      )}/${encodeURIComponent(gate)}/claim`,
      {},
    ),
  release: (ws: string, subject: string, gate: string) =>
    api<{ released: boolean }>(
      `/api/v1/gate-items/${encodeURIComponent(ws)}/${encodeURIComponent(
        subject,
      )}/${encodeURIComponent(gate)}/claim`,
      { method: 'DELETE' },
    ),
  /** D20 — snooze an open gate item until `until` (or ttl_s, default
   *  24h server-side). Snoozed items leave badges and the board. */
  snooze: (
    ws: string,
    subject: string,
    gate: string,
    body?: { until?: string; ttl_s?: number },
  ) =>
    post<{ item: GateItem }>(
      `/api/v1/gate-items/${encodeURIComponent(ws)}/${encodeURIComponent(
        subject,
      )}/${encodeURIComponent(gate)}/snooze`,
      body ?? {},
    ),
  unsnooze: (ws: string, subject: string, gate: string) =>
    api<{ item: GateItem }>(
      `/api/v1/gate-items/${encodeURIComponent(ws)}/${encodeURIComponent(
        subject,
      )}/${encodeURIComponent(gate)}/snooze`,
      { method: 'DELETE' },
    ),
  /** Chat-to-edit (SCHEMAS §16): a multi-turn interview run that
   *  proposes a unified diff against one of the ticket's docs. */
  interviewEdit: (body: {
    workspace: string;
    /** `ticket_ref` for ticket subjects; `subject_ref` generalizes to
     *  feature subjects (F-NNNN — the "Ask About This Feature" scoped
     *  assistant, wp-152). */
    ticket_ref?: string;
    subject_ref?: string;
    message: string;
    target?: 'ticket' | 'rs' | 'tdd' | 'vs' | 'feature' | 'ac' | 'notes';
    session_id?: string;
  }) =>
    post<{ session: string; run: string; subject: string; target: string }>(
      '/api/v1/interview',
      body,
    ),
  interviewSession: (session: string, workspace?: string) =>
    api<InterviewSession>(
      `/api/v1/interview/${encodeURIComponent(session)}${qs({ workspace })}`,
    ),
  interviewApprove: (session: string, expected_status?: string) =>
    post<{ applied: boolean; session: string; doc: string; version: number }>(
      `/api/v1/interview/${encodeURIComponent(session)}/approve`,
      expected_status === undefined ? {} : { expected_status },
    ),
  interviewDiscard: (session: string) =>
    api<{ discarded: boolean; session: string }>(
      `/api/v1/interview/${encodeURIComponent(session)}`,
      { method: 'DELETE' },
    ),
  // wp-111 — traceability links (suggested ≠ verified; decide is OCC)
  links: (ws: string, subject: string) =>
    api<{ relations: Relation[] }>(
      `/api/v1/links${qs({ workspace: ws, subject })}`,
    ),
  decideLink: (body: LinkDecisionBody) =>
    post<{ relation: Relation }>('/api/v1/links/decide', body),
  // wp-111 — navigable citations + repo index head
  evidenceSource: (ws: string, ref: string) =>
    api<EvidenceSource>(`/api/v1/evidence/source${qs({ workspace: ws, ref })}`),
  repoIndex: (ws: string, repo: string) =>
    api<RepoIndexState>(
      `/api/v1/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(
        repo,
      )}/index`,
    ),
  // wp-112 — continuous alignment (findings are hypotheses; decide is
  // OCC + evented; the panel never hides evidence refs)
  alignment: (ws: string, scope: string) =>
    api<AlignmentView>(
      `/api/v1/alignment/${encodeURIComponent(scope)}${qs({ workspace: ws })}`,
    ),
  requestAlignment: (ws: string, scope: string) =>
    post<{ run: unknown; artifact: unknown }>(
      `/api/v1/alignment/${encodeURIComponent(scope)}`,
      { workspace: ws },
    ),
  decideAlignment: (body: AlignmentDecisionBody) =>
    post<{ finding: AlignmentFinding }>('/api/v1/alignment/decide', body),
  rsQuality: (ws: string, id: string) =>
    api<RsQualityResponse>(`${ticketPath(ws, id)}/rs-quality`),
  // wp-142 — Scope Creep Radar (PRD §15.5). Feeds the ChangeSet
  // decision view + Release Center header once wp-136/137 land.
  scopeRadar: (f: {
    workspace: string;
    subject?: string;
    release?: string;
  }) =>
    api<ScopeRadarReport>(
      `/api/v1/scope-radar${qs({
        workspace: f.workspace,
        subject: f.subject,
        release: f.release,
      })}`,
    ),
  /** Acknowledge a `scope-budget` escalation — the higher approval. */
  acknowledgeScopeBudget: (ws: string, changeset: string) =>
    post<{ acknowledged: boolean; changeset_id: string; cleared_at: string }>(
      `/api/v1/scope-radar/${encodeURIComponent(ws)}/${encodeURIComponent(
        changeset,
      )}/acknowledge`,
      {},
    ),
  /** D27 capture tray ingress — creates a `board: null` board_item. */
  capture: (body: {
    workspace: string;
    title: string;
    kind?: string;
    body?: string;
    serves?: string | string[];
  }) => post<{ item: BoardItem }>('/api/v1/capture', body),

  // ---- Discovery surface (wp-147) ----
  boardTaxonomy: () => api<BoardTaxonomy>('/api/v1/boards/meta/taxonomy'),
  ideaBoards: (ws: string) =>
    api<{ boards: IdeaBoardRow[] }>(`/api/v1/boards${qs({ workspace: ws })}`),
  createIdeaBoard: (body: {
    workspace: string;
    board: string;
    name?: string;
    org?: string;
    board_type?: string;
    status?: string;
  }) => post<{ board: IdeaBoardRow }>('/api/v1/boards', body),
  ideaBoard: (ws: string, board: string) =>
    api<IdeaBoardDetail>(
      `/api/v1/boards/${encodeURIComponent(board)}${qs({ workspace: ws })}`,
    ),
  addBoardItem: (
    board: string,
    body: {
      workspace: string;
      kind?: string;
      note_kind?: string;
      importance?: string;
      title?: string;
      body?: string;
      topic?: string;
      zone?: string;
      serves?: string[];
      x?: number;
      y?: number;
    },
  ) =>
    post<{ item: BoardItem }>(
      `/api/v1/boards/${encodeURIComponent(board)}/items`,
      body,
    ),
  boardItemStatements: (ws: string, id: string) =>
    api<{ item: BoardItem; statements: StatementRow[] }>(
      `/api/v1/board-items/${encodeURIComponent(id)}/statements${qs({
        workspace: ws,
      })}`,
    ),
  patchBoardItem: (
    id: string,
    body: {
      workspace: string;
      expected_updated_at: string;
      board?: string | null;
      kind?: string;
      note_kind?: string | null;
      importance?: string | null;
      topic?: string | null;
      note_status?: string;
      title?: string | null;
      body?: string | null;
      zone?: string | null;
      serves?: string[] | null;
      x?: number | null;
      y?: number | null;
      status?: string;
    },
  ) =>
    api<{ item: BoardItem }>(`/api/v1/board-items/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteBoardItem: (ws: string, id: string) =>
    api<{ deleted: boolean }>(
      `/api/v1/board-items/${encodeURIComponent(id)}${qs({ workspace: ws })}`,
      { method: 'DELETE' },
    ),
  tray: (ws: string, kind?: string) =>
    api<{ items: BoardItem[] }>(`/api/v1/tray${qs({ workspace: ws, kind })}`),

  // Interview Orchestrator sessions (§15.9 — distinct from the
  // chat-to-edit `/interview/<session>` surface).
  interviewWizards: (ws: string) =>
    api<{ wizards: InterviewWizard[] }>(
      `/api/v1/interview-wizards${qs({ workspace: ws })}`,
    ),
  interviewSessions: (ws: string, f?: { status?: string; subject?: string }) =>
    api<{ sessions: InterviewSessionRow[] }>(
      `/api/v1/interview-sessions${qs({
        workspace: ws,
        status: f?.status,
        subject: f?.subject,
      })}`,
    ),
  startInterviewSession: (body: {
    workspace: string;
    wizard_id: string;
    subject?: string;
    mode?: string;
    branch?: string;
    role?: string;
  }) =>
    post<{ session: InterviewSessionRow }>('/api/v1/interview-sessions', body),
  discoverySession: (ws: string, session: string) =>
    api<InterviewSessionDetail>(
      `/api/v1/interview-sessions/${encodeURIComponent(session)}${qs({
        workspace: ws,
      })}`,
    ),
  answerQuestion: (
    session: string,
    body: {
      workspace: string;
      answer: string;
      question_id?: string;
      slot?: string;
      slots?: string[];
    },
  ) =>
    post<{ result: AnswerResult }>(
      `/api/v1/interview-sessions/${encodeURIComponent(session)}/answer`,
      body,
    ),
  setInterviewMode: (session: string, workspace: string, mode: string) =>
    post<{ session: InterviewSessionRow }>(
      `/api/v1/interview-sessions/${encodeURIComponent(session)}/mode`,
      { workspace, mode },
    ),
  setInterviewStatus: (session: string, workspace: string, status: string) =>
    post<{ session: InterviewSessionRow }>(
      `/api/v1/interview-sessions/${encodeURIComponent(session)}/status`,
      { workspace, status },
    ),
  pauseInterview: (session: string, workspace: string) =>
    post<{ session: InterviewSessionRow }>(
      `/api/v1/interview-sessions/${encodeURIComponent(session)}/pause`,
      { workspace },
    ),
  resumeInterview: (session: string, workspace: string) =>
    post<{ session: InterviewSessionRow; briefing: ResumeBriefing }>(
      `/api/v1/interview-sessions/${encodeURIComponent(session)}/resume`,
      { workspace },
    ),
  resolveQuestion: (
    session: string,
    questionId: string,
    body: {
      workspace: string;
      status: 'answered' | 'skipped' | 'unanswerable';
      reason?: string;
    },
  ) =>
    post<{ question: QuestionCandidateRow }>(
      `/api/v1/interview-sessions/${encodeURIComponent(
        session,
      )}/questions/${encodeURIComponent(questionId)}/resolve`,
      body,
    ),
  updateSlot: (
    session: string,
    slot: string,
    body: {
      workspace: string;
      state: 'known' | 'not-applicable' | 'deferred';
      value?: string;
    },
  ) =>
    post<{ slot: KnowledgeSlotRow }>(
      `/api/v1/interview-sessions/${encodeURIComponent(
        session,
      )}/slots/${encodeURIComponent(slot)}`,
      body,
    ),
  understanding: (ws: string, session: string) =>
    api<Understanding>(
      `/api/v1/interview-sessions/${encodeURIComponent(
        session,
      )}/understanding${qs({ workspace: ws })}`,
    ),

  // Statement ledger — decide/correct are human affordances routed
  // through the lifecycle engine (§15.3).
  statements: (ws: string, f?: { status?: string; subject?: string }) =>
    api<{ statements: PanelStatement[] }>(
      `/api/v1/statements${qs({
        workspace: ws,
        status: f?.status,
        subject: f?.subject,
      })}`,
    ),
  statement: (ws: string, id: string) =>
    api<StatementDetail>(
      `/api/v1/statements/${encodeURIComponent(id)}${qs({ workspace: ws })}`,
    ),
  decideStatement: (
    id: string,
    body: {
      workspace: string;
      action: 'confirm' | 'dispute' | 'reject';
      reason?: string;
    },
  ) =>
    post<{ statement: StatementRow; decision_id?: string }>(
      `/api/v1/statements/${encodeURIComponent(id)}/decide`,
      body,
    ),
  correctStatement: (
    id: string,
    body: {
      workspace: string;
      text: string;
      session_id?: string;
      slots?: string[];
    },
  ) =>
    post<{ statement: StatementRow; superseded: StatementRow }>(
      `/api/v1/statements/${encodeURIComponent(id)}/correct`,
      body,
    ),
  decideStatementDecision: (
    id: string,
    body: {
      workspace: string;
      decision: string;
      rationale?: string;
      apply?: 'confirmed' | 'rejected' | 'superseded' | 'proposed';
    },
  ) =>
    post<{ decision: StatementDecisionRow }>(
      `/api/v1/statement-decisions/${encodeURIComponent(id)}/decide`,
      body,
    ),
  dismissStatementDecision: (
    id: string,
    body: { workspace: string; rationale?: string },
  ) =>
    post<{ dismissed: boolean }>(
      `/api/v1/statement-decisions/${encodeURIComponent(id)}/dismiss`,
      body,
    ),
  // ---- wp-136/137 — Merge Center + Release Center (DELIVERY §6) ----
  mergeCenter: (ws: string) =>
    api<{ tickets: MergeReadiness[] }>(
      `/api/v1/merge-center/${encodeURIComponent(ws)}`,
    ),
  releases: (ws: string, status?: string) =>
    api<{ releases: ReleaseRow[] }>(
      `/api/v1/releases/${encodeURIComponent(ws)}${qs({ status })}`,
    ),
  createRelease: (ws: string, body: { title: string; target?: string }) =>
    post<{ release: ReleaseRow }>(
      `/api/v1/releases/${encodeURIComponent(ws)}`,
      body,
    ),
  releaseDetail: (ws: string, rel: string) =>
    api<ReleaseDetail>(
      `/api/v1/releases/${encodeURIComponent(ws)}/${encodeURIComponent(rel)}`,
    ),
  addReleaseItem: (
    ws: string,
    rel: string,
    body: {
      item_kind: 'feature' | 'ticket';
      item_id: string;
      partial_ac?: string[];
      approved_by?: string;
      expected_status?: string;
    },
  ) => post<{ item: ReleaseItemRow }>(`${releasePath(ws, rel)}/items`, body),
  removeReleaseItem: (
    ws: string,
    rel: string,
    body: { item_kind: 'feature' | 'ticket'; item_id: string },
  ) =>
    api<{ removed: string }>(`${releasePath(ws, rel)}/items`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  freezeRelease: (ws: string, rel: string, expected_status?: string) =>
    post<{ manifest: ReleaseManifestRow }>(
      `${releasePath(ws, rel)}/freeze`,
      expected_status === undefined ? {} : { expected_status },
    ),
  approveRelease: (
    ws: string,
    rel: string,
    body: {
      decision: 'approved' | 'rejected';
      rationale?: string;
      approver?: string;
      expected_status?: string;
    },
  ) =>
    post<{ approval: ReleaseApprovalRow }>(
      `${releasePath(ws, rel)}/approve`,
      body,
    ),
  /** The ship write — approved → released; all five gates must pass. */
  shipRelease: (ws: string, rel: string, expected_status?: string) =>
    post<{ release: ReleaseRow }>(
      `${releasePath(ws, rel)}/release`,
      expected_status === undefined ? {} : { expected_status },
    ),
  /** Manual deployment evidence — every evidence field non-empty
   *  (invariant 4; webhook/probe are reserved, never inputs). */
  recordDeployment: (
    ws: string,
    rel: string,
    body: {
      env: string;
      sha: string;
      evidence: { type: 'manual'; by: string; note: string; url: string };
    },
  ) =>
    post<{ deployment: DeploymentRow }>(
      `${releasePath(ws, rel)}/deployments`,
      body,
    ),
  /** feature exposure — `available` requires a confirmed deployment_id. */
  setFeatureExposure: (
    ws: string,
    feature: string,
    body: {
      env: string;
      state: 'hidden' | 'limited' | 'available';
      audience?: string;
      evidence?: string;
      deployment_id?: string;
    },
  ) =>
    post<{ exposure: FeatureExposureRow }>(
      `/api/v1/features/${encodeURIComponent(ws)}/${encodeURIComponent(
        feature,
      )}/exposure`,
      body,
    ),
  /** File a post-merge correction ticket (DELIVERY §2). */
  fileCorrection: (
    ws: string,
    ticket: string,
    body: {
      title: string;
      severity?: string;
      priority?: string;
      repos?: string[];
      feature?: string;
      description?: string;
    },
  ) =>
    post<{ ticket: TicketRow }>(`${ticketPath(ws, ticket)}/corrections`, body),
  /** Queue the `release-notes` stage (requires a frozen manifest). */
  draftReleaseNotes: (ws: string, rel: string) =>
    post<{ run: string }>(`${releasePath(ws, rel)}/notes`, {}),
  /** Human draft edit — appends `notes-<audience>.md`, never mutates the
   *  pinned approved version. */
  saveReleaseNoteDraft: (
    ws: string,
    rel: string,
    audience: string,
    content: string,
  ) =>
    post<{ note: ReleaseNoteRow }>(
      `${releasePath(ws, rel)}/notes/${encodeURIComponent(audience)}/draft`,
      { content },
    ),
  approveReleaseNote: (
    ws: string,
    rel: string,
    audience: string,
    approver?: string,
  ) =>
    post<{ note: ReleaseNoteRow }>(
      `${releasePath(ws, rel)}/notes/${encodeURIComponent(audience)}/approve`,
      approver ? { approver } : {},
    ),
  publishReleaseNote: (ws: string, rel: string, audience: string) =>
    post<{ note: ReleaseNoteRow }>(
      `${releasePath(ws, rel)}/notes/${encodeURIComponent(audience)}/publish`,
      {},
    ),
  /** Release-subject doc read — `retro` | `notes-<audience>` only. */
  releaseDoc: (ws: string, rel: string, name: string) =>
    api<DocResponse>(
      `${releasePath(ws, rel)}/docs/${encodeURIComponent(name)}`,
    ),
  /** Queue the `retro` stage on a released|closed release. */
  retroRelease: (ws: string, rel: string) =>
    post<{ run: string }>(`${releasePath(ws, rel)}/retro`, {}),
};
