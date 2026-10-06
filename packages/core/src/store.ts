/**
 * Store interface — the storage contract for DB-SCHEMA.md.
 * One backend: **Postgres** (`postgres://…` via `storage_url`, D29).
 * Tests run the same impl against embedded Postgres (PGlite).
 *
 * The DB IS the system of record — tickets/docs/events/boards are
 * truth rows, not projections. Git is code source control only.
 *
 * Signatures only — implementations live in packages/store (wp-091).
 */
import type { ContainerState } from './enums.js';
import type {
  AlignmentFindingDecisionRow,
  AlignmentFindingRow,
  AlignmentRunRow,
  AssumptionRow,
  BoardItem,
  BoardRow,
  ChangesetItemRow,
  ChangesetRow,
  Claim,
  CodeEdgeRow,
  CodeUnitRow,
  ContainerRow,
  DeliveryCommitmentRow,
  DeploymentRow,
  DesignApprovalRow,
  DocVersion,
  DossierEntry,
  Embedding,
  Entity,
  ErrorSignatureRow,
  EvalCaseRow,
  EvalResultRow,
  EvalRunRow,
  EventRow,
  ExternalReviewMappingRow,
  ExtractionRunRow,
  FeatureExposureRow,
  FeatureRow,
  FindingResolutionRow,
  GateItem,
  IncidentDecisionRow,
  IncidentRow,
  IncidentTicketProposalRow,
  InitiativeRow,
  InterviewBranchRow,
  InterviewMessageRow,
  InterviewSessionRow,
  KnowledgeSlotRow,
  Lease,
  Notification,
  Presence,
  ProjectRow,
  QualityDebtRow,
  QuestionCandidateRow,
  Relation,
  ReleaseApprovalRow,
  ReleaseGateResultRow,
  ReleaseItemRow,
  ReleaseManifestRow,
  ReleaseNoteRow,
  ReleaseOutcomeRow,
  ReleaseRow,
  RepoIndexRow,
  RetrievalEvaluationRow,
  ReviewCommentRow,
  ReviewDecisionRow,
  ReviewEvidenceLinkRow,
  ReviewFindingRow,
  ReviewRevisionRow,
  ReviewSessionRow,
  RunArtifact,
  RunRow,
  SessionSnapshotRow,
  StatementArtifactLinkRow,
  StatementClarificationRow,
  StatementDecisionRow,
  StatementRelationRow,
  StatementRow,
  StatementVersionRow,
  TelemetrySourceRow,
  TestEnvRequestRow,
  TicketRepoRow,
  TicketRow,
  UsageCallRow,
  WizardDefinitionRow,
  WizardVersionRow,
} from './schemas.js';

/** Lease identity (DB-SCHEMA leases PK). */
export interface LeaseKey {
  workspace: string;
  subject: string;
  stage: string;
  attempt: number;
}

/** Claim identity (DB-SCHEMA claims PK). */
export interface ClaimKey {
  workspace: string;
  subject: string;
  gate: string;
}

/** Gate item identity (DB-SCHEMA gate_items PK). */
export interface GateItemKey {
  workspace: string;
  subject: string;
  gate: string;
}

export interface TicketKey {
  workspace: string;
  ticket_id: string;
}

/** Container identity (DB-SCHEMA containers PK, D30). */
export interface ContainerKey {
  workspace: string;
  subject: string;
}

export interface TicketRepoKey extends TicketKey {
  repo: string;
}

/** Embedding lookup (DB-SCHEMA embeddings PK + §12 recall uses). */
export interface EmbeddingKey {
  object_ref: string;
  model: string;
}

/** Doc identity (DB-SCHEMA doc_versions PK prefix). */
export interface DocKey {
  workspace: string;
  subject: string;
  doc: DocVersion['doc'];
}

export interface NearestQuery {
  model: string;
  vector: Uint8Array | number[];
  limit: number;
}

export interface NearestResult {
  object_ref: string;
  distance: number;
}

/** A resolved commit head used to scope code retrieval — only a
 *  `current` (or, under `allow-stale`, `superseded`) head is ever one
 *  of these (INTELLIGENCE §4.1). */
export interface CodeHead {
  repo: string;
  commit_sha: string;
}

/** Full-text hit — the unit plus its `ts_rank` score. */
export interface CodeUnitFtsHit {
  unit: CodeUnitRow;
  rank: number;
}

/**
 * The Store contract (DB-SCHEMA.md). All reads/writes carry the
 * install/user id (SETTINGS `actor:`) — shared-queue attribution.
 */
export interface Store {
  /**
   * Run a multi-statement write path atomically (ARCHITECTURE §4.4 —
   * a command commits row changes + doc versions + audit event in one
   * transaction). `fn` receives a Store bound to the transaction; the
   * whole block rolls back on throw.
   */
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T>;

  // ---- meta ----

  /** schema_meta (DB-SCHEMA): current applied schema version; 0 if none. */
  getSchemaVersion(): Promise<number>;
  setSchemaVersion(version: number): Promise<void>;

  // ---- leases (coordination; fencing for stage runs) ----

  /**
   * Acquire a lease fencing a (workspace, subject, stage, attempt)
   * (DB-SCHEMA leases; CONDUCTOR CLAIM step). Returns the lease on
   * success, null if contested — caller skips this tick.
   * `ttl_s` default 300 (DB-SCHEMA rules); the expiry field IS the TTL.
   */
  acquireLease(
    key: LeaseKey,
    holder: string,
    ttl_s: number,
  ): Promise<Lease | null>;
  /** Conductor-observed heartbeat — refreshes `heartbeat_at`; the
   *  detached process never touches the DB (DB-SCHEMA rules). Fenced:
   *  only updates while `holder` still owns the lease — returns false
   *  when the lease is gone or held by someone else (a stale conductor
   *  must not refresh another owner's row). */
  heartbeatLease(key: LeaseKey, holder: string, at: string): Promise<boolean>;
  /** Release on collect/commit (CONDUCTOR RECONCILE step 1). */
  releaseLease(key: LeaseKey, holder: string): Promise<void>;
  getLease(key: LeaseKey): Promise<Lease | null>;
  /** Sweep leases past their TTL — a crashed install can't hold a lock
   *  forever (CONDUCTOR git-ref CAS lock expiry). */
  sweepExpiredLeases(now: string): Promise<LeaseKey[]>;

