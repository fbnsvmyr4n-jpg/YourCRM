import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";

/**
 * Doing something to many records at once.
 *
 * There were no sort controls and no bulk actions on any of twelve screens —
 * invisible at ten records and unusable at five hundred, which is exactly what
 * a CSV import now produces on day one. The two arrived together for that
 * reason.
 *
 * Two properties matter more than the operations themselves. The statements are
 * single queries, so a failure cannot leave half a selection changed with
 * nothing to say which half. And every one filters the workspace itself: the
 * ids come from a browser, so an id from somewhere else has to match nothing
 * rather than be acted on.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let contacts: typeof import("../src/server/repos/contacts");
let companies: typeof import("../src/server/repos/companies");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (subAccountId: string) => ({
  agencyId: "ag_test",
  subAccountId,
  userId: USER_A,
  role: "owner" as const,
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  contacts = await import("../src/server/repos/contacts");
  companies = await import("../src/server/repos/companies");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM contacts; DELETE FROM companies;`));

const make = (tenant: string, name: string) =>
  withTenant(ctx(tenant), (q) =>
    contacts.createContact(q, {
      firstName: name,
      lastName: "X",
      email: null,
      phone: null,
      info: null,
    })
  );

describe("assigning many at once", () => {
  it("assigns every one and reports the count", async () => {
    const a = await make(TENANT_A, "Ana");
    const b = await make(TENANT_A, "Ben");

    const changed = await withTenant(ctx(TENANT_A), (q) =>
      contacts.bulkAssignOwner(q, [a.id, b.id], USER_A)
    );
    expect(changed).toBe(2);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.every((p) => p.ownerUserId === USER_A)).toBe(true);
  });

  it("unassigns when given nobody", async () => {
    const a = await make(TENANT_A, "Ana");
    await withTenant(ctx(TENANT_A), (q) => contacts.bulkAssignOwner(q, [a.id], USER_A));
    await withTenant(ctx(TENANT_A), (q) => contacts.bulkAssignOwner(q, [a.id], null));

    const [person] = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(person.ownerUserId).toBeNull();
  });

  it("changes nothing for an empty selection", async () => {
    expect(await withTenant(ctx(TENANT_A), (q) => contacts.bulkAssignOwner(q, [], USER_A))).toBe(0);
  });

  it("ignores an id from another workspace, and says how many it changed", async () => {
    /**
     * The ids arrive from a browser. Counting the selection rather than the
     * rows actually changed would report "2 updated" while one of them belonged
     * to a different customer and was untouched — a confident wrong number that
     * stops anybody checking.
     */
    const mine = await make(TENANT_A, "Mine");
    const theirs = await make(TENANT_B, "Theirs");

    const changed = await withTenant(ctx(TENANT_A), (q) =>
      contacts.bulkAssignOwner(q, [mine.id, theirs.id], USER_A)
    );
    expect(changed, "another workspace's contact was counted as changed").toBe(1);

    const other = await withTenant(ctx(TENANT_B), (q) => contacts.listContacts(q));
    expect(other[0].ownerUserId, "another workspace's contact was reassigned").toBeNull();
  });

  it("does not touch a contact that has already been removed", async () => {
    const a = await make(TENANT_A, "Ana");
    await withTenant(ctx(TENANT_A), (q) => contacts.deleteContact(q, a.id));
    expect(await withTenant(ctx(TENANT_A), (q) => contacts.bulkAssignOwner(q, [a.id], USER_A))).toBe(0);
  });
});

