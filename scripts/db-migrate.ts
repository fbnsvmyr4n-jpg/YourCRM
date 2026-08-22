import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

/**
 * Apply `schema.sql` to a database.
 *
 * This existed only in people's heads until 22 Aug 2026, and that is exactly
 * how it failed: three commits changed the schema, the code deployed, and the
 * schema did not — because nothing in the application applies it and nobody
 * remembered to. Production ran new code against an old schema, and
 * `plan_entitlements` — read on every Settings page load — was not there.
 *
 * The schema is written to be re-runnable: `CREATE TABLE IF NOT EXISTS`, every
 * `CREATE POLICY` preceded by a `DROP POLICY IF EXISTS`, `ADD COLUMN IF NOT
 * EXISTS`, and a backfill whose WHERE clause stops matching once it has run.
 * That is what makes running this on every deploy safe rather than merely
 * convenient.
 *
 *   npm run db:migrate                 # against DATABASE_URL
 *   npm run db:migrate -- --dry-run    # report the difference, change nothing
 *
 * Run it with the OWNING role's connection string, not the application's. The
 * app connects as a restricted role that deliberately cannot CREATE — which is
 * the point of it, and which means it cannot run this.
 */

const SCHEMA = readFileSync(join(process.cwd(), "src", "server", "schema.sql"), "utf8");
const dryRun = process.argv.includes("--dry-run");

/** Every table and column the schema file declares. */
function declared(sql: string): { tables: string[]; columns: string[] } {
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  const columns = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map(
    (m) => `${m[1]}.${m[2]}`
  );
  return { tables, columns };
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set. Point it at the database to migrate.");
    process.exit(1);
  }

  // Named without credentials. A migration script that prints its connection
  // string puts a password into every terminal scrollback and CI log.
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "unknown host";
    }
  })();
  console.log(`${dryRun ? "Checking" : "Migrating"} ${host}`);

  const client = new Client({
    connectionString: url,
    ssl: new URL(url).hostname.match(/^(localhost|127\.0\.0\.1|\[?::1\]?)$/)
      ? undefined
      : { rejectUnauthorized: false },
  });
  await client.connect();

  const { tables, columns } = declared(SCHEMA);

  const present = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  const have = new Set(present.rows.map((r) => r.table_name));
  const missingTables = tables.filter((t) => !have.has(t));

  const missingColumns: string[] = [];
  for (const spec of columns) {
    const [table, column] = spec.split(".");
    const found = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (found.rowCount === 0) missingColumns.push(spec);
  }

  if (missingTables.length === 0 && missingColumns.length === 0) {
    console.log(`Up to date — all ${tables.length} tables present.`);
  } else {
    if (missingTables.length) console.log(`Missing tables:  ${missingTables.join(", ")}`);
    if (missingColumns.length) console.log(`Missing columns: ${missingColumns.join(", ")}`);
  }

  if (dryRun) {
    console.log("Dry run — nothing was changed.");
    await client.end();
    return;
  }

  /**
   * One transaction. A schema half applied is worse than one not applied at
   * all: the code cannot tell which half it got, and the failure surfaces as a
   * missing column on one page rather than as a failed deploy.
   */
  try {
    await client.query("BEGIN");
    await client.query(SCHEMA);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`Failed — nothing was changed. ${(err as Error).message}`);
    await client.end();
    process.exit(1);
  }

  const after = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`
  );
  console.log(`Applied. ${after.rows[0].n} tables now present.`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