  // ---- claims (human-gate items) ----

  /** Claim a gate item for a human (DB-SCHEMA claims; CONDUCTOR
   *  `claimed`/`unclaimed` events). Returns the claim or null if held. */
  acquireClaim(
    key: ClaimKey,
    actor: string,
    ttl_s: number,
  ): Promise<Claim | null>;
  releaseClaim(key: ClaimKey, actor: string): Promise<void>;
  getClaim(key: ClaimKey): Promise<Claim | null>;

  // ---- runs registry ----

  /**
   * Register a detached run row (DB-SCHEMA runs; CONDUCTOR LAUNCH).
   * `id` e.g. `team-a/ABC-123/003-implement`; `subject` = ticket id or
   * `survey:`/`probe:`/`import:`/`interview:` for non-ticket runs.
   */
  createRun(run: RunRow): Promise<void>;
  updateRun(id: string, patch: Partial<RunRow>): Promise<void>;
  /** Conductor-observed liveness: pid + artifact/log mtime each tick
   *  (DB-SCHEMA rules — detached process never writes the DB). */
  heartbeatRun(id: string, at: string): Promise<void>;
  /** Live token counters, updated mid-run from `usage_partial` streams
   *  (DB-SCHEMA "Live usage"; ADAPTERS usage contract). */
  updateRunUsage(
    id: string,
    delta: { tokens_in?: number; tokens_out?: number; tokens_cached?: number },
  ): Promise<void>;
  getRun(id: string): Promise<RunRow | null>;
  /** Live runs for the reconcile pass (status in
   *  pending|leased|running|paused|exited). */
  listLiveRuns(): Promise<RunRow[]>;
  listRuns(filter?: {
    workspace?: string;
    subject?: string;
    ticket_id?: string;
    status?: string;
  }): Promise<RunRow[]>;

  // ---- containers (D30 — per-subject docker lifecycle bookkeeping) ----

  /**
   * Upsert the subject's `containers` row (DB-SCHEMA containers). The
   * row is bookkeeping for the conductor-owned docker container —
   * worktrees, not containers, are durable (CONDUCTOR "Container
   * lifecycle"). `state` transitions: created → running → stopped →
   * removed (row retained for audit).
   */
  upsertContainer(row: ContainerRow): Promise<void>;
  getContainer(key: ContainerKey): Promise<ContainerRow | null>;
  /** All container rows (default) or scoped — the orphan sweep scans
   *  every row to reconcile against `docker ps` (CONDUCTOR D30). */
  listContainers(filter?: {
    workspace?: string;
    state?: ContainerState;
  }): Promise<ContainerRow[]>;

  // ---- tickets (TRUTH rows — D29; no projection, no frontmatter) ----

