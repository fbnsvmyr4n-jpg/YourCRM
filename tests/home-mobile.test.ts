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
    expect(page).toMatch(/hint=\{`\$\{upcoming\.length\} upcoming`\}/);
    expect(page).toMatch(/hint=\{`\$\{activity\.length\} recent`\}/);
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
