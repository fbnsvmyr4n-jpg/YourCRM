import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * Companies as a real entity, not a string on a contact.
 *
 * The name lived in `contacts.info` — the same text repeated on every person
 * who worked there. Two consequences the audit called out:
 *
 *  - You cannot see every deal for one company. The only way to group them is
 *    to match text, and "Acme Ltd", "Acme Ltd." and "acme ltd" are three
 *    different companies to a string comparison.
 *  - A rename silently breaks the link. Correcting a spelling on one contact
 *    detaches them from their colleagues, with nothing to say it happened.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "src", "server", "schema.sql"), "utf8");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let companies: typeof import("../src/server/repos/companies");
let contacts: typeof import("../src/server/repos/contacts");
let deals: typeof import("../src/server/repos/deals");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (subAccountId: string) => ({
  agencyId: "ag_test",
  subAccountId,
  userId: "u_test_a",
  role: "owner" as const,
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  companies = await import("../src/server/repos/companies");
  contacts = await import("../src/server/repos/contacts");
  deals = await import("../src/server/repos/deals");
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;`));

describe("one company, however it is spelt", () => {
  it("creates it once and finds it again", async () => {
    const a = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    const b = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    expect(a?.id).toBe(b?.id);
    expect((await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q))).length).toBe(1);
  });

  it("matches regardless of case and surrounding space", async () => {
    /**
     * An import is where duplicate companies are born: five hundred rows whose
     * spreadsheet says "Acme Ltd" and "acme ltd" would otherwise arrive as two
     * companies, which is exactly the mess this entity exists to prevent.
     */
    const a = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    const b = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "  acme ltd  "));
    expect(b?.id, "the same company was created twice").toBe(a?.id);
  });

  it("keeps the first spelling", async () => {
    // A company whose name changes depending on who was added last is worse
    // than one that is slightly wrong.
    await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    const second = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "ACME LTD"));
    expect(second?.name).toBe("Acme Ltd");
  });

  it("creates nothing for a blank name", async () => {
    expect(await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "   "))).toBeNull();
    expect((await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q))).length).toBe(0);
  });

  it("keeps two workspaces' companies apart", async () => {
    // Two agencies both having a client called "Acme" is ordinary. Sharing the
    // row between them would be a cross-tenant leak of who they work with.
    const mine = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    const theirs = await withTenant(ctx(TENANT_B), (q) => companies.findOrCreateCompany(q, "Acme"));
    expect(theirs?.id, "two workspaces shared one company row").not.toBe(mine?.id);
    expect((await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q))).length).toBe(1);
  });
});

describe("renaming does not break the link", () => {
  it("renames it for everyone at once", async () => {
    /**
     * The defect this entity replaces. With the name repeated on each contact,
     * correcting one spelling detached that person from their colleagues — and
     * nothing indicated it had happened.
     */
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    for (const name of ["Ana", "Ben"]) {
      await withTenant(ctx(TENANT_A), (q) =>
        contacts.createContact(q, {
          firstName: name,
          lastName: "X",
          email: null,
          phone: null,
          info: null,
          companyId: co!.id,
        })
      );
    }

    await withTenant(ctx(TENANT_A), (q) => companies.renameCompany(q, co!.id, "Acme Limited"));

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.length).toBe(2);
    for (const p of people) {
      expect(p.companyName, "a rename detached somebody from their company").toBe("Acme Limited");
      expect(p.companyId).toBe(co!.id);
    }
  });

  it("refuses a blank name", async () => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    expect(await withTenant(ctx(TENANT_A), (q) => companies.renameCompany(q, co!.id, "  "))).toBeNull();
    expect((await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q)))[0].name).toBe("Acme");
  });

  it("cannot rename another workspace's company", async () => {
    const theirs = await withTenant(ctx(TENANT_B), (q) => companies.findOrCreateCompany(q, "Theirs"));
    const result = await withTenant(ctx(TENANT_A), (q) =>
      companies.renameCompany(q, theirs!.id, "Hijacked")
    );
    expect(result).toBeNull();
    expect((await withTenant(ctx(TENANT_B), (q) => companies.listCompanies(q)))[0].name).toBe("Theirs");
  });
});

describe("what a company is worth", () => {
  const seed = async (companyName: string, people: number) => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, companyName));
    const made = [];
    for (let i = 0; i < people; i++) {
      made.push(
        await withTenant(ctx(TENANT_A), (q) =>
          contacts.createContact(q, {
            firstName: `P${i}`,
            lastName: companyName,
            email: null,
            phone: null,
            info: null,
            companyId: co!.id,
          })
        )
      );
    }
    return { co: co!, people: made };
  };

  it("adds up deals across everyone who works there", async () => {
    /**
     * The question that could not be asked before. Deals reach a company
     * through the contact they belong to — a deal belongs to a person, and the
     * person belongs to a company.
     */
    const { co, people } = await seed("Acme", 2);
    const one = await withTenant(ctx(TENANT_A), (q) =>
      deals.createDeal(q, { contactId: people[0].id, title: "A", valueCents: 100000, stage: "demo" })
    );
    await withTenant(ctx(TENANT_A), (q) =>
      deals.createDeal(q, { contactId: people[1].id, title: "B", valueCents: 300000, stage: "demo" })
    );
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, one.id, "won"));

    const [rollup] = await withTenant(ctx(TENANT_A), (q) => companies.companyRollups(q));
    expect(rollup.id).toBe(co.id);
    expect(rollup.contacts).toBe(2);
    expect(rollup.wonCents).toBe(100000);
    expect(rollup.openCents, "an open deal at the same company was missed").toBe(300000);
    expect(rollup.openDeals).toBe(1);
  });

  it("counts a lost deal as neither won nor open", async () => {
    // Counted as pipeline it would sit in the total forever.
    const { people } = await seed("Acme", 1);
    const d = await withTenant(ctx(TENANT_A), (q) =>
      deals.createDeal(q, { contactId: people[0].id, title: "A", valueCents: 500000, stage: "demo" })
    );
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, d.id, "lost", { lostReason: "budget" }));

    const [rollup] = await withTenant(ctx(TENANT_A), (q) => companies.companyRollups(q));
    expect(rollup.wonCents).toBe(0);
    expect(rollup.openCents).toBe(0);
    expect(rollup.openDeals).toBe(0);
  });

  it("shows a company with nobody at it yet", async () => {
    // Dropping it makes a company vanish the moment its only contact goes,
    // which reads as the company having been deleted.
    await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Empty Co"));
    const rollups = await withTenant(ctx(TENANT_A), (q) => companies.companyRollups(q));
    expect(rollups.length).toBe(1);
    expect(rollups[0].contacts).toBe(0);
  });

  it("does not count one person twice for having two deals", async () => {
    // The join fans out: two deals for one contact would otherwise report two
    // contacts at the company.
    const { people } = await seed("Acme", 1);
    for (const t of ["A", "B"]) {
      await withTenant(ctx(TENANT_A), (q) =>
        deals.createDeal(q, { contactId: people[0].id, title: t, valueCents: 100000, stage: "demo" })
      );
    }
    const [rollup] = await withTenant(ctx(TENANT_A), (q) => companies.companyRollups(q));
    expect(rollup.contacts, "the join fanned out and double-counted people").toBe(1);
    expect(rollup.openDeals).toBe(2);
  });

  it("ranks the company that has paid most first", async () => {
    const small = await seed("Small Co", 1);
    const big = await seed("Big Co", 1);
    const a = await withTenant(ctx(TENANT_A), (q) =>
      deals.createDeal(q, { contactId: small.people[0].id, title: "s", valueCents: 100000, stage: "demo" })
    );
    const b = await withTenant(ctx(TENANT_A), (q) =>
      deals.createDeal(q, { contactId: big.people[0].id, title: "b", valueCents: 900000, stage: "demo" })
    );
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, a.id, "won"));
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, b.id, "won"));

    const rollups = await withTenant(ctx(TENANT_A), (q) => companies.companyRollups(q));
    expect(rollups[0].name).toBe("Big Co");
  });

  it("never reaches another workspace", async () => {
    const theirs = await withTenant(ctx(TENANT_B), (q) => companies.findOrCreateCompany(q, "Theirs"));
    await withTenant(ctx(TENANT_B), (q) =>
      contacts.createContact(q, {
        firstName: "Their",
        lastName: "Person",
        email: null,
        phone: null,
        info: null,
        companyId: theirs!.id,
      })
    );
    await seed("Mine", 1);

    const mine = await withTenant(ctx(TENANT_A), (q) => companies.companyRollups(q));
    expect(mine.length).toBe(1);
    expect(mine[0].name).toBe("Mine");
  });
});

describe("the backfill turns old text into real companies", () => {
  it("creates one company per distinct name and links the contacts", async () => {
    /**
     * Every contact created before this had its company as text on the record.
     * Left alone they would sit outside the entity entirely — present in the
     * CRM, absent from every company total.
     */
    await db.seed(`
      INSERT INTO contacts (id, sub_account_id, first_name, last_name, info) VALUES
        ('c1', '${TENANT_A}', 'Ana', 'S', 'Acme Ltd'),
        ('c2', '${TENANT_A}', 'Ben', 'C', 'acme ltd'),
        ('c3', '${TENANT_A}', 'Cher', 'D', 'Other Co'),
        ('c4', '${TENANT_A}', 'Dee', 'E', '')
    `);
    await db.seed(SCHEMA);

    const list = await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q));
    expect(list.map((c) => c.name).sort(), "spellings were not merged").toEqual([
      "Acme Ltd",
      "Other Co",
    ]);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    const acme = people.filter((p) => p.companyName === "Acme Ltd");
    expect(acme.length, "the two spellings did not land on one company").toBe(2);
    expect(people.find((p) => p.firstName === "Dee")?.companyId).toBeNull();
  });

  it("does not run twice", async () => {
    // Re-applying the schema is what every deploy does. A backfill that is not
    // self-limiting would create a second company on each one.
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name, info)
       VALUES ('c1', '${TENANT_A}', 'Ana', 'S', 'Acme Ltd')`
    );
    await db.seed(SCHEMA);
    await db.seed(SCHEMA);

    const list = await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q));
    expect(list.length, "the backfill ran again and duplicated the company").toBe(1);
  });

  it("does not re-link a contact somebody has already moved", async () => {
    /**
     * `info` is stale the moment somebody corrects a contact's company by
     * hand. Without the `company_id IS NULL` guard, the next deploy would drag
     * them back to whatever the old text said — silently undoing the fix, and
     * doing it again every deploy.
     */
    const right = await withTenant(ctx(TENANT_A), (q) =>
      companies.findOrCreateCompany(q, "Where They Actually Work")
    );
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name, info, company_id)
       VALUES ('c1', '${TENANT_A}', 'Ana', 'S', 'Old Wrong Name', '${right!.id}')`
    );
    await db.seed(SCHEMA);

    const [person] = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(
      person.companyName,
      "the backfill overwrote a company somebody had corrected by hand"
    ).toBe("Where They Actually Work");

    // And the stale text must not conjure a company of its own. An orphan
    // nobody works at, appearing in every company list, from a name that was
    // already known to be wrong.
    const list = await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q));
    expect(
      list.map((c) => c.name),
      "the backfill created a company from a contact's stale text"
    ).toEqual(["Where They Actually Work"]);
  });

  it("leaves the original text in place", async () => {
    // The only copy if this is ever reverted. Clearing it would destroy it.
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name, info)
       VALUES ('c1', '${TENANT_A}', 'Ana', 'S', 'Acme Ltd')`
    );
    await db.seed(SCHEMA);
    const [person] = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(person.info).toBe("Acme Ltd");
  });

  it("keeps two workspaces' identical names separate", async () => {
    await db.seed(`
      INSERT INTO contacts (id, sub_account_id, first_name, last_name, info) VALUES
        ('c1', '${TENANT_A}', 'Ana', 'S', 'Acme Ltd'),
        ('c2', '${TENANT_B}', 'Ben', 'C', 'Acme Ltd')
    `);
    await db.seed(SCHEMA);

    const a = await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q));
    const b = await withTenant(ctx(TENANT_B), (q) => companies.listCompanies(q));
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0].id, "two workspaces were given the same company row").not.toBe(b[0].id);

    /**
     * And each contact points at their OWN workspace's row.
     *
     * Counting the companies is not enough: the link is made by a separate
     * UPDATE, and without matching the workspace there it can attach one
     * customer's contact to another customer's company — a cross-tenant
     * reference that every later join then follows.
     */
    const theirPerson = await withTenant(ctx(TENANT_B), (q) => contacts.listContacts(q));
    expect(theirPerson[0].companyId, "a contact was linked across workspaces").toBe(b[0].id);
    const myPerson = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(myPerson[0].companyId).toBe(a[0].id);
  });
});

