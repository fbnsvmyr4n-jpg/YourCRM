import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * Tickets through the Inbox's own controls: tracking a conversation, handing
 * it to somebody, logging a message that arrived another way — and the bell.
 */

vi.mock("@/server/tenant-session", () => {
  const run = async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    return withTenant({ agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "member" }, (q) => fn(q));
  };
  return {
    withCurrentTenant: run,
    requireTenant: async () => {
      const pg = await import("./helpers/pg");
      return { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "member" };
    },
  };
});
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let actions: typeof import("../src/app/(app)/inbox/actions");
let withSystem: typeof import("../src/server/tenant").withSystem;
let withTenant: typeof import("../src/server/tenant").withTenant;
let closePool: typeof import("../src/server/db").closePool;

const read = <T,>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem, withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  actions = await import("../src/app/(app)/inbox/actions");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM tickets; DELETE FROM messages; DELETE FROM contacts;
    DELETE FROM users WHERE id IN ('u_finance', 'u_sam');
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('u_finance', '${AGENCY}', NULL, 'f@test.local', 'x', 'Accounts', 'finance'),
      ('u_sam',     '${AGENCY}', '${TENANT_A}', 's@test.local', 'x', 'Sam', 'member');
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', 'amara@test.local');
    INSERT INTO messages (id, sub_account_id, contact_id, thread_id, direction, subject, body, sent_at) VALUES
      ('m_in', '${TENANT_A}', 'ct_amara', 'th_leak', 'received', 'Leak', 'The roof leaks', '${ago(2)}');
  `)
);

describe("tracking and handling a ticket", () => {
  it("tracks a conversation, and a member may do it — it is the work", async () => {
    const out = await actions.trackTicketAction("th_leak");
    expect(out).toMatchObject({ ok: true, ticket: { status: "open", priority: "normal" } });
  });

  it("HANDS IT ONLY TO SOMEBODY WHO CAN SEE CUSTOMER RECORDS", async () => {
    const out = await actions.trackTicketAction("th_leak");
    if (!("ticket" in out)) throw new Error(out.error);
    expect(await actions.updateTicketAction(out.ticket.id, { assigneeUserId: "u_finance" })).toEqual({
      error: "That person cannot be given tickets in this workspace.",
    });
    expect(await actions.updateTicketAction(out.ticket.id, { assigneeUserId: "u_sam", priority: "urgent" })).toMatchObject({
      ok: true,
      ticket: { assigneeUserId: "u_sam", priority: "urgent" },
    });
    expect(await actions.updateTicketAction(out.ticket.id, { assigneeUserId: null })).toMatchObject({
      ticket: { assigneeUserId: null },
    });
  });

  it("refuses a status or priority that is not one, changing nothing", async () => {
    const out = await actions.trackTicketAction("th_leak");
    if (!("ticket" in out)) throw new Error(out.error);
    expect(await actions.updateTicketAction(out.ticket.id, { status: "closed" })).toEqual({ error: "That is not a ticket status." });
    expect(await actions.updateTicketAction(out.ticket.id, { priority: "p1" })).toEqual({ error: "That is not a priority." });
    expect(await read(`SELECT status, priority FROM tickets`)).toEqual([{ status: "open", priority: "normal" }]);
  });
});

describe("logging a message you received", () => {
  it("RECORDS IT AS RECEIVED AND READ, filed to the person, and can open a ticket in one go", async () => {
    const out = await actions.logReceivedAction(
      form({ to: "amara@test.local", channel: "whatsapp", subject: "Gutter", body: "Gutter came loose", openTicket: "on" })
    );
    if (!("ok" in out)) throw new Error(out.error);
    const [m] = await read<{ direction: string; unread: boolean; channel: string; contact_id: string; delivery: string | null }>(
      `SELECT direction, unread, channel, contact_id, delivery FROM messages WHERE id = '${out.id}'`
    );
    expect(m).toEqual({ direction: "received", unread: false, channel: "whatsapp", contact_id: "ct_amara", delivery: null });
    expect(out.ticket).toMatchObject({ status: "open" });
  });

  it("does not open a ticket unless asked", async () => {
    const out = await actions.logReceivedAction(form({ to: "amara@test.local", body: "Thanks!" }));
    expect(out).toMatchObject({ ok: true, ticket: null });
    expect(await read(`SELECT id FROM tickets`)).toEqual([]);
  });

  it("keeps the time it really arrived, and REFUSES ONE FROM THE FUTURE", async () => {
    const when = ago(26);
    const out = await actions.logReceivedAction(form({ to: "amara@test.local", body: "Yesterday's", receivedAt: when, openTicket: "on" }));
    if (!("ok" in out)) throw new Error(out.error);
    expect(out.ticket?.awaitingSince).toBe(when);
    expect(await actions.logReceivedAction(form({ to: "amara@test.local", body: "x", receivedAt: ago(-2) }))).toEqual({
      error: "A message cannot arrive in the future.",
    });
  });

  it("asks for who and what", async () => {
    expect(await actions.logReceivedAction(form({ to: "", body: "x" }))).toEqual({ error: "Say who it was from." });
    expect(await actions.logReceivedAction(form({ to: "Amara", body: "  " }))).toEqual({ error: "Type or paste what they said." });
  });
});

describe("the bell", () => {
  const ctx = (sub: string): TenantContext => ({ agencyId: AGENCY, subAccountId: sub, userId: USER_A, role: "owner" });
  const inA = <T,>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx(TENANT_A), fn);

  it("SAYS HOW MANY CUSTOMERS ARE PAST THEIR REPLY TIME — mine and nobody's, not a colleague's", async () => {
    await db.seed(`
      INSERT INTO messages (id, sub_account_id, thread_id, direction, subject, body, sent_at) VALUES
        ('m_2', '${TENANT_A}', 'th_2', 'received', 'x', 'x', '${ago(30)}'),
        ('m_3', '${TENANT_A}', 'th_3', 'received', 'x', 'x', '${ago(30)}');
      INSERT INTO tickets (id, sub_account_id, thread_id, status, priority, assignee_user_id, awaiting_since) VALUES
        ('tk_mine',  '${TENANT_A}', 'th_leak', 'open', 'urgent', '${USER_A}', '${ago(2)}'),
        ('tk_none',  '${TENANT_A}', 'th_2',    'open', 'normal', NULL,        '${ago(30)}'),
        ('tk_sams',  '${TENANT_A}', 'th_3',    'open', 'normal', 'u_sam',     '${ago(30)}');
    `);
    const notifications = await import("../src/server/notifications");
    const item = (await inA((q) => notifications.listNotifications(q))).find((n) => n.id === "tickets-overdue");
    expect(item).toMatchObject({
      title: "2 tickets past their reply time",
      detail: "1 yours, 1 unassigned",
      href: "/inbox?folder=tickets",
    });
  });

  it("stays quiet when every reply is still in time", async () => {
    await db.seed(`INSERT INTO tickets (id, sub_account_id, thread_id, status, awaiting_since)
                   VALUES ('tk_ok', '${TENANT_A}', 'th_leak', 'open', '${ago(2)}')`);
    const notifications = await import("../src/server/notifications");
    expect((await inA((q) => notifications.listNotifications(q))).find((n) => n.id === "tickets-overdue")).toBeUndefined();
  });

  it("another workspace's overdue ticket is not ours", async () => {
    await db.seed(`
      INSERT INTO messages (id, sub_account_id, thread_id, direction, subject, body) VALUES ('m_b', '${TENANT_B}', 'th_b', 'received', 'x', 'x');
      INSERT INTO tickets (id, sub_account_id, thread_id, status, awaiting_since) VALUES ('tk_b', '${TENANT_B}', 'th_b', 'open', '${ago(99)}');
    `);
    const notifications = await import("../src/server/notifications");
    expect((await inA((q) => notifications.listNotifications(q))).find((n) => n.id === "tickets-overdue")).toBeUndefined();
  });
});
