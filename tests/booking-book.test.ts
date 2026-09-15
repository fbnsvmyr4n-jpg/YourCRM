import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";

/**
 * A stranger writing to the database.
 *
 * Every other write in this product comes from somebody who signed in. These
 * tests treat the booking request as hostile, because it is: the slug, the
 * time, the name and the email all arrive from a machine nobody controls.
 *
 * MUTATION RUN (with booking-action and booking-email): 20 mutants, 18 caught.
 * The two survivors are equivalent, and recorded here rather than left looking
 * like coverage:
 *
 *   • Dropping `lower()` from the slug match. The URL is lowercased before the
 *     query and the table's CHECK only admits lowercase slugs, so both sides are
 *     already lowercase. Kept as the guard for the day that CHECK is relaxed.
 *   • Dropping the `isSlug` check before SQL. A malformed slug is passed as a
 *     bound parameter to an equality match and simply finds no row, so the
 *     answer is the same null. What the check buys is not reaching the database
 *     at all for garbage, which no assertion here can see.
 *
 * Three findings came from driving the real page rather than from this suite,
 * and each became a test: every real user is agency-level (sub_account_id
 * NULL), which the fixture user is not, so published pages 404'd; the
 * confirmation was queued with nothing to send it; and a link typed in capitals
 * was refused while the schema promised it would work.
 */

let db: TestDb;
let bk: typeof import("../src/server/booking/book");
let links: typeof import("../src/server/repos/booking-links");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;

/** Monday 7 Sep 2026, well before it. Offices open 09:00–17:00 UTC. */
const NOW = new Date("2026-09-01T00:00:00Z");
const NINE = "2026-09-07T09:00:00.000Z";

const request = (over: Partial<Parameters<typeof bk.book>[0]> = {}) => ({
  slug: "acme-cranes",
  name: "Amara Dube",
  email: "amara@heineken.test",
  startsAt: NINE,
  notes: "Gate code 4471",
  ...over,
});

