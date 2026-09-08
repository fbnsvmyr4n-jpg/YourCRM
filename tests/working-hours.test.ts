import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The hours a workspace is open.
 *
 * The first half of public booking, and the half that decides whether the
 * second half can be honest. Every property here exists because getting it
 * wrong sends a real person to a real address at a time nobody was there:
 *
 *   - a day nobody configured is CLOSED, never a guessed nine-to-five;
 *   - a week is saved whole or not at all, so a bad Tuesday cannot silently
 *     close Wednesday through Friday;
 *   - and one workspace's hours are not another's.
 *
 * MUTATION RUN: 14 mutants, 13 caught. The one survivor is recorded here rather
 * than left looking like coverage:
 *
 *   • Moving `validateWeek` to AFTER the DELETE survives, and should. The call
 *     runs inside `withTenant`, which is a transaction, so a throw rolls the
 *     DELETE back either way and nothing outside can tell the two apart. An
 *     equivalent mutant for every observable property. Validating first is kept
 *     because it is the clearer order to read, not because a test proves it.
 *
 * Two other survivors were NOT equivalent, and became the tests they were
 * missing: the weekday and minute checks could be deleted from the repo with
 * everything still green, because the Postgres constraints reject the same
 * values and the tests only asserted that *something* threw. "the check in
 * front of the database, on its own" now pins that layer by the message only it
 * can produce.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let wh: typeof import("../src/server/repos/working-hours");
let closePool: typeof import("../src/server/db").closePool;

const CTX: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const CTX_B: TenantContext = { ...CTX, subAccountId: TENANT_B };
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX, fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX_B, fn);

