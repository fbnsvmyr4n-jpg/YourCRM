import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Tests run in Node, not a browser.
 *
 * Still zero-infrastructure, but no longer database-free — that changed on
 * 18 Aug and the old note here saying "nothing touches a database" was left
 * stale for a few commits. The repository suites run against a real Postgres
 * 18 compiled to WebAssembly (PGlite), in-process: no server to start, no
 * container, no `.data` directory, nothing to install beyond `npm ci`. The
 * original rule is intact — the moment a test needs setup, it stops being run
 * — which is why an embedded database was the only acceptable way to test SQL.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // A guard test that silently matches nothing is worse than no test at all,
    // so a run that finds no files is a failure.
    passWithNoTests: false,

    /**
     * Room for a database that has to boot before it can answer.
     *
     * The defaults — 5s a test, 10s a hook — are sized for unit tests that do
     * arithmetic. Most of this suite is not that: twenty-eight files each start
     * their own Postgres, compiled to WebAssembly, and run the whole schema
     * against it in `beforeAll`. On an idle machine that takes a second or two
     * and the defaults are invisible.
     *
     * On a busy one they are not. A run made while a dev server, a browser and
     * an iOS simulator were live produced twelve red tests in a file about
     * ownership; the cause was `Hook timed out in 10000ms` — the harness had
     * not finished booting, and nothing in the output said so. It then passed
     * eight consecutive runs, which is how a real limit gets filed as "flaky"
     * and re-run instead of read.
     *
     * Reproduced deliberately, with thirty spinning processes and a few hundred
     * sockets churning, and it is these two numbers that fix it — not the port
     * range, which was a genuine defect but not this one.
     *
     * A ceiling is not a delay. Nothing here waits longer than the work takes;
     * this only changes the point at which the runner gives up on a machine
     * that is busy, and a test suite that reports the machine's load as a
     * product defect is worse than useless — it teaches you to distrust it.
     */
    testTimeout: 30_000,
    hookTimeout: 60_000,

    /**
     * ONE pooled connection, because the test database serves one session.
     *
     * This is the cause of the `ownership.test.ts` flake — twelve red tests in
     * a whole file, roughly one run in three, filed as timing since 2026-09-04
     * and blamed on the hook timeouts above. It is not timing. The suites talk
     * to PGlite through its socket server, which serves EXACTLY ONE session at
     * a time, while `db.ts` defaults the pool to three. So a second connection
     * opens while the first is mid-transaction, the two sessions tread on each
     * other, and every statement afterwards answers "current transaction is
     * aborted, commands ignored until end of transaction block" — which takes
     * the rest of the file down with it. `ownership.test.ts` is the usual
     * victim because it makes many short tenant transactions and several of
     * them deliberately fail.
     *
     * The identical fault was already diagnosed and fixed for local
     * development, where `.env.local` sets `PG_POOL_MAX=1` and the comment in
     * `db.ts` explains why: Next renders a layout and its page concurrently,
     * and the first connection was reset mid-query. The harness was never given
     * the same setting, so the bug survived in the one place whose job is to
     * catch bugs.
     *
     * Set here rather than in `helpers/pg.ts` so it is in place before any test
     * file imports `db.ts` and builds a pool.
     */
    env: { PG_POOL_MAX: "1" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
