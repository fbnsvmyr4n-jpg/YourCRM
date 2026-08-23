import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PERIODS,
  changeAgainst,
  isPeriod,
  resolvePeriod,
} from "../src/server/report-period";
import { TENANT_A, USER_A } from "./helpers/pg";

/**
 * The window a report covers.
 *
 * Every figure was all-time or a fixed last-six-weeks with no control, so "how
 * did July go?" could not be asked — nor "was that better than June?", which is
 * the question that follows and the only one that makes a number mean anything.
 *
 * Date code fails at boundaries and it fails quietly, so the boundaries are
 * what is tested: the first instant of a window, the last, and the same
 * question asked from three time zones.
 */

const AT = new Date("2026-07-15T10:00:00Z");

describe("a month means the business's month", () => {
  it("starts at midnight local, not midnight UTC", () => {
    /**
     * The defect this replaced, in another form: the migration stored booking
     * times that differed depending on which machine ran it. A report computed
     * in UTC for a business in Johannesburg puts the first two hours of every
     * 1st into the previous month.
     */
    const utc = resolvePeriod("this-month", "UTC", AT);
    expect(utc.from?.toISOString()).toBe("2026-07-01T00:00:00.000Z");

    const jhb = resolvePeriod("this-month", "Africa/Johannesburg", AT);
    expect(jhb.from?.toISOString(), "the month started at UTC midnight, not local").toBe(
      "2026-06-30T22:00:00.000Z"
    );

    const la = resolvePeriod("this-month", "America/Los_Angeles", AT);
    expect(la.from?.toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });

  it("ends where the next one begins, and not a moment later", () => {
    // Half-open. An inclusive upper bound counts a deal won at exactly
    // midnight on the 1st in BOTH months, and the two reports never reconcile.
    const july = resolvePeriod("this-month", "UTC", AT);
    const august = resolvePeriod("this-month", "UTC", new Date("2026-08-15T10:00:00Z"));
    expect(july.to?.toISOString()).toBe(august.from?.toISOString());
  });

  it("hands last month the window this month just left", () => {
    const now = resolvePeriod("this-month", "UTC", AT);
    const before = resolvePeriod("last-month", "UTC", AT);
    expect(before.to?.toISOString()).toBe(now.from?.toISOString());
    expect(before.from?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("crosses a year boundary without arithmetic on the month number", () => {
    // January's previous month is December of the year before. A naive `m - 1`
    // produces month 0 and a report for a month that does not exist.
    const jan = resolvePeriod("last-month", "UTC", new Date("2026-01-10T10:00:00Z"));
    expect(jan.from?.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(jan.to?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("knows which month it is where the business is, not where the server is", () => {
    /**
     * At 23:00 UTC on 31 July it is already 1 August in Johannesburg. Asking
     * UTC which month "now" falls in gives July, so a business there opening
     * their reports just after midnight would see last month's figures
     * labelled as this month's — and no indication anything was wrong.
     *
     * The mirror image in Los Angeles: at 02:00 UTC on 1 August it is still
     * 31 July there.
     */
    const lateJuly = new Date("2026-07-31T23:00:00Z");
    const jhb = resolvePeriod("this-month", "Africa/Johannesburg", lateJuly);
    expect(jhb.from?.toISOString(), "the server's date was used, not the business's").toBe(
      "2026-07-31T22:00:00.000Z"
    );

    const earlyAugust = new Date("2026-08-01T02:00:00Z");
    const la = resolvePeriod("this-month", "America/Los_Angeles", earlyAugust);
    expect(la.from?.toISOString(), "still July in Los Angeles").toBe("2026-07-01T07:00:00.000Z");
  });

  it("handles a daylight-saving change without dropping or repeating an hour", () => {
    /**
     * London moved its clocks on 29 March 2026. A month boundary computed from
     * a fixed offset is an hour out for half the year — and the half it is
     * wrong for is not obvious from looking at it.
     */
    const march = resolvePeriod("this-month", "Europe/London", new Date("2026-03-15T10:00:00Z"));
    expect(march.from?.toISOString(), "GMT: no offset in March").toBe("2026-03-01T00:00:00.000Z");

    const april = resolvePeriod("this-month", "Europe/London", new Date("2026-04-15T10:00:00Z"));
    expect(april.from?.toISOString(), "BST: an hour ahead in April").toBe(
      "2026-03-31T23:00:00.000Z"
    );
  });
});

describe("the other windows", () => {
  it("counts thirty whole days, not thirty times twenty-four hours", () => {
    // A window that starts mid-afternoon makes today's figures depend on what
    // time somebody opened the page.
    const p = resolvePeriod("last-30", "UTC", AT);
    expect(p.from?.toISOString()).toBe("2026-06-16T00:00:00.000Z");
    expect(p.to?.toISOString()).toBe("2026-07-16T00:00:00.000Z");
  });

  it("starts a quarter on its own first month", () => {
    for (const [month, start] of [
      ["2026-02-10", "2026-01-01"],
      ["2026-05-10", "2026-04-01"],
      ["2026-07-10", "2026-07-01"],
      ["2026-11-10", "2026-10-01"],
    ] as const) {
      const p = resolvePeriod("this-quarter", "UTC", new Date(`${month}T10:00:00Z`));
      expect(p.from?.toISOString()).toBe(`${start}T00:00:00.000Z`);
    }
  });

  it("compares a quarter against the one before, across a year", () => {
    const q1 = resolvePeriod("this-quarter", "UTC", new Date("2026-02-10T10:00:00Z"));
    expect(q1.previous?.from.toISOString()).toBe("2025-10-01T00:00:00.000Z");
  });

  it("bounds a year at both ends", () => {
    const p = resolvePeriod("this-year", "UTC", AT);
    expect(p.from?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(p.to?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("gives all time no bounds and nothing to compare", () => {
    /**
     * There is no previous all-time. Inventing one — the half before the
     * midpoint, say — would be a number nobody asked for that looks like one
     * they did.
     */
    const p = resolvePeriod("all-time", "UTC", AT);
    expect(p.from).toBeNull();
    expect(p.to).toBeNull();
    expect(p.previous).toBeNull();
    expect(p.previousLabel).toBeNull();
  });

  it("gives every period except all-time something to compare against", () => {
    for (const id of PERIODS) {
      const p = resolvePeriod(id, "UTC", AT);
      if (id === "all-time") continue;
      expect(p.previous, `${id} has nothing to compare against`).not.toBeNull();
      // The comparison window ends exactly where this one starts: adjacent,
      // never overlapping, so nothing is counted in both.
      expect(p.previous!.to.toISOString()).toBe(p.from!.toISOString());
    }
  });

  it("compares a rolling window against one exactly as long", () => {
    // "Last 30 days" is a fixed length, so its comparison has to be too — 30
    // days against 28 always flatters or damns depending which way round.
    const p = resolvePeriod("last-30", "UTC", AT);
    const span = p.to!.getTime() - p.from!.getTime();
    expect(p.previous!.to.getTime() - p.previous!.from.getTime()).toBe(span);
  });

  it("compares a calendar period against the equivalent calendar period", () => {
    /**
     * Calendar periods are NOT the same length as each other, and should not
     * be forced to be. Q3 2026 has 92 days and Q2 has 91; February is shorter
     * than every month around it. "This quarter versus last quarter" is what a
     * person means when they ask, and normalising the windows to equal spans
     * would answer a question nobody asked — comparing July against "the 31
     * days before July" rather than against June.
     *
     * What must hold is that the two are adjacent and do not overlap, which is
     * asserted for every period above.
     */
    const q = resolvePeriod("this-quarter", "UTC", AT);
    expect(q.previous!.from.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(q.previous!.to.toISOString()).toBe("2026-07-01T00:00:00.000Z");

    const feb = resolvePeriod("last-month", "UTC", new Date("2026-03-10T10:00:00Z"));
    const febDays = (feb.to!.getTime() - feb.from!.getTime()) / 86_400_000;
    expect(febDays, "February was stretched to match January").toBe(28);
  });
});

describe("what counts as a period", () => {
  it("accepts the ones that exist and refuses the rest", () => {
    // The id arrives in a URL, so it is checked rather than trusted.
    expect(isPeriod("last-month")).toBe(true);
    expect(isPeriod("last-week")).toBe(false);
    expect(isPeriod("")).toBe(false);
    expect(isPeriod("__proto__")).toBe(false);
  });
});

describe("saying how a figure changed", () => {
  it("reports a rise and a fall as percentages", () => {
    expect(changeAgainst(150, 100)).toBe(50);
    expect(changeAgainst(50, 100)).toBe(-50);
    expect(changeAgainst(100, 100)).toBe(0);
  });

  it("says nothing rather than infinity when there was nothing before", () => {
    /**
     * A first sale is not "+100%" and certainly not "+∞". Every honest way of
     * describing a rise from zero is a word, so the number is withheld and the
     * screen says it in words instead.
     */
    expect(changeAgainst(500, 0)).toBeNull();
    expect(changeAgainst(0, 0)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Against a real database                                            */
/* ------------------------------------------------------------------ */

let db: import("./helpers/pg").TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let reportView: typeof import("../src/server/reports-view").reportView;
let deals: typeof import("../src/server/repos/deals");
let closePool: typeof import("../src/server/db").closePool;

const ctx = {
  agencyId: "ag_test",
  subAccountId: TENANT_A,
  userId: USER_A,
  role: "owner" as const,
};

beforeAll(async () => {
  const helpers = await import("./helpers/pg");
  db = await helpers.startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ reportView } = await import("../src/server/reports-view"));
  ({ closePool } = await import("../src/server/db"));
  deals = await import("../src/server/repos/deals");
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM deals; DELETE FROM contacts;`));

/** A won deal, banked on a given day. */
async function wonOn(day: string, cents: number) {
  const id = `d_${day}_${cents}`;
  await db.seed(
    `INSERT INTO deals (id, sub_account_id, title, value_cents, stage, won_at)
     VALUES ('${id}', '${TENANT_A}', 'Deal', ${cents}, 'won', '${day}T12:00:00Z')`
  );
}

describe("the window actually filters the figures", () => {
  it("counts only what was won inside it", async () => {
    await wonOn("2026-06-20", 100000);
    await wonOn("2026-07-05", 500000);
    await wonOn("2026-07-25", 300000);

    const july = resolvePeriod("last-month", "UTC", new Date("2026-08-10T10:00:00Z"));
    const r = await withTenant(ctx, (q) => reportView(q, july));

    expect(r.revenueWon, "the window did not filter revenue").toBe(8000);
    expect(r.wonCount).toBe(2);
  });

  it("compares against the window before it", async () => {
    await wonOn("2026-06-20", 400000);
    await wonOn("2026-07-05", 600000);

    const july = resolvePeriod("last-month", "UTC", new Date("2026-08-10T10:00:00Z"));
    const r = await withTenant(ctx, (q) => reportView(q, july));

    expect(r.period?.previousRevenue).toBe(4000);
    // 6000 against 4000 is a rise of half.
    expect(r.period?.revenueChange).toBe(50);
  });

  it("says nothing rather than infinity when the previous window was empty", async () => {
    await wonOn("2026-07-05", 600000);
    const july = resolvePeriod("last-month", "UTC", new Date("2026-08-10T10:00:00Z"));
    const r = await withTenant(ctx, (q) => reportView(q, july));

    expect(r.revenueWon).toBe(6000);
    expect(r.period?.revenueChange, "a first month reported as a percentage rise").toBeNull();
  });

  it("does not filter the open pipeline, which is a fact about now", async () => {
    /**
     * There is no such thing as "the open pipeline of July" — those deals have
     * since closed or are still open today. Filtering it by a date would
     * produce something that looks like a figure and is not one.
     */
    const contacts = await import("../src/server/repos/contacts");
    const person = await withTenant(ctx, (q) =>
      contacts.createContact(q, {
        firstName: "Ana", lastName: "S", email: null, phone: null, info: null,
      })
    );
    await withTenant(ctx, (q) =>
      deals.createDeal(q, { contactId: person.id, title: "Live", valueCents: 900000, stage: "demo" })
    );
    await wonOn("2026-07-05", 100000);

    const july = resolvePeriod("last-month", "UTC", new Date("2026-08-10T10:00:00Z"));
    const r = await withTenant(ctx, (q) => reportView(q, july));

    expect(r.revenueWon, "the window did not apply to revenue").toBe(1000);
    expect(r.openPipeline, "the window was wrongly applied to open pipeline").toBe(9000);
  });

  it("counts everything when the window is all time", async () => {
    await wonOn("2020-01-01", 100000);
    await wonOn("2026-07-05", 500000);

    const all = resolvePeriod("all-time", "UTC", new Date("2026-08-10T10:00:00Z"));
    const r = await withTenant(ctx, (q) => reportView(q, all));

    expect(r.revenueWon).toBe(6000);
    expect(r.period?.previousLabel, "all time invented something to compare against").toBeNull();
  });

  it("puts a deal won at the first instant of a month in that month only", async () => {
    /**
     * The half-open boundary, against a real database. An inclusive upper
     * bound counts this deal in June AND July, and the two reports never
     * reconcile.
     */
    await db.seed(
      `INSERT INTO deals (id, sub_account_id, title, value_cents, stage, won_at)
       VALUES ('d_edge', '${TENANT_A}', 'Midnight', 200000, 'won', '2026-07-01T00:00:00.000Z')`
    );

    const june = resolvePeriod("last-month", "UTC", new Date("2026-07-10T10:00:00Z"));
    const july = resolvePeriod("last-month", "UTC", new Date("2026-08-10T10:00:00Z"));

    const inJune = await withTenant(ctx, (q) => reportView(q, june));
    const inJuly = await withTenant(ctx, (q) => reportView(q, july));

    expect(inJune.revenueWon, "a deal at midnight on the 1st counted in the month before").toBe(0);
    expect(inJuly.revenueWon).toBe(2000);
  });
});