describe("removing a company", () => {
  it("takes it off the list and detaches the people, keeping them", async () => {
    /**
     * Soft, and the contacts keep every record. The first thing anybody does
     * with the management screen is clear out rows that were never companies —
     * the backfill turned an overloaded text column into both — and "I removed
     * the wrong one" has to be survivable.
     */
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Notes Not A Company"));
    await withTenant(ctx(TENANT_A), (q) =>
      contacts.createContact(q, {
        firstName: "Ana",
        lastName: "S",
        email: null,
        phone: null,
        info: "Notes Not A Company",
        companyId: co!.id,
      })
    );

    expect(await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, co!.id))).toBe(true);

    expect((await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q))).length).toBe(0);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.length, "removing a company deleted its contacts").toBe(1);
    expect(people[0].companyId, "the contact still points at a removed company").toBeNull();
    expect(people[0].companyName).toBeNull();
    // The original text is the only copy left. Clearing it would destroy it.
    expect(people[0].info).toBe("Notes Not A Company");
  });

  it("keeps the row, so a removal can be undone", async () => {
    /**
     * Soft is the whole promise. Somebody clearing twenty rows that were never
     * companies will remove one that was, and a hard delete makes that
     * permanent — the row is gone and the contacts that pointed at it have had
     * the link nulled, so there is nothing left to restore from.
     */
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, co!.id));

    const row = await withTenant(ctx(TENANT_A), (q) =>
      q.one<{ id: string; deleted_at: Date | null }>(
        `SELECT id, deleted_at FROM companies WHERE id = $2 AND sub_account_id = $1`,
        [TENANT_A, co!.id]
      )
    );
    expect(row, "the company was deleted outright rather than marked removed").not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
  });

  it("does not take the money off the deals", async () => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    const person = await withTenant(ctx(TENANT_A), (q) =>
      contacts.createContact(q, {
        firstName: "Ana", lastName: "S", email: null, phone: null, info: null, companyId: co!.id,
      })
    );
    const d = await withTenant(ctx(TENANT_A), (q) =>
      deals.createDeal(q, { contactId: person.id, title: "A", valueCents: 500000, stage: "demo" })
    );
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, d.id, "won"));

    await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, co!.id));

    const all = await withTenant(ctx(TENANT_A), (q) => deals.listDeals(q));
    expect(all.length, "removing a company deleted its deals").toBe(1);
    expect(all[0].valueCents).toBe(500000);
    expect(all[0].wonAt).not.toBeNull();
  });

  it("refuses twice, so a double click is not an error the second time", async () => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    expect(await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, co!.id))).toBe(true);
    expect(await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, co!.id))).toBe(false);
  });

  it("cannot remove another workspace's company", async () => {
    const theirs = await withTenant(ctx(TENANT_B), (q) => companies.findOrCreateCompany(q, "Theirs"));
    expect(await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, theirs!.id))).toBe(false);
    expect((await withTenant(ctx(TENANT_B), (q) => companies.listCompanies(q))).length).toBe(1);
  });

  it("frees the name, so it can be created again", async () => {
    // Otherwise removing a mistake makes the correct name permanently
    // unusable — the row is still there, just invisible.
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, co!.id));
    const again = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    expect(again, "the name stayed taken after removal").not.toBeNull();
    expect(again!.id).not.toBe(co!.id);
  });
});

