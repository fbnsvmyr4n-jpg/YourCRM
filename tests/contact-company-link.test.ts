import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The Company field on a contact, and the screen two hops away that depended
 * on it without saying so.
 *
 * The defect this file exists for was invisible everywhere it was caused and
 * only visible somewhere else. Typing a company on a contact wrote the name
 * into a free-text column and left `company_id` null. The contact card then
 * displayed the name, so the person who typed it had every reason to believe
 * the contact was filed — while a deal takes its company FROM ITS CONTACT, so
 * the deal was filed under nobody, and Projects said "No projects yet" with
 * real work sitting in the pipeline.
 *
 * Three things are pinned here, because each one on its own would let the
 * defect back:
 *
 *   - typing a company LINKS the contact to that company record;
 *   - a name that already exists is matched, not duplicated;
 *   - a deal for that contact reaches Projects, which is the only place the
 *     whole chain can be observed to work.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let contacts: typeof import("../src/server/repos/contacts");
let companies: typeof import("../src/server/repos/companies");
let deals: typeof import("../src/server/repos/deals");
let view: typeof import("../src/server/projects-view");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  contacts = await import("../src/server/repos/contacts");
  companies = await import("../src/server/repos/companies");
  deals = await import("../src/server/repos/deals");
  view = await import("../src/server/projects-view");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;`)
);

/**
 * What the action does with the typed name, without a FormData round trip.
 *
 * The action itself is a `"use server"` module that resolves a session, so the
 * rule it applies is exercised here through the same repository call it makes.
 * The wiring — that the form's `company` field reaches this — is what the
 * browser pass covers.
 */
const fileUnder = (name: string) =>
  inA(async (q) => {
    const company = name.trim() ? await companies.findOrCreateCompany(q, name) : null;
    return company?.id ?? null;
  });

describe("typing a company on a contact", () => {
  it("files them under that company, not just next to its name", async () => {
    const companyId = await fileUnder("Stellenbosch Wines");
    const contact = await inA((q) =>
      contacts.createContact(q, {
        firstName: "Owen",
        lastName: "Blake",
        info: "Stellenbosch Wines",
        companyId,
      })
    );

    const row = await inA((q) =>
      q.one<{ company_id: string | null }>(`SELECT company_id FROM contacts WHERE id = $1`, [
        contact.id,
      ])
    );
    expect(row?.company_id, "the name was stored but the contact was filed nowhere").toBe(
      companyId
    );
    expect(companyId).toBeTruthy();
  });

  it("MATCHES a company that already exists, whatever the capitals", async () => {
    /* The case that was most misleading: a company by that exact name already
       existed — created moments earlier on the Companies screen — and the
       contact still was not filed under it. Two records with different
       capitals would be the same mess in a different place. */
    const first = await fileUnder("Stellenbosch Wines");
    const again = await fileUnder("stellenbosch wines");
    expect(again).toBe(first);

    const all = await inA((q) => companies.listCompanies(q));
    expect(all).toHaveLength(1);
    expect(all[0].name, "the first spelling wins").toBe("Stellenbosch Wines");
  });

  it("creates the company when the name is new", async () => {
    const id = await fileUnder("Brand New Client");
    expect(id).toBeTruthy();
    const all = await inA((q) => companies.listCompanies(q));
    expect(all.map((c) => c.name)).toEqual(["Brand New Client"]);
  });

  it("clears the link when the field is emptied", async () => {
    /* Somebody deleting the company name means the person no longer works
       there. Leaving them filed would keep their work on that client's page. */
    expect(await fileUnder("   ")).toBeNull();
    expect(await fileUnder("")).toBeNull();
  });

  it("never reaches another workspace's company of the same name", async () => {
    await inB((q) => companies.findOrCreateCompany(q, "Stellenbosch Wines"));
    const mine = await fileUnder("Stellenbosch Wines");

    const theirs = await inB((q) => companies.listCompanies(q));
    expect(theirs).toHaveLength(1);
    expect(mine, "one workspace was filed under another's company").not.toBe(theirs[0].id);
  });
});

describe("the chain from a typed name to the Projects page", () => {
  it("puts the deal on Projects once its contact has a company", async () => {
    /*
       The whole defect, end to end. Every step of this was already working
       except the first, and the first was invisible.
    */
    const companyId = await fileUnder("Stellenbosch Wines");
    const contact = await inA((q) =>
      contacts.createContact(q, { firstName: "Owen", lastName: "Blake", companyId })
    );
    await inA((q) => deals.createDeal(q, { title: "Rebuild warehouse", contactId: contact.id }));

    const grouped = view.groupByCompany(await inA((q) => view.listProjects(q)));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].name).toBe("Stellenbosch Wines");
    expect(grouped[0].live.map((p) => p.title)).toEqual(["Rebuild warehouse"]);
    expect(await inA((q) => view.countUnfiled(q))).toBe(0);
  });

  it("COUNTS the work that is not filed, instead of the page claiming there is none", async () => {
    /*
       What the page used to do with these: nothing, silently. It said "No
       projects yet" while the deal sat in the pipeline, and its only offered
       action — manage companies — could not have fixed it.
    */
    const contact = await inA((q) =>
      contacts.createContact(q, { firstName: "Owen", lastName: "Blake", info: "Stellenbosch Wines" })
    );
    await inA((q) => deals.createDeal(q, { title: "Rebuild warehouse", contactId: contact.id }));

    expect(view.groupByCompany(await inA((q) => view.listProjects(q)))).toHaveLength(0);
    expect(await inA((q) => view.countUnfiled(q))).toBe(1);
  });

  it("RE-FILES work that already existed when the contact is filed later", async () => {
    /*
       The half of the defect that made the other half useless.

       A deal's company is derived from its contact — but only ever at the
       moment the deal was made, and nothing applied it again. So somebody
       could correctly file a contact under a client and watch their existing
       work stay attached to nobody, with the Projects page still omitting a
       deal whose contact plainly had a company. The only remedy was to delete
       the deal and make it again.
    */
    const contact = await inA((q) =>
      contacts.createContact(q, { firstName: "Owen", lastName: "Blake" })
    );
    const deal = await inA((q) =>
      deals.createDeal(q, { title: "Rebuild warehouse", contactId: contact.id })
    );

    const companyId = await fileUnder("Stellenbosch Wines");
    await inA((q) => contacts.updateContact(q, contact.id, { companyId }));

    const row = await inA((q) =>
      q.one<{ company_id: string | null }>(`SELECT company_id FROM deals WHERE id = $1`, [deal.id])
    );
    expect(row?.company_id, "the deal stayed filed under nobody").toBe(companyId);
  });

  it("re-files through the bulk action too, not just the edit form", async () => {
    /* Enforced where the rule is stated rather than remembered at each call
       site — the list's "move to company" is the other way in. */
    const contact = await inA((q) =>
      contacts.createContact(q, { firstName: "Owen", lastName: "Blake" })
    );
    const deal = await inA((q) =>
      deals.createDeal(q, { title: "Rebuild warehouse", contactId: contact.id })
    );

    const companyId = await fileUnder("Stellenbosch Wines");
    await inA((q) => contacts.bulkSetCompany(q, [contact.id], companyId));

    expect(await inA((q) => view.countUnfiled(q))).toBe(0);
    expect(
      view.groupByCompany(await inA((q) => view.listProjects(q)))[0]?.live.map((p) => p.id)
    ).toEqual([deal.id]);
  });

  it("unfiles the work again when the contact leaves the company", async () => {
    /* The same rule in reverse. A person who no longer works there should not
       keep their old employer's project page populated. */
    const companyId = await fileUnder("Stellenbosch Wines");
    const contact = await inA((q) =>
      contacts.createContact(q, { firstName: "Owen", lastName: "Blake", companyId })
    );
    await inA((q) => deals.createDeal(q, { title: "Rebuild warehouse", contactId: contact.id }));
    expect(await inA((q) => view.countUnfiled(q))).toBe(0);

    await inA((q) => contacts.updateContact(q, contact.id, { companyId: null }));
    expect(await inA((q) => view.countUnfiled(q))).toBe(1);
  });

  it("stops counting it once the contact is filed", async () => {
    const contact = await inA((q) =>
      contacts.createContact(q, { firstName: "Owen", lastName: "Blake" })
    );
    await inA((q) => deals.createDeal(q, { title: "Rebuild warehouse", contactId: contact.id }));
    expect(await inA((q) => view.countUnfiled(q))).toBe(1);

    const companyId = await fileUnder("Stellenbosch Wines");
    await inA((q) => contacts.updateContact(q, contact.id, { companyId }));

    expect(await inA((q) => view.countUnfiled(q))).toBe(0);
    expect(view.groupByCompany(await inA((q) => view.listProjects(q)))).toHaveLength(1);
  });

  it("does not count a deal somebody deleted", async () => {
    const contact = await inA((q) => contacts.createContact(q, { firstName: "Owen", lastName: "Blake" }));
    const deal = await inA((q) =>
      deals.createDeal(q, { title: "Rebuild warehouse", contactId: contact.id })
    );
    expect(await inA((q) => view.countUnfiled(q))).toBe(1);

    await inA((q) => deals.deleteDeal(q, deal.id));
    expect(await inA((q) => view.countUnfiled(q))).toBe(0);
  });

  it("counts only this workspace's unfiled work", async () => {
    const mine = await inA((q) => contacts.createContact(q, { firstName: "Owen", lastName: "Blake" }));
    await inA((q) => deals.createDeal(q, { title: "Mine", contactId: mine.id }));
    const theirs = await inB((q) => contacts.createContact(q, { firstName: "Someone", lastName: "Else" }));
    await inB((q) => deals.createDeal(q, { title: "Theirs", contactId: theirs.id }));

    expect(await inA((q) => view.countUnfiled(q))).toBe(1);
    expect(await inB((q) => view.countUnfiled(q))).toBe(1);
  });
});