const rows = <T>(sql: string) =>
  withSystem((q) => q.rows<T & Record<string, unknown>>(sql));

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  bk = await import("../src/server/booking/book");
  links = await import("../src/server/repos/booking-links");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM outbox; DELETE FROM meetings; DELETE FROM contacts;
    DELETE FROM booking_links; DELETE FROM working_hours; DELETE FROM workspace_holidays;
    UPDATE sub_accounts SET deleted_at = NULL;
    INSERT INTO settings (sub_account_id, time_zone) VALUES
      ('${TENANT_A}', 'UTC'), ('${TENANT_B}', 'UTC')
    ON CONFLICT (sub_account_id) DO UPDATE SET time_zone = 'UTC';
    INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
      SELECT '${TENANT_A}', d, 540, 1020 FROM generate_series(1, 5) AS d;
    INSERT INTO booking_links (id, sub_account_id, slug, title, slot_minutes, notice_minutes, days_ahead, kind, enabled)
      VALUES ('bl_a', '${TENANT_A}', 'acme-cranes', 'Site visit', 30, 0, 14, 'in_person', TRUE);
  `)
);

describe("what the slug is allowed to reach", () => {
  it("books into the workspace that published the link, and no other", async () => {
    const out = await bk.book(request(), NOW);
    expect(out.ok).toBe(true);

    const m = await rows<{ sub_account_id: string; owner_user_id: string }>(
      `SELECT sub_account_id, owner_user_id FROM meetings`
    );
    expect(m).toHaveLength(1);
    expect(m[0].sub_account_id).toBe(TENANT_A);
    // A real person owns it, so somebody is expected at it.
    expect(m[0].owner_user_id).toBe(USER_A);
  });

  it("RESOLVES FOR AN AGENCY-LEVEL OWNER, WHICH IS HOW REAL ACCOUNTS ARE SHAPED", async () => {
    /*
       Found by driving the page, not by this suite. Every real user has
       sub_account_id NULL — they belong to the agency, not one workspace — but
       the fixture user here carries one, so the owner lookup was only ever
       tested against a shape production does not have. Published on real data,
       the page 404'd for everyone.
    */
    await db.seed(`UPDATE users SET sub_account_id = NULL WHERE id = '${USER_A}'`);
    try {
      const link = await withSystem((q) => links.resolveSlug(q, "acme-cranes"));
      expect(link, "a published link with an agency-level owner did not resolve").not.toBeNull();
      expect(link!.ownerUserId).toBe(USER_A);

      const out = await bk.book(request(), NOW);
      expect(out.ok).toBe(true);
      const [m] = await rows<{ owner_user_id: string }>(`SELECT owner_user_id FROM meetings`);
      expect(m.owner_user_id).toBe(USER_A);
    } finally {
      await db.seed(`UPDATE users SET sub_account_id = '${TENANT_A}' WHERE id = '${USER_A}'`);
    }
  });

  it("never borrows an owner from another agency", async () => {
    /* The widened lookup's boundary. A workspace nobody in its own agency can
       own must not resolve by picking up somebody else's customer. */
    await db.seed(`
      INSERT INTO agencies (id, name) VALUES ('ag_other', 'Other Agency') ON CONFLICT DO NOTHING;
      INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
        VALUES ('u_other', 'ag_other', NULL, 'boss@other.test', 'x', 'Other Boss', 'owner')
        ON CONFLICT DO NOTHING;
      UPDATE users SET deleted_at = now() WHERE id = '${USER_A}';
    `);
    try {
      expect(await withSystem((q) => links.resolveSlug(q, "acme-cranes"))).toBeNull();
    } finally {
      await db.seed(`
        UPDATE users SET deleted_at = NULL WHERE id = '${USER_A}';
        DELETE FROM users WHERE id = 'u_other';
        DELETE FROM agencies WHERE id = 'ag_other';
      `);
    }
  });

  it("GIVES THE SAME ANSWER FOR AN UNPUBLISHED LINK AS FOR A NONEXISTENT ONE", async () => {
    /* A different response for "exists but switched off" would let anybody map
       which businesses use the product, one guessed slug at a time. */
    const missing = await bk.book(request({ slug: "no-such-business" }), NOW);
    await db.seed(`UPDATE booking_links SET enabled = FALSE`);
    const unpublished = await bk.book(request(), NOW);

    expect(missing).toEqual(unpublished);
    expect(missing.ok).toBe(false);
    expect(await rows(`SELECT id FROM meetings`)).toHaveLength(0);
  });

  it("does not resolve a link belonging to a deleted workspace", async () => {
    await db.seed(`UPDATE sub_accounts SET deleted_at = now() WHERE id = '${TENANT_A}'`);
    const out = await bk.book(request(), NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not_found");
  });

  it("resolves a link typed in capitals, and refuses anything that is not a slug", async () => {
    /* Links get read down phones and typed in capitals. The first version
       refused this — a 404 for the same page — while the schema comment beside
       the unique index promised that capitals were the same page. */
    for (const typed of ["acme-cranes", "ACME-CRANES", "Acme-Cranes", " acme-cranes "]) {
      const found = await withSystem((q) => links.resolveSlug(q, typed));
      expect(found?.slug, `"${typed}" did not reach the page`).toBe("acme-cranes");
    }

    for (const bad of ["", "a", "-acme", "acme-", "acme cranes", "acme/../x", "acme'--"]) {
      expect(await withSystem((q) => links.resolveSlug(q, bad)), `${bad} resolved`).toBeNull();
    }
  });

  it("tells the visitor nothing beyond the terms and the workspace name", async () => {
    const link = await withSystem((q) => links.resolveSlug(q, "acme-cranes"));
    expect(Object.keys(link!).sort()).toEqual(
      [
        "agencyId",
        "daysAhead",
        "kind",
        "noticeMinutes",
        "ownerUserId",
        "slotMinutes",
        "slug",
        "subAccountId",
        "title",
        "workspaceName",
      ].sort()
    );
  });
});

describe("the posted time is not believed", () => {
  it("REFUSES A TIME THE WORKSPACE IS NOT OFFERING", async () => {
    for (const startsAt of [
      "2026-09-07T03:00:00.000Z", // the middle of the night
      "2026-09-07T09:15:00.000Z", // inside the day, off the grid
      "2026-09-06T10:00:00.000Z", // a Sunday, closed
      "2026-08-31T10:00:00.000Z", // already past
    ]) {
      const out = await bk.book(request({ startsAt }), NOW);
      expect(out.ok, `${startsAt} was accepted`).toBe(false);
    }
    expect(await rows(`SELECT id FROM meetings`)).toHaveLength(0);
  });

  it("refuses a time a holiday has closed since the page was loaded", async () => {
    await db.seed(
      `INSERT INTO workspace_holidays (id, sub_account_id, on_date, name)
       VALUES ('h1', '${TENANT_A}', DATE '2026-09-07', 'Shutdown')`
    );
    const out = await bk.book(request(), NOW);
    expect(out.ok).toBe(false);
  });

  it("stops taking bookings the moment the hours are cleared", async () => {
    await db.seed(`DELETE FROM working_hours`);
    const out = await bk.book(request(), NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not_found");
  });

  it("WILL NOT BOOK THE SAME SLOT TWICE", async () => {
    const first = await bk.book(request(), NOW);
    const second = await bk.book(request({ name: "Ben Cole", email: "ben@client.test" }), NOW);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("taken");
    expect(await rows(`SELECT id FROM meetings`)).toHaveLength(1);
  });

  it("lets only one of two simultaneous requests for a slot through", async () => {
    /*
       HONEST LIMIT OF THIS TEST: the harness runs with a pool of one
       connection, so these two requests are serialised by the pool before the
       advisory lock is ever contended. It proves the outcome, not the lock. The
       lock is what makes the outcome hold on a real pool, where both
       transactions would otherwise read the diary before either wrote to it.
    */
    const results = await Promise.all([
      bk.book(request(), NOW),
      bk.book(request({ name: "Ben Cole", email: "ben@client.test" }), NOW),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await rows(`SELECT id FROM meetings`)).toHaveLength(1);
  });
});

describe("what a booking writes", () => {
  it("files the visitor as a contact, and reuses one who already exists", async () => {
    await bk.book(request(), NOW);
    await bk.book(request({ startsAt: "2026-09-07T10:00:00.000Z", name: "Amara D." }), NOW);

    const contacts = await rows<{ email: string }>(`SELECT email FROM contacts`);
    expect(contacts, "the same person became two contacts").toHaveLength(1);
    expect(contacts[0].email).toBe("amara@heineken.test");
  });

  it("marks the meeting as booked online and keeps the terms of the link", async () => {
    await bk.book(request(), NOW);
    const [m] = await rows<{ topic: string; duration_min: number; kind: string; notes: string }>(
      `SELECT topic, duration_min, kind, notes FROM meetings`
    );
    expect(m.topic).toBe("Site visit");
    expect(m.duration_min).toBe(30);
    expect(m.kind).toBe("in_person");
    expect(m.notes).toMatch(/^Booked online\./);
    expect(m.notes).toContain("Gate code 4471");
  });

  it("queues one confirmation email per booking", async () => {
    await bk.book(request(), NOW);
    const jobs = await rows<{ handler: string }>(`SELECT handler FROM outbox`);
    expect(jobs.map((j) => j.handler)).toEqual(["booking_email"]);
  });

  it("TRIES TO SEND THE CONFIRMATION, rather than leaving it for a scheduler that does not exist", async () => {
    /* There is no cron on this deployment; every feature that queues work
       drains straight afterwards. The first version only queued, so the
       visitor was promised an email that nothing would ever send. With no
       mail provider in this test the attempt is recorded and retried later —
       and `attempts` moving off zero is the proof it was tried at all. */
    const out = await bk.book(request(), NOW);
    expect(out.ok).toBe(true);
    const [job] = await rows<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM outbox WHERE handler = 'booking_email'`
    );
    expect(job.attempts, "the confirmation was queued and never attempted").toBeGreaterThan(0);
  });

  it("writes nothing when the request is malformed", async () => {
    for (const over of [
      { name: "   " },
      { email: "not-an-email" },
      { email: "a@b" },
      { startsAt: "tomorrow morning" },
    ]) {
      const out = await bk.book(request(over), NOW);
      expect(out.ok, JSON.stringify(over)).toBe(false);
      if (!out.ok) expect(out.reason).toBe("invalid");
    }
    expect(await rows(`SELECT id FROM meetings`)).toHaveLength(0);
    expect(await rows(`SELECT id FROM contacts`)).toHaveLength(0);
  });

  it("bounds what a stranger can store", async () => {
    await bk.book(request({ name: "x".repeat(5000), notes: "y".repeat(50_000) }), NOW);
    const [c] = await rows<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM contacts`
    );
    const [m] = await rows<{ notes: string }>(`SELECT notes FROM meetings`);
    expect((c.first_name + c.last_name).length).toBeLessThanOrEqual(80);
    expect(m.notes.length).toBeLessThanOrEqual(2100);
  });
});

describe("the agency is not reachable through a booking", () => {
  it("never touches another workspace, even one with the same hours", async () => {
    await db.seed(`
      INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
        SELECT '${TENANT_B}', d, 540, 1020 FROM generate_series(1, 5) AS d;
    `);
    await bk.book(request(), NOW);
    const inB = await rows(`SELECT id FROM meetings WHERE sub_account_id = '${TENANT_B}'`);
    expect(inB).toHaveLength(0);
    expect(AGENCY).toBeTruthy();
  });
});
