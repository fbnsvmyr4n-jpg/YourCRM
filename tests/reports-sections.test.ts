import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The reports page, grouped by the page each number is about.
 *
 * Eleven cards in one order nobody could state — revenue, leads, voice, lead
 * status, meetings, deals again — so answering "how are my leads doing" meant
 * scrolling past everything else and recognising the right heading. On a phone
 * that is eleven full-width cards end to end.
 *
 * Now the areas carry the sidebar's own names, a tab row jumps to one, and each
 * area shows its headline figure without being opened.
 */

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const sections = src("../src/app/(app)/reports/ReportSections.tsx");
const page = src("../src/app/(app)/reports/page.tsx");
const periods = src("../src/app/(app)/reports/PeriodTabs.tsx");
/* Comments here quote the layout they replaced, so absence checks must run
   against the code rather than the prose about it. */
const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("the areas a report is divided into", () => {
  it("names them the way the sidebar names them", () => {
    /* A reader looking for lead numbers should not have to learn a second
       vocabulary for the same pages. */
    for (const label of ['label: "Deals"', 'label: "Leads"', 'label: "Meetings"', 'label: "Voice"']) {
      expect(pageCode).toContain(label);
    }
  });

  it("offers no tab that opens onto nothing", () => {
    /* Companies only exists when there are companies or referrers to show —
       verified on an account with neither, where the tab is absent rather than
       present and empty. */
    expect(pageCode).toMatch(/accounts\.length > 0 \|\| referrers\.length > 0/);
    expect(pageCode).toMatch(/id: "companies"/);
  });

  it("shows each area's headline figure without opening it", () => {
    /**
     * The point of the grouping: "$314,400 won · $351,600 open" answers the
     * question most readers came with, and the fold is only for the detail
     * behind it. Verified rendering on a phone as exactly that.
     */
    expect(pageCode).toMatch(/hint: `\$\{money\(r\.revenueWon\)\} won · \$\{money\(r\.openPipeline\)\} open`/);
    expect(pageCode).toMatch(/hint: `\$\{rate\(r\.leadConversion\)\} converted`/);
    expect(pageCode).toMatch(/hint: `\$\{r\.meetings\.total\} booked · \$\{rate\(r\.meetings\.showRate\)\} show rate`/);
    /* The guard as well as the value: `{section.hint}` alone still matches
       when the branch around it has been switched off. */
    expect(sections).toMatch(/\{section\.hint && \(/);
    expect(sections).toMatch(/\{section\.hint\}/);
  });

  it("keeps the target above the tabs, outside every area", () => {
    /* Revenue Won answers "how much"; the target answers "is that enough", and
       the second question is the reason anybody opens a reports page. It
       belongs to no single area. */
    const target = pageCode.indexOf("<SalesTargetCard");
    const tabs = pageCode.indexOf("<ReportSections");
    expect(target).toBeGreaterThanOrEqual(0);
    expect(tabs).toBeGreaterThan(target);
    /* And actually rendered — order alone still passes with the wrapper hidden,
       which would leave the one figure that matters most off the page. */
    expect(pageCode).toMatch(/<div className="mt-5">\s*\n\s*<SalesTargetCard/);
  });
});

describe("switching between them", () => {
  it("filters an already-rendered report rather than fetching another", () => {
    /**
     * Every section is server-rendered with the chosen period's data already in
     * it and hidden with CSS, so a tab is instant and changes no numbers. Going
     * back to the server per tab would make the fastest question on the page
     * the slowest.
     */
    expect(sections).toMatch(/const \[tab, setTab\] = useState<string>\("all"\)/);
    expect(sections).not.toMatch(/router\.|useSearchParams|fetch\(/);
  });

  it("drops the fold when a single area is showing", () => {
    /* Under its own tab there is nothing to choose between, so a control that
       hides the only thing on screen is friction with no purpose. */
    expect(sections).toMatch(/const showBody = folded \? expanded : open/);
    expect(sections).toMatch(/\{folded && \(/);
  });

  it("lays the tabs out rather than letting the width decide", () => {
    /**
     * The same failure the meetings filter row had: tabs of different
     * word-lengths under `flex-wrap` fitted on one machine and broke into three
     * ragged lines on a phone. Equal columns break the same way everywhere.
     */
    expect(sections).toMatch(/grid grid-cols-3 gap-1\.5 @min-\[560px\]:grid-cols-6/);
  });
});

describe("a phone folds, a desktop does not", () => {
  it("hides the fold control where the whole report fits", () => {
    /* Above 880px there is room for all of it, and hiding it behind four taps
       would be tidiness at the reader's expense. Verified at 1440px: nine cards
       open, no fold buttons. */
    expect(sections).toMatch(/transition-colors @min-\[880px\]:hidden/);
  });

  it("opens the body on a desktop even when the fold reads as closed", () => {
    /* The closed state is the phone's answer to eleven stacked cards. */
    expect(sections).toMatch(
      /clsx\("hidden", folded && "@min-\[880px\]:flex @min-\[880px\]:flex-col @min-\[880px\]:gap-5"\)/
    );
  });

  it("labels each area on a desktop, since the fold header is gone there", () => {
    /* Otherwise the grouping would exist in the markup and nowhere on screen.
       Verified at 1440px: DEALS, LEADS, MEETINGS, VOICE all rendered. */
    expect(sections).toMatch(/hidden items-center gap-2 text-\[11px\] font-semibold uppercase[^"]*@min-\[880px\]:flex/);
  });

  it("drops the fold's own frame and tint where there is no fold", () => {
    /* A border round an open body would be a second frame drawn around cards
       that already have one. */
    expect(sections).toMatch(/rounded-2xl border border-\[var\(--border\)\] @min-\[880px\]:border-0/);
    expect(sections).toMatch(/folded && showBody && "p-3 @min-\[880px\]:p-0"/);
  });
});

describe("choosing a period", () => {
  it("shows the choice before the server has answered", () => {
    /**
     * These were plain links. Every tap was a full navigation, and this page is
     * `force-dynamic` with six queries behind it, so the whole report was
     * rebuilt before anything on screen acknowledged the tap — including the
     * highlight moving. On a phone that is a second or more of a button that
     * appears not to have worked, which is how it was reported.
     *
     * Measured after: pressed and busy both true within 50ms of the tap, where
     * before nothing changed until the render returned.
     */
    expect(periods).toMatch(/useOptimistic\(current\)/);
    expect(periods).toMatch(/startTransition\(\(\) => \{/);
    expect(periods).toMatch(/aria-busy=\{pending\}/);
    /* And no longer a Link, which is what made the wait unavoidable. */
    expect(periods).not.toMatch(/<Link/);
  });

  it("keeps the period in the URL", () => {
    /* A period worth looking at is worth sending to somebody — "look at July"
       should be a link, not a description of which buttons to press. Verified
       by loading ?period=this-month directly: the right tab is active. */
    expect(periods).toMatch(/router\.push\(id === "all-time" \? "\/reports" : `\/reports\?period=\$\{id\}`/);
  });

  it("does nothing when the period is already showing", () => {
    /* Otherwise tapping the active tab spends a full server render arriving at
       the page it is already on. */
    expect(periods).toMatch(/if \(id === shown\) return;/);
  });

  it("lays the periods out rather than letting the width decide", () => {
    /* Six labels of different lengths under `flex-wrap` put "All time" on a
       line of its own. Verified at 393px: a 3x2 grid, six equal cells, nothing
       clipped; at 1440px, one row. */
    expect(periods).toMatch(/grid grid-cols-3 gap-1\.5 @min-\[560px\]:grid-cols-6/);
  });
});

describe("the page gets to the numbers faster", () => {
  it("drops the standing subtitle", () => {
    /**
     * It explained that the figures come from real records — true of every page
     * here, and not worth three lines above the fold on a phone. It pushed the
     * period row and the headline numbers down for something nobody needed to
     * read twice.
     */
    expect(pageCode).not.toMatch(/counted from your own records/);
    expect(page).toMatch(/No standing subtitle/);
  });
});

describe("a way out of an open section", () => {
  it("puts a hide control at the end of it", () => {
    /**
     * An open area is several full-height cards on a phone, so closing it again
     * meant scrolling back past all of them to reach the header that opened it.
     * The reader is already at the end of the section — the control belongs
     * where they are. The same answer Contact Activity got.
     */
    expect(sections).toMatch(/Hide \{section\.label\.toLowerCase\(\)\}/);
    expect(sections).toMatch(/onClick=\{collapse\}/);
  });

  it("offers it only where there is a fold, and only while it is open", () => {
    /* On a desktop there is no fold to close, and a button offering to hide
       something that stays visible either way would be noise. Verified at
       1440px: no hide buttons, nine cards open. */
    expect(sections).toMatch(/\{folded && showBody && \(/);
    expect(sections).toMatch(/text-muted @min-\[880px\]:hidden/);
  });

  it("lands the reader back on the section they closed", () => {
    /**
     * The content above the button disappears as it collapses, so the scroll
     * position it leaves points at whatever moved up into that space. Measured
     * on the first version: the section's own header ended up 817px above the
     * viewport — the reader was dropped somewhere arbitrary, which is the
     * problem the button existed to solve.
     *
     * Focusing the header scrolls it back into view and puts keyboard focus
     * where it belongs. After: header at 512px, in view, focused.
     */
    expect(sections).toMatch(/const collapse = useCallback\(\(\) => \{\s*\n\s*setExpanded\(false\);\s*\n\s*headerRef\.current\?\.focus\(\);/);
    expect(sections).toMatch(/ref=\{headerRef\}/);
  });
});
