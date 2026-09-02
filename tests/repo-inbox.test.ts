import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The inbox repository.
 *
 * Two behaviours carry most of the weight, and neither is CRUD:
 *
 *  - Trash is a *view* of soft-deleted rows rather than a hidden state, so the
 *    folder predicates must partition the mailbox without overlapping. A
 *    message showing up in two folders, or in none, is the whole bug class.
 *  - Category is derived unless a human overrode it, so improving the
 *    classifier improves old mail. The tests assert the categories the rules
 *    actually produce, not whatever the code happens to return.
 *
 * RLS is bypassed in this harness (see `helpers/pg.ts`), so the isolation cases
 * prove the repository's own predicates.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/inbox");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/inbox");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

const send = (over: Partial<Parameters<typeof repo.createMessage>[1]> = {}) =>
  inA((q) =>
    repo.createMessage(q, {
      direction: "received",
      subject: "Hello there",
      body: "Just saying hi.",
      ...over,
    })
  );

const clear = () => db.seed(`DELETE FROM messages`);

describe("writing and reading", () => {
  it("round-trips a message", async () => {
    const m = await send({ subject: "  Quick question  ", body: "Body text." });
    expect(m.subject, "input was not trimmed").toBe("Quick question");
    expect(m.body).toBe("Body text.");
    expect((await inA((q) => repo.getMessage(q, m.id)))?.id).toBe(m.id);
  });

  it("refuses a direction the database would reject", async () => {
    await expect(send({ direction: "draft" as never })).rejects.toThrow(/direction/i);
  });

  it("refuses an unparseable timestamp", async () => {
    await expect(send({ sentAt: "whenever" })).rejects.toThrow(/valid date/i);
  });

  it("does not mark your own sent mail as unread", async () => {
    // Defaulting `unread` to true put every outgoing message in the badge.
    const sent = await send({ direction: "sent", subject: "My reply" });
    expect(sent.unread, "a message you sent is sitting in your unread count").toBe(false);

    const received = await send({ direction: "received" });
    expect(received.unread).toBe(true);
  });
});

describe("category is derived, and an override wins", () => {
  it("classifies an unlabelled message from its text", async () => {
    const m = await send({ subject: "Could we book a time for a demo next week?", body: "" });
    expect(m.category).toBe("Meeting Requests");
    expect(m.categoryIsOverride, "a classified message claims a human chose it").toBe(false);
  });

  it("classifies from the body as well as the subject", async () => {
    const m = await send({ subject: "Hi", body: "Please approve the invoice, payment is due." });
    expect(m.category).toBe("Tasks");
  });

  it("leaves a message with no confident category uncategorised", async () => {
    // Never guessing is the point: a wrong chip is worse than no chip, because
    // filtering by it silently hides mail.
    const m = await send({ subject: "Hello there", body: "Nothing in particular." });
    expect(m.category).toBeNull();
  });

  it("treats a reply with no other signal as a follow-up", async () => {
    const m = await send({ subject: "Re: Yesterday", body: "" });
    expect(m.category).toBe("Follow-ups");
  });

  it("lets a human override the classifier", async () => {
    const m = await send({ subject: "Could we book a time for a demo next week?", body: "" });
    const over = await inA((q) => repo.setCategory(q, m.id, "Tasks"));
    expect(over?.category).toBe("Tasks");
    expect(over?.categoryIsOverride).toBe(true);
  });

  it("hands the message back to the classifier when the override is cleared", async () => {
    /**
     * Null means "stop overriding", not "no category". This is what keeps the
     * derive-on-read behaviour honest: a stored value can always be undone,
     * so improving the rules still reaches messages someone once relabelled
     * and then reset.
     */
    const m = await send({ subject: "Could we book a time for a demo next week?", body: "" });
    await inA((q) => repo.setCategory(q, m.id, "Tasks"));
    const cleared = await inA((q) => repo.setCategory(q, m.id, null));
    expect(cleared?.category).toBe("Meeting Requests");
    expect(cleared?.categoryIsOverride).toBe(false);
  });

  it("re-derives on every read, so improved rules reach old mail", async () => {
    // The stored row holds no category, so the answer comes from the rules
    // each time rather than from whatever they said on the day it arrived.
    await db.seed(
      `INSERT INTO messages (id, sub_account_id, direction, subject, body, category, unread)
       VALUES ('m_legacy', '${TENANT_A}', 'received', 'Could we book a time for a demo?', '', NULL, TRUE)`
    );
    const m = await inA((q) => repo.getMessage(q, "m_legacy"));
    expect(m?.category).toBe("Meeting Requests");
    expect(m?.categoryIsOverride).toBe(false);
  });
});

