import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The jobs the queue runs, and the promise each of them keeps.
 *
 * The queue itself is proven in `outbox.test.ts`. What is proven here is the
 * thing a customer would notice: **a quotation is emailed once.**
 *
 * That is harder than it sounds, and the hard part is not the happy path. A
 * process can die after the mail provider has accepted the request and before
 * anything on this side records that it did — so the job comes back, and the
 * send is genuinely attempted a second time. Nothing local can prevent that.
 * What can be done is to make the second attempt harmless, and the tests below
 * are the two mechanisms that do it: the same idempotency key reaches the
 * provider each time, and the handler refuses a quotation already marked sent.
 *
 * The mail provider is stubbed at `fetch`, so what is asserted is the actual
 * HTTP request this code would make — headers included.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let outbox: typeof import("../src/server/outbox");
let handlers: typeof import("../src/server/outbox-handlers");
let repo: typeof import("../src/server/repos/outbox");
let quotes: typeof import("../src/server/repos/quotes");
let closePool: typeof import("../src/server/db").closePool;

const CTX: TenantContext = {
  agencyId: AGENCY,
  subAccountId: TENANT_A,
  userId: USER_A,
  role: "owner",
};
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX, fn);

const JOB = "d_outbox_job";
const CRANE = 1_200_000;

/** Every request the code made to Resend, and what it was told in reply. */
type Sent = { to: string[]; idempotencyKey: string | null; text: string };
let sends: Sent[] = [];
let reply: { status: number; body?: string } = { status: 200 };

