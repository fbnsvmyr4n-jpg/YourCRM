import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * Per-record ownership.
 *
 * The defect this closes was verified before it was fixed: `owner_user_id` is a
 * foreign key to `users(id)`, which says the owner is a real user and says
 * nothing about whether they belong to this customer. A deal in agency A's
 * sub-account could be assigned to agency B's employee — and the reports layer
 * joins users to show the owner's NAME, so B's staff name rendered on A's
 * report. Row-level security does not catch it: the write targets a row in A's
 * own tenant and is legitimately allowed. Only the value is wrong.
 *
 * A foreign key cannot express the rule, because the tenant is on the row and
 * the agency is on the user, with sub_accounts in between. So it is a trigger —
 * enforced in the database for the same reason the policies are, rather than
 * living only in application code that an import script can bypass.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "src", "server", "schema.sql"), "utf8");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let deals: typeof import("../src/server/repos/deals");
let contacts: typeof import("../src/server/repos/contacts");
let analytics: typeof import("../src/server/analytics");
let closePool: typeof import("../src/server/db").closePool;

/** A user pinned to tenant A, one roaming the agency, and one in another agency. */
const PINNED = "u_own_pinned";
const ROAMING = "u_own_roaming";
const FOREIGN = "u_own_foreign";
/** Agency-wide staff at ANOTHER agency: the case only the agency check catches. */
const FOREIGN_ROAMING = "u_own_foreign_roaming";

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  deals = await import("../src/server/repos/deals");
  contacts = await import("../src/server/repos/contacts");
  analytics = await import("../src/server/analytics");

  await db.seed(`
    INSERT INTO agencies (id, name) VALUES ('ag_foreign', 'Someone Else') ON CONFLICT DO NOTHING;
    INSERT INTO sub_accounts (id, agency_id, name) VALUES ('sa_foreign', 'ag_foreign', 'Their HQ')
      ON CONFLICT DO NOTHING;
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('${PINNED}',  '${AGENCY}',   '${TENANT_A}', 'pinned@test.local',  'x', 'Pinned Person', 'member'),
      ('${ROAMING}', '${AGENCY}',   NULL,          'roaming@test.local', 'x', 'Agency Staff',  'admin'),
      ('${FOREIGN}', 'ag_foreign',  'sa_foreign',  'rival@test.local',   'x', 'Rival Employee','owner'),
      ('${FOREIGN_ROAMING}', 'ag_foreign', NULL,     'roamer@rival.test',  'x', 'Rival Roamer',  'admin')
    ON CONFLICT DO NOTHING;`);
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

beforeEach(() => db.seed(`DELETE FROM deals; DELETE FROM contacts;`));

const aDeal = () => inA((q) => deals.createDeal(q, { title: "Owned deal", valueCents: 100_000 }));

describe("an owner must belong to this tenant", () => {
  it("accepts somebody pinned to this sub-account", async () => {
    const d = await aDeal();
    const { record, error } = await inA((q) => deals.assignOwner(q, d.id, PINNED));
    expect(error).toBeUndefined();
    expect(record?.ownerUserId).toBe(PINNED);
  });

  it("accepts agency-wide staff, who are not pinned to one client", async () => {
    // Their sub_account_id is NULL by design: an agency's own people work
    // across the clients that agency manages.
    const d = await aDeal();
    const { record } = await inA((q) => deals.assignOwner(q, d.id, ROAMING));
    expect(record?.ownerUserId).toBe(ROAMING);
  });

  it("refuses another agency's employee, with a readable message", async () => {
    const d = await aDeal();
    const { record, error } = await inA((q) => deals.assignOwner(q, d.id, FOREIGN));
    expect(record).toBeUndefined();
    expect(error).toMatch(/not a member of this account/i);

    const still = await inA((q) => deals.getDeal(q, d.id));
    expect(still?.ownerUserId, "the assignment went through anyway").toBeNull();
  });

  it("refuses a user pinned to a DIFFERENT sub-account of the same agency", async () => {
    // Same agency is not close enough: sub-accounts are separate customers of
    // that agency, and their staff should not appear on each other's records.
    const d = await inB((q) => deals.createDeal(q, { title: "B's deal" }));
    const { error } = await inB((q) => deals.assignOwner(q, d.id, PINNED));
    expect(error).toMatch(/not a member/i);
  });

  it("refuses another agency's roaming staff — the case the agency check exists for", async () => {
    /**
     * The one a mutation caught my tests missing. Every other foreign user here
     * is pinned to a sub-account, so the sub-account predicate rejects them and
     * the agency predicate looks redundant. It is not: a user with a NULL
     * sub_account_id passes that clause by design — it is how an agency's own
     * staff work across their clients — so without the agency check, ANY
     * agency's roaming admin could own this customer's records.
     */
    const d = await aDeal();
    const { record, error } = await inA((q) => deals.assignOwner(q, d.id, FOREIGN_ROAMING));
    expect(record, "a rival agency's admin took ownership of this record").toBeUndefined();
    expect(error).toMatch(/not a member/i);
  });

  it("refuses a deleted user", async () => {
    const d = await aDeal();
    await db.seed(`UPDATE users SET deleted_at = now() WHERE id = '${PINNED}'`);
    const { error } = await inA((q) => deals.assignOwner(q, d.id, PINNED));
    expect(error, "a departed colleague can still be given work").toMatch(/not a member/i);
    await db.seed(`UPDATE users SET deleted_at = NULL WHERE id = '${PINNED}'`);
  });

  it("allows unassigning, always", async () => {
    const d = await aDeal();
    await inA((q) => deals.assignOwner(q, d.id, PINNED));
    const { record, error } = await inA((q) => deals.assignOwner(q, d.id, null));
    expect(error).toBeUndefined();
    expect(record?.ownerUserId).toBeNull();
  });

  it("applies to contacts as well as deals", async () => {
    const c = await inA((q) => contacts.createContact(q, { firstName: "Owned", lastName: "Contact" }));
    expect((await inA((q) => contacts.assignOwner(q, c.id, FOREIGN))).error).toMatch(/not a member/i);
    expect((await inA((q) => contacts.assignOwner(q, c.id, PINNED))).record?.ownerUserId).toBe(PINNED);
  });

  it("returns an error rather than throwing for a record that is not there", async () => {
    expect((await inA((q) => deals.assignOwner(q, "no-such-deal", PINNED))).error).toMatch(
      /no longer exists/i
    );
  });
});

