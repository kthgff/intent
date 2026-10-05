/**
 * PgClient — minimal async SQL executor the `PostgresStore` codes
 * against (wp-091, D29). Two drivers:
 *
 * - `postgres.js` for real `postgres://…` storage_urls (runtime);
 * - `@electric-sql/pglite` for embedded Postgres (tests / `pglite:`).
 *
 * Both speak `$n` positional params and async transactions, so all
 * store SQL is written once.
 */
export interface PgClient {
  /** Run a query; returns rows as plain objects. */
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Multi-statement SQL (migrations) — no params, simple protocol. */
  exec(text: string): Promise<void>;
  /** Run fn inside a transaction; rollback on throw. */
  transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type PgDriver = 'postgres' | 'pglite';

/**
 * `postgres://…` / `postgresql://…` → postgres.js driver.
 * `pglite:` / `pglite://…` / `:memory:` → embedded PGlite (test path —
 * `dataDir` after the scheme is optional; in-memory when omitted).
 */
export function parseStorageUrl(storageUrl: string): {
  driver: PgDriver;
  url: string;
} {
  if (
    storageUrl === ':memory:' ||
    storageUrl === 'pglite:' ||
    storageUrl.startsWith('pglite://')
  ) {
    return {
      driver: 'pglite',
      url: storageUrl.replace(/^pglite:(\/\/)?/, ''),
    };
  }
  if (
    storageUrl.startsWith('postgres://') ||
    storageUrl.startsWith('postgresql://')
  ) {
    return { driver: 'postgres', url: storageUrl };
  }
  throw new Error(
    `unsupported storage_url (expected postgres:// or pglite: — D29): ${storageUrl}`,
  );
}

/** postgres.js driver — lazy import so test envs never load it. */
export async function createPostgresClient(url: string): Promise<PgClient> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { prepare: true });
  const wrap = (q: typeof sql): PgClient => ({
    async query<T extends Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const rows = await q.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async exec(text: string): Promise<void> {
      // simple query protocol — multi-statement allowed, no params.
      await q.unsafe(text);
    },
    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
      // Nested `transaction` inside an open tx reuses it — a throw
      // still propagates and rolls the outer tx back.
      if (typeof q.begin !== 'function') return fn(wrap(q));
      return q.begin((tx) =>
        fn(wrap(tx as unknown as typeof sql)),
      ) as Promise<T>;
    },
    async close() {
      await q.end();
    },
  });
  return wrap(sql);
}

/** PGlite driver — embedded Postgres (tests). */
export async function createPgliteClient(dataDir?: string): Promise<PgClient> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite(dataDir && dataDir.length > 0 ? dataDir : undefined);
  await pg.waitReady;
  const wrap = (q: {
    query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
    exec(text: string): Promise<unknown>;
    transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
  }): PgClient => ({
    async query<T extends Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const res = await q.query<T>(text, params);
      return res.rows;
    },
    async exec(text: string): Promise<void> {
      await q.exec(text);
    },
    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
      // PGlite's tx object has no `.transaction` — nested calls reuse
      // the current tx; a throw still aborts the outer one.
      if (typeof q.transaction !== 'function') return fn(wrap(q));
      return q.transaction<T>((tx) => fn(wrap(tx as typeof q)));
    },
    async close() {
      await (q as unknown as { close(): Promise<void> }).close();
    },
  });
  return wrap(pg);
}

export async function createClient(storageUrl: string): Promise<PgClient> {
  const { driver, url } = parseStorageUrl(storageUrl);
  return driver === 'pglite'
    ? createPgliteClient(url)
    : createPostgresClient(url);
}
