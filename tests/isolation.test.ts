import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tenant isolation, enforced at the schema level.
 *
 * This product sells sub-accounts to agencies, so the database holds *other
 * people's customers' data*. A single table added without `sub_account_id`, or
 * with the column but no row-level policy, is a cross-tenant leak — the highest
 * severity failure this system can have.
 *
 * The audit's central lesson applies directly: 31 server actions shipped to
 * production without an authorisation check because the guard was something a
 * developer had to *remember*. This test removes the remembering. A new CRM
 * table that forgets tenancy fails CI before it can ever hold a row.
 *
 * Static, like the authorisation suite: no database, no server, milliseconds.
 * A runtime test proving Postgres actually refuses a cross-tenant read is a
 * separate, heavier suite — this one guarantees the schema *can* be enforced,
 * which is the precondition for that.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "src", "server", "schema.sql"), "utf8");

/** Tables that legitimately have no `sub_account_id`, each for a stated reason. */
const NOT_TENANT_SCOPED: Record<string, string> = {
  agencies: "level 1 — the tenant root itself",
  sub_accounts: "level 2 — scoped by agency_id, and is the thing others point at",
  users: "scoped by agency_id; sub_account_id is nullable for agency-wide staff",
  settings: "keyed BY sub_account_id as its primary key",
};

function tableNames(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
}

function tableBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
  if (start < 0) return "";
  // Bound at the statement terminator rather than guessing a length — the
  // authorisation suite passed on vulnerable code twice by slicing a fixed
  // window that ran into the next declaration.
  const end = sql.indexOf("\n);", start);
  return sql.slice(start, end < 0 ? undefined : end);
}

describe("the schema is discoverable", () => {
  it("finds the tables (a suite matching nothing proves nothing)", () => {
    expect(tableNames(SCHEMA).length).toBeGreaterThanOrEqual(10);
  });
});

describe("every CRM table is tenant-scoped", () => {
  for (const name of tableNames(SCHEMA)) {
    if (name in NOT_TENANT_SCOPED) continue;

    it(`${name} carries sub_account_id NOT NULL, cascading from its tenant`, () => {
      const body = tableBody(SCHEMA, name);
      expect(
        body,
        `${name} has no sub_account_id — every row in it would be visible to every customer`
      ).toMatch(/sub_account_id\s+TEXT\s+NOT NULL/);
      expect(
        body,
        `${name}.sub_account_id must reference sub_accounts and cascade, or deleting a client orphans its data`
      ).toMatch(/REFERENCES sub_accounts\(id\) ON DELETE CASCADE/);
    });

    it(`${name} indexes the tenant column`, () => {
      // Without this the tenant predicate is a sequential scan under a filter,
      // so one large customer degrades every other customer's queries.
      const re = new RegExp(`CREATE INDEX IF NOT EXISTS \\w+ ON ${name} \\(sub_account_id`);
      expect(re.test(SCHEMA), `${name} has no index leading with sub_account_id`).toBe(true);
    });
  }
});

