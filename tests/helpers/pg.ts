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

  /**
   * A free port, found by retrying rather than by hoping — and taken from a
   * range nothing else on the machine is being handed.
   *
   * This picked one at random from a 9,000-wide range and started the server
   * once. Vitest runs test files in parallel and each starts its own database,
   * so a collision was a matter of probability — roughly one run in a hundred
   * with this many suites, which is exactly the frequency that gets dismissed
   * as "flaky" and never investigated. One failure already appeared and did
   * not reproduce, which is what prompted the retry.
   *
   * The retry was only half of it. The range it drew from was 49,000–57,999,
   * which sits almost entirely inside the EPHEMERAL range — the block the
   * kernel hands out as the source port of outbound connections (49,152–65,535
   * on macOS; `sysctl net.inet.ip.portrange.first`). So the harness was
   * competing for ports with every outbound socket on the machine: the dev
   * server talking to Postgres, a browser talking to localhost, a simulator,
   * any script with a database connection open. The busier the machine, the
   * more of the candidate range was already taken.
   *
   * That is not a theoretical concern. It failed exactly once, during a run
   * made while a dev server, a browser and an iOS simulator were all live, and
   * it took the whole file down rather than one test — which is the signature
   * of `beforeAll` throwing, and the only thing here that throws is this loop
   * running out of attempts.
   *
   * Drawing from 20,000–39,999 puts every candidate below the ephemeral floor,
   * so the only thing that can collide is another test worker — which is
   * exactly what the retry below is good at, and a population of eighty-odd
   * files rather than every socket the machine happens to own.
   *
   * Retrying on EADDRINUSE turns a probabilistic failure into a deterministic
   * success.
   */
  /* Below macOS's ephemeral floor of 49,152, and above the range where common
     services sit. Verified against `net.inet.ip.portrange.first` rather than
     remembered. */
  const PORT_FLOOR = 20_000;
  const PORT_SPAN = 20_000;
  const ATTEMPTS = 40;

  let server: PGLiteSocketServer | null = null;
  let port = 0;
  for (let attempt = 0; attempt < ATTEMPTS && !server; attempt++) {
    port = PORT_FLOOR + Math.floor(Math.random() * PORT_SPAN);
    const candidate = new PGLiteSocketServer({
      db,
      port,
      host: "127.0.0.1",
      /**
       * The socket server accepts ONE connection by default and resets the
       * previous one when a second arrives.
       *
       * That makes concurrency untestable — and concurrency is exactly what
       * several of these repositories are written to survive. A test issuing
       * two simultaneous captures against one deal died with ECONNRESET, which
       * reads as a flaky harness rather than as a server configured for a
       * single client. Queries are still serialised inside the one WASM
       * database, so this changes what can be *attempted*, not what the
       * database does with it.
       */
      maxConnections: 10,
    });
    try {
      await candidate.start();
      server = candidate;
    } catch (err) {
      // Anything other than a busy port is a real failure worth surfacing.
      if (!String(err).includes("EADDRINUSE")) throw err;
    }
  }
  if (!server) {
    /* Says what was tried. The previous message named neither the range nor
       the count, so the one time this fired it looked like the repository
       under test had failed rather than the harness — twelve red tests in a
       file whose subject was ownership, and nothing pointing here. */
    throw new Error(
      `Could not find a free port for the test database after ${ATTEMPTS} attempts ` +
        `in ${PORT_FLOOR}-${PORT_FLOOR + PORT_SPAN - 1}.`
    );
  }

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
