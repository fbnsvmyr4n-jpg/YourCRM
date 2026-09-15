import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The application role's grants, rebuilt from the repository alone.
 *
 * Until 16 Sep 2026 they existed only in the production database. These tests
 * run the real schema on a real Postgres that has never seen production and
 * ask the database — not the file — what `yourcrm_app` can do.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "src", "server", "schema.sql"), "utf8");

async function freshDb(roleAttributes = "NOSUPERUSER NOBYPASSRLS") {
  const db = new PGlite();
  await db.exec(`CREATE ROLE yourcrm_app LOGIN ${roleAttributes};`);
  return db;
}

async function tablesMissing(db: PGlite, privilege: string): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
        AND NOT has_table_privilege('yourcrm_app', c.oid, $1)
      ORDER BY 1`,
    [privilege]
  );
  return rows.map((r) => r.t);
}

describe("the app role on a database built from the repository", () => {
  it("CAN READ AND WRITE EVERY TABLE", async () => {
    const db = await freshDb();
    await db.exec(SCHEMA);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`
    );
    expect(rows[0].n, "the schema created no tables, so this proves nothing").toBeGreaterThan(20);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(await tablesMissing(db, privilege), `tables without ${privilege}`).toEqual([]);
    }
    await db.close();
  });

  it("gets nothing beyond rows: no TRUNCATE, no triggers, no CREATE in the schema", async () => {
    const db = await freshDb();
    await db.exec(SCHEMA);
    const { rows: tables } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
    expect(await tablesMissing(db, "TRUNCATE")).toHaveLength(tables[0].n);
    expect(await tablesMissing(db, "TRIGGER")).toHaveLength(tables[0].n);
    const { rows } = await db.query<{ create: boolean; usage: boolean }>(
      `SELECT has_schema_privilege('yourcrm_app', 'public', 'CREATE') AS create,
              has_schema_privilege('yourcrm_app', 'public', 'USAGE')  AS usage`
    );
    expect(rows[0]).toEqual({ create: false, usage: true });
    await db.close();
  });

  it("A TABLE ADDED BY A LATER MIGRATION IS USABLE THE MOMENT IT EXISTS", async () => {
    // The grants block has to be last in the file, so anything appended after
    // it relies on the default privileges. This is that case.
    const db = await freshDb();
    await db.exec(SCHEMA);
    await db.exec(`CREATE TABLE later_feature (id TEXT PRIMARY KEY)`);
    expect(await tablesMissing(db, "SELECT")).toEqual([]);
    expect(await tablesMissing(db, "INSERT")).toEqual([]);
    await db.close();
  });

  it("is safe to run again, which db:migrate does on every deploy", async () => {
    const db = await freshDb();
    await db.exec(SCHEMA);
    await db.exec(SCHEMA);
    expect(await tablesMissing(db, "UPDATE")).toEqual([]);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_default_acl WHERE defaclacl::text LIKE '%yourcrm_app%'`
    );
    expect(rows[0].n, "re-running piled up duplicate default privileges").toBe(2);
    await db.close();
  });

  it("is still confined to one workspace by row-level security", async () => {
    const db = await freshDb();
    await db.exec(SCHEMA);
    await db.exec(`
      INSERT INTO agencies (id, name) VALUES ('ag', 'Agency');
      INSERT INTO sub_accounts (id, agency_id, name, is_primary) VALUES ('sa_1', 'ag', 'One', TRUE), ('sa_2', 'ag', 'Two', FALSE);
      INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES ('c1', 'sa_1', 'A', 'One'), ('c2', 'sa_2', 'B', 'Two');
    `);
    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE yourcrm_app");
    await db.query("SELECT set_config('app.sub_account_id', 'sa_1', true)");
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM contacts ORDER BY id`);
    await db.exec("ROLLBACK");
    expect(rows.map((r) => r.id)).toEqual(["c1"]);
    await db.close();
  });
});

describe("what the migration refuses", () => {
  it("REFUSES TO GRANT TO A ROLE THAT BYPASSES ROW-LEVEL SECURITY", async () => {
    // Granting would make every page load and every tenant see every other.
    const db = await freshDb("NOSUPERUSER BYPASSRLS");
    await expect(db.exec(SCHEMA)).rejects.toThrow(/BYPASSRLS/);
    await db.close();
  });

  it("applies cleanly to a database with no app role at all", async () => {
    const db = new PGlite();
    await expect(db.exec(SCHEMA)).resolves.toBeDefined();
    await db.close();
  });
});
