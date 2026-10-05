/**
 * Postgres implementation of the `Store` contract (packages/core
 * src/store.ts; docs/DB-SCHEMA.md, D29).
 *
 * The DB IS the system of record — tickets/docs/events/boards are
 * truth rows, not projections.
 *
 * - Driver-agnostic over `PgClient` (client.ts): postgres.js at
 *   runtime, PGlite (embedded Postgres) in tests — same SQL, `$n`
 *   params throughout.
 * - Mutating CAS operations (leases, claims, id allocation, doc
 *   versions) run inside transactions; a contested lease insert fails
 *   on PK conflict → caller skips the tick.
 * - Migrations: `migrations/pg/*.sql`, applied sequentially inside
 *   transactions; each version recorded in `schema_meta`.
 * - Embeddings: `vector` BYTEA of Float32 bytes; `nearestEmbeddings`
 *   is an app-side cosine scan (swap for pgvector when it ships).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  AssumptionRow,
  BoardItem,
  BoardRow,
  ChangesetItemRow,
  ChangesetRow,
  Claim,
  ClaimKey,
  ContainerKey,
  ContainerRow,
  ContainerState,
  DeliveryCommitmentRow,
  DeploymentRow,
  DesignApprovalRow,
  DocKey,
  DocVersion,
  DossierEntry,
  Embedding,
  EmbeddingKey,
  Entity,
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
  GateItemKey,
  InitiativeRow,
  InterviewBranchRow,
  InterviewMessageRow,
  InterviewSessionRow,
  KnowledgeSlotRow,
  Lease,
  LeaseKey,
  NearestQuery,
  NearestResult,
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
  Store,
  TicketKey,
  TicketRepoKey,
  TicketRepoRow,
  TicketRow,
  UsageCallRow,
  WizardDefinitionRow,
  WizardVersionRow,
} from '@sprint-runner/core';
import { type PgClient, createClient } from './client.js';

/** Live (non-terminal) run statuses for the reconcile pass —
 *  `validated`/`committed` are transient collect stages: a crash
 *  between them must NOT drop the run from the sweep (it re-enters
 *  via the collecting resume path). */
const LIVE_RUN_STATUSES = [
  'pending',
  'leased',
  'running',
  'paused',
  'exited',
  'collecting',
  'validated',
  'committed',
  'blocked',
  'stalled',
];

/** Run events that generate a notifications row (DB-SCHEMA rules). */
const NOTIFY_EVENTS = new Set(['run_failed', 'run_killed', 'blocked']);

const RUN_COLUMNS = [
  'workspace',
  'subject',
  'ticket_id',
  'stage',
  'attempt',
  'backend',
  'model',
  'depth',
  'pid',
  'worktree',
  'container_id',
  'request',
  'status',
  'started_at',
  'heartbeat_at',
  'exited_at',
  'sentinel',
  'sentinel_raw',
  'cost_usd',
  'tokens_in',
  'tokens_out',
  'tokens_cached',
  'usage_source',
  'duration_s',
  'run_dir',
] as const;

const now = () => new Date().toISOString();

const j = (v: unknown): string => JSON.stringify(v ?? null);
const unj = <T>(v: unknown, fallback: T): T =>
  v === null || v === undefined ? fallback : (JSON.parse(v as string) as T);

type Row = Record<string, unknown>;

export class PostgresStore implements Store {
  readonly db: PgClient;
  private readonly migrations: string;

  private constructor(
    db: PgClient,
    migrationsDir = fileURLToPath(
      new URL('../migrations/pg/', import.meta.url),
    ),
  ) {
    this.db = db;
    this.migrations = migrationsDir;
  }

  /** Open `storage_url` (postgres://… or pglite:/:memory:) and migrate. */
  static async connect(
    storageUrl: string,
    opts: { migrate?: boolean } = {},
  ): Promise<PostgresStore> {
    const db = await createClient(storageUrl);
    const store = new PostgresStore(db);
    if (opts.migrate !== false) await store.migrate();
    return store;
  }

  /** Wrap an existing client (shared-connection tests, embedded use). */
  static wrap(db: PgClient): PostgresStore {
    return new PostgresStore(db);
  }

