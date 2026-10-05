import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";
import { parsePriceList, planChanges } from "@/server/price-import";

/**
 * Suppliers, and loading a list against one, on a real Postgres.
 *
 * The reading and the diff are pure and covered in `price-import.test.ts`. This
 * is what happens when the answer is written: that a load adds and reprices the
 * right rows, that it never silently withdraws anything, that deleting a
 * supplier does not take its prices with it, and that none of it crosses a
 * workspace boundary.
 */

process.env.AUTH_SECRET = "test-secret-for-suppliers-0123456789abcd";

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let repo: typeof import("../src/server/repos/suppliers");
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/suppliers");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  await db.seed(`DELETE FROM price_items; DELETE FROM suppliers;`);
});

const TODAY = "2026-10-05";

/** Load a pasted list exactly as the screen does: read, plan, apply. */
async function load(supplierId: string, pasted: string) {
  return inA(async (q) => {
    const { lines, unread } = parsePriceList(pasted);
    const existing = await repo.supplierItems(q, supplierId);
    const result = await repo.applyPriceList(q, supplierId, planChanges(lines, existing), TODAY);
    return { ...result, unread: unread.length };
  });
}

describe("keeping a supplier", () => {
  it("records who they are and that nothing has been loaded yet", async () => {
    const made = await inA((q) => repo.createSupplier(q, { name: "Stone Yard", email: "sales@stoneyard.test" }));
    expect(made).toMatchObject({ name: "Stone Yard", email: "sales@stoneyard.test", itemCount: 0 });
    /* Null, not today. A supplier we have never had a list from must not look
       as though we have. */
    expect(made?.listUpdatedOn).toBeNull();
  });

  it("refuses a nameless one", async () => {
    expect(await inA((q) => repo.createSupplier(q, { name: "   " }))).toBeNull();
  });

  it("is not visible from another workspace", async () => {
    await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    const theirs = await withTenant({ ...ctx, subAccountId: TENANT_B }, (q) => repo.listSuppliers(q));
    expect(theirs).toEqual([]);
  });
});

describe("loading their list", () => {
  it("adds what is new and stamps the day it was loaded", async () => {
    const s = await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    const out = await load(s!.id, ["Paving stone\tm²\t450.00", "Bedding sand\tm³\t320.00"].join("\n"));
    expect(out).toMatchObject({ added: 2, repriced: 0, unchanged: 0 });

    const [supplier] = await inA((q) => repo.listSuppliers(q));
    expect(supplier).toMatchObject({ itemCount: 2, listUpdatedOn: TODAY });
  });

  it("reprices on the second load rather than duplicating", async () => {
    const s = await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    await load(s!.id, "Paving stone\tm²\t450.00");
    const out = await load(s!.id, "Paving stone\tm²\t480.00");

    expect(out).toMatchObject({ added: 0, repriced: 1 });
    const items = await inA((q) => repo.supplierItems(q, s!.id));
    expect(items).toHaveLength(1);
    expect(items[0].unitCents).toBe(48000);
  });

  it("counts a row that has not moved as unchanged, and touches nothing", async () => {
    const s = await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    await load(s!.id, "Paving stone\tm²\t450.00");
    expect(await load(s!.id, "Paving stone\tm²\t450.00")).toMatchObject({
      added: 0,
      repriced: 0,
      unchanged: 1,
    });
  });

  it("DOES NOT WITHDRAW what is missing from the new list", async () => {
    /*
       The most dangerous thing this could do. A supplier sending their paving
       sheet is not saying they stopped selling sand — and a parser that read 38
       of 40 rows would quietly withdraw the two it failed on. Withdrawing stays
       something a person does on purpose.
    */
    const s = await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    await load(s!.id, ["Paving stone\tm²\t450.00", "Bedding sand\tm³\t320.00"].join("\n"));
    await load(s!.id, "Paving stone\tm²\t480.00");

    const items = await inA((q) => repo.supplierItems(q, s!.id));
    expect(items.map((i) => i.name).sort()).toEqual(["Bedding sand", "Paving stone"]);
  });

  it("stamps the day even when nothing changed", async () => {
    /* "We checked on the 5th and it had not moved" is a different and more
       useful fact than silence. */
    const s = await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    await inA((q) => repo.applyPriceList(q, s!.id, [], TODAY));
    expect((await inA((q) => repo.listSuppliers(q)))[0].listUpdatedOn).toBe(TODAY);
  });

  it("keeps a line it could not read out of the database and in the report", async () => {
    const s = await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    const out = await load(s!.id, ["Paving stone\tm²\t450.00", "Delivery — POA"].join("\n"));
    expect(out).toMatchObject({ added: 1, unread: 1 });
    expect(await inA((q) => repo.supplierItems(q, s!.id))).toHaveLength(1);
  });
});

describe("removing a supplier", () => {
  it("KEEPS the prices they set", async () => {
    /*
       A quotation sent last month cites a rate. Deleting the merchant must not
       delete the rate it was built from, or that document can no longer be
       explained. The items just stop naming a supplier — the same state as
       everything typed before suppliers existed.
    */
    const s = await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    await load(s!.id, "Paving stone\tm²\t450.00");

    expect(await inA((q) => repo.deleteSupplier(q, s!.id))).toBe(true);
    expect(await inA((q) => repo.listSuppliers(q))).toEqual([]);

    const [row] = await withSystem((q) =>
      q.rows<{ name: string; supplier_id: string | null }>(
        `SELECT name, supplier_id FROM price_items WHERE deleted_at IS NULL`
      )
    );
    expect(row).toEqual({ name: "Paving stone", supplier_id: null });
  });

  it("says so when there was nothing to remove", async () => {
    expect(await inA((q) => repo.deleteSupplier(q, "sup-nobody"))).toBe(false);
  });
});

describe("the tenant boundary", () => {
  it("refuses a price pointed at another workspace's supplier", async () => {
    /* The policy stops a tenant READING another's row; this is the trigger that
       stops one being pointed at. */
    const mine = await inA((q) => repo.createSupplier(q, { name: "Stone Yard" }));
    await expect(
      withTenant({ ...ctx, subAccountId: TENANT_B }, (q) =>
        q.rows(
          `INSERT INTO price_items (id, sub_account_id, supplier_id, name, unit, unit_cents)
           VALUES ('pi-theirs', $1, $2, 'Stolen', 'each', 100)`,
          [TENANT_B, mine!.id]
        )
      )
    ).rejects.toThrow(/does not belong to sub-account/);
  });
});
