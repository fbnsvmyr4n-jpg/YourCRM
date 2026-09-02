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
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
