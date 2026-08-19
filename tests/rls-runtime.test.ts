import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Isolation, proven against a real Postgres rather than asserted about text.
 *
 * `isolation.test.ts` reads `schema.sql` with regexes. That is fast and it
 * catches a forgotten column, but it can only ever show that the schema *says*
 * the right thing — and this project has now been burned five separate times by
 * treating a proxy signal as a verified state. The FORCE defect is the sharpest
 * example: every static test was green while every policy was inert, because
 * "a policy is declared" and "a policy is enforced" are different facts.
 *
 * So this suite runs the actual schema on actual Postgres (PGlite: Postgres 18
 * compiled to WASM, in-process, no server and no binaries — it runs in CI
 * unchanged), creates two tenants, and makes the database answer the only
 * question that matters: when agency A asks for agency B's rows, what comes
 * back? It must be nothing, on read, on write, and on delete.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "src", "server", "schema.sql"), "utf8");

const A = "sa_alpha";
const B = "sa_beta";

/**
 * A database shaped like production: the application's role OWNS its tables.
 *
 * This is the detail the whole exercise turns on. Neon hands you a role that
 * owns the schema it creates, and Postgres exempts a table's owner from row
 * level security. Seeding happens as the superuser (which bypasses RLS, making
 * it a convenient fixture loader); every assertion runs as `app`, the owner,
 * which is exactly who the deployed application connects as.
 */
async function tenantDb(opts: { force?: boolean } = {}) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`CREATE ROLE app NOSUPERUSER;`);
  await db.exec(`
    DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE %I OWNER TO app', t);
      END LOOP;
    END $$;`);

  if (opts.force === false) {
    // Reproduces the defect found on 18 Aug, to prove it was real.
    await db.exec(`ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY;`);
  }

  // Seeded as superuser, so the fixture itself is not subject to the policies
  // under test — otherwise a broken policy would look like a broken fixture.
  await db.exec(`
    INSERT INTO agencies (id, name) VALUES ('ag_alpha', 'Alpha'), ('ag_beta', 'Beta');
    INSERT INTO sub_accounts (id, agency_id, name, is_primary) VALUES
      ('${A}', 'ag_alpha', 'Alpha HQ', TRUE),
      ('${B}', 'ag_beta',  'Beta HQ',  TRUE);
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('c_alpha', '${A}', 'Ada',   'Alpha', 'ada@alpha.test'),
      ('c_beta',  '${B}', 'Bruno', 'Beta',  'bruno@beta.test');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage, source) VALUES
      ('d_alpha', '${A}', 'c_alpha', 'Alpha deal', 500000, 'demo', 'referral'),
      ('d_beta',  '${B}', 'c_beta',  'Beta deal',  900000, 'won',  'facebook');
  `);
  return db;
}

/** Run SQL exactly as the app does: as `app`, inside one tenant-scoped transaction. */
async function asTenant<T = Record<string, unknown>>(
  db: PGlite,
  subAccountId: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app");
    await db.query("SELECT set_config('app.sub_account_id', $1, true)", [subAccountId]);
    const { rows } = await db.query<T>(sql, params);
    await db.exec("COMMIT");
    return rows;
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
}

describe("the schema runs on real Postgres", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await tenantDb();
  });

  it("applies cleanly, with every policy both enabled and forced", async () => {
    // A static test cannot tell you the file even parses.
    const { rows } = await db.query<{ relname: string; f: boolean }>(
      `SELECT relname, relforcerowsecurity AS f FROM pg_class
       WHERE relrowsecurity AND relnamespace = 'public'::regnamespace ORDER BY relname`
    );
    // Derived from the schema, not hardcoded: this used to say 8 and would have
    // silently under-checked the moment a ninth table arrived — which it just
    // did, when chat_messages was added.
    const declared = [...SCHEMA.matchAll(/ALTER TABLE\s+\w+\s+ENABLE ROW LEVEL SECURITY/g)].length;
    expect(rows.length, "a table declares RLS but Postgres does not report it").toBe(declared);
    expect(declared).toBeGreaterThanOrEqual(9);
    for (const r of rows) expect(r.f, `${r.relname} is not FORCEd`).toBe(true);
  });
});

