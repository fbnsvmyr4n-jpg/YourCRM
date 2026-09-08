import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * Billing the work.
 *
 * Invoicing was in the data model from the day documents were built — the kind
 * was allowed, `paid` was a status, the id prefix was written — and none of it
 * was reachable. The dropdown offered two kinds of three, nothing could be
 * sent, and no screen said what had been billed.
 *
 * The two properties worth defending are about money leaving and money coming
 * in exactly once:
 *
 *   - the figures on an invoice are the figures the client ACCEPTED, not a
 *     retype, so what was sold and what was billed cannot drift;
 *   - a job is billed once. Two invoices for one agreement is a phone call and
 *     a lost afternoon, and "did we already invoice this" had no answer before.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let raise: typeof import("../src/server/invoice-from-quote");
let invoices: typeof import("../src/server/repos/invoices");
let outbox: typeof import("../src/server/outbox");
let handlers: typeof import("../src/server/outbox-handlers");
let repo: typeof import("../src/server/repos/outbox");
let closePool: typeof import("../src/server/db").closePool;

const CTX: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX, fn);
const JOB = "d_bill";

type Sent = { to: string[]; subject: string; text: string; idempotencyKey: string | null };
let sends: Sent[] = [];
let reply: { status: number; body?: string } = { status: 200 };

function stubMail() {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes("api.resend.com")) throw new Error(`unexpected fetch to ${href}`);
    const body = JSON.parse(String(init?.body ?? "{}"));
    sends.push({
      to: body.to,
      subject: String(body.subject ?? ""),
      text: String(body.text ?? ""),
      idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
    });
    return new Response(reply.body ?? "{}", { status: reply.status });
  });
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  raise = await import("../src/server/invoice-from-quote");
  invoices = await import("../src/server/repos/invoices");
  outbox = await import("../src/server/outbox");
  handlers = await import("../src/server/outbox-handlers");
  repo = await import("../src/server/repos/outbox");
});

afterAll(async () => {
  delete process.env.RESEND_API_KEY;
  await closePool?.();
  await db.stop();
});

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  sends = [];
  reply = { status: 200 };
  stubMail();
  await db.seed(`
    DELETE FROM outbox; DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM project_tasks; DELETE FROM deals; DELETE FROM contacts;
    DELETE FROM settings WHERE sub_account_id = '${TENANT_A}';

    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email)
    VALUES ('ct_pay', '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test');

    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage)
    VALUES ('${JOB}', '${TENANT_A}', 'ct_pay', 'Rebuild warehouse', 100, 'won');

    INSERT INTO project_tasks (id, sub_account_id, deal_id, name)
    VALUES ('t_crane', '${TENANT_A}', '${JOB}', 'Mobile crane hire');`);
});

/** A quotation in whatever state the test needs, with its lines filed. */
const quote = (status: string, filed = true) =>
  db.seed(`
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, party_contact_id, notes)
    VALUES ('doc_q', '${TENANT_A}', '${JOB}', 'quote', 'Q-500', '${status}', 'Heineken', 'ct_pay', 'Valid 30 days.');
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position, project_task_id)
    VALUES ('l1', '${TENANT_A}', 'doc_q', 'Mobile crane hire', 3, 1200000, 0, ${filed ? "'t_crane'" : "NULL"}),
           ('l2', '${TENANT_A}', 'doc_q', 'Site survey', 2, 125050, 1, NULL);`);

