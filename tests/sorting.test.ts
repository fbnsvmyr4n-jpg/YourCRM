import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every list a person scrolls can be ordered.
 *
 * There were no sort controls anywhere — invisible at ten records and unusable
 * at five hundred, which is what a CSV import produces on day one.
 *
 * The control itself is one component. Four copies of the same menu would have
 * drifted: one would keep its dropdown open on Escape, another would forget to
 * mark the current option, and the difference would only ever be noticed by
 * whoever used the odd one out.
 */

const APP = join(__dirname, "..", "src", "app", "(app)");
const read = (p: string) => readFileSync(join(APP, p), "utf8");

/** Screens whose main content is a list somebody scrolls. */
const LISTS = [
  ["contacts/ContactsView.tsx", "contacts"],
  ["inbox/InboxView.tsx", "the inbox"],
  ["leads/LeadCardsSection.tsx", "leads"],
  ["meetings/MeetingsView.tsx", "meetings"],
] as const;

describe("every scrollable list can be sorted", () => {
  it.each(LISTS)("%s offers a sort control", (file, name) => {
    const src = read(file);
    expect(existsSync(join(APP, file)), `${file} is missing`).toBe(true);
    expect(src, `${name} has no sort control`).toMatch(/<SortMenu\b/);
    expect(src, `${name} does not import the shared control`).toMatch(
      /from "@\/components\/ui\/SortMenu"/
    );
  });

  it.each(LISTS)("%s uses the shared control, not its own menu", (file, name) => {
    /**
     * A second inline menu beside the shared one is how the drift starts. The
     * marker is a hand-rolled dropdown with its own open state for sorting.
     */
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(
      /const \[sortOpen/.test(src),
      `${name} has its own sort dropdown state — use the shared SortMenu`
    ).toBe(false);
  });

  it.each(LISTS)("%s applies the chosen order to what it renders", (file, name) => {
    // A control wired to state that nothing reads is worse than no control:
    // it responds, and the list does not move.
    const src = read(file);
    expect(src, `${name} never reads its sort state`).toMatch(/\bsort\b/);
    expect(src, `${name} does not re-sort when the order changes`).toMatch(
      /\[[^\]]*\bsort\b[^\]]*\]\s*\)/
    );
  });
});

describe("the calendar is deliberately not sortable", () => {
  it("orders by date and time, because that is what a calendar is", () => {
    /**
     * Not an omission. A calendar places meetings on a grid by date and sorts
     * within a day by time — the position IS the order. A "sort by name"
     * control there would be a control that does nothing sensible, which is
     * worse than none.
     */
    const src = read("calendar/CalendarView.tsx");
    expect(src, "the calendar grew a sort control").not.toMatch(/<SortMenu\b/);
    expect(src, "the calendar no longer orders a day by time").toMatch(/minutesOfDay/);
  });
});

describe("the shared control behaves", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "src", "components", "ui", "SortMenu.tsx"),
    "utf8"
  );

  it("closes on Escape, not only on a click elsewhere", () => {
    // A menu dismissable only by clicking outside is one a keyboard user
    // cannot close at all.
    expect(SRC).toMatch(/e\.key === "Escape"/);
  });

  it("marks which option is current", () => {
    // Without it the menu says what is possible and never what is chosen.
    expect(SRC).toMatch(/aria-checked=\{value === o\.id\}/);
    expect(SRC).toMatch(/role="menuitemradio"/);
  });

  it("lights the button only when the order is not the default", () => {
    // So the control says at a glance whether the list is in an unusual order.
    expect(SRC).toMatch(/const active = value !== defaultId/);
  });

  it("removes its listeners when it closes", () => {
    // Four lists mounting a document listener each and never removing it is a
    // leak that grows with every navigation.
    expect(SRC).toMatch(/removeEventListener\("mousedown"/);
    expect(SRC).toMatch(/removeEventListener\("keydown"/);
  });
});
