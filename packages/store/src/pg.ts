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
  BoardItem,
  BoardRow,
  Claim,
  ClaimKey,
  DocKey,
  DocVersion,
  DossierEntry,
  Embedding,
  EmbeddingKey,
  Entity,
  EventRow,
  FeatureRow,
  GateItem,
  GateItemKey,
  InitiativeRow,
  Lease,
  LeaseKey,
  NearestQuery,
  NearestResult,
  Notification,
  Presence,
  ProjectRow,
  Relation,
  RunArtifact,
  RunRow,
  Store,
  TicketKey,
  TicketRepoKey,
  TicketRepoRow,
  TicketRow,
  UsageCallRow,
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

  // ---- tickets ----

  async upsertTicket(row: TicketRow): Promise<void> {
    const p = [
      row.workspace,
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
      row.forced ? 1 : 0,
      row.spec_score ?? null,
      row.spec_hash ?? null,
      row.blocked_reason ?? null,
      row.created_at ?? null,
      row.updated_at,
    ];
    await this.db.query(
      `INSERT INTO tickets (workspace, ticket_id, feature, title, status,
         priority, depth, backend, model, repos, parent, depends_on,
         serves, source, forced, spec_score, spec_hash, blocked_reason,
         created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20)
       ON CONFLICT (workspace, ticket_id) DO UPDATE SET
         feature=$3, title=$4, status=$5, priority=$6, depth=$7,
         backend=$8, model=$9, repos=$10, parent=$11, depends_on=$12,
         serves=$13, source=$14, forced=$15, spec_score=$16, spec_hash=$17,
         blocked_reason=$18, updated_at=$20`,
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
      `INSERT INTO projects (workspace, name, next_ticket_seq,
         next_feature_seq, next_initiative_seq, settings, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace) DO UPDATE SET name=$2, settings=$6`,
      [
        row.workspace,
        row.name ?? null,
        row.next_ticket_seq ?? 1,
        row.next_feature_seq ?? 1,
        row.next_initiative_seq ?? 1,
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
    column: 'next_ticket_seq' | 'next_feature_seq' | 'next_initiative_seq',
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
      const [t, f, i] = await Promise.all([
        seqStart('tickets', 'ticket_id', 'SR'),
        seqStart('features', 'feature', 'F'),
        seqStart('initiatives', 'initiative', 'I'),
      ]);
      await this.db.query(
        `INSERT INTO projects (workspace, name, next_ticket_seq,
           next_feature_seq, next_initiative_seq, settings, created_at)
         VALUES ($1, $1, $2, $3, $4, '{}', $5)
         ON CONFLICT (workspace) DO NOTHING`,
        [workspace, t, f, i, new Date().toISOString()],
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

  // ---- boards / canvas ----

  async upsertBoard(row: BoardRow): Promise<void> {
    await this.db.query(
      `INSERT INTO boards (workspace, board, name, created_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace, board) DO UPDATE SET name=$3`,
      [row.workspace, row.board, row.name ?? null, row.created_at ?? null],
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
      item.created_at ?? null,
      item.updated_at ?? null,
    ];
    await this.db.query(
      `INSERT INTO board_items (id, workspace, board, kind, ref, title,
         body, x, y, w, h, zone, serves, status, consumed_by, created_at,
         updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         board=$3, kind=$4, ref=$5, title=$6, body=$7, x=$8, y=$9, w=$10,
         h=$11, zone=$12, serves=$13, status=$14, consumed_by=$15,
         updated_at=$17`,
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
      `INSERT INTO initiatives (workspace, initiative, board, title,
         status, owner, priority, serves, provenance, created_at,
         updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace, initiative) DO UPDATE SET
         board=$3, title=$4, status=$5, owner=$6, priority=$7,
         serves=$8, provenance=$9, updated_at=$11`,
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
      row.feature,
      row.initiative ?? null,
      row.title,
      row.status,
      row.owner ?? null,
      row.priority ?? null,
      j(row.serves ?? null),
      row.created_at ?? null,
      row.updated_at ?? null,
    ];
    await this.db.query(
      `INSERT INTO features (workspace, feature, initiative, title,
         status, owner, priority, serves, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (workspace, feature) DO UPDATE SET
         initiative=$3, title=$4, status=$5, owner=$6, priority=$7,
         serves=$8, updated_at=$10`,
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

function rowToTicket(row: Row): TicketRow {
  return {
    workspace: row.workspace as string,
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
    name: (row.name as string | null) ?? null,
    next_ticket_seq: (row.next_ticket_seq as number) ?? 1,
    next_feature_seq: (row.next_feature_seq as number) ?? 1,
    next_initiative_seq: (row.next_initiative_seq as number) ?? 1,
    settings: unj(row.settings, {}),
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToBoard(row: Row): BoardRow {
  return {
    workspace: row.workspace as string,
    board: row.board as string,
    name: (row.name as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function rowToBoardItem(row: Row): BoardItem {
  return {
    id: row.id as string,
    workspace: row.workspace as string,
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
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function rowToInitiative(row: Row): InitiativeRow {
  return {
    workspace: row.workspace as string,
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
    feature: row.feature as string,
    initiative: (row.initiative as string | null) ?? null,
    title: row.title as string,
    status: row.status as FeatureRow['status'],
    owner: (row.owner as string | null) ?? null,
    priority: (row.priority as FeatureRow['priority']) ?? null,
    serves: unj(row.serves, null),
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
