/*
   Two findings from driving every screen at 375px, and the rule they share.

   Bradley's standing instruction is that everything should fit comfortably on
   the screen and nobody should have to scroll to see information. Both of these
   broke it in the same way — furniture sized for a desktop taking the room the
   content needed — and both were fixed by MEASURING rather than by taste, which
   is how the deals board settled the same argument earlier.

   The sweep also cleared three screens I had expected to fix:
     - the Reports tiles share a row height already; the content is top-aligned,
       which is correct;
     - the deals summary row is a measured 1-2-1 with a comment explaining why
       three across fails at 375px;
     - the project detail, inbox, leads, quotes, notes and settings all fit.
   Those are recorded here so the next sweep does not re-open them.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

describe("the calendar month grid on a phone", () => {
  const view = read("src/app/(app)/calendar/CalendarView.tsx");

  it("shows dots instead of pills when the grid is too narrow for them", () => {
    /*
       Seven columns of a 375px screen is 45px a day, and a meeting pill carries
       an icon, a name and a time. Every one rendered as a character or two
       stacked vertically — an unreadable label rather than a short one.
    */
    expect(view).toMatch(/const dotsOnly = width > 0 && width < 560;/);
    expect(view).toMatch(/\{dotsOnly \? \(/);
  });

  it("measures the GRID, not the window", () => {
    /* It is the width this grid actually has that decides whether a pill fits.
       The same decision the inbox makes about stacking. */
    expect(view).toMatch(/const width = useElementWidth\(gridRef\)/);
    expect(view).toMatch(/<div ref=\{gridRef\} className="grid flex-1 grid-cols-7/);
  });

  it("shows pills until it has measured, so a desktop never flashes dots", () => {
    /* `width` is 0 before the first measurement. Pills are the richer view, so
       an unmeasured grid shows those. */
    expect(view).toMatch(/width > 0 &&/);
  });

  it("does not make a 6px dot its own touch target", () => {
    /* The cell behind them already opens the day. A dot you cannot land on,
       sitting over a control you can, is worse than no control. */
    expect(view).toMatch(/pointer-events-none relative flex flex-wrap gap-1/);
  });

  it("says how many it did not draw, rather than dropping them silently", () => {
    /* Four dots on a day with six is not true. */
    expect(view).toMatch(/dayMeetings\.slice\(0, 4\)/);
    expect(view).toMatch(/\+\{dayMeetings\.length - 4\}/);
  });

  it("gives a day less height when it only holds dots, so the month fits", () => {
    expect(view).toMatch(/dotsOnly \? "min-h-\[58px\]" : "min-h-\[112px\]"/);
  });
});

describe("the voice console's figures on a phone", () => {
  const view = read("src/app/(app)/voice-agents/VoiceAgentConsole.tsx");

  it("puts two on a row instead of one card each", () => {
    /* Each is a number and a word. One per row pushed the Call Log — what the
       page is for — most of a screen down. */
    expect(view).toMatch(/<div className="grid grid-cols-2 gap-4 @min-\[680px\]:grid-cols-\[/);
  });

  it("is two across and not three, on a measurement", () => {
    /* At 375px three columns leave about 47px of text beside a 44px icon, and
       "8m 35s" needs 70. Recorded because the next person to look at this will
       wonder why it is not three. */
    /* Matched across the line break the comment wraps on. */
    expect(view).toMatch(/about 47px of text beside a 44px icon/);
  });

  it("leaves the desktop row of four exactly as it was", () => {
    for (const span of ['className="col-span-2 flex items-center gap-4 @min-\\[680px\\]:col-span-1"', 'className="col-span-2 @min-\\[680px\\]:col-span-1"']) {
      expect(view, `a tile lost its desktop span: ${span}`).toMatch(new RegExp(span));
    }
  });
});