describe("raising an invoice", () => {
  it("bills the figures the client accepted, unchanged", async () => {
    /* 3 × $12,000 + 2 × $1,250.50 = $36,000 + $2,501 = $38,501. By hand. */
    await quote("accepted");
    const result = await inA((q) => raise.raiseInvoiceFromQuote(q, JOB));

    expect(result.error).toBeUndefined();
    expect(result.fromQuote).toBe("Q-500");
    expect(result.totalCents).toBe(3_850_100);

    const invoice = await inA((q) => invoices.findInvoice(q, result.invoiceId!));
    expect(invoice?.lines.map((l) => l.description)).toEqual(["Mobile crane hire", "Site survey"]);
    expect(invoice?.totalCents).toBe(3_850_100);
    expect(invoice?.status, "an invoice is raised as a draft, not sent").toBe("draft");
  });

  it("carries the stage links across, so per-stage money keeps working", async () => {
    /* The invoice line points at the same task as the quote line it came from.
       Without this, billing a job would silently empty every stage's figures. */
    await quote("accepted");
    const result = await inA((q) => raise.raiseInvoiceFromQuote(q, JOB));
    const filed = await inA((q) =>
      q.rows<{ description: string; project_task_id: string | null }>(
        `SELECT description, project_task_id FROM document_lines WHERE document_id = $2 AND sub_account_id = $1 ORDER BY position`,
        [TENANT_A, result.invoiceId]
      )
    );
    expect(filed[0].project_task_id).toBe("t_crane");
    expect(filed[1].project_task_id, "an unfiled line stays unfiled").toBeNull();
  });

  it("REFUSES to bill the same job twice", async () => {
    /* The worst thing this feature could do. A client receiving two demands
       for one job is a phone call and a lost afternoon. */
    await quote("accepted");
    const first = await inA((q) => raise.raiseInvoiceFromQuote(q, JOB));
    expect(first.number).toBeTruthy();

    const second = await inA((q) => raise.raiseInvoiceFromQuote(q, JOB));
    expect(second.invoiceId).toBeUndefined();
    expect(second.error).toMatch(/already been raised/i);

    const count = await inA((q) =>
      q.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM documents WHERE sub_account_id = $1 AND kind = 'invoice'`,
        [TENANT_A]
      )
    );
    expect(count?.n).toBe("1");
  });

  it("refuses a quotation the client has not accepted", async () => {
    /* An invoice bills agreed work. Billing from a draft, or from something
       merely sent, is demanding money for a price nobody said yes to. */
    for (const status of ["draft", "awaiting_approval", "approved", "sent", "declined"]) {
      await db.seed(`DELETE FROM document_lines; DELETE FROM documents;`);
      await quote(status);
      const result = await inA((q) => raise.raiseInvoiceFromQuote(q, JOB));
      expect(result.invoiceId, `a ${status} quotation was billable`).toBeUndefined();
      expect(result.error).toMatch(/no accepted quotation/i);
    }
  });

  it("numbers invoices in their own sequence, continuing from the highest", async () => {
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
      VALUES ('old', '${TENANT_A}', '${JOB}', 'invoice', 'INV-1007', 'paid');`);
    expect(await inA((q) => raise.nextInvoiceNumber(q))).toBe("INV-1008");
  });

  it("ignores numbers that are not ours when working out the next one", async () => {
    /* A business that types its own numbers should not make the next
       generated one nonsense. */
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
      VALUES ('hand', '${TENANT_A}', '${JOB}', 'invoice', 'MARCH-2026-A', 'paid');`);
    expect(await inA((q) => raise.nextInvoiceNumber(q))).toBe("INV-1001");
  });
});

describe("sending an invoice", () => {
  const queueSend = (documentId: string) =>
    inA((q) =>
      outbox.queueJob(q, handlers.OUTBOX_REGISTRY, {
        handler: handlers.INVOICE_EMAIL,
        payload: { documentId },
        dedupeKey: handlers.invoiceEmailKey(documentId),
      })
    );

  async function raised() {
    await quote("accepted");
    const result = await inA((q) => raise.raiseInvoiceFromQuote(q, JOB));
    return result.invoiceId!;
  }

  it("sends it, marks it sent, and settles the job", async () => {
    const id = await raised();
    await queueSend(id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ ran: 1, done: 1 });
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toEqual(["amara@heineken.test"]);
    expect(sends[0].subject).toMatch(/^Invoice INV-\d+ — Rebuild warehouse$/);

    const after = await inA((q) => invoices.findInvoice(q, id));
    expect(after?.status).toBe("sent");
    expect(after?.sentAt).toBeTruthy();
  });

  it("REFUSES to send one that has already gone", async () => {
    /* Delivery is at least once, so the handler has to refuse rather than
       trust the queue. A client billed twice does not care whose fault it was. */
    const id = await raised();
    await queueSend(id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends).toHaveLength(1);

    await db.seed(`UPDATE outbox SET status = 'pending', run_after = now() - interval '1 second'`);
    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ done: 1 });
    expect(sends, "the client was billed twice").toHaveLength(1);
  });

  it("prints the payment details this workspace uses", async () => {
    /* An invoice without them is a demand with no way to satisfy it. */
    await db.seed(`
      INSERT INTO settings (sub_account_id, invoice_pay_to)
      VALUES ('${TENANT_A}', 'Standard Bank 123456789, ref your invoice number')
      ON CONFLICT (sub_account_id) DO UPDATE SET invoice_pay_to = EXCLUDED.invoice_pay_to;`);
    const id = await raised();
    await queueSend(id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends[0].text).toMatch(/Standard Bank 123456789/);
  });

  it("omits payment details rather than printing a blank line", async () => {
    /* A client reads "Payment details:" followed by nothing as a mistake, and
       inventing terms would be this app making up how somebody gets paid. */
    const id = await raised();
    await queueSend(id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends[0].text).not.toMatch(/Payment details/);
  });

  it("gives up on an address the provider refuses", async () => {
    reply = { status: 422, body: "invalid `to` field" };
    const id = await raised();
    await queueSend(id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ dead: 1 });
    const dead = await inA((q) => repo.deadJobs(q));
    expect(dead[0].handler).toBe(handlers.INVOICE_EMAIL);
  });

  it("keeps trying when the provider is down", async () => {
    reply = { status: 500, body: "down" };
    const id = await raised();
    await queueSend(id);
    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ retried: 1 });

    const still = await inA((q) => invoices.findInvoice(q, id));
    expect(still?.sentAt, "it was marked sent despite failing").toBeNull();
  });

  it("queues one job however many times send is pressed", async () => {
    const id = await raised();
    await queueSend(id);
    await queueSend(id);
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends).toHaveLength(1);
  });

  it("reads the address from the contact, not a copy on the document", async () => {
    /* An address copied at the moment a document was raised goes stale the
       first time somebody changes their email, and a bill nobody receives is
       a bill nobody pays. */
    const id = await raised();
    await db.seed(`UPDATE contacts SET email = 'accounts@heineken.test' WHERE id = 'ct_pay'`);
    await queueSend(id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends[0].to).toEqual(["accounts@heineken.test"]);
  });
});
