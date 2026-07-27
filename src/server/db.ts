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

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString,
      // Hosted Postgres (Neon, Supabase, Railway, RDS) terminates TLS at the
      // proxy with a certificate this client doesn't need to verify.
      ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
      max: 3, // serverless-friendly: keep the pool small
    });
  }
  return pool;
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

/** True when the app is configured to use Postgres. */
export function usingPostgres(): boolean {
  return !!process.env.DATABASE_URL;
}
