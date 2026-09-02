import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * The referral loop: a happy customer names somebody, and that becomes a
 * Prospect attributed back to them.
 *
 * The Referral column's exit condition has always read "Feeds back into
 * Prospect", and nothing made it happen — the cycle ran in somebody's head or,
 * far more often, not at all.
 *
 * The attribution arithmetic gets the most attention here because it is what
 * any thank-you or reward would be paid from. A number that quietly counts a
 * lost referral as pipeline, or credits a referrer for somebody else's deal, is
 * a number that costs money the moment it is used for anything.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let referrals: typeof import("../src/server/referrals");
let deals: typeof import("../src/server/repos/deals");
let contacts: typeof import("../src/server/repos/contacts");
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
  referrals = await import("../src/server/referrals");
  deals = await import("../src/server/repos/deals");
  contacts = await import("../src/server/repos/contacts");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  await db.seed(`DELETE FROM activities; DELETE FROM deals; DELETE FROM contacts;`);
});

const referrer = (tenant = TENANT_A, first = "Dave", last = "Klein") =>
  withTenant(ctx(tenant), (q) =>
    contacts.createContact(q, { firstName: first, lastName: last, email: null, phone: null, info: null })
  );

describe("recording a referral", () => {
  it("creates the person and the opportunity together", async () => {
    /**
     * Both, or neither. A contact with no deal is a name nobody follows up; a
     * deal with no contact is a card with nobody to call.
     */
    const dave = await referrer();
    const result = await withTenant(ctx(TENANT_A), (q) =>
      referrals.recordReferral(q, {
        referrerContactId: dave.id,
        firstName: "Mia",
        lastName: "Okafor",
        note: "Same problem with missed calls",
      })
    );

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;

    expect(result.deal.stage, "a referral did not land in Prospect").toBe("prospect");
    expect(result.deal.source).toBe("referral");
    expect(result.deal.referredByContactId, "the referral credits nobody").toBe(dave.id);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.map((c) => `${c.firstName} ${c.lastName}`)).toContain("Mia Okafor");
  });

  it("keeps what the referrer said as the first pain point", async () => {
    // The closest thing to Discovery that exists before Discovery happens, and
    // exactly what to open the first call with.
    const dave = await referrer();
    const result = await withTenant(ctx(TENANT_A), (q) =>
      referrals.recordReferral(q, {
        referrerContactId: dave.id,
        firstName: "Mia",
        lastName: "Okafor",
        note: "Runs two branches, same missed-call problem",
      })
    );
    expect(result.ok && result.deal.painPoints).toEqual([
      "Runs two branches, same missed-call problem",
    ]);
  });

  it("carries no invented value", async () => {
    // A referral nobody has spoken to yet has no value. Inventing one puts
    // imaginary money in the pipeline the moment the loop is used.
    const dave = await referrer();
    const result = await withTenant(ctx(TENANT_A), (q) =>
      referrals.recordReferral(q, { referrerContactId: dave.id, firstName: "Mia", lastName: "O" })
    );
    expect(result.ok && result.deal.valueCents).toBe(0);
  });

  it("refuses a referral with no name", async () => {
    const dave = await referrer();
    const result = await withTenant(ctx(TENANT_A), (q) =>
      referrals.recordReferral(q, { referrerContactId: dave.id, firstName: "  ", lastName: "" })
    );
    expect(result.ok).toBe(false);
  });

  it("refuses to credit a referrer from another workspace", async () => {
    /**
     * The referrer id arrives from a form. Attributing a referral to an
     * arbitrary contact is how a reward programme gets gamed — and pointing it
     * at another tenant's contact would be a cross-tenant write besides.
     */
    const theirs = await referrer(TENANT_B, "Someone", "Else");
    const result = await withTenant(ctx(TENANT_A), (q) =>
      referrals.recordReferral(q, {
        referrerContactId: theirs.id,
        firstName: "Mia",
        lastName: "Okafor",
      })
    );
    expect(result.ok, "another workspace's contact was credited").toBe(false);

    const mine = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(mine.length, "a contact was created despite the refusal").toBe(0);
  });

  it("leaves a trace on both records", async () => {
    // On the new prospect it explains where they came from; on the referrer it
    // is the evidence that they have been sending work.
    const dave = await referrer();
    const result = await withTenant(ctx(TENANT_A), (q) =>
      referrals.recordReferral(q, { referrerContactId: dave.id, firstName: "Mia", lastName: "Okafor" })
    );
    expect(result.ok).toBe(true);

    const rows = await withTenant(ctx(TENANT_A), (q) =>
      q.rows<{ entity_id: string; title: string }>(
        `SELECT entity_id, title FROM activities WHERE sub_account_id = $1`,
        [TENANT_A]
      )
    );
    expect(rows.some((a) => a.title.includes("Referred by Dave Klein"))).toBe(true);
    expect(rows.some((a) => a.entity_id === dave.id && a.title.includes("Referred Mia"))).toBe(true);
  });
});

