import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * The business's own details, and the rules around changing them.
 *
 * These end up on paperwork that leaves the building, so the two failures worth
 * guarding are both about trust rather than about layout: details that cannot be
 * REMOVED once they are wrong, and a tax rate that can be set by somebody who
 * has no business setting it.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const actions = read("../src/app/(app)/settings/actions.ts");
const card = read("../src/app/(app)/settings/BusinessCard.tsx");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let closePool: typeof import("../src/server/db").closePool;
let settings: typeof import("../src/server/repos/settings");

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  settings = await import("../src/server/repos/settings");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM settings WHERE sub_account_id = '${TENANT_A}';`));

describe("saving them", () => {
  it("WRITES THE FIRST SET WITHOUT ANY ROW EXISTING", async () => {
    /* A workspace that has never opened Settings has no row at all, and
       "fill in your VAT number" must not be the thing that discovers it. */
    const saved = await inA((q) =>
      settings.updateSettings(q, {
        businessAddress: "12 Main Road\nClaremont",
        registrationNumber: "2019/123456/07",
        vatNumber: "4123456789",
        vatRateBp: 1500,
        pricesIncludeVat: false,
      })
    );
    expect(saved.vatNumber).toBe("4123456789");
    expect(saved.vatRateBp).toBe(1500);
    expect(saved.businessAddress).toBe("12 Main Road\nClaremont");
  });

  it("CAN TAKE A DETAIL BACK OUT AGAIN", async () => {
    /* The failure worth preventing: a business moves premises, empties the
       address box, and the old address keeps printing on documents going to
       clients because an empty value was read as "leave it alone". */
    await inA((q) => settings.updateSettings(q, { businessAddress: "Old place", vatNumber: "4123456789" }));
    const cleared = await inA((q) => settings.updateSettings(q, { businessAddress: null }));
    expect(cleared.businessAddress).toBeNull();
    /* And only that one. A field nobody mentioned is untouched. */
    expect(cleared.vatNumber).toBe("4123456789");
  });

  it("leaves everything alone when nothing is mentioned", async () => {
    await inA((q) =>
      settings.updateSettings(q, { vatNumber: "4123456789", vatRateBp: 1500, pricesIncludeVat: true })
    );
    const after = await inA((q) => settings.updateSettings(q, { weeklyCapacity: 30 }));
    expect(after).toMatchObject({ vatNumber: "4123456789", vatRateBp: 1500, pricesIncludeVat: true });
  });

  it("keeps `false` as a real answer", async () => {
    /* `prices_include_vat` is a boolean, so "not mentioned" and "false" are two
       different things — conflated, the setting could be turned on and never
       off again. */
    await inA((q) => settings.updateSettings(q, { pricesIncludeVat: true }));
    const off = await inA((q) => settings.updateSettings(q, { pricesIncludeVat: false }));
    expect(off.pricesIncludeVat).toBe(false);
  });

  it("REFUSES A RATE OUTSIDE 0–100%", async () => {
    await expect(inA((q) => settings.updateSettings(q, { vatRateBp: 10001 }))).rejects.toThrow(/0% and 100%/);
    await expect(inA((q) => settings.updateSettings(q, { vatRateBp: -1 }))).rejects.toThrow(/0% and 100%/);
    /* And a fraction of a basis point, which is a rate the arithmetic cannot
       hold exactly — the whole reason it is not stored as a decimal. */
    await expect(inA((q) => settings.updateSettings(q, { vatRateBp: 1500.5 }))).rejects.toThrow();
  });

  it("gives a workspace that has saved nothing a safe set of defaults", async () => {
    const fresh = await inA((q) => settings.getSettings(q));
    expect(fresh.vatRateBp).toBe(0);
    expect(fresh.pricesIncludeVat).toBe(false);
    expect(fresh.vatNumber).toBeNull();
  });
});

describe("how often the row is read", () => {
  it("ONCE PER TRANSACTION, however many callers ask for it", async () => {
    /*
       The performance pass counted the queries behind a page load and found
       this row fetched four times in one render of the application layout —
       the layout's currency, the sidebar counts, the notification feed and the
       retainer sweep each asking separately — and again by the page inside it.
       The layout wraps every screen, so those were three redundant round trips
       on every page view in the product.

       Identity is the proof: the memo hands every caller in a transaction the
       same promise, so the same object comes back. A second read would build a
       second object.
    */
    const [first, second] = await inA(async (q) => [
      await settings.getSettings(q),
      await settings.getSettings(q),
    ]);
    expect(first).toBe(second);
  });

  it("is not carried between transactions", async () => {
    /* A memo that outlived its transaction would serve one workspace's figures
       to the next request. It is keyed on the query object, which lives exactly
       as long as the transaction. */
    const one = await inA((q) => settings.getSettings(q));
    const two = await inA((q) => settings.getSettings(q));
    expect(one).not.toBe(two);
    expect(one).toEqual(two);
  });

  it("NEVER SERVES A STALE ROW after a write in the same transaction", async () => {
    const after = await inA(async (q) => {
      await settings.getSettings(q);
      await settings.updateSettings(q, { vatNumber: "4999999999", vatRateBp: 1400 });
      return settings.getSettings(q);
    });
    expect(after.vatNumber).toBe("4999999999");
    expect(after.vatRateBp).toBe(1400);
  });
});

describe("who may change them", () => {
  it("IS AN OWNER OR A FINANCE USER, not everybody", () => {
    /* The bank account clients are told to pay into is on this form. The gate
       is the one the billing screen already uses. */
    const fn = actions.slice(actions.indexOf("export async function updateBusinessDetailsAction"));
    expect(fn).toMatch(/roleCan\(q\.ctx\.role, "manage_billing"\)/);
  });

  it("does not read a single customer record to do it", () => {
    /* `crmData: false` is what lets a finance user — who cannot open Contacts —
       fill this in at all. It is earned: nothing here touches a contact. */
    const fn = actions.slice(actions.indexOf("export async function updateBusinessDetailsAction"));
    expect(fn).toMatch(/crmData: false/);
  });

  it("begins with the tenant check, like every other action", () => {
    const fn = actions.slice(actions.indexOf("export async function updateBusinessDetailsAction"));
    expect(fn).toMatch(/^export async function updateBusinessDetailsAction\([\s\S]{0,200}return withCurrentTenant\(/);
  });
});

describe("what the form will not let somebody do", () => {
  it("CHARGE VAT WITH NO REGISTRATION NUMBER TO CHARGE IT UNDER", () => {
    /* That combination produces an invoice a client's accountant rejects, and
       the discovery happens at their end rather than ours. */
    expect(actions).toMatch(/vatRateBp > 0 && !vatNumber/);
    expect(actions).toMatch(/Add your VAT registration number before charging VAT/);
  });

  it("type a rate as words and have it read as zero", () => {
    /* `decimal` returns null for anything that is not a finite non-negative
       number — refused, rather than a tax line quietly vanishing. */
    expect(actions).toMatch(/const ratePercent = decimal\(formData\.get\("vatRate"\), 100, 2\)/);
    expect(actions).toMatch(/if \(ratePercent === null\)/);
  });

  it("stores the rate in basis points, converted once", () => {
    expect(actions).toMatch(/Math\.round\(ratePercent \* 100\)/);
  });
});

describe("what the card says before anything is saved", () => {
  it("SHOWS BOTH READINGS OF THE PRICE, in real money", () => {
    /* The checkbox has a 15% consequence and nothing on screen would look wrong
       either way, so the card works a real figure through both readings as it
       is ticked. */
    expect(card).toMatch(/vatBreakdown\(EXAMPLE_CENTS, rateBp, inclusive\)/);
    expect(card).toMatch(/The client pays/);
  });

  it("names the fields a tax invoice is still missing", () => {
    expect(card).toMatch(/your VAT registration number/);
    expect(card).toMatch(/your trading address/);
    expect(card).toMatch(/your company registration number/);
  });

  it("shows the details to somebody who cannot edit them", () => {
    /* Hiding them would leave a member unable to see what is going out on
       documents in their own name. */
    expect(card).toMatch(/<ReadOnly settings=\{settings\} \/>/);
  });
});
