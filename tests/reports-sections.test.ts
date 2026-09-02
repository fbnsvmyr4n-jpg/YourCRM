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
