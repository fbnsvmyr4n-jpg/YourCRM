import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";
import { flatten, type Availability } from "../src/server/booking/slots";

/**
 * Availability against a real database.
 *
 * `booking-slots.test.ts` proves the rules. This proves the questions asked to
 * feed them — which is where the interesting mistakes are, because a query that
 * returns slightly the wrong rows produces an answer that looks entirely
 * reasonable and double-books somebody.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let avail: typeof import("../src/server/booking/availability");
let wh: typeof import("../src/server/repos/working-hours");
let closePool: typeof import("../src/server/db").closePool;

const CTX: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const CTX_B: TenantContext = { ...CTX, subAccountId: TENANT_B };
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX, fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX_B, fn);

const MONDAY = "2026-09-07";
const BEFORE = new Date("2026-09-01T00:00:00Z");

const starts = (a: Availability) => flatten(a).map((s) => s.startsAt);
const ok = (a: Availability) => {
  if (!a.ok) throw new Error(`expected slots, got ${a.reason}`);
  return a;
};

/** Mon–Fri 09:00–17:00 in a tenant. */
const openWeek = (tenant: string) =>
  db.seed(
    `INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
     SELECT '${tenant}', d, 540, 1020 FROM generate_series(1, 5) AS d`
  );

const meeting = (tenant: string, id: string, at: string, minutes: number) =>
  db.seed(
    `INSERT INTO meetings (id, sub_account_id, topic, scheduled_at, duration_min)
     VALUES ('${id}', '${tenant}', 'Site visit', '${at}', ${minutes})`
  );

