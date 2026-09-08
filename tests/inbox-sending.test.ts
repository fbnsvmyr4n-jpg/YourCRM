import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The Inbox, which used to record sends nobody made.
 *
 * The composer wrote a row with `direction = 'sent'` and transmitted nothing —
 * no provider, no queue, no send anywhere in the feature. Somebody typed a
 * message, pressed send, watched it appear in Sent, and the recipient received
 * nothing. Every Call / Text / Email control in the product leads there.
 *
 * So the property under test is not "email works". It is that **the ledger
 * cannot claim more than happened**:
 *
 *   - nothing reads `sent` until a provider accepted it;
 *   - a channel this product cannot transmit on says so instead of pretending;
 *   - a failure is recorded as a failure, not left looking queued for ever.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let inbox: typeof import("../src/server/repos/inbox");
let outbox: typeof import("../src/server/outbox");
let handlers: typeof import("../src/server/outbox-handlers");
let repo: typeof import("../src/server/repos/outbox");
let closePool: typeof import("../src/server/db").closePool;

const CTX: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX, fn);

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
  inbox = await import("../src/server/repos/inbox");
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
    DELETE FROM outbox; DELETE FROM messages; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_has',  '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test'),
      ('ct_none', '${TENANT_A}', 'Ben',   'Cole', NULL);`);
});

const write = (over: Partial<Parameters<typeof inbox.createMessage>[1]> = {}) =>
  inA((q) =>
    inbox.createMessage(q, {
      direction: "sent",
      contactId: "ct_has",
      channel: "email",
      subject: "About the warehouse",
      body: "Confirming Thursday at ten.",
      delivery: "logged",
      ...over,
    })
  );

/* The same door the Inbox action goes through, so what the tests exercise is
   what pressing Send exercises. */
const queue = (messageId: string) => inA((q) => handlers.queueMessageEmail(q, messageId));

describe("what the ledger is allowed to claim", () => {
  it("does not call a message sent just because it was written", async () => {
    /*
       The whole defect in one assertion. Creating an outgoing message records
       it; it does not transmit it, and the row must not say otherwise.
    */
    const message = await write();
    const stored = await inA((q) => inbox.findOutgoing(q, message.id));
    expect(stored?.delivery, "a freshly written message claimed to be sent").not.toBe("sent");
    expect(sends, "writing a message put something on the wire").toHaveLength(0);
  });

  it("says nothing about delivery for a message that came IN", async () => {
    /* Inbound is not ours to have sent, so the question does not apply and
       NULL says exactly that — rather than a state that reads like a claim. */
    const received = await inA((q) =>
      inbox.createMessage(q, {
        direction: "received",
        contactId: "ct_has",
        subject: "Re: the warehouse",
        body: "Thursday suits.",
      })
    );
    const row = await inA((q) =>
      q.one<{ delivery: string | null }>(`SELECT delivery FROM messages WHERE id = $2 AND sub_account_id = $1`, [
        TENANT_A,
        received.id,
      ])
    );
    expect(row?.delivery).toBeNull();
  });

  it("says queued the moment it is queued, not only once it lands", async () => {
    /* The two halves are one act. A job with no `queued` on the message tells
       the reader "recorded here only" about something already on its way. */
    const message = await write();
    await queue(message.id);
    const waiting = await inA((q) => inbox.findOutgoing(q, message.id));
    expect(waiting?.delivery).toBe("queued");
  });

  it("only reads `sent` once a provider has accepted it", async () => {
    const message = await write();
    await queue(message.id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ ran: 1, done: 1 });
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toEqual(["amara@heineken.test"]);
    expect(sends[0].subject).toBe("About the warehouse");
    expect(sends[0].text).toMatch(/Confirming Thursday at ten\./);

    const after = await inA((q) => inbox.findOutgoing(q, message.id));
    expect(after?.delivery).toBe("sent");
  });

  it("RECORDS A FAILURE AS A FAILURE, rather than leaving it looking queued", async () => {
    /* A message stuck on `queued` after we stopped trying is the same lie in a
       quieter font. */
    reply = { status: 422, body: "invalid `to` field" };
    const message = await write();
    await queue(message.id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ dead: 1 });
    const after = await inA((q) => inbox.findOutgoing(q, message.id));
    expect(after?.delivery).toBe("failed");
    expect(after?.deliveryError).toMatch(/address was refused/i);
    expect(after?.deliveryError, "raw provider JSON reached the screen").not.toMatch(/[{}"]/);
  });

  it("leaves it queued while the provider is merely down", async () => {
    /* Not a failure yet — something is still trying, and saying "failed" would
       send somebody chasing a message that is about to arrive. */
    reply = { status: 500, body: "down" };
    const message = await write();
    await queue(message.id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ retried: 1 });
    const after = await inA((q) => inbox.findOutgoing(q, message.id));
    expect(after?.delivery, "a retryable failure was written off").toBe("queued");
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);
  });
});

describe("channels this product cannot transmit on", () => {
  it("knows which ones it can send", () => {
    /* There is no messaging provider for WhatsApp or SMS anywhere in the
       codebase. Offering to send on them is the same class of untruth this
       change removes. */
    expect(inbox.canSendOn("email")).toBe(true);
    expect(inbox.canSendOn("whatsapp")).toBe(false);
    expect(inbox.canSendOn("sms")).toBe(false);
  });

  it("refuses to send one, rather than failing quietly or pretending", async () => {
    const message = await write({ channel: "whatsapp" });
    await queue(message.id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ dead: 1 });
    expect(sends).toHaveLength(0);
    const after = await inA((q) => inbox.findOutgoing(q, message.id));
    expect(after?.delivery).toBe("failed");
    expect(after?.deliveryError).toMatch(/whatsapp cannot be sent/i);
  });
});

describe("sending it once", () => {
  it("will not send the same message twice", async () => {
    /* Delivery is at least once, so the handler refuses rather than trusting
       the queue — a client receiving the same message twice does not care
       whose fault it was. */
    const message = await write();
    await queue(message.id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends).toHaveLength(1);

    await db.seed(`UPDATE outbox SET status = 'pending', run_after = now() - interval '1 second'`);
    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ done: 1 });
    expect(sends, "the recipient got it twice").toHaveLength(1);
  });

  it("queues one job however many times send is pressed", async () => {
    const message = await write();
    await queue(message.id);
    await queue(message.id);
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);
  });

  it("carries the job id to the provider as an idempotency key", async () => {
    const message = await write();
    const jobId = await queue(message.id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends[0].idempotencyKey).toBe(jobId);
  });
});

describe("who it goes to", () => {
  it("reads the address from the contact, not a copy on the message", async () => {
    /* An address frozen at compose time goes stale the first time somebody
       corrects an email, and a message nobody receives is worse than one never
       written. */
    const message = await write();
    await db.seed(`UPDATE contacts SET email = 'accounts@heineken.test' WHERE id = 'ct_has'`);
    await queue(message.id);
    await outbox.drain(CTX, handlers.OUTBOX_REGISTRY);
    expect(sends[0].to).toEqual(["accounts@heineken.test"]);
  });

  it("stops on a contact with no address, and says so on the message", async () => {
    const message = await write({ contactId: "ct_none" });
    await queue(message.id);

    expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ dead: 1 });
    const after = await inA((q) => inbox.findOutgoing(q, message.id));
    expect(after?.delivery).toBe("failed");
    expect(after?.deliveryError).toMatch(/no email address/i);
  });

  it("waits, rather than dying, when the workspace has no mail provider", async () => {
    /* Production's current state. These should go out when a key is set, not
       be dead by the time it is. */
    delete process.env.RESEND_API_KEY;
    try {
      const message = await write();
      await queue(message.id);
      expect(await outbox.drain(CTX, handlers.OUTBOX_REGISTRY)).toMatchObject({ retried: 1 });
      expect(sends).toHaveLength(0);
    } finally {
      process.env.RESEND_API_KEY = "re_test_not_a_real_key";
    }
  });
});
