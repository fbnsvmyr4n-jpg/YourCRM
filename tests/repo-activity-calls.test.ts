import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The activity log and the calls repository.
 *
 * These two are grouped because they share the property that makes them worth
 * testing: both are records of things that happened. An activity log that can
 * be edited is not a log, and a call whose transcript loses turns is not a
 * record of the call. Most of the cases below are about that, not about CRUD.
 *
 * RLS is bypassed in this harness (see `helpers/pg.ts`), so the isolation cases
 * prove the repositories' own predicates.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let activity: typeof import("../src/server/repos/activity");
let calls: typeof import("../src/server/repos/calls");
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
  activity = await import("../src/server/repos/activity");
  calls = await import("../src/server/repos/calls");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

const log = (over: Partial<Parameters<typeof activity.logActivity>[1]> = {}) =>
  inA((q) =>
    activity.logActivity(q, {
      entityType: "contact",
      entityId: "c_1",
      kind: "note",
      title: "Left a voicemail",
      ...over,
    })
  );

describe("the activity log records what happened", () => {
  it("round-trips an entry", async () => {
    const a = await log({ title: "  Called back  ", detail: "  Spoke for 5 minutes  " });
    expect(a.title, "input was not trimmed").toBe("Called back");
    expect(a.detail).toBe("Spoke for 5 minutes");
    expect(a.kind).toBe("note");
  });

  it("refuses an entity type the database would reject", async () => {
    await expect(log({ entityType: "invoice" as never })).rejects.toThrow(/entity type/i);
  });

  it("refuses an unknown kind", async () => {
    await expect(log({ kind: "exploded" as never })).rejects.toThrow(/kind/i);
  });

  it("refuses an entry with no title", async () => {
    // An unreadable line takes up space in the timeline and says nothing.
    await expect(log({ title: "   " })).rejects.toThrow(/title/i);
  });

  it("keeps a missing amount as null rather than zero", async () => {
    /**
     * "This event had no amount" and "this event was worth nothing" are
     * different claims, and only one of them is true. A zero would total
     * correctly and read as a real figure on any screen showing it.
     */
    const none = await log({ kind: "note" });
    expect(none.amountCents).toBeNull();

    const won = await log({ kind: "won", title: "Closed", amountCents: 250_000 });
    expect(won.amountCents).toBe(250_000);
    expect(typeof won.amountCents, "BIGINT came back as the string Postgres sends").toBe("number");
  });

  it("refuses a fractional amount", async () => {
    await expect(log({ kind: "won", title: "Closed", amountCents: 12.5 })).rejects.toThrow(
      /whole cents/i
    );
  });

  it("exposes no way to change or remove an entry", () => {
    // The property, asserted directly: a history that can be edited is not a
    // history. Erasure is a separate operation with different rules, and
    // adding a casual delete here would trade that guarantee for nothing.
    const exported = Object.keys(activity);
    expect(exported).not.toContain("updateActivity");
    expect(exported).not.toContain("deleteActivity");
    expect(exported).not.toContain("deleteActivityFor");
  });

  it("returns one entity's history, newest first", async () => {
    await db.seed(`DELETE FROM activities`);
    await log({ entityId: "c_hist", title: "First", at: "2026-01-01T09:00:00Z" });
    await log({ entityId: "c_hist", title: "Second", at: "2026-02-01T09:00:00Z" });
    await log({ entityId: "c_other", title: "Elsewhere" });

    const rows = await inA((q) => activity.listForEntity(q, "contact", "c_hist"));
    expect(rows.map((r) => r.title)).toEqual(["Second", "First"]);
  });

  it("does not mix entities that share an id but not a type", async () => {
    // `entity_id` has no foreign key, so nothing but this predicate stops a
    // deal and a contact with the same id sharing a timeline.
    await db.seed(`DELETE FROM activities`);
    await log({ entityType: "contact", entityId: "same", title: "Contact event" });
    await log({ entityType: "deal", entityId: "same", title: "Deal event" });

    const forContact = await inA((q) => activity.listForEntity(q, "contact", "same"));
    expect(forContact.map((r) => r.title)).toEqual(["Contact event"]);
  });

  it("keeps a contact's history after the contact is gone", async () => {
    /**
     * Deliberate. The events did happen, and losing them exactly when a record
     * is removed is losing the history that matters most. The rows are simply
     * unreachable, because every read names an entity.
     */
    await db.seed(`DELETE FROM activities`);
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name)
       VALUES ('c_doomed', '${TENANT_A}', 'Soon', 'Gone') ON CONFLICT DO NOTHING`
    );
    await log({ entityId: "c_doomed", title: "Signed the contract" });
    await db.seed(`UPDATE contacts SET deleted_at = now() WHERE id = 'c_doomed'`);

    const rows = await inA((q) => activity.listForEntity(q, "contact", "c_doomed"));
    expect(rows.map((r) => r.title)).toEqual(["Signed the contract"]);
  });

  it("hides another tenant's activity", async () => {
    await db.seed(`DELETE FROM activities`);
    await log({ title: "A's event" });
    expect(await inB((q) => activity.listActivity(q))).toEqual([]);
    expect(await inB((q) => activity.listForEntity(q, "contact", "c_1"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

const dial = (over: Partial<Parameters<typeof calls.logCall>[1]> = {}) =>
  inA((q) => calls.logCall(q, { callerName: "Jo Bloggs", durationSec: 120, ...over }));

describe("calls are recorded, and their transcripts cannot lose turns", () => {
  it("round-trips a call", async () => {
    const c = await dial({ phone: "  07700 900000  ", summary: "  Wants a demo  " });
    expect(c.phone).toBe("07700 900000");
    expect(c.summary).toBe("Wants a demo");
    expect(c.durationSec).toBe(120);
    expect((await inA((q) => calls.getCall(q, c.id)))?.id).toBe(c.id);
  });

  it("refuses a negative or absurd duration", async () => {
    // A negative length is a broken clock upstream, and averaging it silently
    // drags every call statistic down.
    await expect(dial({ durationSec: -5 })).rejects.toThrow(/whole seconds/i);
    await expect(dial({ durationSec: 1.5 })).rejects.toThrow(/whole seconds/i);
    await expect(dial({ durationSec: 90_000 })).rejects.toThrow(/range/i);
  });

  it("refuses an unparseable time", async () => {
    await expect(dial({ receivedAt: "sometime" })).rejects.toThrow(/valid date/i);
  });

  it("refuses a transcript turn with an unknown speaker", async () => {
    await expect(
      dial({ transcript: [{ role: "narrator" as never, text: "Hello" }] })
    ).rejects.toThrow(/role/i);
  });

  it("appends transcript turns instead of replacing them", async () => {
    const c = await dial({ transcript: [{ role: "caller", text: "Hi there" }] });
    const after = await inA((q) =>
      calls.appendTranscript(q, c.id, [{ role: "agent", text: "How can I help?" }])
    );
    expect(after?.transcript).toEqual([
      { role: "caller", text: "Hi there" },
      { role: "agent", text: "How can I help?" },
    ]);
  });

  it("appends inside the UPDATE, never by reading the array into JavaScript", async () => {
    // A call in progress is exactly where turns arrive in between a read and a
    // write, so the concatenation has to happen against the locked row.
    const src = readFileSync(join(__dirname, "..", "src", "server", "repos", "calls.ts"), "utf8");
    expect(src).toMatch(/transcript\s*=\s*transcript\s*\|\|/);
  });

  it("ignores empty turns rather than storing blanks", async () => {
    const c = await dial({ transcript: [] });
    const after = await inA((q) => calls.appendTranscript(q, c.id, [{ role: "agent", text: "  " }]));
    expect(after?.transcript).toEqual([]);
  });

  it("links a call to the contact and deal it produced, and can unlink", async () => {
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name)
       VALUES ('c_called', '${TENANT_A}', 'Called', 'Person') ON CONFLICT DO NOTHING;
       INSERT INTO deals (id, sub_account_id, title, stage)
       VALUES ('d_from_call', '${TENANT_A}', 'From a call', 'prospect') ON CONFLICT DO NOTHING`
    );
    const c = await dial();
    const linked = await inA((q) =>
      calls.linkCall(q, c.id, { contactId: "c_called", createdDealId: "d_from_call" })
    );
    expect(linked?.contactId).toBe("c_called");
    expect(linked?.createdDealId).toBe("d_from_call");

    const unlinked = await inA((q) => calls.linkCall(q, c.id, { contactId: null }));
    expect(unlinked?.contactId).toBeNull();
    expect(unlinked?.createdDealId, "unlinking one link cleared the other").toBe("d_from_call");
  });

  it("does not orchestrate other entities", () => {
    /**
     * `processCall` used to live in this repository and created a lead and a
     * meeting as a side effect of reading a call — orchestration across three
     * entities, inside a leaf. The project rule is that repositories stay
     * leaves, so that behaviour belongs to a layer above this one.
     */
    expect(Object.keys(calls)).not.toContain("processCall");
  });

  it("lists a contact's calls", async () => {
    const c = await dial({ contactId: "c_called" });
    const list = await inA((q) => calls.listCallsForContact(q, "c_called"));
    expect(list.map((x) => x.id)).toContain(c.id);
  });

  it("soft-deletes and restores", async () => {
    const c = await dial();
    expect(await inA((q) => calls.deleteCall(q, c.id))).toBe(true);
    expect(await inA((q) => calls.getCall(q, c.id))).toBeNull();
    expect(await inA((q) => calls.restoreCall(q, c.id))).toBe(true);
    expect(await inA((q) => calls.getCall(q, c.id))).not.toBeNull();
  });

  it("refuses every cross-tenant operation", async () => {
    const c = await dial({ summary: "Mine" });
    expect(await inB((q) => calls.getCall(q, c.id))).toBeNull();
    expect(await inB((q) => calls.updateCall(q, c.id, { summary: "Stolen" }))).toBeNull();
    expect(await inB((q) => calls.appendTranscript(q, c.id, [{ role: "agent", text: "x" }]))).toBeNull();
    expect(await inB((q) => calls.linkCall(q, c.id, { contactId: "whoever" }))).toBeNull();
    expect(await inB((q) => calls.deleteCall(q, c.id))).toBe(false);

    const mine = await inA((q) => calls.getCall(q, c.id));
    expect(mine?.summary, "another tenant modified this call").toBe("Mine");
    expect(mine?.transcript).toEqual([]);
  });
});
