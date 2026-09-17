import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * Card payment through a workspace's own Paystack account, on a real Postgres.
 *
 * Paystack is replaced by an injected `fetch` that answers the way its API
 * description says it does, so the request building, the response handling
 * and every refusal run for real — nothing here reaches the network.
 */

process.env.AUTH_SECRET = "test-secret-for-payments-0123456789abcdef";
const SECRET_KEY = "sk_test_abcdefghijklmnopqrstuvwxyz012345";
const OTHER_KEY = "sk_test_zyxwvutsrqponmlkjihgfedcba543210";

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let repo: typeof import("../src/server/repos/payments");
let pay: typeof import("../src/server/pay/pay");
let webhook: typeof import("../src/server/pay/webhook");
let paystack: typeof import("../src/server/paystack");
let secrets: typeof import("../src/server/secrets");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (sub: string): TenantContext => ({ agencyId: AGENCY, subAccountId: sub, userId: USER_A, role: "owner" });
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx(TENANT_A), fn);
const read = <T>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));

type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };

/** A pretend Paystack. `verify` decides what the verify endpoint says for a reference. */
function fakePaystack(opts: { acceptKey?: boolean; verify?: (reference: string) => Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, method: init?.method ?? "GET", body, auth });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (opts.acceptKey === false) return json(401, { status: false, message: "Invalid key" });
    if (url.includes("/transaction/initialize")) {
      return json(200, { status: true, message: "ok", data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "abc", reference: body.reference } });
    }
    if (url.includes("/transaction/verify/")) {
      const reference = decodeURIComponent(url.split("/transaction/verify/")[1]);
      return json(200, { status: true, message: "ok", data: { reference, channel: "card", paid_at: new Date().toISOString(), metadata: {}, ...opts.verify?.(reference) } });
    }
    return json(200, { status: true, message: "ok", data: [] });
  }) as typeof fetch;
  return { f, calls };
}

const TOKEN = "tok_invoice_a_0123456789abcdefghijklmno";

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/payments");
  pay = await import("../src/server/pay/pay");
  webhook = await import("../src/server/pay/webhook");
  paystack = await import("../src/server/paystack");
  secrets = await import("../src/server/secrets");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  await db.seed(`
    DELETE FROM todos; DELETE FROM invoice_payments; DELETE FROM payment_connections; DELETE FROM activities;
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO settings (sub_account_id, currency) VALUES ('${TENANT_A}', 'ZAR')
      ON CONFLICT (sub_account_id) DO UPDATE SET currency = 'ZAR';
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', 'amara@test.local');
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage, contact_id, owner_user_id) VALUES
      ('d_garden', '${TENANT_A}', 'Dube garden', 0, 'won', 'ct_amara', '${USER_A}'),
      ('d_theirs', '${TENANT_B}', 'Theirs', 0, 'won', NULL, NULL);
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party_contact_id, due_on, sent_at, pay_token) VALUES
      ('inv-a', '${TENANT_A}', 'd_garden', 'invoice', 'INV-1001', 'sent', 'ct_amara', current_date + 7, now(), '${TOKEN}');
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
      ('l1', '${TENANT_A}', 'inv-a', 'Maintenance', 1, 450000, 0);
  `);
});

const connect = async (key = SECRET_KEY) => {
  const { f } = fakePaystack();
  const out = await inA((q) => repo.connectPaystack(q, key, f));
  if ("error" in out) throw new Error(out.error);
};

