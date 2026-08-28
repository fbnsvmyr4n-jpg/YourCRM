import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dashboard on a phone.
 *
 * It renders ten cards. On a desktop they sit in two columns and read as a
 * dashboard; collapsed to one column they became ten full-width cards stacked
 * end to end, every one expanded, all competing for the same attention.
 *
 * And the ORDER was wrong, because it was written for two columns. Everything
 * in the right rail landed after everything in the main column, so Today's
 * Focus — the most actionable card on the page, top-right on a desktop —
 * arrived sixth on a phone, below three reports about the past.
 *
 * Verified against the compiled stylesheet with the real wrapper classes:
 *
 *   375px   both wrappers `display: contents`, eight siblings at 359px each,
 *           order datetime, hero, focus, quick, revenue, thisweek,
 *           reminders, activity
 *   1280px  wrappers back to `flex`; main column x=8 w=898 and rail x=926
 *           w=346, which is the layout that was already there
 */

const page = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/page.tsx", import.meta.url)),
  "utf8"
);
const section = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/MobileSection.tsx", import.meta.url)),
  "utf8"
);

describe("the dashboard on a phone", () => {
  it("dissolves the two columns so every card can be ordered", () => {
    /* `order` only sorts siblings. While the rail was a single wrapper, no
       amount of ordering could lift one of its cards above a main-column card
       — the whole rail moved or none of it did. `contents` removes the
       wrappers from the box tree below the breakpoint and puts all ten cards
       in one flex column; from `@min-[820px]` they come back. */
    expect(page).toMatch(/@container contents @min-\[820px\]:flex @min-\[820px\]:flex-col/);
    expect(page).toMatch(/<div className="contents @min-\[820px\]:flex @min-\[820px\]:flex-col @min-\[820px\]:gap-5">/);
    expect(page).toMatch(/flex flex-col gap-5 @min-\[820px\]:grid @min-\[820px\]:grid-cols-\[minmax\(0,1fr\)_346px\]/);
  });

  it("puts what to do next above what already happened", () => {
    /**
     * Today's Focus and Quick Actions are the two cards that say what to DO.
     * Revenue, This Week, Reminders and Activity all report on what has
     * already happened. On a phone the actions now come third and fourth,
     * directly under the greeting, instead of sixth and seventh.
     */
    const orderOf = (component: string) => {
      const at = page.indexOf(`<${component}`);
      const before = page.slice(0, at);
      const m = [...before.matchAll(/order-(\d) @min-\[820px\]:order-none/g)];
      return m.length ? Number(m[m.length - 1][1]) : null;
    };
    expect(orderOf("TodaysFocus")).toBe(3);
    expect(orderOf("QuickActions")).toBe(4);
    /* And the reports sit below them. */
    expect(orderOf("MobileSection")).toBe(5);
  });

  it("every ordering is undone above the breakpoint", () => {
    /* A stray `order-N` without its `@min-[820px]:order-none` would reorder a
       desktop column too, which is the one thing this must not touch. */
    const orders = page.match(/order-\d(?![\d])/g) ?? [];
    const undone = page.match(/@min-\[820px\]:order-none/g) ?? [];
    expect(orders.length).toBeGreaterThanOrEqual(8);
    expect(undone.length).toBe(orders.length);
  });

  it("folds the reports away, and only on a phone", () => {
    /* The control is `sm:hidden` and the body `sm:contents`, so from `sm` up
       the wrapper contributes no box at all and the desktop grid sees exactly
       the children it saw before. */
    expect(section).toMatch(/className="btn-soft focus-ring flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left sm:hidden"/);
    expect(section).toMatch(/clsx\("sm:contents", open \? "block" : "hidden"\)/);
    expect(section).toMatch(/<section className="flex flex-col gap-3 sm:contents">/);
  });

  it("says what is inside without being opened", () => {
    /* A row of closed headings that only say "Revenue" is a worse page than
       the cluttered one — the reader has to open each to find out whether it
       matters. Every fold carries a figure. */
    expect(section).toMatch(/hint\?: string;/);
    expect(page).toMatch(/hint=\{`\$\$\{revenueTotal\.toLocaleString\(\)\} won · last 6 weeks`\}/);
    expect(page).toMatch(/hint=\{`\$\{wonThisWeek\.length\} won · \$\{followUps\.length\} to follow up`\}/);
    expect(page).toMatch(/hint=\{`\$\{activity\.length\} recent`\}/);
  });

  it("does not fold a card that is already short", () => {
    /* A fold has to earn its tap. Reminders is a short list with its own
       heading, so collapsing it hid nothing and added a step — three folds on
       this page, not four. Reported as tedious, and this was part of why. */
    expect(page).not.toMatch(/<MobileSection title="Reminders"/);
    expect(page).toMatch(/<Reminders items=\{upcoming\} \/>/);
  });

  it("shows the same numbers once, not twice", () => {
    /**
     * Three of the hero's four stat tiles read the SAME variables Today's
     * Focus reads a card below — `openLeadCount`, `meetingsToday.length` and
     * `unread`. On a desktop the two sit in different columns and the
     * repetition is a glance apart; stacked on a phone they are the same four
     * numbers one after the other.
     *
     * Today's Focus is the copy worth keeping: every row carries a line of
     * context and links somewhere, where a tile is a bare number. It also
     * retires the fourth tile, "Contacts" — a raw row count that only ever
     * goes up — in favour of deals closed, the money won and active clients.
     */
    expect(page).toMatch(/mt-5 hidden grid-cols-2 gap-3 sm:grid @min-\[520px\]:grid-cols-4/);
    /* And the duplicate route to the same screen goes with it: Quick Actions,
       four cards down this same page, already has Schedule Meeting. */
    expect(page).toMatch(/btn-accent focus-ring hidden items-center gap-2 rounded-xl px-4 py-2\.5 text-sm font-semibold sm:flex/);
  });

  it("remembers whether a section was left open", () => {
    /**
     * The fold was reported as tedious, and re-opening the same card every
     * morning is why. `useSyncExternalStore` rather than an effect writing
     * state: stored preferences are an external mutable source, the server
     * snapshot is the default so there is no hydration mismatch, and setting
     * state inside an effect is what the React compiler rejects.
     */
    expect(section).toMatch(/useSyncExternalStore\(\s*subscribe,/);
    expect(section).toMatch(/\(\) => defaultOpen\s*\)/);
    expect(section).toMatch(/const key = `dash-open:\$\{id\}`/);
  });

  it("never lets a blocked storage break the page", () => {
    /* Private windows, cleared site data and browsers set to block site data
       all THROW on access rather than returning null. Losing the memory is a
       small thing; losing the dashboard is not. */
    const guards = section.match(/try \{/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    expect(section).toMatch(/catch \{\s*return fallback;/);
  });

  it("leaves the essentials open", () => {
    /* The time, the greeting, the focus and the actions are not folded. A
       dashboard that opens with nothing on it is not calmer, it is empty. */
    for (const essential of ["DateTimeBar", "Hero", "TodaysFocus", "QuickActions"]) {
      const at = page.indexOf(`<${essential}`);
      /* Inside a fold means the nearest OPEN tag before it comes after the
         nearest CLOSE tag. Both absent (-1) means it precedes every fold,
         which is also outside — the first version of this compared -1 with -1
         and failed on the very card it was meant to pass. */
      const opened = page.lastIndexOf("<MobileSection", at);
      const closedAt = page.lastIndexOf("</MobileSection>", at);
      expect(opened > closedAt, `${essential} is inside a fold`).toBe(false);
    }
  });
});
