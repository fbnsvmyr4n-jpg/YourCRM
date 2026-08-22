import { Pool } from "pg";

/**
 * Postgres-backed storage.
 *
 * Each logical table (contacts, deals, …) is one row holding a JSONB document,
 * which mirrors the file store exactly — so every repository keeps working
 * without a single change. It persists properly on serverless hosts, where the
 * filesystem does not.
 *
 * If you later need per-row SQL (filtering, joins, indexes), individual
 * collections can be normalised into real tables one at a time; nothing else
 * in the app has to move.
 */

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

/** Loopback, by hostname — the one case where there is no TLS to negotiate. */
export function isLocal(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    // An unparseable URL is not something to guess about. Assuming TLS is the
    // safe direction: the worst case is a clear handshake error, rather than a
    // connection to a remote database in plain text.
    return false;
  }
}

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString,
      // Hosted Postgres (Neon, Supabase, Railway, RDS) terminates TLS at the
      // proxy with a certificate this client doesn't need to verify. A local
      // database has no TLS at all and refuses the handshake outright.
      //
      // Matched on the parsed hostname, not on the string containing
      // "localhost": the local dev database is reached at 127.0.0.1 and was
      // asked for SSL it does not speak, which surfaced as "the server does not
      // support SSL connections" and looked like a database fault rather than a
      // client assumption. Substring matching also says yes to a hosted name
      // that merely contains the word.
      ssl: isLocal(connectionString) ? undefined : { rejectUnauthorized: false },
      // Serverless-friendly: keep the pool small. Configurable because the
      // local dev database (PGlite over a socket) serves ONE connection at a
      // time — Next renders a layout and its page concurrently, so a pool of
      // three opened a second connection and the first was reset mid-query.
      // It surfaced as ECONNRESET from every page at once, which looks like a
      // database falling over rather than a pool sized for a different server.
      max: Number(process.env.PG_POOL_MAX ?? 3),
      // A hung query used to hang the request that issued it — nothing bounded
      // it. These turn a stalled database into a fast, visible failure rather
      // than a page that never returns.
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
  }
  return pool;
}

/**
 * Close the pool and forget it, so the next call builds a fresh one.
 *
 * Needed for an orderly shutdown: open sockets keep a Node process alive
 * indefinitely, which is why a test run that has touched the database appears
 * to pass and then hang instead of exiting.
 */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  ready = null;
  await current?.end();
}

/** Create the storage table once per process. */
function init(): Promise<void> {
  if (!ready) {
    ready = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS crm_collections (
           name       TEXT PRIMARY KEY,
           data       JSONB NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      )
      .then(() => undefined)
      .catch((err) => {
        ready = null; // let a later request retry
        throw err;
      });
  }
  return ready;
}

/** Read a collection, seeding it on first access. */
export async function dbRead<T>(name: string, seed: T[]): Promise<T[]> {
  await init();
  const { rows } = await getPool().query<{ data: T[] }>(
    "SELECT data FROM crm_collections WHERE name = $1",
    [name]
  );
  if (rows.length > 0) return rows[0].data;

  await dbWrite(name, seed);
  return seed;
}

/** Replace a collection's contents. */
export async function dbWrite<T>(name: string, rows: T[]): Promise<void> {
  await init();
  await getPool().query(
    `INSERT INTO crm_collections (name, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (name)
     DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [name, JSON.stringify(rows)]
  );
}

/**
 * Atomic read-modify-write for one collection.
 *
 * A plain read-then-write loses data under concurrency: two requests read the
 * same array and the second overwrites the first. This runs the whole cycle
 * inside a transaction holding an advisory lock on the collection name, so
 * writers are serialised. The advisory lock (rather than `SELECT … FOR UPDATE`)
 * also covers the case where the row does not exist yet.
 */
export async function dbMutate<T>(
  name: string,
  seed: T[],
  mutate: (rows: T[]) => T[] | Promise<T[]>
): Promise<T[]> {
  await init();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Held until COMMIT/ROLLBACK; serialises every writer of this collection.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);

    const { rows } = await client.query<{ data: T[] }>(
      "SELECT data FROM crm_collections WHERE name = $1",
      [name]
    );
    const current = rows.length > 0 ? rows[0].data : seed;
    const next = await mutate(current);

    await client.query(
      `INSERT INTO crm_collections (name, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (name)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [name, JSON.stringify(next)]
    );
    await client.query("COMMIT");
    return next;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** True when the app is *configured* to use Postgres. Says nothing about reachability. */
export function usingPostgres(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * Actually open a connection and run a query.
 *
 * `usingPostgres()` only checks that the env var exists — which is why the
 * health endpoint once reported "ok: postgres" while the database was in fact
 * unreachable. A health check that cannot detect a dead database is barely a
 * health check. This is the real probe.
 */
export async function pingDatabase(): Promise<
  { ok: true; ms: number } | { ok: false; error: string }
> {
  const started = Date.now();
  try {
    // Deliberately does NOT create anything. This used to call `init()`, which
    // issued `CREATE TABLE IF NOT EXISTS` — and Postgres checks the schema's
    // CREATE privilege before noticing the table already exists. That made the
    // health check fail for any role without CREATE, which is exactly the role
    // the application should be running as.
    const client = await getPool().connect();
    try {
      await client.query("SELECT 1");
      return { ok: true, ms: Date.now() - started };
    } finally {
      client.release();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type IsolationCheck = {
  role: string;
  /** True when the connecting role can see past every row-level policy. */
  bypassesRls: boolean;
  superuser: boolean;
  /** Tables with row-level security enabled. */
  protectedTables: number;
  ok: boolean;
};

/**
 * Can the role this app connects as actually be constrained by the policies?
 *
 * Found the hard way on 20 Aug: Neon grants `BYPASSRLS` to the database owner,
 * and the application was connecting as that owner. `BYPASSRLS` skips
 * row-level security outright — not "unless forced", not "unless the owner",
 * always — so every policy on the production database was inert while
 * `pg_class` cheerfully reported them enabled AND forced.
 *
 * That combination is invisible from inside the schema: everything looks
 * correct because everything IS correct, and the role simply is not subject to
 * it. Nothing short of asking the role about itself would have shown it.
 *
 * The repositories filter `sub_account_id` themselves, so isolation does not
 * depend on this — but the backstop is only a backstop if it is standing.
 */
export async function checkIsolation(): Promise<IsolationCheck> {
  const { rows } = await getPool().query<{
    rolname: string;
    rolbypassrls: boolean;
    rolsuper: boolean;
    protected_tables: string;
  }>(
    `SELECT r.rolname, r.rolbypassrls, r.rolsuper,
            (SELECT count(*) FROM pg_class c
             WHERE c.relrowsecurity AND c.relnamespace = 'public'::regnamespace)::text
              AS protected_tables
     FROM pg_roles r WHERE r.rolname = current_user`
  );

  const row = rows[0];
  const bypassesRls = row?.rolbypassrls ?? false;
  const superuser = row?.rolsuper ?? false;

  return {
    role: row?.rolname ?? "unknown",
    bypassesRls,
    superuser,
    protectedTables: Number(row?.protected_tables ?? 0),
    // Policies existing is not the same as policies applying. Both have to hold.
    ok: !bypassesRls && !superuser && Number(row?.protected_tables ?? 0) > 0,
  };
}

