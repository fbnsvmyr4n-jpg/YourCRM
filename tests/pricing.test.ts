import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The price list.
 *
 * It exists so that an agent drafting a quotation is selecting rather than
 * inventing, which makes two of these tests the point of the whole file: a
 * price is stored in exact cents, and a withdrawn item stops being offered
 * without breaking the quotes that already cite it.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let pricing: typeof import("../src/server/repos/pricing");
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
  pricing = await import("../src/server/repos/pricing");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM price_items;`));

const add = (name: string, cents: number, unit = "per day") =>
  inA((q) => pricing.savePriceItem(q, { name, unitCents: cents, unit }));

describe("keeping a price list", () => {
  it("stores a price in exact cents", async () => {
    // $12,000.50 is 1,200,050 cents. Anything that rounds here puts a wrong
    // total on a document somebody signs.
    const { item } = await add("Mobile crane hire", 1_200_050);
    expect(item?.unitCents).toBe(1_200_050);
  });

  it("defaults the unit rather than leaving it blank", async () => {
    const { item } = await inA((q) =>
      pricing.savePriceItem(q, { name: "Site survey", unitCents: 500_00, unit: "  " })
    );
    expect(item?.unit).toBe("each");
  });

  it("refuses a second item with the same name", async () => {
    // Two rows called "Crane hire" at different prices is a question the agent
    // cannot answer and a person should not have to.
    await add("Crane hire", 100_00);
    const second = await add("crane hire", 200_00);
    expect(second.error).toMatch(/already have an item/i);
  });

  it("refuses a negative price rather than storing one", async () => {
    const result = await inA((q) =>
      pricing.savePriceItem(q, { name: "Discount", unitCents: -100 })
    );
    expect(result.error).toMatch(/whole number of cents, and not negative/i);
  });

  it("refuses an item with no name", async () => {
    expect((await inA((q) => pricing.savePriceItem(q, { name: "   ", unitCents: 1 }))).error)
      .toMatch(/name/i);
  });

  it("corrects a price in place rather than adding a second row", async () => {
    const { item } = await add("Crane hire", 100_00);
    await inA((q) =>
      pricing.savePriceItem(q, { id: item!.id, name: "Crane hire", unitCents: 150_00 })
    );
    const list = await inA((q) => pricing.listPriceItems(q));
    expect(list).toHaveLength(1);
    expect(list[0].unitCents).toBe(150_00);
  });
});

describe("withdrawing something you no longer sell", () => {
  it("stops offering it without deleting it", async () => {
    /*
       The distinction that matters. A quotation citing this line last year has
       to keep making sense, so the row stays; it simply stops appearing where
       new prices are offered.
    */
    const { item } = await add("Old scaffold rate", 90_00);
    await inA((q) => pricing.setPriceItemActive(q, item!.id, false));

    expect(await inA((q) => pricing.listPriceItems(q, true))).toEqual([]);
    const all = await inA((q) => pricing.listPriceItems(q));
    expect(all).toHaveLength(1);
    expect(all[0].active).toBe(false);
  });

  it("brings one back", async () => {
    const { item } = await add("Seasonal rate", 10_00);
    await inA((q) => pricing.setPriceItemActive(q, item!.id, false));
    await inA((q) => pricing.setPriceItemActive(q, item!.id, true));
    expect(await inA((q) => pricing.listPriceItems(q, true))).toHaveLength(1);
  });

  it("sorts the live ones above the withdrawn", async () => {
    // Otherwise a withdrawn "Aardvark" leads the list somebody is scanning for
    // what they can actually charge for.
    const { item } = await add("Aardvark removal", 1_00);
    await add("Zebra crossing", 2_00);
    await inA((q) => pricing.setPriceItemActive(q, item!.id, false));
    expect((await inA((q) => pricing.listPriceItems(q))).map((i) => i.name)).toEqual([
      "Zebra crossing",
      "Aardvark removal",
    ]);
  });

  it("frees the name once an item is deleted for good", async () => {
    const { item } = await add("Typo hire", 1_00);
    expect(await inA((q) => pricing.deletePriceItem(q, item!.id))).toBe(true);
    expect((await add("Typo hire", 2_00)).error).toBeUndefined();
  });
});

describe("one workspace's prices are its own", () => {
  it("is invisible from another tenant", async () => {
    await add("Crane hire", 100_00);
    expect(await inB((q) => pricing.listPriceItems(q))).toEqual([]);
  });

  it("cannot be edited from another tenant", async () => {
    const { item } = await add("Crane hire", 100_00);
    const result = await inB((q) =>
      pricing.savePriceItem(q, { id: item!.id, name: "Hijacked", unitCents: 1 })
    );
    expect(result.item).toBeUndefined();
    expect((await inA((q) => pricing.listPriceItems(q)))[0].name).toBe("Crane hire");
  });
});