describe("what a referrer has actually been worth", () => {
  const send = (referrerId: string, name: string) =>
    withTenant(ctx(TENANT_A), (q) =>
      referrals.recordReferral(q, { referrerContactId: referrerId, firstName: name, lastName: "X" })
    );

  it("counts nothing for a workspace with no referrals", async () => {
    expect(await withTenant(ctx(TENANT_A), (q) => referrals.referralCredits(q))).toEqual([]);
  });

  it("separates won from still open", async () => {
    /**
     * A referrer who sent five that went nowhere is not the same as one who
     * sent two that closed. A single blended number hides the difference
     * exactly when it is being used to decide who gets thanked.
     */
    const dave = await referrer();
    const a = await send(dave.id, "Won");
    const b = await send(dave.id, "Open");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await withTenant(ctx(TENANT_A), (q) =>
      deals.updateDeal(q, a.deal.id, { valueCents: 500000 })
    );
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, a.deal.id, "won"));
    // Stage moves through `moveStage`, not `updateDeal` — the patch type
    // deliberately excludes it, because moving a deal has side effects
    // (`won_at`, loss reasons) that a field assignment would skip.
    await withTenant(ctx(TENANT_A), (q) => deals.updateDeal(q, b.deal.id, { valueCents: 300000 }));
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, b.deal.id, "demo"));

    const [credit] = await withTenant(ctx(TENANT_A), (q) => referrals.referralCredits(q));
    expect(credit.referrals).toBe(2);
    expect(credit.won).toBe(1);
    expect(credit.wonCents).toBe(500000);
    expect(credit.openCents, "the open figure is wrong").toBe(300000);
  });

  it("stops counting a referral that was lost", async () => {
    // A lost referral is neither money in hand nor money still coming. Counted
    // as pipeline it would sit in the total forever.
    const dave = await referrer();
    const a = await send(dave.id, "Doomed");
    if (!a.ok) return;
    await withTenant(ctx(TENANT_A), (q) =>
      deals.updateDeal(q, a.deal.id, { valueCents: 900000 })
    );
    await withTenant(ctx(TENANT_A), (q) =>
      deals.moveStage(q, a.deal.id, "lost", { lostReason: "budget" })
    );

    const [credit] = await withTenant(ctx(TENANT_A), (q) => referrals.referralCredits(q));
    expect(credit.referrals).toBe(1);
    expect(credit.wonCents).toBe(0);
    expect(credit.openCents, "a lost referral was counted as open pipeline").toBe(0);
  });

  it("ranks the referrer who has brought most money first", async () => {
    const dave = await referrer(TENANT_A, "Dave", "Klein");
    const sam = await referrer(TENANT_A, "Sam", "Ito");

    const small = await send(dave.id, "Small");
    const big = await send(sam.id, "Big");
    if (!small.ok || !big.ok) return;

    await withTenant(ctx(TENANT_A), (q) => deals.updateDeal(q, small.deal.id, { valueCents: 100000 }));
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, small.deal.id, "won"));
    await withTenant(ctx(TENANT_A), (q) => deals.updateDeal(q, big.deal.id, { valueCents: 800000 }));
    await withTenant(ctx(TENANT_A), (q) => deals.moveStage(q, big.deal.id, "won"));

    const credits = await withTenant(ctx(TENANT_A), (q) => referrals.referralCredits(q));
    expect(credits[0].name).toBe("Sam Ito");
  });

  it("credits only this workspace's referrals", async () => {
    const mine = await referrer(TENANT_A, "Mine", "Here");
    const theirs = await referrer(TENANT_B, "Theirs", "There");
    await send(mine.id, "One");
    await withTenant(ctx(TENANT_B), (q) =>
      referrals.recordReferral(q, { referrerContactId: theirs.id, firstName: "Two", lastName: "X" })
    );

    const a = await withTenant(ctx(TENANT_A), (q) => referrals.referralCredits(q));
    const b = await withTenant(ctx(TENANT_B), (q) => referrals.referralCredits(q));
    expect(a.length).toBe(1);
    expect(a[0].name).toBe("Mine Here");
    expect(b[0].name).toBe("Theirs There");
  });

  it("ignores a referral row planted in another workspace", async () => {
    /**
     * `recordReferral` refuses a cross-tenant referrer, so this row cannot be
     * created through the product. It is inserted directly, which is what an
     * import, a migration, or a connection that bypasses row-level security
     * could produce — and it is exactly what `d.sub_account_id = $1` defends
     * against. Without that predicate the JOIN alone still scopes the contacts,
     * so nothing through the normal path would ever notice it was missing.
     */
    const dave = await referrer(TENANT_A, "Dave", "Klein");
    await db.seed(
      `INSERT INTO deals (id, sub_account_id, title, value_cents, stage, source,
                          referred_by_contact_id, won_at)
       VALUES ('d_planted', '${TENANT_B}', 'Planted', 999999, 'won', 'referral', '${dave.id}', now())`
    );

    const credits = await withTenant(ctx(TENANT_A), (q) => referrals.referralCredits(q));
    const dropped = credits.find((c) => c.contactId === dave.id);
    expect(
      dropped?.wonCents ?? 0,
      "a deal in another workspace was credited to this one's referrer"
    ).toBe(0);
  });

  it("drops a referrer whose contact record was removed", async () => {
    // Otherwise a deleted contact keeps appearing in a report with a blank
    // name beside somebody else's money.
    const dave = await referrer();
    await send(dave.id, "One");
    await withTenant(ctx(TENANT_A), (q) => contacts.deleteContact(q, dave.id));

    const credits = await withTenant(ctx(TENANT_A), (q) => referrals.referralCredits(q));
    expect(credits, "a removed referrer still appears").toEqual([]);
  });
});