describe("row-level security backs the application up", () => {
  for (const name of tableNames(SCHEMA)) {
    if (name in NOT_TENANT_SCOPED && name !== "settings") continue;

    it(`${name} has RLS enabled and an isolation policy`, () => {
      // Whitespace-tolerant: the schema aligns these statements in a column.
      const enabled = new RegExp(`ALTER TABLE\\s+${name}\\s+ENABLE ROW LEVEL SECURITY`);
      expect(
        enabled.test(SCHEMA),
        `${name} does not enable row-level security — isolation would rest entirely on every query remembering to filter`
      ).toBe(true);

      const policy = new RegExp(
        `CREATE POLICY ${name}_tenant_isolation ON ${name}[\\s\\S]*?WITH CHECK \\(sub_account_id = current_setting\\('app\\.sub_account_id', TRUE\\)\\)`
      );
      expect(
        policy.test(SCHEMA),
        `${name} has no tenant isolation policy with both USING and WITH CHECK`
      ).toBe(true);
    });
  }

  it("every policy checks writes as well as reads", () => {
    // USING alone filters SELECT but still permits INSERT/UPDATE of a row
    // belonging to another tenant. Both clauses are required.
    const policies = [...SCHEMA.matchAll(/CREATE POLICY (\w+) ON (\w+)([\s\S]*?);/g)];
    expect(policies.length).toBeGreaterThanOrEqual(8);
    for (const [, policyName, table, body] of policies) {
      expect(body, `policy ${policyName} on ${table} has no USING clause`).toMatch(/USING \(/);
      expect(body, `policy ${policyName} on ${table} has no WITH CHECK clause`).toMatch(/WITH CHECK \(/);
    }
  });
});

describe("money and deletion are modelled safely", () => {
  it("money is stored as integer cents, never a float", () => {
    expect(SCHEMA).not.toMatch(/\b(REAL|DOUBLE PRECISION|FLOAT)\b/);
    expect(SCHEMA).toMatch(/value_cents\s+BIGINT/);
  });

  it("CRM tables support soft delete", () => {
    // The audit found hard deletes with no undo and no tombstone on real
    // customer data — a record was destroyed during it and only partly restored.
    for (const name of ["contacts", "deals", "meetings", "companies", "messages", "calls"]) {
      expect(tableBody(SCHEMA, name), `${name} cannot be soft-deleted`).toMatch(/deleted_at\s+TIMESTAMPTZ/);
    }
  });
});

describe("the deal pipeline matches the documented sales process", () => {
  it("carries all six of Bradley's stages plus a terminal lost state", () => {
    const body = tableBody(SCHEMA, "deals");
    for (const stage of ["prospect", "discovery", "demo", "won", "delivery", "referral"]) {
      expect(body, `deal stage "${stage}" is missing from the pipeline`).toContain(`'${stage}'`);
    }
    // Not one of the six, but required: without a losing state, Win Rate is
    // won ÷ all deals, which falls every time a lead is added.
    expect(body, "deals have no terminal lost state").toContain("'lost'");
  });

  it("stores pain points on the deal, so Discovery can drive the Demo", () => {
    expect(tableBody(SCHEMA, "deals")).toMatch(/pain_points\s+JSONB/);
  });

  it("records who referred a deal, closing the loop back to Prospect", () => {
    expect(tableBody(SCHEMA, "deals")).toMatch(/referred_by_contact_id/);
  });
});

describe("leads are folded into contacts and deals", () => {
  /**
   * The old model kept `leads` and `contacts` as separate tables holding the
   * same human, joined only by matching their name. Two consequences, both
   * measured during the audit: the same person could exist twice with
   * divergent data, and revenue-by-source matched only 4 of 10 won deals
   * because a rename severed the link with no error.
   *
   * A lead is now not a record type at all. It is a *position*: a contact who
   * has an open deal. Nothing to duplicate, nothing to reconcile.
   */

  it("has no leads table to drift out of sync with contacts", () => {
    expect(
      tableNames(SCHEMA),
      "a `leads` table reintroduces the duplicate-person class of bug"
    ).not.toContain("leads");
  });

  it("attributes source on the deal, not by matching names", () => {
    const body = tableBody(SCHEMA, "deals");
    expect(body, "deals cannot be attributed to a source").toMatch(/source\s+TEXT\s+NOT NULL/);
    for (const src of ["google_ads", "facebook", "referral", "phone_call"]) {
      expect(body, `source "${src}" is missing`).toContain(`'${src}'`);
    }
  });

  it("does not store a lead's sales position on the contact", () => {
    // Stored status is what went stale. Whether someone is a lead or a client
    // is derived from their deals, the same rule the meetings model follows.
    const body = tableBody(SCHEMA, "contacts");
    expect(body, "contacts store a stage — it will disagree with the deal").not.toMatch(
      /^\s*(stage|status)\s+TEXT/m
    );
  });
});