describe("one tenant cannot reach another's data", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await tenantDb();
  });

  it("SELECT returns only the caller's rows", async () => {
    const alpha = await asTenant<{ id: string }>(db, A, "SELECT id FROM contacts");
    expect(alpha.map((r) => r.id)).toEqual(["c_alpha"]);

    const beta = await asTenant<{ id: string }>(db, B, "SELECT id FROM contacts");
    expect(beta.map((r) => r.id)).toEqual(["c_beta"]);
  });

  it("naming another tenant's row by primary key returns nothing", async () => {
    // The realistic attack: a guessed or leaked id pasted into a URL.
    const rows = await asTenant(db, A, "SELECT id FROM contacts WHERE id = 'c_beta'");
    expect(rows, "agency Alpha read agency Beta's contact by id").toEqual([]);
  });

  it("UPDATE cannot touch another tenant's row", async () => {
    await asTenant(db, A, "UPDATE contacts SET first_name = 'HACKED' WHERE id = 'c_beta'");
    const [beta] = await asTenant<{ first_name: string }>(
      db,
      B,
      "SELECT first_name FROM contacts WHERE id = 'c_beta'"
    );
    expect(beta.first_name, "another tenant modified this row").toBe("Bruno");
  });

  it("DELETE cannot remove another tenant's row", async () => {
    await asTenant(db, A, "DELETE FROM contacts WHERE id = 'c_beta'");
    const beta = await asTenant(db, B, "SELECT id FROM contacts WHERE id = 'c_beta'");
    expect(beta.length, "another tenant deleted this row").toBe(1);
  });

  it("INSERT cannot plant a row in another tenant", async () => {
    // WITH CHECK is what stops this. USING alone would allow it, and the row
    // would then be invisible to the tenant that created it and visible to the
    // victim — corruption that is very hard to trace back.
    await expect(
      asTenant(
        db,
        A,
        `INSERT INTO contacts (id, sub_account_id, first_name) VALUES ('c_planted', '${B}', 'Planted')`
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("aggregates cannot leak another tenant's revenue", async () => {
    // A count or a SUM that ignores the policy leaks commercially sensitive
    // figures without ever exposing a record.
    const [alpha] = await asTenant<{ total: string | null }>(
      db,
      A,
      "SELECT SUM(value_cents)::text AS total FROM deals"
    );
    expect(alpha.total, "Alpha's revenue total includes Beta's deals").toBe("500000");
  });
});

describe("with no tenant set, nothing is visible", () => {
  it("an unscoped query returns zero rows rather than everything", async () => {
    // Fail closed. `current_setting(..., TRUE)` yields NULL when unset, so the
    // policy matches nothing — a bug shows up as an empty screen, never as
    // somebody else's data.
    const db = await tenantDb();
    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE app");
    const { rows } = await db.query("SELECT id FROM contacts");
    await db.exec("COMMIT");
    expect(rows).toEqual([]);
  });
});

describe("BYPASSRLS defeats everything, reproduced", () => {
  it("a role with BYPASSRLS sees every tenant, FORCE or not", async () => {
    /**
     * Found on production, 20 Aug, and the reason stage 1 exists.
     *
     * Neon grants `BYPASSRLS` to the database owner — `neondb_owner` has
     * rolbypassrls = true. That attribute skips row-level security outright:
     * not "unless forced", not "unless the owner", but always. Every policy on
     * the production database was inert while the application connected as
     * that role, and `pg_class` still reported them enabled AND forced, which
     * is what made it invisible.
     *
     * The failure log had already recorded that BYPASSRLS roles skip policies.
     * Knowing the rule is not the same as checking whether the instance has
     * it — which is this project's most-repeated mistake, at one more level.
     *
     * Reproduced here so the mechanism is executable rather than folklore.
     */
    const db = await tenantDb();
    await db.exec(`CREATE ROLE bypasser NOSUPERUSER BYPASSRLS;`);
    await db.exec(`
      DO $$ DECLARE t text; BEGIN
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format('GRANT ALL ON %I TO bypasser', t);
        END LOOP;
      END $$;`);

    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE bypasser");
    await db.query("SELECT set_config('app.sub_account_id', $1, true)", [A]);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM contacts ORDER BY id");
    await db.exec("COMMIT");

    // Both tenants, despite a correct policy, FORCE set, and a tenant selected.
    expect(rows.map((r) => r.id)).toEqual(["c_alpha", "c_beta"]);
    await db.close();
  });

  it("the same role without BYPASSRLS is confined to its tenant", async () => {
    // The fix, stated as an assertion: it is the role attribute that matters,
    // so the application must connect as a role that does not have it.
    const db = await tenantDb();
    await db.exec(`CREATE ROLE confined NOSUPERUSER NOBYPASSRLS;`);
    await db.exec(`
      DO $$ DECLARE t text; BEGIN
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format('GRANT ALL ON %I TO confined', t);
        END LOOP;
      END $$;`);

    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE confined");
    await db.query("SELECT set_config('app.sub_account_id', $1, true)", [A]);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM contacts");
    await db.exec("COMMIT");

    expect(rows.map((r) => r.id)).toEqual(["c_alpha"]);
    await db.close();
  });
});

describe("the FORCE defect, reproduced", () => {
  it("without FORCE the policies are inert and every tenant sees everything", async () => {
    /**
     * Not a hypothetical. This is the schema exactly as it stood before 18 Aug:
     * policy present, RLS enabled, static tests green. The single missing word
     * is the difference between isolation and a full cross-tenant leak, and
     * nothing in the system would have reported it.
     *
     * Keeping the defect executable means the next person to wonder whether
     * FORCE is really necessary gets an answer in 200ms instead of an argument.
     */
    const db = await tenantDb({ force: false });
    const rows = await asTenant<{ id: string }>(db, A, "SELECT id FROM contacts ORDER BY id");
    expect(rows.map((r) => r.id)).toEqual(["c_alpha", "c_beta"]);
  });
});
