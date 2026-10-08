/*
   Stock: what is on the shelf, and every reason it moved.

   Slice 1 of Bradley's feature 2. Stock leaves when the invoice is RAISED —
   his call, and the right one for a trades business: the materials go out with
   the crew, so by the time you are billing for them they are on the client's
   site, whatever the invoice's status says and whoever has paid.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/* Comments stripped: five guards this week have matched the PROSE explaining a
   fix rather than the fix. */
const read = (p: string) =>
  readFileSync(`${process.cwd()}/${p}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
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
  stock = await import("../src/server/repos/stock");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/*
   TWO SUPPLIERS, because that is the only way two prices share a name.

   The first version of this fixture gave both stones no supplier and the
   database refused it: `price_items_name_once_per_supplier` is what stops a
   workspace growing four rows called "Crane hire". Two merchants selling the
   same thing at different rates is the case the index was widened FOR, and it
   is the case this file is about — so the fixture has to be that, not a state
   the product cannot produce.
*/
beforeEach(() =>
  db.seed(`
    DELETE FROM stock_movements;
    DELETE FROM document_lines;
    DELETE FROM documents;
    DELETE FROM price_items;
    DELETE FROM suppliers;
    DELETE FROM deals WHERE id = 'deal_stock';
    INSERT INTO deals (id, sub_account_id, title, stage, source)
      VALUES ('deal_stock', '${TENANT_A}', 'Stock test job', 'won', 'other')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO suppliers (id, sub_account_id, name) VALUES
      ('sup_stone', '${TENANT_A}', 'Stone Yard'),
      ('sup_rival', '${TENANT_A}', 'Cape Quarry');
    INSERT INTO price_items (id, sub_account_id, name, unit, unit_cents, track_stock, supplier_id) VALUES
      ('pi_stone_a', '${TENANT_A}', 'Paving stone', 'm²', 45000, TRUE,  'sup_rival'),
      ('pi_stone_b', '${TENANT_A}', 'Paving stone', 'm²', 51000, TRUE,  'sup_stone'),
      ('pi_labour',  '${TENANT_A}', 'Site labour',  'day', 180000, FALSE, NULL);
  `)
);

const onHand = async (id: string) => (await inA((q) => stock.stockOnHand(q)))[id];

describe("stock on hand", () => {
  it("IS THE SUM OF ITS OWN HISTORY, never a stored total", async () => {
    /*
       The whole design. A number on `price_items` that each sale decremented
       could disagree with the movements behind it, and once it had drifted
       there would be nothing left to recompute it from. Here the history IS
       the number, which is why "why is it 160?" has an answer.
    */
    await inA((q) =>
      stock.recordMovement(q, { priceItemId: "pi_stone_a", qtyChange: 200, reason: "received", userId: USER_A })
    );
    await inA((q) =>
      stock.recordMovement(q, { priceItemId: "pi_stone_a", qtyChange: -40, reason: "sold", userId: null })
    );
    expect(await onHand("pi_stone_a")).toBe(160);

    const history = await inA((q) => stock.movementsFor(q, "pi_stone_a"));
    expect(history.map((m) => m.qtyChange)).toEqual([-40, 200]);
    expect(history.reduce((sum, m) => sum + m.qtyChange, 0)).toBe(160);
  });

  it("says nothing for an item nobody counts", async () => {
    /* A trades business sells labour as well as materials. "Site labour: 3 in
       stock" is not a fact about anything, so the row has no shelf — even if a
       movement were somehow written against it. */
    await inA((q) =>
      stock.recordMovement(q, { priceItemId: "pi_labour", qtyChange: 5, reason: "received", userId: USER_A })
    );
    expect(await onHand("pi_labour")).toBeUndefined();
  });

  it("KEEPS TWO PRICES OF THE SAME NAME ON SEPARATE SHELVES", async () => {
    /*
       Two suppliers can both sell paving stone, which is the point of keeping
       suppliers. Taking stock off "Paving stone" by NAME would empty whichever
       row came first — the bug fixed on 7 Oct, arriving again as goods leaving
       the wrong shelf.
    */
    await inA((q) =>
      stock.recordMovement(q, { priceItemId: "pi_stone_b", qtyChange: 200, reason: "received", userId: USER_A })
    );
    await inA((q) =>
      stock.recordMovement(q, { priceItemId: "pi_stone_b", qtyChange: -40, reason: "sold", userId: null })
    );
    expect(await onHand("pi_stone_b")).toBe(160);
    expect(await onHand("pi_stone_a"), "the other shelf was touched").toBeUndefined();
  });

  it("never counts another workspace's shelf", async () => {
    await inA((q) =>
      stock.recordMovement(q, { priceItemId: "pi_stone_a", qtyChange: 10, reason: "received", userId: USER_A })
    );
    expect(await inB((q) => stock.stockOnHand(q))).toEqual({});
  });
});

describe("a sale, which is the only movement nobody presses a button for", () => {
  beforeEach(() =>
    db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
        VALUES ('doc_inv', '${TENANT_A}', 'deal_stock', 'invoice', 'INV-9001', 'draft');
      INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, price_item_id) VALUES
        ('dl_1', '${TENANT_A}', 'doc_inv', 'Paving stone', 40, 51000, 'pi_stone_b'),
        ('dl_2', '${TENANT_A}', 'doc_inv', 'Site labour',   3, 180000, 'pi_labour'),
        ('dl_3', '${TENANT_A}', 'doc_inv', 'Scaffold hire', 1,  90000, NULL);
    `)
  );

  it("takes only the lines that KNOW what they are", async () => {
    /* A hand-typed line has no price item, so it moves nothing — deliberately.
       Matching its description back to an item by name is guessing which shelf
       to empty, and guessing is worse than not emptying one. Labour is skipped
       because it is not goods. */
    const lines = await inA((q) => stock.soldLinesFor(q, "doc_inv"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ priceItemId: "pi_stone_b", quantity: 40 });
  });

  it("MOVES THE GOODS ONCE, however many times it is asked", async () => {
    /*
       Raising an invoice from a quotation, a double-pressed button, a retried
       request: all the same sale. The line is the natural key and a unique
       index enforces it — without that the second attempt empties the shelf
       twice and nothing says so.
    */
    const { takeStockForInvoice } = await import("../src/server/stock-sale");
    await inA((q) =>
      stock.recordMovement(q, { priceItemId: "pi_stone_b", qtyChange: 200, reason: "received", userId: USER_A })
    );

    expect(await inA((q) => takeStockForInvoice(q, "doc_inv"))).toBe(1);
    expect(await inA((q) => takeStockForInvoice(q, "doc_inv")), "it sold twice").toBe(0);
    expect(await onHand("pi_stone_b")).toBe(160);
  });

  it("records that NOBODY pressed anything", async () => {
    /* `moved_by_user_id` null is the fact: raising the invoice did it. Same
       reasoning as an automatically loaded price list. */
    const { takeStockForInvoice } = await import("../src/server/stock-sale");
    await inA((q) => takeStockForInvoice(q, "doc_inv"));
    const [movement] = await inA((q) => stock.movementsFor(q, "pi_stone_b"));
    expect(movement.reason).toBe("sold");
    expect(movement.movedByUserId).toBeNull();
    expect(movement.documentNumber).toBe("INV-9001");
  });
});

