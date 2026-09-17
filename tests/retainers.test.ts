import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/** Retainers on a real Postgres: the invoices they raise, once each, and the controls. */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let repo: typeof import("../src/server/repos/retainers");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (sub: string): TenantContext => ({ agencyId: AGENCY, subAccountId: sub, userId: USER_A, role: "owner" });
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx(TENANT_A), fn);
const read = <T>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));

const monthly = { description: "Garden maintenance", amountCents: 450_000, every: "month" as const, endsOn: null, dueDays: 7 };

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/retainers");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM retainers; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', 'amara@test.local');
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage, contact_id) VALUES
      ('d_garden', '${TENANT_A}', 'Dube garden', 0, 'won', 'ct_amara'),
      ('d_theirs', '${TENANT_B}', 'Theirs', 0, 'won', NULL);
  `)
);

const create = (startsOn: string, over: Partial<typeof monthly> = {}) =>
  inA(async (q) => {
    const out = await repo.createRetainer(q, "d_garden", { ...monthly, ...over, startsOn });
    if ("error" in out) throw new Error(out.error);
    return out.retainer;
  });

describe("raising invoices", () => {
  it("RAISES ONE DRAFT PER PERIOD THAT HAS STARTED, to the project's client, due on the terms", async () => {
    await create("2026-07-01");
    const out = await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-01"));
    expect(out).toEqual({ raised: 3, numbers: ["INV-1001", "INV-1002", "INV-1003"] });

    const docs = await read<{ number: string; status: string; party: string; party_contact_id: string; issued_on: string; due_on: string; period_start: string }>(
      `SELECT number, status, party, party_contact_id, issued_on::text AS issued_on, due_on::text AS due_on, period_start::text AS period_start
         FROM documents ORDER BY number`
    );
    expect(docs[2]).toEqual({
      number: "INV-1003",
      status: "draft",
      party: "Amara Dube",
      party_contact_id: "ct_amara",
      issued_on: "2026-09-01",
      due_on: "2026-09-08",
      period_start: "2026-09-01",
    });
    const [line] = await read<{ description: string; quantity: string; unit_cents: string }>(
      `SELECT description, quantity::text AS quantity, unit_cents::text AS unit_cents FROM document_lines
        WHERE document_id = (SELECT id FROM documents WHERE number = 'INV-1003')`
    );
    expect(line).toEqual({ description: "Garden maintenance — 1–30 Sep 2026", quantity: "1.000", unit_cents: "450000" });
  });

  it("RUNNING AGAIN RAISES NOTHING — and the retainer knows where it is", async () => {
    const r = await create("2026-08-01");
    await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-10"));
    expect(await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-10"))).toEqual({ raised: 0, numbers: [] });
    const [after] = await inA((q) => repo.listRetainers(q, "d_garden"));
    expect(after).toMatchObject({ id: r.id, periodsBilled: 2, nextInvoiceOn: "2026-10-01" });
  });

  it("A PERIOD ALREADY BILLED IS SKIPPED, never billed twice, and the retainer still moves on", async () => {
    const r = await create("2026-09-01");
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, retainer_id, period_start)
      VALUES ('inv_existing', '${TENANT_A}', 'd_garden', 'invoice', 'INV-5000', '${r.id}', '2026-09-01')`);
    expect(await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-02"))).toEqual({ raised: 0, numbers: [] });
    expect((await inA((q) => repo.listRetainers(q)))[0].nextInvoiceOn).toBe("2026-10-01");
  });

  it("does not bill a project that has been deleted", async () => {
    await create("2026-09-01");
    await db.seed(`UPDATE deals SET deleted_at = now() WHERE id = 'd_garden'`);
    expect((await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-02"))).raised).toBe(0);
  });

  it("A RETAINER INVOICE DOES NOT STOP THE PROJECT BEING INVOICED FROM ITS QUOTE", async () => {
    await create("2026-09-01");
    await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-01"));
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status) VALUES ('q1', '${TENANT_A}', 'd_garden', 'quote', 'Q-1', 'accepted');
      INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position)
        VALUES ('ql1', '${TENANT_A}', 'q1', 'Landscaping', 1, 1000000, 0);`);
    const { raiseInvoiceFromQuote } = await import("../src/server/invoice-from-quote");
    expect(await inA((q) => raiseInvoiceFromQuote(q, "d_garden"))).toMatchObject({ number: "INV-1002", fromQuote: "Q-1" });
  });
});

describe("pausing, resuming, cancelling", () => {
  it("RESUMING SKIPS THE PAUSED MONTHS rather than billing them", async () => {
    const r = await create("2026-01-15");
    await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-02-20"));
    await inA((q) => repo.setRetainerStatus(q, r.id, "paused", "2026-02-20"));
    expect((await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-06-01"))).raised).toBe(0);

    const resumed = await inA((q) => repo.setRetainerStatus(q, r.id, "active", "2026-06-10"));
    expect(resumed).toMatchObject({ retainer: { status: "active", nextInvoiceOn: "2026-06-15" } });
    expect((await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-06-15"))).raised).toBe(1);
    expect(await read(`SELECT count(*)::int AS n FROM documents`)).toEqual([{ n: 3 }]);
  });

  it("cancelling is final, and keeps what was raised", async () => {
    const r = await create("2026-09-01");
    await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-01"));
    await inA((q) => repo.setRetainerStatus(q, r.id, "cancelled", "2026-09-05"));
    expect(await inA((q) => repo.setRetainerStatus(q, r.id, "active", "2026-09-05"))).toEqual({
      error: "That retainer has been cancelled.",
    });
    expect((await inA((q) => repo.raiseDueRetainerInvoices(q, "2027-01-01"))).raised).toBe(0);
    expect(await read(`SELECT count(*)::int AS n FROM documents`)).toEqual([{ n: 1 }]);
  });

  it("a change of amount applies to what is billed next, not what was billed", async () => {
    const r = await create("2026-09-01");
    await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-01"));
    await inA((q) => repo.updateRetainer(q, r.id, { ...monthly, amountCents: 500_000 }));
    await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-10-01"));
    expect(
      await read(`SELECT d.period_start::text AS period, l.unit_cents::text AS c FROM document_lines l
                    JOIN documents d ON d.id = l.document_id ORDER BY d.period_start`)
    ).toEqual([
      { period: "2026-09-01", c: "450000" },
      { period: "2026-10-01", c: "500000" },
    ]);
  });
});

describe("the workspace boundary and the bell", () => {
  it("cannot put another workspace's project on a retainer", async () => {
    expect(await inA((q) => repo.createRetainer(q, "d_theirs", { ...monthly, startsOn: "2026-09-01" }))).toEqual({
      error: "That project no longer exists.",
    });
  });

  it("the database refuses it even when asked directly", async () => {
    await expect(
      db.seed(`INSERT INTO retainers (id, sub_account_id, deal_id, description, amount_cents, every, starts_on, next_invoice_on)
               VALUES ('rt_x', '${TENANT_A}', 'd_theirs', 'x', 1, 'month', '2026-09-01', '2026-09-01')`)
    ).rejects.toThrow(/does not belong/);
  });

  it("SAYS HOW MANY RETAINER INVOICES WAIT TO BE SENT, and links to the project", async () => {
    await create("2026-08-01");
    await inA((q) => repo.raiseDueRetainerInvoices(q, "2026-09-01"));
    const notifications = await import("../src/server/notifications");
    const item = (await inA((q) => notifications.listNotifications(q))).find((n) => n.id === "retainer-drafts");
    expect(item).toMatchObject({ title: "2 retainer invoices ready to send", href: "/projects/d_garden" });

    await db.seed(`UPDATE documents SET status = 'sent'`);
    expect((await inA((q) => notifications.listNotifications(q))).find((n) => n.id === "retainer-drafts")).toBeUndefined();
  });

  it("a failure while raising never breaks the request that tried", async () => {
    const { raiseRetainersSafely } = await import("../src/server/retainer-run");
    await create("2020-01-01");
    /* Force a failure the raise cannot treat as "already billed". */
    await db.seed(`ALTER TABLE document_lines ADD CONSTRAINT tmp_refuse CHECK (unit_cents < 0) NOT VALID`);
    try {
      const out = await inA(async (q) => ({ raised: await raiseRetainersSafely(q), stillWorks: (await repo.listRetainers(q)).length }));
      expect(out).toEqual({ raised: 0, stillWorks: 1 });
      expect(await read(`SELECT count(*)::int AS n FROM documents`)).toEqual([{ n: 0 }]);
    } finally {
      await db.seed(`ALTER TABLE document_lines DROP CONSTRAINT tmp_refuse`);
    }
  });
});