describe("moving many into a company", () => {
  it("moves them all", async () => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    const a = await make(TENANT_A, "Ana");
    const b = await make(TENANT_A, "Ben");

    const changed = await withTenant(ctx(TENANT_A), (q) =>
      contacts.bulkSetCompany(q, [a.id, b.id], co!.id)
    );
    expect(changed).toBe(2);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.every((p) => p.companyName === "Acme")).toBe(true);
  });

  it("takes them out of a company when given none", async () => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    const a = await make(TENANT_A, "Ana");
    await withTenant(ctx(TENANT_A), (q) => contacts.bulkSetCompany(q, [a.id], co!.id));
    await withTenant(ctx(TENANT_A), (q) => contacts.bulkSetCompany(q, [a.id], null));

    const [person] = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(person.companyId).toBeNull();
  });

  it("refuses a company from another workspace, changing nothing", async () => {
    /**
     * The dangerous one. Without checking, this would move a customer's
     * contacts into a stranger's company — a cross-tenant reference that every
     * later join follows, in bulk.
     */
    const theirs = await withTenant(ctx(TENANT_B), (q) => companies.findOrCreateCompany(q, "Theirs"));
    const mine = await make(TENANT_A, "Mine");

    const changed = await withTenant(ctx(TENANT_A), (q) =>
      contacts.bulkSetCompany(q, [mine.id], theirs!.id)
    );
    expect(changed, "contacts were moved into another workspace's company").toBe(0);

    const [person] = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(person.companyId).toBeNull();
  });

  it("refuses a company that has been removed", async () => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, co!.id));
    const a = await make(TENANT_A, "Ana");

    expect(await withTenant(ctx(TENANT_A), (q) => contacts.bulkSetCompany(q, [a.id], co!.id))).toBe(0);
  });
});

describe("removing many at once", () => {
  it("removes them and reports the count", async () => {
    const a = await make(TENANT_A, "Ana");
    const b = await make(TENANT_A, "Ben");
    const changed = await withTenant(ctx(TENANT_A), (q) =>
      contacts.bulkDeleteContacts(q, [a.id, b.id])
    );
    expect(changed).toBe(2);
    expect((await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q))).length).toBe(0);
  });

  it("is soft, so it can be undone", async () => {
    /**
     * The audit found a record destroyed and only partly reconstructed because
     * there was nothing to restore from. In bulk that risk is multiplied by the
     * size of the selection.
     */
    const a = await make(TENANT_A, "Ana");
    await withTenant(ctx(TENANT_A), (q) => contacts.bulkDeleteContacts(q, [a.id]));

    expect(await withTenant(ctx(TENANT_A), (q) => contacts.restoreContact(q, a.id))).toBe(true);
    expect((await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q))).length).toBe(1);
  });

  it("cannot reach another workspace", async () => {
    const theirs = await make(TENANT_B, "Theirs");
    expect(await withTenant(ctx(TENANT_A), (q) => contacts.bulkDeleteContacts(q, [theirs.id]))).toBe(0);
    expect((await withTenant(ctx(TENANT_B), (q) => contacts.listContacts(q))).length).toBe(1);
  });

  it("counts a second removal as nothing, so a double click is not an error", async () => {
    const a = await make(TENANT_A, "Ana");
    await withTenant(ctx(TENANT_A), (q) => contacts.bulkDeleteContacts(q, [a.id]));
    expect(await withTenant(ctx(TENANT_A), (q) => contacts.bulkDeleteContacts(q, [a.id]))).toBe(0);
  });
});

describe("the blast radius is bounded", () => {
  it("touches no more than the limit in one call", async () => {
    /**
     * Not a performance limit — these are single statements. It is a blast
     * radius: a mis-click on "select all" after importing five hundred
     * contacts should not be able to empty an entire book of business in one
     * request. Capped, the mistake is partial and obvious rather than total.
     */
    const { BULK_LIMIT } = contacts;
    expect(BULK_LIMIT).toBeGreaterThan(0);

    const made = [];
    for (let i = 0; i < 5; i++) made.push((await make(TENANT_A, `P${i}`)).id);

    // Padded far past the cap with ids that do not exist; only the real ones
    // inside the first `BULK_LIMIT` may be touched.
    const padded = [...made, ...Array.from({ length: BULK_LIMIT + 50 }, (_, i) => `ghost-${i}`)];
    const changed = await withTenant(ctx(TENANT_A), (q) =>
      contacts.bulkDeleteContacts(q, padded)
    );
    expect(changed).toBe(5);
  });

  it("ignores everything past the cap", async () => {
    const made = [];
    for (let i = 0; i < 3; i++) made.push((await make(TENANT_A, `P${i}`)).id);

    // The real ids sit past the cap, so none of them may be reached.
    const padded = [
      ...Array.from({ length: contacts.BULK_LIMIT }, (_, i) => `ghost-${i}`),
      ...made,
    ];
    const changed = await withTenant(ctx(TENANT_A), (q) =>
      contacts.bulkDeleteContacts(q, padded)
    );
    expect(changed, "the cap did not bound the statement").toBe(0);
    expect((await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q))).length).toBe(3);
  });
});
