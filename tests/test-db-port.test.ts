import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDb } from "./helpers/pg";

/**
 * The harness must not fight the operating system for ports.
 *
 * Every repository suite starts its own Postgres on a TCP port. Those ports
 * used to be drawn from 49,000–57,999 — almost entirely inside the EPHEMERAL
 * range, the block the kernel hands out as the source port of outbound
 * connections. The harness was therefore competing with every socket on the
 * machine: a dev server talking to its database, a browser talking to
 * localhost, a simulator, any script holding a connection open.
 *
 * It failed exactly once, during a run made while a dev server, a browser and
 * an iOS simulator were all live, and it took a whole file down rather than a
 * single test — the signature of `beforeAll` throwing. It then passed eight
 * consecutive full runs, including one under thirty spinning processes on
 * fifteen cores, which is why this is a test and not a bug report: the failure
 * needs a busy machine, and CI is not reliably busy in the same way.
 *
 * A flaky suite is worse than a failing one. It teaches you to re-run instead
 * of to read, and every "verified" claim made against it is worth less.
 */

/**
 * Started once, up front, rather than inside the first assertion.
 *
 * Three real Postgres instances — WASM, each running the full schema — take
 * several seconds between them, and more than that when eighty other files are
 * running alongside. Written as a test body it blew the default five-second
 * limit under a full-suite run while passing comfortably on its own: this file
 * was briefly the flake it exists to prevent.
 *
 * Hoisting it also removes the ordering trap. The two assertions below both
 * read `dbs`, so with the setup inside the first one, a timeout there failed
 * the second for a completely unrelated reason.
 */
const dbs: TestDb[] = [];

beforeAll(async () => {
  /* Three, because one port landing low could be luck. */
  for (let i = 0; i < 3; i++) dbs.push(await startTestDb());
}, 60_000);

afterAll(async () => {
  await Promise.all(dbs.map((d) => d.stop()));
});

/** macOS's floor; Linux's is higher still (32,768), so this is the strict one. */
const EPHEMERAL_FLOOR = 49_152;

describe("the test database picks a port nothing else is being given", () => {
  it("agrees with what this kernel actually reports", () => {
    /* Read rather than remembered, so the constant above cannot quietly become
       wrong on a machine that is configured differently. */
    if (process.platform !== "darwin") return;
    const reported = Number(
      execFileSync("sysctl", ["-n", "net.inet.ip.portrange.first"], { encoding: "utf8" }).trim()
    );
    expect(reported).toBeGreaterThanOrEqual(EPHEMERAL_FLOOR);
  });

  it("stays below the ephemeral floor", () => {
    expect(dbs).toHaveLength(3);
    for (const db of dbs) {
      expect(db.port, `port ${db.port} is inside the ephemeral range`).toBeLessThan(
        EPHEMERAL_FLOOR
      );
      // And above the well-known/registered ports that real services sit on.
      expect(db.port).toBeGreaterThanOrEqual(20_000);
    }
  });

  it("gives every database its own port", () => {
    const ports = dbs.map((d) => d.port);
    expect(new Set(ports).size, "two databases shared a port").toBe(ports.length);
  });

  it("says what it tried when it cannot find one", () => {
    /**
     * The one time this fired, the message named neither the range nor the
     * number of attempts — so twelve red tests appeared in a file about
     * ownership with nothing pointing at the harness. A failure that cannot be
     * read is a failure that gets re-run instead of fixed.
     */
    const helper = readFileSync(
      fileURLToPath(new URL("./helpers/pg.ts", import.meta.url)),
      "utf8"
    );
    expect(helper).toMatch(/Could not find a free port for the test database after \$\{ATTEMPTS\} attempts/);
    expect(helper).toMatch(/in \$\{PORT_FLOOR\}-\$\{PORT_FLOOR \+ PORT_SPAN - 1\}/);
  });
});
