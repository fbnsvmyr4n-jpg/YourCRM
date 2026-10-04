import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";
import { worthKeeping } from "@/data/drafts";

/**
 * Emails started and not sent.
 *
 * The composer kept one draft, in the browser's own storage. That is the right
 * place for the box being typed in and the wrong place for everything after it:
 * there was room for exactly ONE, it was invisible from any other device, and
 * clearing site data threw away a half-written reply to a client without
 * leaving a trace it had existed.
 *
 * Two properties carry most of the weight here. A draft is PLURAL — beginning a
 * second message must not overwrite the first, which is what the single slot
 * did. And a draft is PERSONAL — a half-written message is a thought rather
 * than a record, and a colleague's unfinished sentence is not something the
 * workspace reads over their shoulder.
 */

process.env.AUTH_SECRET = "test-secret-for-drafts-0123456789abcdef";

const OTHER_USER = "u_test_colleague";

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/drafts");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (userId = USER_A): TenantContext => ({
  agencyId: AGENCY,
  subAccountId: TENANT_A,
  userId,
  role: "owner",
});
const asMe = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx(), fn);
const asThem = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx(OTHER_USER), fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/drafts");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  /* A colleague in the same workspace, because "personal" is only testable
     against somebody else. Seeded rather than assumed: the harness ships one
     user, and a foreign key on `user_id` means an invented id would fail as a
     constraint violation rather than as the permission check this is about. */
  await db.seed(`
    DELETE FROM message_drafts;
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
    VALUES ('${OTHER_USER}', '${AGENCY}', '${TENANT_A}', 'colleague@test.local', 'x', 'Colleague', 'member')
    ON CONFLICT (id) DO NOTHING;
  `);
});

const write = (over: Partial<{ id: string | null; to: string; subject: string; body: string }> = {}) =>
  asMe((q) => repo.saveDraft(q, { to: "ben@cole.test", subject: "Paving", body: "Figures on Monday.", ...over }));

describe("what counts as a draft", () => {
  it("is writing, not an address", () => {
    /* Pressing Email on a contact card fills the address and nothing else.
       Counting that as a draft would mean every abandoned click left a row, and
       Drafts would fill with empty messages addressed to people nobody wrote
       to. */
    expect(worthKeeping({ subject: "", body: "" })).toBe(false);
    expect(worthKeeping({})).toBe(false);
    expect(worthKeeping({ subject: "   ", body: "\n\t " })).toBe(false);
    expect(worthKeeping({ subject: "Paving" })).toBe(true);
    expect(worthKeeping({ body: "Hi Ben" })).toBe(true);
  });

  it("is not saved when there is nothing in it", async () => {
    expect(await write({ subject: "", body: "" })).toBeNull();
    expect(await asMe((q) => repo.listDrafts(q))).toEqual([]);
  });
});

describe("more than one", () => {
  it("is the whole point — a second message does not overwrite the first", async () => {
    await write({ subject: "First" });
    await write({ subject: "Second" });
    const mine = await asMe((q) => repo.listDrafts(q));
    expect(mine.map((d) => d.subject)).toEqual(["Second", "First"]);
  });

  it("keeps editing the SAME draft when the composer was opened from one", async () => {
    const first = await write({ subject: "First" });
    await write({ id: first!.id, subject: "First, revised" });
    const mine = await asMe((q) => repo.listDrafts(q));
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe("First, revised");
  });

  it("does not lose the writing when the id no longer matches anything", async () => {
    /* Deleted in another tab, or an id that was never theirs. Falling through
       to a new row is the only outcome that does not throw away what somebody
       has written. */
    const saved = await write({ id: "dr_gone", subject: "Still here" });
    expect(saved?.subject).toBe("Still here");
    expect(await asMe((q) => repo.listDrafts(q))).toHaveLength(1);
  });

  it("leads with the newest", async () => {
    const a = await write({ subject: "Older" });
    await write({ subject: "Newer" });
    await write({ id: a!.id, subject: "Older, touched" });
    const mine = await asMe((q) => repo.listDrafts(q));
    expect(mine[0].subject).toBe("Older, touched");
  });
});

describe("whose draft it is", () => {
  it("is not readable by a colleague in the same workspace", async () => {
    await write({ subject: "Half a thought" });
    expect(await asThem((q) => repo.listDrafts(q))).toEqual([]);
  });

  it("cannot be rewritten by a colleague who knows its id", async () => {
    const mine = await write({ subject: "Mine" });
    await asThem((q) => repo.saveDraft(q, { id: mine!.id, to: "", subject: "Theirs", body: "" }));
    /* Theirs became a new row of their own; mine is untouched. */
    expect((await asMe((q) => repo.listDrafts(q)))[0].subject).toBe("Mine");
  });

  it("cannot be discarded by a colleague who knows its id", async () => {
    const mine = await write({ subject: "Mine" });
    expect(await asThem((q) => repo.discardDraft(q, mine!.id))).toBe(false);
    expect(await asMe((q) => repo.listDrafts(q))).toHaveLength(1);
  });

  it("is not readable from another workspace", async () => {
    await write({ subject: "Mine" });
    const theirs = await withTenant({ ...ctx(), subAccountId: TENANT_B }, (q) => repo.listDrafts(q));
    expect(theirs).toEqual([]);
  });
});

describe("throwing one away", () => {
  it("takes it out of the list and says that it did", async () => {
    const saved = await write();
    expect(await asMe((q) => repo.discardDraft(q, saved!.id))).toBe(true);
    expect(await asMe((q) => repo.listDrafts(q))).toEqual([]);
  });

  it("says so honestly the second time, rather than claiming to delete again", async () => {
    /* The caller shows a message based on this answer. A discard that reports
       success for a row it did not touch is the shape of defect that had seven
       forms saying "saved" when nothing was saved. */
    const saved = await write();
    await asMe((q) => repo.discardDraft(q, saved!.id));
    expect(await asMe((q) => repo.discardDraft(q, saved!.id))).toBe(false);
  });
});
