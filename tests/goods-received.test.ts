/*
   Goods received: the purchase slip that puts stock on the shelf.

   Slice 2 of Bradley's feature 2, and the half that makes the figure
   trustworthy. Without it stock only ever falls, and a number that can only
   fall is one everybody learns to ignore within a month.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

const read = (p: string) =>
  readFileSync(`${process.cwd()}/${p}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let received: typeof import("../src/server/repos/goods-received");
let stock: typeof import("../src/server/repos/stock");
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
  received = await import("../src/server/repos/goods-received");
  stock = await import("../src/server/repos/stock");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/* Two suppliers, because that is the only way two prices share a name — the
   fixture the database refused when slice 1's tests were written. */
beforeEach(() =>
  db.seed(`
    DELETE FROM stock_movements;
    DELETE FROM goods_received_lines;
    DELETE FROM goods_received;
    DELETE FROM price_items;
    DELETE FROM suppliers;
    INSERT INTO suppliers (id, sub_account_id, name) VALUES
      ('sup_stone', '${TENANT_A}', 'Stone Yard'),
      ('sup_other', '${TENANT_B}', 'Their Yard');
    INSERT INTO price_items (id, sub_account_id, name, unit, unit_cents, track_stock, supplier_id) VALUES
      ('pi_stone',  '${TENANT_A}', 'Paving stone', 'm²',  51000, TRUE,  'sup_stone'),
      ('pi_sand',   '${TENANT_A}', 'Bedding sand', 'm³',  34500, TRUE,  'sup_stone'),
      ('pi_labour', '${TENANT_A}', 'Site labour',  'day', 180000, FALSE, NULL);
  `)
);

const onHand = async (id: string) => (await inA((q) => stock.stockOnHand(q)))[id];

const slip = (over: Partial<Parameters<typeof received.receiveGoods>[1]> = {}) => ({
  supplierId: "sup_stone",
  reference: "DN-5512",
  receivedOn: "2026-10-08",
  note: null,
  lines: [{ priceItemId: "pi_stone", quantity: 60 }],
  userId: USER_A,
  ...over,
});

describe("recording a delivery", () => {
  it("PUTS THE GOODS ON THE SHELF, with no separate posting step", async () => {
    /*
       Saving the slip IS the movement. A delivery somebody typed and did not
       post is a delivery that will not be posted — the shelf short, and the
       explanation sitting one screen away in a draft nobody opens again.
    */
    const result = await inA((q) => received.receiveGoods(q, slip()));
    expect(result).not.toHaveProperty("error");
    expect(await onHand("pi_stone")).toBe(60);
  });

  it("records WHO took it in, unlike a sale", async () => {
    /* A sale is moved by raising an invoice and carries no user. A delivery is
       somebody standing at the gate counting, so it carries their name. */
    await inA((q) => received.receiveGoods(q, slip()));
    const [movement] = await inA((q) => stock.movementsFor(q, "pi_stone"));
    expect(movement.reason).toBe("received");
    expect(movement.movedByUserId).toBe(USER_A);
  });

  it("carries their delivery note onto the movement", async () => {
    /* Theirs, not ours: it is what the supplier's invoice will cite when the
       two have to be matched. */
    await inA((q) => received.receiveGoods(q, slip()));
    const [movement] = await inA((q) => stock.movementsFor(q, "pi_stone"));
    expect(movement.note).toBe("Delivery DN-5512");
  });

  it("takes several lines at once", async () => {
    await inA((q) =>
      received.receiveGoods(
        q,
        slip({
          lines: [
            { priceItemId: "pi_stone", quantity: 60 },
            { priceItemId: "pi_sand", quantity: 20 },
          ],
        })
      )
    );
    expect(await onHand("pi_stone")).toBe(60);
    expect(await onHand("pi_sand")).toBe(20);
  });
});

