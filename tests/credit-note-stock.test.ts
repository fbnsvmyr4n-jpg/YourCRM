/*
   Where the goods went when a bill was credited.

   Bradley's reasoning, which this implements: a client who cancels before the
   materials leave the yard returns them; damaged goods come back but are not
   resold; and most credit notes are not about goods at all.

   The design decision underneath it, which is the thing worth protecting: THIS
   IS ASKED, NEVER INFERRED. The same credit note means "two pallets came back"
   and "they kept everything and I reduced the bill", and those are opposite
   facts about the shelf.

   And the default is that nothing came back, because the two mistakes do not
   cost the same. A shelf claiming materials nobody can find gets quoted
   against and fails a job; a shelf that understates costs one purchase order
   and is corrected by a stock take.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";
import { DISPOSITIONS, DISPOSITION_LABEL } from "../src/data/stock";

const read = (p: string) =>
  readFileSync(`${process.cwd()}/${p}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let stock: typeof import("../src/server/repos/stock");
let creditStock: typeof import("../src/server/stock-credit");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  stock = await import("../src/server/repos/stock");
  creditStock = await import("../src/server/stock-credit");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/**
 * 200 paving stones on the shelf, 40 of them sold on an invoice, and a credit
 * note for 40 sitting in draft.
 *
 * The credit note also carries a line of LABOUR and a HAND-TYPED line, because
 * those are the two kinds that must never move stock and a fixture without
 * them could not show it.
 */
beforeEach(() =>
  db.seed(`
    DELETE FROM stock_movements; DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM price_items; DELETE FROM suppliers; DELETE FROM deals;
    INSERT INTO deals (id, sub_account_id, title, stage, source)
      VALUES ('d_cn', '${TENANT_A}', 'Paving', 'won', 'other');
    INSERT INTO suppliers (id, sub_account_id, name)
      VALUES ('sup', '${TENANT_A}', 'Stone Yard');
    INSERT INTO price_items (id, sub_account_id, name, unit, unit_cents, track_stock, supplier_id) VALUES
      ('pi_stone',  '${TENANT_A}', 'Paving stone', 'm²',  50000, TRUE,  'sup'),
      ('pi_labour', '${TENANT_A}', 'Site labour',  'day', 180000, FALSE, NULL);
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status) VALUES
      ('inv1', '${TENANT_A}', 'd_cn', 'invoice',     'INV-1', 'sent'),
      ('cn1',  '${TENANT_A}', 'd_cn', 'credit_note', 'CN-1',  'draft');
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position, price_item_id) VALUES
      ('li1',  '${TENANT_A}', 'inv1', 'Paving stone', 40, 50000, 0, 'pi_stone'),
      ('lc1',  '${TENANT_A}', 'cn1',  'Paving stone', 40, 50000, 0, 'pi_stone'),
      ('lc2',  '${TENANT_A}', 'cn1',  'Site labour',   2, 180000, 1, 'pi_labour'),
      ('lc3',  '${TENANT_A}', 'cn1',  'Skip hire',     1,  90000, 2, NULL);
    INSERT INTO stock_movements (id, sub_account_id, price_item_id, qty_change, reason)
      VALUES ('sm_in', '${TENANT_A}', 'pi_stone', 200, 'received');
    INSERT INTO stock_movements (id, sub_account_id, price_item_id, qty_change, reason, document_id, document_line_id)
      VALUES ('sm_sold', '${TENANT_A}', 'pi_stone', -40, 'sold', 'inv1', 'li1');
  `)
);

const onHand = async (id = "pi_stone") => (await inA((q) => stock.stockOnHand(q)))[id];

const restock = async (d: (typeof DISPOSITIONS)[number]) =>
  (await inA((q) => creditStock.restockForCreditNote(q, "cn1", d, USER_A))).items;

