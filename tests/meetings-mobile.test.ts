import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The meetings page on a phone.
 *
 * Booking a meeting is why anyone opens this page, and it was the fourth thing
 * on it. Above it sat three analytics cards, one of which — "Meetings" — counted
 * the same meetings Workload & Capacity is about, and two of which are reporting
 * that Reports already carries. Measured at 393x850 before: "Schedule a Meeting"
 * was well past the first screen, under cards a person booking a meeting has no
 * use for.
 *
 * The desktop keeps all four cards exactly where they were.
 */

const view = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/meetings/MeetingsView.tsx", import.meta.url)),
  "utf8"
);
/* The comments here quote the classes they replaced, so absence checks must run
   against the code rather than the prose about it. */
const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("booking comes first on a phone", () => {
  it("puts the scheduler above the dashboard, and nowhere else", () => {
    /* `order-first` only where the page is one column. On the desktop the rail
       is the right-hand column and must stay there. */
    expect(code).toMatch(/className="order-first @min-\[820px\]:order-none"/);
  });

  it("lets the dashboard cards leave their box so they can be ordered", () => {
    /**
     * The four cards live in a wrapper that is the left column on a wide
     * screen. `display: contents` below that makes them direct children of the
     * page grid, which is what lets the scheduler be ordered above them without
     * moving anything on the desktop.
     */
    expect(code).toMatch(/className="contents @min-\[820px\]:flex @min-\[820px\]:flex-col @min-\[820px\]:gap-5"/);
  });

  it("measures every threshold against the page, not the left column", () => {
    /**
     * The wrapper must NOT declare its own container. When it did, these rows
     * measured themselves against the left COLUMN — 774px at a 1440px window,
     * under the 820 threshold — so all three cards vanished on the desktop
     * while the page around them was plainly wide enough. Caught by measuring
     * the rendered page rather than trusting the classes read correctly.
     *
     * 976 and 916 are the original 620 and 560 column thresholds expressed
     * against the page, so the desktop splits into two columns at exactly the
     * widths it always did.
     */
    expect(code).not.toMatch(/container-type:inline-size/);
    expect(code).toMatch(/@min-\[976px\]:grid-cols-\[minmax\(0,0\.82fr\)_minmax\(0,1\.18fr\)\]/);
  });

  it("takes the three cards off the phone and leaves them on the desktop", () => {
    /* Verified in the browser: hidden at 393px, and at 1440px all four render
       in their original two rows with the rail beside them. */
    expect(code).toMatch(/className="hidden gap-5 @min-\[820px\]:grid/);
    expect(code).toMatch(/<div className="hidden @min-\[820px\]:block">\s*\n\s*<LossInsights/);
  });

  it("keeps the online / in-person split, in the card that carried it away", () => {
    /**
     * It came from the "Meetings" card, which was counting the same meetings
     * Workload & Capacity is about. That card stayed on the meetings page and
     * this one moved to Reports, so the split travelled with it and is no
     * longer a duplicate of anything — which is why it no longer hides itself
     * at any width.
     */
    const shared = readFileSync(
      fileURLToPath(new URL("../src/components/meetings/WorkloadCapacity.tsx", import.meta.url)),
      "utf8"
    );
    expect(shared).toMatch(/className="mb-4 grid grid-cols-2 gap-3"/);
    expect(shared).toMatch(/analytics\.byType\.online/);
    expect(shared).toMatch(/analytics\.byType\.inPerson/);
  });
});

describe("the calendar has room for its own numbers", () => {
  it("gives the days horizontal space, not just vertical", () => {
    /**
     * Measured at 393px before: each day cell was 23.9px with a 0px gap — every
     * number flush against the next, which reads as overlapping even where the
     * boxes only touch. After: 36px cells with an even ~7.5px between them.
     */
    expect(code).toMatch(/grid grid-cols-7 gap-x-1 gap-y-1 text-center text-\[11px\]/);
    expect(code).toMatch(/mt-1 grid grid-cols-7 gap-x-1 gap-y-1/);
    expect(code).not.toMatch(/grid-cols-7 gap-y-1 text-center text-\[11px\]/);
  });

  it("stops the time column squeezing the calendar when there is no room", () => {
    /* Side by side at 393px the calendar got 169px for seven columns. Stacked
       it gets 321px, which is a day cell you can actually hit. */
    expect(code).toMatch(/grid grid-cols-1 gap-3 @min-\[420px\]:grid-cols-\[minmax\(0,1fr\)_140px\]/);
    expect(code).toMatch(/<Card className="@container !p-4">/);
  });

  it("centres the month between the arrows instead of against them", () => {
    /**
     * `justify-between` had it mathematically centred and still touching both
     * buttons — measured 0px of clearance either side, because "September 2026"
     * filled every pixel it was given. A three-track grid centres the label in
     * what is left, and the padding keeps it off the arrows however long the
     * month is. After: 66.6px of clearance on each side, symmetric.
     */
    expect(code).toMatch(/mb-2 grid grid-cols-\[28px_minmax\(0,1fr\)_28px\] items-center/);
    expect(code).toMatch(/className="truncate px-2 text-center text-sm font-medium"/);
    expect(code).not.toMatch(/mb-2 flex items-center justify-between/);
  });
});

describe("workload moves to reports", () => {
  const reports = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/reports/page.tsx", import.meta.url)),
    "utf8"
  );
  const shared = readFileSync(
    fileURLToPath(new URL("../src/components/meetings/WorkloadCapacity.tsx", import.meta.url)),
    "utf8"
  );

  it("renders on reports and nowhere on meetings", () => {
    /* Moved, not copied. Two of these would be the same numbers in two places,
       and they would drift the moment either changed. */
    expect(reports).toMatch(/<WorkloadCapacity\n/);
    expect(code).not.toMatch(/<WorkloadCapacity/);
  });

  it("is a component both pages can use", () => {
    /* No hooks and no state, so a server-rendered Reports page can render it
       directly rather than pulling the whole meetings view across. */
    expect(shared).toMatch(/export function WorkloadCapacity/);
    expect(shared).not.toMatch(/useState|useEffect|useMemo/);
    expect(shared).not.toMatch(/"use client"/);
  });

  it("gets the same inputs it always had", () => {
    expect(reports).toMatch(/analytics=\{meetingStats\}/);
    expect(reports).toMatch(/capacity=\{weeklyCapacity\}/);
    expect(reports).toMatch(/meetings=\{meetings\}/);
    /* "Today" in the business's zone, as the meetings page does it — otherwise
       an evening booking reads as tomorrow's to anyone east of the server. */
    expect(reports).toMatch(/instantToWallClock\(new Date\(\)\.toISOString\(\), settings\.timeZone\)/);
  });

  it("stops the meetings page asking for a capacity it no longer shows", () => {
    expect(code).not.toMatch(/capacity/);
  });
});

