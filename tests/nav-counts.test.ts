import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * The numbers on the sidebar are real numbers.
 *
 * The Inbox badge was the literal string "12" in the navigation config. It read
 * 12 against an empty database — the first claim the product makes to a new
 * customer, and false. Nothing caught it because nothing was looking at the
 * static config; the tests all watched the repositories the badge did not use.
 *
 * These count against a real database, in two tenants, because a badge that
 * totals every customer's unread is both wrong and a disclosure.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let navCounts: typeof import("../src/server/nav-counts").navCounts;
let closePool: typeof import("../src/server/db").closePool;

const ctx = (subAccountId: string) => ({
  agencyId: "ag_test",
  subAccountId,
  userId: "u_test_a",
  role: "owner" as const,
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ navCounts } = await import("../src/server/nav-counts"));
  ({ closePool } = await import("../src/server/db"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  await db.seed(`DELETE FROM messages; DELETE FROM meetings;`);
});

const message = (tenant: string, id: string, unread: boolean, direction = "received") =>
  db.seed(
    `INSERT INTO messages (id, sub_account_id, direction, subject, body, unread, sent_at)
     VALUES ('${id}', '${tenant}', '${direction}', 's', 'b', ${unread}, now())`
  );

describe("the inbox badge counts what is actually waiting", () => {
  it("is zero on an empty inbox", async () => {
    const counts = await withTenant(ctx(TENANT_A), (q) => navCounts(q));
    expect(counts.inbox, "an empty inbox reported unread messages").toBe(0);
  });

  it("counts unread received messages", async () => {
    await message(TENANT_A, "m1", true);
    await message(TENANT_A, "m2", true);
    const counts = await withTenant(ctx(TENANT_A), (q) => navCounts(q));
    expect(counts.inbox).toBe(2);
  });

  it("ignores read messages", async () => {
    await message(TENANT_A, "m1", true);
    await message(TENANT_A, "m2", false);
    const counts = await withTenant(ctx(TENANT_A), (q) => navCounts(q));
    expect(counts.inbox, "a read message was still counted as waiting").toBe(1);
  });

  it("ignores messages the customer sent themselves", async () => {
    // An unread flag on an outbound message is meaningless, but it exists on
    // the row, and counting it would show a badge for the customer's own reply.
    await message(TENANT_A, "m1", true, "sent");
    const counts = await withTenant(ctx(TENANT_A), (q) => navCounts(q));
    expect(counts.inbox).toBe(0);
  });

  it("ignores deleted messages", async () => {
    await message(TENANT_A, "m1", true);
    await db.seed(`UPDATE messages SET deleted_at = now() WHERE id = 'm1'`);
    const counts = await withTenant(ctx(TENANT_A), (q) => navCounts(q));
    expect(counts.inbox, "a deleted message still showed on the badge").toBe(0);
  });

  it("counts only the workspace being looked at", async () => {
    // The badge belongs to one client. A total across an agency's clients is
    // both a wrong number and a disclosure of how busy the others are.
    await message(TENANT_A, "m1", true);
    await message(TENANT_B, "m2", true);
    await message(TENANT_B, "m3", true);

    expect((await withTenant(ctx(TENANT_A), (q) => navCounts(q))).inbox).toBe(1);
    expect((await withTenant(ctx(TENANT_B), (q) => navCounts(q))).inbox).toBe(2);
  });
});

