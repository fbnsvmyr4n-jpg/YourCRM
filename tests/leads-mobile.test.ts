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
 *
 * The target then moved off this page entirely, to Reports. It is a headline
 * number, not a lead, and Reports had every other headline number but no
 * measure of whether they were good enough.
 */

const page = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/leads/page.tsx", import.meta.url)),
  "utf8"
);
const reports = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/reports/page.tsx", import.meta.url)),
  "utf8"
);
const targetCard = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/reports/SalesTargetCard.tsx", import.meta.url)),
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

  it("no longer carries the Sales Target card at all", () => {
    /* Not hidden, not collapsed — absent. If the card ever came back here it
       would silently re-add roughly 400px above the list on a phone, undoing
       the reason this page was reordered in the first place. */
    expect(page).not.toMatch(/SalesTargetCard/);
    expect(page).not.toMatch(/monthlyTargetCents/);

    /* And the title stopped promising something the page no longer shows. */
    expect(page).not.toMatch(/Sales Target &amp; Leads/);
  });

  it("hands the target to Reports, wired to real month-to-date revenue", () => {
    expect(reports).toMatch(/<SalesTargetCard/);
    expect(reports).toMatch(/monthlyTargetCents/);

    /* Month-to-date, NOT the selected reporting period. A target is always
       about this calendar month; if it followed the period control, "68% of
       target" would mean something different depending on a dropdown that has
       nothing to do with the target. */
    expect(reports).toMatch(/setUTCDate\(1\)/);
    expect(reports).toMatch(/reportData\(q\)/);
  });

  it("still refuses to divide by a target of zero", () => {
    /* Zero is the default on a new account. No target set is not 0% progress —
       it is no answer, so the card must receive null and say so. */
    expect(reports).toMatch(/monthlyTarget > 0 \?/);
    expect(reports).toMatch(/: null/);
    expect(targetCard).toMatch(/pct: number \| null/);
  });

  it("does not render the six-week chart twice on Reports", () => {
    /* On Leads this card carried the only chart on the page. Reports renders
       the same six-week revenue series, larger, immediately below it — so the
       chart came off the card in the move. */
    expect(targetCard).not.toMatch(/AreaChart/);
    expect(reports).toMatch(/<AreaChart data=\{r\.weekly\}/);
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