describe("upcoming meetings on a phone", () => {
  it("stops forcing a seven-column table through a 353px card", () => {
    /**
     * The table needs 680px and scrolled sideways inside the card, so the
     * reader saw Time and half a contact name and had to discover a horizontal
     * gesture to reach the rest. Below 680px each meeting is a card carrying
     * the same facts stacked. Verified at 393px: table hidden, three cards at
     * 311px, nothing past the right edge, no page scroll.
     */
    expect(code).toMatch(/hidden @min-\[680px\]:-m-1 @min-\[680px\]:block/);
    expect(code).toMatch(/flex flex-col gap-2\.5 @min-\[680px\]:hidden/);
    expect(code).toMatch(/function MeetingCard\(/);
  });

  it("leads with rescheduling, because that is what happens to a meeting", () => {
    /* Someone cannot make it and the time moves. A pencil icon says "edit" and
       hides the thing this list is actually for. */
    expect(code).toMatch(/<Pencil className="h-3\.5 w-3\.5" \/> Reschedule/);
  });

  it("only offers Join when a link was really saved", () => {
    /* Otherwise it looks actionable and does nothing — the same rule the table
       already applied to the contact name. */
    expect(code).toMatch(/\{m\.link && \(/);
  });

  it("keeps the time from being the part that truncates", () => {
    expect(code).toMatch(/shrink-0 whitespace-nowrap text-xs font-medium tabular-nums/);
  });

  it("lets the filters wrap instead of running off the card", () => {
    /* Packed onto one row at 393px the tabs, sort and "View Calendar" overflowed
       — the last control read "View Cale". */
    expect(code).toMatch(/mb-4 flex flex-col gap-3 @min-\[680px\]:flex-row/);
    expect(code).toMatch(/<Card className="@container">/);
    expect(code).not.toMatch(/mb-4 flex flex-wrap items-center justify-between gap-3/);
  });
});