describe("the rule is the database's, not the repository's", () => {
  /**
   * The distinction that matters. If this lived only in `assignOwner`, then a
   * bulk import, a migration script, or an endpoint written next year could
   * write the same bad row without going near it. The trigger is what makes
   * the rule true of the data rather than true of one function.
   */
  it("rejects a raw INSERT that names a foreign owner", async () => {
    const raw = new PGlite();
    await raw.exec(SCHEMA);
    await raw.exec(`
      INSERT INTO agencies (id,name) VALUES ('ag_1','One'),('ag_2','Two');
      INSERT INTO sub_accounts (id,agency_id,name) VALUES ('s1','ag_1','One HQ'),('s2','ag_2','Two HQ');
      INSERT INTO users (id,agency_id,sub_account_id,email,password_hash,name,role)
        VALUES ('outsider','ag_2','s2','x@y.z','x','Outsider','owner');`);

    await expect(
      raw.exec(`INSERT INTO deals (id,sub_account_id,owner_user_id,title,stage,source)
                VALUES ('d','s1','outsider','Theirs','won','other')`)
    ).rejects.toThrow(/does not belong to sub-account/i);
    await raw.close();
  });

  it("rejects an UPDATE that moves ownership out of the tenant", async () => {
    // Insert-time checking alone would leave the obvious back door open.
    const d = await aDeal();
    await inA((q) => deals.assignOwner(q, d.id, PINNED));
    await expect(
      db.seed(`UPDATE deals SET owner_user_id = '${FOREIGN}' WHERE id = '${d.id}'`)
    ).rejects.toThrow(/does not belong to sub-account/i);
  });

  it("guards contacts, deals and meetings alike", () => {
    for (const table of ["contacts", "deals", "meetings"]) {
      expect(
        new RegExp(`CREATE TRIGGER ${table}_owner_in_tenant`).test(SCHEMA),
        `${table} can be assigned an owner from another tenant`
      ).toBe(true);
    }
  });

  it("fires on UPDATE of the tenant column too, not only the owner", () => {
    // Moving a row between sub-accounts could otherwise carry an owner who is
    // valid where it came from and foreign where it lands.
    expect(SCHEMA).toMatch(/UPDATE OF owner_user_id, sub_account_id ON deals/);
  });
});

describe("ownership is usable, not just enforced", () => {
  it("lists everything assigned to one person", async () => {
    const mine = await aDeal();
    const theirs = await aDeal();
    await inA((q) => deals.assignOwner(q, mine.id, PINNED));
    await inA((q) => deals.assignOwner(q, theirs.id, ROAMING));

    const list = await inA((q) => deals.listByOwner(q, PINNED));
    expect(list.map((d) => d.id)).toEqual([mine.id]);
  });

  it("lists what nobody has picked up", async () => {
    // The unassigned pile is the useful half of this feature: it is the work
    // that will otherwise sit there because it is nobody's.
    const owned = await aDeal();
    const orphan = await aDeal();
    await inA((q) => deals.assignOwner(q, owned.id, PINNED));

    const unassigned = await inA((q) => deals.listByOwner(q, null));
    expect(unassigned.map((d) => d.id)).toEqual([orphan.id]);
  });

  it("never lists another tenant's records", async () => {
    const d = await inB((q) => deals.createDeal(q, { title: "B's" }));
    expect((await inA((q) => deals.listByOwner(q, null))).map((x) => x.id)).not.toContain(d.id);
  });
});

describe("the leak this closes", () => {
  it("cannot put another agency's employee name on this tenant's report", async () => {
    /**
     * The concrete consequence, tested end to end. The reports layer joins
     * users to name each owner; with a foreign owner allowed, a rival agency's
     * staff name appeared in this customer's owner breakdown.
     */
    const d1 = await aDeal();
    const d2 = await aDeal();
    await inA((q) => deals.assignOwner(q, d1.id, PINNED));
    await inA((q) => deals.assignOwner(q, d2.id, ROAMING));
    await inA((q) => deals.moveStage(q, d1.id, "won"));
    await inA((q) => deals.moveStage(q, d2.id, "won"));

    // The assignment that would have leaked is refused, so it cannot appear.
    expect((await inA((q) => deals.assignOwner(q, d1.id, FOREIGN))).error).toBeTruthy();

    const names = (await inA((q) => analytics.reportData(q))).owners.map((o) => o.name);
    expect(names, "another agency's employee is named on this report").not.toContain(
      "Rival Employee"
    );
    expect(names).toEqual(expect.arrayContaining(["Pinned Person", "Agency Staff"]));
  });
});