describe("one company's people and deals", () => {
  it("lists everyone at it and every deal they are on", async () => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    const ana = await withTenant(ctx(TENANT_A), (q) =>
      contacts.createContact(q, { firstName: "Ana", lastName: "S", email: "a@x.co", phone: null, info: null, companyId: co!.id })
    );
    const ben = await withTenant(ctx(TENANT_A), (q) =>
      contacts.createContact(q, { firstName: "Ben", lastName: "C", email: null, phone: null, info: null, companyId: co!.id })
    );
    const won = await withTenant(ctx(TENANT_A), (q) =>
      deals.createDeal(q, { contactId: ana.id, title: "Retainer", valueCents: 400000, stage: "demo" })
    );
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, won.id, "won"));
    await withTenant(ctx(TENANT_A), (q) =>
      deals.createDeal(q, { contactId: ben.id, title: "Website", valueCents: 200000, stage: "demo" })
    );

    const detail = await withTenant(ctx(TENANT_A), (q) => companies.companyDetail(q, co!.id));
    expect(detail).not.toBeNull();
    expect(detail!.people.length).toBe(2);
    expect(detail!.people[0].name, "the person who has bought most is not first").toBe("Ana S");
    expect(detail!.people[0].wonCents).toBe(400000);
    expect(detail!.deals.length).toBe(2);
    expect(detail!.deals.map((d) => d.contactName).sort()).toEqual(["Ana S", "Ben C"]);
  });

  it("returns nothing for another workspace's company", async () => {
    const theirs = await withTenant(ctx(TENANT_B), (q) => companies.findOrCreateCompany(q, "Theirs"));
    expect(await withTenant(ctx(TENANT_A), (q) => companies.companyDetail(q, theirs!.id))).toBeNull();
  });

  it("returns nothing once it has been removed", async () => {
    const co = await withTenant(ctx(TENANT_A), (q) => companies.findOrCreateCompany(q, "Acme"));
    await withTenant(ctx(TENANT_A), (q) => companies.removeCompany(q, co!.id));
    expect(await withTenant(ctx(TENANT_A), (q) => companies.companyDetail(q, co!.id))).toBeNull();
  });
});
