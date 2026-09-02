import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * Recovery from a delete.
 *
 * Every delete in this product has been soft since the audit. Six entities
 * delete that way; five had a `restore*` function, and only one of those five
 * had a caller anywhere in the interface. The tombstones were being written and
 * nobody could reach them — the same shape as the pain-point defect, with a
 * worse consequence: a prospect deleted by mistake stayed gone as far as anyone
 * using the product could tell.
 *
 * These tests exercise the listing and the way back, and — more importantly —
 * the three ways this could be quietly wrong: showing another workspace's
 * deleted rows, restoring one from another workspace, and restoring something
 * that is not actually deleted.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let trash: typeof import("../src/server/trash");
let contacts: typeof import("../src/server/repos/contacts");
let companies: typeof import("../src/server/repos/companies");
let deals: typeof import("../src/server/repos/deals");
let meetings: typeof import("../src/server/repos/meetings");
let calls: typeof import("../src/server/repos/calls");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (subAccountId: string) => ({
  agencyId: "ag_test",
  subAccountId,
  userId: "u_test_a",
  role: "owner" as const,
});

const asA = <T>(fn: (q: import("../src/server/tenant").TenantQuery) => Promise<T>) =>
  withTenant(ctx(TENANT_A), fn);
const asB = <T>(fn: (q: import("../src/server/tenant").TenantQuery) => Promise<T>) =>
  withTenant(ctx(TENANT_B), fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  trash = await import("../src/server/trash");
  contacts = await import("../src/server/repos/contacts");
  companies = await import("../src/server/repos/companies");
  deals = await import("../src/server/repos/deals");
  meetings = await import("../src/server/repos/meetings");
  calls = await import("../src/server/repos/calls");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(
    `DELETE FROM calls; DELETE FROM messages; DELETE FROM meetings;
     DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;`
  )
);