const movementsOnCredit = () =>
  inA((q) =>
    q.rows<{ reason: string; qty_change: string }>(
      `SELECT reason, qty_change::text FROM stock_movements
        WHERE sub_account_id = $1 AND document_id = 'cn1' ORDER BY reason`,
      [TENANT_A]
    )
  );

describe("nothing came back", () => {
  it("MOVES NOTHING AT ALL — the default, and the safe direction", async () => {
    expect(await onHand()).toBe(160);
    expect(await restock("none")).toBe(0);
    expect(await onHand()).toBe(160);
    expect(await movementsOnCredit()).toEqual([]);
  });

  it("is what an unanswered question means", () => {
    /* The action reads the field and falls back to `none`, so a form posted
       without it — an older client, a pressed Enter, a credit note with no
       goods on it — credits the money and leaves the shelf alone. */
    const actions = read("src/app/(app)/projects/actions.ts");
    expect(actions).toMatch(/pick\(formData\.get\("disposition"\), DISPOSITIONS\) \?\? "none"/);
  });
});

describe("goods came back and can be resold", () => {
  it("puts exactly what was credited back on the shelf", async () => {
    expect(await restock("resellable")).toBe(1);
    expect(await onHand()).toBe(200);
    expect(await movementsOnCredit()).toEqual([{ reason: "returned", qty_change: "40.000" }]);
  });

  it("MOVES ONLY TRACKED GOODS PICKED FROM THE LIST", async () => {
    /*
       Three lines, one movement. Labour has no shelf — "Site labour: 2 back in
       stock" is not a fact about anything — and the hand-typed line has no
       price item, so filling a shelf would mean matching "Skip hire" by name,
       which is the guess that put a quotation at the wrong rate once already.
    */
    await restock("resellable");
    const all = await inA((q) =>
      q.rows<{ price_item_id: string }>(
        `SELECT price_item_id FROM stock_movements
          WHERE sub_account_id = $1 AND document_id = 'cn1'`,
        [TENANT_A]
      )
    );
    expect(all).toEqual([{ price_item_id: "pi_stone" }]);
    expect(await onHand("pi_labour")).toBeUndefined();
  });

  it("puts them back ONCE, however many times it is issued", async () => {
    /* The unique index is what makes this true rather than the caller being
       careful — a double-pressed control and a retried request are the same
       credit note. */
    expect(await restock("resellable")).toBe(1);
    expect(await restock("resellable")).toBe(0);
    expect(await onHand()).toBe(200);
  });
});

describe("goods came back damaged", () => {
  it("RECORDS BOTH FACTS, and leaves the shelf where it was", async () => {
    /*
       Damaged stock must not quietly become sellable stock, or it gets quoted
       to the next client. But it must not vanish either, or nothing says what
       damage is costing. So: returned, then written off — on hand is unchanged,
       which is the truth, and the history says why, which is the point of
       keeping a history instead of a number.
    */
    /* ONE item, two movements — the count a person reads must be the item. */
    expect(await restock("damaged")).toBe(1);
    expect(await onHand()).toBe(160);
    expect(await movementsOnCredit()).toEqual([
      { reason: "returned", qty_change: "40.000" },
      { reason: "written_off", qty_change: "-40.000" },
    ]);
  });

  it("is idempotent in both halves", async () => {
    expect(await restock("damaged")).toBe(1);
    expect(await restock("damaged")).toBe(0);
    expect((await movementsOnCredit()).length).toBe(2);
  });

  it("is a DIFFERENT answer from resellable, not a flavour of it", async () => {
    /* If these collapsed into one, a yard would be quoting damaged stone. */
    expect(DISPOSITIONS).toEqual(["none", "resellable", "damaged"]);
    expect(DISPOSITION_LABEL.damaged).not.toBe(DISPOSITION_LABEL.resellable);
  });
});

