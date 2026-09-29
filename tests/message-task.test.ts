import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import { TASK_CATEGORIES, messageTaskKey, taskFromMessage } from "../src/server/message-task";
import { classifyMessage } from "../src/server/inbox-classify";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * A message that asks for something becomes a task.
 *
 * A client writes "can you quote me for the paving" and that is a job to do,
 * and it lived only in the Inbox. The classifier already worked out what each
 * message was; nothing acted on it.
 *
 * Every test here is really about the same risk, from one side or the other:
 * a task list that fills with noise is worse than no task list, because people
 * stop reading it and the real ones go past too. So most of these check that
 * NOTHING was raised.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let inbox: typeof import("../src/server/repos/inbox");
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

const tasks = () =>
  inA((q) =>
    q.rows<{ title: string; assignee_user_id: string | null; contact_id: string | null; source_key: string | null }>(
      `SELECT title, assignee_user_id, contact_id, source_key FROM todos
        WHERE sub_account_id = $1 ORDER BY title`,
      [TENANT_A]
    )
  );

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  inbox = await import("../src/server/repos/inbox");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM todos; DELETE FROM messages; DELETE FROM contacts; DELETE FROM settings;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, owner_user_id)
      VALUES ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', '${USER_A}'),
             ('ct_nobody', '${TENANT_A}', 'Unowned', 'Person', NULL);
  `)
);

describe("which messages earn a task", () => {
  const msg = (over: Partial<Parameters<typeof taskFromMessage>[0]> = {}) => ({
    direction: "received" as const,
    category: "Tasks" as const,
    subject: "Quote for the paving",
    senderName: "Amara Dube",
    ...over,
  });

  it("names the sender and their own subject, so the row is recognisable", () => {
    expect(taskFromMessage(msg(), true)?.title).toBe("Reply to Amara Dube: Quote for the paving");
  });

  it("says where it came from, so a wrong one is easy to dismiss", () => {
    expect(taskFromMessage(msg(), true)?.notes).toMatch(/Inbox/);
  });

  it("RAISES NOTHING WHEN THE SETTING IS OFF", () => {
    expect(taskFromMessage(msg(), false)).toBe(null);
  });

  it("RAISES NOTHING FOR WHAT WE SENT — that is not somebody waiting on us", () => {
    expect(taskFromMessage(msg({ direction: "sent" }), true)).toBe(null);
  });

  it("RAISES NOTHING WHEN THE CLASSIFIER WAS NOT SURE", () => {
    /* A guess must never become a task. */
    expect(taskFromMessage(msg({ category: null }), true)).toBe(null);
    expect(taskFromMessage(msg({ category: undefined }), true)).toBe(null);
  });

  it("LEAVES REPLIES AND CONFIRMATIONS ALONE — the flood this has to avoid", () => {
    /* "Follow-ups" is the classifier's fallback for anything starting "Re:",
       so acting on it would raise a task for every reply in every thread. */
    expect(taskFromMessage(msg({ category: "Follow-ups" }), true)).toBe(null);
    expect(taskFromMessage(msg({ category: "Appointments" }), true)).toBe(null);
    expect(taskFromMessage(msg({ category: "Meeting Requests" }), true)).toBe(null);
    expect(TASK_CATEGORIES).toEqual(["Tasks", "Enquiries"]);
  });

  it("still makes a task out of a message with no subject", () => {
    expect(taskFromMessage(msg({ subject: "   " }), true)?.title).toBe("Reply to Amara Dube");
  });

  it("does not print an empty name when nobody is on file", () => {
    expect(taskFromMessage(msg({ senderName: null }), true)?.title).toContain("a client");
  });
});

describe("what the classifier makes of the sentences clients actually write", () => {
  /**
   * The half of this feature that decides whether it works at all.
   *
   * The rules had no word for "quote" in them, so "could you quote me for the
   * driveway paving" scored nothing and came out uncategorised — and an
   * uncategorised message raises nothing. The most common request a builder
   * gets would have raised no task at all, which is worse than not shipping
   * the feature, because it would look like it was working.
   */
  const asks = [
    ["Quote for the paving", "Hi, could you quote me for the driveway paving please?"],
    ["Hi", "Could you quote us on a new fence?"],
    ["Quotation request", "Please send a quotation for the roof repair."],
    ["Paving", "Can you give me a price for paving the driveway?"],
    ["Roof", "How much would it cost to redo the roof?"],
    ["Invoice 1002", "Please approve the invoice before Friday."],
  ] as const;

  for (const [subject, body] of asks) {
    it(`treats "${body.slice(0, 38)}…" as work`, () => {
      const category = classifyMessage(subject, [body]);
      expect(category, "classified as nothing, so no task would be raised").toBeTruthy();
      expect(TASK_CATEGORIES).toContain(category!);
    });
  }

  const noise = [
    ["Newsletter", "Here is our monthly update on industry news."],
    ["Thanks", "Thanks, received."],
  ] as const;

  for (const [subject, body] of noise) {
    it(`leaves "${body.slice(0, 30)}…" alone`, () => {
      const category = classifyMessage(subject, [body]);
      expect(category === undefined || !TASK_CATEGORIES.includes(category)).toBe(true);
    });
  }
});

describe("when a message actually arrives", () => {
  const arrive = (over: Record<string, unknown> = {}) =>
    inA((q) =>
      inbox.createMessage(q, {
        direction: "received",
        subject: "Quote for the paving",
        body: "Could you send me a price for the driveway please?",
        contactId: "ct_amara",
        category: "Tasks",
        ...over,
      } as Parameters<typeof inbox.createMessage>[1])
    );

  it("RAISES A TASK, ASSIGNED TO WHOEVER OWNS THAT CLIENT", async () => {
    await arrive();
    const rows = await tasks();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("Reply to Amara Dube: Quote for the paving");
    expect(rows[0].assignee_user_id).toBe(USER_A);
    expect(rows[0].contact_id).toBe("ct_amara");
  });

  it("RAISES ONE TASK PER CONVERSATION, however many emails arrive on it", async () => {
    const first = await arrive();
    await arrive({ subject: "Re: Quote for the paving", threadId: first.threadId });
    await arrive({ subject: "Any news?", threadId: first.threadId });
    const rows = await tasks();
    expect(rows.length, "a thread of three emails became three tasks").toBe(1);
    expect(rows[0].source_key).toBe(messageTaskKey(first.threadId));
  });

  it("leaves it for the team when the client has no owner", async () => {
    await arrive({ contactId: "ct_nobody" });
    const rows = await tasks();
    expect(rows.length).toBe(1);
    /* Nobody, rather than a guess. It shows on the team's list. */
    expect(rows[0].assignee_user_id).toBe(null);
  });

  it("RAISES NOTHING ONCE THE WORKSPACE TURNS IT OFF", async () => {
    await db.seed(`
      INSERT INTO settings (sub_account_id, tasks_from_messages) VALUES ('${TENANT_A}', FALSE)
      ON CONFLICT (sub_account_id) DO UPDATE SET tasks_from_messages = FALSE;
    `);
    await arrive();
    expect(await tasks()).toEqual([]);
  });

  it("is ON for a workspace that has never saved a setting", async () => {
    /* No settings row must mean the same as the column default, or the feature
       is silently off for every new workspace. */
    await db.seed(`DELETE FROM settings;`);
    await arrive();
    expect((await tasks()).length).toBe(1);
  });

  it("raises nothing for a message we sent", async () => {
    await arrive({ direction: "sent", category: "Tasks" });
    expect(await tasks()).toEqual([]);
  });
});