const day = (weekday: number, opens: string, closes: string) => ({
  weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
  opensMinute: wh.parseClock(opens)!,
  closesMinute: wh.parseClock(closes)!,
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  wh = await import("../src/server/repos/working-hours");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM working_hours;`));

describe("a day nobody configured is closed", () => {
  it("starts with no hours at all, rather than a working week nobody chose", async () => {
    /* The defect this prevents: a booking page that assumes nine-to-five and
       lets a client book a Saturday site visit at a business that does not open
       on Saturdays. Nothing is offered until somebody says what to offer. */
    const week = await inA((q) => wh.listWorkingHours(q));
    expect(week).toEqual([]);
    expect(wh.hasWorkingHours(week), "a brand-new workspace claimed to be open").toBe(false);
  });

  it("reports a specific unconfigured day as closed, not as an error", async () => {
    await inA((q) => wh.replaceWorkingHours(q, [day(1, "08:00", "17:00")]));
    const week = await inA((q) => wh.listWorkingHours(q));

    expect(wh.hoursFor(week, 1)).toMatchObject({ opensMinute: 480, closesMinute: 1020 });
    for (const closed of [0, 2, 3, 4, 5, 6]) {
      expect(wh.hoursFor(week, closed), `weekday ${closed} was not closed`).toBeNull();
    }
  });

  it("closes a day by leaving it out — the only way to say it", async () => {
    /* An update-only path could never turn a day off, which is why the write
       deletes first. Proven by actually turning one off. */
    await inA((q) =>
      wh.replaceWorkingHours(q, [day(1, "08:00", "17:00"), day(6, "09:00", "13:00")])
    );
    expect((await inA((q) => wh.listWorkingHours(q))).map((d) => d.weekday)).toEqual([1, 6]);

    await inA((q) => wh.replaceWorkingHours(q, [day(1, "08:00", "17:00")]));
    const after = await inA((q) => wh.listWorkingHours(q));
    expect(after.map((d) => d.weekday), "Saturday could not be closed again").toEqual([1]);
  });

  it("can be emptied back to nothing", async () => {
    await inA((q) => wh.replaceWorkingHours(q, [day(1, "08:00", "17:00")]));
    await inA((q) => wh.replaceWorkingHours(q, []));
    expect(await inA((q) => wh.listWorkingHours(q))).toEqual([]);
  });
});

describe("Sunday is 0, on both sides", () => {
  it("agrees with getDay() and with Postgres EXTRACT(DOW)", async () => {
    /* A silent one-day shift is the classic bug here: ISO says Monday is 1,
       JavaScript and Postgres both say Sunday is 0. Asserted against the real
       thing rather than against a constant repeated from the source. */
    await inA((q) => wh.replaceWorkingHours(q, [day(0, "10:00", "14:00")]));

    const row = await inA((q) =>
      q.one<{ weekday: number }>(
        `SELECT weekday FROM working_hours WHERE sub_account_id = $1`,
        [TENANT_A]
      )
    );
    expect(row?.weekday).toBe(0);
    expect(wh.WEEKDAYS[0]).toBe("Sunday");

    // A date known to be a Sunday: 6 September 2026.
    expect(new Date("2026-09-06T12:00:00Z").getUTCDay()).toBe(0);
    const dow = await inA((q) =>
      q.one<{ dow: string }>(`SELECT EXTRACT(DOW FROM DATE '2026-09-06')::text AS dow`)
    );
    expect(Number(dow?.dow)).toBe(0);
  });
});

describe("times a day can actually have", () => {
  it("reads and writes the clock without drifting", () => {
    expect(wh.parseClock("08:00")).toBe(480);
    expect(wh.parseClock("08:30")).toBe(510);
    expect(wh.parseClock("00:00")).toBe(0);
    expect(wh.parseClock("23:59")).toBe(1439);
    expect(wh.formatClock(510)).toBe("08:30");
    expect(wh.formatClock(0)).toBe("00:00");
    expect(wh.formatClock(1439)).toBe("23:59");
  });

  it("lets a day run to midnight, which 23:59 is not", () => {
    expect(wh.parseClock("24:00")).toBe(1440);
    expect(wh.formatClock(1440)).toBe("24:00");
  });

  it("refuses a shape it would otherwise have to guess at", () => {
    for (const bad of ["8:30", "0830", "8:30am", "25:00", "12:60", "", "noon", null, 480]) {
      expect(wh.parseClock(bad), `${String(bad)} was accepted`).toBeNull();
    }
  });

  it("REFUSES A DAY THAT CLOSES BEFORE IT OPENS", async () => {
    /* Not a short day — a negative one. Every slot generator would return an
       empty list and nobody would be told why. */
    await expect(
      inA((q) => wh.replaceWorkingHours(q, [day(1, "17:00", "08:00")]))
    ).rejects.toThrow(/closes at or before it opens/i);
  });

  it("refuses a day that closes exactly when it opens", async () => {
    await expect(
      inA((q) => wh.replaceWorkingHours(q, [day(1, "09:00", "09:00")]))
    ).rejects.toThrow(/closes at or before it opens/i);
  });

  it("refuses a weekday that is not one", async () => {
    for (const weekday of [-1, 7, 1.5]) {
      await expect(
        inA((q) =>
          wh.replaceWorkingHours(q, [
            { weekday: weekday as 0, opensMinute: 480, closesMinute: 1020 },
          ])
        )
      ).rejects.toThrow();
    }
  });

  it("refuses a minute that is not on the clock", async () => {
    /* `parseClock` cannot produce these, so nothing reaching the repo through
       the form will carry them — but a server action is a public endpoint and
       the repo takes numbers, so the numbers have to be checked here too. */
    const cases: Array<[number, number, string]> = [
      [-1, 1020, "negative open"],
      [1440, 1441, "opens at the far midnight"],
      [480, 1441, "closes past midnight"],
      [480, 0, "closes at zero"],
      [8.5, 1020, "fractional minute"],
    ];
    for (const [opensMinute, closesMinute, what] of cases) {
      await expect(
        inA((q) => wh.replaceWorkingHours(q, [{ weekday: 1, opensMinute, closesMinute }])),
        `${what} was accepted`
      ).rejects.toThrow();
    }
  });

  it("refuses the same day twice", async () => {
    await expect(
      inA((q) => wh.replaceWorkingHours(q, [day(1, "08:00", "12:00"), day(1, "13:00", "17:00")]))
    ).rejects.toThrow(/twice/i);
  });

  it("names the day in the message, so the person knows which row to fix", async () => {
    await expect(
      inA((q) => wh.replaceWorkingHours(q, [day(4, "17:00", "08:00")]))
    ).rejects.toThrow(/Thursday/);
  });
});

describe("the check in front of the database, on its own", () => {
  /*
     These call `validateWeek` directly, and they exist because of a mutation
     run: removing the weekday and minute checks from the repo left every test
     above still passing. Both layers reject the same values, so a test that
     only asserts "it threw" cannot tell which one did the work — and the
     TypeScript layer is the one that produces a sentence naming the day. Take
     it away and the person gets a raw constraint violation instead.

     So these assert the MESSAGE, which only this layer can produce.
  */
  const at = (weekday: number, opensMinute: number, closesMinute: number) => [
    { weekday: weekday as 0, opensMinute, closesMinute },
  ];

  it("rejects a weekday outside the week, by name", () => {
    for (const bad of [-1, 7, 12, 1.5]) {
      const problems = wh.validateWeek(at(bad, 480, 1020));
      expect(problems, `weekday ${bad} passed validation`).toHaveLength(1);
      expect(problems[0].message).toMatch(/not a day of the week/i);
    }
  });

  it("rejects an opening minute that is not a time of day", () => {
    for (const bad of [-1, 1440, 5000, 8.5, Number.NaN]) {
      const problems = wh.validateWeek(at(1, bad, 1020));
      expect(problems, `open minute ${bad} passed validation`).toHaveLength(1);
      expect(problems[0].message).toMatch(/opening time is not a time of day/i);
    }
  });

  it("rejects a closing minute that is not a time of day", () => {
    for (const bad of [0, -1, 1441, 17.5, Number.NaN]) {
      const problems = wh.validateWeek(at(1, 480, bad));
      expect(problems, `close minute ${bad} passed validation`).toHaveLength(1);
      expect(problems[0].message).toMatch(/closing time is not a time of day/i);
    }
  });

  it("accepts the edges that are real: midnight to midnight", () => {
    expect(wh.validateWeek(at(1, 0, 1440))).toEqual([]);
    expect(wh.validateWeek(at(0, 1439, 1440))).toEqual([]);
  });

  it("reports every bad day, not just the first", () => {
    // The form marks rows; one problem at a time would make fixing a week a
    // series of round trips.
    const problems = wh.validateWeek([
      { weekday: 1, opensMinute: 1020, closesMinute: 480 },
      { weekday: 2, opensMinute: 480, closesMinute: 1020 },
      { weekday: 3, opensMinute: -1, closesMinute: 1020 },
    ]);
    expect(problems.map((p) => p.weekday)).toEqual([1, 3]);
  });

  it("says nothing about a week that is fine", () => {
    expect(wh.validateWeek([])).toEqual([]);
    expect(
      wh.validateWeek([
        { weekday: 1, opensMinute: 480, closesMinute: 1020 },
        { weekday: 6, opensMinute: 540, closesMinute: 780 },
      ])
    ).toEqual([]);
  });
});

describe("a week saves whole, or not at all", () => {
  it("LEAVES THE STORED WEEK UNTOUCHED WHEN ANY DAY IS WRONG", async () => {
    /*
       The one that would quietly close a business: a set that fails halfway
       leaves the workspace open on the days that happened to be written and
       closed on the rest, with a booking page confidently offering the remains.

       Two things prevent it, and only one of them is in this repo. The whole
       week is validated before anything is written — but the guarantee comes
       from `withTenant`, which wraps the call in a transaction, so a throw
       anywhere rolls the DELETE back with it. The next test drives that
       directly, because this one passes even with the validation moved after
       the delete, and a test that cannot tell those apart is not testing the
       mechanism it names.
    */
    const good = [day(1, "08:00", "17:00"), day(2, "08:00", "17:00"), day(3, "08:00", "17:00")];
    await inA((q) => wh.replaceWorkingHours(q, good));

    await expect(
      inA((q) =>
        wh.replaceWorkingHours(q, [
          day(1, "07:00", "16:00"),
          day(2, "18:00", "09:00"), // the bad one, in the middle
          day(3, "07:00", "16:00"),
        ])
      )
    ).rejects.toThrow();

    const after = await inA((q) => wh.listWorkingHours(q));
    expect(after.map((d) => d.weekday), "a rejected week still changed the stored one").toEqual([
      1, 2, 3,
    ]);
    expect(after.every((d) => d.opensMinute === 480), "a rejected week partly applied").toBe(true);
  });

  it("rolls the DELETE back when the write itself fails partway", async () => {
    /*
       The mechanism the test above relies on, driven directly: a failure AFTER
       the delete and between the inserts must leave the stored week exactly as
       it was. Validation cannot help here — the failure is not a bad value, it
       is the write dying halfway, which is what a dropped connection or a
       constraint nobody anticipated looks like.
    */
    const good = [day(1, "08:00", "17:00"), day(2, "08:00", "17:00")];
    await inA((q) => wh.replaceWorkingHours(q, good));

    await expect(
      inA(async (q) => {
        await q.rows(`DELETE FROM working_hours WHERE sub_account_id = $1`, [TENANT_A]);
        await q.rows(
          `INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
           VALUES ($1, 3, 540, 1080)`,
          [TENANT_A]
        );
        throw new Error("the write died halfway");
      })
    ).rejects.toThrow(/died halfway/);

    const after = await inA((q) => wh.listWorkingHours(q));
    expect(after.map((d) => d.weekday), "a half-finished save survived").toEqual([1, 2]);
    expect(after.every((d) => d.opensMinute === 480)).toBe(true);
  });

  it("returns the days in week order however they were given", async () => {
    const stored = await inA((q) =>
      wh.replaceWorkingHours(q, [day(5, "08:00", "16:00"), day(1, "08:00", "17:00"), day(3, "09:00", "15:00")])
    );
    expect(stored.map((d) => d.weekday)).toEqual([1, 3, 5]);
  });

  it("replaces rather than accumulating, however many times it is saved", async () => {
    for (let i = 0; i < 3; i++) {
      await inA((q) => wh.replaceWorkingHours(q, [day(1, "08:00", "17:00")]));
    }
    expect(await inA((q) => wh.listWorkingHours(q))).toHaveLength(1);
  });
});

describe("the suggestion is a suggestion", () => {
  it("is not stored, and nothing reads it to decide what is bookable", async () => {
    /* A form default the person confirms, not a fact the product asserts. If
       this ever leaked into storage, a workspace would be advertising hours
       nobody chose — the same class as a dashboard showing invented revenue. */
    expect(wh.SUGGESTED_WEEK.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5]);
    const week = await inA((q) => wh.listWorkingHours(q));
    expect(week, "the suggested week reached the database on its own").toEqual([]);
    expect(wh.hasWorkingHours(week)).toBe(false);
  });

  it("is itself a valid week, so accepting it cannot fail", () => {
    expect(wh.validateWeek(wh.SUGGESTED_WEEK)).toEqual([]);
  });
});

describe("one workspace's hours are not another's", () => {
  it("keeps them apart", async () => {
    await inA((q) => wh.replaceWorkingHours(q, [day(1, "08:00", "17:00")]));
    await inB((q) => wh.replaceWorkingHours(q, [day(6, "09:00", "13:00")]));

    expect((await inA((q) => wh.listWorkingHours(q))).map((d) => d.weekday)).toEqual([1]);
    expect((await inB((q) => wh.listWorkingHours(q))).map((d) => d.weekday)).toEqual([6]);
  });

  it("does not let one workspace's save wipe another's", async () => {
    /* The write starts with a DELETE. Scoped wrongly, that DELETE would empty
       the table for every customer on the platform — a whole-table wipe hiding
       inside a routine save. */
    await inB((q) => wh.replaceWorkingHours(q, [day(6, "09:00", "13:00")]));
    await inA((q) => wh.replaceWorkingHours(q, [day(1, "08:00", "17:00")]));

    const b = await inB((q) => wh.listWorkingHours(q));
    expect(b, "saving one workspace's hours deleted another's").toHaveLength(1);
  });
});

describe("the database refuses what the code refuses", () => {
  it("rejects an impossible day even when the check in front of it is bypassed", async () => {
    /* Validation in TypeScript protects the path through the repo. The
       constraint protects the table, which is what a future caller, a script or
       a migration will meet instead. */
    await expect(
      db.seed(
        `INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
         VALUES ('${TENANT_A}', 1, 1020, 480)`
      )
    ).rejects.toThrow();

    await expect(
      db.seed(
        `INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
         VALUES ('${TENANT_A}', 9, 480, 1020)`
      )
    ).rejects.toThrow();

    await expect(
      db.seed(
        `INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
         VALUES ('${TENANT_A}', 1, 480, 1441)`
      )
    ).rejects.toThrow();
  });

  it("allows one row per weekday and no more", async () => {
    await db.seed(
      `INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
       VALUES ('${TENANT_A}', 1, 480, 1020)`
    );
    await expect(
      db.seed(
        `INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
         VALUES ('${TENANT_A}', 1, 540, 1080)`
      )
    ).rejects.toThrow();
  });
});
