import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_COLUMNS, EXPECTED_TABLES } from "../src/server/schema-check";
import { startTestDb, type TestDb } from "./helpers/pg";

/**
 * The health check's idea of the schema matches the schema.
 *
 * A drift detector that has drifted is worse than none: it reports "ok" with
 * authority. `EXPECTED_TABLES` is a hand-written list because the health
 * endpoint cannot rely on reading a file from a serverless bundle — so the list
 * is pinned here, against the file itself.
 *
 * The failure this whole mechanism exists for: on 22 Aug 2026 three commits
 * changed the schema, the code deployed, and the schema did not. Production ran
 * new code against an old database and `/api/health` said "ok" throughout,
 * because it checked the connection and the policies and had no opinion about
 * the shape.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "src", "server", "schema.sql"), "utf8");

const declaredTables = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const declaredColumns = [
  ...SCHEMA.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g),
].map((m) => [m[1], m[2]] as [string, string]);

describe("the drift detector has not drifted", () => {
  it("reads the schema (a suite matching nothing proves nothing)", () => {
    expect(declaredTables.length).toBeGreaterThanOrEqual(15);
  });

  it("expects every table the schema declares", () => {
    // A new table absent from this list is a table whose absence in production
    // the health check would not notice — which is the exact failure it exists
    // to catch, reintroduced one table at a time.
    const missing = declaredTables.filter((t) => !(EXPECTED_TABLES as readonly string[]).includes(t));
    expect(
      missing,
      `schema.sql declares ${missing.join(", ")}, which the health check does not look for`
    ).toEqual([]);
  });

  it("expects no table the schema does not declare", () => {
    // The other direction. A stale entry means a permanently "degraded" health
    // check, which trains everybody to ignore it.
    const extra = (EXPECTED_TABLES as readonly string[]).filter(
      (t) => !declaredTables.includes(t)
    );
    expect(
      extra,
      `the health check expects ${extra.join(", ")}, which schema.sql no longer creates`
    ).toEqual([]);
  });

  it("expects every column added by an ALTER", () => {
    /**
     * These are the ones a stale database is most likely to be missing while
     * still having the table, so a table-only check would pass over exactly the
     * case that is hardest to spot.
     */
    const listed = new Set(EXPECTED_COLUMNS.map(([t, c]) => `${t}.${c}`));
    for (const [table, column] of declaredColumns) {
      expect(
        listed.has(`${table}.${column}`),
        `schema.sql adds ${table}.${column}, which the health check does not look for`
      ).toBe(true);
    }
  });

  it("lists no column the schema does not add", () => {
    const declared = new Set(declaredColumns.map(([t, c]) => `${t}.${c}`));
    for (const [table, column] of EXPECTED_COLUMNS) {
      expect(
        declared.has(`${table}.${column}`),
        `the health check expects ${table}.${column}, which schema.sql does not add`
      ).toBe(true);
    }
  });
});

describe("the check actually reports a stale database", () => {
  /**
   * The lists above are pinned to the file; this is the function that uses
   * them. Without it, `ok: true` hardcoded into `checkSchema` passes every
   * assertion in this file — a detector that cannot report a problem, which is
   * exactly the false green the whole mechanism exists to prevent.
   */
  let db: TestDb;
  let checkSchema: typeof import("../src/server/db").checkSchema;
  let closePool: typeof import("../src/server/db").closePool;

  beforeAll(async () => {
    db = await startTestDb();
    ({ checkSchema } = await import("../src/server/db"));
    ({ closePool } = await import("../src/server/db"));
  });

  afterAll(async () => {
    await closePool?.();
    await db.stop();
  });

  it("is ok against a database built from the schema", async () => {
    const result = await checkSchema();
    expect(result.missingTables).toEqual([]);
    expect(result.missingColumns).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names the missing table when one is absent", async () => {
    await db.seed(`DROP TABLE IF EXISTS stripe_events`);
    const result = await checkSchema();
    expect(result.ok, "a database missing a table reported as up to date").toBe(false);
    expect(result.missingTables).toContain("stripe_events");
    // Restored so the ordering of tests in this file cannot matter.
    await db.seed(SCHEMA);
  });

  it("names a missing column even when every table is present", async () => {
    // The harder case: the table is there and only the column added by a later
    // ALTER is missing, which is what a partially-migrated database looks like.
    await db.seed(`ALTER TABLE agencies DROP COLUMN IF EXISTS billing_synced_at`);
    const result = await checkSchema();
    expect(result.ok, "a database missing a column reported as up to date").toBe(false);
    expect(result.missingColumns).toContain("agencies.billing_synced_at");
    await db.seed(SCHEMA);
  });
});

describe("the schema can be applied to an existing database", () => {
  /**
   * `db:migrate` runs the whole file on every deploy, against a database that
   * already has most of it. That is only safe because every statement is
   * written to be re-runnable — and it is easy to add one that is not.
   */
  it("creates nothing without IF NOT EXISTS", () => {
    const creates = [...SCHEMA.matchAll(/^CREATE (TABLE|INDEX|UNIQUE INDEX)\s+(?!IF NOT EXISTS)/gim)];
    expect(
      creates.map((m) => m[0].trim()),
      "a CREATE without IF NOT EXISTS fails the second time the schema is applied"
    ).toEqual([]);
  });

  it("drops each policy before creating it", () => {
    // `CREATE POLICY` has no IF NOT EXISTS. Without the paired DROP, applying
    // the schema a second time fails partway through — and a schema half
    // applied is worse than one not applied, because nothing says which half.
    const policies = [...SCHEMA.matchAll(/CREATE POLICY (\w+)/g)].map((m) => m[1]);
    expect(policies.length, "no policies found — the detector is broken").toBeGreaterThan(0);
    for (const name of policies) {
      // Matched to a word boundary, not by substring. `DROP POLICY IF EXISTS
      // contacts_tenant_isolation_x` contains the text of the check for
      // `contacts_tenant_isolation`, so a renamed DROP passed while the policy
      // it was meant to remove went unhandled — the third time this exact
      // substring mistake has appeared in a guard on this project.
      const dropped = new RegExp(`DROP POLICY IF EXISTS ${name}\\b(?!_)`).test(SCHEMA);
      expect(
        dropped,
        `policy ${name} is created without being dropped first; re-applying the schema would fail`
      ).toBe(true);
    }
  });

  it("drops each policy exactly once", () => {
    /**
     * Two identical DROP lines are harmless to run and quietly defeat the check
     * above: renaming one still leaves the other, so a policy could lose its
     * paired DROP and this suite would not notice. They came from applying the
     * same "make it re-runnable" edit twice.
     */
    const drops = [...SCHEMA.matchAll(/^DROP POLICY IF EXISTS (\w+)/gm)].map((m) => m[1]);
    const seen = new Map<string, number>();
    for (const name of drops) seen.set(name, (seen.get(name) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    expect(duplicated, `dropped more than once: ${duplicated.join(", ")}`).toEqual([]);
    // And every drop belongs to a policy that is actually created.
    expect(drops.length).toBe([...SCHEMA.matchAll(/^CREATE POLICY/gm)].length);
  });

  it("adds columns only with IF NOT EXISTS", () => {
    const adds = [...SCHEMA.matchAll(/ADD COLUMN(?! IF NOT EXISTS)/g)];
    expect(adds.length, "an ADD COLUMN without IF NOT EXISTS breaks re-application").toBe(0);
  });
});
