/**
 * REST client for the conductor surface (API.md).
 *
 * Auth: bearer token on EVERY request. Browser bootstrap is the
 * loopback `GET /?token=` flow — the server sets a `sr_session`
 * cookie; we also keep the token in sessionStorage so fetch calls and
 * the SSE stream authenticate through either channel (EventSource
 * cannot set headers; it sends the cookie same-origin).
 */
import type {
  BoardItem,
  Claim,
  DossierEntry,
  EventRow,
  GateItem,
  Relation,
  RelationVerification,
  RsQuality,
  RunRow,
  TicketRepoRow,
  TicketRow,
  Triage,
} from '@sprint-runner/core';

const TOKEN_KEY = 'sr_ui_token';

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
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
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
    // Sets sr_session cookie (HttpOnly, SameSite=Strict). Loopback only.
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

const ticketPath = (ws: string, id: string) =>
  `/api/v1/tickets/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`;

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
    ticket_ref: string;
    message: string;
    target?: 'ticket' | 'rs' | 'tdd' | 'vs';
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
  rsQuality: (ws: string, id: string) =>
    api<RsQualityResponse>(`${ticketPath(ws, id)}/rs-quality`),
  /** D27 capture tray ingress — creates a `board: null` board_item. */
  capture: (body: {
    workspace: string;
    title: string;
    kind?: string;
    body?: string;
    serves?: string | string[];
  }) => post<{ item: BoardItem }>('/api/v1/capture', body),
};