function stubMail() {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes("api.resend.com")) throw new Error(`unexpected fetch to ${href}`);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}"));
    sends.push({
      to: body.to,
      text: String(body.text ?? ""),
      idempotencyKey: headers.get("Idempotency-Key"),
    });
    return new Response(reply.body ?? "{}", { status: reply.status });
  });
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  outbox = await import("../src/server/outbox");
  handlers = await import("../src/server/outbox-handlers");
  repo = await import("../src/server/repos/outbox");
  quotes = await import("../src/server/repos/quotes");
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
    DELETE FROM outbox;
    DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM price_items; DELETE FROM deals;
    DELETE FROM contacts; DELETE FROM companies;

    INSERT INTO companies (id, sub_account_id, name) VALUES ('co_h', '${TENANT_A}', 'Heineken');
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, company_id) VALUES
      ('ct_buyer',   '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test', 'co_h'),
      ('ct_noemail', '${TENANT_A}', 'Ben',   'Cole', NULL,                  'co_h');
    INSERT INTO deals (id, sub_account_id, company_id, contact_id, title, value_cents, stage)
    VALUES ('${JOB}', '${TENANT_A}', 'co_h', 'ct_buyer', 'Rebuild warehouse', 1800000_00, 'discovery');`);
});

/** An approved quotation, ready to go out, addressed to whoever is named. */
async function approvedQuote(partyContactId = "ct_buyer") {
  const draft = await inA((q) =>
    quotes.draftQuote(q, {
      dealId: JOB,
      partyContactId,
      party: "Amara Dube, Heineken",
      notes: null,
      lines: [{ description: "Mobile crane hire", quantity: 1, unitCents: CRANE }],
      agent: "chat",
    })
  );
  const id = draft.quote!.id;
  await inA((q) => quotes.approveQuote(q, id));
  return id;
}

/** Queue the send the way the approve action does. */
const queueSend = (documentId: string) =>
  inA((q) =>
    outbox.queueJob(q, handlers.OUTBOX_REGISTRY, {
      handler: handlers.QUOTE_EMAIL,
      payload: { documentId },
      dedupeKey: handlers.quoteEmailKey(documentId),
    })
  );

describe("emailing an approved quotation", () => {
  it("sends it, marks it sent, and settles the job", async () => {
    const id = await approvedQuote();
    await queueSend(id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ ran: 1, done: 1 });
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toEqual(["amara@heineken.test"]);

    const quote = await inA((q) => quotes.findQuote(q, id));
    expect(quote?.status).toBe("sent");
    expect(quote?.sentAt).toBeTruthy();
  });

  it("carries the job id to the provider as an idempotency key", async () => {
    /* The only place a duplicate can actually be stopped. Our side of the
       wire cannot know whether a request the process died during was
       received; theirs can. */
    const id = await approvedQuote();
    const jobId = await queueSend(id);

    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends[0].idempotencyKey).toBe(jobId);
    expect(sends[0].idempotencyKey!.length).toBeLessThanOrEqual(256);
  });

  it("KEEPS THE SAME KEY when the job is retried", async () => {
    /*
       The property, and the reason the key is the job id rather than something
       generated per attempt: a fresh key on each retry would make every
       duplicate a new email in the provider's eyes, which is precisely the
       case the key exists to cover.
    */
    reply = { status: 503, body: "upstream unavailable" };
    const id = await approvedQuote();
    const jobId = await queueSend(id);

    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    await db.seed(`UPDATE outbox SET run_after = now() - interval '1 second'`);
    reply = { status: 200 };
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);

    expect(sends).toHaveLength(2);
    expect(sends[0].idempotencyKey).toBe(jobId);
    expect(sends[1].idempotencyKey).toBe(jobId);
  });

  it("REFUSES to send a quotation that already went", async () => {
    /*
       The second guard, and the one that does not depend on the provider
       honouring anything. The old code would happily send again — that was
       the defect: crash after the send, press the button, and the client gets
       the same price twice.
    */
    const id = await approvedQuote();
    await queueSend(id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends).toHaveLength(1);

    // Force the job back into the queue, as a crashed worker's lease expiring
    // would, and run it again.
    await db.seed(`UPDATE outbox SET status = 'pending', run_after = now() - interval '1 second'`);
    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ done: 1 });
    expect(sends, "a quotation already marked sent must not go out again").toHaveLength(1);
  });

  it("re-reads the quotation instead of trusting the job", async () => {
    /* A job queued two minutes ago must act on what is true now. Somebody
       discarded this one in the meantime; nothing should be emailed, and
       nothing has gone wrong. */
    const id = await approvedQuote();
    await queueSend(id);
    await db.seed(`UPDATE documents SET deleted_at = now() WHERE id = '${id}'`);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ done: 1 });
    expect(sends).toHaveLength(0);
  });

  it("gives up at once on an address the provider refuses", async () => {
    /* A 422 will be a 422 for ever. Six goes over two hours only delay the
       moment somebody finds out. */
    reply = { status: 422, body: "invalid `to` field" };
    const id = await approvedQuote();
    await queueSend(id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ dead: 1 });
    const dead = await inA((q) => repo.deadJobs(q));
    expect(dead[0].lastError).toMatch(/422/);
  });

  it("waits out a provider that is down", async () => {
    reply = { status: 500, body: "internal error" };
    const id = await approvedQuote();
    await queueSend(id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ retried: 1 });
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);
  });

  it("stops on a quotation nobody approved", async () => {
    /* The last gate before a price reaches a customer, read from the database
       rather than trusted from whoever queued the job. */
    const draft = await inA((q) =>
      quotes.draftQuote(q, {
        dealId: JOB,
        partyContactId: "ct_buyer",
        party: "Amara Dube",
        notes: null,
        lines: [{ description: "Mobile crane hire", quantity: 1, unitCents: CRANE }],
        agent: "chat",
      })
    );
    await queueSend(draft.quote!.id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ dead: 1 });
    expect(sends).toHaveLength(0);
  });

  it("stops on a contact with no address", async () => {
    const id = await approvedQuote("ct_noemail");
    await queueSend(id);
    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ dead: 1 });
    expect(sends).toHaveLength(0);
  });

  it("waits, rather than dying, when the workspace has no email configured", async () => {
    /* A workspace that switches email on this afternoon should find its
       queued quotations go out — not find them dead. */
    delete process.env.RESEND_API_KEY;
    try {
      const id = await approvedQuote();
      await queueSend(id);
      expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ retried: 1 });
    } finally {
      process.env.RESEND_API_KEY = "re_test_not_a_real_key";
    }
  });

  it("names the person who APPROVED it, not whoever sent it", async () => {
    /*
       A defect this change would have introduced, caught before it shipped.

       The approver's name used to come from the acting session, which was
       right while sending happened inside the approver's own request. Now the
       scheduled sweep can send it, and the sweep has no person behind it — so
       the same quotation would be signed by a name when a request drained it
       and by nobody when the sweep did. The name has to come off the document.
    */
    const id = await approvedQuote();
    await queueSend(id);

    // Drained by something with no user at all, exactly as the sweep does it.
    await outbox.drain({ ...CTX, userId: "" }, handlers.OUTBOX_REGISTRY);

    expect(sends).toHaveLength(1);
    expect(sends[0].text, "the email must still name the approver").toContain("Tester");
  });

  it("queues one job however many times approve is pressed", async () => {
    const id = await approvedQuote();
    await queueSend(id);
    await queueSend(id);
    await queueSend(id);
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);

    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends).toHaveLength(1);
  });
});

describe("analysing a finished call", () => {
  const CALL = "call_outbox_1";

  const queueAnalysis = (callId: string) =>
    inA((q) =>
      outbox.queueJob(q, handlers.OUTBOX_REGISTRY, {
        handler: handlers.CALL_ANALYSIS,
        payload: { callId },
        dedupeKey: handlers.callAnalysisKey(callId),
      })
    );

  beforeEach(async () => {
    await db.seed(`
      DELETE FROM call_analysis; DELETE FROM calls;
      INSERT INTO calls (id, sub_account_id, caller_name, phone, duration_sec, outcome, summary, transcript)
      VALUES ('${CALL}', '${TENANT_A}', 'Marcus Reid', '+27824471190', 200, 'qualified', 'Wants a crane.',
        '[{"role":"agent","text":"Thanks for calling."},
          {"role":"caller","text":"We need a mobile crane for three days."},
          {"role":"agent","text":"I will send a quotation."}]'::jsonb);`);
  });

  it("settles quietly when there is no model to read the call", async () => {
    /*
       No API key is "nothing to do", not "it failed". A dead row for every
       call in a deployment without a key would bury the one list a person
       reads when something has actually gone wrong.
    */
    const had = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await queueAnalysis(CALL);
      expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ ran: 1, done: 1 });
    } finally {
      if (had) process.env.ANTHROPIC_API_KEY = had;
    }
  });

  it("settles when the call has been deleted since", async () => {
    await queueAnalysis(CALL);
    await db.seed(`UPDATE calls SET deleted_at = now() WHERE id = '${CALL}'`);
    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ done: 1 });
  });

  it("queues one analysis however many times the webhook is redelivered", async () => {
    /* Twilio retries its status callback. Two jobs would be two readings of
       one call, and two charges for it. */
    await queueAnalysis(CALL);
    await queueAnalysis(CALL);
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);
  });
});