describe("folders partition the mailbox", () => {
  it("puts each message in exactly the folders it belongs to", async () => {
    await clear();
    const received = await send({ direction: "received", subject: "Incoming" });
    const sent = await send({ direction: "sent", subject: "Outgoing" });
    const read = await send({ direction: "received", subject: "Already read" });
    await inA((q) => repo.setUnread(q, read.id, false));
    const binned = await send({ direction: "received", subject: "Binned" });
    await inA((q) => repo.trashMessage(q, binned.id));

    const ids = async (f: Parameters<typeof repo.listMessages>[1]) =>
      (await inA((q) => repo.listMessages(q, f))).map((x) => x.id);

    expect(await ids("inbox")).toEqual(expect.arrayContaining([received.id, read.id]));
    expect(await ids("inbox"), "sent mail appeared in the inbox").not.toContain(sent.id);
    expect(await ids("inbox"), "a binned message stayed in the inbox").not.toContain(binned.id);

    expect(await ids("unread")).toContain(received.id);
    expect(await ids("unread"), "an already-read message is in unread").not.toContain(read.id);

    expect(await ids("sent")).toEqual([sent.id]);

    expect(await ids("trash")).toEqual([binned.id]);
  });

  it("shows only deleted mail in trash, and only live mail everywhere else", async () => {
    await clear();
    const live = await send({ subject: "Live" });
    const dead = await send({ subject: "Dead" });
    await inA((q) => repo.trashMessage(q, dead.id));

    for (const folder of ["inbox", "unread", "sent"] as const) {
      const ids = (await inA((q) => repo.listMessages(q, folder))).map((x) => x.id);
      expect(ids, `a trashed message leaked into ${folder}`).not.toContain(dead.id);
    }
    const trash = (await inA((q) => repo.listMessages(q, "trash"))).map((x) => x.id);
    expect(trash).toEqual([dead.id]);
    expect(trash, "a live message appeared in the bin").not.toContain(live.id);
  });

  it("keeps sent mail out of unread even when it is flagged unread", async () => {
    /**
     * The unread folder means "incoming mail I still have to deal with", so it
     * is bounded by direction as well as by the flag. Without that predicate
     * the hole is invisible in ordinary use — sent mail defaults to read — and
     * only opens when something marks an outgoing message unread, which the
     * API allows. A mutation that removed the direction check passed the whole
     * suite before this test existed.
     */
    await clear();
    const sentButFlagged = await send({ direction: "sent", subject: "Flagged", unread: true });
    const incoming = await send({ direction: "received", subject: "Incoming" });

    const ids = (await inA((q) => repo.listMessages(q, "unread"))).map((x) => x.id);
    expect(ids).toContain(incoming.id);
    expect(ids, "an outgoing message is sitting in unread").not.toContain(sentButFlagged.id);
  });

  it("refuses a folder it does not recognise", async () => {
    await expect(inA((q) => repo.listMessages(q, "archive" as never))).rejects.toThrow(/folder/i);
  });

  it("returns newest first", async () => {
    await clear();
    const older = await send({ subject: "Older", sentAt: "2026-01-01T10:00:00Z" });
    const newer = await send({ subject: "Newer", sentAt: "2026-02-01T10:00:00Z" });
    expect((await inA((q) => repo.listMessages(q, "inbox"))).map((x) => x.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });
});

describe("trash is reversible, and readable while it is there", () => {
  it("can still open a message that is in the bin", async () => {
    // Otherwise the bin is a list of things you cannot look at before deciding
    // whether to restore them.
    const m = await send();
    await inA((q) => repo.trashMessage(q, m.id));
    const read = await inA((q) => repo.getMessage(q, m.id));
    expect(read, "a binned message cannot be opened").not.toBeNull();
    expect(read?.deletedAt, "the record does not say it is deleted").not.toBeNull();
  });

  it("restores back into the inbox", async () => {
    const m = await send({ subject: "Coming back" });
    await inA((q) => repo.trashMessage(q, m.id));
    expect(await inA((q) => repo.restoreMessage(q, m.id))).toBe(true);
    expect((await inA((q) => repo.getMessage(q, m.id)))?.deletedAt).toBeNull();
  });

  it("reports false rather than throwing when there is nothing to do", async () => {
    expect(await inA((q) => repo.trashMessage(q, "nope"))).toBe(false);
    const m = await send();
    expect(await inA((q) => repo.restoreMessage(q, m.id)), "restored a message that was never binned").toBe(
      false
    );
  });
});

describe("the unread badge counts only what it should", () => {
  it("counts unread received mail, and nothing else", async () => {
    await clear();
    await send({ direction: "received" });
    await send({ direction: "received" });
    await send({ direction: "sent", subject: "Mine" });
    const read = await send({ direction: "received" });
    await inA((q) => repo.setUnread(q, read.id, false));
    const binned = await send({ direction: "received" });
    await inA((q) => repo.trashMessage(q, binned.id));

    // A badge that keeps counting binned mail teaches the user to ignore it.
    expect(await inA((q) => repo.unreadCount(q))).toBe(2);
  });

  it("is zero, not an error, for an empty mailbox", async () => {
    expect(await inB((q) => repo.unreadCount(q))).toBe(0);
  });
});

describe("the tenant boundary holds", () => {
  it("hides and refuses every cross-tenant operation", async () => {
    const m = await send({ subject: "Mine" });
    expect(await inB((q) => repo.getMessage(q, m.id))).toBeNull();
    expect(await inB((q) => repo.setUnread(q, m.id, false))).toBeNull();
    expect(await inB((q) => repo.setCategory(q, m.id, "Tasks"))).toBeNull();
    expect(await inB((q) => repo.trashMessage(q, m.id))).toBe(false);

    const mine = await inA((q) => repo.getMessage(q, m.id));
    expect(mine?.subject, "another tenant modified this message").toBe("Mine");
    expect(mine?.unread).toBe(true);
    expect(mine?.deletedAt).toBeNull();
  });

  it("keeps trash separate between tenants", async () => {
    const m = await send({ subject: "A's bin" });
    await inA((q) => repo.trashMessage(q, m.id));
    expect((await inB((q) => repo.listMessages(q, "trash"))).map((x) => x.id)).not.toContain(m.id);
  });
});
