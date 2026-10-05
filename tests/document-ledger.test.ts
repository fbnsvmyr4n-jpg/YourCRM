import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import { documentCounts } from "../src/server/document-ledger";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * Quotations and purchase orders, listed across every job.
 *
 * The figures here are the ones a person acts on — what a client has agreed to
 * and what has been committed to suppliers — so every one of them is checked
 * against arithmetic done by hand, and the rules about WHICH documents count
 * are the same ones the project header uses. Two definitions of "committed" in
 * one product would be worse than none.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let documentLedger: typeof import("../src/server/document-ledger").documentLedger;
let nextDocumentNumber: typeof import("../src/server/document-ledger").nextDocumentNumber;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ documentLedger, nextDocumentNumber } = await import("../src/server/document-ledger"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/**
 * Two jobs, and a document of every status that decides the arithmetic.
 *
 * 100 x R450 and 100 x R200 are deliberate: a quantity above one, so a total
 * that was taken from the unit price alone would be obvious.
 */
beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_ben', '${TENANT_A}', 'Ben', 'Cole'),
      ('ct_them', '${TENANT_B}', 'Bruno', 'Beta');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage) VALUES
      ('d_paving', '${TENANT_A}', 'ct_ben', 'Paving — phase 1', 6000000, 'delivery'),
      ('d_roof',   '${TENANT_A}', 'ct_ben', 'Roof',             9000000, 'won'),
      ('d_theirs', '${TENANT_B}', 'ct_them', 'Theirs',          5000000, 'won');
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, issued_on) VALUES
      ('q_ok',   '${TENANT_A}', 'd_paving', 'quote', 'Q-1001', 'accepted',  'Ben Cole', '2026-08-31'),
      ('q_sent', '${TENANT_A}', 'd_paving', 'quote', 'Q-1002', 'sent',      'Ben Cole', '2026-09-22'),
      ('q_no',   '${TENANT_A}', 'd_roof',   'quote', 'Q-1003', 'declined',  'Ben Cole', '2026-09-01'),
      ('p_live', '${TENANT_A}', 'd_paving', 'purchase_order', 'PO-1001', 'sent',      'Stone Yard', '2026-09-05'),
      ('p_off',  '${TENANT_A}', 'd_paving', 'purchase_order', 'PO-1002', 'cancelled', 'Stone Yard', '2026-09-06'),
      ('p_draft','${TENANT_A}', 'd_roof',   'purchase_order', 'PO-1003', 'draft',     'Timber Co',  '2026-09-07'),
      ('q_them', '${TENANT_B}', 'd_theirs', 'quote', 'Q-9001', 'accepted',  'Bruno',    '2026-09-01');
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
      ('l1', '${TENANT_A}', 'q_ok',    'Paving stone',  100, 45000, 0),
      ('l2', '${TENANT_A}', 'q_sent',  'Drainage',        1, 1000000, 0),
      ('l3', '${TENANT_A}', 'q_no',    'Roof',            1, 2000000, 0),
      ('l4', '${TENANT_A}', 'p_live',  'Stone',         100, 20000, 0),
      ('l5', '${TENANT_A}', 'p_off',   'Sand',            1, 500000, 0),
      ('l6', '${TENANT_A}', 'p_draft', 'Timber',          1, 300000, 0),
      ('l7', '${TENANT_B}', 'q_them',  'Theirs',          1, 9900000, 0);
  `)
);

describe("what a quotation ledger totals", () => {
  it("MULTIPLIES QUANTITY BY UNIT PRICE — 100 at R450 is R45,000, not R450", async () => {
    /* The arithmetic that has gone wrong in this product before. */
    const { rows } = await inA((q) => documentLedger(q, "quote"));
    expect(rows.find((r) => r.number === "Q-1001")?.totalCents).toBe(4_500_000);
  });

  it("COUNTS ONLY WHAT THE CLIENT AGREED TO", async () => {
    /* Accepted counts. Sent is a hope and declined is a no — the same test the
       project header uses, so the two screens cannot disagree. */
    const ledger = await inA((q) => documentLedger(q, "quote"));
    expect(ledger.countedCents).toBe(4_500_000);
    expect(ledger.notCountedCents).toBe(1_000_000 + 2_000_000);
  });

  it("keeps every quotation in the list, counted or not", async () => {
    const { rows } = await inA((q) => documentLedger(q, "quote"));
    expect(rows.map((r) => r.number).sort()).toEqual(["Q-1001", "Q-1002", "Q-1003"]);
    expect(rows.find((r) => r.number === "Q-1002")?.counts).toBe(false);
  });

  it("says which job each one belongs to", async () => {
    const { rows } = await inA((q) => documentLedger(q, "quote"));
    expect(rows.find((r) => r.number === "Q-1003")?.projectTitle).toBe("Roof");
  });

  it("NEVER SHOWS ANOTHER WORKSPACE'S PAPERWORK", async () => {
    const ledger = await inA((q) => documentLedger(q, "quote"));
    expect(ledger.rows.some((r) => r.number === "Q-9001")).toBe(false);
    expect(ledger.countedCents).toBe(4_500_000);
  });
});

describe("what a purchase order ledger totals", () => {
  it("COUNTS A DRAFT ORDER — money we might owe is counted before it is certain", async () => {
    /* The deliberate asymmetry with quotations: a draft order is a commitment
       somebody has decided to make, and leaving it out makes a job look
       profitable right up until it is not. */
    const ledger = await inA((q) => documentLedger(q, "purchase_order"));
    expect(ledger.countedCents).toBe(2_000_000 + 300_000);
  });

  it("leaves out one that was called off", async () => {
    const ledger = await inA((q) => documentLedger(q, "purchase_order"));
    expect(ledger.rows.find((r) => r.number === "PO-1002")?.counts).toBe(false);
    expect(ledger.notCountedCents).toBe(500_000);
  });

  it("agrees with the rule the project header uses", () => {
    /* Read from the same function rather than restated here. */
    expect(documentCounts("quote", "accepted")).toBe(true);
    expect(documentCounts("quote", "sent")).toBe(false);
    expect(documentCounts("purchase_order", "draft")).toBe(true);
    expect(documentCounts("purchase_order", "cancelled")).toBe(false);
    /*
       An invoice's ledger answers a DIFFERENT question from a quotation's.

       This said false, on the reasoning that an invoice is the same money as
       the quotation it bills and must not be counted twice — which is still
       true of the PROJECT's figures, and `stage-money` is where that is
       enforced. It was never true of the bookkeeper's screen, which asks
       whether the money has arrived. Invoices had no ledger at all when this
       was written, so the question had not come up.
    */
    expect(documentCounts("invoice", "paid")).toBe(true);
    expect(documentCounts("invoice", "sent")).toBe(false);
  });
});

describe("the number offered for the next one", () => {
  it("carries on from the highest this workspace has used", async () => {
    expect(await inA((q) => nextDocumentNumber(q, "quote", "Q"))).toBe("Q-1004");
    expect(await inA((q) => nextDocumentNumber(q, "purchase_order", "PO"))).toBe("PO-1004");
  });

  it("DOES NOT REUSE A NUMBER AFTER A DOCUMENT IS DELETED", async () => {
    /* Counting rows would hand Q-1003's number to the next quotation, and two
       different documents would have carried the same number. */
    await db.seed(`UPDATE documents SET deleted_at = now() WHERE id = 'q_no';`);
    expect(await inA((q) => nextDocumentNumber(q, "quote", "Q"))).toBe("Q-1004");
  });

  it("starts somewhere that does not announce a first sale", async () => {
    await db.seed(`DELETE FROM documents;`);
    expect(await inA((q) => nextDocumentNumber(q, "quote", "Q"))).toBe("Q-1001");
  });

  it("ignores a number that is not of the shape it counts", async () => {
    /* A one-off carried from elsewhere must not break the arithmetic. */
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
      VALUES ('q_odd', '${TENANT_A}', 'd_paving', 'quote', 'Q-2024-SPECIAL', 'draft');
    `);
    expect(await inA((q) => nextDocumentNumber(q, "quote", "Q"))).toBe("Q-1004");
  });

  it("is not confused by another workspace's numbering", async () => {
    /* Tenant B is already on Q-9001. Offering Q-9002 here would leak the fact
       that somebody else exists, and skip this workspace's own sequence. */
    expect(await inA((q) => nextDocumentNumber(q, "quote", "Q"))).toBe("Q-1004");
  });
});
