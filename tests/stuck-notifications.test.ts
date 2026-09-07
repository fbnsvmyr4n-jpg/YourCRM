import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import { shortenError } from "../src/server/notifications";
import type { TenantContext } from "../src/server/tenant";

/**
 * Work the system gave up on, where a person will actually see it.
 *
 * The outbox stops after six attempts and leaves a row saying why. That was
 * the whole of the reporting: one `console.error` inside a scheduled sweep and
 * a table nobody queries. So a quotation somebody approved could fail to reach
 * the client permanently, and the first anyone would know is the client asking
 * where it was.
 *
 * These tests are about that one property — **a job we abandoned is visible** —
 * and about the two ways it could quietly stop being true: a handler added
 * later with no label written for it, and one workspace seeing another's
 * failures.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let notifications: typeof import("../src/server/notifications");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

/** A job that was given up on, written straight to the table. */
const deadJob = (tenant: string, id: string, handler: string, error: string) => `
  INSERT INTO outbox (id, sub_account_id, handler, payload, status, attempts, last_error, settled_at)
  VALUES ('${id}', '${tenant}', '${handler}', '{}'::jsonb, 'dead', 6, ${error}, now());`;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  notifications = await import("../src/server/notifications");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM outbox; DELETE FROM calls; DELETE FROM meetings;`));

const feed = () => inA((qq) => notifications.listNotifications(qq));

describe("a job we gave up on reaches the person who needed it", () => {
  it("puts a failed quotation email in the feed, in the provider's own words", async () => {
    await db.seed(
      deadJob(TENANT_A, "j1", "quote_email", q('Resend returned 403 {"message":"You can only send testing emails to your own email address"}'))
    );

    const items = await feed();
    const stuck = items.filter((i) => i.kind === "stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0].title).toBe("1 quotation could not be emailed");
    /* The provider's words, not "something went wrong" — this is the sentence
       that tells somebody what to fix. */
    expect(stuck[0].detail).toBe("You can only send testing emails to your own email address");
    expect(stuck[0].href).toBe("/chat");
  });

  it("sorts it above everything a person merely has not done yet", async () => {
    /*
       A client is waiting on something this workspace believes it already
       sent. That outranks a meeting starting today — which is seeded here on
       purpose, because an ordering assertion with nothing to outrank passes
       whatever the weight is. Mutation testing caught exactly that: dropping
       the weight to 10 left this green until a competing item existed.
    */
    await db.seed(
      deadJob(TENANT_A, "j1", "quote_email", q("failed")) +
        `INSERT INTO meetings (id, sub_account_id, topic, scheduled_at, outcome)
         VALUES ('m_today', '${TENANT_A}', 'Site walkthrough', now(), 'scheduled');`
    );

    const items = await feed();
    const meeting = items.find((i) => i.kind === "meeting");
    expect(meeting, "the competing item did not appear — this test proves nothing without it").toBeTruthy();
    expect(items[0].kind).toBe("stuck");
    expect(items[0].weight).toBeGreaterThan(meeting!.weight);
  });

  it("counts them together rather than shouting once per job", async () => {
    await db.seed(
      deadJob(TENANT_A, "j1", "quote_email", q("first")) +
        deadJob(TENANT_A, "j2", "quote_email", q("second")) +
        deadJob(TENANT_A, "j3", "quote_email", q("third"))
    );
    const stuck = (await feed()).filter((i) => i.kind === "stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0].title).toBe("3 quotations could not be emailed");
  });

  it("separates different kinds of failure, because they are fixed in different places", async () => {
    await db.seed(
      deadJob(TENANT_A, "j1", "quote_email", q("mail refused")) +
        deadJob(TENANT_A, "j2", "call_analysis", q("model timed out"))
    );
    const stuck = (await feed()).filter((i) => i.kind === "stuck");
    expect(stuck.map((s) => s.href).sort()).toEqual(["/chat", "/voice-agents"]);
    expect(stuck.find((s) => s.href === "/voice-agents")?.title).toBe("1 call could not be read");
  });

  it("names a failed invitation, rather than falling back to generic wording", async () => {
    /*
       Found by driving it, one commit after the fallback was written: the
       invite handler was added and nobody registered it here, so a real failed
       invitation read "1 background task could not be completed". The fallback
       did its job — it surfaced — but a person cannot act on that sentence.
    */
    await db.seed(deadJob(TENANT_A, "j1", "invite_email", q("mail refused")));
    const stuck = (await feed()).filter((i) => i.kind === "stuck");
    expect(stuck[0].title).toBe("1 invitation could not be sent");
    expect(stuck[0].href).toBe("/settings?s=team");
  });

  it("every handler the app ships has wording of its own", async () => {
    /* The fallback is a safety net for a handler somebody forgot, not the
       normal case. If this fails, a handler was added without a label. */
    const { OUTBOX_HANDLERS } = await import("../src/server/outbox-handlers");
    for (const handler of OUTBOX_HANDLERS) {
      await db.seed(`DELETE FROM outbox;` + deadJob(TENANT_A, "j1", handler.name, q("failed")));
      const stuck = (await feed()).filter((i) => i.kind === "stuck");
      expect(stuck[0].title, `${handler.name} has no wording of its own`).not.toMatch(
        /background task/
      );
    }
  });

  it("SURFACES a handler nobody wrote a label for", async () => {
    /*
       The way this feature would quietly die. Somebody adds a handler next
       year, forgets the lookup table, and its failures become invisible again
       — recreating the exact hole this closed. So an unknown handler still
       produces an entry, in plain words.
    */
    await db.seed(deadJob(TENANT_A, "j1", "some_future_handler", q("it broke")));
    const stuck = (await feed()).filter((i) => i.kind === "stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0].title).toBe("1 background task could not be completed");
    expect(stuck[0].detail).toBe("it broke");
  });

  it("keeps the fallback wording grammatical when there is more than one", async () => {
    /* "1 background task were abandoned" shipped for about a minute. A feed
       people are meant to trust cannot read like a stub — so the plural is
       driven through the real code rather than asserted in the test. */
    await db.seed(
      deadJob(TENANT_A, "j1", "some_future_handler", q("it broke")) +
        deadJob(TENANT_A, "j2", "some_future_handler", q("it broke again"))
    );
    const stuck = (await feed()).filter((i) => i.kind === "stuck");
    expect(stuck[0].title).toBe("2 background tasks could not be completed");
  });

  it("says nothing when nothing failed", async () => {
    /* A feed that cries wolf stops being read, and the healthy state is the
       common one. */
    expect((await feed()).filter((i) => i.kind === "stuck")).toEqual([]);
  });

  it("ignores jobs that are still being retried", async () => {
    /* Pending is not failed. Telling somebody about a job that is going to
       succeed in thirty seconds is noise. */
    await db.seed(`
      INSERT INTO outbox (id, sub_account_id, handler, payload, status, attempts, last_error)
      VALUES ('j1', '${TENANT_A}', 'quote_email', '{}'::jsonb, 'pending', 2, 'temporarily down');`);
    expect((await feed()).filter((i) => i.kind === "stuck")).toEqual([]);
  });

  it("never shows one workspace another's failures", async () => {
    await db.seed(deadJob(TENANT_B, "j1", "quote_email", q("their problem")));
    expect((await feed()).filter((i) => i.kind === "stuck")).toEqual([]);
    expect(
      (await inB((qq) => notifications.listNotifications(qq))).filter((i) => i.kind === "stuck")
    ).toHaveLength(1);
  });
});

describe("cutting a provider error down to what a person can act on", () => {
  it("pulls the message out of the JSON a provider returns", () => {
    expect(
      shortenError('Resend returned 422 {"statusCode":422,"name":"validation_error","message":"Invalid `to` field"}')
    ).toBe("Invalid `to` field");
  });

  it("keeps a plain error as it is", () => {
    expect(shortenError("socket hang up")).toBe("socket hang up");
  });

  it("still finds the message when the stored error was cut off mid-sentence", () => {
    /*
       `last_error` is stored truncated at 500 characters, so a long provider
       error loses its closing quote. Insisting on one made the extraction fail
       precisely on the longest errors and put raw JSON in front of a person —
       which is what a real 403 looked like on screen.
    */
    const cut = 'Resend returned 403 {"statusCode":403,"name":"validation_error","message":"You can only send testing emails to your own address (someone@example.com). To send to other recipients, please veri';
    expect(shortenError(cut)).toMatch(/^You can only send testing emails/);
    expect(shortenError(cut)).not.toMatch(/statusCode/);
  });

  it("trims one too long to read in a popover", () => {
    const out = shortenError("x".repeat(400));
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("survives a job with no reason recorded", () => {
    expect(shortenError(null)).toBe("");
    expect(shortenError("")).toBe("");
  });
});
