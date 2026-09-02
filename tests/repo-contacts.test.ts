import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The contacts repository, against real Postgres, through the real code path.
 *
 * Nothing here is mocked: these calls open a genuine pooled connection, run
 * `withTenant`, and hit policies the database is enforcing. So a passing test
 * means the shipping code works, not that a test double agreed with itself.
 *
 * The isolation cases matter most. The audit's finding was never that the wrong
 * filter was written — it was that a filter *could be forgotten*, silently. A
 * repository proven to leak nothing even when it never mentions a tenant is the
 * only version of this that stays true as the code grows.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/contacts");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});

beforeAll(async () => {
  db = await startTestDb();
  // Imported after DATABASE_URL is set: the pool reads it when first built.
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/contacts");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

describe("creating and reading", () => {
  it("round-trips a contact", async () => {
    const made = await inA((q) =>
      repo.createContact(q, {
        firstName: "  Ada  ",
        lastName: "Lovelace",
        email: "ada@example.test",
        ownerUserId: USER_A,
      })
    );
    expect(made.firstName, "input was not trimmed").toBe("Ada");
    expect(made.id).toMatch(/^ada-lovelace-/);

    const read = await inA((q) => repo.getContact(q, made.id));
    expect(read?.email).toBe("ada@example.test");
  });

  it("stamps the tenant from the context, not from the caller", async () => {
    const made = await inA((q) => repo.createContact(q, { firstName: "Grace", lastName: "H" }));
    // Visible to A, invisible to B — the only observable definition of correct.
    expect(await inA((q) => repo.getContact(q, made.id))).not.toBeNull();
    expect(await inB((q) => repo.getContact(q, made.id))).toBeNull();
  });

  it("returns an empty list for a tenant with no contacts", async () => {
    // Not an error, and not somebody else's rows.
    expect(await inB((q) => repo.listContacts(q))).toEqual([]);
  });
});

describe("lead and client are derived, never stored", () => {
  it("a contact with no deals is neither", async () => {
    const c = await inA((q) => repo.createContact(q, { firstName: "New", lastName: "Person" }));
    const read = await inA((q) => repo.getContact(q, c.id));
    expect(read).toMatchObject({ isClient: false, hasOpenDeal: false });
  });

  it("an open deal makes them a lead", async () => {
    const c = await inA((q) => repo.createContact(q, { firstName: "Open", lastName: "Deal" }));
    await db.seed(
      `INSERT INTO deals (id, sub_account_id, contact_id, title, stage)
       VALUES ('d_open', '${TENANT_A}', '${c.id}', 'In play', 'discovery')`
    );
    const read = await inA((q) => repo.getContact(q, c.id));
    expect(read).toMatchObject({ hasOpenDeal: true, isClient: false });
  });

  it("a won deal makes them a client, and keeps them one after the deal moves on", async () => {
    /**
     * The reason `won_at` is the signal rather than the stage. Bradley's
     * process continues past the sale into Delivery and Referral; reading the
     * stage would make a client stop being one the moment their deal advanced,
     * which is exactly backwards.
     */
    const c = await inA((q) => repo.createContact(q, { firstName: "Paid", lastName: "Client" }));
    await db.seed(
      `INSERT INTO deals (id, sub_account_id, contact_id, title, stage, won_at)
       VALUES ('d_won', '${TENANT_A}', '${c.id}', 'Closed', 'won', now())`
    );
    expect(await inA((q) => repo.getContact(q, c.id))).toMatchObject({ isClient: true });

    await db.seed(`UPDATE deals SET stage = 'referral' WHERE id = 'd_won'`);
    const later = await inA((q) => repo.getContact(q, c.id));
    expect(later?.isClient, "a client stopped being one when their deal advanced").toBe(true);
    expect(later?.hasOpenDeal, "a post-close deal is not an open lead").toBe(false);
  });

  it("ignores a deleted deal when deriving", async () => {
    const c = await inA((q) => repo.createContact(q, { firstName: "Ghost", lastName: "Deal" }));
    await db.seed(
      `INSERT INTO deals (id, sub_account_id, contact_id, title, stage, deleted_at)
       VALUES ('d_gone', '${TENANT_A}', '${c.id}', 'Deleted', 'demo', now())`
    );
    expect(await inA((q) => repo.getContact(q, c.id))).toMatchObject({ hasOpenDeal: false });
  });
});

describe("updating", () => {
  it("changes only the fields it is given", async () => {
    const c = await inA((q) =>
      repo.createContact(q, {
        firstName: "Keep",
        lastName: "Fields",
        email: "keep@example.test",
        phone: "0100",
      })
    );
    const updated = await inA((q) => repo.updateContact(q, c.id, { firstName: "Changed" }));
    expect(updated?.firstName).toBe("Changed");
    expect(updated?.email, "an unmentioned field was blanked").toBe("keep@example.test");
    expect(updated?.phone, "an unmentioned field was blanked").toBe("0100");
  });

  it("clears a field when explicitly passed null", async () => {
    // The distinction a naive COALESCE loses: "leave it alone" and "empty it"
    // are different instructions and must stay different.
    const c = await inA((q) =>
      repo.createContact(q, { firstName: "Clear", lastName: "Me", phone: "0200" })
    );
    const updated = await inA((q) => repo.updateContact(q, c.id, { phone: null }));
    expect(updated?.phone).toBeNull();
  });

  it("returns null for a contact that is not this tenant's", async () => {
    const c = await inA((q) => repo.createContact(q, { firstName: "Not", lastName: "Yours" }));
    expect(await inB((q) => repo.updateContact(q, c.id, { firstName: "Stolen" }))).toBeNull();
    const still = await inA((q) => repo.getContact(q, c.id));
    expect(still?.firstName, "another tenant modified this record").toBe("Not");
  });
});

describe("deletion is soft and reversible", () => {
  it("hides the contact but keeps it recoverable", async () => {
    const c = await inA((q) => repo.createContact(q, { firstName: "Soft", lastName: "Delete" }));

    expect(await inA((q) => repo.deleteContact(q, c.id))).toBe(true);
    expect(await inA((q) => repo.getContact(q, c.id)), "a deleted contact is still readable").toBeNull();
    const list = await inA((q) => repo.listContacts(q));
    expect(list.some((x) => x.id === c.id), "a deleted contact still appears in the list").toBe(false);

    expect(await inA((q) => repo.restoreContact(q, c.id))).toBe(true);
    expect(await inA((q) => repo.getContact(q, c.id))).not.toBeNull();
  });

  it("reports false rather than throwing when there is nothing to delete", async () => {
    expect(await inA((q) => repo.deleteContact(q, "does-not-exist"))).toBe(false);
  });

  it("cannot delete another tenant's contact", async () => {
    const c = await inA((q) => repo.createContact(q, { firstName: "Safe", lastName: "Row" }));
    expect(await inB((q) => repo.deleteContact(q, c.id))).toBe(false);
    expect(await inA((q) => repo.getContact(q, c.id)), "another tenant deleted this record").not.toBeNull();
  });
});

describe("the tenant boundary holds at the repository", () => {
  it("lists only the caller's contacts", async () => {
    await inB((q) => repo.createContact(q, { firstName: "Beta", lastName: "Only" }));
    const a = await inA((q) => repo.listContacts(q));
    const b = await inB((q) => repo.listContacts(q));

    expect(b.map((x) => x.lastName)).toEqual(["Only"]);
    expect(a.some((x) => x.lastName === "Only"), "tenant A can see tenant B's contact").toBe(false);
    expect(a.length).toBeGreaterThan(0);
  });

  it("refuses to run at all without a tenant", async () => {
    await expect(
      withTenant({ ...ctxFor(TENANT_A), subAccountId: "" }, (q) => repo.listContacts(q))
    ).rejects.toThrow(/tenant/i);
  });
});