  /** Upsert the `tickets` truth row (DB-SCHEMA tickets). */
  upsertTicket(row: TicketRow): Promise<void>;
  getTicket(key: TicketKey): Promise<TicketRow | null>;
  listTickets(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<TicketRow[]>;
  deleteTicket(key: TicketKey): Promise<void>;

  /** One row per repo a ticket touches (DB-SCHEMA ticket_repos);
   *  headline status is a rollup — merged iff EVERY row is merged. */
  upsertTicketRepo(row: TicketRepoRow): Promise<void>;
  getTicketRepo(key: TicketRepoKey): Promise<TicketRepoRow | null>;
  listTicketRepos(key: TicketKey): Promise<TicketRepoRow[]>;
  deleteTicketRepos(key: TicketKey): Promise<void>;

  // ---- events (append-only TRUTH — DB-SCHEMA events; SCHEMAS §7) ----

  /**
   * Append an events row (DB-SCHEMA events). `seq` is assigned by the
   * store (identity). Events are insert-only — never updated/deleted.
   */
  appendEvent(row: EventRow): Promise<number>;
  listEvents(filter: {
    workspace: string;
    ticket_id?: string;
    subject?: string;
    event?: string;
  }): Promise<EventRow[]>;

  /** Per-call ledger projection from usage.json (DB-SCHEMA usage_calls;
   *  SCHEMAS §13). */
  insertUsageCalls(rows: UsageCallRow[]): Promise<void>;
  listUsageCalls(run_id: string): Promise<UsageCallRow[]>;

  // ---- gate_items (materialized inbox) ----

  /** Surface a gate item (CONDUCTOR gates wait for a human forever);
   *  triggers a notifications row (DB-SCHEMA notifications rule). */
  upsertGateItem(item: GateItem): Promise<void>;
  clearGateItem(key: GateItemKey, cleared_at: string): Promise<void>;
  getGateItem(key: GateItemKey): Promise<GateItem | null>;
  /** The unified inbox query (S-01) — open items across workspaces.
   *  `cleared_at - surfaced_at` dwell feeds `human_minutes`. */
  listGateItems(filter?: {
    workspace?: string;
    open?: boolean;
  }): Promise<GateItem[]>;

  // ---- notifications ----

  /** Generated on gate_items insert and run_failed/run_killed/blocked
   *  events (DB-SCHEMA notifications rule). `id` assigned by store. */
  insertNotification(n: Omit<Notification, 'id'>): Promise<number>;
  markNotificationRead(id: number, at: string): Promise<void>;
  listNotifications(filter?: {
    workspace?: string;
    unreadOnly?: boolean;
  }): Promise<Notification[]>;
  /** Retention: prune >30d (DB-SCHEMA rules). */
  pruneNotifications(before: string): Promise<number>;

  // ---- presence ----

  upsertPresence(p: Presence): Promise<void>;
  listPresence(): Promise<Presence[]>;
  /** Retention: prune >30d (DB-SCHEMA rules). */
  prunePresence(before: string): Promise<number>;

  // ---- dossiers (knowledge base; SCHEMAS §11, DB-SCHEMA dossiers) ----

  /**
   * Write a dossier section. Refresh writes `version+1` and flags
   * `stale` on unchanged-but-older sections; human `edited_by` survives
   * re-survey — conflict → human version wins (DB-SCHEMA rules).
   */
  upsertDossierSection(entry: DossierEntry): Promise<void>;
  getDossierSection(
    scope: string,
    name: string,
    section: string,
    version?: number,
  ): Promise<DossierEntry | null>;
  /** Latest version of every section for a scope — used to inject
   *  SCOPED sections into stage prompts (SCHEMAS §11 consumption rule). */
  getDossier(scope: string, name: string): Promise<DossierEntry[]>;
  listDossiers(filter?: { scope?: string }): Promise<DossierEntry[]>;
  listDossierVersions(
    scope: string,
    name: string,
    section: string,
  ): Promise<DossierEntry[]>;

  // ---- semantic layer: entities, relations, embeddings (§12) ----

  upsertEntity(e: Entity): Promise<void>;
  getEntity(id: string): Promise<Entity | null>;
  listEntities(filter?: {
    product?: string;
    kind?: string;
  }): Promise<Entity[]>;
  deleteEntity(id: string): Promise<void>;

  /** Typed edges (DB-SCHEMA relations; ontology-lite, not RDF). */
  upsertRelation(r: Relation): Promise<void>;
  listRelations(filter?: {
    subject?: string;
    /** Ticket-scoped edge sets (wp-111): `subject = prefix OR subject
     *  LIKE prefix || ':%'` so `SR-1` also matches `SR-1:ac:AC-2`. */
    subject_prefix?: string;
    predicate?: string;
    object?: string;
  }): Promise<Relation[]>;
  /**
   * Atomic optimistic-concurrency update of an edge's `verification`
   * (wp-111 human verify/reject — D37): the WHERE clause carries the
   * `expected` state so a contested write loses IN the statement (no
   * check-then-write race). Result:
   *  - `updated`  — the transition landed (`prior` = the pre-write state)
   *  - `noop`     — edge already at `next` (idempotent repeat; NO event)
   *  - `conflict` — edge exists but isn't at `expected` (stale write →
   *                 the caller surfaces HTTP 409; `current` included)
   *  - `missing`  — no such edge (caller surfaces 404)
   */
  decideRelation(
    key: { subject: string; predicate: string; object: string },
    expected: Relation['verification'],
    next: NonNullable<Relation['verification']>,
  ): Promise<
    | { state: 'updated'; prior: Relation['verification'] }
    | { state: 'noop' }
    | { state: 'conflict'; current: Relation['verification'] }
    | { state: 'missing' }
  >;
  deleteRelation(r: Relation): Promise<void>;

  /** sqlite-vec / pgvector (DB-SCHEMA embeddings; §12 uses: prior-art
   *  recall, near-dup detection, dossier retrieval, conflict prediction). */
  upsertEmbedding(e: Embedding): Promise<void>;
  getEmbedding(key: EmbeddingKey): Promise<Embedding | null>;
  deleteEmbedding(key: EmbeddingKey): Promise<void>;
  nearestEmbeddings(q: NearestQuery): Promise<NearestResult[]>;

  // ---- projects (DB-SCHEMA projects; workspace is the key) ----

  /** Only `workspace` is required — the `next_*_seq` counters and
   *  `settings` carry zod defaults, so callers may omit them (a new
   *  counter never breaks existing call sites). */
  upsertProject(
    row: Pick<ProjectRow, 'workspace'> & Partial<ProjectRow>,
  ): Promise<void>;
  getProject(workspace: string): Promise<ProjectRow | null>;
  listProjects(): Promise<ProjectRow[]>;
  /**
   * Transactional id allocation (DB-SCHEMA rules): increments the
   * project's `next_*_seq` counter and returns the formatted id —
   * `SR-NNNN` / `F-NNNN` / `I-NNNN`. Replaces next-id ref-CAS.
   */
  allocTicketId(workspace: string): Promise<string>;
  allocFeatureId(workspace: string): Promise<string>;
  allocInitiativeId(workspace: string): Promise<string>;

  // ---- boards / canvas (D26/D27) ----

  upsertBoard(row: BoardRow): Promise<void>;
  getBoard(workspace: string, board: string): Promise<BoardRow | null>;
  listBoards(workspace: string): Promise<BoardRow[]>;
  deleteBoard(workspace: string, board: string): Promise<void>;

  /** board NULL rows = the capture tray (D27). */
  upsertBoardItem(item: BoardItem): Promise<void>;
  getBoardItem(id: string): Promise<BoardItem | null>;
  listBoardItems(filter: {
    workspace: string;
    /** Pass a board slug for a canvas, null for the tray, undefined
     *  for everything in the workspace. */
    board?: string | null;
    kind?: string;
    status?: string;
  }): Promise<BoardItem[]>;
  deleteBoardItem(id: string): Promise<void>;

  // ---- hierarchy: initiatives / features (D26) ----

  upsertInitiative(row: InitiativeRow): Promise<void>;
  getInitiative(
    workspace: string,
    initiative: string,
  ): Promise<InitiativeRow | null>;
  listInitiatives(filter?: {
    workspace?: string;
    board?: string;
    status?: string;
  }): Promise<InitiativeRow[]>;

  upsertFeature(row: FeatureRow): Promise<void>;
  getFeature(workspace: string, feature: string): Promise<FeatureRow | null>;
  listFeatures(filter?: {
    workspace?: string;
    initiative?: string;
    status?: string;
  }): Promise<FeatureRow[]>;

  // ---- doc_versions (append-only doc truth — D24/D29) ----

  /**
   * Append a new immutable version of a doc (DB-SCHEMA doc_versions).
   * `version` is assigned by the store (max+1) and returned. Every
   * persisted doc change is a version — never an in-place update.
   */
  appendDocVersion(
    key: DocKey,
    content: string,
    edited_by: string,
  ): Promise<DocVersion>;
  /** Latest version of one doc (max(version)). */
  getDoc(key: DocKey): Promise<DocVersion | null>;
  getDocVersion(key: DocKey, version: number): Promise<DocVersion | null>;
  /** Version history for a doc, ascending. */
  listDocVersions(key: DocKey): Promise<DocVersion[]>;
  /** Latest version of every doc on a subject (S-05 docs tab). */
  listDocs(key: {
    workspace: string;
    subject: string;
  }): Promise<DocVersion[]>;

  // ---- run_artifacts (structured stage output — DB-SCHEMA) ----

  putArtifact(a: RunArtifact): Promise<void>;
  getArtifact(run_id: string, name: string): Promise<RunArtifact | null>;
  listArtifacts(run_id: string): Promise<RunArtifact[]>;

  // =====================================================================
  // Addendum entities (wp-131 freeze — PRD §15 / DELIVERY §3 families).
  // Every query is workspace-qualified; append-only tables expose
  // `append…`/`list…` only — no mutating methods.
  // =====================================================================

  // ---- releases / delivery (DELIVERY §3) ----

  /** REL-NNNN allocator — same transactional seq-bump as tickets. */
  allocReleaseId(workspace: string): Promise<string>;

  upsertRelease(row: ReleaseRow): Promise<void>;
  getRelease(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseRow | null>;
  listReleases(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<ReleaseRow[]>;

  /** Release scope membership. Soft-remove via `removed_at` — a removed
   *  item stays in the row set for audit. */
  upsertReleaseItem(row: ReleaseItemRow): Promise<void>;
  listReleaseItems(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseItemRow[]>;
  removeReleaseItem(
    key: {
      workspace: string;
      release_id: string;
      item_kind: string;
      item_id: string;
    },
    removed_at: string,
  ): Promise<void>;

  /** Immutable manifest cut (DELIVERY invariant 3) — insert-only; a
   *  scope change appends a new `version`. */
  appendReleaseManifest(row: ReleaseManifestRow): Promise<void>;
  getReleaseManifest(
    key: { workspace: string; release_id: string },
    version?: number,
  ): Promise<ReleaseManifestRow | null>;
  listReleaseManifests(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseManifestRow[]>;

  /** Append-only approval bound to a manifest digest. */
  appendReleaseApproval(row: ReleaseApprovalRow): Promise<void>;
  listReleaseApprovals(key: {
    workspace: string;
    release_id: string;
    manifest_version?: number;
  }): Promise<ReleaseApprovalRow[]>;

  /** Publication metadata — note content lives in doc_versions
   *  (`notes-<audience>.md`, DELIVERY §3). */
  upsertReleaseNote(row: ReleaseNoteRow): Promise<void>;
  getReleaseNote(key: {
    workspace: string;
    release_id: string;
    audience: string;
  }): Promise<ReleaseNoteRow | null>;
  listReleaseNotes(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseNoteRow[]>;

  /** Append-only gate-check audit; `id` is store-assigned. */
  appendReleaseGateResult(
    row: Omit<ReleaseGateResultRow, 'id'>,
  ): Promise<number>;
  listReleaseGateResults(key: {
    workspace: string;
    release_id: string;
    gate?: string;
  }): Promise<ReleaseGateResultRow[]>;

  /** Insert a deployment (MVP evidence is manual; DELIVERY §3
   *  invariant 4 requires non-empty `evidence`). */
  insertDeployment(row: DeploymentRow): Promise<void>;
  /** Record the manual confirmation on an existing deployment row. */
  confirmDeployment(
    key: { workspace: string; deployment_id: string },
    confirmed_by: string,
    at: string,
  ): Promise<void>;
  listDeployments(filter: {
    workspace: string;
    release_id?: string;
    environment?: string;
  }): Promise<DeploymentRow[]>;

  /** Feature availability per environment — `available` requires a
   *  linked `deployment_id` (DELIVERY invariant 4). */
  upsertFeatureExposure(row: FeatureExposureRow): Promise<void>;
  getFeatureExposure(key: {
    workspace: string;
    feature_id: string;
    environment: string;
  }): Promise<FeatureExposureRow | null>;
  listFeatureExposure(filter: {
    workspace: string;
    feature_id?: string;
    environment?: string;
  }): Promise<FeatureExposureRow[]>;

  /** KPI outcomes per release (DELIVERY §3). */
  upsertReleaseOutcome(row: ReleaseOutcomeRow): Promise<void>;
  listReleaseOutcomes(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseOutcomeRow[]>;

  // ---- changesets (PRD §15.5, wp-140) ----

  /** CS-NNNN allocator — same transactional seq-bump as tickets. */
  allocChangesetId(workspace: string): Promise<string>;

  upsertChangeset(row: ChangesetRow): Promise<void>;
  getChangeset(key: {
    workspace: string;
    changeset_id: string;
  }): Promise<ChangesetRow | null>;
  listChangesets(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<ChangesetRow[]>;

  /** Ordered apply list — `seq` is the caller-assigned ordinal;
   *  partial application stays visible via per-item status. */
  upsertChangesetItem(row: ChangesetItemRow): Promise<void>;
  listChangesetItems(key: {
    workspace: string;
    changeset_id: string;
  }): Promise<ChangesetItemRow[]>;

  // ---- statement ledger (PRD §15.3/§15.9, wp-143) ----

  /**
   * Write a statement — appends `statement_versions` at max(version)+1
   * and updates the `semantic_statements` head in one transaction
   * (doc_versions discipline). Returns the head row with the allocated
   * `version`.
   */
  upsertStatement(row: Omit<StatementRow, 'version'>): Promise<StatementRow>;
  getStatement(key: {
    workspace: string;
    statement_id: string;
  }): Promise<StatementRow | null>;
  listStatements(filter?: {
    workspace?: string;
    status?: string;
    scope?: string;
    scope_ref?: string;
    intent?: string;
  }): Promise<StatementRow[]>;
  /** Append-only version history, ascending. */
  listStatementVersions(key: {
    workspace: string;
    statement_id: string;
  }): Promise<StatementVersionRow[]>;

  /** Typed statement edges — the authority rule resolves on these
   *  (§15.3), not vector similarity. */
  upsertStatementRelation(row: StatementRelationRow): Promise<void>;
  listStatementRelations(filter: {
    workspace: string;
    src?: string;
    dst?: string;
    predicate?: string;
  }): Promise<StatementRelationRow[]>;
  deleteStatementRelation(key: {
    workspace: string;
    src: string;
    predicate: string;
    dst: string;
  }): Promise<void>;

  /** Clarification Q&A bound to a statement — `answer` lands via
   *  re-upsert with `answered_at` set. */
  upsertStatementClarification(row: StatementClarificationRow): Promise<void>;
  listStatementClarifications(filter: {
    workspace: string;
    statement_id?: string;
  }): Promise<StatementClarificationRow[]>;

  /** Disagreement decision items — never a silent merge (§15.9). */
  upsertStatementDecision(row: StatementDecisionRow): Promise<void>;
  getStatementDecision(key: {
    workspace: string;
    decision_id: string;
  }): Promise<StatementDecisionRow | null>;
  listStatementDecisions(filter: {
    workspace: string;
    statement_id?: string;
    status?: string;
  }): Promise<StatementDecisionRow[]>;

  /** Statement → generated-artifact back-links (wp-146 lint). */
  upsertStatementArtifactLink(row: StatementArtifactLinkRow): Promise<void>;
  listStatementArtifactLinks(filter: {
    workspace: string;
    statement_id?: string;
    artifact?: string;
  }): Promise<StatementArtifactLinkRow[]>;
  deleteStatementArtifactLink(key: {
    workspace: string;
    statement_id: string;
    artifact: string;
    element: string;
  }): Promise<void>;

  /** Extraction provenance (model + prompt version per batch). */
  insertExtractionRun(row: ExtractionRunRow): Promise<void>;
  getExtractionRun(key: {
    workspace: string;
    extraction_run_id: string;
  }): Promise<ExtractionRunRow | null>;
  listExtractionRuns(filter?: {
    workspace?: string;
    subject?: string;
  }): Promise<ExtractionRunRow[]>;

  // ---- interview orchestrator (PRD §15.9, wp-145) ----

  upsertWizardDefinition(row: WizardDefinitionRow): Promise<void>;
  getWizardDefinition(key: {
    workspace: string;
    wizard_id: string;
  }): Promise<WizardDefinitionRow | null>;
  /** Immutable wizard config versions — insert-only. */
  appendWizardVersion(row: WizardVersionRow): Promise<void>;
  getWizardVersion(
    key: { workspace: string; wizard_id: string },
    version?: number,
  ): Promise<WizardVersionRow | null>;
  listWizardVersions(key: {
    workspace: string;
    wizard_id: string;
  }): Promise<WizardVersionRow[]>;

  upsertInterviewSession(row: InterviewSessionRow): Promise<void>;
  getInterviewSession(key: {
    workspace: string;
    session_id: string;
  }): Promise<InterviewSessionRow | null>;
  listInterviewSessions(filter?: {
    workspace?: string;
    subject?: string;
    status?: string;
  }): Promise<InterviewSessionRow[]>;

  /** Multi-stakeholder specialist branches (§15.9). */
  upsertInterviewBranch(row: InterviewBranchRow): Promise<void>;
  listInterviewBranches(key: {
    workspace: string;
    session_id: string;
  }): Promise<InterviewBranchRow[]>;

  /**
   * Durable transcript (§15.9) — append-only; `seq` is store-assigned
   * (max+1 per session) and returned.
   */
  appendInterviewMessage(
    row: Omit<InterviewMessageRow, 'seq'>,
  ): Promise<number>;
  listInterviewMessages(key: {
    workspace: string;
    session_id: string;
    /** Only rows with seq > after (resume/incremental reads). */
    after?: number;
  }): Promise<InterviewMessageRow[]>;

  upsertKnowledgeSlot(row: KnowledgeSlotRow): Promise<void>;
  getKnowledgeSlot(key: {
    workspace: string;
    session_id: string;
    slot: string;
  }): Promise<KnowledgeSlotRow | null>;
  listKnowledgeSlots(key: {
    workspace: string;
    session_id: string;
    state?: string;
  }): Promise<KnowledgeSlotRow[]>;

  /** Planner output — scored next-question candidates. */
  upsertQuestionCandidate(row: QuestionCandidateRow): Promise<void>;
  listQuestionCandidates(filter: {
    workspace: string;
    session_id: string;
    status?: string;
  }): Promise<QuestionCandidateRow[]>;

  /** Append-only resume snapshots (§15.9). */
  appendSessionSnapshot(row: SessionSnapshotRow): Promise<void>;
  /** Latest snapshot for a session when `version` is omitted. */
  getSessionSnapshot(
    key: { workspace: string; session_id: string },
    version?: number,
  ): Promise<SessionSnapshotRow | null>;
  listSessionSnapshots(key: {
    workspace: string;
    session_id: string;
  }): Promise<SessionSnapshotRow[]>;

  // ---- review studio (PRD §15.8, wp-148/149/150) ----

  upsertReviewSession(row: ReviewSessionRow): Promise<void>;
  getReviewSession(key: {
    workspace: string;
    review_id: string;
  }): Promise<ReviewSessionRow | null>;
  listReviewSessions(filter?: {
    workspace?: string;
    subject?: string;
    status?: string;
  }): Promise<ReviewSessionRow[]>;

  /** Append-only reviewable heads — approvals bind to `head_sha` +
   *  the pinned spec baseline (stale-approval, §15.8). */
  appendReviewRevision(row: ReviewRevisionRow): Promise<void>;
  /** Latest revision when `revision` is omitted. */
  getReviewRevision(
    key: { workspace: string; review_id: string },
    revision?: number,
  ): Promise<ReviewRevisionRow | null>;
  listReviewRevisions(key: {
    workspace: string;
    review_id: string;
  }): Promise<ReviewRevisionRow[]>;

  upsertReviewFinding(row: ReviewFindingRow): Promise<void>;
  getReviewFinding(key: {
    workspace: string;
    finding_id: string;
  }): Promise<ReviewFindingRow | null>;
  listReviewFindings(filter: {
    workspace: string;
    review_id?: string;
    status?: string;
    severity?: string;
  }): Promise<ReviewFindingRow[]>;

  /** Semantic comments — `out-of-scope` routes to a ChangeSet
   *  (`changeset_id`); a comment is an instruction, not authorization. */
  upsertReviewComment(row: ReviewCommentRow): Promise<void>;
  listReviewComments(filter: {
    workspace: string;
    review_id?: string;
    subject?: string;
  }): Promise<ReviewCommentRow[]>;

  /** Append-only reviewer verdicts bound to head SHA + spec baseline —
   *  never posed as GitHub approvals (§15.8). */
  appendReviewDecision(row: ReviewDecisionRow): Promise<void>;
  listReviewDecisions(key: {
    workspace: string;
    review_id: string;
  }): Promise<ReviewDecisionRow[]>;

  /** Append-only finding lifecycle audit — terminal dispositions
   *  require `rationale` + a permissioned `actor`. */
  appendFindingResolution(row: FindingResolutionRow): Promise<void>;
  listFindingResolutions(key: {
    workspace: string;
    finding_id: string;
  }): Promise<FindingResolutionRow[]>;

  /** Requirement-first review evidence edges — insert is idempotent
   *  (duplicate links collapse on the PK). */
  insertReviewEvidenceLink(row: ReviewEvidenceLinkRow): Promise<void>;
  listReviewEvidenceLinks(filter: {
    workspace: string;
    review_id?: string;
    finding_id?: string;
  }): Promise<ReviewEvidenceLinkRow[]>;
  deleteReviewEvidenceLink(key: {
    workspace: string;
    review_id: string;
    finding_id: string;
    evidence_ref: string;
  }): Promise<void>;

  /** Explicit finding↔external-thread mapping — idempotent on the
   *  (external_kind, external_id) PK; GitHub stays authoritative. */
  upsertExternalReviewMapping(row: ExternalReviewMappingRow): Promise<void>;
  listExternalReviewMappings(filter: {
    workspace: string;
    review_id?: string;
    finding_id?: string;
  }): Promise<ExternalReviewMappingRow[]>;

  /** Visual-AC / design approvals bound to a mockup revision (§15.4). */
  upsertDesignApproval(row: DesignApprovalRow): Promise<void>;
  getDesignApproval(key: {
    workspace: string;
    approval_id: string;
  }): Promise<DesignApprovalRow | null>;
  listDesignApprovals(filter: {
    workspace: string;
    subject?: string;
    status?: string;
  }): Promise<DesignApprovalRow[]>;

  // ---- process machinery (PRD §15.10, wp-153) ----

  /** Assumption Register — auto-captured when a stage depends on
   *  unverified info; high-impact unverified rows gate or get human
   *  risk-acceptance. */
  upsertAssumption(row: AssumptionRow): Promise<void>;
  getAssumption(key: {
    workspace: string;
    assumption_id: string;
  }): Promise<AssumptionRow | null>;
  listAssumptions(filter?: {
    workspace?: string;
    subject?: string;
    status?: string;
  }): Promise<AssumptionRow[]>;

  /** Quality Debt Register — owned, expiring, consolidatable (§15.10). */
  upsertQualityDebt(row: QualityDebtRow): Promise<void>;
  getQualityDebt(key: {
    workspace: string;
    debt_id: string;
  }): Promise<QualityDebtRow | null>;
  listQualityDebt(filter?: {
    workspace?: string;
    status?: string;
    kind?: string;
  }): Promise<QualityDebtRow[]>;

  /**
   * Versioned committed scope (§15.6): appends `delivery_commitments`
   * at max(version)+1 for the commitment and returns the row with the
   * allocated `version`. planned ≠ committed ≠ implemented ≠ verified
   * ≠ delivered.
   */
  commitDeliveryCommitment(
    row: Omit<DeliveryCommitmentRow, 'version'>,
  ): Promise<DeliveryCommitmentRow>;
  /** Head (max version) of a commitment when `version` is omitted. */
  getDeliveryCommitment(
    key: { workspace: string; commitment_id: string },
    version?: number,
  ): Promise<DeliveryCommitmentRow | null>;
  /** Latest version of every commitment — status filter applies to
   *  the head rows. */
  listDeliveryCommitments(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<DeliveryCommitmentRow[]>;
  listDeliveryCommitmentVersions(key: {
    workspace: string;
    commitment_id: string;
  }): Promise<DeliveryCommitmentRow[]>;

  // ---- eval lab (PRD §15.12, wp-156) ----

  upsertEvalRun(row: EvalRunRow): Promise<void>;
  getEvalRun(key: {
    workspace: string;
    eval_run_id: string;
  }): Promise<EvalRunRow | null>;
  listEvalRuns(filter?: {
    workspace?: string;
    family?: string;
    status?: string;
  }): Promise<EvalRunRow[]>;

  /** Golden-set cases — upsert keeps the corpus curatable. */
  upsertEvalCase(row: EvalCaseRow): Promise<void>;
  listEvalCases(filter: {
    workspace: string;
    family?: string;
  }): Promise<EvalCaseRow[]>;

  /** Append-only — a re-run is a new eval_run. */
  appendEvalResult(row: EvalResultRow): Promise<void>;
  listEvalResults(key: {
    workspace: string;
    eval_run_id: string;
  }): Promise<EvalResultRow[]>;

  // =====================================================================
  // Code intelligence / evidence plane (INTELLIGENCE §4, D37, wp-110).
  // Commit-pinned, derived state: only `repo_indexes.status = current`
  // is the default retrieval head; `building`/`failed` rows are never
  // served. Historical units stay addressable for citations/audit.
  // =====================================================================

  /** Upsert a commit-pinned index head (status building → current|failed). */
  upsertRepoIndex(row: RepoIndexRow): Promise<void>;
  getRepoIndex(key: {
    workspace: string;
    repo: string;
    commit_sha: string;
  }): Promise<RepoIndexRow | null>;
  /** The `status = current` head — the ONLY default retrieval head. */
  getCurrentRepoIndex(
    workspace: string,
    repo: string,
  ): Promise<RepoIndexRow | null>;
  /** Most recent head per (repo) for the given status; used for
   *  `allow-stale` fallback and the repository-index status surface. */
  listRepoIndexes(filter?: {
    workspace?: string;
    repo?: string;
    status?: string;
  }): Promise<RepoIndexRow[]>;
  /**
   * Atomically promote a fully-built head: sets the target row `current`
   * and flips every other head for (workspace, repo) to `superseded` in
   * ONE transaction. Throws when the target is missing or `failed` — a
   * partial or failed index is never promoted (DB-SCHEMA D37).
   */
  promoteRepoIndexHead(
    key: { workspace: string; repo: string; commit_sha: string },
    at?: string,
  ): Promise<void>;
  /** Update a head's status/indexed_at/stats (building→failed on error). */
  setRepoIndexStatus(
    key: { workspace: string; repo: string; commit_sha: string },
    status: RepoIndexRow['status'],
    patch?: { indexed_at?: string; stats?: Record<string, unknown> | null },
  ): Promise<void>;

  /** Idempotent bulk write of code units for a commit (upsert on `id`). */
  upsertCodeUnits(rows: CodeUnitRow[]): Promise<void>;
  getCodeUnit(id: string): Promise<CodeUnitRow | null>;
  listCodeUnits(filter: {
    workspace: string;
    repo: string;
    commit_sha: string;
    path?: string;
  }): Promise<CodeUnitRow[]>;
  /** Delete a path's units at a commit (deleted/renamed path handling). */
  deleteCodeUnitsForPath(key: {
    workspace: string;
    repo: string;
    commit_sha: string;
    path: string;
  }): Promise<void>;
  /** Full-text search, scoped to explicit authorized heads only. */
  searchCodeUnitsFts(q: {
    workspace: string;
    heads: CodeHead[];
    query: string;
    limit: number;
  }): Promise<CodeUnitFtsHit[]>;
  /** Exact symbol/path match, scoped to authorized heads. */
  findCodeUnitsExact(q: {
    workspace: string;
    heads: CodeHead[];
    symbols?: string[];
    paths?: string[];
    limit: number;
  }): Promise<CodeUnitRow[]>;
  /** Units whose content hash matches — maps semantic recall (content-
   *  addressed embeddings) back to authorized commit-pinned rows. */
  findCodeUnitsByHash(q: {
    workspace: string;
    heads: CodeHead[];
    hashes: string[];
    limit: number;
  }): Promise<CodeUnitRow[]>;

  /** Upsert a structural/explicit code edge (idempotent on PK). */
  upsertCodeEdge(row: CodeEdgeRow): Promise<void>;
  listCodeEdges(filter: {
    workspace: string;
    repo: string;
    commit_sha: string;
    subject_ref?: string;
    predicate?: string;
  }): Promise<CodeEdgeRow[]>;

  /** Persist one golden-set run's metrics (INTELLIGENCE §7). */
  insertRetrievalEvaluation(row: RetrievalEvaluationRow): Promise<void>;
  getRetrievalEvaluation(id: string): Promise<RetrievalEvaluationRow | null>;
  listRetrievalEvaluations(filter?: {
    task?: string;
    suite_version?: string;
  }): Promise<RetrievalEvaluationRow[]>;

  // =====================================================================
  // Continuous alignment (SCHEMAS §18, INTELLIGENCE §5, D37 Phase B,
  // wp-112). Runs are durable + deduplicated: an `on-merge` run keyed
  // by (workspace, scope, trigger_sha) collides on the unique index and
  // returns `existing` — duplicate merge events can never fork history.
  // Finding `status` changes ONLY through `decideAlignmentFinding`
  // (OCC + append-only audit); a comparison re-run may refresh
  // evidence/confidence/freshness but never reopens a settled finding.
  // =====================================================================

  /**
   * Insert a comparison run. Returns `created` when the row landed,
   * `existing` (+ the row) when the (workspace, scope, trigger_sha)
   * dedupe key already has one — the caller reuses that run_id.
   */
  insertAlignmentRun(row: AlignmentRunRow): Promise<{
    state: 'created' | 'existing';
    run: AlignmentRunRow;
  }>;
  getAlignmentRun(key: {
    workspace: string;
    run_id: string;
  }): Promise<AlignmentRunRow | null>;
  /** Most recent first; filter by scope/status/trigger. */
  listAlignmentRuns(filter?: {
    workspace?: string;
    scope?: string;
    status?: string;
    trigger?: string;
  }): Promise<AlignmentRunRow[]>;
  /** Finish a run: status + the validated artifact + finding count +
   *  usage totals. */
  updateAlignmentRun(
    key: { workspace: string; run_id: string },
    patch: Partial<
      Pick<
        AlignmentRunRow,
        | 'status'
        | 'finding_count'
        | 'artifact'
        | 'index_heads'
        | 'tokens_in'
        | 'tokens_out'
        | 'cost_usd'
        | 'finished_at'
      >
    >,
  ): Promise<void>;

  /**
   * Persist a finding from a comparison run. `ON CONFLICT` refreshes
   * the mutable evidence fields (claim/confidence/evidence/freshness/
   * next-check/run_id) but NEVER touches `status` — a dismissed or
   * verified finding stays settled across re-runs (original preserved).
   */
  upsertAlignmentFinding(row: AlignmentFindingRow): Promise<void>;
  getAlignmentFinding(key: {
    workspace: string;
    id: string;
  }): Promise<AlignmentFindingRow | null>;
  listAlignmentFindings(filter?: {
    workspace?: string;
    scope?: string;
    run_id?: string;
    kind?: string;
    status?: string;
  }): Promise<AlignmentFindingRow[]>;
  /**
   * Atomic optimistic-concurrency status transition for a human
   * inspect/dismiss/verify/resolve decision — same contract as
   * `decideRelation`: `updated` | `noop` (already at target) |
   * `conflict` (stale `expected` → HTTP 409) | `missing` (404).
   */
  decideAlignmentFinding(
    key: { workspace: string; id: string },
    expected: AlignmentFindingRow['status'] | null,
    next: NonNullable<AlignmentFindingRow['status']>,
    at: string,
  ): Promise<
    | { state: 'updated'; prior: AlignmentFindingRow['status'] }
    | { state: 'noop' }
    | { state: 'conflict'; current: AlignmentFindingRow['status'] }
    | { state: 'missing' }
  >;
  /** Append-only audit row for a decision (seq allocated by the
   *  caller inside the same transaction). */
  appendAlignmentFindingDecision(
    row: AlignmentFindingDecisionRow,
  ): Promise<void>;
  listAlignmentFindingDecisions(filter: {
    workspace: string;
    finding_id: string;
  }): Promise<AlignmentFindingDecisionRow[]>;
  // ---- test-environment requests (PRD §15.10, wp-157) ----

  /** `TE-NNNN` allocator — same transactional seq-bump as tickets. */
  allocTestEnvRequestId(workspace: string): Promise<string>;
  /**
   * Upsert a `test_env_requests` row (DB-SCHEMA). The row is the
   * durable request/audit trail: `pending → fulfilled|waived|expired`.
   * Provisioning evidence + the requesting `run_id` live on it.
   */
  upsertTestEnvRequest(row: TestEnvRequestRow): Promise<void>;
  getTestEnvRequest(key: {
    workspace: string;
    request_id: string;
  }): Promise<TestEnvRequestRow | null>;
  /** Requests scoped by workspace/subject/status (open-request lookup). */
  listTestEnvRequests(filter?: {
    workspace?: string;
    subject?: string;
    status?: string;
  }): Promise<TestEnvRequestRow[]>;

  // =====================================================================
  // Telemetry + incident intelligence (SCHEMAS §19, INTELLIGENCE §6,
  // D37 Phase C, wp-120). Raw events never land here — only sanitized,
  // deduplicated signatures, backend locators, incidents, investigations,
  // and verified resolutions. `incidents.status` and proposal `status`
  // move ONLY through the OCC decide paths (decideIncident /
  // decideIncidentTicketProposal); ingest upserts never touch them.
  // =====================================================================

  /** Register/update a telemetry source. `config` carries secret
   *  names/refs only — the connector layer rejects raw values. */
  upsertTelemetrySource(row: TelemetrySourceRow): Promise<void>;
  getTelemetrySource(key: {
    workspace: string;
    id: string;
  }): Promise<TelemetrySourceRow | null>;
  listTelemetrySources(filter?: {
    workspace?: string;
    enabled?: boolean;
  }): Promise<TelemetrySourceRow[]>;

  /**
   * Upsert an error signature on its dedupe key (workspace,
   *   source_id, fingerprint_version, fingerprint): a repeat event
   *   refreshes `representative`/`attributes`/`last_seen` and adds
   *   `count_delta` to `count` — one versioned row per pattern, never
   *   a row per event (INTELLIGENCE §6.1). Returns the row and whether
   *   it was newly created.
   */
  upsertErrorSignature(
    row: ErrorSignatureRow,
    countDelta: number,
  ): Promise<{ state: 'created' | 'updated'; row: ErrorSignatureRow }>;
  getErrorSignature(key: {
    workspace: string;
    id: string;
  }): Promise<ErrorSignatureRow | null>;
  listErrorSignatures(filter?: {
    workspace?: string;
    source_id?: string;
  }): Promise<ErrorSignatureRow[]>;
  /** Retention — remove derived signatures (and only derived state;
   *  the source backend is never touched) older than `before`. */
  pruneErrorSignatures(key: {
    workspace: string;
    before: string;
  }): Promise<number>;

  /** INC-NNNN allocator — same transactional seq-bump as tickets. */
  allocIncidentId(workspace: string): Promise<string>;

  /** Open an incident bound to a signature. Idempotent on `id`. */
  insertIncident(row: IncidentRow): Promise<void>;
  getIncident(key: {
    workspace: string;
    id: string;
  }): Promise<IncidentRow | null>;
  listIncidents(filter?: {
    workspace?: string;
    status?: string;
    signature_id?: string;
  }): Promise<IncidentRow[]>;
  /** Non-lifecycle fields only (summary/investigation_ref/root_cause/
   *  resolution/refs) — `status`/`resolution_verified`/`resolved_at`
   *  move exclusively through `decideIncident`. */
  updateIncident(
    key: { workspace: string; id: string },
    patch: Partial<
      Pick<
        IncidentRow,
        | 'summary'
        | 'investigation_ref'
        | 'root_cause'
        | 'resolution'
        | 'deployment_refs'
        | 'ticket_refs'
        | 'pr_refs'
      >
    >,
  ): Promise<void>;
  /**
   * Atomic optimistic-concurrency status transition for a human
   * incident decision — same contract as `decideAlignmentFinding`:
   * `updated` | `noop` | `conflict` (stale `expected`) | `missing`.
   * `next: 'resolved'` additionally stamps `resolution_verified=1` and
   * `resolved_at`; `reopen` clears them.
   */
  decideIncident(
    key: { workspace: string; id: string },
    expected: IncidentRow['status'] | null,
    next: IncidentRow['status'],
    at: string,
  ): Promise<
    | { state: 'updated'; prior: IncidentRow['status'] }
    | { state: 'noop' }
    | { state: 'conflict'; current: IncidentRow['status'] }
    | { state: 'missing' }
  >;
  /** Append-only incident-decision audit (seq allocated by the caller
   *  inside the same transaction). */
  appendIncidentDecision(row: IncidentDecisionRow): Promise<void>;
  listIncidentDecisions(filter: {
    workspace: string;
    incident_id: string;
  }): Promise<IncidentDecisionRow[]>;
  /** Retention — remove incidents (and their decision audit) last
   *  touched before `before`; the source backend is never touched. */
  pruneIncidents(key: {
    workspace: string;
    before: string;
  }): Promise<number>;

  /** Draft-ticket proposals — the draft-ticket gate (wp-120). */
  insertIncidentTicketProposal(row: IncidentTicketProposalRow): Promise<void>;
  getIncidentTicketProposal(key: {
    workspace: string;
    id: string;
  }): Promise<IncidentTicketProposalRow | null>;
  listIncidentTicketProposals(filter?: {
    workspace?: string;
    incident_id?: string;
    status?: string;
  }): Promise<IncidentTicketProposalRow[]>;
  /**
   * OCC approve/reject on a draft proposal — `approved` records
   *   `board_item_id` of the tray item the decision created. Same
   *   `updated|noop|conflict|missing` contract as the other decide
   *   paths.
   */
  decideIncidentTicketProposal(
    key: { workspace: string; id: string },
    expected: IncidentTicketProposalRow['status'] | null,
    next: IncidentTicketProposalRow['status'],
    at: string,
    decidedBy: string,
    boardItemId?: string | null,
  ): Promise<
    | { state: 'updated'; prior: IncidentTicketProposalRow['status'] }
    | { state: 'noop' }
    | { state: 'conflict'; current: IncidentTicketProposalRow['status'] }
    | { state: 'missing' }
  >;
}
