/**
 * SQLite implementation of the `Store` contract (packages/core
 * src/store.ts; docs/DB-SCHEMA.md).
 *
 * - better-sqlite3, WAL mode, `busy_timeout` for multi-connection
 *   contention. Single-writer discipline: all mutating CAS operations
 *   run inside IMMEDIATE transactions, so two `SqliteStore` instances
 *   on the same file cannot interleave a check+insert.
 * - `storage_url` parsing: `sqlite://<path>`; `sqlite:///` absolute,
 *   `sqlite://~` / `sqlite://~/…` expands `$HOME`, `sqlite:///:memory:`
 *   (or `:memory:`) for an in-memory DB.
 * - Migrations: `migrations/*.sql`, applied sequentially; each applied
 *   version is recorded in `schema_meta` (spec: `version`, `applied_at`).
 * - Embeddings: `vector` stored as a Float32Array BLOB. sqlite-vec is
 *   not bundled, so `nearestEmbeddings` falls back to an in-process
 *   cosine-distance scan (correct, O(n) — fine at KB scale; swap for
 *   sqlite-vec `vec0` virtual table when the extension ships).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Claim,
  ClaimKey,
  DossierEntry,
  Embedding,
  EmbeddingKey,
  Entity,
  EventRow,
  GateItem,
  GateItemKey,
  Lease,
  LeaseKey,
  NearestQuery,
  NearestResult,
  Notification,
  Presence,
  Relation,
  RunRow,
  Store,
  TicketKey,
  TicketRepoKey,
  TicketRepoRow,
  TicketRow,
  UsageCallRow,
} from '@sprint-runner/core';
import Database from 'better-sqlite3';

/** Live (non-terminal) run statuses for the reconcile pass. */
const LIVE_RUN_STATUSES = [
  'pending',
  'leased',
  'running',
  'paused',
  'exited',
  'collecting',
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

/** Resolve a `storage_url` to a filesystem path (or ':memory:'). */
export function resolveSqliteUrl(storageUrl: string): string {
  let p = storageUrl;
  if (p === ':memory:') return p;
  if (!p.startsWith('sqlite://')) {
    throw new Error(
      `unsupported storage_url scheme (expected sqlite://): ${storageUrl}`,
    );
  }
  p = p.slice('sqlite://'.length);
  if (p === ':memory:' || p === '/:memory:') return ':memory:';
  if (p === '~' || p.startsWith('~/')) {
    p = homedir() + p.slice(1);
  } else if (!p.startsWith('/')) {
    // sqlite://relative/path — resolve against CWD.
    p = `${process.cwd()}/${p}`;
  }
  return p;
}

const now = () => new Date().toISOString();

const j = (v: unknown): string => JSON.stringify(v ?? null);
const unj = <T>(v: unknown, fallback: T): T =>
  v === null || v === undefined ? fallback : (JSON.parse(v as string) as T);

export interface SqliteStoreOptions {
  /** Applied automatically; pass `false` to skip (tests/debugging). */
  migrate?: boolean;
}

export class SqliteStore implements Store {
  readonly db: Database.Database;

  constructor(storageUrl: string, opts: SqliteStoreOptions = {}) {
    const path = resolveSqliteUrl(storageUrl);
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    if (opts.migrate !== false) this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ---- migrations -------------------------------------------------

  private migrationsDir(): string {
    return fileURLToPath(new URL('../migrations/', import.meta.url));
  }

  /** Apply pending migrations in filename order; record each in
   *  schema_meta. Idempotent. */
  migrate(): void {
    const dir = this.migrationsDir();
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = this.getSchemaVersionSync();
    const files = readdirSync(dir)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const version = Number.parseInt(file.slice(0, 4), 10);
      if (version <= applied) continue;
      const sql = readFileSync(`${dir}/${file}`, 'utf8');
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare(
            'INSERT INTO schema_meta (version, applied_at) VALUES (?, ?)',
          )
          .run(version, now());
      })();
    }
  }

  private getSchemaVersionSync(): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_meta')
      .get() as { v: number | null };
    return row.v ?? 0;
  }

  // ---- meta ----

  async getSchemaVersion(): Promise<number> {
    return this.getSchemaVersionSync();
  }

  async setSchemaVersion(version: number): Promise<void> {
    this.db
      .prepare('INSERT INTO schema_meta (version, applied_at) VALUES (?, ?)')
      .run(version, now());
  }

  // ---- leases ----

  /** Expiry test: last heartbeat (or acquired_at) + ttl_s < now. */
  private static readonly LEASE_EXPIRED =
    'julianday(@nowTs) > julianday(COALESCE(heartbeat_at, acquired_at)) + ttl_s / 86400.0';

  async acquireLease(
    key: LeaseKey,
    holder: string,
    ttl_s: number,
  ): Promise<Lease | null> {
    const at = now();
    const insert = this.db.prepare(
      `INSERT INTO leases (workspace, subject, stage, attempt, holder, acquired_at, ttl_s, heartbeat_at)
       VALUES (@workspace, @subject, @stage, @attempt, @holder, @at, @ttl, @at)`,
    );
    const result = this.db
      .transaction((): Lease | null => {
        const existing = this.getLeaseSync(key);
        if (existing) {
          const expired = this.db
            .prepare(
              `SELECT 1 FROM leases
             WHERE workspace=@workspace AND subject=@subject
               AND stage=@stage AND attempt=@attempt
               AND ${SqliteStore.LEASE_EXPIRED}`,
            )
            .get({ ...key, nowTs: at });
          if (!expired) return null;
          this.deleteLeaseSync(key);
        }
        insert.run({ ...key, holder, at, ttl: ttl_s });
        return this.getLeaseSync(key);
      })
      .immediate();
    return result;
  }

  async heartbeatLease(key: LeaseKey, at: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE leases SET heartbeat_at = @at
         WHERE workspace=@workspace AND subject=@subject
           AND stage=@stage AND attempt=@attempt`,
      )
      .run({ ...key, at });
  }

  private deleteLeaseSync(key: LeaseKey): void {
    this.db
      .prepare(
        `DELETE FROM leases
         WHERE workspace=@workspace AND subject=@subject
           AND stage=@stage AND attempt=@attempt`,
      )
      .run(key);
  }

  async releaseLease(key: LeaseKey, holder: string): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM leases
         WHERE workspace=@workspace AND subject=@subject
           AND stage=@stage AND attempt=@attempt AND holder=@holder`,
      )
      .run({ ...key, holder });
  }

  private getLeaseSync(key: LeaseKey): Lease | null {
    const row = this.db
      .prepare(
        `SELECT * FROM leases
         WHERE workspace=@workspace AND subject=@subject
           AND stage=@stage AND attempt=@attempt`,
      )
      .get(key) as Record<string, unknown> | undefined;
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

  async getLease(key: LeaseKey): Promise<Lease | null> {
    return this.getLeaseSync(key);
  }

  async sweepExpiredLeases(nowTs: string): Promise<LeaseKey[]> {
    return this.db.transaction((): LeaseKey[] => {
      const rows = this.db
        .prepare(
          `SELECT workspace, subject, stage, attempt FROM leases
           WHERE ${SqliteStore.LEASE_EXPIRED}`,
        )
        .all({ nowTs }) as LeaseKey[];
      this.db
        .prepare(`DELETE FROM leases WHERE ${SqliteStore.LEASE_EXPIRED}`)
        .run({ nowTs });
      return rows;
    })();
  }

  // ---- claims ----

  private static readonly CLAIM_EXPIRED =
    'julianday(@nowTs) > julianday(claimed_at) + ttl_s / 86400.0';

  async acquireClaim(
    key: ClaimKey,
    actor: string,
    ttl_s: number,
  ): Promise<Claim | null> {
    const at = now();
    return this.db
      .transaction((): Claim | null => {
        const existing = this.getClaimSync(key);
        if (existing) {
          const expired = this.db
            .prepare(
              `SELECT 1 FROM claims
             WHERE workspace=@workspace AND subject=@subject AND gate=@gate
               AND ${SqliteStore.CLAIM_EXPIRED}`,
            )
            .get({ ...key, nowTs: at });
          if (!expired) return null;
          this.db
            .prepare(
              `DELETE FROM claims
             WHERE workspace=@workspace AND subject=@subject AND gate=@gate`,
            )
            .run(key);
        }
        this.db
          .prepare(
            `INSERT INTO claims (workspace, subject, gate, claimed_by, claimed_at, ttl_s)
           VALUES (@workspace, @subject, @gate, @actor, @at, @ttl)`,
          )
          .run({ ...key, actor, at, ttl: ttl_s });
        return this.getClaimSync(key);
      })
      .immediate();
  }

  async releaseClaim(key: ClaimKey, actor: string): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM claims
         WHERE workspace=@workspace AND subject=@subject AND gate=@gate
           AND claimed_by=@actor`,
      )
      .run({ ...key, actor });
  }

  private getClaimSync(key: ClaimKey): Claim | null {
    const row = this.db
      .prepare(
        `SELECT * FROM claims
         WHERE workspace=@workspace AND subject=@subject AND gate=@gate`,
      )
      .get(key) as Record<string, unknown> | undefined;
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

  async getClaim(key: ClaimKey): Promise<Claim | null> {
    return this.getClaimSync(key);
  }

  // ---- runs ----

  async createRun(run: RunRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (id, ${RUN_COLUMNS.join(', ')})
         VALUES (@id, ${RUN_COLUMNS.map((c) => `@${c}`).join(', ')})`,
      )
      .run(this.runParams(run));
  }

  private runParams(run: Partial<RunRow> & { id?: string }) {
    const p: Record<string, unknown> = { id: run.id };
    for (const c of RUN_COLUMNS) p[c] = run[c] ?? null;
    return p;
  }

  async updateRun(id: string, patch: Partial<RunRow>): Promise<void> {
    const keys = RUN_COLUMNS.filter(
      (c) => c in patch && patch[c] !== undefined,
    );
    if (keys.length === 0 && patch.id === undefined) return;
    const cols = keys.map((c) => `${c} = @${c}`).join(', ');
    this.db
      .prepare(`UPDATE runs SET ${cols} WHERE id = @__id`)
      .run({ ...nullify({ ...patch }), __id: id });
  }

  async heartbeatRun(id: string, at: string): Promise<void> {
    this.db
      .prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?')
      .run(at, id);
  }

  async updateRunUsage(
    id: string,
    delta: {
      tokens_in?: number;
      tokens_out?: number;
      tokens_cached?: number;
    },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE runs SET
           tokens_in = COALESCE(tokens_in, 0) + COALESCE(@tin, 0),
           tokens_out = COALESCE(tokens_out, 0) + COALESCE(@tout, 0),
           tokens_cached = COALESCE(tokens_cached, 0) + COALESCE(@tcache, 0)
         WHERE id = @id`,
      )
      .run({
        id,
        tin: delta.tokens_in ?? null,
        tout: delta.tokens_out ?? null,
        tcache: delta.tokens_cached ?? null,
      });
  }

  private rowToRun(row: Record<string, unknown>): RunRow {
    const r: Record<string, unknown> = {};
    r.id = row.id;
    for (const c of RUN_COLUMNS) r[c] = row[c] ?? null;
    return r as unknown as RunRow;
  }

  async getRun(id: string): Promise<RunRow | null> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRun(row) : null;
  }

  async listLiveRuns(): Promise<RunRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE status IN (${LIVE_RUN_STATUSES.map(
          () => '?',
        ).join(',')})`,
      )
      .all(...LIVE_RUN_STATUSES) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  async listRuns(filter?: {
    workspace?: string;
    subject?: string;
    ticket_id?: string;
    status?: string;
  }): Promise<RunRow[]> {
    const { where, args } = buildWhere({
      workspace: filter?.workspace,
      subject: filter?.subject,
      ticket_id: filter?.ticket_id,
      status: filter?.status,
    });
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY started_at`)
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  // ---- ticket projections ----

  async upsertTicket(row: TicketRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tickets (workspace, ticket_id, title, status, priority,
           depth, backend, model, repos, parent, depends_on, spec_score,
           spec_hash, blocked_reason, updated_at)
         VALUES (@workspace, @ticket_id, @title, @status, @priority,
           @depth, @backend, @model, @repos, @parent, @depends_on,
           @spec_score, @spec_hash, @blocked_reason, @updated_at)
         ON CONFLICT (workspace, ticket_id) DO UPDATE SET
           title=@title, status=@status, priority=@priority, depth=@depth,
           backend=@backend, model=@model, repos=@repos, parent=@parent,
           depends_on=@depends_on, spec_score=@spec_score,
           spec_hash=@spec_hash, blocked_reason=@blocked_reason,
           updated_at=@updated_at`,
      )
      .run({
        workspace: row.workspace,
        ticket_id: row.ticket_id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        depth: row.depth ?? null,
        backend: row.backend ?? null,
        model: row.model ?? null,
        repos: j(row.repos),
        parent: row.parent ?? null,
        depends_on: j(row.depends_on),
        spec_score: row.spec_score ?? null,
        spec_hash: row.spec_hash ?? null,
        blocked_reason: row.blocked_reason ?? null,
        updated_at: row.updated_at,
      });
  }

  private rowToTicket(row: Record<string, unknown>): TicketRow {
    return {
      workspace: row.workspace as string,
      ticket_id: row.ticket_id as string,
      title: row.title as string,
      status: row.status as TicketRow['status'],
      priority: row.priority as TicketRow['priority'],
      depth: (row.depth as TicketRow['depth']) ?? null,
      backend: (row.backend as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      repos: unj(row.repos, []),
      parent: (row.parent as string | null) ?? null,
      depends_on: unj(row.depends_on, []),
      spec_score: (row.spec_score as number | null) ?? null,
      spec_hash: (row.spec_hash as string | null) ?? null,
      blocked_reason: (row.blocked_reason as string | null) ?? null,
      updated_at: row.updated_at as string,
    };
  }

  async getTicket(key: TicketKey): Promise<TicketRow | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM tickets WHERE workspace=@workspace AND ticket_id=@ticket_id',
      )
      .get(key) as Record<string, unknown> | undefined;
    return row ? this.rowToTicket(row) : null;
  }

  async listTickets(filter?: {
    workspace?: string;
    status?: string;
  }): Promise<TicketRow[]> {
    const { where, args } = buildWhere({
      workspace: filter?.workspace,
      status: filter?.status,
    });
    const rows = this.db
      .prepare(`SELECT * FROM tickets ${where} ORDER BY ticket_id`)
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToTicket(r));
  }

  async deleteTicket(key: TicketKey): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM tickets WHERE workspace=@workspace AND ticket_id=@ticket_id',
      )
      .run(key);
  }

  async upsertTicketRepo(row: TicketRepoRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ticket_repos (workspace, ticket_id, repo, branch,
           worktree, pr_url, pr_state, ci_state, merged_sha)
         VALUES (@workspace, @ticket_id, @repo, @branch, @worktree,
           @pr_url, @pr_state, @ci_state, @merged_sha)
         ON CONFLICT (workspace, ticket_id, repo) DO UPDATE SET
           branch=@branch, worktree=@worktree, pr_url=@pr_url,
           pr_state=@pr_state, ci_state=@ci_state, merged_sha=@merged_sha`,
      )
      .run({
        workspace: row.workspace,
        ticket_id: row.ticket_id,
        repo: row.repo,
        branch: row.branch ?? null,
        worktree: row.worktree ?? null,
        pr_url: row.pr_url ?? null,
        pr_state: row.pr_state ?? null,
        ci_state: row.ci_state ?? null,
        merged_sha: row.merged_sha ?? null,
      });
  }

  private rowToTicketRepo(row: Record<string, unknown>): TicketRepoRow {
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

  async getTicketRepo(key: TicketRepoKey): Promise<TicketRepoRow | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM ticket_repos
         WHERE workspace=@workspace AND ticket_id=@ticket_id AND repo=@repo`,
      )
      .get(key) as Record<string, unknown> | undefined;
    return row ? this.rowToTicketRepo(row) : null;
  }

  async listTicketRepos(key: TicketKey): Promise<TicketRepoRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ticket_repos
         WHERE workspace=@workspace AND ticket_id=@ticket_id ORDER BY repo`,
      )
      .all(key) as Record<string, unknown>[];
    return rows.map((r) => this.rowToTicketRepo(r));
  }

  async deleteTicketRepos(key: TicketKey): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM ticket_repos
         WHERE workspace=@workspace AND ticket_id=@ticket_id`,
      )
      .run(key);
  }

  // ---- events / usage projections ----

  async appendEvent(row: EventRow): Promise<number> {
    return this.db.transaction((): number => {
      const info = this.db
        .prepare(
          `INSERT INTO events_idx (workspace, ticket_id, ts, stage,
             actor_type, actor_id, event, run, refs, data, cost_usd,
             tokens_in, tokens_out, tokens_cached, usage_source,
             duration_s, human_minutes)
           VALUES (@workspace, @ticket_id, @ts, @stage, @actor_type,
             @actor_id, @event, @run, @refs, @data, @cost_usd,
             @tokens_in, @tokens_out, @tokens_cached, @usage_source,
             @duration_s, @human_minutes)`,
        )
        .run({
          workspace: row.workspace,
          ticket_id: row.ticket_id ?? null,
          ts: row.ts,
          stage: row.stage ?? null,
          actor_type: row.actor_type,
          actor_id: row.actor_id,
          event: row.event,
          run: row.run ?? null,
          refs: j(row.refs),
          data: j(row.data),
          cost_usd: row.cost_usd ?? null,
          tokens_in: row.tokens_in ?? null,
          tokens_out: row.tokens_out ?? null,
          tokens_cached: row.tokens_cached ?? null,
          usage_source: row.usage_source ?? null,
          duration_s: row.duration_s ?? null,
          human_minutes: row.human_minutes ?? null,
        });
      // DB-SCHEMA notifications rule: run_failed/run_killed/blocked.
      if (NOTIFY_EVENTS.has(row.event)) {
        this.insertNotificationSync({
          workspace: row.workspace,
          subject: row.ticket_id ?? row.run ?? 'unknown',
          kind: row.event,
          payload: j({ event: row.event, run: row.run ?? null }),
          created_at: row.ts,
          read_at: null,
        });
      }
      return Number(info.lastInsertRowid);
    })();
  }

  private rowToEvent(row: Record<string, unknown>): EventRow {
    return {
      seq: row.seq as number,
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

  async listEvents(filter: {
    workspace: string;
    ticket_id?: string;
    subject?: string;
    event?: string;
  }): Promise<EventRow[]> {
    // `subject` maps to ticket_id OR run id for non-ticket subjects.
    const clauses: Record<string, string | undefined> = {
      workspace: filter.workspace,
      ticket_id: filter.ticket_id,
      event: filter.event,
    };
    let where = buildWhere(clauses).where;
    const args = [...buildWhere(clauses).args];
    if (filter.subject) {
      where += `${where ? ' AND' : 'WHERE'} (ticket_id = ? OR run = ?)`;
      args.push(filter.subject, filter.subject);
    }
    const rows = this.db
      .prepare(`SELECT * FROM events_idx ${where} ORDER BY seq`)
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEvent(r));
  }

  async clearEvents(workspace: string, ticket_id?: string): Promise<void> {
    if (ticket_id !== undefined) {
      this.db
        .prepare('DELETE FROM events_idx WHERE workspace=? AND ticket_id=?')
        .run(workspace, ticket_id);
    } else {
      this.db
        .prepare('DELETE FROM events_idx WHERE workspace=?')
        .run(workspace);
    }
  }

  async insertUsageCalls(rows: UsageCallRow[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO usage_calls (run_id, seq, ts, model,
         tokens_in, tokens_out, tokens_cached, latency_s, source)
       VALUES (@run_id, @seq, @ts, @model, @tokens_in, @tokens_out,
         @tokens_cached, @latency_s, @source)`,
    );
    this.db.transaction(() => {
      for (const r of rows) stmt.run(nullify({ ...r }));
    })();
  }

  async listUsageCalls(run_id: string): Promise<UsageCallRow[]> {
    const rows = this.db
      .prepare('SELECT * FROM usage_calls WHERE run_id=? ORDER BY seq')
      .all(run_id) as Record<string, unknown>[];
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
    this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO gate_items (workspace, subject, gate, kind,
             surfaced_at, cleared_at, blocked_agent, priority)
           VALUES (@workspace, @subject, @gate, @kind, @surfaced_at,
             @cleared_at, @blocked_agent, @priority)
           ON CONFLICT (workspace, subject, gate) DO NOTHING`,
        )
        .run({
          workspace: item.workspace,
          subject: item.subject,
          gate: item.gate,
          kind: item.kind,
          surfaced_at: item.surfaced_at,
          cleared_at: item.cleared_at ?? null,
          blocked_agent: item.blocked_agent ? 1 : 0,
          priority: item.priority ?? null,
        });
      if (inserted.changes > 0) {
        // DB-SCHEMA notifications rule: generated on gate_items insert.
        this.insertNotificationSync({
          workspace: item.workspace,
          subject: item.subject,
          kind: `gate:${item.kind}`,
          payload: j({ gate: item.gate, kind: item.kind }),
          created_at: item.surfaced_at,
          read_at: null,
        });
      } else {
        this.db
          .prepare(
            `UPDATE gate_items SET kind=@kind, surfaced_at=@surfaced_at,
               cleared_at=@cleared_at, blocked_agent=@blocked_agent,
               priority=@priority
             WHERE workspace=@workspace AND subject=@subject AND gate=@gate`,
          )
          .run({
            workspace: item.workspace,
            subject: item.subject,
            gate: item.gate,
            kind: item.kind,
            surfaced_at: item.surfaced_at,
            cleared_at: item.cleared_at ?? null,
            blocked_agent: item.blocked_agent ? 1 : 0,
            priority: item.priority ?? null,
          });
      }
    })();
  }

  async clearGateItem(key: GateItemKey, cleared_at: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE gate_items SET cleared_at=@cleared_at
         WHERE workspace=@workspace AND subject=@subject AND gate=@gate`,
      )
      .run({ ...key, cleared_at });
  }

  private rowToGateItem(row: Record<string, unknown>): GateItem {
    return {
      workspace: row.workspace as string,
      subject: row.subject as string,
      gate: row.gate as string,
      kind: row.kind as GateItem['kind'],
      surfaced_at: row.surfaced_at as string,
      cleared_at: (row.cleared_at as string | null) ?? null,
      blocked_agent: Boolean(row.blocked_agent),
      priority: (row.priority as GateItem['priority']) ?? null,
    };
  }

  async getGateItem(key: GateItemKey): Promise<GateItem | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM gate_items
         WHERE workspace=@workspace AND subject=@subject AND gate=@gate`,
      )
      .get(key) as Record<string, unknown> | undefined;
    return row ? this.rowToGateItem(row) : null;
  }

  async listGateItems(filter?: {
    workspace?: string;
    open?: boolean;
  }): Promise<GateItem[]> {
    const { where, args } = buildWhere({ workspace: filter?.workspace });
    let sql = `SELECT * FROM gate_items ${where}`;
    if (filter?.open === true)
      sql += `${where ? ' AND' : ' WHERE'} cleared_at IS NULL`;
    if (filter?.open === false)
      sql += `${where ? ' AND' : ' WHERE'} cleared_at IS NOT NULL`;
    sql += ' ORDER BY surfaced_at';
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToGateItem(r));
  }

  // ---- notifications ----

  private insertNotificationSync(n: Omit<Notification, 'id'>): number {
    const info = this.db
      .prepare(
        `INSERT INTO notifications (workspace, subject, kind, payload,
           created_at, read_at)
         VALUES (@workspace, @subject, @kind, @payload, @created_at,
           @read_at)`,
      )
      .run({
        workspace: n.workspace,
        subject: n.subject,
        kind: n.kind,
        payload: n.payload ?? null,
        created_at: n.created_at,
        read_at: n.read_at ?? null,
      });
    return Number(info.lastInsertRowid);
  }

  async insertNotification(n: Omit<Notification, 'id'>): Promise<number> {
    return this.insertNotificationSync(n);
  }

  async markNotificationRead(id: number, at: string): Promise<void> {
    this.db
      .prepare('UPDATE notifications SET read_at=? WHERE id=?')
      .run(at, id);
  }

  private rowToNotification(row: Record<string, unknown>): Notification {
    return {
      id: row.id as number,
      workspace: row.workspace as string,
      subject: row.subject as string,
      kind: row.kind as string,
      payload: (row.payload as string | null) ?? null,
      created_at: row.created_at as string,
      read_at: (row.read_at as string | null) ?? null,
    };
  }

  async listNotifications(filter?: {
    workspace?: string;
    unreadOnly?: boolean;
  }): Promise<Notification[]> {
    const { where, args } = buildWhere({ workspace: filter?.workspace });
    let sql = `SELECT * FROM notifications ${where}`;
    if (filter?.unreadOnly)
      sql += `${where ? ' AND' : ' WHERE'} read_at IS NULL`;
    sql += ' ORDER BY id';
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNotification(r));
  }

  async pruneNotifications(before: string): Promise<number> {
    const info = this.db
      .prepare('DELETE FROM notifications WHERE created_at < ?')
      .run(before);
    return info.changes;
  }

  // ---- presence ----

  async upsertPresence(p: Presence): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO presence (install_id, actor, last_seen)
         VALUES (@install_id, @actor, @last_seen)
         ON CONFLICT (install_id) DO UPDATE SET
           actor=@actor, last_seen=@last_seen`,
      )
      .run(p);
  }

  async listPresence(): Promise<Presence[]> {
    return this.db
      .prepare('SELECT * FROM presence ORDER BY install_id')
      .all() as Presence[];
  }

  async prunePresence(before: string): Promise<number> {
    const info = this.db
      .prepare('DELETE FROM presence WHERE last_seen < ?')
      .run(before);
    return info.changes;
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
   * Versioning rules (DB-SCHEMA):
   * - every write lands at `MAX(version)+1` for the section id;
   * - a machine refresh (no `edited_by`) racing a human-edited latest
   *   version does NOT overwrite the human row — the new version is
   *   inserted flagged `stale` (for review) and the human content stays
   *   intact ("edited_by wins");
   * - after a refresh, sibling sections of the same scope+name whose
   *   latest survey is older get `stale=1` ("unchanged-but-older").
   */
  async upsertDossierSection(entry: DossierEntry): Promise<void> {
    const id = SqliteStore.dossierId(entry);
    this.db.transaction(() => {
      const latest = this.db
        .prepare('SELECT MAX(version) AS v FROM dossiers WHERE id = ?')
        .get(id) as { v: number | null };
      const version = (latest.v ?? 0) + 1;
      const stale =
        entry.stale || (!entry.edited_by && this.latestEditedByHuman(id));
      this.db
        .prepare(
          `INSERT INTO dossiers (id, scope, name, section, version,
             content, surveyed_at, sources_used, stale, edited_by,
             edited_at)
           VALUES (@id, @scope, @name, @section, @version, @content,
             @surveyed_at, @sources_used, @stale, @edited_by, @edited_at)`,
        )
        .run({
          id,
          scope: entry.scope,
          name: entry.name,
          section: entry.section,
          version,
          content: entry.content,
          surveyed_at: entry.surveyed_at,
          sources_used: (entry.sources_used ?? []).join(','),
          stale: stale ? 1 : 0,
          edited_by: entry.edited_by ?? null,
          edited_at: entry.edited_at ?? null,
        });
      // Flag unchanged-but-older sibling sections stale.
      this.db
        .prepare(
          `UPDATE dossiers SET stale = 1
           WHERE scope = @scope AND name = @name AND id != @id
             AND version = (
               SELECT MAX(version) FROM dossiers d2
               WHERE d2.id = dossiers.id)
             AND surveyed_at < @surveyed_at`,
        )
        .run({
          scope: entry.scope,
          name: entry.name,
          id,
          surveyed_at: entry.surveyed_at,
        });
    })();
  }

  private latestEditedByHuman(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT edited_by FROM dossiers
         WHERE id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(id) as { edited_by: string | null } | undefined;
    return !!row?.edited_by;
  }

  private rowToDossier(row: Record<string, unknown>): DossierEntry {
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

  async getDossierSection(
    scope: string,
    name: string,
    section: string,
    version?: number,
  ): Promise<DossierEntry | null> {
    const id = SqliteStore.dossierId({ scope, name, section });
    const row = (
      version === undefined
        ? this.db
            .prepare(
              'SELECT * FROM dossiers WHERE id=? ORDER BY version DESC LIMIT 1',
            )
            .get(id)
        : this.db
            .prepare('SELECT * FROM dossiers WHERE id=? AND version=?')
            .get(id, version)
    ) as Record<string, unknown> | undefined;
    return row ? this.rowToDossier(row) : null;
  }

  async getDossier(scope: string, name: string): Promise<DossierEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM dossiers d
         WHERE d.scope=? AND d.name=?
           AND d.version = (
             SELECT MAX(version) FROM dossiers d2 WHERE d2.id = d.id)
         ORDER BY d.section`,
      )
      .all(scope, name) as Record<string, unknown>[];
    return rows.map((r) => this.rowToDossier(r));
  }

  async listDossiers(filter?: { scope?: string }): Promise<DossierEntry[]> {
    const { where, args } = buildWhere({ scope: filter?.scope });
    const rows = this.db
      .prepare(
        `SELECT * FROM dossiers d ${where ? `${where} AND` : 'WHERE'}
           d.version = (
             SELECT MAX(version) FROM dossiers d2 WHERE d2.id = d.id)
         ORDER BY d.scope, d.name, d.section`,
      )
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToDossier(r));
  }

  async listDossierVersions(
    scope: string,
    name: string,
    section: string,
  ): Promise<DossierEntry[]> {
    const rows = this.db
      .prepare('SELECT * FROM dossiers WHERE id=? ORDER BY version')
      .all(SqliteStore.dossierId({ scope, name, section })) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToDossier(r));
  }

  // ---- entities / relations ----

  async upsertEntity(e: Entity): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO entities (id, product, kind, name, canonical,
           aliases, source, evidence)
         VALUES (@id, @product, @kind, @name, @canonical, @aliases,
           @source, @evidence)
         ON CONFLICT (id) DO UPDATE SET product=@product, kind=@kind,
           name=@name, canonical=@canonical, aliases=@aliases,
           source=@source, evidence=@evidence`,
      )
      .run({
        id: e.id,
        product: e.product,
        kind: e.kind,
        name: e.name,
        canonical: e.canonical,
        aliases: j(e.aliases),
        source: e.source,
        evidence: e.evidence ?? null,
      });
  }

  private rowToEntity(row: Record<string, unknown>): Entity {
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

  async getEntity(id: string): Promise<Entity | null> {
    const row = this.db.prepare('SELECT * FROM entities WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  async listEntities(filter?: {
    product?: string;
    kind?: string;
  }): Promise<Entity[]> {
    const { where, args } = buildWhere({
      product: filter?.product,
      kind: filter?.kind,
    });
    const rows = this.db
      .prepare(`SELECT * FROM entities ${where} ORDER BY id`)
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntity(r));
  }

  async deleteEntity(id: string): Promise<void> {
    this.db.prepare('DELETE FROM entities WHERE id=?').run(id);
  }

  async upsertRelation(r: Relation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO relations (subject, predicate, object, evidence, source)
         VALUES (@subject, @predicate, @object, @evidence, @source)
         ON CONFLICT (subject, predicate, object) DO UPDATE SET
           evidence=@evidence, source=@source`,
      )
      .run({
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        evidence: r.evidence ?? null,
        source: r.source ?? null,
      });
  }

  async listRelations(filter?: {
    subject?: string;
    predicate?: string;
    object?: string;
  }): Promise<Relation[]> {
    const { where, args } = buildWhere({
      subject: filter?.subject,
      predicate: filter?.predicate,
      object: filter?.object,
    });
    const rows = this.db
      .prepare(`SELECT * FROM relations ${where}`)
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      subject: r.subject as string,
      predicate: r.predicate as Relation['predicate'],
      object: r.object as string,
      evidence: (r.evidence as string | null) ?? undefined,
      source: (r.source as string | null) ?? undefined,
    }));
  }

  async deleteRelation(r: Relation): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM relations
         WHERE subject=@subject AND predicate=@predicate AND object=@object`,
      )
      .run(r);
  }

  // ---- embeddings ----

  async upsertEmbedding(e: Embedding): Promise<void> {
    const vec =
      e.vector instanceof Uint8Array
        ? e.vector
        : new Uint8Array(new Float32Array(e.vector).buffer);
    this.db
      .prepare(
        `INSERT INTO embeddings (object_ref, model, vector)
         VALUES (@object_ref, @model, @vector)
         ON CONFLICT (object_ref, model) DO UPDATE SET vector=@vector`,
      )
      .run({ object_ref: e.object_ref, model: e.model, vector: vec });
  }

  async getEmbedding(key: EmbeddingKey): Promise<Embedding | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM embeddings WHERE object_ref=@object_ref AND model=@model',
      )
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      object_ref: row.object_ref as string,
      model: row.model as string,
      vector: new Uint8Array(row.vector as Uint8Array),
    };
  }

  async deleteEmbedding(key: EmbeddingKey): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM embeddings WHERE object_ref=@object_ref AND model=@model',
      )
      .run(key);
  }

  /**
   * Cosine-distance scan. sqlite-vec is not bundled — when the
   * extension ships this can swap to a `vec0` KNN query without
   * changing the interface. Throws if stored vector shape is invalid.
   */
  async nearestEmbeddings(q: NearestQuery): Promise<NearestResult[]> {
    const query =
      q.vector instanceof Uint8Array
        ? bytesToF32(q.vector)
        : new Float32Array(q.vector);
    const rows = this.db
      .prepare('SELECT object_ref, vector FROM embeddings WHERE model=?')
      .all(q.model) as { object_ref: string; vector: Uint8Array | null }[];
    const results: NearestResult[] = [];
    for (const r of rows) {
      if (!r.vector) continue;
      const v = bytesToF32(r.vector);
      if (v.length !== query.length) continue;
      results.push({ object_ref: r.object_ref, distance: cosine(query, v) });
    }
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, q.limit);
  }
}

// ---------- helpers ----------

function nullify<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === undefined ? null : v;
  return out as T;
}

function buildWhere(cols: Record<string, string | undefined>): {
  where: string;
  args: string[];
} {
  const parts: string[] = [];
  const args: string[] = [];
  for (const [k, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    parts.push(`${k} = ?`);
    args.push(v);
  }
  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
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
