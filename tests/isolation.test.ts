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
  password_resets:
    "pre-authentication: requested by somebody who cannot sign in, so there is " +
    "no tenant to scope to. Holds a hash and an expiry, never customer records.",
  login_attempts:
    "pre-authentication: rate limiting must work before the account is even " +
    "identified, which is the point of it. Holds a key and a counter.",
  plan_entitlements:
    "the published price list, not customer data. Identical rows for every " +
    "agency, keyed by (plan, feature), written by a migration and only read by " +
    "the app. Scoping it per tenant would meanevery customer carrying their " +
    "own copy of the pricing, which is how one of them ends up on last year's.",
  referral_credits:
    "billing, which belongs to the AGENCY — one level above sub-accounts, like " +
    "the plan and the Stripe customer. An agency's credit is not the property " +
    "of any one of its client workspaces, and scoping it to one would mean the " +
    "same balance appearing under whichever client happened to be selected. " +
    "Holds amounts and agency references; never customer records.",
  stripe_events:
    "a webhook arrives before anything has resolved which customer it belongs " +
    "to — that resolution is what the handler does. Holds a Stripe event id, a " +
    "type, a timestamp and a nullable agency reference; never customer records " +
    "and never anything from a card. It exists to make a redelivered event a " +
    "no-op, which is a platform-wide guarantee, not a per-tenant one.",
  voice_sessions:
    "pre-tenant: a telephony webhook arrives before anything has resolved which " +
    "customer the call belongs to — that resolution reads the dialled number and " +
    "happens when the call ENDS. Keyed by the provider's own call id, which is " +
    "unguessable and unique across the platform, read only by the webhook, and " +
    "deleted when the call finishes. It does hold what the caller said, so the " +
    "TTL sweep is not housekeeping — it is the thing that stops a transcript " +
    "outliving the conversation when a provider drops the final callback.",
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

describe("the price list stays a price list", () => {
  /**
   * `plan_entitlements` is exempt from tenancy because it holds no customer
   * data. That is a property of the table, not a promise — the moment it gains
   * an agency or sub-account column it IS customer data, sitting in a table
   * with no policy protecting it. So the exemption checks its own premise.
   */
  it("carries no per-customer identifier", () => {
    const body = tableBody(SCHEMA, "plan_entitlements");
    expect(body, "the price list is empty or missing").toContain("plan");
    expect(
      /\b(agency_id|sub_account_id|user_id|owner_user_id)\b/.test(body),
      "plan_entitlements gained a per-customer column; it is no longer a shared " +
        "price list and its exemption from tenant isolation no longer holds"
    ).toBe(false);
  });
});

describe("the credit ledger stays a ledger", () => {
  /**
   * `referral_credits` is exempt from tenancy because it is agency-level
   * billing. That holds only while it stays a ledger of amounts — a column
   * carrying a contact, a deal or anything from a workspace makes it customer
   * data sitting in a table with no policy over it.
   */
  it("holds amounts and agency references, nothing from a workspace", () => {
    const body = tableBody(SCHEMA, "referral_credits");
    expect(body).toContain("amount_cents");

    for (const column of ["contact", "deal", "meeting", "sub_account", "email", "phone"]) {
      expect(
        new RegExp(`\\b${column}\\w*\\s+(TEXT|JSONB|INTEGER|BIGINT)`, "i").test(body),
        `referral_credits gained a "${column}" column — it now holds workspace data, ` +
          `and its exemption from tenant isolation no longer holds`
      ).toBe(false);
    }
  });

  it("records a sign rather than a direction", () => {
    // One signed column, so an amount and a separate "is this a debit" flag
    // cannot disagree with each other.
    //
    // SQL comments are stripped first: the note explaining this decision
    // contains the very word the check looks for, so matching the raw text
    // failed on the comment that justifies it. Fourth time this shape has
    // caught a guard here.
    const body = tableBody(SCHEMA, "referral_credits").replace(/--[^\n]*/g, "");
    expect(body).toMatch(/amount_cents\s+BIGINT NOT NULL/);
    expect(body, "a separate direction column reintroduces the disagreement").not.toMatch(
      /\b(direction|is_debit|credit_type)\b/
    );
  });
});

describe("the billing event log stays a log", () => {
  /**
   * `stripe_events` is exempt from tenancy because it records deliveries, not
   * records. The exemption holds only while that is true — a column carrying
   * what a customer bought, or anything from an invoice, makes it customer data
   * sitting in a table with no policy over it.
   */
  it("holds identifiers and timing, nothing else", () => {
    const body = tableBody(SCHEMA, "stripe_events");
    expect(body, "the billing event log is missing").toContain("stripe_events");

    for (const column of ["amount", "invoice", "card", "payload", "body", "email", "receipt"]) {
      expect(
        new RegExp(`\\b${column}\\w*\\s+(TEXT|JSONB|INTEGER|NUMERIC)`, "i").test(body),
        `stripe_events gained a "${column}" column — it now holds billing detail, ` +
          `and its exemption from tenant isolation no longer holds`
      ).toBe(false);
    }
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

  it("forces the policies onto the table owner", () => {
    /**
     * The one that would have made all of this decorative.
     *
     * Postgres exempts a table's OWNER from row-level security. This app
     * connects to its database as the owner of its own schema, so with ENABLE
     * alone every policy is present, every test above passes, and no isolation
     * is enforced at runtime. There is no error and no log line — the only
     * symptom is one customer reading another's records.
     *
     * Exactly the audit's recurring root cause: asserting a verified state
     * from a proxy signal. "A policy exists" is not "isolation is enforced".
     */
    const enabled = [...SCHEMA.matchAll(/ALTER TABLE\s+(\w+)\s+ENABLE ROW LEVEL SECURITY/g)].map(
      (m) => m[1]
    );
    expect(enabled.length).toBeGreaterThanOrEqual(8);
    for (const table of enabled) {
      const forced = new RegExp(`ALTER TABLE\\s+${table}\\s+FORCE ROW LEVEL SECURITY`);
      expect(
        forced.test(SCHEMA),
        `${table} enables RLS but does not FORCE it — the owner, which is this application, bypasses every policy on it`
      ).toBe(true);
    }
  });

  it("every policy checks writes as well as reads", () => {
    // USING alone filters SELECT but still permits INSERT/UPDATE of a row
    // belonging to another tenant. Both clauses are required.
    const policies = [...SCHEMA.matchAll(/CREATE POLICY (\w+) ON (\w+)([\s\S]*?);/g)];
    // Tracks the schema rather than a number someone wrote once: every table
    // that enables RLS must have exactly one policy, so the two counts move
    // together and a new table cannot arrive with neither.
    const enabled = [...SCHEMA.matchAll(/ALTER TABLE\s+(\w+)\s+ENABLE ROW LEVEL SECURITY/g)];
    expect(policies.length, "a table enables RLS but has no policy").toBe(enabled.length);
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