describe("which credit notes get asked", () => {
  it("is only the ones holding goods somebody counts", async () => {
    const lines = await inA((q) => creditStock.creditedStockLines(q, "cn1"));
    expect(lines).toEqual([{ lineId: "lc1", priceItemId: "pi_stone", quantity: 40 }]);
  });

  it("is carried on the ledger row, so the control is not drawn without goods", () => {
    /* A question with only one sensible answer is one people learn to click
       through without reading, which is how the real one gets clicked through
       too. */
    const ledger = read("src/server/document-ledger.ts");
    expect(ledger).toMatch(/pi\.track_stock = TRUE/);
    expect(ledger).toMatch(/\) AS has_stock/);

    const view = read("src/components/documents/DocumentLedgerView.tsx");
    expect(view).toMatch(/\{isCredit && r\.hasStock && r\.status === "draft" && \(/);
    expect(view).toMatch(/name="disposition"/);
    expect(view).toMatch(/defaultValue="none"/);
  });
});

describe("an issued credit note is finished", () => {
  const actions = read("src/app/(app)/projects/actions.ts");
  const fn = actions.slice(actions.indexOf("export async function setCreditNoteStatusAction"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  it("CANNOT BE CANCELLED OR PUT BACK TO DRAFT", () => {
    /*
       You cannot un-give somebody a document they are holding: their copy says
       they owe less, and nothing pressed here reaches it. Back-to-draft is the
       one that would actually be reached for, because it looks like tidying
       rather than undoing — and it would quietly put the whole amount back on
       what the client owes.

       Refused as ANY change away from an issued note, rather than by listing
       the two: a third status added later would otherwise slip through the
       gap, which is exactly how `approved` became a dead end on quotations.
    */
    expect(body).toMatch(/alreadyIssued && status !== note\.status/);
    expect(body).toMatch(/has already been issued to the client/);
  });

  it("says what to do instead, rather than naming a rule", () => {
    expect(body).toMatch(/Raise a new invoice to charge it back/);
  });

  it("is not offered the menu on screen either", () => {
    const view = read("src/components/documents/DocumentLedgerView.tsx");
    expect(view).toMatch(/const issuedCredit = \(row: LedgerRow\) => isCredit && row\.status !== "draft";/);
    expect(view).toMatch(/\|\| issuedCredit\(r\) \? \(/);
  });

  it("moves the goods only on the way IN to issued", () => {
    /* Re-saving an issued credit note must not put the goods back a second
       time. The index would catch it; this stops it being attempted, which is
       what keeps the "N back on the shelf" message honest. */
    expect(body).toMatch(/if \(status === "sent" && !alreadyIssued\)/);
  });
});

describe("what the screen claims afterwards", () => {
  const actions = read("src/app/(app)/projects/actions.ts");

  it("REPORTS WHAT WAS WRITTEN, not what was asked for", () => {
    /* `restockForCreditNote` is deliberately silent on failure — the credit
       note is what the person asked for, and a stock row that could not be
       written must not lose it. Which means the count it returns is the only
       honest thing to report. A screen that says "40 back on the shelf"
       because that is what was requested is how a count stops being trusted. */
    expect(actions).toMatch(/\(\{ items \} = await restockForCreditNote\(/);
    expect(actions).toMatch(/items === 0\s*\?\s*""/);
  });

  it("COUNTS ITEMS AND NEVER A QUANTITY", () => {
    /*
       The bug this caught, found by issuing a real credit note: the message
       counted movement ROWS and said "1 back on the shelf" when twenty paving
       stones had come back. A true number read as the wrong fact.

       Items is the only honest unit here — quantities cannot be summed across
       them, 20 m² and 3 days being 23 of nothing — and a count of items cannot
       be mistaken for a count of stones.
    */
    expect(actions).toMatch(/items === 1 \? "1 item" : `\$\{items\} items`/);
    expect(actions).toMatch(/Stock for \$\{n\} is back on the shelf/);
    expect(actions).not.toMatch(/items \/ 2/);
  });
});