describe("cancelling an invoice", () => {
  it("PUTS THE GOODS BACK, as a return rather than by erasing the sale", async () => {
    /*
       The cost of choosing "raised" as the moment: an invoice raised and then
       cancelled has taken stock that never left. Recorded as its own movement,
       because "sold 40, returned 40" is what happened — a count that can be
       rewritten is a count that can be argued with.
    */
    const { takeStockForInvoice, returnStockForInvoice } = await import("../src/server/stock-sale");
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
        VALUES ('doc_c', '${TENANT_A}', 'deal_stock', 'invoice', 'INV-9002', 'draft');
      INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, price_item_id)
        VALUES ('dl_c', '${TENANT_A}', 'doc_c', 'Paving stone', 25, 51000, 'pi_stone_b');
    `);
    await inA((q) =>
      stock.recordMovement(q, { priceItemId: "pi_stone_b", qtyChange: 100, reason: "received", userId: USER_A })
    );

    await inA((q) => takeStockForInvoice(q, "doc_c"));
    expect(await onHand("pi_stone_b")).toBe(75);

    await inA((q) => returnStockForInvoice(q, "doc_c", USER_A));
    expect(await onHand("pi_stone_b")).toBe(100);

    const history = await inA((q) => stock.movementsFor(q, "pi_stone_b"));
    expect(history.map((m) => m.reason)).toEqual(["returned", "sold", "received"]);
  });

  it("does not put them back twice", async () => {
    const { takeStockForInvoice, returnStockForInvoice } = await import("../src/server/stock-sale");
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
        VALUES ('doc_d', '${TENANT_A}', 'deal_stock', 'invoice', 'INV-9003', 'draft');
      INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, price_item_id)
        VALUES ('dl_d', '${TENANT_A}', 'doc_d', 'Paving stone', 10, 51000, 'pi_stone_b');
    `);
    await inA((q) => takeStockForInvoice(q, "doc_d"));
    await inA((q) => returnStockForInvoice(q, "doc_d", USER_A));
    await inA((q) => returnStockForInvoice(q, "doc_d", USER_A));
    expect(await onHand("pi_stone_b")).toBe(0);
  });
});

describe("the link a line carries", () => {
  const detail = read("src/app/(app)/projects/[id]/ProjectDetail.tsx");
  const actions = read("src/app/(app)/projects/actions.ts");

  it("IS HELD IN STATE, because React wipes a hand-written hidden field", () => {
    /*
       The bug that only appears once BOTH features exist. The picker wrote the
       id straight into a hidden input; the running total added this morning
       re-renders on every keystroke; React resets an uncontrolled hidden
       field's value on re-render. So the rate filled, the link was wiped a
       frame later, and the invoice took stock off nothing at all. Found by
       raising an invoice and watching the shelf not move.
    */
    expect(detail).toMatch(/const \[lineItems, setLineItems\] = useState<Record<number, string>>\(\{\}\)/);
    expect(detail).toMatch(/value=\{lineItems\[i\] \?\? ""\}/);
    expect(detail, "the link is written into the DOM again").not.toMatch(/linked\.value =/);
  });

  it("is re-established on every keystroke, never left behind", () => {
    /* Pick "Paving stone", edit it to "Paving stone offcuts", and a link kept
       from the earlier pick takes paving stone off the shelf for a line that no
       longer says paving stone. */
    expect(detail).toMatch(/setLineItems\(\(prev\) => \(\{ \.\.\.prev, \[i\]: match\?\.id \?\? "" \}\)\)/);
  });

  it("IS CHECKED AGAINST THIS WORKSPACE before it is stored", () => {
    /* It arrives in a form field. A line pointing at somebody else's price
       would move their stock. */
    expect(actions).toMatch(/SELECT p\.id FROM price_items p\s*\n?\s*WHERE p\.id = \$9 AND p\.sub_account_id = \$2/);
  });
});
