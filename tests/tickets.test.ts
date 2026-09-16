import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/** Tickets on Inbox threads, on a real Postgres: opening, the clock, and who owns them. */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let tickets: typeof import("../src/server/repos/tickets");
let inbox: typeof import("../src/server/repos/inbox");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (sub: string): TenantContext => ({ agencyId: AGENCY, subAccountId: sub, userId: USER_A, role: "owner" });
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx(TENANT_A), fn);
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const row = async (thread: string) =>
  (
    await withSystem((q) => q.rows<{ status: string; awaiting_since: Date | null; resolved_at: Date | null }>(
      `SELECT status, awaiting_since, resolved_at FROM tickets WHERE thread_id = '${thread}'`
    ))
  )[0];

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  tickets = await import("../src/server/repos/tickets");
  inbox = await import("../src/server/repos/inbox");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM tickets; DELETE FROM messages;
    DELETE FROM users WHERE id IN ('u_other_ws', 'u_gone');
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('u_other_ws', '${AGENCY}', '${TENANT_B}', 'b@test.local', 'x', 'Other', 'member');
    INSERT INTO messages (id, sub_account_id, thread_id, direction, subject, body, sent_at) VALUES
      ('m_in',  '${TENANT_A}', 'th_theirs', 'received', 'Leak', 'The roof leaks', '${ago(5)}'),
      ('m_out', '${TENANT_A}', 'th_ours',   'sent',     'Quote', 'Here it is',    '${ago(2)}'),
      ('m_b',   '${TENANT_B}', 'th_b',      'received', 'B', 'b', now());
  `)
);

describe("opening a ticket", () => {
  it("STARTS THE CLOCK FROM THE CUSTOMER'S MESSAGE when they spoke last", async () => {
    const out = await inA((q) => tickets.openTicket(q, "th_theirs"));
    if (!("ticket" in out)) throw new Error(out.error);
    expect(out.ticket.status).toBe("open");
    expect(Math.abs(Date.parse(out.ticket.awaitingSince!) - Date.parse(ago(5)))).toBeLessThan(5_000);
  });

  it("starts out waiting on them when we spoke last", async () => {
    const out = await inA((q) => tickets.openTicket(q, "th_ours"));
    expect(out).toMatchObject({ ticket: { status: "waiting", awaitingSince: null } });
  });

  it("opening twice returns the same ticket rather than a second", async () => {
    const first = await inA((q) => tickets.openTicket(q, "th_theirs"));
    const again = await inA((q) => tickets.openTicket(q, "th_theirs"));
    expect(again).toMatchObject({ created: false, ticket: { id: "ticket" in first ? first.ticket.id : "" } });
  });

  it("CANNOT OPEN ONE ON ANOTHER WORKSPACE'S THREAD", async () => {
    expect(await inA((q) => tickets.openTicket(q, "th_b"))).toEqual({ error: "That conversation no longer exists." });
  });

  it("the database refuses a thread with no messages in the workspace", async () => {
    await expect(
      db.seed(`INSERT INTO tickets (id, sub_account_id, thread_id) VALUES ('tk_x', '${TENANT_A}', 'th_b')`)
    ).rejects.toThrow(/has no messages/);
  });

  it("the database refuses an assignee from another workspace", async () => {
    await inA((q) => tickets.openTicket(q, "th_theirs"));
    await expect(db.seed(`UPDATE tickets SET assignee_user_id = 'u_other_ws'`)).rejects.toThrow(/does not belong/);
  });
});

describe("the clock follows the conversation", () => {
  it("OUR REPLY STOPS IT and moves the ticket to waiting on them", async () => {
    await inA((q) => tickets.openTicket(q, "th_theirs"));
    await inA((q) => inbox.createMessage(q, { direction: "sent", subject: "Re: Leak", body: "On our way", threadId: "th_theirs" }));
    expect(await row("th_theirs")).toMatchObject({ status: "waiting", awaiting_since: null });
  });

  it("THEIR MESSAGE REOPENS A RESOLVED TICKET and starts the clock again", async () => {
    const out = await inA((q) => tickets.openTicket(q, "th_theirs"));
    if (!("ticket" in out)) throw new Error("not opened");
    await inA((q) => tickets.updateTicket(q, out.ticket.id, { status: "resolved" }));
    expect(await row("th_theirs")).toMatchObject({ status: "resolved", awaiting_since: null });

    await inA((q) => inbox.createMessage(q, { direction: "received", subject: "Re: Leak", body: "Still leaking", threadId: "th_theirs" }));
    const after = await row("th_theirs");
    expect(after.status).toBe("open");
    expect(after.resolved_at).toBeNull();
    expect(after.awaiting_since).not.toBeNull();
  });

  it("logging an OLD message written before it was resolved does not reopen it", async () => {
    const out = await inA((q) => tickets.openTicket(q, "th_theirs"));
    if (!("ticket" in out)) throw new Error("not opened");
    await inA((q) => tickets.updateTicket(q, out.ticket.id, { status: "resolved" }));
    await inA((q) =>
      inbox.createMessage(q, { direction: "received", subject: "Leak", body: "earlier", threadId: "th_theirs", sentAt: ago(3) })
    );
    expect((await row("th_theirs")).status).toBe("resolved");
  });

  it("owes a reply from the EARLIEST unanswered message, not the latest", async () => {
    await inA((q) => tickets.openTicket(q, "th_theirs"));
    await inA((q) => inbox.createMessage(q, { direction: "received", subject: "Re: Leak", body: "hello?", threadId: "th_theirs" }));
    const after = await row("th_theirs");
    expect(Math.abs(after.awaiting_since!.getTime() - Date.parse(ago(5)))).toBeLessThan(5_000);
  });

  it("an older reply of ours logged after they wrote does not stop the clock", async () => {
    await inA((q) => tickets.openTicket(q, "th_theirs"));
    await inA((q) =>
      inbox.createMessage(q, { direction: "sent", subject: "Re: Leak", body: "old", threadId: "th_theirs", sentAt: ago(8) })
    );
    expect(await row("th_theirs")).toMatchObject({ status: "open" });
    expect((await row("th_theirs")).awaiting_since).not.toBeNull();
  });
});

describe("changing a ticket", () => {
  it("waiting clears what is owed; reopening does not invent it back", async () => {
    const out = await inA((q) => tickets.openTicket(q, "th_theirs"));
    if (!("ticket" in out)) throw new Error("not opened");
    await inA((q) => tickets.updateTicket(q, out.ticket.id, { status: "waiting" }));
    expect(await row("th_theirs")).toMatchObject({ status: "waiting", awaiting_since: null });
    await inA((q) => tickets.updateTicket(q, out.ticket.id, { status: "open", priority: "high" }));
    expect(await row("th_theirs")).toMatchObject({ status: "open", awaiting_since: null });
  });

  it("resolving twice keeps the first resolution time", async () => {
    const out = await inA((q) => tickets.openTicket(q, "th_theirs"));
    if (!("ticket" in out)) throw new Error("not opened");
    await inA((q) => tickets.updateTicket(q, out.ticket.id, { status: "resolved" }));
    const first = (await row("th_theirs")).resolved_at;
    await inA((q) => tickets.updateTicket(q, out.ticket.id, { status: "resolved" }));
    expect((await row("th_theirs")).resolved_at).toEqual(first);
  });

  it("refuses an assignee from another workspace with a sentence, keeping the request usable", async () => {
    const out = await inA((q) => tickets.openTicket(q, "th_theirs"));
    if (!("ticket" in out)) throw new Error("not opened");
    const refused = await inA(async (q) => {
      const r = await tickets.updateTicket(q, out.ticket.id, { assigneeUserId: "u_other_ws" });
      return { r, still: (await tickets.listTickets(q)).length };
    });
    expect(refused).toEqual({ r: { error: "That person cannot be given tickets in this workspace." }, still: 1 });
  });
});

describe("overdue, for the bell", () => {
  it("COUNTS ONLY REPLIES PAST DUE, split into mine and nobody's", async () => {
    await db.seed(`
      INSERT INTO messages (id, sub_account_id, thread_id, direction, subject, body, sent_at) VALUES
        ('m_2', '${TENANT_A}', 'th_2', 'received', 'x', 'x', '${ago(2)}'),
        ('m_3', '${TENANT_A}', 'th_3', 'received', 'x', 'x', '${ago(30)}');
      INSERT INTO tickets (id, sub_account_id, thread_id, status, priority, assignee_user_id, awaiting_since) VALUES
        ('tk_urgent_mine', '${TENANT_A}', 'th_theirs', 'open', 'urgent', '${USER_A}', '${ago(2)}'),
        ('tk_normal_2h',   '${TENANT_A}', 'th_2',      'open', 'normal', NULL,        '${ago(2)}'),
        ('tk_normal_30h',  '${TENANT_A}', 'th_3',      'open', 'normal', NULL,        '${ago(30)}');
    `);
    expect(await inA((q) => tickets.overdueTickets(q, USER_A))).toEqual({ mine: 1, unassigned: 1 });
  });
});
