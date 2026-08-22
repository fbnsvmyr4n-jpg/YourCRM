import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "../src/server/auth";

/**
 * A local Postgres for development.
 *
 * Since the app moved off the file store it has needed a real database, and
 * there was not one on this machine — signing in locally returned a 500 with
 * "DATABASE_URL is not set", so every local check was really a check of the
 * login page. The alternative on offer was pointing dev at the production
 * connection string, which makes every experiment a production write.
 *
 * PGlite is the same engine the test suite runs against (Postgres 18, compiled
 * to WASM), served over a TCP socket so the real `pg` driver connects to it.
 * The data directory persists between runs, so a workspace created while
 * testing is still there tomorrow.
 *
 * It is NOT production-shaped in one respect, and it matters: PGlite's socket
 * server offers only its built-in superuser session, and superusers bypass
 * row-level security. Tenant isolation is therefore NOT enforced by the
 * database here — the repositories' own `sub_account_id` predicates are all
 * that scope a query. That is the stricter condition, so a leak visible here is
 * a real leak; a leak invisible here may still be caught by RLS in production.
 * The proof that RLS itself works lives in `tests/rls-runtime.test.ts`.
 *
 *   npm run dev:db
 */

const PORT = Number(process.env.DEV_DB_PORT ?? 5433);
const DATA_DIR = join(process.cwd(), ".dev-db");
const SCHEMA = readFileSync(join(process.cwd(), "src", "server", "schema.sql"), "utf8");

const DEMO = {
  agency: "ag-demo",
  primary: "sa-demo-primary",
  email: "demo@yourcrm.com",
  password: "demo1234",
};

async function main() {
  const db = await PGlite.create({ dataDir: DATA_DIR });

  // The schema is re-runnable, which is what makes this safe to do on every
  // start rather than only on first creation — a column added this afternoon
  // is present after a restart, with no reset step to forget.
  await db.exec(SCHEMA);

  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM users WHERE email = $1`,
    [DEMO.email]
  );

  if (rows[0]?.n === "0") {
    await db.query(
      `INSERT INTO agencies (id, name, plan, plan_status)
       VALUES ($1, 'Demo Agency', 'starter', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [DEMO.agency]
    );
    await db.query(
      `INSERT INTO sub_accounts (id, agency_id, name, is_primary)
       VALUES ($1, $2, 'Demo Agency', TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [DEMO.primary, DEMO.agency]
    );
    await db.query(
      `INSERT INTO users (id, agency_id, sub_account_id, name, email, password_hash, role)
       VALUES ('u-demo', $1, NULL, 'Demo Owner', $2, $3, 'owner')`,
      // sub_account_id NULL on purpose: the owner is agency staff, so they can
      // switch between clients. A pinned user would never see the switcher,
      // which is the thing most worth being able to try locally.
      [DEMO.agency, DEMO.email, hashPassword(DEMO.password)]
    );
    console.log(`seeded ${DEMO.email} / ${DEMO.password}`);
  }

  const server = new PGLiteSocketServer({
    db,
    port: PORT,
    host: "127.0.0.1",
    /**
     * The socket server accepts ONE connection by default and resets the
     * previous one when a second arrives. Next renders a layout and its page
     * concurrently, so every navigation opened two — and every page in the app
     * failed at once with ECONNRESET, which reads like the database falling
     * over rather than a server configured for a single client. Queries are
     * queued internally, so the single WASM database is still serialised.
     */
    maxConnections: 10,
  });
  await server.start();

  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  console.log(`dev database listening on ${PORT}`);
  console.log(`DATABASE_URL=${url}`);

  const stop = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