describe("the secret key", () => {
  it("IS STORED ENCRYPTED, shows only its last four, and reads back", async () => {
    await connect();
    const [row] = await read<{ secret_encrypted: string; key_last4: string; mode: string }>(
      `SELECT secret_encrypted, key_last4, mode FROM payment_connections`
    );
    expect(row.secret_encrypted).not.toContain("sk_test");
    expect(row).toMatchObject({ key_last4: "2345", mode: "test" });
    expect(await inA((q) => repo.paystackSecret(q))).toBe(SECRET_KEY);
  });

  it("a tampered value does not decrypt to anything", () => {
    const stored = secrets.encryptSecret("sk_live_x");
    const [v, iv, tag, body] = stored.split(":");
    const flipped = Buffer.from(body, "base64");
    flipped[0] ^= 1;
    expect(secrets.decryptSecret([v, iv, tag, flipped.toString("base64")].join(":"))).toBeNull();
  });

  it("REFUSES A PUBLIC KEY, and a key Paystack rejects is not stored", async () => {
    expect(await inA((q) => repo.connectPaystack(q, "pk_live_abcdefghijklmnopqrstuvwxyz", fakePaystack().f))).toEqual({
      error: expect.stringMatching(/PUBLIC key/),
    });
    expect(await inA((q) => repo.connectPaystack(q, SECRET_KEY, fakePaystack({ acceptKey: false }).f))).toEqual({
      error: expect.stringMatching(/did not accept/),
    });
    expect(await read(`SELECT 1 FROM payment_connections`)).toEqual([]);
  });

  it("signatures: the right key matches, any other key or byte does not", () => {
    const body = JSON.stringify({ event: "charge.success" });
    const sig = createHmac("sha512", SECRET_KEY).update(body).digest("hex");
    expect(paystack.signatureMatches(body, sig, SECRET_KEY)).toBe(true);
    expect(paystack.signatureMatches(body, sig, OTHER_KEY)).toBe(false);
    expect(paystack.signatureMatches(body + " ", sig, SECRET_KEY)).toBe(false);
    expect(paystack.signatureMatches(body, null, SECRET_KEY)).toBe(false);
  });
});

describe("the pay page", () => {
  it("says plainly when the business does not take card payment", async () => {
    expect(await pay.loadPayPage(TOKEN)).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/does not take card payments/) });
  });

  it("an unknown token is simply not found", async () => {
    expect(await pay.loadPayPage("tok_nobody_0123456789abcdefghijklmnopqr")).toEqual({ state: "not_found" });
  });

  it("STARTS A CHECKOUT FOR WHAT IS OWED, in the workspace's currency, to the client's email", async () => {
    await connect();
    const { f, calls } = fakePaystack();
    expect(await pay.startPayment(TOKEN, f)).toEqual({ url: "https://checkout.paystack.com/abc" });
    const init = calls.find((c) => c.url.endsWith("/transaction/initialize"))!;
    expect(init.auth).toBe(`Bearer ${SECRET_KEY}`);
    expect(init.body).toMatchObject({ email: "amara@test.local", amount: 450000, currency: "ZAR", callback_url: `http://localhost:3100/pay/${TOKEN}` });
    expect(String(init.body!.reference)).toMatch(/^yc_inv-a_[0-9a-f]{12}$/);
  });

  it("will not take payment for an invoice that has not been issued", async () => {
    await connect();
    await db.seed(`UPDATE documents SET sent_at = NULL, status = 'draft'`);
    expect(await pay.startPayment(TOKEN, fakePaystack().f)).toEqual({ error: "This invoice has not been issued yet." });
  });
});

