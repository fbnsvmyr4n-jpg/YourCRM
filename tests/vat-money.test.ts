import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * VAT where it touches real money.
 *
 * `vat.test.ts` holds the arithmetic. This holds the thing that arithmetic is
 * FOR: that one invoice has one amount owing, wherever it is read. The failure
 * this exists to prevent is specific and quiet — a workspace that charges VAT on
 * top of its typed prices has lines adding up to the figure BEFORE tax, so
 * anything that bills or settles against that figure is 15% short, says "paid",
 * and leaves the shortfall to surface in a VAT return months later.
 */

process.env.AUTH_SECRET = "test-secret-for-vat-money-0123456789abcdef";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let closePool: typeof import("../src/server/db").closePool;
let repo: typeof import("../src/server/repos/payments");
let pay: typeof import("../src/server/pay/pay");

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

const TOKEN = "tok_vat_invoice_0123456789abcdefghijkl";
/* R1,000 of lines. At 15% added on top, the client owes R1,150. */
const LINE_CENTS = 100000;

const statusOf = () =>
  inA((q) =>
    q.one<{ status: string }>(
      `SELECT status FROM documents WHERE sub_account_id = $1 AND id = 'inv-vat'`,
      [TENANT_A]
    )
  ).then((r) => r?.status);

/** Record a payment of `cents` as though Paystack had confirmed it. */
const receive = (cents: number, reference: string) =>
  inA((q) =>
    repo.recordPaystackPayment(
      q,
      {
        status: "success",
        reference,
        amountCents: cents,
        currency: "ZAR",
        paidAt: new Date().toISOString(),
        channel: "card",
        metadata: {},
      },
      "ZAR"
    )
  );

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/payments");
  pay = await import("../src/server/pay/pay");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/** 15%, charged on top of the prices this workspace types. */
const seedWith = (rateBp: number, inclusive: boolean) =>
  db.seed(`
    DELETE FROM invoice_payments; DELETE FROM activities;
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO settings (sub_account_id, currency, vat_number, vat_rate_bp, prices_include_vat)
      VALUES ('${TENANT_A}', 'ZAR', '4123456789', ${rateBp}, ${inclusive})
      ON CONFLICT (sub_account_id) DO UPDATE SET
        currency = 'ZAR', vat_number = '4123456789',
        vat_rate_bp = ${rateBp}, prices_include_vat = ${inclusive};
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', 'amara@test.local');
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage, contact_id) VALUES
      ('d_garden', '${TENANT_A}', 'Dube garden', 0, 'won', 'ct_amara');
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party_contact_id, sent_at, pay_token)
      VALUES ('inv-vat', '${TENANT_A}', 'd_garden', 'invoice', 'INV-9001', 'sent', 'ct_amara', now(), '${TOKEN}');
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position)
      VALUES ('l1', '${TENANT_A}', 'inv-vat', 'Maintenance', 1, ${LINE_CENTS}, 0);
  `);

beforeEach(() => seedWith(1500, false));

describe("an invoice from a VAT-registered business", () => {
  it("IS NOT SETTLED BY THE PRE-TAX AMOUNT — R1,000 does not clear R1,150", async () => {
    /* The bug this is here for: lines totalling R1,000, a client who owes
       R1,150, R1,000 arrives, and the invoice goes to "paid" with R150 missing
       and nothing on any screen saying so. */
    const outcome = await receive(LINE_CENTS, "yc_inv-vat_0123456789ab");
    expect(outcome).toEqual({
      outcome: "part_paid",
      number: "INV-9001",
      paidCents: LINE_CENTS,
      totalCents: 115000,
    });
    expect(await statusOf()).toBe("sent");
  });

  it("is settled by the gross", async () => {
    const outcome = await receive(115000, "yc_inv-vat_0123456789cd");
    expect(outcome).toEqual({ outcome: "paid", number: "INV-9001" });
    expect(await statusOf()).toBe("paid");
  });

  it("ASKS THE CLIENT FOR THE GROSS, and shows them where it comes from", async () => {
    const page = await pay.loadPayPage(TOKEN);
    expect(page.state).not.toBe("not_found");
    if (page.state === "not_found") return;
    /* The amount, the button and the paper copy are one number. */
    expect(page.totalCents).toBe(115000);
    expect(page.outstandingCents).toBe(115000);
    /* And the split, so a client can see why it is not the sum of the lines. */
    expect(page.vat).toEqual({ netCents: LINE_CENTS, vatCents: 15000, rateBp: 1500 });
  });
});

describe("when the typed prices already include the tax", () => {
  beforeEach(() => seedWith(1500, true));

  it("asks for exactly what was quoted, and takes the tax out of it", async () => {
    const page = await pay.loadPayPage(TOKEN);
    if (page.state === "not_found") return;
    expect(page.totalCents).toBe(LINE_CENTS);
    expect(page.vat).toEqual({ netCents: 86957, vatCents: 13043, rateBp: 1500 });
  });

  it("settles on that same figure", async () => {
    expect(await receive(LINE_CENTS, "yc_inv-vat_0123456789ef")).toEqual({
      outcome: "paid",
      number: "INV-9001",
    });
  });
});

describe("a business that charges no VAT", () => {
  beforeEach(() => seedWith(0, false));

  it("owes exactly the lines, and is told nothing about tax", async () => {
    const page = await pay.loadPayPage(TOKEN);
    if (page.state === "not_found") return;
    expect(page.totalCents).toBe(LINE_CENTS);
    expect(page.vat).toBeNull();
  });

  it("settles on the lines", async () => {
    expect(await receive(LINE_CENTS, "yc_inv-vat_0123456789ff")).toEqual({
      outcome: "paid",
      number: "INV-9001",
    });
  });
});

describe("one answer, in every place that states it", () => {
  it("THE SETTLEMENT AND THE PAY PAGE BOTH ASK `payableCents`", () => {
    /* Not two copies of the same `if`. The four surfaces a client meets — the
       printed sheet, the emailed copy, the pay page and the card charge — are
       only consistent because they share one function. */
    expect(read("../src/server/repos/payments.ts")).toMatch(/payableCents\(/);
    expect(read("../src/server/pay/pay.ts")).toMatch(/payableCents\(/);
  });

  it("the emailed copy carries the same split as the sheet", () => {
    const handlers = read("../src/server/outbox-handlers.ts");
    expect(handlers).toMatch(/vatBreakdown\(quote\.totalCents, settings\.vatRateBp, settings\.pricesIncludeVat\)/);
    expect(handlers).toMatch(/vatBreakdown\(invoice\.totalCents, settings\.vatRateBp, settings\.pricesIncludeVat\)/);
  });

  it("NO SURFACE DOES THE SUM ITSELF", () => {
    /* A second `* 1.15` anywhere is a second answer. Every one of these reads
       the breakdown from `server/vat.ts`. */
    for (const file of [
      "../src/server/pay/pay.ts",
      "../src/server/repos/payments.ts",
      "../src/server/email.ts",
      "../src/app/(app)/documents/[id]/DocumentSheet.tsx",
    ]) {
      const src = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(src, `${file} does its own tax arithmetic`).not.toMatch(/vatRateBp\s*\/\s*10000|\*\s*1\.1[0-9]/);
    }
  });

  it("leaves the pipeline and the reports counting the lines as typed", () => {
    /* VAT is collected for a revenue service; it is not revenue. Filling in a
       tax number must not silently inflate what this business reports earning. */
    const stageMoney = read("../src/server/stage-money.ts");
    expect(stageMoney).not.toMatch(/vat/i);
  });
});
