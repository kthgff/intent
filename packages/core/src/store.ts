/**
 * Store interface — the storage contract for DB-SCHEMA.md.
 * One schema, two backends: SQLite (solo) and Postgres (daemon) via
 * `storage_url` (DB-SCHEMA intro; TRACKER D6 ships SQLite first).
 *
 * Data classes (PRD/DB-SCHEMA): *coordination* (leases, runs, claims,
 * presence, notifications) and *query/reference* (dossiers, entities,
 * relations, embeddings, ticket/event projections). Everything is
 * ephemeral-or-regenerable — git keeps the approval/audit truth.
 *
 * Signatures only — implementations live in packages/store (wp-011).
 */
import type {
  Claim,
  DossierEntry,
  Embedding,
  Entity,
  EventRow,
  GateItem,
  Lease,
  Notification,
  Presence,
  Relation,
  RunRow,
  TicketRepoRow,
  TicketRow,
  UsageCallRow,
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

export interface TicketRepoKey extends TicketKey {
  repo: string;
}

/** Embedding lookup (DB-SCHEMA embeddings PK + §12 recall uses). */
export interface EmbeddingKey {
  object_ref: string;
  model: string;
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

/**
 * The Store contract (DB-SCHEMA.md). All reads/writes carry the
 * install/user id (SETTINGS `actor:`) — shared-queue attribution.
 */
export interface Store {
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
   *  detached process never touches the DB (DB-SCHEMA rules). */
  heartbeatLease(key: LeaseKey, at: string): Promise<void>;
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

  // ---- ticket projections (rebuilt from git frontmatter every pull) ----

  /** Upsert the `tickets` projection row (DB-SCHEMA tickets; rebuilt on
   *  pull — never re-parse ticket.md in the DB). */
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

  // ---- event / usage projections (rebuildable — nuke + replay) ----

  /**
   * Append an events_idx row (DB-SCHEMA events_idx; projection of
   * events.jsonl SCHEMAS §7). `seq` is assigned by the store.
   */
  appendEvent(row: EventRow): Promise<number>;
  listEvents(filter: {
    workspace: string;
    ticket_id?: string;
    subject?: string;
    event?: string;
  }): Promise<EventRow[]>;
  /** Replay support: drop and rebuild projections from git
   *  (DB-SCHEMA "Rebuildable" rule). */
  clearEvents(workspace: string, ticket_id?: string): Promise<void>;

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
    predicate?: string;
    object?: string;
  }): Promise<Relation[]>;
  deleteRelation(r: Relation): Promise<void>;

  /** sqlite-vec / pgvector (DB-SCHEMA embeddings; §12 uses: prior-art
   *  recall, near-dup detection, dossier retrieval, conflict prediction). */
  upsertEmbedding(e: Embedding): Promise<void>;
  getEmbedding(key: EmbeddingKey): Promise<Embedding | null>;
  deleteEmbedding(key: EmbeddingKey): Promise<void>;
  nearestEmbeddings(q: NearestQuery): Promise<NearestResult[]>;
}
