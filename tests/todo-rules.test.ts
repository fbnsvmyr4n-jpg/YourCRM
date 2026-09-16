import { describe, expect, it } from "vitest";
import { addDays, bucketOf, daysBetween, dueLabel, isIsoDay, sortTodos } from "../src/server/todo-rules";

/** When a task is due, which group it belongs in, and how that is said. */

const TODAY = "2026-09-16"; // a Wednesday

describe("which group a task is in", () => {
  it.each([
    [{ dueOn: "2026-09-15", doneAt: null }, "overdue"],
    [{ dueOn: TODAY, doneAt: null }, "today"],
    [{ dueOn: "2026-09-17", doneAt: null }, "upcoming"],
    [{ dueOn: null, doneAt: null }, "undated"],
    [{ dueOn: "2026-09-01", doneAt: "2026-09-02T10:00:00.000Z" }, "done"],
  ] as const)("%j → %s", (todo, bucket) => {
    expect(bucketOf(todo, TODAY)).toBe(bucket);
  });

  it("COUNTS CALENDAR DAYS, not 24-hour periods, across a month and a year", () => {
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("how the due day is said", () => {
  it.each([
    ["2026-09-16", "Today"],
    ["2026-09-17", "Tomorrow"],
    ["2026-09-15", "Yesterday"],
    ["2026-09-02", "14 days overdue"],
    ["2026-09-20", "Sun"],
    ["2026-09-30", "Wed 30 Sep"],
    ["2027-01-05", "Tue 5 Jan 2027"],
  ])("%s reads %s", (dueOn, label) => {
    expect(dueLabel(dueOn, TODAY)).toBe(label);
  });

  it("says when there is no day at all", () => {
    expect(dueLabel(null, TODAY)).toBe("No due date");
  });
});

describe("the order to do them in", () => {
  it("LONGEST OVERDUE FIRST, then by day, undated after, finished last and newest first", () => {
    const t = (id: string, dueOn: string | null, doneAt: string | null = null, createdAt = "2026-09-01T00:00:00Z") => ({
      id, dueOn, doneAt, createdAt,
    });
    const sorted = sortTodos([
      t("done-old", "2026-09-01", "2026-09-10T00:00:00Z"),
      t("undated-late", null, null, "2026-09-05T00:00:00Z"),
      t("tomorrow", "2026-09-17"),
      t("done-new", null, "2026-09-15T00:00:00Z"),
      t("way-overdue", "2026-09-01"),
      t("undated-early", null, null, "2026-09-02T00:00:00Z"),
      t("today", TODAY),
    ]);
    expect(sorted.map((x) => x.id)).toEqual([
      "way-overdue", "today", "tomorrow", "undated-early", "undated-late", "done-new", "done-old",
    ]);
  });
});

describe("what counts as a day", () => {
  it("accepts real days only", () => {
    expect(isIsoDay("2028-02-29")).toBe(true);
    expect(isIsoDay("2027-02-29")).toBe(false);
    expect(isIsoDay("16/09/2026")).toBe(false);
    expect(isIsoDay(null)).toBe(false);
  });
});
