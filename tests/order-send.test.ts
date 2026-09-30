import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * Sending a purchase order to a supplier.
 *
 * An order had no address anywhere and could never be sent: `party` is a name
 * typed on the order, and a supplier is usually not in the CRM at all — nobody
 * files the builder's merchant as a contact to buy sand from them. So
 * `documents.party_email` now carries one.
 *
 * What is checked here is the pair of rules that stop an order going wrong:
 * an order that has already gone must not go again, because two deliveries
 * arrive and an argument about an invoice follows; and a send that FAILED must
 * leave the order exactly as it was, so nothing on screen claims it went.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/quotes");
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/quotes");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_ben', '${TENANT_A}', 'Ben', 'Cole', 'ben@cole.test');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage) VALUES
      ('d_paving', '${TENANT_A}', 'ct_ben', 'Paving', 6000000, 'delivery');
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, party_email) VALUES
      ('po_draft', '${TENANT_A}', 'd_paving', 'purchase_order', 'PO-1', 'draft', 'Stone Yard', 'orders@yard.test'),
      ('po_off',   '${TENANT_A}', 'd_paving', 'purchase_order', 'PO-2', 'cancelled', 'Stone Yard', 'orders@yard.test'),
      ('q_one',    '${TENANT_A}', 'd_paving', 'quote', 'Q-1', 'approved', 'Ben Cole', NULL);
    UPDATE documents SET party_contact_id = 'ct_ben' WHERE id = 'q_one';
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
      ('l1', '${TENANT_A}', 'po_draft', 'Stone', 2.5, 199999, 0);
  `)
);

describe("finding an order to send", () => {
  it("READS AN ORDER, and never a quotation by the same id", async () => {
    /* Asking for an order and getting a quotation would send the wrong
       document to the wrong party. */
    expect(await inA((q) => repo.findOrder(q, "po_draft"))).not.toBeNull();
    expect(await inA((q) => repo.findOrder(q, "q_one"))).toBeNull();
  });

  it("carries the supplier's own address", async () => {
    const order = await inA((q) => repo.findOrder(q, "po_draft"));
    expect(order?.partyEmail).toBe("orders@yard.test");
  });

  it("TOTALS TO THE CENT — 2.5 at R1,999.99 is R4,999.98", async () => {
    /* 4,999.975 rounded once, in the database, exactly as every other screen
       rounds it. */
    const order = await inA((q) => repo.findOrder(q, "po_draft"));
    expect(order?.totalCents).toBe(499998);
  });
});

describe("a document's own address beats the contact's", () => {
  it("uses party_email when one is set on the document", async () => {
    /* Somebody who typed an address ON this document meant it for this
       document — a client's accounts inbox rather than the person who signed
       the quotation. */
    await db.seed(`UPDATE documents SET party_email = 'accounts@cole.test' WHERE id = 'q_one';`);
    const quote = await inA((q) => repo.findQuote(q, "q_one"));
    expect(quote?.partyEmail).toBe("accounts@cole.test");
  });

  it("falls back to the contact when the document has none", async () => {
    const quote = await inA((q) => repo.findQuote(q, "q_one"));
    expect(quote?.partyEmail).toBe("ben@cole.test");
  });
});

describe("marking one sent", () => {
  it("marks a draft order sent — drafting one was already the decision", async () => {
    /* Unlike a quotation, which may not leave without a named approver: an
       order is counted in a project's committed money from the moment it is
       drafted. */
    expect(await inA((q) => repo.markOrderSent(q, "po_draft"))).toBe(true);
  });

  it("REFUSES TO SEND ONE TWICE", async () => {
    await inA((q) => repo.markOrderSent(q, "po_draft"));
    expect(await inA((q) => repo.markOrderSent(q, "po_draft"))).toBe(false);
  });

  it("refuses one that was called off", async () => {
    expect(await inA((q) => repo.markOrderSent(q, "po_off"))).toBe(false);
  });

  it("never marks a quotation sent through the order path", async () => {
    expect(await inA((q) => repo.markOrderSent(q, "q_one"))).toBe(false);
  });
});

describe("what the database refuses to store", () => {
  /**
   * ONE refusal, deliberately.
   *
   * The test harness is PGlite over a socket, and two refused statements in
   * a row desync the connection — every statement after answers "current
   * transaction is aborted", and the failure surfaces in whichever FILE runs
   * next rather than in this one. Four refusals here took `ownership.test.ts`
   * down with them. The shape of the check is what matters, and one case
   * proves the constraint is live.
   */
  it("REFUSES SOMETHING THAT IS NOT AN ADDRESS", async () => {
    await expect(
      db.seed(`UPDATE documents SET party_email = 'not an email' WHERE id = 'po_draft';`)
    ).rejects.toThrow();
  });

  it("accepts a real one", async () => {
    await expect(
      db.seed(`UPDATE documents SET party_email = 'orders@stone-yard.co.za' WHERE id = 'po_draft';`)
    ).resolves.not.toThrow();
  });
});
describe("the send action", () => {
  const action = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/purchase-orders/actions.ts", import.meta.url)),
    "utf8"
  );

  it("SAYS WHY rather than failing quietly, for each thing a person must fix", () => {
    for (const reason of [
      "has already been sent",
      "has been called off",
      "has no supplier email address",
      "Email isn't switched on",
    ]) {
      expect(action, `no message for: ${reason}`).toContain(reason);
    }
  });

  it("re-reads the order afterwards rather than reporting what was asked for", () => {
    /* "Queued" hides three different truths, and saying "we'll keep trying"
       about a job that has already stopped is worse than saying nothing. */
    expect(action).toMatch(/findJob\(q, ORDER_EMAIL/);
    expect(action).toMatch(/job\?\.status === "dead"/);
  });

  it("deduplicates on the document, so pressing twice cannot order twice", () => {
    expect(action).toMatch(/dedupeKey: orderEmailKey\(order\.id\)/);
  });
});
