import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * Money that arrived outside the card provider, on a real Postgres.
 *
 * The behaviour under test is the one that replaced picking "paid" out of a
 * status menu: a payment is recorded, and the invoice's status is a consequence
 * of what has been received rather than a word somebody typed. The rule that
 * decides "received covers what is owed" is shared with the Paystack webhook —
 * `tests/payments.test.ts` drives the same rule from the other door, and the
 * two must never disagree.
 */

process.env.AUTH_SECRET = "test-secret-for-manual-pay-0123456789abcd";

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let repo: typeof import("../src/server/repos/payments");
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);
const read = <T>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/payments");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/** R4,500 of lines. With VAT at 15% charged on top, R5,175 is what is owed. */
beforeEach(async () => {
  await db.seed(`
    DELETE FROM invoice_payments; DELETE FROM activities;
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO settings (sub_account_id, currency, vat_rate_bp, prices_include_vat)
      VALUES ('${TENANT_A}', 'ZAR', 1500, FALSE)
      ON CONFLICT (sub_account_id) DO UPDATE SET currency = 'ZAR', vat_rate_bp = 1500, prices_include_vat = FALSE;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', 'amara@test.local');
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage, contact_id, owner_user_id) VALUES
      ('d_garden', '${TENANT_A}', 'Dube garden', 0, 'won', 'ct_amara', '${USER_A}');
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party_contact_id, sent_at) VALUES
      ('inv-a', '${TENANT_A}', 'd_garden', 'invoice', 'INV-1001', 'sent', 'ct_amara', now());
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
      ('l1', '${TENANT_A}', 'inv-a', 'Maintenance', 1, 450000, 0);
  `);
});

const record = (amountCents: number, over: Partial<Parameters<typeof repo.recordManualPayment>[1]> = {}) =>
  inA((q) =>
    repo.recordManualPayment(q, {
      documentId: "inv-a",
      amountCents,
      paidOn: "2026-10-01",
      method: "transfer",
      ...over,
    })
  );

const statusOf = async () =>
  (await read<{ status: string }>(`SELECT status FROM documents WHERE id = 'inv-a'`))[0].status;

describe("a transfer that covers the invoice", () => {
  it("settles it against what is owed INCLUDING VAT, not the line total", async () => {
    /* The line total is R4,500 and the client owes R5,175. An invoice that went
       to "paid" on R4,500 would be 15% short and marked settled, with nothing
       on any screen saying money was still outstanding. */
    expect(await record(450_000)).toMatchObject({ outcome: "part_paid", totalCents: 517_500 });
    expect(await statusOf()).toBe("sent");

    expect(await record(67_500)).toMatchObject({ outcome: "paid", number: "INV-1001" });
    expect(await statusOf()).toBe("paid");
  });

  it("records the amount, the day, the method and who said so", async () => {
    await record(517_500, { paidOn: "2026-09-28", method: "cash" });
    const [row] = await read<{
      provider: string;
      amount_cents: string;
      channel: string;
      paid_at: Date;
      recorded_by_user_id: string;
    }>(`SELECT provider, amount_cents, channel, paid_at, recorded_by_user_id FROM invoice_payments`);
    expect(row).toMatchObject({
      provider: "manual",
      amount_cents: "517500",
      channel: "cash",
      recorded_by_user_id: USER_A,
    });
    expect(row.paid_at.toISOString().slice(0, 10)).toBe("2026-09-28");
  });

  it("leaves a line on the job's history saying how the money came", async () => {
    await record(517_500, { method: "cheque", note: "Ref 88213" });
    const [log] = await read<{ title: string; detail: string; amount_cents: string }>(
      `SELECT title, detail, amount_cents FROM activities WHERE entity_id = 'd_garden'`
    );
    expect(log.title).toBe("INV-1001 paid");
    expect(log.detail).toBe("Received by cheque — Ref 88213");
    expect(log.amount_cents).toBe("517500");
  });
});

describe("a client who pays part of it", () => {
  it("is something the product can finally say", async () => {
    const out = await record(200_000);
    expect(out).toEqual({
      outcome: "part_paid",
      number: "INV-1001",
      paidCents: 200_000,
      totalCents: 517_500,
    });
    expect(await statusOf()).toBe("sent");
  });

  it("adds up across several payments rather than replacing the last", async () => {
    await record(200_000);
    await record(200_000);
    expect(await record(100_000)).toMatchObject({ outcome: "part_paid", paidCents: 500_000 });
    expect(await record(17_500)).toMatchObject({ outcome: "paid" });
    expect(await read(`SELECT 1 FROM invoice_payments`)).toHaveLength(4);
  });

  it("each payment is its own row, even for the identical amount on the same day", async () => {
    /* Two R1,000 transfers on one day are two payments. The reference is ours
       and random precisely so the uniqueness rule cannot collapse them. */
    await record(100_000);
    await record(100_000);
    expect(await read(`SELECT 1 FROM invoice_payments`)).toHaveLength(2);
  });
});

describe("what it refuses", () => {
  it("an amount that is not money", async () => {
    for (const bad of [0, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await record(bad)).toMatchObject({ outcome: "ignored" });
    }
    expect(await read(`SELECT 1 FROM invoice_payments`)).toEqual([]);
  });

  it("an invoice that was cancelled — money against one is a mistake, not a payment", async () => {
    await db.seed(`UPDATE documents SET status = 'cancelled' WHERE id = 'inv-a'`);
    expect(await record(517_500)).toMatchObject({ outcome: "ignored", reason: "INV-1001 was cancelled." });
    expect(await read(`SELECT 1 FROM invoice_payments`)).toEqual([]);
  });

  it("a quotation, which is not paid against", async () => {
    await db.seed(`UPDATE documents SET kind = 'quote' WHERE id = 'inv-a'`);
    expect(await record(517_500)).toMatchObject({ outcome: "ignored" });
  });

  it("another workspace's invoice", async () => {
    expect(
      await withTenant({ ...ctx, subAccountId: "sub_nobody" }, (q) =>
        repo.recordManualPayment(q, {
          documentId: "inv-a",
          amountCents: 517_500,
          paidOn: "2026-10-01",
          method: "transfer",
        })
      )
    ).toMatchObject({ outcome: "ignored" });
    expect(await read(`SELECT 1 FROM invoice_payments`)).toEqual([]);
  });
});

describe("a workspace that charges no VAT", () => {
  it("is settled by the line total, with nothing added", async () => {
    await db.seed(`UPDATE settings SET vat_rate_bp = 0 WHERE sub_account_id = '${TENANT_A}'`);
    expect(await record(450_000)).toMatchObject({ outcome: "paid" });
    expect(await statusOf()).toBe("paid");
  });
});

describe("a workspace whose prices already include VAT", () => {
  it("is settled by the price on the document, not the price plus tax again", async () => {
    await db.seed(`UPDATE settings SET prices_include_vat = TRUE WHERE sub_account_id = '${TENANT_A}'`);
    expect(await record(450_000)).toMatchObject({ outcome: "paid" });
  });
});
