import { describe, expect, it } from "vitest";
import { easterSunday, southAfricanHolidays } from "../src/server/holidays";

/**
 * The dates a schedule will move work around.
 *
 * Every expected value here was checked against a calendar before it was
 * written, because a wrong holiday is worse than no holiday: it moves somebody's
 * work for a reason they cannot see, and the schedule looks perfectly confident
 * while doing it.
 */

describe("Easter", () => {
  it("lands where the calendar says, across several years", () => {
    /* Two of the holidays hang off this and neither can be a fixed date.
       Checked against a calendar for each year rather than derived from the
       same algorithm that is under test. */
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2028)).toBe("2028-04-16");
  });

  it("is always a Sunday", () => {
    /* A property rather than a value: whatever year it is asked for, the answer
       has to be a Sunday, which catches an off-by-one the fixed cases above
       might happen not to cover. */
    for (let year = 2020; year <= 2040; year++) {
      const day = new Date(`${easterSunday(year)}T00:00:00Z`).getUTCDay();
      expect(day, `Easter ${year} is not a Sunday`).toBe(0);
    }
  });
});

describe("South Africa's public holidays", () => {
  const of = (year: number) => new Map(southAfricanHolidays(year).map((h) => [h.onDate, h.name]));

  it("puts Good Friday and Family Day either side of Easter", () => {
    const dates = of(2026);
    expect(dates.get("2026-04-03")).toBe("Good Friday");
    expect(dates.get("2026-04-06")).toBe("Family Day");
  });

  it("carries the fixed dates", () => {
    const dates = of(2026);
    expect(dates.get("2026-01-01")).toBe("New Year's Day");
    expect(dates.get("2026-03-21")).toBe("Human Rights Day");
    expect(dates.get("2026-04-27")).toBe("Freedom Day");
    expect(dates.get("2026-05-01")).toBe("Workers' Day");
    expect(dates.get("2026-06-16")).toBe("Youth Day");
    expect(dates.get("2026-09-24")).toBe("Heritage Day");
    expect(dates.get("2026-12-16")).toBe("Day of Reconciliation");
    expect(dates.get("2026-12-25")).toBe("Christmas Day");
    expect(dates.get("2026-12-26")).toBe("Day of Goodwill");
  });

  it("moves a Sunday holiday to the Monday", () => {
    /* The Public Holidays Act's rule, and 2026 exercises it: National Women's
       Day falls on Sunday 9 August. */
    const dates = of(2026);
    expect(dates.get("2026-08-09")).toBe("National Women's Day");
    expect(dates.get("2026-08-10")).toBe("National Women's Day (observed)");
  });

  it("does NOT move a Saturday holiday", () => {
    /* Easy to assume the other way, and assuming it hands somebody a day off
       that does not exist. Human Rights Day is Saturday 21 March 2026. */
    const dates = of(2026);
    expect(dates.get("2026-03-21")).toBe("Human Rights Day");
    expect(dates.has("2026-03-23")).toBe(false);
  });

  it("never returns two entries for one day", () => {
    for (let year = 2024; year <= 2030; year++) {
      const list = southAfricanHolidays(year);
      const unique = new Set(list.map((h) => h.onDate));
      expect(unique.size, `${year} has two holidays on one date`).toBe(list.length);
    }
  });

  it("comes back in date order", () => {
    const list = southAfricanHolidays(2026).map((h) => h.onDate);
    expect([...list].sort()).toEqual(list);
  });

  it("gives twelve holidays, plus one for each that fell on a Sunday", () => {
    // 2026: twelve, with Women's Day on a Sunday, so thirteen.
    expect(southAfricanHolidays(2026)).toHaveLength(13);
    // 2025: 27 April (Freedom Day) is a Sunday, so thirteen as well.
    expect(southAfricanHolidays(2025)).toHaveLength(13);
  });
});
