import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * On a phone, the leads come before the analytics about them.
 *
 * Measured on a 393 x 852 screen: the Sales Target panel alone was 1,101px —
 * taller than the phone — and three analytics cards stacked above the list, so
 * the first lead began at y=1305. A page called "Sales Target & Leads" showed
 * no leads at all until you had scrolled past a chart.
 *
 * Collapsing the target moved it to y=898. Still below the fold, because the
 * other two cards remained: no amount of shrinking gets a lead onto the first
 * screen. Reordering did — y=184.
 */

const page = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/leads/page.tsx", import.meta.url)),
  "utf8"
);
const detail = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/leads/SalesTargetDetail.tsx", import.meta.url)),
  "utf8"
);
const cards = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/leads/LeadCardsSection.tsx", import.meta.url)),
  "utf8"
);

describe("the leads page on a phone", () => {
  it("puts the list above the analytics, and only on a phone", () => {
    /* `flex flex-col sm:block` is the mechanism: below `sm` the order classes
       apply, from `sm` it is a plain block where `order` means nothing and the
       designed order returns. */
    expect(page).toMatch(/flex max-w-\[1500px\] animate-fade-up flex-col sm:block/);
    expect(page).toMatch(/order-2 sm:order-none/);
    expect(page).toMatch(/order-3 grid grid-cols-1 gap-5 sm:order-none/);
  });

  it("collapses the Sales Target panel without a media query", () => {
    /**
     * `hidden sm:block` means closed on a phone and open on a desktop FROM THE
     * FIRST PAINT — server and client agree, so there is no hydration flash,
     * and a desktop reader never depends on JavaScript to see a panel that was
     * always visible there. State only ever opens it on a phone.
     */
    expect(detail).toMatch(/open \? "block" : "hidden"/);
    expect(detail).toMatch(/sm:block/);
    expect(detail).not.toMatch(/matchMedia|ResizeObserver/);
  });

  it("keeps the collapsed panel reachable and labelled", () => {
    expect(detail).toMatch(/aria-expanded=\{open\}/);
    expect(detail).toMatch(/sm:hidden/);
  });

  it("shows the filters as a segmented strip on a phone", () => {
    /**
     * Stacking the cards was the first attempt and it was not enough: four of
     * them still cost about 410px before a single lead appeared, and "Follow-up
     * Required" still wrapped onto two lines at 393px.
     *
     * They are filters. Their whole job is to be tapped and to carry a count,
     * and neither needs a 200px card. The strip costs about 80px and is
     * modelled on the Lead Sources panel further down the same page, which
     * already shows TOTAL / NEW / OPEN / WON as one compact row.
     */
    expect(cards).toMatch(/grid grid-cols-4 overflow-hidden rounded-2xl[^"]*sm:hidden/);
    expect(cards).toMatch(/st === "Follow-up Required" \? "Follow-up"/);
  });

  it("keeps the desktop cards, hidden only below sm", () => {
    /* The card grid is untouched from `sm` up — same two-then-four columns it
       always had. Only its visibility is conditional. */
    expect(cards).toMatch(/mb-5 hidden grid-cols-2 gap-4 sm:grid @min-\[880px\]:grid-cols-4/);
  });

  it("both filter controls drive the same state", () => {
    /* Two renderings of one filter. If they ever diverged, the strip would
       report a selection the list did not honour. */
    const setFilterCalls = (cards.match(/setFilter\(st\)/g) ?? []).length;
    expect(setFilterCalls).toBeGreaterThanOrEqual(2);
  });
});
