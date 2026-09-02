import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * Turning a handled call into records.
 *
 * This is the automation the product is sold on — the agent answers, and a
 * contact, an opportunity and a meeting appear. It used to run inside the
 * calls repository, where *reading* a call wrote to three other tables.
 *
 * The cases worth testing are the ones where getting it wrong is quiet: a
 * repeat caller silently duplicated, a "not interested" call inflating the
 * pipeline anyway, and the button being pressed twice.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let processCall: typeof import("../src/server/process-call").processCall;
let calls: typeof import("../src/server/repos/calls");
let contacts: typeof import("../src/server/repos/contacts");
let deals: typeof import("../src/server/repos/deals");
let meetings: typeof import("../src/server/repos/meetings");
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
  ({ processCall } = await import("../src/server/process-call"));
  calls = await import("../src/server/repos/calls");
  contacts = await import("../src/server/repos/contacts");
  deals = await import("../src/server/repos/deals");
  meetings = await import("../src/server/repos/meetings");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

beforeEach(() =>
  db.seed(`DELETE FROM calls; DELETE FROM meetings; DELETE FROM deals; DELETE FROM contacts;`)
);

const incoming = (over: Partial<Parameters<typeof calls.logCall>[1]> = {}) =>
  inA((q) =>
    calls.logCall(q, {
      callerName: "Nadia Rossi",
      phone: "+27 82 551 4470",
      durationSec: 200,
      outcome: "qualified",
      ...over,
    })
  );