describe("pay links", () => {
  it("ONLY AN INVOICE STILL TO BE PAID GETS ONE", async () => {
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status) VALUES
        ('inv-paid', '${TENANT_A}', 'd_garden', 'invoice', 'INV-2', 'paid'),
        ('inv-void', '${TENANT_A}', 'd_garden', 'invoice', 'INV-3', 'cancelled'),
        ('inv-new', '${TENANT_A}', 'd_garden', 'invoice', 'INV-4', 'sent');`);
    expect(await inA((q) => repo.ensurePayToken(q, "inv-paid"))).toBeNull();
    expect(await inA((q) => repo.ensurePayToken(q, "inv-void"))).toBeNull();
    const first = await inA((q) => repo.ensurePayToken(q, "inv-new"));
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await inA((q) => repo.ensurePayToken(q, "inv-new"))).toBe(first);
  });
});

describe("recording money", () => {
  const good = (reference: string) => ({ status: "success", amount: 450000, currency: "ZAR", reference });

  it("MARKS THE INVOICE PAID ONLY WHEN PAYSTACK CONFIRMS IT, once however often it is told", async () => {
    await connect();
    const { f } = fakePaystack({ verify: good });
    const ref = repo.paymentReference("inv-a");
    expect(await pay.confirmReturn(TOKEN, ref, f)).toEqual({ outcome: "paid", number: "INV-1001" });
    expect(await pay.confirmReturn(TOKEN, ref, f)).toEqual({ outcome: "already_recorded" });
    expect(await read(`SELECT status FROM documents WHERE id = 'inv-a'`)).toEqual([{ status: "paid" }]);
    expect(await read(`SELECT count(*)::int AS n FROM invoice_payments`)).toEqual([{ n: 1 }]);
    expect(await pay.loadPayPage(TOKEN)).toMatchObject({ state: "paid" });
  });

  it("a declined or abandoned payment records nothing and says so", async () => {
    await connect();
    const out = await pay.confirmReturn(TOKEN, repo.paymentReference("inv-a"), fakePaystack({ verify: () => ({ status: "abandoned", amount: 450000, currency: "ZAR" }) }).f);
    expect(out).toEqual({ outcome: "failed", message: "The payment was not completed. You can try again." });
    expect(await read(`SELECT status FROM documents WHERE id = 'inv-a'`)).toEqual([{ status: "sent" }]);
  });

  it("A REFERENCE FOR ANOTHER INVOICE, OR THE WRONG CURRENCY, IS REFUSED", async () => {
    await connect();
    const f = fakePaystack({ verify: good }).f;
    expect(await pay.confirmReturn(TOKEN, repo.paymentReference("inv-other"), f)).toMatchObject({ outcome: "ignored" });
    const usd = fakePaystack({ verify: (reference) => ({ ...good(reference), currency: "USD" }) }).f;
    expect(await pay.confirmReturn(TOKEN, repo.paymentReference("inv-a"), usd)).toEqual({
      outcome: "ignored",
      reason: "paid in a different currency",
    });
    expect(await read(`SELECT count(*)::int AS n FROM invoice_payments`)).toEqual([{ n: 0 }]);
  });

  it("A RETURN CARRYING ANOTHER INVOICE'S REFERENCE RECORDS NOTHING, even in the same workspace", async () => {
    await connect();
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, sent_at) VALUES
        ('inv-b', '${TENANT_A}', 'd_garden', 'invoice', 'INV-1002', 'sent', now());
      INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
        ('lb', '${TENANT_A}', 'inv-b', 'Other', 1, 450000, 0);`);
    const f = fakePaystack({ verify: good }).f;
    expect(await pay.confirmReturn(TOKEN, repo.paymentReference("inv-b"), f)).toEqual({
      outcome: "ignored",
      reason: "reference is for another invoice",
    });
    expect(await read(`SELECT count(*)::int AS n FROM invoice_payments`)).toEqual([{ n: 0 }]);
  });

  it("a payment that falls short is recorded and the invoice stays open", async () => {
    await connect();
    const short = fakePaystack({ verify: (reference) => ({ ...good(reference), amount: 100000 }) }).f;
    expect(await pay.confirmReturn(TOKEN, repo.paymentReference("inv-a"), short)).toEqual({
      outcome: "part_paid",
      number: "INV-1001",
      paidCents: 100000,
      totalCents: 450000,
    });
    expect(await pay.loadPayPage(TOKEN)).toMatchObject({ state: "payable", outstandingCents: 350000 });
    const again = fakePaystack();
    await pay.startPayment(TOKEN, again.f);
    expect(again.calls.find((c) => c.url.endsWith("/transaction/initialize"))!.body).toMatchObject({ amount: 350000 });
  });
});