describe("the calendar dot means something is on today", () => {
  const meeting = (tenant: string, id: string, when: string) =>
    db.seed(
      `INSERT INTO meetings (id, sub_account_id, topic, scheduled_at)
       VALUES ('${id}', '${tenant}', 'Call', ${when})`
    );

  /**
   * A moment on the WORKSPACE's day, which with no settings row is UTC.
   *
   * These fixtures used to say `date_trunc('day', now())`, which is midnight in
   * whatever zone the database session happens to be in — the machine's, under
   * this harness. That agreed with the old badge only because the badge made
   * the same mistake. Written against the workspace's day, the fixture says
   * what it means and the boundary tests test the boundary.
   */
  const utcDay = (offset: string) =>
    `(date_trunc('day', now() AT TIME ZONE 'UTC') + interval '${offset}') AT TIME ZONE 'UTC'`;

  it("is off with nothing scheduled", async () => {
    expect((await withTenant(ctx(TENANT_A), (q) => navCounts(q))).calendarToday).toBe(false);
  });

  it("is on for a meeting later today", async () => {
    await meeting(TENANT_A, "mt1", utcDay("13 hours"));
    expect((await withTenant(ctx(TENANT_A), (q) => navCounts(q))).calendarToday).toBe(true);
  });

  it("is off for tomorrow and for yesterday", async () => {
    // The boundaries are the whole point of a "today" dot. An inclusive upper
    // bound puts tomorrow's first meeting on today's badge.
    await meeting(TENANT_A, "mt1", utcDay("1 day"));
    await meeting(TENANT_A, "mt2", utcDay("-1 second"));
    expect((await withTenant(ctx(TENANT_A), (q) => navCounts(q))).calendarToday).toBe(false);
  });

  it("belongs to one workspace", async () => {
    await meeting(TENANT_B, "mt1", utcDay("13 hours"));
    expect((await withTenant(ctx(TENANT_A), (q) => navCounts(q))).calendarToday).toBe(false);
    expect((await withTenant(ctx(TENANT_B), (q) => navCounts(q))).calendarToday).toBe(true);
  });

  /**
   * The day is the BUSINESS'S day.
   *
   * Found by the inbox audit: the dot used `date_trunc('day', now())` — the
   * database's UTC day — while the Calendar page beside it has always used the
   * workspace's zone. In Johannesburg those disagree until 02:00; in Auckland a
   * 09:00 meeting is 20:00 UTC the day before, so the page showed a meeting
   * today and the dot next to it said nothing was on.
   *
   * The two zones below are 25 hours apart, so whatever the server's clock
   * says, at least one of them is on a different date from UTC — the same pair
   * the other time-zone tests in this project use, for the same reason.
   */
  for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    it(`AGREES WITH THE CALENDAR PAGE IN ${zone}`, async () => {
      const { instantToWallClock, wallClockToInstant } = await import("../src/lib/zoned");
      await db.seed(
        `INSERT INTO settings (sub_account_id, time_zone) VALUES ('${TENANT_A}', '${zone}')
         ON CONFLICT (sub_account_id) DO UPDATE SET time_zone = '${zone}'`
      );
      /* The business's own today, exactly as the Calendar page computes it. */
      const today = instantToWallClock(new Date().toISOString(), zone)!.date;
      const atNine = wallClockToInstant(today, "09:00", zone)!;
      await meeting(TENANT_A, "mt_local", `'${atNine}'::timestamptz`);

      const counts = await withTenant(ctx(TENANT_A), (q) => navCounts(q));
      await db.seed(`DELETE FROM settings WHERE sub_account_id = '${TENANT_A}'`);

      expect(
        counts.calendarToday,
        "the Calendar page shows a meeting today and the dot beside it does not"
      ).toBe(true);
    });
  }
});

describe("the navigation config holds no invented numbers", () => {
  /**
   * The defect was not a wrong query — it was a number written into a config
   * file, where no repository test would ever look. So the file itself is
   * checked: it may name a count, it may not contain one.
   */
  it("nav.ts contains no literal badge value", () => {
    const src = readFileSync(
      join(__dirname, "..", "src", "components", "shell", "nav.ts"),
      "utf8"
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code, "a badge literal is back in the navigation config").not.toMatch(
      /badge:\s*["'`]/
    );
    // `dot: true` was the same thing wearing a different shape — a permanent
    // "something is happening" marker that was true on an empty account.
    expect(code, "a hardcoded dot is back in the navigation config").not.toMatch(/dot:\s*true/);
  });
});
