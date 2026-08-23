import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, TENANT_A, USER_A } from "./helpers/pg";

/**
 * Renaming something never breaks what it is attached to.
 *
 * Entities used to be joined by matching names: revenue-by-source matched a won
 * deal to a lead BY NAME, and the audit found only 4 of 10 matched. A rename
 * severed the link and nothing said so — the worst kind of data loss, because
 * the records are all still there and simply stop referring to each other.
 *
 * The relational rewrite replaced those with foreign keys. This is the check
 * that it is actually true everywhere, rather than believed: every name in the
 * fixture is changed, and every relationship has to survive it.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let closePool: typeof import("../src/server/db").closePool;
let contacts: typeof import("../src/server/repos/contacts");
let companies: typeof import("../src/server/repos/companies");
let deals: typeof import("../src/server/repos/deals");
let referrals: typeof import("../src/server/referrals");

const ctx = {
  agencyId: "ag_test",
  subAccountId: TENANT_A,
  userId: USER_A,
  role: "owner" as const,
};

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  contacts = await import("../src/server/repos/contacts");
  companies = await import("../src/server/repos/companies");
  deals = await import("../src/server/repos/deals");
  referrals = await import("../src/server/referrals");
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

beforeEach(() =>
  db.seed(`DELETE FROM activities; DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;`)
);

describe("a rename keeps every relationship", () => {
  it("keeps a contact's deals when the contact is renamed", async () => {
    /**
     * The original defect. Revenue-by-source matched a won deal to a lead by
     * name — 4 of 10 matched — so correcting somebody's surname quietly
     * removed their revenue from the report.
     */
    const person = await withTenant(ctx, (q) =>
      contacts.createContact(q, {
        firstName: "Ana",
        lastName: "Silva",
        email: "a@x.co",
        phone: null,
        info: null,
      })
    );
    const deal = await withTenant(ctx, (q) =>
      deals.createDeal(q, { contactId: person.id, title: "Retainer", valueCents: 500000, stage: "demo" })
    );

    await withTenant(ctx, (q) =>
      contacts.updateContact(q, person.id, { firstName: "Ana-Maria", lastName: "Silva-Costa" })
    );

    const after = await withTenant(ctx, (q) => deals.getDeal(q, deal.id));
    expect(after?.contactId, "a rename detached the deal from its contact").toBe(person.id);

    const all = await withTenant(ctx, (q) => deals.listDeals(q));
    expect(all.length).toBe(1);
  });

  it("keeps a company's people when the company is renamed", async () => {
    const co = await withTenant(ctx, (q) => companies.findOrCreateCompany(q, "Acme Ltd"));
    await withTenant(ctx, (q) =>
      contacts.createContact(q, {
        firstName: "Ana",
        lastName: "S",
        email: null,
        phone: null,
        info: null,
        companyId: co!.id,
      })
    );

    await withTenant(ctx, (q) => companies.renameCompany(q, co!.id, "Acme Limited"));

    const [person] = await withTenant(ctx, (q) => contacts.listContacts(q));
    expect(person.companyId).toBe(co!.id);
    expect(person.companyName, "the rename did not reach the contact").toBe("Acme Limited");
  });

  it("keeps a referral credited after both people are renamed", async () => {
    /**
     * The one that would matter most once referrals are worth account credit:
     * a referrer whose name was corrected losing the work they had sent.
     */
    const dave = await withTenant(ctx, (q) =>
      contacts.createContact(q, { firstName: "Dave", lastName: "Klein", email: null, phone: null, info: null })
    );
    const result = await withTenant(ctx, (q) =>
      referrals.recordReferral(q, { referrerContactId: dave.id, firstName: "Mia", lastName: "Okafor" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await withTenant(ctx, (q) => contacts.updateContact(q, dave.id, { firstName: "David" }));
    await withTenant(ctx, (q) => contacts.updateContact(q, result.contactId, { lastName: "Okafor-Bello" }));

    const credits = await withTenant(ctx, (q) => referrals.referralCredits(q));
    expect(credits.length, "the referral lost its referrer").toBe(1);
    expect(credits[0].contactId).toBe(dave.id);
    expect(credits[0].name).toBe("David Klein");
    expect(credits[0].referrals).toBe(1);
  });

  it("keeps a deal's activity history when the deal is retitled", async () => {
    const person = await withTenant(ctx, (q) =>
      contacts.createContact(q, { firstName: "Ana", lastName: "S", email: null, phone: null, info: null })
    );
    const deal = await withTenant(ctx, (q) =>
      deals.createDeal(q, { contactId: person.id, title: "Original title", valueCents: 100000, stage: "demo" })
    );
    const activity = await import("../src/server/repos/activity");
    await withTenant(ctx, (q) =>
      activity.logActivity(q, {
        entityType: "deal",
        entityId: deal.id,
        kind: "note",
        title: "Called them back",
        actorUserId: USER_A,
      })
    );

    await withTenant(ctx, (q) => deals.updateDeal(q, deal.id, { title: "Completely different title" }));

    const rows = await withTenant(ctx, (q) =>
      q.rows<{ entity_id: string }>(
        `SELECT entity_id FROM activities WHERE sub_account_id = $1 AND entity_id = $2`,
        [TENANT_A, deal.id]
      )
    );
    expect(rows.length, "retitling a deal orphaned its history").toBe(1);
  });

  it("keeps a company's rollup after everything in it is renamed", async () => {
    // The end-to-end version: rename the company AND the person, and the money
    // still adds up against the same company.
    const co = await withTenant(ctx, (q) => companies.findOrCreateCompany(q, "Acme"));
    const person = await withTenant(ctx, (q) =>
      contacts.createContact(q, {
        firstName: "Ana", lastName: "S", email: null, phone: null, info: null, companyId: co!.id,
      })
    );
    const deal = await withTenant(ctx, (q) =>
      deals.createDeal(q, { contactId: person.id, title: "Work", valueCents: 750000, stage: "demo" })
    );
    await withTenant(ctx, (q) => deals.moveStage(q, deal.id, "won"));

    await withTenant(ctx, (q) => companies.renameCompany(q, co!.id, "Acme Holdings"));
    await withTenant(ctx, (q) => contacts.updateContact(q, person.id, { lastName: "Different" }));
    await withTenant(ctx, (q) => deals.updateDeal(q, deal.id, { title: "Renamed work" }));

    const [rollup] = await withTenant(ctx, (q) => companies.companyRollups(q));
    expect(rollup.name).toBe("Acme Holdings");
    expect(rollup.contacts).toBe(1);
    expect(rollup.wonCents, "the money left the company when things were renamed").toBe(750000);
  });
});

describe("nothing joins on a name", () => {
  const SRC = join(__dirname, "..", "src");

  const walk = (dir: string): string[] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir).flatMap((f) => {
          const full = join(dir, f);
          if (statSync(full).isDirectory()) return walk(full);
          return /\.(ts|tsx)$/.test(f) ? [full] : [];
        });

  it("has no SQL join on a name or other text column", () => {
    /**
     * The shape of the original defect, as SQL. Joining on a name is joining on
     * something a person is allowed to change, and the failure is silent by
     * construction.
     */
    const offenders: string[] = [];
    for (const path of walk(join(SRC, "server"))) {
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // `migrate/` is the one-off import from the old JSONB store: its source
      // data genuinely had no ids, which is why the relational schema exists.
      if (path.includes(join("server", "migrate"))) continue;

      for (const m of code.matchAll(/JOIN\s+\w+\s+\w+\s+ON\s+([^\n]+)/gi)) {
        if (/\.(name|first_name|last_name|title|info)\b/.test(m[1])) {
          offenders.push(`${path.split("/src/")[1]}: ${m[1].trim().slice(0, 70)}`);
        }
      }
    }
    expect(offenders, `these join on text:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not gather a person's messages by their name", () => {
    /**
     * The one place this survived the rewrite. The reader's thread matched on
     * the sender's email OR their name, so correcting a spelling split one
     * person's history in two with nothing to say why. It goes by contact id
     * now, with email as the fallback only for a sender who is not yet a
     * contact and therefore has no id to match on.
     */
    const code = readFileSync(join(SRC, "app", "(app)", "inbox", "InboxView.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(code, "the thread no longer uses the contact id").toMatch(
      /m\.contactId === message\.contactId/
    );
    expect(
      /m\.name === message\.name/.test(code),
      "the message thread is gathered by name again"
    ).toBe(false);
  });

  it("carries the contact id all the way to the screen", () => {
    // A link that stops at the repository is a link the interface cannot use,
    // which is how it ended up matching on text in the first place.
    const decorator = readFileSync(join(SRC, "server", "decorate-message.ts"), "utf8");
    expect(decorator).toMatch(/contactId: m\.contactId/);
  });
});
