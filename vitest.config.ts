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
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
