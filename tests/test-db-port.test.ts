import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  /**
   * ONE CONNECTION, because there is one session behind it.
   *
   * This is the other half of the `ownership.test.ts` flake, and the half that
   * survived two previous diagnoses. That file would lose twelve tests at once,
   * roughly three runs in ten; it was filed as timing in September and fixed
   * with larger hook timeouts, then re-diagnosed as pool size and fixed again
   * with `PG_POOL_MAX=1` in `vitest.config.ts`. The rate fell and did not reach
   * zero, which is the signature of a cause that was half right.
   *
   * It was: `PG_POOL_MAX` stops the POOL opening a second connection, and the
   * socket server was separately configured to accept ten. The note attached to
   * that ten said queries are serialised inside the one WASM database, so
   * allowing more clients changed only what could be *attempted* — and that is
   * the sentence that was wrong. PGlite is a single SESSION, not merely a
   * single engine. Transaction state, the current role and the wire protocol's
   * own sequence all belong to that one session, so a second client interleaves
   * with the first rather than queueing behind it. The result is `Received
   * unexpected commandComplete message from backend`, then `Client has
   * encountered a connection error and is not queryable`, and then every
   * remaining test in the file at once.
   *
   * Asserted here because the obvious way to make this harness "support
   * concurrency" is to raise this number, and doing so reads like an
   * improvement right up until a whole file turns red once a fortnight.
   *
   * ── The three doors, and what each was worth ──────────────────────────────
   *
   * Measured, not reasoned, because two previous attempts were reasoned and
   * both were half right. Full-suite runs, failures out of total:
   *
   *   baseline (before this pass)                3/10
   *   all three doors shut                       0/30
   *
   * And on `ownership.test.ts` alone, isolating the seed path:
   *
   *   seeding in process                         4/10
   *   seeding over the socket                    1/10
   *
   * The three were this `maxConnections`, the in-process `db.exec` behind
   * `seed` (see `helpers/pg.ts`), and a test that stood up a SECOND PGlite
   * instance while this file's own was serving a live connection (see
   * `ownership.test.ts`). Each one is a way for something to touch the database
   * beside the single pooled connection, and the database has one session.
   */
  it("ACCEPTS ONE CLIENT AT A TIME, which is what the database is", () => {
    const helper = readFileSync(
      fileURLToPath(new URL("./helpers/pg.ts", import.meta.url)),
      "utf8"
    );
    expect(helper, "the test database server accepts more than one client").toMatch(
      /maxConnections: 1,/
    );
  });

  /**
   * And nothing reaches the database except through that one connection.
   *
   * `seed` used to run `db.exec` against the PGlite object directly, in
   * process. It does not look like a connection, which is exactly why it
   * outlived two diagnoses of this flake — but it is one, and it shares the
   * session the pool is using. Worth 4/10 → 1/10 on `ownership.test.ts` alone.
   */
  it("SEEDS THROUGH THE POOL, not past it", () => {
    const helper = readFileSync(
      fileURLToPath(new URL("./helpers/pg.ts", import.meta.url)),
      "utf8"
    );
    const seed = helper.slice(helper.indexOf("seed: async"), helper.indexOf("stop: async"));
    expect(seed, "seeding bypasses the pool and talks to PGlite in process").not.toMatch(
      /db\.exec\(/
    );
    expect(seed).toMatch(/getPool\(\)\.query\(sql\)/);
  });

  /**
   * And no test stands up a database of its own beside the shared one.
   *
   * One did: a whole second WASM Postgres, running the whole schema, inside a
   * test in a file whose own instance was serving a live socket. The failures
   * clustered on that file. `startTestDb` is the only way in.
   */
  it("starts NO SECOND DATABASE BESIDE the shared one", () => {
    /*
       BESIDE is the whole rule, and the reason this is not simply "no file may
       construct a PGlite".

       Two files do, legitimately, and neither is a second path: `rls-runtime`
       and `app-role-grants` drive PGlite in process and start no socket server
       at all. In-process is the only place `SET LOCAL ROLE` works, so it is the
       only place row-level security itself can be proven — see the note at the
       top of `helpers/pg.ts`. There is no first connection for them to race.
       What is forbidden is a file that calls `startTestDb()` — taking the
       shared instance and its live socket — and then builds another one too.
    */
    const dir = fileURLToPath(new URL(".", import.meta.url));
    /* Assembled rather than written out, so this file does not match its own
       search and report itself. */
    const CONSTRUCTS = new RegExp(["new", "PGlite", "\\("].join("\\s*"));

    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) => {
        const src = readFileSync(join(dir, f), "utf8");
        return /startTestDb\(/.test(src) && CONSTRUCTS.test(src);
      });

    expect(
      offenders,
      `these start their own PGlite beside the shared one: ${offenders.join(", ")}`
    ).toEqual([]);
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
