import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A throwaway Postgres for repository tests, shaped like production.
 *
 * Served over a TCP socket so the real `pg` driver connects to it, which means
 * the repos under test run through the actual pool and the actual `withTenant`
 * — not a stand-in. The alternative was exporting a test-only factory for the
 * querier, which would have put a hole in the exact guarantee its symbol brand
 * exists to provide, and left the tests exercising code that never ships.
 *
 * IMPORTANT — what this harness can and cannot prove.
 *
 * PGlite's socket server accepts only its built-in `postgres` session, which is
 * a superuser, and it refuses both `ALTER ROLE postgres NOSUPERUSER` and a
 * startup `role` option. Superusers bypass row-level security, so **RLS is not
 * in force here.** An early version of this file claimed otherwise; several
 * isolation assertions passed under it while the database was enforcing
 * nothing, which is the FORCE defect's exact shape a second time.
 *
 * So the two controls are proven in the two places each can be:
 *   - `rls-runtime.test.ts` drives PGlite in-process, where SET LOCAL ROLE
 *     works, and proves the database itself refuses cross-tenant access.
 *   - these repo tests prove the repositories' own `sub_account_id` predicates
 *     hold, with RLS switched off — the stricter of the two conditions, since
 *     it is exactly what a bypassing connection would face.
 *
 * Neither stands in for the other, and neither is claimed to.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "..", "src", "server", "schema.sql"), "utf8");

export const AGENCY = "ag_test";
export const TENANT_A = "sa_test_a";
export const TENANT_B = "sa_test_b";
export const USER_A = "u_test_a";

export type TestDb = {
  port: number;
  stop: () => Promise<void>;
  /** Run SQL as the superuser, bypassing RLS — for fixtures only, never assertions. */
  seed: (sql: string) => Promise<void>;
};

export async function startTestDb(): Promise<TestDb> {
  const db = await PGlite.create();
  await db.exec(SCHEMA);

  await db.exec(`
    CREATE ROLE app NOSUPERUSER;
    DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE %I OWNER TO app', t);
      END LOOP;
    END $$;
    ALTER ROLE postgres SET ROLE app;
  `);

  await db.exec(`
    INSERT INTO agencies (id, name) VALUES ('${AGENCY}', 'Test Agency');
    INSERT INTO sub_accounts (id, agency_id, name, is_primary) VALUES
      ('${TENANT_A}', '${AGENCY}', 'Tenant A', TRUE),
      ('${TENANT_B}', '${AGENCY}', 'Tenant B', FALSE);
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('${USER_A}', '${AGENCY}', '${TENANT_A}', 'a@test.local', 'x', 'Tester A', 'owner');
  `);

  // An ephemeral port: the suite must not collide with anything already bound,
  // and vitest may run files in parallel.
  const port = 49_000 + Math.floor(Math.random() * 9_000);
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();

  // `localhost` rather than the bind address on purpose: db.ts disables TLS
  // only for connection strings containing "localhost".
  process.env.DATABASE_URL = `postgresql://postgres@localhost:${port}/postgres`;

  return {
    port,
    seed: async (sql: string) => {
      await db.exec("RESET ROLE");
      await db.exec(sql);
    },
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
