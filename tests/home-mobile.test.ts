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
const toggleHook = readFileSync(
  fileURLToPath(new URL("../src/lib/remembered-toggle.ts", import.meta.url)),
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
    /* Undone at whichever breakpoint that ordering belongs to — the page
       ordering is unwound at `@min-[820px]`, the ordering inside the revenue
       grid at `sm`. The first version of this counted only the first kind and
       failed the moment a second breakpoint was used, which is the test being
       narrow rather than the code being wrong. */
    const orders = page.match(/order-\d(?![\d])/g) ?? [];
    const undone = page.match(/(?:sm|@min-\[820px\]):order-none/g) ?? [];
    expect(orders.length).toBeGreaterThanOrEqual(8);
    expect(undone.length).toBe(orders.length);
  });

  it("folds the reports away, and only on a phone", () => {
    /* The control is `sm:hidden` and the body `sm:contents`, so from `sm` up
       the wrapper contributes no box at all and the desktop grid sees exactly
       the children it saw before. */
    /* The header is `sm:hidden` and the body `sm:contents`, so from `sm` up the
       wrapper contributes no box at all. Anchored on the tokens that carry
       that, not on the whole class string — the styling around them changed
       when the folds were given the Leads colour language, and a test that
       pins the paint breaks on every visual change while proving nothing about
       the behaviour. */
    expect(section).toMatch(/text-left transition-colors sm:hidden/);
    expect(section).toMatch(/clsx\("sm:contents", open \? "flex flex-col gap-4 p-3" : "hidden"\)/);
    expect(section).toMatch(/"flex flex-col sm:contents"/);
  });

  it("says what is inside without being opened", () => {
    /* A row of closed headings that only say "Revenue" is a worse page than
       the cluttered one — the reader has to open each to find out whether it
       matters. Every fold carries a figure. */
    expect(section).toMatch(/hint\?: string;/);
    expect(page).toMatch(/hint=\{`\$\$\{revenueTotal\.toLocaleString\(\)\} won · last 6 weeks`\}/);
    expect(page).toMatch(/hint=\{`\$\{activity\.length\} recent`\}/);
  });

  it("keeps one Revenue fold, holding This Week and what was received", () => {
    /**
     * The Revenue Overview chart is gone from the phone, and the This Week
     * fold with it. The chart's headline — total won over six weeks — is the
     * exact figure the fold's own header carries, so on a phone the card
     * restated the line the reader had just tapped and then spent 500px
     * drawing it. The number survives as the hint.
     *
     * Two folds now, not three: Revenue and Activity.
     */
    expect(page).not.toMatch(/<MobileSection\s+title="This week"/);
    const folds = page.match(/<MobileSection/g) ?? [];
    expect(folds).toHaveLength(2);
    expect(page).toMatch(/<div className="hidden sm:block">\s*<RevenueOverview/);
  });

  it("merges the two desktop rows into one grid, so nothing renders twice", () => {
    /**
     * Ordering and hiding only work between siblings. While these four cards
     * sat in two separate grids, This Week could not be lifted next to Revenue
     * Received without rendering it into both layouts and hiding one.
     *
     * One grid of four in two columns produces the same pairs, gap and row
     * heights as two grids of two. Verified against the compiled stylesheet at
     * 1280px — every card lands on the same pixel:
     *
     *   overview (0,0,622,120)     received (642,0,622,120)
     *   thisweek (0,140,622,110)   connections (642,140,622,110)
     *
     * And at 375px: This Week, then Received; Overview and Follow-ups hidden.
     */
    const grids = page.match(/grid grid-cols-1 gap-5 @min-\[560px\]:grid-cols-2/g) ?? [];
    expect(grids).toHaveLength(1);
    expect(page).toMatch(/<div className="order-1 sm:order-none">\s*<ThisWeek/);
    expect(page).toMatch(/<div className="order-2 sm:order-none">\s*<RevenueReceived/);
  });

  it("does not repeat the follow-up count on a phone", () => {
    /* Today's Focus already carries "N leads need follow-up" with the same
       count and the same link to /leads, three cards above. On a desktop the
       two sit in different columns; stacked they would be the same row twice —
       the same reason the hero tiles are hidden. */
    expect(page).toMatch(/<div className="hidden sm:block">\s*<Connections/);
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
    /* The store moved into `useRememberedToggle` so the contacts page's own
       fold could share it rather than carry a second copy. The behaviour is
       asserted where it now lives; what stays MobileSection's business is the
       key it remembers under. */
    expect(section).toMatch(/useRememberedToggle\(key, defaultOpen\)/);
    expect(section).toMatch(/const key = `dash-open:\$\{id\}`/);
    expect(toggleHook).toMatch(/useSyncExternalStore\(\s*subscribe,/);
    expect(toggleHook).toMatch(/\(\) => defaultOpen\s*\)/);
  });

  it("never lets a blocked storage break the page", () => {
    /* Private windows, cleared site data and browsers set to block site data
       all THROW on access rather than returning null. Losing the memory is a
       small thing; losing the dashboard is not. */
    const guards = toggleHook.match(/try \{/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    expect(toggleHook).toMatch(/catch \{\s*return fallback;/);
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

describe("how a fold looks", () => {
  it("speaks the Leads page's colour language", () => {
    /**
     * The folds were plain grey pills on a page whose sibling screens are
     * colour-coded, so they read as a different product. Leads washes its
     * status cards with `linear-gradient(135deg, soft, transparent 90%)` over
     * a `{ color, soft }` tone and states the tone once more as a filled dot.
     * The same wash, the same palette, the same dot.
     */
    expect(section).toMatch(/linear-gradient\(135deg, \$\{tone\.soft\}, transparent 90%\)/);
    expect(section).toMatch(/style=\{\{ background: tone\.color \}\}/);

    /* And the tones come from the same variables Leads uses, not new ones. */
    expect(page).toMatch(/tone=\{\{ color: "var\(--green\)", soft: "var\(--green-soft\)" \}\}/);
    expect(page).toMatch(/tone=\{\{ color: "var\(--accent\)", soft: "var\(--accent-soft\)" \}\}/);
  });

  it("becomes one card when open, not a heading above a card", () => {
    /**
     * Closed it is its own rounded object. Open, the border and the radius
     * move to the section and the header gives up both, so the group is a
     * single rounded box with a titled top edge and the cards nested inside —
     * rather than a pill, a gap, and whatever card happened to follow it.
     */
    expect(section).toMatch(/open && "overflow-hidden rounded-2xl border border-\[var\(--border\)\]"/);
    expect(section).toMatch(/open\s*\?\s*"border-b border-\[var\(--border\)\]"\s*:\s*"rounded-2xl border border-\[var\(--border\)\]"/);

    /* Inset, so the cards read as contents rather than as siblings. */
    expect(section).toMatch(/open \? "flex flex-col gap-4 p-3" : "hidden"/);
  });

  it("keeps all of it off the desktop", () => {
    /* Every one of these is a phone treatment. `sm:contents` on both the
       section and the body means the desktop grid still sees exactly the
       children it saw before — no border, no padding, no wrapper box. */
    expect(section).toMatch(/"flex flex-col sm:contents"/);
    expect(section).toMatch(/clsx\("sm:contents", open \? "flex flex-col gap-4 p-3" : "hidden"\)/);
    expect(section).toMatch(/text-left transition-colors sm:hidden/);
  });
});
