import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Tests run in Node, not a browser.
 *
 * Nothing here touches a database. The suite is deliberately zero-infrastructure
 * so it can run on every commit without a server, a Postgres instance, or a
 * `.data` directory — the moment a test needs setup, it stops being run.
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