  /**
   * Atomic multi-write (ARCHITECTURE §4.4): `fn` receives a store bound
   * to the transaction — all row changes, doc versions, and events
   * commit together or roll back together.
   */
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new PostgresStore(tx)));
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // ---- migrations -------------------------------------------------

  /** Session-scoped advisory lock key (ARCHITECTURE: "takes a Postgres
   *  advisory migration lock") — serializes concurrent migrators across
   *  installs. `veto` → a fixed bigint constant. */
  private static readonly MIGRATION_LOCK_KEY = 727001;

  /**
   * Apply pending `migrations/pg/NNNN_*.sql` in order under the advisory
   * lock; each applied version records its file's sha256 in
   * `schema_meta.checksum` and already-applied checksums are verified on
   * every boot — a tampered migration file fails closed rather than
   * silently drifting (wp-091).
   */
  async migrate(): Promise<void> {
    // Advisory lock FIRST — schema_meta bootstrap itself races when two
    // installs boot together. Session-level lock: released in finally,
    // never transaction-scoped (it must outlive each migration's tx).
    await this.db.query('SELECT pg_advisory_lock($1)', [
      PostgresStore.MIGRATION_LOCK_KEY,
    ]);
    try {
      await this.db.query(
        'CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL, applied_at TEXT NOT NULL, checksum TEXT)',
      );
      // Upgrading a pre-checksum schema_meta.
      await this.db.query(
        'ALTER TABLE schema_meta ADD COLUMN IF NOT EXISTS checksum TEXT',
      );
      const appliedRows = await this.db.query<{
        version: number;
        checksum: string | null;
      }>('SELECT version, checksum FROM schema_meta ORDER BY version');
      const appliedChecksum = new Map(
        appliedRows.map((r) => [r.version, r.checksum]),
      );
      const applied = appliedRows.reduce((m, r) => Math.max(m, r.version), 0);
      const files = readdirSync(this.migrations)
        .filter((f) => /^\d+_.*\.sql$/.test(f))
        .sort();
      for (const file of files) {
        const version = Number.parseInt(file.slice(0, 4), 10);
        const sql = readFileSync(`${this.migrations}/${file}`, 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        if (version <= applied) {
          // Fail-closed drift check: an applied migration whose file no
          // longer matches its recorded checksum means the schema and
          // the code disagree — boot stops, the operator investigates.
          const recorded = appliedChecksum.get(version);
          if (recorded && recorded !== checksum) {
            throw new Error(
              `migration ${file} checksum drift: recorded ${recorded.slice(0, 12)}… ` +
                `≠ current ${checksum.slice(0, 12)}… (schema_meta tamper or a modified applied migration)`,
            );
          }
          continue;
        }
        await this.db.transaction(async (tx) => {
          await tx.exec(sql);
          await tx.query(
            'INSERT INTO schema_meta (version, applied_at, checksum) VALUES ($1, $2, $3)',
            [version, now(), checksum],
          );
        });
      }
    } finally {
      await this.db
        .query('SELECT pg_advisory_unlock($1)', [
          PostgresStore.MIGRATION_LOCK_KEY,
        ])
        .catch(() => {});
    }
  }

  // ---- meta ----

  async getSchemaVersion(): Promise<number> {
    const rows = await this.db.query<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM schema_meta',
    );
    return rows[0]?.v ?? 0;
  }

  async setSchemaVersion(version: number): Promise<void> {
    await this.db.query(
      'INSERT INTO schema_meta (version, applied_at) VALUES ($1, $2)',
      [version, now()],
    );
  }

  // ---- leases ----

  /** Expiry: last heartbeat (or acquired_at) + ttl_s < now (ISO text). */
  private static readonly LEASE_EXPIRED = `(
    COALESCE(heartbeat_at, acquired_at)::timestamptz
      + make_interval(secs => ttl_s)
  ) < $NOW::timestamptz`;

  private expiredClause(nowIdx: number): string {
    return PostgresStore.LEASE_EXPIRED.replace('$NOW', `$${nowIdx}`);
  }

  async acquireLease(
    key: LeaseKey,
    holder: string,
    ttl_s: number,
  ): Promise<Lease | null> {
    const at = now();
    try {
      return await this.db.transaction(async (tx): Promise<Lease | null> => {
        const existing = await getLeaseRow(tx, key);
        if (existing) {
          const expired = await tx.query(
            `SELECT 1 FROM leases
             WHERE workspace=$1 AND subject=$2 AND stage=$3 AND attempt=$4
               AND ${this.expiredClause(5)}`,
            [key.workspace, key.subject, key.stage, key.attempt, at],
          );
          if (expired.length === 0) return null;
          await deleteLease(tx, key);
        }
        await tx.query(
          `INSERT INTO leases (workspace, subject, stage, attempt, holder,
             acquired_at, ttl_s, heartbeat_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            key.workspace,
            key.subject,
            key.stage,
            key.attempt,
            holder,
            at,
            ttl_s,
            at,
          ],
        );
        return getLeaseRow(tx, key);
      });
    } catch (e) {
      // PK conflict — another install won the race between check+insert.
      if (isUniqueViolation(e)) return null;
      throw e;
    }
  }

  /** Fenced heartbeat: updates only when `holder` still owns the lease —
   *  returns false when the row is missing or held by someone else (a
   *  stale conductor must not refresh another owner's lease). */
  async heartbeatLease(
    key: LeaseKey,
    holder: string,
    at: string,
  ): Promise<boolean> {
    const rows = await this.db.query<{ workspace: string }>(
      `UPDATE leases SET heartbeat_at=$5
       WHERE workspace=$1 AND subject=$2 AND stage=$3 AND attempt=$4
         AND holder=$6
       RETURNING workspace`,
      [key.workspace, key.subject, key.stage, key.attempt, at, holder],
    );
    return rows.length > 0;
  }

  async releaseLease(key: LeaseKey, holder: string): Promise<void> {
    await this.db.query(
      `DELETE FROM leases
       WHERE workspace=$1 AND subject=$2 AND stage=$3 AND attempt=$4
         AND holder=$5`,
      [key.workspace, key.subject, key.stage, key.attempt, holder],
    );
  }

  async getLease(key: LeaseKey): Promise<Lease | null> {
    return getLeaseRow(this.db, key);
  }

  async sweepExpiredLeases(nowTs: string): Promise<LeaseKey[]> {
    return this.db.transaction(async (tx): Promise<LeaseKey[]> => {
      const rows = await tx.query<Row>(
        `DELETE FROM leases WHERE ${this.expiredClause(1)}
         RETURNING workspace, subject, stage, attempt`,
        [nowTs],
      );
      return rows as unknown as LeaseKey[];
    });
  }

  // ---- claims ----

  async acquireClaim(
    key: ClaimKey,
    actor: string,
    ttl_s: number,
  ): Promise<Claim | null> {
    const at = now();
    try {
      return await this.db.transaction(async (tx): Promise<Claim | null> => {
        const existing = await getClaimRow(tx, key);
        if (existing) {
          const expired = await tx.query(
            `SELECT 1 FROM claims
             WHERE workspace=$1 AND subject=$2 AND gate=$3
               AND (claimed_at::timestamptz + make_interval(secs => ttl_s))
                   < $4::timestamptz`,
            [key.workspace, key.subject, key.gate, at],
          );
          if (expired.length === 0) return null;
          await tx.query(
            `DELETE FROM claims
             WHERE workspace=$1 AND subject=$2 AND gate=$3`,
            [key.workspace, key.subject, key.gate],
          );
        }
        await tx.query(
          `INSERT INTO claims (workspace, subject, gate, claimed_by,
             claimed_at, ttl_s)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [key.workspace, key.subject, key.gate, actor, at, ttl_s],
        );
        return getClaimRow(tx, key);
      });
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
  }

  async releaseClaim(key: ClaimKey, actor: string): Promise<void> {
    await this.db.query(
      `DELETE FROM claims
       WHERE workspace=$1 AND subject=$2 AND gate=$3 AND claimed_by=$4`,
      [key.workspace, key.subject, key.gate, actor],
    );
  }

  async getClaim(key: ClaimKey): Promise<Claim | null> {
    return getClaimRow(this.db, key);
  }

  // ---- runs ----

  async createRun(run: RunRow): Promise<void> {
    const cols = ['id', ...RUN_COLUMNS];
    await this.db.query(
      `INSERT INTO runs (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => runParam(run, c)),
    );
  }

  async updateRun(id: string, patch: Partial<RunRow>): Promise<void> {
    const keys = RUN_COLUMNS.filter(
      (c) => c in patch && patch[c] !== undefined,
    );
    // `id` is not a mutable column — an {id}-only patch is a no-op, and
    // an empty SET clause would emit invalid SQL.
    if (keys.length === 0) return;
    const sets = keys.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await this.db.query(`UPDATE runs SET ${sets} WHERE id = $1`, [
      id,
      ...keys.map((c) => runParam(patch, c)),
    ]);
  }

  async heartbeatRun(id: string, at: string): Promise<void> {
    await this.db.query('UPDATE runs SET heartbeat_at=$1 WHERE id=$2', [
      at,
      id,
    ]);
  }

  async updateRunUsage(
    id: string,
    delta: {
      tokens_in?: number;
      tokens_out?: number;
      tokens_cached?: number;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE runs SET
         tokens_in = COALESCE(tokens_in, 0) + COALESCE($2, 0),
         tokens_out = COALESCE(tokens_out, 0) + COALESCE($3, 0),
         tokens_cached = COALESCE(tokens_cached, 0) + COALESCE($4, 0)
       WHERE id = $1`,
      [
        id,
        delta.tokens_in ?? null,
        delta.tokens_out ?? null,
        delta.tokens_cached ?? null,
      ],
    );
  }

  async getRun(id: string): Promise<RunRow | null> {
    const rows = await this.db.query('SELECT * FROM runs WHERE id=$1', [id]);
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async listLiveRuns(): Promise<RunRow[]> {
    const marks = LIVE_RUN_STATUSES.map((_, i) => `$${i + 1}`).join(',');
    const rows = await this.db.query(
      `SELECT * FROM runs WHERE status IN (${marks})`,
      [...LIVE_RUN_STATUSES],
    );
    return rows.map(rowToRun);
  }

  async listRuns(filter?: {
    workspace?: string;
    subject?: string;
    ticket_id?: string;
    status?: string;
  }): Promise<RunRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      subject: filter?.subject,
      ticket_id: filter?.ticket_id,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM runs ${where} ORDER BY started_at`,
      args,
    );
    return rows.map(rowToRun);
  }

  // ---- containers (D30) ----

  async upsertContainer(row: ContainerRow): Promise<void> {
    await this.db.query(
      `INSERT INTO containers (workspace, subject, container_id, image,
         state, created_at, stopped_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace, subject) DO UPDATE SET
         container_id=$3, image=$4, state=$5, created_at=$6,
         stopped_at=$7`,
      [
        row.workspace,
        row.subject,
        row.container_id,
        row.image ?? null,
        row.state,
        row.created_at ?? now(),
        row.stopped_at ?? null,
      ],
    );
  }

  async getContainer(key: ContainerKey): Promise<ContainerRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM containers WHERE workspace=$1 AND subject=$2',
      [key.workspace, key.subject],
    );
    return rows[0] ? rowToContainer(rows[0]) : null;
  }

  async listContainers(filter?: {
    workspace?: string;
    state?: ContainerState;
  }): Promise<ContainerRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      state: filter?.state,
    });
    const rows = await this.db.query(
      `SELECT * FROM containers ${where} ORDER BY workspace, subject`,
      args,
    );
    return rows.map(rowToContainer);
  }

  // ---- tickets ----

  async upsertTicket(row: TicketRow): Promise<void> {
    const p = [
      row.workspace,
      row.org ?? null,
      row.ticket_id,
      row.feature ?? null,
      row.title,
      row.status,
      row.priority,
      row.depth ?? null,
      row.backend ?? null,
      row.model ?? null,
      j(row.repos),
      row.parent ?? null,
      j(row.depends_on),
      j(row.serves ?? null),
      row.source ?? null,
      row.work_type ?? null,
      row.origin ?? null,
      row.severity ?? null,
      row.execution_readiness ?? 'unassessed',
      row.parallel_safety ?? 'unknown',
      row.source_ref ? j(row.source_ref) : null,
      row.test_env ? j(row.test_env) : null,
      row.forced ? 1 : 0,
      row.spec_score ?? null,
      row.spec_hash ?? null,
      row.blocked_reason ?? null,
      row.created_at ?? null,
      row.updated_at,
    ];
    await this.db.query(
      `INSERT INTO tickets (workspace, org, ticket_id, feature, title,
         status, priority, depth, backend, model, repos, parent,
         depends_on, serves, source, work_type, origin, severity,
         execution_readiness, parallel_safety, source_ref, test_env,
         forced, spec_score, spec_hash, blocked_reason, created_at,
         updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (workspace, ticket_id) DO UPDATE SET
         org=$2, feature=$4, title=$5, status=$6, priority=$7, depth=$8,
         backend=$9, model=$10, repos=$11, parent=$12, depends_on=$13,
         serves=$14, source=$15, work_type=$16, origin=$17, severity=$18,
         execution_readiness=$19, parallel_safety=$20, source_ref=$21,
         test_env=$22, forced=$23, spec_score=$24, spec_hash=$25,
         blocked_reason=$26, updated_at=$28`,
      p,
    );
  }

  async getTicket(key: TicketKey): Promise<TicketRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM tickets WHERE workspace=$1 AND ticket_id=$2',
      [key.workspace, key.ticket_id],
    );
    return rows[0] ? rowToTicket(rows[0]) : null;
  }

  async listTickets(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<TicketRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM tickets ${where} ORDER BY ticket_id`,
      args,
    );
    return rows.map(rowToTicket);
  }

  async deleteTicket(key: TicketKey): Promise<void> {
    await this.db.query(
      'DELETE FROM tickets WHERE workspace=$1 AND ticket_id=$2',
      [key.workspace, key.ticket_id],
    );
  }

  async upsertTicketRepo(row: TicketRepoRow): Promise<void> {
    await this.db.query(
      `INSERT INTO ticket_repos (workspace, ticket_id, repo, branch,
         worktree, pr_url, pr_state, ci_state, merged_sha)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workspace, ticket_id, repo) DO UPDATE SET
         branch=$4, worktree=$5, pr_url=$6, pr_state=$7, ci_state=$8,
         merged_sha=$9`,
      [
        row.workspace,
        row.ticket_id,
        row.repo,
        row.branch ?? null,
        row.worktree ?? null,
        row.pr_url ?? null,
        row.pr_state ?? null,
        row.ci_state ?? null,
        row.merged_sha ?? null,
      ],
    );
  }

  async getTicketRepo(key: TicketRepoKey): Promise<TicketRepoRow | null> {
    const rows = await this.db.query(
      `SELECT * FROM ticket_repos
       WHERE workspace=$1 AND ticket_id=$2 AND repo=$3`,
      [key.workspace, key.ticket_id, key.repo],
    );
    return rows[0] ? rowToTicketRepo(rows[0]) : null;
  }

  async listTicketRepos(key: TicketKey): Promise<TicketRepoRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM ticket_repos
       WHERE workspace=$1 AND ticket_id=$2 ORDER BY repo`,
      [key.workspace, key.ticket_id],
    );
    return rows.map(rowToTicketRepo);
  }

  async deleteTicketRepos(key: TicketKey): Promise<void> {
    await this.db.query(
      'DELETE FROM ticket_repos WHERE workspace=$1 AND ticket_id=$2',
      [key.workspace, key.ticket_id],
    );
  }

  // ---- events (append-only truth) ----

  async appendEvent(row: EventRow): Promise<number> {
    return this.db.transaction(async (tx): Promise<number> => {
      const inserted = await tx.query<{ seq: number }>(
        `INSERT INTO events (workspace, ticket_id, ts, stage,
           actor_type, actor_id, event, run, refs, data, cost_usd,
           tokens_in, tokens_out, tokens_cached, usage_source,
           duration_s, human_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING seq`,
        [
          row.workspace,
          row.ticket_id ?? null,
          row.ts,
          row.stage ?? null,
          row.actor_type,
          row.actor_id,
          row.event,
          row.run ?? null,
          j(row.refs),
          j(row.data),
          row.cost_usd ?? null,
          row.tokens_in ?? null,
          row.tokens_out ?? null,
          row.tokens_cached ?? null,
          row.usage_source ?? null,
          row.duration_s ?? null,
          row.human_minutes ?? null,
        ],
      );
      // DB-SCHEMA notifications rule: run_failed/run_killed/blocked.
      if (NOTIFY_EVENTS.has(row.event)) {
        await insertNotificationRow(tx, {
          workspace: row.workspace,
          subject: row.ticket_id ?? row.run ?? 'unknown',
          kind: row.event,
          payload: j({ event: row.event, run: row.run ?? null }),
          created_at: row.ts,
          read_at: null,
        });
      }
      return Number(inserted[0]?.seq ?? 0);
    });
  }

  async listEvents(filter: {
    workspace: string;
    ticket_id?: string;
    subject?: string;
    event?: string;
  }): Promise<EventRow[]> {
    const { where, args, next } = pgWhere({
      workspace: filter.workspace,
      ticket_id: filter.ticket_id,
      event: filter.event,
    });
    let sql = `SELECT * FROM events ${where}`;
    if (filter.subject) {
      sql += `${where ? ' AND' : ' WHERE'} (ticket_id = $${next} OR run = $${next + 1})`;
      args.push(filter.subject, filter.subject);
    }
    sql += ' ORDER BY seq';
    const rows = await this.db.query(sql, args);
    return rows.map(rowToEvent);
  }

  async insertUsageCalls(rows: UsageCallRow[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const r of rows) {
        await tx.query(
          `INSERT INTO usage_calls (run_id, seq, ts, model,
             tokens_in, tokens_out, tokens_cached, latency_s, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (run_id, seq) DO UPDATE SET
             ts=$3, model=$4, tokens_in=$5, tokens_out=$6,
             tokens_cached=$7, latency_s=$8, source=$9`,
          [
            r.run_id,
            r.seq,
            r.ts,
            r.model,
            r.tokens_in ?? null,
            r.tokens_out ?? null,
            r.tokens_cached ?? null,
            r.latency_s ?? null,
            r.source ?? null,
          ],
        );
      }
    });
  }

  async listUsageCalls(run_id: string): Promise<UsageCallRow[]> {
    const rows = await this.db.query(
      'SELECT * FROM usage_calls WHERE run_id=$1 ORDER BY seq',
      [run_id],
    );
    return rows.map((r) => ({
      run_id: r.run_id as string,
      seq: r.seq as number,
      ts: r.ts as string,
      model: r.model as string,
      tokens_in: r.tokens_in as number,
      tokens_out: r.tokens_out as number,
      tokens_cached: r.tokens_cached as number,
      latency_s: r.latency_s as number,
      source: r.source as UsageCallRow['source'],
    }));
  }

  // ---- gate_items ----

  async upsertGateItem(item: GateItem): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO gate_items (workspace, subject, gate, kind,
           surfaced_at, cleared_at, snoozed_until, blocked_agent, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace, subject, gate) DO NOTHING
         RETURNING workspace`,
        [
          item.workspace,
          item.subject,
          item.gate,
          item.kind,
          item.surfaced_at,
          item.cleared_at ?? null,
          item.snoozed_until ?? null,
          item.blocked_agent ? 1 : 0,
          item.priority ?? null,
        ],
      );
      if (inserted.length > 0) {
        // DB-SCHEMA notifications rule: generated on gate_items insert.
        await insertNotificationRow(tx, {
          workspace: item.workspace,
          subject: item.subject,
          kind: `gate:${item.kind}`,
          payload: j({ gate: item.gate, kind: item.kind }),
          created_at: item.surfaced_at,
          read_at: null,
        });
      } else {
        await tx.query(
          `UPDATE gate_items SET kind=$4, surfaced_at=$5, cleared_at=$6,
             snoozed_until=$7, blocked_agent=$8, priority=$9
           WHERE workspace=$1 AND subject=$2 AND gate=$3`,
          [
            item.workspace,
            item.subject,
            item.gate,
            item.kind,
            item.surfaced_at,
            item.cleared_at ?? null,
            item.snoozed_until ?? null,
            item.blocked_agent ? 1 : 0,
            item.priority ?? null,
          ],
        );
      }
    });
  }

  async clearGateItem(key: GateItemKey, cleared_at: string): Promise<void> {
    await this.db.query(
      `UPDATE gate_items SET cleared_at=$4
       WHERE workspace=$1 AND subject=$2 AND gate=$3`,
      [key.workspace, key.subject, key.gate, cleared_at],
    );
  }

  async getGateItem(key: GateItemKey): Promise<GateItem | null> {
    const rows = await this.db.query(
      `SELECT * FROM gate_items
       WHERE workspace=$1 AND subject=$2 AND gate=$3`,
      [key.workspace, key.subject, key.gate],
    );
    return rows[0] ? rowToGateItem(rows[0]) : null;
  }

  async listGateItems(filter?: {
    workspace?: string;
    open?: boolean;
  }): Promise<GateItem[]> {
    const { where, args, next } = pgWhere({ workspace: filter?.workspace });
    let sql = `SELECT * FROM gate_items ${where}`;
    if (filter?.open === true)
      sql += `${where ? ' AND' : ' WHERE'} cleared_at IS NULL`;
    if (filter?.open === false)
      sql += `${where ? ' AND' : ' WHERE'} cleared_at IS NOT NULL`;
    void next;
    sql += ' ORDER BY surfaced_at';
    const rows = await this.db.query(sql, args);
    return rows.map(rowToGateItem);
  }

  // ---- notifications ----

  async insertNotification(n: Omit<Notification, 'id'>): Promise<number> {
    return insertNotificationRow(this.db, n);
  }

  async markNotificationRead(id: number, at: string): Promise<void> {
    await this.db.query('UPDATE notifications SET read_at=$1 WHERE id=$2', [
      at,
      id,
    ]);
  }

  async listNotifications(filter?: {
    workspace?: string;
    unreadOnly?: boolean;
  }): Promise<Notification[]> {
    const { where, args } = pgWhere({ workspace: filter?.workspace });
    let sql = `SELECT * FROM notifications ${where}`;
    if (filter?.unreadOnly)
      sql += `${where ? ' AND' : ' WHERE'} read_at IS NULL`;
    sql += ' ORDER BY id';
    const rows = await this.db.query(sql, args);
    return rows.map(rowToNotification);
  }

  async pruneNotifications(before: string): Promise<number> {
    const rows = await this.db.query<{ id: number }>(
      'DELETE FROM notifications WHERE created_at < $1 RETURNING id',
      [before],
    );
    return rows.length;
  }

  // ---- presence ----

  async upsertPresence(p: Presence): Promise<void> {
    await this.db.query(
      `INSERT INTO presence (install_id, actor, last_seen)
       VALUES ($1,$2,$3)
       ON CONFLICT (install_id) DO UPDATE SET actor=$2, last_seen=$3`,
      [p.install_id, p.actor, p.last_seen],
    );
  }

  async listPresence(): Promise<Presence[]> {
    const rows = await this.db.query(
      'SELECT * FROM presence ORDER BY install_id',
    );
    return rows.map((r) => ({
      install_id: r.install_id as string,
      actor: r.actor as string,
      last_seen: r.last_seen as string,
    }));
  }

  async prunePresence(before: string): Promise<number> {
    const rows = await this.db.query<{ install_id: string }>(
      'DELETE FROM presence WHERE last_seen < $1 RETURNING install_id',
      [before],
    );
    return rows.length;
  }

  // ---- dossiers ----

  private static dossierId(e: {
    scope: string;
    name: string;
    section: string;
  }): string {
    return `${e.scope}:${e.name}:${e.section}`;
  }

  /**
   * Versioning rules (DB-SCHEMA): every write lands at MAX(version)+1;
   * a machine refresh racing a human-edited latest version does NOT
   * overwrite — the new version is flagged `stale` (edited_by wins);
   * unchanged-but-older sibling sections get stale=1 after a refresh.
   */
  async upsertDossierSection(entry: DossierEntry): Promise<void> {
    const id = PostgresStore.dossierId(entry);
    await this.db.transaction(async (tx) => {
      // Serialize concurrent writers on this section — MAX(version)+1
      // under READ COMMITTED can otherwise double-allocate a version and
      // hit the PK. A transaction-scoped advisory lock makes the winner
      // recompute AFTER the loser commits (D29 store contract).
      await lockKey(tx, `dossier:${id}`);
      const latest = await tx.query<{ v: number | null }>(
        'SELECT MAX(version) AS v FROM dossiers WHERE id = $1',
        [id],
      );
      const version = (latest[0]?.v ?? 0) + 1;
      const human = await tx.query<{ edited_by: string | null }>(
        `SELECT edited_by FROM dossiers
         WHERE id = $1 ORDER BY version DESC LIMIT 1`,
        [id],
      );
      const stale =
        entry.stale || (!entry.edited_by && Boolean(human[0]?.edited_by));
      await tx.query(
        `INSERT INTO dossiers (id, scope, name, section, version,
           content, surveyed_at, sources_used, stale, edited_by, edited_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          entry.scope,
          entry.name,
          entry.section,
          version,
          entry.content,
          entry.surveyed_at,
          (entry.sources_used ?? []).join(','),
          stale ? 1 : 0,
          entry.edited_by ?? null,
          entry.edited_at ?? null,
        ],
      );
      await tx.query(
        `UPDATE dossiers SET stale = 1
         WHERE scope = $1 AND name = $2 AND id != $3
           AND version = (
             SELECT MAX(version) FROM dossiers d2 WHERE d2.id = dossiers.id)
           AND surveyed_at < $4`,
        [entry.scope, entry.name, id, entry.surveyed_at],
      );
    });
  }

  async getDossierSection(
    scope: string,
    name: string,
    section: string,
    version?: number,
  ): Promise<DossierEntry | null> {
    const id = PostgresStore.dossierId({ scope, name, section });
    const rows =
      version === undefined
        ? await this.db.query(
            'SELECT * FROM dossiers WHERE id=$1 ORDER BY version DESC LIMIT 1',
            [id],
          )
        : await this.db.query(
            'SELECT * FROM dossiers WHERE id=$1 AND version=$2',
            [id, version],
          );
    return rows[0] ? rowToDossier(rows[0]) : null;
  }

  async getDossier(scope: string, name: string): Promise<DossierEntry[]> {
    const rows = await this.db.query(
      `SELECT * FROM dossiers d
       WHERE d.scope=$1 AND d.name=$2
         AND d.version = (
           SELECT MAX(version) FROM dossiers d2 WHERE d2.id = d.id)
       ORDER BY d.section`,
      [scope, name],
    );
    return rows.map(rowToDossier);
  }

  async listDossiers(filter?: { scope?: string }): Promise<DossierEntry[]> {
    const { where, args } = pgWhere({ scope: filter?.scope });
    const rows = await this.db.query(
      `SELECT * FROM dossiers d ${where ? `${where} AND` : 'WHERE'}
         d.version = (
           SELECT MAX(version) FROM dossiers d2 WHERE d2.id = d.id)
       ORDER BY d.scope, d.name, d.section`,
      args,
    );
    return rows.map(rowToDossier);
  }

  async listDossierVersions(
    scope: string,
    name: string,
    section: string,
  ): Promise<DossierEntry[]> {
    const rows = await this.db.query(
      'SELECT * FROM dossiers WHERE id=$1 ORDER BY version',
      [PostgresStore.dossierId({ scope, name, section })],
    );
    return rows.map(rowToDossier);
  }

  // ---- entities / relations ----

  async upsertEntity(e: Entity): Promise<void> {
    await this.db.query(
      `INSERT INTO entities (id, product, kind, name, canonical,
         aliases, source, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET product=$2, kind=$3, name=$4,
         canonical=$5, aliases=$6, source=$7, evidence=$8`,
      [
        e.id,
        e.product,
        e.kind,
        e.name,
        e.canonical,
        j(e.aliases),
        e.source,
        e.evidence ?? null,
      ],
    );
  }

  async getEntity(id: string): Promise<Entity | null> {
    const rows = await this.db.query('SELECT * FROM entities WHERE id=$1', [
      id,
    ]);
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async listEntities(filter?: {
    product?: string;
    kind?: string;
  }): Promise<Entity[]> {
    const { where, args } = pgWhere({
      product: filter?.product,
      kind: filter?.kind,
    });
    const rows = await this.db.query(
      `SELECT * FROM entities ${where} ORDER BY id`,
      args,
    );
    return rows.map(rowToEntity);
  }

  async deleteEntity(id: string): Promise<void> {
    await this.db.query('DELETE FROM entities WHERE id=$1', [id]);
  }

  async upsertRelation(r: Relation): Promise<void> {
    await this.db.query(
      `INSERT INTO relations (subject, predicate, object, evidence, source,
         confidence, verification, valid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (subject, predicate, object) DO UPDATE SET
         evidence=$4, source=$5, confidence=$6, verification=$7,
         valid_at=$8`,
      [
        r.subject,
        r.predicate,
        r.object,
        r.evidence ?? null,
        r.source ?? null,
        r.confidence ?? null,
        r.verification ?? null,
        r.valid_at ?? null,
      ],
    );
  }

  async listRelations(filter?: {
    subject?: string;
    predicate?: string;
    object?: string;
  }): Promise<Relation[]> {
    const { where, args } = pgWhere({
      subject: filter?.subject,
      predicate: filter?.predicate,
      object: filter?.object,
    });
    const rows = await this.db.query(`SELECT * FROM relations ${where}`, args);
    return rows.map((r) => ({
      subject: r.subject as string,
      predicate: r.predicate as Relation['predicate'],
      object: r.object as string,
      evidence: (r.evidence as string | null) ?? undefined,
      source: (r.source as Relation['source']) ?? undefined,
      confidence: (r.confidence as number | null) ?? undefined,
      verification:
        (r.verification as Relation['verification'] | null) ?? undefined,
      valid_at: (r.valid_at as string | null) ?? undefined,
    }));
  }

  async deleteRelation(r: Relation): Promise<void> {
    await this.db.query(
      `DELETE FROM relations
       WHERE subject=$1 AND predicate=$2 AND object=$3`,
      [r.subject, r.predicate, r.object],
    );
  }

  // ---- embeddings ----

  async upsertEmbedding(e: Embedding): Promise<void> {
    const vec =
      e.vector instanceof Uint8Array
        ? e.vector
        : new Uint8Array(new Float32Array(e.vector).buffer);
    await this.db.query(
      `INSERT INTO embeddings (object_ref, model, vector)
       VALUES ($1,$2,$3)
       ON CONFLICT (object_ref, model) DO UPDATE SET vector=$3`,
      [e.object_ref, e.model, Buffer.from(vec)],
    );
  }

  async getEmbedding(key: EmbeddingKey): Promise<Embedding | null> {
    const rows = await this.db.query(
      'SELECT * FROM embeddings WHERE object_ref=$1 AND model=$2',
      [key.object_ref, key.model],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      object_ref: row.object_ref as string,
      model: row.model as string,
      vector: toU8(row.vector) as Uint8Array<ArrayBuffer>,
    };
  }

  async deleteEmbedding(key: EmbeddingKey): Promise<void> {
    await this.db.query(
      'DELETE FROM embeddings WHERE object_ref=$1 AND model=$2',
      [key.object_ref, key.model],
    );
  }

  /** App-side cosine scan (BYTEA → Float32); pgvector swap-in later. */
  async nearestEmbeddings(q: NearestQuery): Promise<NearestResult[]> {
    const query =
      q.vector instanceof Uint8Array
        ? bytesToF32(q.vector)
        : new Float32Array(q.vector);
    const rows = await this.db.query(
      'SELECT object_ref, vector FROM embeddings WHERE model=$1',
      [q.model],
    );
    const results: NearestResult[] = [];
    for (const r of rows) {
      if (!r.vector) continue;
      const v = bytesToF32(toU8(r.vector));
      if (v.length !== query.length) continue;
      results.push({
        object_ref: r.object_ref as string,
        distance: cosine(query, v),
      });
    }
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, q.limit);
  }

  // ---- projects / id allocation ----

  async upsertProject(row: ProjectRow): Promise<void> {
    await this.db.query(
      `INSERT INTO projects (workspace, org, name, next_ticket_seq,
         next_feature_seq, next_initiative_seq, next_release_seq,
         settings, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workspace) DO UPDATE SET org=$2, name=$3, settings=$8`,
      [
        row.workspace,
        row.org ?? null,
        row.name ?? null,
        row.next_ticket_seq ?? 1,
        row.next_feature_seq ?? 1,
        row.next_initiative_seq ?? 1,
        row.next_release_seq ?? 1,
        j(row.settings ?? {}),
        row.created_at ?? null,
      ],
    );
  }

  async getProject(workspace: string): Promise<ProjectRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM projects WHERE workspace=$1',
      [workspace],
    );
    return rows[0] ? rowToProject(rows[0]) : null;
  }

  async listProjects(): Promise<ProjectRow[]> {
    const rows = await this.db.query(
      'SELECT * FROM projects ORDER BY workspace',
    );
    return rows.map(rowToProject);
  }

  private async allocSeq(
    workspace: string,
    column:
      | 'next_ticket_seq'
      | 'next_feature_seq'
      | 'next_initiative_seq'
      | 'next_release_seq',
    prefix: string,
  ): Promise<string> {
    const bump = () =>
      this.db.query<{ n: number }>(
        `UPDATE projects SET ${column} = ${column} + 1
         WHERE workspace = $1 RETURNING ${column} - 1 AS n`,
        [workspace],
      );
    let rows = await bump();
    if (rows.length === 0) {
      // Self-heal a missing projects row — every sequence seeds ABOVE
      // the existing rows' high-water mark, so a workspace that
      // predates project registration never reissues an id (an
      // upsertTicket on a recycled id would silently overwrite a live
      // ticket — observed via import materializing over SR-0001).
      const seqStart = async (table: string, idCol: string, p: string) => {
        const r = await this.db.query<{ n: number }>(
          `SELECT COALESCE(
             MAX(CAST(substring(${idCol} FROM $2) AS INTEGER)), 0) + 1 AS n
           FROM ${table} WHERE workspace=$1 AND ${idCol} LIKE $3`,
          [workspace, `^${p}-(\\d+)$`, `${p}-%`],
        );
        return r[0]?.n ?? 1;
      };
      const [t, f, i, rel] = await Promise.all([
        seqStart('tickets', 'ticket_id', 'SR'),
        seqStart('features', 'feature', 'F'),
        seqStart('initiatives', 'initiative', 'I'),
        seqStart('releases', 'release_id', 'REL'),
      ]);
      await this.db.query(
        `INSERT INTO projects (workspace, name, next_ticket_seq,
           next_feature_seq, next_initiative_seq, next_release_seq,
           settings, created_at)
         VALUES ($1, $1, $2, $3, $4, $5, '{}', $6)
         ON CONFLICT (workspace) DO NOTHING`,
        [workspace, t, f, i, rel, new Date().toISOString()],
      );
      rows = await bump();
    }
    const n = rows[0]?.n;
    if (n === undefined || n === null) {
      throw new Error(
        `allocSeq: unknown workspace '${workspace}' — create the project first`,
      );
    }
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }

  allocTicketId(workspace: string): Promise<string> {
    return this.allocSeq(workspace, 'next_ticket_seq', 'SR');
  }

  allocFeatureId(workspace: string): Promise<string> {
    return this.allocSeq(workspace, 'next_feature_seq', 'F');
  }

  allocInitiativeId(workspace: string): Promise<string> {
    return this.allocSeq(workspace, 'next_initiative_seq', 'I');
  }

  allocReleaseId(workspace: string): Promise<string> {
    return this.allocSeq(workspace, 'next_release_seq', 'REL');
  }

  // ---- boards / canvas ----

  async upsertBoard(row: BoardRow): Promise<void> {
    await this.db.query(
      `INSERT INTO boards (workspace, org, board, name, board_type,
         status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace, board) DO UPDATE SET
         org=$2, name=$4, board_type=$5, status=$6`,
      [
        row.workspace,
        row.org ?? null,
        row.board,
        row.name ?? null,
        row.board_type ?? null,
        row.status ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async getBoard(workspace: string, board: string): Promise<BoardRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM boards WHERE workspace=$1 AND board=$2',
      [workspace, board],
    );
    return rows[0] ? rowToBoard(rows[0]) : null;
  }

  async listBoards(workspace: string): Promise<BoardRow[]> {
    const rows = await this.db.query(
      'SELECT * FROM boards WHERE workspace=$1 ORDER BY board',
      [workspace],
    );
    return rows.map(rowToBoard);
  }

  async deleteBoard(workspace: string, board: string): Promise<void> {
    await this.db.query('DELETE FROM boards WHERE workspace=$1 AND board=$2', [
      workspace,
      board,
    ]);
  }

  async upsertBoardItem(item: BoardItem): Promise<void> {
    const p = [
      item.id,
      item.workspace,
      item.org ?? null,
      item.board ?? null,
      item.kind,
      item.ref ?? null,
      item.title ?? null,
      item.body ?? null,
      item.x ?? null,
      item.y ?? null,
      item.w ?? null,
      item.h ?? null,
      item.zone ?? null,
      j(item.serves ?? null),
      item.status,
      item.consumed_by ?? null,
      item.note_kind ?? null,
      item.topic ?? null,
      item.importance ?? null,
      item.applies_to ? j(item.applies_to) : null,
      item.note_status ?? null,
      item.rationale ?? null,
      item.provenance ?? null,
      item.created_at ?? null,
      item.updated_at ?? null,
    ];
    await this.db.query(
      `INSERT INTO board_items (id, workspace, org, board, kind, ref,
         title, body, x, y, w, h, zone, serves, status, consumed_by,
         note_kind, topic, importance, applies_to, note_status,
         rationale, provenance, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (id) DO UPDATE SET
         org=$3, board=$4, kind=$5, ref=$6, title=$7, body=$8, x=$9,
         y=$10, w=$11, h=$12, zone=$13, serves=$14, status=$15,
         consumed_by=$16, note_kind=$17, topic=$18, importance=$19,
         applies_to=$20, note_status=$21, rationale=$22, provenance=$23,
         updated_at=$25`,
      p,
    );
  }

  async getBoardItem(id: string): Promise<BoardItem | null> {
    const rows = await this.db.query('SELECT * FROM board_items WHERE id=$1', [
      id,
    ]);
    return rows[0] ? rowToBoardItem(rows[0]) : null;
  }

  async listBoardItems(filter: {
    workspace: string;
    board?: string | null;
    kind?: string;
    status?: string;
  }): Promise<BoardItem[]> {
    const { where, args, next } = pgWhere({
      workspace: filter.workspace,
      kind: filter.kind,
      status: filter.status,
    });
    let sql = `SELECT * FROM board_items ${where}`;
    if (filter.board === null) {
      sql += `${where ? ' AND' : ' WHERE'} board IS NULL`;
    } else if (filter.board !== undefined) {
      sql += `${where ? ' AND' : ' WHERE'} board = $${next}`;
      args.push(filter.board);
    }
    sql += ' ORDER BY id';
    const rows = await this.db.query(sql, args);
    return rows.map(rowToBoardItem);
  }

  async deleteBoardItem(id: string): Promise<void> {
    await this.db.query('DELETE FROM board_items WHERE id=$1', [id]);
  }

  // ---- initiatives / features ----

  async upsertInitiative(row: InitiativeRow): Promise<void> {
    const p = [
      row.workspace,
      row.org ?? null,
      row.initiative,
      row.board ?? null,
      row.title,
      row.status,
      row.owner ?? null,
      row.priority ?? null,
      j(row.serves ?? null),
      row.provenance ?? null,
      row.created_at ?? null,
      row.updated_at ?? null,
    ];
    await this.db.query(
      `INSERT INTO initiatives (workspace, org, initiative, board, title,
         status, owner, priority, serves, provenance, created_at,
         updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace, initiative) DO UPDATE SET
         org=$2, board=$4, title=$5, status=$6, owner=$7, priority=$8,
         serves=$9, provenance=$10, updated_at=$12`,
      p,
    );
  }

  async getInitiative(
    workspace: string,
    initiative: string,
  ): Promise<InitiativeRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM initiatives WHERE workspace=$1 AND initiative=$2',
      [workspace, initiative],
    );
    return rows[0] ? rowToInitiative(rows[0]) : null;
  }

  async listInitiatives(filter?: {
    workspace?: string;
    board?: string;
    status?: string;
  }): Promise<InitiativeRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      board: filter?.board,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM initiatives ${where} ORDER BY initiative`,
      args,
    );
    return rows.map(rowToInitiative);
  }

  async upsertFeature(row: FeatureRow): Promise<void> {
    const p = [
      row.workspace,
      row.org ?? null,
      row.feature,
      row.initiative ?? null,
      row.title,
      row.status,
      row.owner ?? null,
      row.priority ?? null,
      j(row.serves ?? null),
      row.test_env ? j(row.test_env) : null,
      row.created_at ?? null,
      row.updated_at ?? null,
    ];
    await this.db.query(
      `INSERT INTO features (workspace, org, feature, initiative, title,
         status, owner, priority, serves, test_env, created_at,
         updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace, feature) DO UPDATE SET
         org=$2, initiative=$4, title=$5, status=$6, owner=$7,
         priority=$8, serves=$9, test_env=$10, updated_at=$12`,
      p,
    );
  }

  async getFeature(
    workspace: string,
    feature: string,
  ): Promise<FeatureRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM features WHERE workspace=$1 AND feature=$2',
      [workspace, feature],
    );
    return rows[0] ? rowToFeature(rows[0]) : null;
  }

  async listFeatures(filter?: {
    workspace?: string;
    initiative?: string;
    status?: string;
  }): Promise<FeatureRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      initiative: filter?.initiative,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM features ${where} ORDER BY feature`,
      args,
    );
    return rows.map(rowToFeature);
  }

  // ---- doc_versions ----

  async appendDocVersion(
    key: DocKey,
    content: string,
    edited_by: string,
  ): Promise<DocVersion> {
    return this.db.transaction(async (tx): Promise<DocVersion> => {
      // Same MAX(version)+1 race as dossiers — serialize per doc key so
      // concurrent writers land on consecutive versions instead of a
      // unique violation (DB-SCHEMA doc_versions).
      await lockKey(tx, `doc:${key.workspace}:${key.subject}:${key.doc}`);
      const rows = await tx.query<{ version: number }>(
        `INSERT INTO doc_versions (workspace, subject, doc, version,
           content, edited_by, created_at)
         SELECT $1, $2, $3,
           COALESCE((
             SELECT MAX(version) FROM doc_versions
             WHERE workspace=$1 AND subject=$2 AND doc=$3
           ), 0) + 1,
           $4, $5, $6
         RETURNING version`,
        [key.workspace, key.subject, key.doc, content, edited_by, now()],
      );
      const version = rows[0]?.version ?? 0;
      return {
        workspace: key.workspace,
        subject: key.subject,
        doc: key.doc,
        version,
        content,
        edited_by,
        created_at: now(),
      };
    });
  }

  async getDoc(key: DocKey): Promise<DocVersion | null> {
    const rows = await this.db.query(
      `SELECT * FROM doc_versions
       WHERE workspace=$1 AND subject=$2 AND doc=$3
       ORDER BY version DESC LIMIT 1`,
      [key.workspace, key.subject, key.doc],
    );
    return rows[0] ? rowToDocVersion(rows[0]) : null;
  }

  async getDocVersion(
    key: DocKey,
    version: number,
  ): Promise<DocVersion | null> {
    const rows = await this.db.query(
      `SELECT * FROM doc_versions
       WHERE workspace=$1 AND subject=$2 AND doc=$3 AND version=$4`,
      [key.workspace, key.subject, key.doc, version],
    );
    return rows[0] ? rowToDocVersion(rows[0]) : null;
  }

  async listDocVersions(key: DocKey): Promise<DocVersion[]> {
    const rows = await this.db.query(
      `SELECT * FROM doc_versions
       WHERE workspace=$1 AND subject=$2 AND doc=$3
       ORDER BY version`,
      [key.workspace, key.subject, key.doc],
    );
    return rows.map(rowToDocVersion);
  }

  async listDocs(key: {
    workspace: string;
    subject: string;
  }): Promise<DocVersion[]> {
    const rows = await this.db.query(
      `SELECT * FROM doc_versions d
       WHERE d.workspace=$1 AND d.subject=$2
         AND d.version = (
           SELECT MAX(version) FROM doc_versions d2
           WHERE d2.workspace=d.workspace AND d2.subject=d.subject
             AND d2.doc=d.doc)
       ORDER BY d.doc`,
      [key.workspace, key.subject],
    );
    return rows.map(rowToDocVersion);
  }

  // ---- run_artifacts ----

  async putArtifact(a: RunArtifact): Promise<void> {
    await this.db.query(
      `INSERT INTO run_artifacts (run_id, name, content, created_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (run_id, name) DO UPDATE SET content=$3, created_at=$4`,
      [a.run_id, a.name, a.content, a.created_at ?? now()],
    );
  }

  async getArtifact(run_id: string, name: string): Promise<RunArtifact | null> {
    const rows = await this.db.query(
      'SELECT * FROM run_artifacts WHERE run_id=$1 AND name=$2',
      [run_id, name],
    );
    return rows[0] ? rowToArtifact(rows[0]) : null;
  }

  async listArtifacts(run_id: string): Promise<RunArtifact[]> {
    const rows = await this.db.query(
      'SELECT * FROM run_artifacts WHERE run_id=$1 ORDER BY name',
      [run_id],
    );
    return rows.map(rowToArtifact);
  }

  // ---- delivery: releases (DELIVERY §3) ----

  async upsertRelease(row: ReleaseRow): Promise<void> {
    await this.db.query(
      `INSERT INTO releases (workspace, org, release_id, title, status,
         target, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workspace, release_id) DO UPDATE SET
         org=$2, title=$4, status=$5, target=$6, updated_at=$9`,
      [
        row.workspace,
        row.org ?? null,
        row.release_id,
        row.title,
        row.status,
        row.target ?? null,
        row.created_by ?? null,
        row.created_at ?? null,
        row.updated_at ?? null,
      ],
    );
  }

  async getRelease(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM releases WHERE workspace=$1 AND release_id=$2',
      [key.workspace, key.release_id],
    );
    return rows[0] ? rowToRelease(rows[0]) : null;
  }

  async listReleases(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<ReleaseRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM releases ${where} ORDER BY release_id`,
      args,
    );
    return rows.map(rowToRelease);
  }

  async upsertReleaseItem(row: ReleaseItemRow): Promise<void> {
    await this.db.query(
      `INSERT INTO release_items (workspace, org, release_id, item_kind,
         item_id, partial_ac, delivery_state, approved_by, added_by,
         added_at, removed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace, release_id, item_kind, item_id)
       DO UPDATE SET
         partial_ac=$6, delivery_state=$7, approved_by=$8,
         removed_at=$11`,
      [
        row.workspace,
        row.org ?? null,
        row.release_id,
        row.item_kind,
        row.item_id,
        row.partial_ac ? j(row.partial_ac) : null,
        row.delivery_state ?? 'planned',
        row.approved_by ?? null,
        row.added_by ?? null,
        row.added_at ?? null,
        row.removed_at ?? null,
      ],
    );
  }

  async listReleaseItems(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseItemRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM release_items
       WHERE workspace=$1 AND release_id=$2 AND removed_at IS NULL
       ORDER BY item_kind, item_id`,
      [key.workspace, key.release_id],
    );
    return rows.map(rowToReleaseItem);
  }

  async removeReleaseItem(
    key: {
      workspace: string;
      release_id: string;
      item_kind: string;
      item_id: string;
    },
    removed_at: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE release_items SET removed_at=$5
       WHERE workspace=$1 AND release_id=$2 AND item_kind=$3 AND item_id=$4`,
      [key.workspace, key.release_id, key.item_kind, key.item_id, removed_at],
    );
  }

  async appendReleaseManifest(row: ReleaseManifestRow): Promise<void> {
    await this.db.query(
      `INSERT INTO release_manifests (workspace, org, release_id, version,
         digest, items, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row.workspace,
        row.org ?? null,
        row.release_id,
        row.version,
        row.digest,
        j(row.items),
        row.created_at ?? null,
      ],
    );
  }

  async getReleaseManifest(
    key: { workspace: string; release_id: string },
    version?: number,
  ): Promise<ReleaseManifestRow | null> {
    const rows =
      version === undefined
        ? await this.db.query(
            `SELECT * FROM release_manifests
             WHERE workspace=$1 AND release_id=$2
             ORDER BY version DESC LIMIT 1`,
            [key.workspace, key.release_id],
          )
        : await this.db.query(
            `SELECT * FROM release_manifests
             WHERE workspace=$1 AND release_id=$2 AND version=$3`,
            [key.workspace, key.release_id, version],
          );
    return rows[0] ? rowToReleaseManifest(rows[0]) : null;
  }

  async listReleaseManifests(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseManifestRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM release_manifests
       WHERE workspace=$1 AND release_id=$2 ORDER BY version`,
      [key.workspace, key.release_id],
    );
    return rows.map(rowToReleaseManifest);
  }

  async appendReleaseApproval(row: ReleaseApprovalRow): Promise<void> {
    await this.db.query(
      `INSERT INTO release_approvals (workspace, org, release_id,
         manifest_version, approver, decision, rationale, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace, release_id, manifest_version, approver)
       DO NOTHING`,
      [
        row.workspace,
        row.org ?? null,
        row.release_id,
        row.manifest_version,
        row.approver,
        row.decision,
        row.rationale ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async listReleaseApprovals(key: {
    workspace: string;
    release_id: string;
    manifest_version?: number;
  }): Promise<ReleaseApprovalRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM release_approvals
       WHERE workspace=$1 AND release_id=$2
         AND ($3::int IS NULL OR manifest_version=$3)
       ORDER BY manifest_version, approver`,
      [key.workspace, key.release_id, key.manifest_version ?? null],
    );
    return rows.map(rowToReleaseApproval);
  }

  async upsertReleaseNote(row: ReleaseNoteRow): Promise<void> {
    await this.db.query(
      `INSERT INTO release_notes (workspace, org, release_id, audience,
         doc_version, approved_by, approved_at, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace, release_id, audience) DO UPDATE SET
         doc_version=$5, approved_by=$6, approved_at=$7, published_at=$8`,
      [
        row.workspace,
        row.org ?? null,
        row.release_id,
        row.audience,
        row.doc_version ?? null,
        row.approved_by ?? null,
        row.approved_at ?? null,
        row.published_at ?? null,
      ],
    );
  }

  async getReleaseNote(key: {
    workspace: string;
    release_id: string;
    audience: string;
  }): Promise<ReleaseNoteRow | null> {
    const rows = await this.db.query(
      `SELECT * FROM release_notes
       WHERE workspace=$1 AND release_id=$2 AND audience=$3`,
      [key.workspace, key.release_id, key.audience],
    );
    return rows[0] ? rowToReleaseNote(rows[0]) : null;
  }

  async listReleaseNotes(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseNoteRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM release_notes
       WHERE workspace=$1 AND release_id=$2 ORDER BY audience`,
      [key.workspace, key.release_id],
    );
    return rows.map(rowToReleaseNote);
  }

  async appendReleaseGateResult(
    row: Omit<ReleaseGateResultRow, 'id'>,
  ): Promise<number> {
    const rows = await this.db.query<{ id: number }>(
      `INSERT INTO release_gate_results (workspace, org, release_id, gate,
         result, evidence, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        row.workspace,
        row.org ?? null,
        row.release_id,
        row.gate,
        row.result,
        row.evidence ? j(row.evidence) : null,
        row.checked_at,
      ],
    );
    return Number(rows[0]?.id ?? 0);
  }

  async listReleaseGateResults(key: {
    workspace: string;
    release_id: string;
    gate?: string;
  }): Promise<ReleaseGateResultRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM release_gate_results
       WHERE workspace=$1 AND release_id=$2
         AND ($3::text IS NULL OR gate=$3)
       ORDER BY id`,
      [key.workspace, key.release_id, key.gate ?? null],
    );
    return rows.map(rowToReleaseGateResult);
  }

  async insertDeployment(row: DeploymentRow): Promise<void> {
    await this.db.query(
      `INSERT INTO deployments (workspace, org, deployment_id, release_id,
         environment, sha, evidence, confirmed_by, confirmed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.workspace,
        row.org ?? null,
        row.deployment_id,
        row.release_id,
        row.environment,
        row.sha,
        j(row.evidence),
        row.confirmed_by ?? null,
        row.confirmed_at ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async confirmDeployment(
    key: { workspace: string; deployment_id: string },
    confirmed_by: string,
    at: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE deployments SET confirmed_by=$3, confirmed_at=$4
       WHERE workspace=$1 AND deployment_id=$2`,
      [key.workspace, key.deployment_id, confirmed_by, at],
    );
  }

  async listDeployments(filter: {
    workspace: string;
    release_id?: string;
    environment?: string;
  }): Promise<DeploymentRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      release_id: filter.release_id,
      environment: filter.environment,
    });
    const rows = await this.db.query(
      `SELECT * FROM deployments ${where} ORDER BY deployment_id`,
      args,
    );
    return rows.map(rowToDeployment);
  }

  async upsertFeatureExposure(row: FeatureExposureRow): Promise<void> {
    await this.db.query(
      `INSERT INTO feature_exposure (workspace, org, feature_id,
         environment, state, audience, evidence, deployment_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workspace, feature_id, environment) DO UPDATE SET
         state=$5, audience=$6, evidence=$7, deployment_id=$8, updated_at=$9`,
      [
        row.workspace,
        row.org ?? null,
        row.feature_id,
        row.environment,
        row.state,
        row.audience ?? null,
        row.evidence ?? null,
        row.deployment_id ?? null,
        row.updated_at ?? null,
      ],
    );
  }

  async getFeatureExposure(key: {
    workspace: string;
    feature_id: string;
    environment: string;
  }): Promise<FeatureExposureRow | null> {
    const rows = await this.db.query(
      `SELECT * FROM feature_exposure
       WHERE workspace=$1 AND feature_id=$2 AND environment=$3`,
      [key.workspace, key.feature_id, key.environment],
    );
    return rows[0] ? rowToFeatureExposure(rows[0]) : null;
  }

  async listFeatureExposure(filter: {
    workspace: string;
    feature_id?: string;
    environment?: string;
  }): Promise<FeatureExposureRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      feature_id: filter.feature_id,
      environment: filter.environment,
    });
    const rows = await this.db.query(
      `SELECT * FROM feature_exposure ${where}
       ORDER BY feature_id, environment`,
      args,
    );
    return rows.map(rowToFeatureExposure);
  }

  async upsertReleaseOutcome(row: ReleaseOutcomeRow): Promise<void> {
    await this.db.query(
      `INSERT INTO release_outcomes (workspace, org, release_id, kpi,
         data, measured_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace, release_id, kpi) DO UPDATE SET
         data=$5, measured_at=$6`,
      [
        row.workspace,
        row.org ?? null,
        row.release_id,
        row.kpi,
        j(row.data),
        row.measured_at ?? null,
      ],
    );
  }

  async listReleaseOutcomes(key: {
    workspace: string;
    release_id: string;
  }): Promise<ReleaseOutcomeRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM release_outcomes
       WHERE workspace=$1 AND release_id=$2 ORDER BY kpi`,
      [key.workspace, key.release_id],
    );
    return rows.map(rowToReleaseOutcome);
  }

  // ---- changesets (PRD §15.5, wp-140) ----

  async upsertChangeset(row: ChangesetRow): Promise<void> {
    await this.db.query(
      `INSERT INTO changesets (workspace, org, changeset_id, title, request,
         baseline, classification, status, analysis, decision,
         decision_rationale, decided_by, decided_at, expires_on, emergency,
         retro_ref, reconciliation, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (workspace, changeset_id) DO UPDATE SET
         title=$4, classification=$7, status=$8, analysis=$9, decision=$10,
         decision_rationale=$11, decided_by=$12, decided_at=$13,
         expires_on=$14, emergency=$15, retro_ref=$16, reconciliation=$17,
         updated_at=$20`,
      [
        row.workspace,
        row.org ?? null,
        row.changeset_id,
        row.title ?? null,
        row.request,
        row.baseline ? j(row.baseline) : null,
        row.classification ?? null,
        row.status,
        row.analysis ? j(row.analysis) : null,
        row.decision ?? null,
        row.decision_rationale ?? null,
        row.decided_by ?? null,
        row.decided_at ?? null,
        row.expires_on ?? null,
        row.emergency ? 1 : 0,
        row.retro_ref ?? null,
        row.reconciliation ? j(row.reconciliation) : null,
        row.created_by ?? null,
        row.created_at ?? null,
        row.updated_at ?? null,
      ],
    );
  }

  async getChangeset(key: {
    workspace: string;
    changeset_id: string;
  }): Promise<ChangesetRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM changesets WHERE workspace=$1 AND changeset_id=$2',
      [key.workspace, key.changeset_id],
    );
    return rows[0] ? rowToChangeset(rows[0]) : null;
  }

  async listChangesets(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<ChangesetRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM changesets ${where} ORDER BY changeset_id`,
      args,
    );
    return rows.map(rowToChangeset);
  }

  async upsertChangesetItem(row: ChangesetItemRow): Promise<void> {
    await this.db.query(
      `INSERT INTO changeset_items (workspace, org, changeset_id, seq,
         subject, doc, base_version, proposed_version, change, status,
         applied_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace, changeset_id, seq) DO UPDATE SET
         subject=$5, doc=$6, base_version=$7, proposed_version=$8,
         change=$9, status=$10, applied_at=$11`,
      [
        row.workspace,
        row.org ?? null,
        row.changeset_id,
        row.seq,
        row.subject,
        row.doc ?? null,
        row.base_version ?? null,
        row.proposed_version ?? null,
        row.change ? j(row.change) : null,
        row.status ?? 'pending',
        row.applied_at ?? null,
      ],
    );
  }

  async listChangesetItems(key: {
    workspace: string;
    changeset_id: string;
  }): Promise<ChangesetItemRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM changeset_items
       WHERE workspace=$1 AND changeset_id=$2 ORDER BY seq`,
      [key.workspace, key.changeset_id],
    );
    return rows.map(rowToChangesetItem);
  }

  // ---- statement ledger (PRD §15.3/§15.9, wp-143) ----

  async upsertStatement(
    row: Omit<StatementRow, 'version'>,
  ): Promise<StatementRow> {
    return this.db.transaction(async (tx): Promise<StatementRow> => {
      // doc_version discipline — serialize MAX(version)+1 per statement.
      await lockKey(tx, `statement:${row.workspace}:${row.statement_id}`);
      const v = await tx.query<{ version: number }>(
        `INSERT INTO statement_versions (workspace, org, statement_id,
           version, text, source_text, source_ref, intent, polarity,
           subject, strength, scope, scope_ref, status, confidence,
           provenance, extraction_run, edited_by, created_at)
         SELECT $1,$2,$3,
           COALESCE((
             SELECT MAX(version) FROM statement_versions
             WHERE workspace=$1 AND statement_id=$3
           ), 0) + 1,
           $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
         RETURNING version`,
        [
          row.workspace,
          row.org ?? null,
          row.statement_id,
          row.text,
          row.source_text ?? null,
          row.source_ref ? j(row.source_ref) : null,
          row.intent ?? null,
          row.polarity ?? null,
          row.subject ?? null,
          row.strength ?? null,
          row.scope ?? null,
          row.scope_ref ?? null,
          row.status,
          row.confidence ?? null,
          row.provenance ?? null,
          row.extraction_run ?? null,
          row.created_by ?? null,
          row.created_at ?? now(),
        ],
      );
      const version = v[0]?.version ?? 1;
      await tx.query(
        `INSERT INTO semantic_statements (workspace, org, statement_id,
           version, text, source_text, source_ref, intent, polarity,
           subject, strength, scope, scope_ref, status, confidence,
           provenance, extraction_run, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (workspace, statement_id) DO UPDATE SET
           version=$4, text=$5, source_text=$6, source_ref=$7, intent=$8,
           polarity=$9, subject=$10, strength=$11, scope=$12,
           scope_ref=$13, status=$14, confidence=$15, provenance=$16,
           extraction_run=$17, updated_at=$20`,
        [
          row.workspace,
          row.org ?? null,
          row.statement_id,
          version,
          row.text,
          row.source_text ?? null,
          row.source_ref ? j(row.source_ref) : null,
          row.intent ?? null,
          row.polarity ?? null,
          row.subject ?? null,
          row.strength ?? null,
          row.scope ?? null,
          row.scope_ref ?? null,
          row.status,
          row.confidence ?? null,
          row.provenance ?? null,
          row.extraction_run ?? null,
          row.created_by ?? null,
          row.created_at ?? now(),
          row.updated_at ?? now(),
        ],
      );
      return { ...row, version };
    });
  }

  async getStatement(key: {
    workspace: string;
    statement_id: string;
  }): Promise<StatementRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM semantic_statements WHERE workspace=$1 AND statement_id=$2',
      [key.workspace, key.statement_id],
    );
    return rows[0] ? rowToStatement(rows[0]) : null;
  }

  async listStatements(filter?: {
    workspace?: string;
    status?: string;
    scope?: string;
    scope_ref?: string;
    intent?: string;
  }): Promise<StatementRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      status: filter?.status,
      scope: filter?.scope,
      scope_ref: filter?.scope_ref,
      intent: filter?.intent,
    });
    const rows = await this.db.query(
      `SELECT * FROM semantic_statements ${where} ORDER BY statement_id`,
      args,
    );
    return rows.map(rowToStatement);
  }

  async listStatementVersions(key: {
    workspace: string;
    statement_id: string;
  }): Promise<StatementVersionRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM statement_versions
       WHERE workspace=$1 AND statement_id=$2 ORDER BY version`,
      [key.workspace, key.statement_id],
    );
    return rows.map(rowToStatementVersion);
  }

  async upsertStatementRelation(row: StatementRelationRow): Promise<void> {
    await this.db.query(
      `INSERT INTO statement_relations (workspace, org, src, predicate,
         dst, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace, src, predicate, dst) DO NOTHING`,
      [
        row.workspace,
        row.org ?? null,
        row.src,
        row.predicate,
        row.dst,
        row.created_by ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async listStatementRelations(filter: {
    workspace: string;
    src?: string;
    dst?: string;
    predicate?: string;
  }): Promise<StatementRelationRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      src: filter.src,
      dst: filter.dst,
      predicate: filter.predicate,
    });
    const rows = await this.db.query(
      `SELECT * FROM statement_relations ${where} ORDER BY src, predicate, dst`,
      args,
    );
    return rows.map(rowToStatementRelation);
  }

  async deleteStatementRelation(key: {
    workspace: string;
    src: string;
    predicate: string;
    dst: string;
  }): Promise<void> {
    await this.db.query(
      `DELETE FROM statement_relations
       WHERE workspace=$1 AND src=$2 AND predicate=$3 AND dst=$4`,
      [key.workspace, key.src, key.predicate, key.dst],
    );
  }

  async upsertStatementClarification(
    row: StatementClarificationRow,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO statement_clarifications (workspace, org,
         clarification_id, statement_id, question, answer, asked_by,
         answered_by, created_at, answered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (workspace, clarification_id) DO UPDATE SET
         answer=$6, answered_by=$8, answered_at=$10`,
      [
        row.workspace,
        row.org ?? null,
        row.clarification_id,
        row.statement_id,
        row.question,
        row.answer ?? null,
        row.asked_by ?? null,
        row.answered_by ?? null,
        row.created_at ?? null,
        row.answered_at ?? null,
      ],
    );
  }

  async listStatementClarifications(filter: {
    workspace: string;
    statement_id?: string;
  }): Promise<StatementClarificationRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      statement_id: filter.statement_id,
    });
    const rows = await this.db.query(
      `SELECT * FROM statement_clarifications ${where}
       ORDER BY created_at, clarification_id`,
      args,
    );
    return rows.map(rowToStatementClarification);
  }

  async upsertStatementDecision(row: StatementDecisionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO statement_decisions (workspace, org, decision_id,
         statement_id, decision, status, rationale, decided_by, decided_at,
         created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace, decision_id) DO UPDATE SET
         decision=$5, status=$6, rationale=$7, decided_by=$8, decided_at=$9`,
      [
        row.workspace,
        row.org ?? null,
        row.decision_id,
        row.statement_id,
        row.decision ?? null,
        row.status,
        row.rationale ?? null,
        row.decided_by ?? null,
        row.decided_at ?? null,
        row.created_by ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async getStatementDecision(key: {
    workspace: string;
    decision_id: string;
  }): Promise<StatementDecisionRow | null> {
    const rows = await this.db.query(
      `SELECT * FROM statement_decisions
       WHERE workspace=$1 AND decision_id=$2`,
      [key.workspace, key.decision_id],
    );
    return rows[0] ? rowToStatementDecision(rows[0]) : null;
  }

  async listStatementDecisions(filter: {
    workspace: string;
    statement_id?: string;
    status?: string;
  }): Promise<StatementDecisionRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      statement_id: filter.statement_id,
      status: filter.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM statement_decisions ${where}
       ORDER BY created_at, decision_id`,
      args,
    );
    return rows.map(rowToStatementDecision);
  }

  async upsertStatementArtifactLink(
    row: StatementArtifactLinkRow,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO statement_artifact_links (workspace, org, statement_id,
         artifact, element, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace, statement_id, artifact, element)
       DO NOTHING`,
      [
        row.workspace,
        row.org ?? null,
        row.statement_id,
        row.artifact,
        row.element ?? '',
        row.created_by ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async listStatementArtifactLinks(filter: {
    workspace: string;
    statement_id?: string;
    artifact?: string;
  }): Promise<StatementArtifactLinkRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      statement_id: filter.statement_id,
      artifact: filter.artifact,
    });
    const rows = await this.db.query(
      `SELECT * FROM statement_artifact_links ${where}
       ORDER BY statement_id, artifact, element`,
      args,
    );
    return rows.map(rowToStatementArtifactLink);
  }

  async deleteStatementArtifactLink(key: {
    workspace: string;
    statement_id: string;
    artifact: string;
    element: string;
  }): Promise<void> {
    await this.db.query(
      `DELETE FROM statement_artifact_links
       WHERE workspace=$1 AND statement_id=$2 AND artifact=$3 AND element=$4`,
      [key.workspace, key.statement_id, key.artifact, key.element],
    );
  }

  async insertExtractionRun(row: ExtractionRunRow): Promise<void> {
    await this.db.query(
      `INSERT INTO semantic_extraction_runs (workspace, org,
         extraction_run_id, run, subject, model, prompt_version, stats,
         created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workspace, extraction_run_id) DO NOTHING`,
      [
        row.workspace,
        row.org ?? null,
        row.extraction_run_id,
        row.run ?? null,
        row.subject ?? null,
        row.model ?? null,
        row.prompt_version ?? null,
        row.stats ? j(row.stats) : null,
        row.created_at ?? null,
      ],
    );
  }

  async getExtractionRun(key: {
    workspace: string;
    extraction_run_id: string;
  }): Promise<ExtractionRunRow | null> {
    const rows = await this.db.query(
      `SELECT * FROM semantic_extraction_runs
       WHERE workspace=$1 AND extraction_run_id=$2`,
      [key.workspace, key.extraction_run_id],
    );
    return rows[0] ? rowToExtractionRun(rows[0]) : null;
  }

  async listExtractionRuns(filter?: {
    workspace?: string;
    subject?: string;
  }): Promise<ExtractionRunRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      subject: filter?.subject,
    });
    const rows = await this.db.query(
      `SELECT * FROM semantic_extraction_runs ${where}
       ORDER BY created_at, extraction_run_id`,
      args,
    );
    return rows.map(rowToExtractionRun);
  }

  // ---- interview orchestrator (PRD §15.9, wp-145) ----

  async upsertWizardDefinition(row: WizardDefinitionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO wizard_definitions (workspace, org, wizard_id, name,
         description, current_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace, wizard_id) DO UPDATE SET
         name=$4, description=$5, current_version=$6, updated_at=$8`,
      [
        row.workspace,
        row.org ?? null,
        row.wizard_id,
        row.name ?? null,
        row.description ?? null,
        row.current_version ?? null,
        row.created_at ?? null,
        row.updated_at ?? null,
      ],
    );
  }

  async getWizardDefinition(key: {
    workspace: string;
    wizard_id: string;
  }): Promise<WizardDefinitionRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM wizard_definitions WHERE workspace=$1 AND wizard_id=$2',
      [key.workspace, key.wizard_id],
    );
    return rows[0] ? rowToWizardDefinition(rows[0]) : null;
  }

  async appendWizardVersion(row: WizardVersionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO wizard_versions (workspace, org, wizard_id, version,
         definition, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        row.workspace,
        row.org ?? null,
        row.wizard_id,
        row.version,
        j(row.definition),
        row.created_at ?? null,
      ],
    );
  }

  async getWizardVersion(
    key: { workspace: string; wizard_id: string },
    version?: number,
  ): Promise<WizardVersionRow | null> {
    const rows =
      version === undefined
        ? await this.db.query(
            `SELECT * FROM wizard_versions
             WHERE workspace=$1 AND wizard_id=$2
             ORDER BY version DESC LIMIT 1`,
            [key.workspace, key.wizard_id],
          )
        : await this.db.query(
            `SELECT * FROM wizard_versions
             WHERE workspace=$1 AND wizard_id=$2 AND version=$3`,
            [key.workspace, key.wizard_id, version],
          );
    return rows[0] ? rowToWizardVersion(rows[0]) : null;
  }

  async listWizardVersions(key: {
    workspace: string;
    wizard_id: string;
  }): Promise<WizardVersionRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM wizard_versions
       WHERE workspace=$1 AND wizard_id=$2 ORDER BY version`,
      [key.workspace, key.wizard_id],
    );
    return rows.map(rowToWizardVersion);
  }

  async upsertInterviewSession(row: InterviewSessionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO interview_sessions (workspace, org, session_id,
         wizard_id, wizard_version, subject, mode, status, draft_ready,
         approval_ready, knowledge_version, created_by, created_at,
         updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (workspace, session_id) DO UPDATE SET
         wizard_id=$4, wizard_version=$5, subject=$6, mode=$7, status=$8,
         draft_ready=$9, approval_ready=$10, knowledge_version=$11,
         updated_at=$14`,
      [
        row.workspace,
        row.org ?? null,
        row.session_id,
        row.wizard_id ?? null,
        row.wizard_version ?? null,
        row.subject ?? null,
        row.mode ?? null,
        row.status,
        row.draft_ready ? 1 : 0,
        row.approval_ready ? 1 : 0,
        row.knowledge_version ?? null,
        row.created_by ?? null,
        row.created_at ?? null,
        row.updated_at ?? null,
      ],
    );
  }

  async getInterviewSession(key: {
    workspace: string;
    session_id: string;
  }): Promise<InterviewSessionRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM interview_sessions WHERE workspace=$1 AND session_id=$2',
      [key.workspace, key.session_id],
    );
    return rows[0] ? rowToInterviewSession(rows[0]) : null;
  }

  async listInterviewSessions(filter?: {
    workspace?: string;
    subject?: string;
    status?: string;
  }): Promise<InterviewSessionRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      subject: filter?.subject,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM interview_sessions ${where} ORDER BY created_at, session_id`,
      args,
    );
    return rows.map(rowToInterviewSession);
  }

  async upsertInterviewBranch(row: InterviewBranchRow): Promise<void> {
    await this.db.query(
      `INSERT INTO interview_branches (workspace, org, session_id, branch,
         role, status, created_at, merged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace, session_id, branch) DO UPDATE SET
         role=$5, status=$6, merged_at=$8`,
      [
        row.workspace,
        row.org ?? null,
        row.session_id,
        row.branch,
        row.role ?? null,
        row.status,
        row.created_at ?? null,
        row.merged_at ?? null,
      ],
    );
  }

  async listInterviewBranches(key: {
    workspace: string;
    session_id: string;
  }): Promise<InterviewBranchRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM interview_branches
       WHERE workspace=$1 AND session_id=$2 ORDER BY branch`,
      [key.workspace, key.session_id],
    );
    return rows.map(rowToInterviewBranch);
  }

  async appendInterviewMessage(
    row: Omit<InterviewMessageRow, 'seq'>,
  ): Promise<number> {
    return this.db.transaction(async (tx): Promise<number> => {
      // Per-session monotonic seq — serialize max+1 like doc_versions.
      await lockKey(tx, `interview:${row.workspace}:${row.session_id}`);
      const rows = await tx.query<{ seq: number }>(
        `INSERT INTO interview_messages (workspace, org, session_id, seq,
           branch, role, content, created_at)
         SELECT $1,$2,$3,
           COALESCE((
             SELECT MAX(seq) FROM interview_messages
             WHERE workspace=$1 AND session_id=$3
           ), 0) + 1,
           $4,$5,$6,$7
         RETURNING seq`,
        [
          row.workspace,
          row.org ?? null,
          row.session_id,
          row.branch ?? null,
          row.role,
          row.content,
          row.created_at ?? now(),
        ],
      );
      return rows[0]?.seq ?? 1;
    });
  }

  async listInterviewMessages(key: {
    workspace: string;
    session_id: string;
    after?: number;
  }): Promise<InterviewMessageRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM interview_messages
       WHERE workspace=$1 AND session_id=$2 AND seq > $3
       ORDER BY seq`,
      [key.workspace, key.session_id, key.after ?? 0],
    );
    return rows.map(rowToInterviewMessage);
  }

  async upsertKnowledgeSlot(row: KnowledgeSlotRow): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_slots (workspace, org, session_id, slot,
         state, value, statement_refs, confidence, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workspace, session_id, slot) DO UPDATE SET
         state=$5, value=$6, statement_refs=$7, confidence=$8,
         updated_at=$9`,
      [
        row.workspace,
        row.org ?? null,
        row.session_id,
        row.slot,
        row.state,
        row.value ?? null,
        row.statement_refs ? j(row.statement_refs) : null,
        row.confidence ?? null,
        row.updated_at ?? null,
      ],
    );
  }

  async getKnowledgeSlot(key: {
    workspace: string;
    session_id: string;
    slot: string;
  }): Promise<KnowledgeSlotRow | null> {
    const rows = await this.db.query(
      `SELECT * FROM knowledge_slots
       WHERE workspace=$1 AND session_id=$2 AND slot=$3`,
      [key.workspace, key.session_id, key.slot],
    );
    return rows[0] ? rowToKnowledgeSlot(rows[0]) : null;
  }

  async listKnowledgeSlots(key: {
    workspace: string;
    session_id: string;
    state?: string;
  }): Promise<KnowledgeSlotRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM knowledge_slots
       WHERE workspace=$1 AND session_id=$2
         AND ($3::text IS NULL OR state=$3)
       ORDER BY slot`,
      [key.workspace, key.session_id, key.state ?? null],
    );
    return rows.map(rowToKnowledgeSlot);
  }

  async upsertQuestionCandidate(row: QuestionCandidateRow): Promise<void> {
    await this.db.query(
      `INSERT INTO question_candidates (workspace, org, session_id,
         question_id, slot, question, scores, status, created_at,
         resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (workspace, session_id, question_id) DO UPDATE SET
         slot=$5, question=$6, scores=$7, status=$8, resolved_at=$10`,
      [
        row.workspace,
        row.org ?? null,
        row.session_id,
        row.question_id,
        row.slot ?? null,
        row.question,
        row.scores ? j(row.scores) : null,
        row.status,
        row.created_at ?? null,
        row.resolved_at ?? null,
      ],
    );
  }

  async listQuestionCandidates(filter: {
    workspace: string;
    session_id: string;
    status?: string;
  }): Promise<QuestionCandidateRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      session_id: filter.session_id,
      status: filter.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM question_candidates ${where}
       ORDER BY created_at, question_id`,
      args,
    );
    return rows.map(rowToQuestionCandidate);
  }

  async appendSessionSnapshot(row: SessionSnapshotRow): Promise<void> {
    await this.db.query(
      `INSERT INTO session_snapshots (workspace, org, session_id, version,
         snapshot, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row.workspace,
        row.org ?? null,
        row.session_id,
        row.version,
        j(row.snapshot),
        row.reason ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async getSessionSnapshot(
    key: { workspace: string; session_id: string },
    version?: number,
  ): Promise<SessionSnapshotRow | null> {
    const rows =
      version === undefined
        ? await this.db.query(
            `SELECT * FROM session_snapshots
             WHERE workspace=$1 AND session_id=$2
             ORDER BY version DESC LIMIT 1`,
            [key.workspace, key.session_id],
          )
        : await this.db.query(
            `SELECT * FROM session_snapshots
             WHERE workspace=$1 AND session_id=$2 AND version=$3`,
            [key.workspace, key.session_id, version],
          );
    return rows[0] ? rowToSessionSnapshot(rows[0]) : null;
  }

  async listSessionSnapshots(key: {
    workspace: string;
    session_id: string;
  }): Promise<SessionSnapshotRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM session_snapshots
       WHERE workspace=$1 AND session_id=$2 ORDER BY version`,
      [key.workspace, key.session_id],
    );
    return rows.map(rowToSessionSnapshot);
  }

  // ---- review studio (PRD §15.8, wp-148/149/150) ----

  async upsertReviewSession(row: ReviewSessionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO review_sessions (workspace, org, review_id, subject,
         status, created_by, created_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace, review_id) DO UPDATE SET
         status=$5, closed_at=$8`,
      [
        row.workspace,
        row.org ?? null,
        row.review_id,
        row.subject,
        row.status,
        row.created_by ?? null,
        row.created_at ?? null,
        row.closed_at ?? null,
      ],
    );
  }

  async getReviewSession(key: {
    workspace: string;
    review_id: string;
  }): Promise<ReviewSessionRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM review_sessions WHERE workspace=$1 AND review_id=$2',
      [key.workspace, key.review_id],
    );
    return rows[0] ? rowToReviewSession(rows[0]) : null;
  }

  async listReviewSessions(filter?: {
    workspace?: string;
    subject?: string;
    status?: string;
  }): Promise<ReviewSessionRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      subject: filter?.subject,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM review_sessions ${where}
       ORDER BY created_at, review_id`,
      args,
    );
    return rows.map(rowToReviewSession);
  }

  async appendReviewRevision(row: ReviewRevisionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO review_revisions (workspace, org, review_id, revision,
         head_sha, base_sha, baseline, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.workspace,
        row.org ?? null,
        row.review_id,
        row.revision,
        row.head_sha,
        row.base_sha ?? null,
        row.baseline ? j(row.baseline) : null,
        row.created_at ?? null,
      ],
    );
  }

  async getReviewRevision(
    key: { workspace: string; review_id: string },
    revision?: number,
  ): Promise<ReviewRevisionRow | null> {
    const rows =
      revision === undefined
        ? await this.db.query(
            `SELECT * FROM review_revisions
             WHERE workspace=$1 AND review_id=$2
             ORDER BY revision DESC LIMIT 1`,
            [key.workspace, key.review_id],
          )
        : await this.db.query(
            `SELECT * FROM review_revisions
             WHERE workspace=$1 AND review_id=$2 AND revision=$3`,
            [key.workspace, key.review_id, revision],
          );
    return rows[0] ? rowToReviewRevision(rows[0]) : null;
  }

  async listReviewRevisions(key: {
    workspace: string;
    review_id: string;
  }): Promise<ReviewRevisionRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM review_revisions
       WHERE workspace=$1 AND review_id=$2 ORDER BY revision`,
      [key.workspace, key.review_id],
    );
    return rows.map(rowToReviewRevision);
  }

  async upsertReviewFinding(row: ReviewFindingRow): Promise<void> {
    await this.db.query(
      `INSERT INTO review_findings (workspace, org, finding_id, review_id,
         revision, subject, status, severity, category, kind, thread_id,
         file, line, symbol, repo, body, evidence, suggested_fix,
         confidence, blocking, security_category, affected_asset,
         exposure, policy_violated, author, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (workspace, finding_id) DO UPDATE SET
         revision=$5, subject=$6, status=$7, severity=$8, category=$9,
         kind=$10, thread_id=$11, file=$12, line=$13, symbol=$14,
         repo=$15, body=$16, evidence=$17, suggested_fix=$18,
         confidence=$19, blocking=$20, security_category=$21,
         affected_asset=$22, exposure=$23, policy_violated=$24,
         author=$25, updated_at=$27`,
      [
        row.workspace,
        row.org ?? null,
        row.finding_id,
        row.review_id,
        row.revision ?? null,
        row.subject ?? null,
        row.status,
        row.severity ?? null,
        row.category ?? null,
        row.kind ?? null,
        row.thread_id ?? null,
        row.file ?? null,
        row.line ?? null,
        row.symbol ?? null,
        row.repo ?? null,
        row.body,
        row.evidence ?? null,
        row.suggested_fix ?? null,
        row.confidence ?? null,
        row.blocking ? 1 : 0,
        row.security_category ?? null,
        row.affected_asset ?? null,
        row.exposure ?? null,
        row.policy_violated ?? null,
        row.author ?? null,
        row.created_at ?? null,
        row.updated_at ?? null,
      ],
    );
  }

  async getReviewFinding(key: {
    workspace: string;
    finding_id: string;
  }): Promise<ReviewFindingRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM review_findings WHERE workspace=$1 AND finding_id=$2',
      [key.workspace, key.finding_id],
    );
    return rows[0] ? rowToReviewFinding(rows[0]) : null;
  }

  async listReviewFindings(filter: {
    workspace: string;
    review_id?: string;
    status?: string;
    severity?: string;
  }): Promise<ReviewFindingRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      review_id: filter.review_id,
      status: filter.status,
      severity: filter.severity,
    });
    const rows = await this.db.query(
      `SELECT * FROM review_findings ${where} ORDER BY finding_id`,
      args,
    );
    return rows.map(rowToReviewFinding);
  }

  async upsertReviewComment(row: ReviewCommentRow): Promise<void> {
    await this.db.query(
      `INSERT INTO review_comments (workspace, org, comment_id, review_id,
         revision, subject, file, line, type, disposition,
         ai_classification, body, author, changeset_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (workspace, comment_id) DO UPDATE SET
         type=$9, disposition=$10, ai_classification=$11, body=$12,
         changeset_id=$14`,
      [
        row.workspace,
        row.org ?? null,
        row.comment_id,
        row.review_id,
        row.revision ?? null,
        row.subject ?? null,
        row.file ?? null,
        row.line ?? null,
        row.type ?? null,
        row.disposition ?? null,
        row.ai_classification ? j(row.ai_classification) : null,
        row.body,
        row.author ?? null,
        row.changeset_id ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async listReviewComments(filter: {
    workspace: string;
    review_id?: string;
    subject?: string;
  }): Promise<ReviewCommentRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      review_id: filter.review_id,
      subject: filter.subject,
    });
    const rows = await this.db.query(
      `SELECT * FROM review_comments ${where}
       ORDER BY created_at, comment_id`,
      args,
    );
    return rows.map(rowToReviewComment);
  }

  async appendReviewDecision(row: ReviewDecisionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO review_decisions (workspace, org, decision_id, review_id,
         revision, reviewer, action, head_sha, baseline, rationale,
         created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace, decision_id) DO NOTHING`,
      [
        row.workspace,
        row.org ?? null,
        row.decision_id,
        row.review_id,
        row.revision ?? null,
        row.reviewer,
        row.action,
        row.head_sha,
        row.baseline ? j(row.baseline) : null,
        row.rationale ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async listReviewDecisions(key: {
    workspace: string;
    review_id: string;
  }): Promise<ReviewDecisionRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM review_decisions
       WHERE workspace=$1 AND review_id=$2
       ORDER BY created_at, decision_id`,
      [key.workspace, key.review_id],
    );
    return rows.map(rowToReviewDecision);
  }

  async appendFindingResolution(row: FindingResolutionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO finding_resolutions (workspace, org, finding_id, seq,
         status, rationale, actor, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.workspace,
        row.org ?? null,
        row.finding_id,
        row.seq,
        row.status,
        row.rationale ?? null,
        row.actor,
        row.created_at ?? now(),
      ],
    );
  }

  async listFindingResolutions(key: {
    workspace: string;
    finding_id: string;
  }): Promise<FindingResolutionRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM finding_resolutions
       WHERE workspace=$1 AND finding_id=$2 ORDER BY seq`,
      [key.workspace, key.finding_id],
    );
    return rows.map(rowToFindingResolution);
  }

  async insertReviewEvidenceLink(row: ReviewEvidenceLinkRow): Promise<void> {
    await this.db.query(
      `INSERT INTO review_evidence_links (workspace, org, review_id,
         finding_id, evidence_ref, kind, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace, review_id, finding_id, evidence_ref)
       DO NOTHING`,
      [
        row.workspace,
        row.org ?? null,
        row.review_id,
        row.finding_id,
        row.evidence_ref,
        row.kind ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async listReviewEvidenceLinks(filter: {
    workspace: string;
    review_id?: string;
    finding_id?: string;
  }): Promise<ReviewEvidenceLinkRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      review_id: filter.review_id,
      finding_id: filter.finding_id,
    });
    const rows = await this.db.query(
      `SELECT * FROM review_evidence_links ${where}
       ORDER BY review_id, finding_id, evidence_ref`,
      args,
    );
    return rows.map(rowToReviewEvidenceLink);
  }

  async deleteReviewEvidenceLink(key: {
    workspace: string;
    review_id: string;
    finding_id: string;
    evidence_ref: string;
  }): Promise<void> {
    await this.db.query(
      `DELETE FROM review_evidence_links
       WHERE workspace=$1 AND review_id=$2 AND finding_id=$3
         AND evidence_ref=$4`,
      [key.workspace, key.review_id, key.finding_id, key.evidence_ref],
    );
  }

  async upsertExternalReviewMapping(
    row: ExternalReviewMappingRow,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO external_review_mappings (workspace, org, review_id,
         finding_id, external_kind, external_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace, external_kind, external_id) DO UPDATE SET
         review_id=$3, finding_id=$4`,
      [
        row.workspace,
        row.org ?? null,
        row.review_id,
        row.finding_id ?? null,
        row.external_kind,
        row.external_id,
        row.created_at ?? null,
      ],
    );
  }

  async listExternalReviewMappings(filter: {
    workspace: string;
    review_id?: string;
    finding_id?: string;
  }): Promise<ExternalReviewMappingRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      review_id: filter.review_id,
      finding_id: filter.finding_id,
    });
    const rows = await this.db.query(
      `SELECT * FROM external_review_mappings ${where}
       ORDER BY external_kind, external_id`,
      args,
    );
    return rows.map(rowToExternalReviewMapping);
  }

  async upsertDesignApproval(row: DesignApprovalRow): Promise<void> {
    await this.db.query(
      `INSERT INTO design_approvals (workspace, org, approval_id, subject,
         doc, doc_version, checklist, covers, reviewer, rationale, status,
         created_at, invalidated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (workspace, approval_id) DO UPDATE SET
         checklist=$7, covers=$8, status=$11, invalidated_at=$13`,
      [
        row.workspace,
        row.org ?? null,
        row.approval_id,
        row.subject,
        row.doc,
        row.doc_version,
        row.checklist ? j(row.checklist) : null,
        row.covers ? j(row.covers) : null,
        row.reviewer,
        row.rationale ?? null,
        row.status,
        row.created_at ?? null,
        row.invalidated_at ?? null,
      ],
    );
  }

  async getDesignApproval(key: {
    workspace: string;
    approval_id: string;
  }): Promise<DesignApprovalRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM design_approvals WHERE workspace=$1 AND approval_id=$2',
      [key.workspace, key.approval_id],
    );
    return rows[0] ? rowToDesignApproval(rows[0]) : null;
  }

  async listDesignApprovals(filter: {
    workspace: string;
    subject?: string;
    status?: string;
  }): Promise<DesignApprovalRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      subject: filter.subject,
      status: filter.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM design_approvals ${where}
       ORDER BY created_at, approval_id`,
      args,
    );
    return rows.map(rowToDesignApproval);
  }

  // ---- process machinery (PRD §15.10, wp-153) ----

  async upsertAssumption(row: AssumptionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO assumptions (workspace, org, assumption_id, subject,
         statement, impact, impact_if_false, evidence_needed, affected,
         status, owner, source, created_at, updated_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (workspace, assumption_id) DO UPDATE SET
         subject=$4, statement=$5, impact=$6, impact_if_false=$7,
         evidence_needed=$8, affected=$9, status=$10, owner=$11,
         source=$12, updated_at=$14, resolved_at=$15`,
      [
        row.workspace,
        row.org ?? null,
        row.assumption_id,
        row.subject ?? null,
        row.statement,
        row.impact ?? null,
        row.impact_if_false ?? null,
        row.evidence_needed ?? null,
        row.affected ? j(row.affected) : null,
        row.status,
        row.owner ?? null,
        row.source ?? null,
        row.created_at ?? null,
        row.updated_at ?? null,
        row.resolved_at ?? null,
      ],
    );
  }

  async getAssumption(key: {
    workspace: string;
    assumption_id: string;
  }): Promise<AssumptionRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM assumptions WHERE workspace=$1 AND assumption_id=$2',
      [key.workspace, key.assumption_id],
    );
    return rows[0] ? rowToAssumption(rows[0]) : null;
  }

  async listAssumptions(filter?: {
    workspace?: string;
    subject?: string;
    status?: string;
  }): Promise<AssumptionRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      subject: filter?.subject,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM assumptions ${where}
       ORDER BY created_at, assumption_id`,
      args,
    );
    return rows.map(rowToAssumption);
  }

  async upsertQualityDebt(row: QualityDebtRow): Promise<void> {
    await this.db.query(
      `INSERT INTO quality_debt (workspace, org, debt_id, subject, kind,
         title, body, owner, revisit, expires_at, approved_by, approved_at,
         consolidated_into, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (workspace, debt_id) DO UPDATE SET
         subject=$4, kind=$5, title=$6, body=$7, owner=$8, revisit=$9,
         expires_at=$10, approved_by=$11, approved_at=$12,
         consolidated_into=$13, status=$14, updated_at=$16`,
      [
        row.workspace,
        row.org ?? null,
        row.debt_id,
        row.subject ?? null,
        row.kind,
        row.title,
        row.body ?? null,
        row.owner ?? null,
        row.revisit ?? null,
        row.expires_at ?? null,
        row.approved_by ?? null,
        row.approved_at ?? null,
        row.consolidated_into ?? null,
        row.status,
        row.created_at ?? null,
        row.updated_at ?? null,
      ],
    );
  }

  async getQualityDebt(key: {
    workspace: string;
    debt_id: string;
  }): Promise<QualityDebtRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM quality_debt WHERE workspace=$1 AND debt_id=$2',
      [key.workspace, key.debt_id],
    );
    return rows[0] ? rowToQualityDebt(rows[0]) : null;
  }

  async listQualityDebt(filter?: {
    workspace?: string;
    status?: string;
    kind?: string;
  }): Promise<QualityDebtRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      status: filter?.status,
      kind: filter?.kind,
    });
    const rows = await this.db.query(
      `SELECT * FROM quality_debt ${where} ORDER BY created_at, debt_id`,
      args,
    );
    return rows.map(rowToQualityDebt);
  }

  async commitDeliveryCommitment(
    row: Omit<DeliveryCommitmentRow, 'version'>,
  ): Promise<DeliveryCommitmentRow> {
    return this.db.transaction(async (tx): Promise<DeliveryCommitmentRow> => {
      // Versioned committed scope — max(version)+1 per commitment.
      await lockKey(tx, `commitment:${row.workspace}:${row.commitment_id}`);
      const rows = await tx.query<{ version: number }>(
        `INSERT INTO delivery_commitments (workspace, org, commitment_id,
           version, scope, target, success_criteria, exclusions,
           assumptions, owner, status, created_by, created_at)
         SELECT $1,$2,$3,
           COALESCE((
             SELECT MAX(version) FROM delivery_commitments
             WHERE workspace=$1 AND commitment_id=$3
           ), 0) + 1,
           $4,$5,$6,$7,$8,$9,$10,$11,$12
         RETURNING version`,
        [
          row.workspace,
          row.org ?? null,
          row.commitment_id,
          j(row.scope),
          row.target ?? null,
          row.success_criteria ?? null,
          row.exclusions ?? null,
          row.assumptions ?? null,
          row.owner ?? null,
          row.status,
          row.created_by ?? null,
          row.created_at ?? now(),
        ],
      );
      const version = rows[0]?.version ?? 1;
      return { ...row, version };
    });
  }

  async getDeliveryCommitment(
    key: { workspace: string; commitment_id: string },
    version?: number,
  ): Promise<DeliveryCommitmentRow | null> {
    const rows =
      version === undefined
        ? await this.db.query(
            `SELECT * FROM delivery_commitments
             WHERE workspace=$1 AND commitment_id=$2
             ORDER BY version DESC LIMIT 1`,
            [key.workspace, key.commitment_id],
          )
        : await this.db.query(
            `SELECT * FROM delivery_commitments
             WHERE workspace=$1 AND commitment_id=$2 AND version=$3`,
            [key.workspace, key.commitment_id, version],
          );
    return rows[0] ? rowToDeliveryCommitment(rows[0]) : null;
  }

  async listDeliveryCommitments(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<DeliveryCommitmentRow[]> {
    // Head rows (max version per commitment) — status filter applies
    // to the head, not history.
    const rows = await this.db.query(
      `SELECT d.* FROM delivery_commitments d
       WHERE d.workspace=$1
         AND d.version = (
           SELECT MAX(version) FROM delivery_commitments d2
           WHERE d2.workspace=d.workspace
             AND d2.commitment_id=d.commitment_id)
         AND ($2::text IS NULL OR d.status=$2)
       ORDER BY d.commitment_id`,
      [filter?.workspace ?? '', filter?.status ?? null],
    );
    return rows.map(rowToDeliveryCommitment);
  }

  async listDeliveryCommitmentVersions(key: {
    workspace: string;
    commitment_id: string;
  }): Promise<DeliveryCommitmentRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM delivery_commitments
       WHERE workspace=$1 AND commitment_id=$2 ORDER BY version`,
      [key.workspace, key.commitment_id],
    );
    return rows.map(rowToDeliveryCommitment);
  }

  // ---- eval lab (PRD §15.12, wp-156) ----

  async upsertEvalRun(row: EvalRunRow): Promise<void> {
    await this.db.query(
      `INSERT INTO eval_runs (workspace, org, eval_run_id, family, model,
         prompt_version, policy_version, status, metrics, created_by,
         created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace, eval_run_id) DO UPDATE SET
         status=$8, metrics=$9, completed_at=$12`,
      [
        row.workspace,
        row.org ?? null,
        row.eval_run_id,
        row.family,
        row.model ?? null,
        row.prompt_version ?? null,
        row.policy_version ?? null,
        row.status,
        row.metrics ? j(row.metrics) : null,
        row.created_by ?? null,
        row.created_at ?? null,
        row.completed_at ?? null,
      ],
    );
  }

  async getEvalRun(key: {
    workspace: string;
    eval_run_id: string;
  }): Promise<EvalRunRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM eval_runs WHERE workspace=$1 AND eval_run_id=$2',
      [key.workspace, key.eval_run_id],
    );
    return rows[0] ? rowToEvalRun(rows[0]) : null;
  }

  async listEvalRuns(filter?: {
    workspace?: string;
    family?: string;
    status?: string;
  }): Promise<EvalRunRow[]> {
    const { where, args } = pgWhere({
      workspace: filter?.workspace,
      family: filter?.family,
      status: filter?.status,
    });
    const rows = await this.db.query(
      `SELECT * FROM eval_runs ${where} ORDER BY created_at, eval_run_id`,
      args,
    );
    return rows.map(rowToEvalRun);
  }

  async upsertEvalCase(row: EvalCaseRow): Promise<void> {
    await this.db.query(
      `INSERT INTO eval_cases (workspace, org, family, case_id, input,
         expected, tags, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace, family, case_id) DO UPDATE SET
         input=$5, expected=$6, tags=$7`,
      [
        row.workspace,
        row.org ?? null,
        row.family,
        row.case_id,
        j(row.input),
        j(row.expected),
        row.tags ? j(row.tags) : null,
        row.created_at ?? null,
      ],
    );
  }

  async listEvalCases(filter: {
    workspace: string;
    family?: string;
  }): Promise<EvalCaseRow[]> {
    const { where, args } = pgWhere({
      workspace: filter.workspace,
      family: filter.family,
    });
    const rows = await this.db.query(
      `SELECT * FROM eval_cases ${where} ORDER BY family, case_id`,
      args,
    );
    return rows.map(rowToEvalCase);
  }

  async appendEvalResult(row: EvalResultRow): Promise<void> {
    await this.db.query(
      `INSERT INTO eval_results (workspace, org, eval_run_id, family,
         case_id, verdict, scores, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.workspace,
        row.org ?? null,
        row.eval_run_id,
        row.family,
        row.case_id,
        row.verdict,
        row.scores ? j(row.scores) : null,
        row.detail ?? null,
        row.created_at ?? null,
      ],
    );
  }

  async listEvalResults(key: {
    workspace: string;
    eval_run_id: string;
  }): Promise<EvalResultRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM eval_results
       WHERE workspace=$1 AND eval_run_id=$2 ORDER BY family, case_id`,
      [key.workspace, key.eval_run_id],
    );
    return rows.map(rowToEvalResult);
  }
}

