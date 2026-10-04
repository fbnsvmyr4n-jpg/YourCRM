import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * What a client has actually PAID, on the contact panel.
 *
 * Asked for by name: "I think it should be all the money that that client has
 * been confirmed to have made." The panel used to answer a different question —
 * the value of deals marked won, which is what was AGREED — and the difference
 * between the two is money still outstanding. These hold the new figure to the
 * payments actually recorded, and hold it apart from the won figure, because a
 * test that let one stand in for the other would let the old answer back in.
 */

process.env.AUTH_SECRET = "test-secret-for-contact-received-01234567";

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let summaries: typeof import("../src/server/contact-summaries").contactSummaries;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ contactSummaries: summaries } = await import("../src/server/contact-summaries"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/**
 * Amara has won R100,000 of work and paid R30,000 of it.
 * Bongani has won the same R100,000 and paid nothing.
 */
beforeEach(async () => {
  await db.seed(`
    DELETE FROM invoice_payments; DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', 'amara@test.local'),
      ('ct_bongani', '${TENANT_A}', 'Bongani', 'Mahl', 'bongani@test.local');
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage, won_at, contact_id, owner_user_id) VALUES
      ('d_amara', '${TENANT_A}', 'Amara paving', 10000000, 'won', now(), 'ct_amara', '${USER_A}'),
      ('d_bongani', '${TENANT_A}', 'Bongani paving', 10000000, 'won', now(), 'ct_bongani', '${USER_A}');
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status) VALUES
      ('inv_amara', '${TENANT_A}', 'd_amara', 'invoice', 'INV-1001', 'sent'),
      ('inv_bongani', '${TENANT_A}', 'd_bongani', 'invoice', 'INV-1002', 'sent');
    INSERT INTO invoice_payments
      (id, sub_account_id, document_id, provider, reference, amount_cents, currency, paid_at) VALUES
      ('pay_1', '${TENANT_A}', 'inv_amara', 'manual', 'man_one', 2000000, 'ZAR', now()),
      ('pay_2', '${TENANT_A}', 'inv_amara', 'paystack', 'yc_inv_amara_0123456789ab', 1000000, 'ZAR', now());
  `);
});

const received = async (contactId: string) =>
  (await inA((q) => summaries(q, ["ct_amara", "ct_bongani"])))[contactId].receivedCents;

describe("money received", () => {
  it("adds up every payment against that client's invoices, however it arrived", async () => {
    /* A transfer entered by hand and a card charge confirmed by the provider
       are both money in the bank, and neither is more real than the other. */
    expect(await received("ct_amara")).toBe(3_000_000);
  });

  it("is zero for a client who has been invoiced and has not paid", async () => {
    expect(await received("ct_bongani")).toBe(0);
  });

  it("does NOT follow the won figure — the gap is the money outstanding", async () => {
    const all = await inA((q) => summaries(q, ["ct_amara", "ct_bongani"]));
    /* Both won R100,000. Only one has paid anything. A panel where these two
       clients look identical is the panel this replaced. */
    expect(all.ct_amara.wonValueCents).toBe(all.ct_bongani.wonValueCents);
    expect(all.ct_amara.receivedCents).not.toBe(all.ct_bongani.receivedCents);
  });

  it("ignores a payment against a deleted invoice", async () => {
    await db.seed(`UPDATE documents SET deleted_at = now() WHERE id = 'inv_amara'`);
    expect(await received("ct_amara")).toBe(0);
  });

  it("ignores a disputed payment — a charge pulled back is not money received", async () => {
    await db.seed(`UPDATE invoice_payments SET status = 'disputed' WHERE id = 'pay_1'`);
    expect(await received("ct_amara")).toBe(1_000_000);
  });

  it("does not reach into another workspace", async () => {
    const theirs = await withTenant({ ...ctx, subAccountId: TENANT_B }, (q) =>
      summaries(q, ["ct_amara"])
    );
    expect(theirs.ct_amara.receivedCents).toBe(0);
  });
});