const ask = (o: Parameters<typeof avail.availabilityFor>[1] = {}) =>
  inA((q) => avail.availabilityFor(q, { fromDate: MONDAY, days: 1, now: BEFORE, ...o }));

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  avail = await import("../src/server/booking/availability");
  wh = await import("../src/server/repos/working-hours");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM meetings; DELETE FROM working_hours; DELETE FROM workspace_holidays;
    -- The harness seeds no settings row, and a missing one means getSettings
    -- hands back its defaults, so an UPDATE here would match nothing and every
    -- zone test below would silently run in UTC and pass for the wrong reason.
    -- Written for both tenants instead. (SQL comments, not JS ones: a backtick
    -- inside a template literal ends the literal, which is how this file failed
    -- to parse a moment ago and how two earlier files in this project broke.)
    INSERT INTO settings (sub_account_id, time_zone) VALUES
      ('${TENANT_A}', 'UTC'), ('${TENANT_B}', 'UTC')
    ON CONFLICT (sub_account_id) DO UPDATE SET time_zone = 'UTC';
  `)
);

describe("before anything is configured", () => {
  it("refuses rather than showing an empty fortnight", async () => {
    const a = await ask();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("no_hours");
  });

  it("offers times once hours exist", async () => {
    await openWeek(TENANT_A);
    expect(flatten(ok(await ask()))).toHaveLength(16);
  });
});

describe("the meetings it counts as busy", () => {
  beforeEach(() => openWeek(TENANT_A));

  it("BLOCKS A SLOT A MEETING RUNS INTO, NOT ONLY ONE IT STARTS IN", async () => {
    /*
       The query mistake worth having a test for. `listBetween` filters on
       `scheduled_at` alone, so a 90-minute meeting starting at 08:30 — before
       the window — would not come back, and 09:00 would be offered straight
       over the top of it. Availability built on that double-books somebody and
       looks, from the calendar, like it was never checked at all.
    */
    await meeting(TENANT_A, "m_early", "2026-09-07T08:30:00Z", 90);
    const a = ok(await ask());
    expect(starts(a), "a slot was offered inside an existing meeting").not.toContain(
      "2026-09-07T09:00:00.000Z"
    );
    expect(starts(a)).not.toContain("2026-09-07T09:30:00.000Z");
    expect(starts(a)[0]).toBe("2026-09-07T10:00:00.000Z");
  });

  it("blocks a meeting that starts the night before and runs in", async () => {
    /* The reason the fetch window is widened backwards. */
    await meeting(TENANT_A, "m_overnight", "2026-09-06T22:00:00Z", 12 * 60);
    const a = ok(await ask());
    expect(starts(a), "an overnight meeting did not block the morning").not.toContain(
      "2026-09-07T09:00:00.000Z"
    );
  });

  it("ignores a meeting that has been deleted", async () => {
    await meeting(TENANT_A, "m_gone", "2026-09-07T09:00:00Z", 60);
    await db.seed(`UPDATE meetings SET deleted_at = now() WHERE id = 'm_gone'`);
    expect(starts(ok(await ask()))).toContain("2026-09-07T09:00:00.000Z");
  });

  it("counts a meeting in ANOTHER workspace as no business of ours", async () => {
    /* Row-level security is the backstop; this proves the feature is on the
       right side of it. A competitor's diary blanking your booking page would
       be a data leak and an outage at once. */
    await openWeek(TENANT_B);
    await meeting(TENANT_B, "m_theirs", "2026-09-07T09:00:00Z", 8 * 60);

    expect(starts(ok(await ask())), "another tenant's meeting blocked our day").toContain(
      "2026-09-07T09:00:00.000Z"
    );

    const theirs = ok(
      await inB((q) => avail.availabilityFor(q, { fromDate: MONDAY, days: 1, now: BEFORE }))
    );
    expect(starts(theirs), "their own meeting did not block their day").not.toContain(
      "2026-09-07T09:00:00.000Z"
    );
  });
});

describe("the workspace's own calendar", () => {
  beforeEach(() => openWeek(TENANT_A));

  it("closes a day the workspace marked as a holiday", async () => {
    await db.seed(
      `INSERT INTO workspace_holidays (id, sub_account_id, on_date, name)
       VALUES ('h1', '${TENANT_A}', DATE '2026-09-07', 'Company shutdown')`
    );
    expect(flatten(ok(await ask()))).toHaveLength(0);
  });

  it("READS TIMES IN THE WORKSPACE'S ZONE, NOT THE SERVER'S", async () => {
    /* 09:00 must mean nine in the morning where the business is. With the zone
       ignored, every slot on this page would be two hours out for this
       workspace and correct for nobody. */
    await db.seed(`UPDATE settings SET time_zone = 'Africa/Johannesburg' WHERE sub_account_id = '${TENANT_A}'`);
    expect(starts(ok(await ask()))[0]).toBe("2026-09-07T07:00:00.000Z");

    await db.seed(`UPDATE settings SET time_zone = 'America/New_York' WHERE sub_account_id = '${TENANT_A}'`);
    expect(starts(ok(await ask()))[0]).toBe("2026-09-07T13:00:00.000Z");
  });

  it("starts from today in the WORKSPACE's zone when no date is given", async () => {
    /* At 23:00 UTC it is already tomorrow in Johannesburg. Using the server's
       date would offer a day the workspace has already finished. */
    await db.seed(`UPDATE settings SET time_zone = 'Africa/Johannesburg' WHERE sub_account_id = '${TENANT_A}'`);
    expect(avail.todayIn("Africa/Johannesburg", new Date("2026-09-07T23:00:00Z"))).toBe(
      "2026-09-08"
    );
    expect(avail.todayIn("America/New_York", new Date("2026-09-08T01:00:00Z"))).toBe("2026-09-07");

    const a = ok(
      await inA((q) =>
        avail.availabilityFor(q, { days: 1, now: new Date("2026-09-07T23:00:00Z") })
      )
    );
    expect(a.days[0]?.date, "the server's date was used instead of the workspace's").toBe(
      "2026-09-08"
    );
  });
});

describe("the defaults a caller gets without asking", () => {
  beforeEach(() => openWeek(TENANT_A));

  it("offers half-hour slots two weeks out, with notice", async () => {
    const a = ok(await inA((q) => avail.availabilityFor(q, { fromDate: MONDAY, now: BEFORE })));
    expect(a.days).toHaveLength(10); // ten working days in a fortnight
    for (const s of flatten(a)) {
      expect(Date.parse(s.endsAt) - Date.parse(s.startsAt)).toBe(30 * 60_000);
    }
  });

  it("keeps two hours' notice, so nothing is bookable that starts immediately", async () => {
    const now = new Date("2026-09-07T09:00:00Z");
    const a = ok(await inA((q) => avail.availabilityFor(q, { fromDate: MONDAY, days: 1, now })));
    const first = Date.parse(starts(a)[0]);
    expect(first - now.getTime()).toBeGreaterThanOrEqual(120 * 60_000);
  });

  it("will not be talked into an unbounded range", async () => {
    const a = ok(
      await inA((q) => avail.availabilityFor(q, { fromDate: MONDAY, days: 100_000, now: BEFORE }))
    );
    expect(a.days.length).toBeLessThanOrEqual(90);
  });
});

describe("hours and availability agree", () => {
  it("stops offering a day the moment it is closed in Settings", async () => {
    await openWeek(TENANT_A);
    expect(ok(await ask({ days: 7, fromDate: "2026-09-06" })).days.map((d) => d.weekday)).toEqual([
      1, 2, 3, 4, 5,
    ]);

    await inA((q) =>
      wh.replaceWorkingHours(q, [
        { weekday: 1, opensMinute: 540, closesMinute: 1020 },
        { weekday: 6, opensMinute: 540, closesMinute: 780 },
      ])
    );
    expect(ok(await ask({ days: 7, fromDate: "2026-09-06" })).days.map((d) => d.weekday)).toEqual([
      1, 6,
    ]);
  });

  it("goes back to refusing when the hours are cleared", async () => {
    await openWeek(TENANT_A);
    expect((await ask()).ok).toBe(true);
    await inA((q) => wh.replaceWorkingHours(q, []));
    const a = await ask();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("no_hours");
  });
});
