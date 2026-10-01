import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * The Inbox queue, audited against arithmetic rather than against the screen.
 *
 * The question behind all of it: does every surface that states something about
 * a ticket state the SAME thing? The bell counts overdue replies in SQL, the
 * queue draws them in the browser from the same rules, and the clock itself is
 * moved by a third piece of code when a message is recorded. Three readers of
 * one fact is where this product has repeatedly found its bugs.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let closePool: typeof import("../src/server/db").closePool;
let tickets: typeof import("../src/server/repos/tickets");
let inbox: typeof import("../src/server/repos/inbox");
let rules: typeof import("../src/server/ticket-rules");

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  tickets = await import("../src/server/repos/tickets");
  inbox = await import("../src/server/repos/inbox");
  rules = await import("../src/server/ticket-rules");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM tickets; DELETE FROM messages; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', 'amara@test.local');
  `)
);

/** A message on a thread, as the product records one. */
const say = (direction: "sent" | "received", sentAt: string, threadId = "th_1") =>
  inA((q) =>
    inbox.createMessage(q, {
      threadId,
      direction,
      channel: "email",
      sender: direction === "received" ? "Amara Dube" : "Us",
      senderEmail: direction === "received" ? "amara@test.local" : null,
      subject: "Fence quote",
      body: "…",
      sentAt,
      contactId: "ct_amara",
    } as Parameters<typeof inbox.createMessage>[1])
  );

describe("the clock a ticket starts on", () => {
  it("RUNS FROM THE EARLIEST UNANSWERED MESSAGE, not the most recent one", async () => {
    /*
       A customer wrote three days ago and chased an hour ago, and nobody has
       answered either. They have been waiting three days.

       Started from the latest message instead, a brand-new ticket on that
       thread reads "Reply within 24h" — the queue sorts it below work that
       arrived this morning and the bell does not count it, for the one customer
       in the workspace who has been ignored longest.
    */
    await say("received", ago(72 * HOUR));
    await say("received", ago(1 * HOUR));

    const opened = await inA((q) => tickets.openTicket(q, "th_1"));
    expect("ticket" in opened).toBe(true);
    if (!("ticket" in opened)) return;

    const since = Date.parse(opened.ticket.awaitingSince ?? "");
    const waitedHours = (Date.now() - since) / HOUR;
    expect(waitedHours).toBeGreaterThan(70);
    /* And so the bell sees it: 24h is the normal-priority promise. */
    expect(rules.isOverdue(opened.ticket, Date.now())).toBe(true);
  });

  it("owes nothing when we spoke last", async () => {
    await say("received", ago(5 * HOUR));
    await say("sent", ago(1 * HOUR));
    const opened = await inA((q) => tickets.openTicket(q, "th_1"));
    if (!("ticket" in opened)) throw new Error("not opened");
    expect(opened.ticket.status).toBe("waiting");
    expect(opened.ticket.awaitingSince).toBeNull();
  });

  it("runs from THEIR message, when they have written since our last reply", async () => {
    await say("received", ago(10 * HOUR));
    await say("sent", ago(8 * HOUR));
    await say("received", ago(3 * HOUR));
    const opened = await inA((q) => tickets.openTicket(q, "th_1"));
    if (!("ticket" in opened)) throw new Error("not opened");
    const waited = (Date.now() - Date.parse(opened.ticket.awaitingSince ?? "")) / HOUR;
    /* Three hours, not ten: the ten-hour-old one was answered. */
    expect(waited).toBeGreaterThan(2.5);
    expect(waited).toBeLessThan(4);
  });
});

describe("the bell and the queue", () => {
  it("COUNT THE SAME TICKETS — the bell's SQL against the queue's own rules", async () => {
    await say("received", ago(48 * HOUR), "th_late");
    await say("received", ago(1 * HOUR), "th_fresh");
    await inA((q) => tickets.openTicket(q, "th_late"));
    await inA((q) => tickets.openTicket(q, "th_fresh"));

    const counted = await inA((q) => tickets.overdueTickets(q, USER_A));
    const all = await inA((q) => tickets.listTickets(q));
    const byRules = all.filter((t) => rules.isOverdue(t, Date.now())).length;

    expect(counted.mine + counted.unassigned).toBe(byRules);
    expect(byRules).toBe(1);
  });

  it("DOES NOT NAG ABOUT A TICKET THE QUEUE CANNOT SHOW", async () => {
    /*
       The queue draws one row per ticket from that thread's latest message, and
       it skips trashed mail. Bin the only message on a thread whose ticket is
       still open and the bell goes on counting a reply that is owed on a
       conversation nothing on screen can reach — a badge that cannot be
       cleared, which is the thing a badge must never be.
    */
    const m = await say("received", ago(48 * HOUR));
    await inA((q) => tickets.openTicket(q, "th_1"));
    await inA((q) => inbox.trashMessage(q, m.id));

    const counted = await inA((q) => tickets.overdueTickets(q, USER_A));
    const visible = await inA(async (q) => {
      const msgs = [
        ...(await inbox.listMessages(q, "inbox")),
        ...(await inbox.listMessages(q, "sent")),
      ];
      const threads = new Set(msgs.map((x) => x.threadId));
      return (await tickets.listTickets(q)).filter((t) => threads.has(t.threadId));
    });

    expect(
      counted.mine + counted.unassigned,
      "the bell counts a ticket whose conversation is in the bin"
    ).toBe(visible.length);
  });
});

describe("what a reply does to the clock", () => {
  it("STOPS IT, and the ticket moves to waiting on the customer", async () => {
    await say("received", ago(5 * HOUR));
    await inA((q) => tickets.openTicket(q, "th_1"));
    await say("sent", ago(1 * HOUR));
    const [t] = await inA((q) => tickets.listTickets(q));
    expect(t.status).toBe("waiting");
    expect(t.awaitingSince).toBeNull();
    expect(rules.isOverdue(t, Date.now())).toBe(false);
  });

  it("does not stop it when the reply predates what they said", async () => {
    /* Logging yesterday's phone call does not answer this morning's email. */
    await say("received", ago(2 * HOUR));
    await inA((q) => tickets.openTicket(q, "th_1"));
    await say("sent", ago(20 * HOUR));
    const [t] = await inA((q) => tickets.listTickets(q));
    expect(t.status).toBe("open");
    expect(t.awaitingSince).not.toBeNull();
  });

  it("REOPENS on a new message from them, from the new message's time", async () => {
    await say("received", ago(30 * HOUR));
    await inA((q) => tickets.openTicket(q, "th_1"));
    await inA(async (q) => {
      const [t] = await tickets.listTickets(q);
      await tickets.updateTicket(q, t.id, { status: "resolved" });
    });
    await say("received", ago(1 * HOUR));
    const [t] = await inA((q) => tickets.listTickets(q));
    expect(t.status).toBe("open");
    /* One hour, not thirty: the old one was dealt with. */
    const waited = (Date.now() - Date.parse(t.awaitingSince ?? "")) / HOUR;
    expect(waited).toBeLessThan(2);
  });

  it("IS REOPENED BY AN UNANSWERED MESSAGE THAT PREDATES THE RESOLUTION", async () => {
    /* The 09:59 reply recorded at 10:01, either side of Resolve at 10:00. The
       old rule dropped it in silence; nobody owed the customer anything and no
       screen said so. */
    await say("received", ago(30 * HOUR));
    await inA((q) => tickets.openTicket(q, "th_1"));
    await inA(async (q) => {
      const [t] = await tickets.listTickets(q);
      await tickets.updateTicket(q, t.id, { status: "resolved" });
    });
    await say("received", ago(29 * HOUR));
    const [t] = await inA((q) => tickets.listTickets(q));
    expect(t.status).toBe("open");
  });

  it("stays resolved for an old message a reply of ours already answered", async () => {
    await say("received", ago(30 * HOUR));
    await inA((q) => tickets.openTicket(q, "th_1"));
    await say("sent", ago(20 * HOUR));
    await inA(async (q) => {
      const [t] = await tickets.listTickets(q);
      await tickets.updateTicket(q, t.id, { status: "resolved" });
    });
    /* Filed after the fact, and answered 20 hours ago. Nothing is owed. */
    await say("received", ago(25 * HOUR));
    const [t] = await inA((q) => tickets.listTickets(q));
    expect(t.status).toBe("resolved");
  });
});

describe("the order of the queue", () => {
  it("PUTS THE LONGEST-IGNORED CUSTOMER FIRST", async () => {
    await say("received", ago(2 * HOUR), "th_a");
    await say("received", ago(40 * HOUR), "th_b");
    await say("received", ago(6 * HOUR), "th_c");
    for (const th of ["th_a", "th_b", "th_c"]) await inA((q) => tickets.openTicket(q, th));

    const ordered = (await inA((q) => tickets.listTickets(q))).sort(rules.compareTickets);
    expect(ordered.map((t) => t.threadId)).toEqual(["th_b", "th_c", "th_a"]);
  });

  it("puts an urgent ticket ahead of a normal one that arrived at the same moment", async () => {
    const at = ago(1 * HOUR);
    await say("received", at, "th_a");
    await say("received", at, "th_b");
    await inA((q) => tickets.openTicket(q, "th_a"));
    await inA((q) => tickets.openTicket(q, "th_b", { priority: "urgent" }));
    const ordered = (await inA((q) => tickets.listTickets(q))).sort(rules.compareTickets);
    expect(ordered[0].threadId).toBe("th_b");
  });
});