describe("the webhook", () => {
  const sign = (body: string, key = SECRET_KEY) => createHmac("sha512", key).update(body).digest("hex");

  it("REFUSES A BODY NOT SIGNED BY THIS WORKSPACE'S KEY — and an unknown workspace looks the same", async () => {
    await connect();
    const body = JSON.stringify({ event: "charge.success", data: { reference: repo.paymentReference("inv-a") } });
    expect((await webhook.handlePaystackWebhook(AGENCY, TENANT_A, body, sign(body, OTHER_KEY))).status).toBe(401);
    expect((await webhook.handlePaystackWebhook("ag_other", TENANT_A, body, sign(body))).status).toBe(401);
    expect(await read(`SELECT 1 FROM invoice_payments`)).toEqual([]);
  });

  it("A SIGNED charge.success IS STILL VERIFIED WITH PAYSTACK before money is recorded", async () => {
    await connect();
    const ref = repo.paymentReference("inv-a");
    const body = JSON.stringify({ event: "charge.success", data: { reference: ref, amount: 450000 } });
    const lying = fakePaystack({ verify: () => ({ status: "failed", amount: 450000, currency: "ZAR" }) });
    expect(await webhook.handlePaystackWebhook(AGENCY, TENANT_A, body, sign(body), lying.f)).toEqual({
      status: 200,
      body: { received: true, outcome: "ignored" },
    });
    expect(lying.calls.some((c) => c.url.includes(`/transaction/verify/${ref}`))).toBe(true);

    const honest = fakePaystack({ verify: (reference) => ({ status: "success", amount: 450000, currency: "ZAR", reference }) });
    expect((await webhook.handlePaystackWebhook(AGENCY, TENANT_A, body, sign(body), honest.f)).body).toEqual({
      received: true,
      outcome: "paid",
    });
  });

  it("A CHARGEBACK REOPENS THE INVOICE AND RAISES ONE TASK for the project's owner", async () => {
    await connect();
    const ref = repo.paymentReference("inv-a");
    await pay.confirmReturn(TOKEN, ref, fakePaystack({ verify: (reference) => ({ status: "success", amount: 450000, currency: "ZAR", reference }) }).f);
    const body = JSON.stringify({ event: "charge.dispute.create", data: { transaction: { reference: ref } } });
    await webhook.handlePaystackWebhook(AGENCY, TENANT_A, body, sign(body));
    await webhook.handlePaystackWebhook(AGENCY, TENANT_A, body, sign(body));
    expect(await read(`SELECT title, assignee_user_id FROM todos`)).toEqual([
      { title: "Payment disputed on INV-1001", assignee_user_id: USER_A },
    ]);
    expect(await read(`SELECT status FROM documents WHERE id = 'inv-a'`)).toEqual([{ status: "sent" }]);
  });

  it("events it has no use for are acknowledged, not retried", async () => {
    await connect();
    const body = JSON.stringify({ event: "transfer.success", data: {} });
    expect(await webhook.handlePaystackWebhook(AGENCY, TENANT_A, body, sign(body))).toEqual({
      status: 200,
      body: { ignored: "transfer.success" },
    });
  });
});

describe("chasing overdue invoices", () => {
  it("RAISES ONE TASK PER OVERDUE INVOICE, and leaves paid, draft and long-forgotten ones alone", async () => {
    await db.seed(`
      UPDATE documents SET due_on = '2026-09-10' WHERE id = 'inv-a';
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, due_on) VALUES
        ('inv-paid',  '${TENANT_A}', 'd_garden', 'invoice', 'INV-1002', 'paid',  '2026-09-10'),
        ('inv-draft', '${TENANT_A}', 'd_garden', 'invoice', 'INV-1003', 'draft', '2026-09-10'),
        ('inv-old',   '${TENANT_A}', 'd_garden', 'invoice', 'INV-1004', 'sent',  '2026-06-01'),
        ('inv-future','${TENANT_A}', 'd_garden', 'invoice', 'INV-1005', 'sent',  '2026-09-30');
    `);
    expect(await inA((q) => repo.chaseOverdueInvoices(q, "2026-09-18"))).toBe(1);
    expect(await inA((q) => repo.chaseOverdueInvoices(q, "2026-09-19"))).toBe(0);
    expect(await read(`SELECT title, due_on::text AS due, deal_id FROM todos`)).toEqual([
      { title: "Chase INV-1001 — payment overdue", due: "2026-09-18", deal_id: "d_garden" },
    ]);
  });
});