describe("a deleted record is still there", () => {
  it("lists a deleted contact and puts it back", async () => {
    const person = await asA((q) =>
      contacts.createContact(q, { firstName: "Ana", lastName: "Silva", email: "ana@x.com" })
    );
    await asA((q) => contacts.deleteContact(q, person.id));

    expect(await asA((q) => contacts.listContacts(q))).toHaveLength(0);

    const items = await asA((q) => trash.listTrash(q));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("contact");
    expect(items[0].label).toBe("Ana Silva");

    expect(await asA((q) => trash.restoreFromTrash(q, "contact", person.id))).toBe(true);
    expect(await asA((q) => contacts.listContacts(q))).toHaveLength(1);
    expect(await asA((q) => trash.listTrash(q))).toHaveLength(0);
  });

  it("covers every kind that can be deleted", async () => {
    /**
     * The regression this guards. Companies had no restore function at all, and
     * it took enumerating the entities to notice — every other kind here had one
     * written and left unreachable. Adding a soft-deletable entity without
     * adding it to this list should fail.
     */
    const contact = await asA((q) => contacts.createContact(q, { firstName: "Bo", lastName: "Diaz" }));
    const company = await asA((q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    const deal = await asA((q) => deals.createDeal(q, { title: "Acme renewal", valueCents: 5000 }));
    const meeting = await asA((q) =>
      meetings.createMeeting(q, { topic: "Discovery", scheduledAt: new Date() })
    );
    const call = await asA((q) => calls.logCall(q, { callerName: "Unknown caller", phone: "+27 82" }));

    await asA((q) => contacts.deleteContact(q, contact.id));
    await asA((q) => companies.removeCompany(q, company!.id));
    await asA((q) => deals.deleteDeal(q, deal.id));
    await asA((q) => meetings.deleteMeeting(q, meeting.id));
    await asA((q) => calls.deleteCall(q, call.id));

    const items = await asA((q) => trash.listTrash(q));
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(trash.TRASH_KINDS));

    for (const item of items) {
      expect(
        await asA((q) => trash.restoreFromTrash(q, item.kind, item.id)),
        `${item.kind} could not be restored`
      ).toBe(true);
    }
    expect(await asA((q) => trash.listTrash(q))).toHaveLength(0);
  });

  it("names a record that has no name, rather than showing a blank row", async () => {
    // A row you cannot identify is a row you cannot decide about, which makes
    // the list useless exactly when the record was created carelessly.
    const nameless = await asA((q) => contacts.createContact(q, { firstName: "", lastName: "" }));
    await asA((q) => contacts.deleteContact(q, nameless.id));
    const [item] = await asA((q) => trash.listTrash(q));
    expect(item.label).toBe("Unnamed contact");
  });

  it("falls back to the email before giving up on a name", async () => {
    const byEmail = await asA((q) =>
      contacts.createContact(q, { firstName: "", lastName: "", email: "who@x.com" })
    );
    await asA((q) => contacts.deleteContact(q, byEmail.id));
    const [item] = await asA((q) => trash.listTrash(q));
    expect(item.label).toBe("who@x.com");
  });

  it("puts the most recent deletion first", async () => {
    // "I just deleted the wrong thing" is the whole use case; it must be the
    // top row, not somewhere in a list ordered by insertion.
    const first = await asA((q) => contacts.createContact(q, { firstName: "First", lastName: "X" }));
    const second = await asA((q) => contacts.createContact(q, { firstName: "Second", lastName: "X" }));
    await asA((q) => contacts.deleteContact(q, first.id));
    await db.seed(`UPDATE contacts SET deleted_at = now() - interval '1 hour' WHERE id = '${first.id}'`);
    await asA((q) => contacts.deleteContact(q, second.id));

    const items = await asA((q) => trash.listTrash(q));
    expect(items.map((i) => i.label)).toEqual(["Second X", "First X"]);
  });
});

describe("the list is one workspace's own", () => {
  it("never shows another workspace's deleted records", async () => {
    const theirs = await asB((q) => contacts.createContact(q, { firstName: "Their", lastName: "Client" }));
    await asB((q) => contacts.deleteContact(q, theirs.id));

    expect(await asA((q) => trash.listTrash(q))).toHaveLength(0);
    expect(await asA((q) => trash.trashCount(q))).toBe(0);
    expect(await asB((q) => trash.listTrash(q))).toHaveLength(1);
  });

  it("refuses to restore a record from another workspace", async () => {
    /**
     * The id arrives from a browser. Guessing one from another workspace must
     * change nothing and read exactly like a stale id, because a different
     * answer for "exists but is not yours" tells the guesser they guessed right.
     */
    const theirs = await asB((q) => contacts.createContact(q, { firstName: "Their", lastName: "Client" }));
    await asB((q) => contacts.deleteContact(q, theirs.id));

    expect(await asA((q) => trash.restoreFromTrash(q, "contact", theirs.id))).toBe(false);
    expect(await asB((q) => trash.listTrash(q)), "the record was restored by the wrong workspace")
      .toHaveLength(1);
  });
});

describe("restoring something that should not be restored", () => {
  it("says no to a record that was never deleted", async () => {
    const live = await asA((q) => contacts.createContact(q, { firstName: "Live", lastName: "One" }));
    expect(await asA((q) => trash.restoreFromTrash(q, "contact", live.id))).toBe(false);
  });

  it("says no to an id that does not exist", async () => {
    expect(await asA((q) => trash.restoreFromTrash(q, "deal", "c_nothing"))).toBe(false);
  });

  it("rejects a kind that is not one of ours", async () => {
    // The kind chooses a table. If an arbitrary string could reach the dispatch
    // table this would be the injection point, so it is validated first.
    expect(trash.isTrashKind("contact")).toBe(true);
    expect(trash.isTrashKind("users")).toBe(false);
    expect(trash.isTrashKind("contacts")).toBe(false);
    expect(trash.isTrashKind("")).toBe(false);
  });
});

describe("counting without loading", () => {
  it("counts every kind, and zero is zero rather than null", async () => {
    expect(await asA((q) => trash.trashCount(q))).toBe(0);

    const contact = await asA((q) => contacts.createContact(q, { firstName: "Cy", lastName: "Q" }));
    const deal = await asA((q) => deals.createDeal(q, { title: "Q deal" }));
    await asA((q) => contacts.deleteContact(q, contact.id));
    await asA((q) => deals.deleteDeal(q, deal.id));

    expect(await asA((q) => trash.trashCount(q))).toBe(2);
  });
});

describe("restoring a company", () => {
  it("brings the company back without silently re-attaching people", async () => {
    /**
     * Removing a company clears `company_id` on its members, so nothing records
     * who they were. Restoring cannot put them back, and the screen says so —
     * this test is what keeps that statement true. If restore ever did
     * re-attach, the copy would be a lie in the other direction.
     */
    const co = await asA((q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    const person = await asA((q) =>
      contacts.createContact(q, { firstName: "Ana", lastName: "Silva", companyId: co!.id })
    );

    await asA((q) => companies.removeCompany(q, co!.id));
    expect(await asA((q) => trash.restoreFromTrash(q, "company", co!.id))).toBe(true);

    const back = await asA((q) => companies.listCompanies(q));
    expect(back).toHaveLength(1);

    const restoredPerson = await asA((q) => contacts.getContact(q, person.id));
    expect(restoredPerson?.companyId, "the contact was re-attached by guesswork").toBeNull();
  });

  it("cannot be restored twice", async () => {
    // Restore filters `deleted_at IS NOT NULL`. Without that a double submit
    // would keep succeeding, and every "restored" toast after the first would
    // be reporting work that did not happen.
    const co = await asA((q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    await asA((q) => companies.removeCompany(q, co!.id));
    expect(await asA((q) => trash.restoreFromTrash(q, "company", co!.id))).toBe(true);
    expect(await asA((q) => trash.restoreFromTrash(q, "company", co!.id))).toBe(false);
  });
});