// ---------- shared row helpers ----------

/**
 * Transaction-scoped advisory lock on an arbitrary string key —
 * `pg_advisory_xact_lock` auto-releases at commit/rollback and blocks
 * other transactions touching the same key. Used to serialize
 * MAX(version)+1 writers (doc_versions, dossiers) and any future
 * per-key mutation sequence under READ COMMITTED.
 */
async function lockKey(tx: PgClient, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    key,
  ]);
}

async function getLeaseRow(q: PgClient, key: LeaseKey): Promise<Lease | null> {
  const rows = await q.query(
    `SELECT * FROM leases
     WHERE workspace=$1 AND subject=$2 AND stage=$3 AND attempt=$4`,
    [key.workspace, key.subject, key.stage, key.attempt],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    workspace: row.workspace as string,
    subject: row.subject as string,
    stage: row.stage as string,
    attempt: row.attempt as number,
    holder: row.holder as string,
    acquired_at: row.acquired_at as string,
    ttl_s: row.ttl_s as number,
    heartbeat_at: (row.heartbeat_at as string | null) ?? null,
  };
}

async function deleteLease(q: PgClient, key: LeaseKey): Promise<void> {
  await q.query(
    `DELETE FROM leases
     WHERE workspace=$1 AND subject=$2 AND stage=$3 AND attempt=$4`,
    [key.workspace, key.subject, key.stage, key.attempt],
  );
}

