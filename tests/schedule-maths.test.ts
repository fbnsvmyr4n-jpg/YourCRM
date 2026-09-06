import { describe, expect, it } from "vitest";
import {
  addWorkingDays,
  earliestStart,
  finishAfter,
  isWeekend,
  nextWorkingDay,
  workingDaysBetween,
} from "../src/server/schedule";

/**
 * The arithmetic every cascaded date rests on.
 *
 * If this is wrong, every date below a moved task is wrong with it — silently,
 * and plausibly enough that nobody checks. So the cases here are the ones a
 * calendar-day implementation gets wrong: Friday to Monday, a span containing a
 * weekend, and a task waiting on two other tasks.
 *
 * The anchor dates are real. In 2026, 18 September is a Friday and 21 September
 * is a Monday — which is the step Bradley's own baseline schedule takes, and
 * the reason working days are counted at all.
 */

describe("which days are working days", () => {
  it("knows a weekend when it sees one", () => {
    expect(isWeekend("2026-09-19")).toBe(true); // Saturday
    expect(isWeekend("2026-09-20")).toBe(true); // Sunday
    expect(isWeekend("2026-09-18")).toBe(false); // Friday
    expect(isWeekend("2026-09-21")).toBe(false); // Monday
  });

  it("moves a weekend date forward to the Monday", () => {
    expect(nextWorkingDay("2026-09-19")).toBe("2026-09-21");
    expect(nextWorkingDay("2026-09-20")).toBe("2026-09-21");
  });

  it("leaves a working day where it is", () => {
    expect(nextWorkingDay("2026-09-18")).toBe("2026-09-18");
  });
});

describe("adding working days", () => {
  it("steps Friday to Monday rather than into the weekend", () => {
    // The exact step in the source schedule, and the one a calendar-day
    // implementation gets wrong by landing on the Saturday.
    expect(addWorkingDays("2026-09-18", 1)).toBe("2026-09-21");
  });

  it("adds a plain day inside the week", () => {
    expect(addWorkingDays("2026-09-21", 1)).toBe("2026-09-22");
  });

  it("skips the weekend when counting across it", () => {
    // Wednesday + 4 working days = the following Tuesday, not the Sunday.
    expect(addWorkingDays("2026-09-16", 4)).toBe("2026-09-22");
  });

  it("lands on a working day even when adding nothing", () => {
    /* Adding zero to a Saturday is not a no-op: every caller is asking where
       work happens from here, and the answer is never the weekend. */
    expect(addWorkingDays("2026-09-19", 0)).toBe("2026-09-21");
  });
});

describe("how long a task takes", () => {
  it("counts a same-day task as one day", () => {
    expect(workingDaysBetween("2026-09-21", "2026-09-21")).toBe(1);
  });

  it("counts inclusively", () => {
    expect(workingDaysBetween("2026-09-21", "2026-09-23")).toBe(3);
  });

  it("does not count the weekend as work", () => {
    // Friday to Monday is two days of work, not four days of calendar.
    expect(workingDaysBetween("2026-09-18", "2026-09-21")).toBe(2);
  });

  it("never reports a task as taking no time", () => {
    /* A span entirely inside a weekend has no working days in it, and a task of
       zero length collapses to a point on the chart. */
    expect(workingDaysBetween("2026-09-19", "2026-09-20")).toBe(1);
  });

  it("survives a backwards range rather than returning nonsense", () => {
    expect(workingDaysBetween("2026-09-23", "2026-09-21")).toBe(1);
  });
});

describe("finishing after a duration", () => {
  it("is the same day for a one-day task", () => {
    expect(finishAfter("2026-09-21", 1)).toBe("2026-09-21");
  });

  it("carries a duration across a weekend", () => {
    // Two working days from Friday finishes on the Monday.
    expect(finishAfter("2026-09-18", 2)).toBe("2026-09-21");
  });

  it("round-trips with the duration it was measured from", () => {
    /* The property the cascade depends on: move a task, keep its length. */
    for (const [start, due] of [
      ["2026-09-18", "2026-09-21"],
      ["2026-08-24", "2026-08-25"],
      ["2026-09-01", "2026-09-30"],
    ]) {
      const days = workingDaysBetween(start, due);
      expect(finishAfter(start, days)).toBe(due);
    }
  });
});

describe("where a dependent task starts", () => {
  it("is the working day after its predecessor finishes", () => {
    expect(earliestStart([{ dueOn: "2026-09-21", lagDays: 0 }])).toBe("2026-09-22");
  });

  it("steps over a weekend when the predecessor ends on a Friday", () => {
    expect(earliestStart([{ dueOn: "2026-09-18", lagDays: 0 }])).toBe("2026-09-21");
  });

  it("honours a lag, in working days", () => {
    // Finishes Monday, waits two working days, starts Thursday.
    expect(earliestStart([{ dueOn: "2026-09-21", lagDays: 2 }])).toBe("2026-09-24");
  });

  it("waits for the LATEST of several predecessors, not the first", () => {
    /* A task waiting on two things waits for both. Taking the earliest would
       start work before something it depends on had finished — the whole
       failure this feature exists to prevent. */
    expect(
      earliestStart([
        { dueOn: "2026-09-21", lagDays: 0 },
        { dueOn: "2026-09-30", lagDays: 0 },
        { dueOn: "2026-09-10", lagDays: 0 },
      ])
    ).toBe("2026-10-01");
  });

  it("counts lag when deciding which predecessor is latest", () => {
    /* The earlier finish plus a long wait beats the later finish with none.
       Monday 21 September plus eleven working days (one to start, ten of lag)
       is Tuesday 6 October — checked against a calendar, because the first
       expectation written here was an off-by-one I had counted by eye. */
    expect(
      earliestStart([
        { dueOn: "2026-09-21", lagDays: 10 },
        { dueOn: "2026-09-25", lagDays: 0 },
      ])
    ).toBe("2026-10-06");
  });

  it("says nothing when nothing it waits on has a date", () => {
    /* An unknown predecessor cannot imply a date, and inventing one puts a
       confident bar on the chart with nothing behind it. */
    expect(earliestStart([{ dueOn: null, lagDays: 0 }])).toBeNull();
    expect(earliestStart([])).toBeNull();
  });

  it("ignores the undated predecessors and uses the ones it has", () => {
    expect(
      earliestStart([
        { dueOn: null, lagDays: 0 },
        { dueOn: "2026-09-21", lagDays: 0 },
      ])
    ).toBe("2026-09-22");
  });
});
