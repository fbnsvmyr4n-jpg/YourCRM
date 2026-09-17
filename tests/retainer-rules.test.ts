import { describe, expect, it } from "vitest";
import {
  duePeriods,
  firstPeriodFrom,
  isIsoDay,
  MAX_CATCH_UP,
  monthlyCents,
  periodEnd,
  periodLabel,
  periodStart,
} from "../src/server/retainer-rules";

/** Billing periods on the calendar — where getting a day wrong bills somebody wrongly. */

describe("when each period starts", () => {
  it("steps a month, a quarter and a year from the start date", () => {
    expect(periodStart("2026-09-01", "month", 1)).toBe("2026-10-01");
    expect(periodStart("2026-09-01", "quarter", 1)).toBe("2026-12-01");
    expect(periodStart("2026-11-15", "quarter", 1)).toBe("2027-02-15");
    expect(periodStart("2026-09-01", "year", 2)).toBe("2028-09-01");
  });

  it("A 31ST START BILLS ON THE LAST DAY OF SHORT MONTHS — and goes back to the 31st", () => {
    expect(periodStart("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(periodStart("2026-01-31", "month", 2)).toBe("2026-03-31");
    expect(periodStart("2026-01-31", "month", 3)).toBe("2026-04-30");
    expect(periodStart("2027-12-31", "month", 2)).toBe("2028-02-29");
  });

  it("a 29 Feb yearly start lands on 28 Feb in ordinary years", () => {
    expect(periodStart("2028-02-29", "year", 1)).toBe("2029-02-28");
    expect(periodStart("2028-02-29", "year", 4)).toBe("2032-02-29");
  });

  it("a period ends the day before the next begins", () => {
    expect(periodEnd("2026-01-31", "month", 0)).toBe("2026-02-27");
    expect(periodEnd("2026-12-01", "month", 0)).toBe("2026-12-31");
    expect(periodLabel("2026-09-01", periodEnd("2026-09-01", "month", 0))).toBe("1–30 Sep 2026");
    expect(periodLabel("2026-09-01", periodEnd("2026-09-01", "quarter", 0))).toBe("1 Sep – 30 Nov 2026");
    expect(periodLabel("2026-12-15", periodEnd("2026-12-15", "year", 0))).toBe("15 Dec 2026 – 14 Dec 2027");
  });
});

describe("what is due", () => {
  const base = { startsOn: "2026-07-01", endsOn: null, every: "month" as const, status: "active" as const, periodsBilled: 0 };

  it("BILLS EVERY PERIOD THAT HAS STARTED, including today's, and nothing ahead", () => {
    expect(duePeriods(base, "2026-09-01")).toEqual({ periods: [0, 1, 2], periodsBilled: 3, nextInvoiceOn: "2026-10-01" });
    expect(duePeriods({ ...base, periodsBilled: 3 }, "2026-09-30")).toEqual({
      periods: [],
      periodsBilled: 3,
      nextInvoiceOn: "2026-10-01",
    });
  });

  it("nothing while paused or cancelled", () => {
    expect(duePeriods({ ...base, status: "paused" }, "2026-09-01").periods).toEqual([]);
    expect(duePeriods({ ...base, status: "cancelled" }, "2026-09-01").periods).toEqual([]);
  });

  it("stops at the end date — the period starting ON it is still billed", () => {
    expect(duePeriods({ ...base, endsOn: "2026-08-01" }, "2026-12-01").periods).toEqual([0, 1]);
    expect(duePeriods({ ...base, endsOn: "2026-07-31" }, "2026-12-01").periods).toEqual([0]);
  });

  it(`raises at most ${MAX_CATCH_UP} in one go`, () => {
    const out = duePeriods({ ...base, startsOn: "2020-01-01" }, "2026-09-01");
    expect(out.periods).toHaveLength(MAX_CATCH_UP);
    expect(out.nextInvoiceOn).toBe("2021-01-01");
  });
});

describe("resuming", () => {
  it("PICKS UP AT THE FIRST PERIOD ON OR AFTER TODAY — the paused months are not billed", () => {
    expect(firstPeriodFrom("2026-01-15", "month", "2026-06-10")).toBe(5);
    expect(periodStart("2026-01-15", "month", 5)).toBe("2026-06-15");
    expect(firstPeriodFrom("2026-01-15", "month", "2026-06-15")).toBe(5);
    expect(firstPeriodFrom("2026-01-15", "month", "2026-06-16")).toBe(6);
    expect(firstPeriodFrom("2026-01-31", "month", "2026-03-01")).toBe(2);
    expect(firstPeriodFrom("2026-09-01", "year", "2026-08-01")).toBe(0);
  });
});

describe("small things", () => {
  it("a monthly figure for any rhythm", () => {
    expect(monthlyCents(450_000, "month")).toBe(450_000);
    expect(monthlyCents(900_000, "quarter")).toBe(300_000);
    expect(monthlyCents(1_200_000, "year")).toBe(100_000);
  });

  it("recognises a real calendar day only", () => {
    expect(isIsoDay("2026-02-28")).toBe(true);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("26-2-1")).toBe(false);
  });
});