describe("the loop is reachable from the interface", () => {
  const BOARD = readFileSync(
    join(__dirname, "..", "src", "app", "(app)", "deals", "DealsBoard.tsx"),
    "utf8"
  );
  const REPORTS = readFileSync(
    join(__dirname, "..", "src", "app", "(app)", "reports", "page.tsx"),
    "utf8"
  );

  it("can record a referral from a deal", () => {
    expect(BOARD, "nothing in the board records a referral").toMatch(/recordReferralAction\(/);
  });

  it("asks only once the work is done", () => {
    /**
     * Asking during Discovery is asking a stranger for a favour. Asking once
     * the work is delivered and visibly working is asking a happy customer an
     * easy question — the difference between the loop running and it not.
     */
    const code = BOARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/stage !== "delivery" && deal\.stage !== "referral"/);
  });

  it("shows who has been sending work", () => {
    expect(REPORTS, "referrers are counted but never shown").toMatch(/referralCredits\(/);
  });

  it("takes the referrer from the deal, never from the form", () => {
    /**
     * The one place this could be gamed. A referrer id posted by the browser
     * lets anybody credit any contact — which matters the moment referrals are
     * worth account credit. It comes from the deal being viewed, whose tenant
     * has already been established.
     */
    const ACTIONS = readFileSync(
      join(__dirname, "..", "src", "app", "(app)", "deals", "actions.ts"),
      "utf8"
    );
    const start = ACTIONS.indexOf("export async function recordReferralAction");
    expect(start, "the referral action is gone").toBeGreaterThan(-1);
    const body = ACTIONS.slice(start, ACTIONS.indexOf("\nexport async function", start + 1));
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code, "the referrer is not read from the deal").toMatch(/getDeal\(q, dealId\)/);
    expect(code).toMatch(/referrerContactId:\s*deal\.contactId/);
    // And no referrer id is accepted from the browser at all.
    expect(
      /formData\.get\(\s*["'](referrer|referrerId|contactId)["']/.test(code),
      "a referrer id is read from the form, so any contact could be credited"
    ).toBe(false);
  });
});