describe("what it refuses", () => {
  it("REFUSES A LINE THAT IS NOT STOCK, rather than dropping it quietly", async () => {
    /*
       The failure worth preventing. Somebody typing a delivery expects every
       line of it to count — a line that silently did nothing is a shelf that
       is short with no sign of why, found weeks later when the count is wrong
       and nobody can say when it started.
    */
    const result = await inA((q) =>
      received.receiveGoods(q, slip({ lines: [{ priceItemId: "pi_labour", quantity: 3 }] }))
    );
    expect(result).toHaveProperty("error");
    expect(await onHand("pi_labour")).toBeUndefined();
  });

  it("WRITES NOTHING AT ALL when one line is bad", async () => {
    /* Whole or not at all. Half a delivery on the shelf is worse than none:
       the figure is wrong and the slip says it is right. */
    const result = await inA((q) =>
      received.receiveGoods(
        q,
        slip({
          lines: [
            { priceItemId: "pi_stone", quantity: 60 },
            { priceItemId: "pi_labour", quantity: 3 },
          ],
        })
      )
    );
    expect(result).toHaveProperty("error");
    expect(await onHand("pi_stone"), "half the delivery landed").toBeUndefined();
    expect(await inA((q) => received.listReceived(q))).toHaveLength(0);
  });

  it("refuses a delivery with nothing on it", async () => {
    expect(await inA((q) => received.receiveGoods(q, slip({ lines: [] })))).toHaveProperty("error");
  });

  it("refuses a supplier from another workspace", async () => {
    /* The policy stops a tenant READING another's rows; this is the other
       half — being POINTED at one. */
    const result = await inA((q) => received.receiveGoods(q, slip({ supplierId: "sup_other" })));
    expect(result).toHaveProperty("error");
  });

  it("never shows one workspace another's deliveries", async () => {
    await inA((q) => received.receiveGoods(q, slip()));
    expect(await inB((q) => received.listReceived(q))).toHaveLength(0);
  });
});

describe("the slip that is left behind", () => {
  it("says who, when, their reference and what was on it", async () => {
    await inA((q) =>
      received.receiveGoods(
        q,
        slip({
          note: "Two bags split on arrival.",
          lines: [
            { priceItemId: "pi_stone", quantity: 60 },
            { priceItemId: "pi_sand", quantity: 20 },
          ],
        })
      )
    );
    const [recorded] = await inA((q) => received.listReceived(q));
    expect(recorded).toMatchObject({
      supplierName: "Stone Yard",
      reference: "DN-5512",
      receivedOn: "2026-10-08",
      note: "Two bags split on arrival.",
    });
    expect(recorded.lines.map((l) => `${l.quantity} ${l.unit} ${l.itemName}`)).toEqual([
      "60 m² Paving stone",
      "20 m³ Bedding sand",
    ]);
  });

  it("takes a delivery with no reference, because plenty arrive with a scribble", async () => {
    /* Refusing to record one for want of a number is how stock stops being
       recorded at all. */
    const result = await inA((q) => received.receiveGoods(q, slip({ reference: null })));
    expect(result).not.toHaveProperty("error");
    expect((await inA((q) => received.listReceived(q)))[0].reference).toBeNull();
  });
});

describe("where it lives", () => {
  const schema = read("src/server/schema.sql");

  it("IS NOT A FOURTH `documents` KIND, and the schema says why", () => {
    /*
       The obvious move, and wrong. `documents.deal_id` is NOT NULL: a
       quotation and an invoice are about a job, and a purchase order is raised
       for one. A delivery into the yard is about a SUPPLIER — the stone
       arrives, it goes on the shelf, and which job it will be used on is not
       known and may be several. The choice was to weaken a constraint every
       project query leans on, or to write a job onto a record that has none.
    */
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS goods_received \(/);
    expect(schema).toMatch(/CHECK \(kind IN \('quote', 'purchase_order', 'invoice'\)\)/);
  });

  it("moves the goods ONCE however many times it is asked", () => {
    /* Same shape and same reasoning as a sale: the line is the natural key, so
       a retried request puts the goods on once. */
    expect(schema).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_once_per_received_line/);
  });

  it("insists a delivery line names something, unlike a document line", () => {
    /* A delivery note exists to move stock. A line naming no item moves none —
       a row that looks like a record of goods and is not one. */
    expect(schema).toMatch(/price_item_id\s+TEXT NOT NULL REFERENCES price_items\(id\)/);
  });
});