describe("a handled call becomes records", () => {
  it("creates a contact and an opportunity", async () => {
    const call = await incoming();
    const result = await inA((q) => processCall(q, call.id));

    expect(result.error).toBeUndefined();
    expect(result.contactCreated).toBe(true);

    const [person] = await inA((q) => contacts.listContacts(q));
    expect(person).toMatchObject({ firstName: "Nadia", lastName: "Rossi" });

    const [deal] = await inA((q) => deals.listDeals(q));
    // Attribution is a column, so a deal from the phone says so — and survives
    // the caller being renamed later.
    expect(deal).toMatchObject({ contactId: person.id, source: "phone_call" });
  });

  it("books the meeting the caller asked for", async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const call = await incoming({ outcome: "meeting-booked", requestedAt: at, topic: "Demo" });
    const result = await inA((q) => processCall(q, call.id));

    expect(result.meetingCreated).toBe(true);
    const [meeting] = await inA((q) => meetings.listMeetings(q));
    expect(meeting.topic).toBe("Demo");
    // The instant resolved at capture, not a relative label re-read later.
    expect(new Date(meeting.scheduledAt).getTime()).toBe(new Date(at).getTime());
  });

  it("starts a booked call further along than a plain enquiry", async () => {
    // Somebody who agreed to a meeting has been qualified; somebody who only
    // enquired has not. Filing both as prospects loses that.
    const enquiry = await incoming({ outcome: "qualified" });
    await inA((q) => processCall(q, enquiry.id));
    const booked = await incoming({
      callerName: "Owen Blake",
      phone: "+27 71 220 8834",
      outcome: "meeting-booked",
      requestedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await inA((q) => processCall(q, booked.id));

    const all = await inA((q) => deals.listDeals(q));
    const stages = Object.fromEntries(all.map((d) => [d.title, d.stage]));
    expect(stages["Enquiry from Nadia Rossi"]).toBe("prospect");
    expect(stages["Enquiry from Owen Blake"]).toBe("discovery");
  });

  it("links the call to what it produced", async () => {
    const call = await incoming();
    await inA((q) => processCall(q, call.id));

    const stored = await inA((q) => calls.getCall(q, call.id));
    expect(stored?.contactId).toBeTruthy();
    expect(stored?.createdDealId, "the call does not record the deal it created").toBeTruthy();
  });
});

describe("a repeat caller is recognised, not duplicated", () => {
  it("matches an existing contact on their phone number", async () => {
    /**
     * Phone first, because on a call it is the identifier: the caller said
     * their name out loud and somebody typed it, so the spelling is a guess,
     * while the number came from the network.
     */
    await inA((q) =>
      contacts.createContact(q, {
        firstName: "Nadia",
        lastName: "Rossi",
        phone: "+27 82 551 4470",
      })
    );

    // Same number, name misheard — which is exactly what happens on a call.
    const call = await incoming({ callerName: "Nadya Rosi" });
    const result = await inA((q) => processCall(q, call.id));

    expect(result.contactMatched, "a repeat caller was duplicated").toBe(true);
    expect((await inA((q) => contacts.listContacts(q))).length).toBe(1);
  });

  it("ignores formatting differences in the number", async () => {
    await inA((q) =>
      contacts.createContact(q, { firstName: "Nadia", lastName: "Rossi", phone: "0825514470" })
    );
    // A DIFFERENT name, so only the number can produce the match. The first
    // version of this test reused the same name, so the name fallback matched
    // and the digit normalisation was never exercised — removing it entirely
    // left the suite green.
    const call = await incoming({ phone: "+27 82 551 4470", callerName: "Nadya Rosi" });
    await inA((q) => processCall(q, call.id));
    expect(
      (await inA((q) => contacts.listContacts(q))).length,
      "the same number in a different format created a duplicate"
    ).toBe(1);
  });

  it("refuses to guess when two contacts share a number", async () => {
    // That is itself a duplicate, and picking one would be a coin toss — so a
    // new record is created and a human can merge them.
    for (const first of ["Nadia", "Marco"]) {
      await inA((q) =>
        contacts.createContact(q, { firstName: first, lastName: "Rossi", phone: "0825514470" })
      );
    }
    const call = await incoming({ phone: "0825514470", callerName: "Someone Else" });
    await inA((q) => processCall(q, call.id));
    expect((await inA((q) => contacts.listContacts(q))).length).toBe(3);
  });
});

describe("what it refuses to do", () => {
  it("creates nothing for a caller who said they were not interested", async () => {
    // Recording an opportunity anyway inflates the pipeline with work nobody
    // is going to do.
    const call = await incoming({ outcome: "not-interested" });
    const result = await inA((q) => processCall(q, call.id));

    expect(result.error).toMatch(/not interested/i);
    expect(await inA((q) => deals.listDeals(q))).toEqual([]);
    expect(await inA((q) => contacts.listContacts(q))).toEqual([]);
  });

  it("does not create a second set of records when run twice", async () => {
    /**
     * The button is on screen, and people press things twice. Without this the
     * second press produces a duplicate contact, a duplicate deal and a
     * duplicate meeting — and nothing says it happened.
     */
    const call = await incoming({
      outcome: "meeting-booked",
      requestedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const first = await inA((q) => processCall(q, call.id));
    const second = await inA((q) => processCall(q, call.id));

    expect(second.dealId, "a second run made a different deal").toBe(first.dealId);
    expect(second.contactCreated, "a second run claimed to create the contact again").toBeFalsy();
    expect((await inA((q) => contacts.listContacts(q))).length).toBe(1);
    expect((await inA((q) => deals.listDeals(q))).length).toBe(1);
    expect((await inA((q) => meetings.listMeetings(q))).length).toBe(1);
  });

  it("books no meeting when none was requested", async () => {
    const call = await incoming({ outcome: "meeting-booked", requestedAt: null });
    const result = await inA((q) => processCall(q, call.id));
    // The outcome says one was booked but no slot was captured. Inventing a
    // time would put a meeting in the diary that nobody agreed to.
    expect(result.meetingCreated).toBe(false);
    expect(await inA((q) => meetings.listMeetings(q))).toEqual([]);
  });

  it("refuses a call belonging to another tenant", async () => {
    const call = await incoming();
    const result = await inB((q) => processCall(q, call.id));
    expect(result.error).toMatch(/no longer exists/i);
    expect(await inB((q) => contacts.listContacts(q))).toEqual([]);
  });
});