async function getClaimRow(q: PgClient, key: ClaimKey): Promise<Claim | null> {
  const rows = await q.query(
    `SELECT * FROM claims
     WHERE workspace=$1 AND subject=$2 AND gate=$3`,
    [key.workspace, key.subject, key.gate],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    workspace: row.workspace as string,
    subject: row.subject as string,
    gate: row.gate as string,
    claimed_by: row.claimed_by as string,
    claimed_at: row.claimed_at as string,
    ttl_s: row.ttl_s as number,
  };
}

async function insertNotificationRow(
  q: PgClient,
  n: Omit<Notification, 'id'>,
): Promise<number> {
  const rows = await q.query<{ id: number }>(
    `INSERT INTO notifications (workspace, subject, kind, payload,
       created_at, read_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      n.workspace,
      n.subject,
      n.kind,
      n.payload ?? null,
      n.created_at,
      n.read_at ?? null,
    ],
  );
  return Number(rows[0]?.id ?? 0);
}

function runParam(run: Partial<RunRow> & { id?: string }, col: string) {
  const v = (run as Record<string, unknown>)[col];
  if (col === 'request') return v ? JSON.stringify(v) : null;
  return v ?? null;
}

function rowToRun(row: Row): RunRow {
  const r: Record<string, unknown> = { id: row.id };
  for (const c of RUN_COLUMNS) r[c] = row[c] ?? null;
  r.request = row.request ? unj(row.request, null) : null;
  return r as unknown as RunRow;
}

function rowToContainer(row: Row): ContainerRow {
  return {
    workspace: row.workspace as string,
    subject: row.subject as string,
    container_id: row.container_id as string,
    image: (row.image as string | null) ?? null,
    state: row.state as ContainerRow['state'],
    created_at: (row.created_at as string | null) ?? null,
    stopped_at: (row.stopped_at as string | null) ?? null,
  };
}

function rowToTicket(row: Row): TicketRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    ticket_id: row.ticket_id as string,
    feature: (row.feature as string | null) ?? null,
    title: row.title as string,
    status: row.status as TicketRow['status'],
    priority: row.priority as TicketRow['priority'],
    depth: (row.depth as TicketRow['depth']) ?? null,
    backend: (row.backend as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    repos: unj(row.repos, []),
    parent: (row.parent as string | null) ?? null,
    depends_on: unj(row.depends_on, []),
    serves: unj(row.serves, null),
    source: (row.source as string | null) ?? null,
    work_type: (row.work_type as TicketRow['work_type']) ?? null,
    origin: (row.origin as TicketRow['origin']) ?? null,
    severity: (row.severity as TicketRow['severity']) ?? null,
    execution_readiness:
      (row.execution_readiness as TicketRow['execution_readiness']) ?? null,
    parallel_safety:
      (row.parallel_safety as TicketRow['parallel_safety']) ?? null,
    source_ref: unj(row.source_ref, null),
    test_env: unj(row.test_env, null),
    forced: Boolean(row.forced),
    spec_score: (row.spec_score as number | null) ?? null,
    spec_hash: (row.spec_hash as string | null) ?? null,
    blocked_reason: (row.blocked_reason as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: row.updated_at as string,
  };
}

function rowToTicketRepo(row: Row): TicketRepoRow {
  return {
    workspace: row.workspace as string,
    ticket_id: row.ticket_id as string,
    repo: row.repo as string,
    branch: (row.branch as string | null) ?? null,
    worktree: (row.worktree as string | null) ?? null,
    pr_url: (row.pr_url as string | null) ?? null,
    pr_state: (row.pr_state as TicketRepoRow['pr_state']) ?? null,
    ci_state: (row.ci_state as TicketRepoRow['ci_state']) ?? null,
    merged_sha: (row.merged_sha as string | null) ?? null,
  };
}

function rowToEvent(row: Row): EventRow {
  return {
    seq: Number(row.seq),
    workspace: row.workspace as string,
    ticket_id: (row.ticket_id as string | null) ?? null,
    ts: row.ts as string,
    stage: (row.stage as string | null) ?? null,
    actor_type: row.actor_type as EventRow['actor_type'],
    actor_id: row.actor_id as string,
    event: row.event as EventRow['event'],
    run: (row.run as string | null) ?? null,
    refs: unj(row.refs, []),
    data: unj(row.data, {}),
    cost_usd: (row.cost_usd as number | null) ?? null,
    tokens_in: (row.tokens_in as number | null) ?? null,
    tokens_out: (row.tokens_out as number | null) ?? null,
    tokens_cached: (row.tokens_cached as number | null) ?? null,
    usage_source: (row.usage_source as EventRow['usage_source']) ?? null,
    duration_s: (row.duration_s as number | null) ?? null,
    human_minutes: (row.human_minutes as number | null) ?? null,
  };
}

function rowToGateItem(row: Row): GateItem {
  return {
    workspace: row.workspace as string,
    subject: row.subject as string,
    gate: row.gate as string,
    kind: row.kind as GateItem['kind'],
    surfaced_at: row.surfaced_at as string,
    cleared_at: (row.cleared_at as string | null) ?? null,
    snoozed_until: (row.snoozed_until as string | null) ?? null,
    blocked_agent: Boolean(row.blocked_agent),
    priority: (row.priority as GateItem['priority']) ?? null,
  };
}

function rowToNotification(row: Row): Notification {
  return {
    id: Number(row.id),
    workspace: row.workspace as string,
    subject: row.subject as string,
    kind: row.kind as string,
    payload: (row.payload as string | null) ?? null,
    created_at: row.created_at as string,
    read_at: (row.read_at as string | null) ?? null,
  };
}

function rowToDossier(row: Row): DossierEntry {
  return {
    scope: row.scope as DossierEntry['scope'],
    name: row.name as string,
    section: row.section as DossierEntry['section'],
    version: row.version as number,
    content: row.content as string,
    surveyed_at: row.surveyed_at as string,
    sources_used: ((row.sources_used as string | null) ?? '')
      .split(',')
      .filter(Boolean) as DossierEntry['sources_used'],
    stale: Boolean(row.stale),
    edited_by: (row.edited_by as string | null) ?? null,
    edited_at: (row.edited_at as string | null) ?? null,
  };
}

function rowToEntity(row: Row): Entity {
  return {
    id: row.id as string,
    product: row.product as string,
    kind: row.kind as Entity['kind'],
    name: row.name as string,
    canonical: row.canonical as string,
    aliases: unj(row.aliases, []),
    source: row.source as Entity['source'],
    evidence: (row.evidence as string | null) ?? undefined,
  };
}

function rowToProject(row: Row): ProjectRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    next_ticket_seq: (row.next_ticket_seq as number) ?? 1,
    next_feature_seq: (row.next_feature_seq as number) ?? 1,
    next_initiative_seq: (row.next_initiative_seq as number) ?? 1,
    next_release_seq: (row.next_release_seq as number) ?? 1,
    settings: unj(row.settings, {}),
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToBoard(row: Row): BoardRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    board: row.board as string,
    name: (row.name as string | null) ?? null,
    board_type: (row.board_type as BoardRow['board_type']) ?? null,
    status: (row.status as BoardRow['status']) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToBoardItem(row: Row): BoardItem {
  return {
    id: row.id as string,
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    board: (row.board as string | null) ?? null,
    kind: row.kind as BoardItem['kind'],
    ref: (row.ref as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    x: (row.x as number | null) ?? null,
    y: (row.y as number | null) ?? null,
    w: (row.w as number | null) ?? null,
    h: (row.h as number | null) ?? null,
    zone: (row.zone as string | null) ?? null,
    serves: unj(row.serves, null),
    status: row.status as BoardItem['status'],
    consumed_by: (row.consumed_by as string | null) ?? null,
    note_kind: (row.note_kind as BoardItem['note_kind']) ?? null,
    topic: (row.topic as string | null) ?? null,
    importance: (row.importance as BoardItem['importance']) ?? null,
    applies_to: unj(row.applies_to, null),
    note_status: (row.note_status as BoardItem['note_status']) ?? null,
    rationale: (row.rationale as string | null) ?? null,
    provenance: (row.provenance as BoardItem['provenance']) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToInitiative(row: Row): InitiativeRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    initiative: row.initiative as string,
    board: (row.board as string | null) ?? null,
    title: row.title as string,
    status: row.status as InitiativeRow['status'],
    owner: (row.owner as string | null) ?? null,
    priority: (row.priority as InitiativeRow['priority']) ?? null,
    serves: unj(row.serves, null),
    provenance: (row.provenance as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToFeature(row: Row): FeatureRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    feature: row.feature as string,
    initiative: (row.initiative as string | null) ?? null,
    title: row.title as string,
    status: row.status as FeatureRow['status'],
    owner: (row.owner as string | null) ?? null,
    priority: (row.priority as FeatureRow['priority']) ?? null,
    serves: unj(row.serves, null),
    test_env: unj(row.test_env, null),
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToDocVersion(row: Row): DocVersion {
  return {
    workspace: row.workspace as string,
    subject: row.subject as string,
    doc: row.doc as DocVersion['doc'],
    version: row.version as number,
    content: row.content as string,
    edited_by: (row.edited_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToArtifact(row: Row): RunArtifact {
  return {
    run_id: row.run_id as string,
    name: row.name as string,
    content: row.content as string,
    created_at: (row.created_at as string | null) ?? null,
  };
}

// ---------- delivery mappers (DELIVERY §3) ----------

function rowToRelease(row: Row): ReleaseRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    release_id: row.release_id as string,
    title: row.title as string,
    status: row.status as ReleaseRow['status'],
    target: (row.target as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToReleaseItem(row: Row): ReleaseItemRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    release_id: row.release_id as string,
    item_kind: row.item_kind as ReleaseItemRow['item_kind'],
    item_id: row.item_id as string,
    partial_ac: unj<string[] | null>(row.partial_ac, null),
    delivery_state:
      (row.delivery_state as ReleaseItemRow['delivery_state'] | null) ??
      'planned',
    approved_by: (row.approved_by as string | null) ?? null,
    added_by: (row.added_by as string | null) ?? null,
    added_at: (row.added_at as string | null) ?? null,
    removed_at: (row.removed_at as string | null) ?? null,
  };
}

function rowToReleaseManifest(row: Row): ReleaseManifestRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    release_id: row.release_id as string,
    version: row.version as number,
    digest: row.digest as string,
    items: unj<ReleaseManifestRow['items']>(row.items, []),
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToReleaseApproval(row: Row): ReleaseApprovalRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    release_id: row.release_id as string,
    manifest_version: row.manifest_version as number,
    approver: row.approver as string,
    decision: row.decision as ReleaseApprovalRow['decision'],
    rationale: (row.rationale as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToReleaseNote(row: Row): ReleaseNoteRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    release_id: row.release_id as string,
    audience: row.audience as ReleaseNoteRow['audience'],
    doc_version: (row.doc_version as number | null) ?? null,
    approved_by: (row.approved_by as string | null) ?? null,
    approved_at: (row.approved_at as string | null) ?? null,
    published_at: (row.published_at as string | null) ?? null,
  };
}

function rowToReleaseGateResult(row: Row): ReleaseGateResultRow {
  return {
    id: row.id as number,
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    release_id: row.release_id as string,
    gate: row.gate as string,
    result: row.result as ReleaseGateResultRow['result'],
    evidence: unj<ReleaseGateResultRow['evidence']>(row.evidence, null),
    checked_at: row.checked_at as string,
  };
}

function rowToDeployment(row: Row): DeploymentRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    deployment_id: row.deployment_id as string,
    release_id: row.release_id as string,
    environment: row.environment as string,
    sha: row.sha as string,
    evidence: unj<DeploymentRow['evidence']>(row.evidence, {
      type: 'manual',
    }) as DeploymentRow['evidence'],
    confirmed_by: (row.confirmed_by as string | null) ?? null,
    confirmed_at: (row.confirmed_at as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToFeatureExposure(row: Row): FeatureExposureRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    feature_id: row.feature_id as string,
    environment: row.environment as string,
    state: row.state as FeatureExposureRow['state'],
    audience: (row.audience as string | null) ?? null,
    evidence: (row.evidence as string | null) ?? null,
    deployment_id: (row.deployment_id as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToReleaseOutcome(row: Row): ReleaseOutcomeRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    release_id: row.release_id as string,
    kpi: row.kpi as string,
    data: unj<ReleaseOutcomeRow['data']>(row.data, {}),
    measured_at: (row.measured_at as string | null) ?? null,
  };
}

function rowToChangeset(row: Row): ChangesetRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    changeset_id: row.changeset_id as string,
    title: (row.title as string | null) ?? null,
    request: row.request as string,
    baseline: unj<ChangesetRow['baseline']>(row.baseline, null),
    classification:
      (row.classification as ChangesetRow['classification'] | null) ?? null,
    status: row.status as ChangesetRow['status'],
    analysis: unj<ChangesetRow['analysis']>(row.analysis, null),
    decision: (row.decision as ChangesetRow['decision'] | null) ?? null,
    decision_rationale: (row.decision_rationale as string | null) ?? null,
    decided_by: (row.decided_by as string | null) ?? null,
    decided_at: (row.decided_at as string | null) ?? null,
    expires_on: (row.expires_on as string | null) ?? null,
    emergency: row.emergency === 1 || row.emergency === true,
    retro_ref: (row.retro_ref as string | null) ?? null,
    reconciliation: unj<ChangesetRow['reconciliation']>(
      row.reconciliation,
      null,
    ),
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToChangesetItem(row: Row): ChangesetItemRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    changeset_id: row.changeset_id as string,
    seq: row.seq as number,
    subject: row.subject as string,
    doc: (row.doc as string | null) ?? null,
    base_version: (row.base_version as number | null) ?? null,
    proposed_version: (row.proposed_version as number | null) ?? null,
    change: unj<ChangesetItemRow['change']>(row.change, null),
    status: (row.status as ChangesetItemRow['status'] | null) ?? 'pending',
    applied_at: (row.applied_at as string | null) ?? null,
  };
}

function stmtFields(row: Row) {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    statement_id: row.statement_id as string,
    version: row.version as number,
    text: row.text as string,
    source_text: (row.source_text as string | null) ?? null,
    source_ref: unj<StatementRow['source_ref']>(row.source_ref, null),
    intent: (row.intent as StatementRow['intent'] | null) ?? null,
    polarity: (row.polarity as StatementRow['polarity'] | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    strength: (row.strength as StatementRow['strength'] | null) ?? null,
    scope: (row.scope as StatementRow['scope'] | null) ?? null,
    scope_ref: (row.scope_ref as string | null) ?? null,
    status: row.status as StatementRow['status'],
    confidence: (row.confidence as number | null) ?? null,
    provenance: (row.provenance as StatementRow['provenance'] | null) ?? null,
    extraction_run: (row.extraction_run as string | null) ?? null,
  };
}

function rowToStatement(row: Row): StatementRow {
  return {
    ...stmtFields(row),
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToStatementVersion(row: Row): StatementVersionRow {
  return {
    ...stmtFields(row),
    edited_by: (row.edited_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToStatementRelation(row: Row): StatementRelationRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    src: row.src as string,
    predicate: row.predicate as StatementRelationRow['predicate'],
    dst: row.dst as string,
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToStatementClarification(row: Row): StatementClarificationRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    clarification_id: row.clarification_id as string,
    statement_id: row.statement_id as string,
    question: row.question as string,
    answer: (row.answer as string | null) ?? null,
    asked_by: (row.asked_by as string | null) ?? null,
    answered_by: (row.answered_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    answered_at: (row.answered_at as string | null) ?? null,
  };
}

function rowToStatementDecision(row: Row): StatementDecisionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    decision_id: row.decision_id as string,
    statement_id: row.statement_id as string,
    decision: (row.decision as string | null) ?? null,
    status: row.status as StatementDecisionRow['status'],
    rationale: (row.rationale as string | null) ?? null,
    decided_by: (row.decided_by as string | null) ?? null,
    decided_at: (row.decided_at as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToStatementArtifactLink(row: Row): StatementArtifactLinkRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    statement_id: row.statement_id as string,
    artifact: row.artifact as string,
    element: (row.element as string | null) ?? '',
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToExtractionRun(row: Row): ExtractionRunRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    extraction_run_id: row.extraction_run_id as string,
    run: (row.run as string | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    prompt_version: (row.prompt_version as string | null) ?? null,
    stats: unj<ExtractionRunRow['stats']>(row.stats, null),
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToWizardDefinition(row: Row): WizardDefinitionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    wizard_id: row.wizard_id as string,
    name: (row.name as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    current_version: (row.current_version as number | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToWizardVersion(row: Row): WizardVersionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    wizard_id: row.wizard_id as string,
    version: row.version as number,
    definition: unj<WizardVersionRow['definition']>(row.definition, {}),
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToInterviewSession(row: Row): InterviewSessionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    session_id: row.session_id as string,
    wizard_id: (row.wizard_id as string | null) ?? null,
    wizard_version: (row.wizard_version as number | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    mode: (row.mode as InterviewSessionRow['mode'] | null) ?? null,
    status: row.status as InterviewSessionRow['status'],
    draft_ready: row.draft_ready === 1 || row.draft_ready === true,
    approval_ready: row.approval_ready === 1 || row.approval_ready === true,
    knowledge_version: (row.knowledge_version as number | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToInterviewBranch(row: Row): InterviewBranchRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    session_id: row.session_id as string,
    branch: row.branch as string,
    role: (row.role as string | null) ?? null,
    status: row.status as InterviewBranchRow['status'],
    created_at: (row.created_at as string | null) ?? null,
    merged_at: (row.merged_at as string | null) ?? null,
  };
}

function rowToInterviewMessage(row: Row): InterviewMessageRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    session_id: row.session_id as string,
    seq: row.seq as number,
    branch: (row.branch as string | null) ?? null,
    role: row.role as InterviewMessageRow['role'],
    content: row.content as string,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToKnowledgeSlot(row: Row): KnowledgeSlotRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    session_id: row.session_id as string,
    slot: row.slot as string,
    state: row.state as KnowledgeSlotRow['state'],
    value: (row.value as string | null) ?? null,
    statement_refs: unj<KnowledgeSlotRow['statement_refs']>(
      row.statement_refs,
      null,
    ),
    confidence: (row.confidence as number | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToQuestionCandidate(row: Row): QuestionCandidateRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    session_id: row.session_id as string,
    question_id: row.question_id as string,
    slot: (row.slot as string | null) ?? null,
    question: row.question as string,
    scores: unj<QuestionCandidateRow['scores']>(row.scores, null),
    status: row.status as QuestionCandidateRow['status'],
    created_at: (row.created_at as string | null) ?? null,
    resolved_at: (row.resolved_at as string | null) ?? null,
  };
}

function rowToSessionSnapshot(row: Row): SessionSnapshotRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    session_id: row.session_id as string,
    version: row.version as number,
    snapshot: unj<SessionSnapshotRow['snapshot']>(row.snapshot, {}),
    reason: (row.reason as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToReviewSession(row: Row): ReviewSessionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    review_id: row.review_id as string,
    subject: row.subject as string,
    status: row.status as ReviewSessionRow['status'],
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    closed_at: (row.closed_at as string | null) ?? null,
  };
}

function rowToReviewRevision(row: Row): ReviewRevisionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    review_id: row.review_id as string,
    revision: row.revision as number,
    head_sha: row.head_sha as string,
    base_sha: (row.base_sha as string | null) ?? null,
    baseline: unj<ReviewRevisionRow['baseline']>(row.baseline, null),
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToReviewFinding(row: Row): ReviewFindingRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    finding_id: row.finding_id as string,
    review_id: row.review_id as string,
    revision: (row.revision as number | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    status: row.status as ReviewFindingRow['status'],
    severity: (row.severity as ReviewFindingRow['severity'] | null) ?? null,
    category: (row.category as ReviewFindingRow['category'] | null) ?? null,
    kind: (row.kind as ReviewFindingRow['kind'] | null) ?? null,
    thread_id: (row.thread_id as string | null) ?? null,
    file: (row.file as string | null) ?? null,
    line: (row.line as number | null) ?? null,
    symbol: (row.symbol as string | null) ?? null,
    repo: (row.repo as string | null) ?? null,
    body: row.body as string,
    evidence: (row.evidence as string | null) ?? null,
    suggested_fix: (row.suggested_fix as string | null) ?? null,
    confidence: (row.confidence as number | null) ?? null,
    blocking: row.blocking === 1 || row.blocking === true,
    security_category:
      (row.security_category as ReviewFindingRow['security_category'] | null) ??
      null,
    affected_asset: (row.affected_asset as string | null) ?? null,
    exposure: (row.exposure as string | null) ?? null,
    policy_violated: (row.policy_violated as string | null) ?? null,
    author: (row.author as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToReviewComment(row: Row): ReviewCommentRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    comment_id: row.comment_id as string,
    review_id: row.review_id as string,
    revision: (row.revision as number | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    file: (row.file as string | null) ?? null,
    line: (row.line as number | null) ?? null,
    type: (row.type as ReviewCommentRow['type'] | null) ?? null,
    disposition:
      (row.disposition as ReviewCommentRow['disposition'] | null) ?? null,
    ai_classification: unj<ReviewCommentRow['ai_classification']>(
      row.ai_classification,
      null,
    ),
    body: row.body as string,
    author: (row.author as string | null) ?? null,
    changeset_id: (row.changeset_id as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToReviewDecision(row: Row): ReviewDecisionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    decision_id: row.decision_id as string,
    review_id: row.review_id as string,
    revision: (row.revision as number | null) ?? null,
    reviewer: row.reviewer as string,
    action: row.action as ReviewDecisionRow['action'],
    head_sha: row.head_sha as string,
    baseline: unj<ReviewDecisionRow['baseline']>(row.baseline, null),
    rationale: (row.rationale as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToFindingResolution(row: Row): FindingResolutionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    finding_id: row.finding_id as string,
    seq: row.seq as number,
    status: row.status as FindingResolutionRow['status'],
    rationale: (row.rationale as string | null) ?? null,
    actor: row.actor as string,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToReviewEvidenceLink(row: Row): ReviewEvidenceLinkRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    review_id: row.review_id as string,
    finding_id: row.finding_id as string,
    evidence_ref: row.evidence_ref as string,
    kind: (row.kind as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToExternalReviewMapping(row: Row): ExternalReviewMappingRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    review_id: row.review_id as string,
    finding_id: (row.finding_id as string | null) ?? null,
    external_kind: row.external_kind as string,
    external_id: row.external_id as string,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToDesignApproval(row: Row): DesignApprovalRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    approval_id: row.approval_id as string,
    subject: row.subject as string,
    doc: row.doc as string,
    doc_version: row.doc_version as number,
    checklist: unj<DesignApprovalRow['checklist']>(row.checklist, null),
    covers: unj<DesignApprovalRow['covers']>(row.covers, null),
    reviewer: row.reviewer as string,
    rationale: (row.rationale as string | null) ?? null,
    status: row.status as DesignApprovalRow['status'],
    created_at: (row.created_at as string | null) ?? null,
    invalidated_at: (row.invalidated_at as string | null) ?? null,
  };
}

function rowToAssumption(row: Row): AssumptionRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    assumption_id: row.assumption_id as string,
    subject: (row.subject as string | null) ?? null,
    statement: row.statement as string,
    impact: (row.impact as AssumptionRow['impact'] | null) ?? null,
    impact_if_false: (row.impact_if_false as string | null) ?? null,
    evidence_needed: (row.evidence_needed as string | null) ?? null,
    affected: unj<AssumptionRow['affected']>(row.affected, null),
    status: row.status as AssumptionRow['status'],
    owner: (row.owner as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
    resolved_at: (row.resolved_at as string | null) ?? null,
  };
}

function rowToQualityDebt(row: Row): QualityDebtRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    debt_id: row.debt_id as string,
    subject: (row.subject as string | null) ?? null,
    kind: row.kind as QualityDebtRow['kind'],
    title: row.title as string,
    body: (row.body as string | null) ?? null,
    owner: (row.owner as string | null) ?? null,
    revisit: (row.revisit as string | null) ?? null,
    expires_at: (row.expires_at as string | null) ?? null,
    approved_by: (row.approved_by as string | null) ?? null,
    approved_at: (row.approved_at as string | null) ?? null,
    consolidated_into: (row.consolidated_into as string | null) ?? null,
    status: row.status as QualityDebtRow['status'],
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToDeliveryCommitment(row: Row): DeliveryCommitmentRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    commitment_id: row.commitment_id as string,
    version: row.version as number,
    scope: unj<DeliveryCommitmentRow['scope']>(row.scope, {}),
    target: (row.target as string | null) ?? null,
    success_criteria: (row.success_criteria as string | null) ?? null,
    exclusions: (row.exclusions as string | null) ?? null,
    assumptions: (row.assumptions as string | null) ?? null,
    owner: (row.owner as string | null) ?? null,
    status: row.status as DeliveryCommitmentRow['status'],
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToEvalRun(row: Row): EvalRunRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    eval_run_id: row.eval_run_id as string,
    family: row.family as string,
    model: (row.model as string | null) ?? null,
    prompt_version: (row.prompt_version as string | null) ?? null,
    policy_version: (row.policy_version as string | null) ?? null,
    status: row.status as EvalRunRow['status'],
    metrics: unj<EvalRunRow['metrics']>(row.metrics, null),
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
  };
}

function rowToEvalCase(row: Row): EvalCaseRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    family: row.family as string,
    case_id: row.case_id as string,
    input: unj<EvalCaseRow['input']>(row.input, {}),
    expected: unj<EvalCaseRow['expected']>(row.expected, {}),
    tags: unj<EvalCaseRow['tags']>(row.tags, null),
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToEvalResult(row: Row): EvalResultRow {
  return {
    workspace: row.workspace as string,
    org: (row.org as string | null) ?? null,
    eval_run_id: row.eval_run_id as string,
    family: row.family as string,
    case_id: row.case_id as string,
    verdict: row.verdict as EvalResultRow['verdict'],
    scores: unj<EvalResultRow['scores']>(row.scores, null),
    detail: (row.detail as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

// ---------- helpers ----------

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: string }).code === '23505'
  );
}

function pgWhere(cols: Record<string, string | undefined>): {
  where: string;
  args: string[];
  next: number;
} {
  const parts: string[] = [];
  const args: string[] = [];
  for (const [k, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    args.push(v);
    parts.push(`${k} = $${args.length}`);
  }
  return {
    where: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    args,
    next: args.length + 1,
  };
}

function toU8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') return new Uint8Array(Buffer.from(v, 'hex'));
  return new Uint8Array(v as ArrayBuffer);
}

function bytesToF32(u: Uint8Array): Float32Array {
  const buf = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
  return new Float32Array(buf);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
