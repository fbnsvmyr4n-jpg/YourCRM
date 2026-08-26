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
const topbar = readFileSync(
  fileURLToPath(new URL("../src/components/shell/Topbar.tsx", import.meta.url)),
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
    expect(page).toMatch(/flex max-w-\[1500px\] animate-fade-up flex-col gap-5 sm:block/);
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

  it("spaces the reordered items from the container, not from the items", () => {
    /**
     * Every gap on this page used to be a margin on the item BELOW it, which
     * is only correct while the document order holds. Reversing two items with
     * `order` leaves the margin on whichever item still declares it, not on
     * the boundary it was meant to fill.
     *
     * Measured at 375px: the leads list ended at y=1721 and Lead's Feed began
     * at y=1721. Two bordered cards butted flush read as one overlapping the
     * other, which is exactly how it was reported.
     *
     * `gap-5` belongs to the container, so it fills the boundary in either
     * order, and it is desktop-inert by construction — from `sm` the box is
     * `display:block`, where `gap` has no effect.
     */
    expect(page).toMatch(/flex max-w-\[1500px\] animate-fade-up flex-col gap-5 sm:block/);

    /* The two margins that used to supply that spacing must not also apply
       below `sm`, or the boundary is paid for twice. */
    expect(page).toMatch(/pb-0 pt-1 sm:pb-5/);
    expect(cards).toMatch(/"mt-0 sm:mt-5"/);
  });

  it("colours the filter strip at rest, not only when selected", () => {
    /**
     * The desktop cards carry their status hue all the time — a soft gradient
     * wash and the count in the status colour. The strip painted only the
     * SELECTED cell, so with "All" chosen (the default, and the one status
     * with no colour of its own) every cell rendered grey and the colour
     * language the rest of the page speaks vanished on a phone.
     */
    expect(cards).toMatch(/background: active \? soft : `linear-gradient\(135deg, \$\{soft\}, transparent 90%\)`/);

    /* The count takes its hue unconditionally. `color: active ? color : undefined`
       was the bug. */
    expect(cards).toMatch(/leading-none" style=\{\{ color \}\}/);

    /* Selection can no longer be carried by colour-vs-no-colour, so it is
       carried by the flat wash and an underline. */
    expect(cards).toMatch(/absolute inset-x-2 bottom-0 h-0\.5/);
  });

  it("centres the account button once its label is hidden", () => {
    /* `pl-1 pr-2.5` balances the name and chevron that follow the avatar. Below
       `sm` both are `hidden`, so that padding put the avatar 3px left of the
       button's own centre and made the button 46px beside a 40px bell. */
    expect(topbar).toMatch(/h-10 w-10 items-center justify-center gap-2\.5 rounded-full p-0 sm:h-auto sm:w-auto sm:justify-start sm:py-1 sm:pl-1 sm:pr-2\.5/);

    /* A 36px avatar cannot centre inside a 40px button with a border. */
    expect(topbar).toMatch(/h-8 w-8 place-items-center rounded-full[^"]*sm:h-9 sm:w-9/);
  });

  it("collapses the whole list so the analytics are reachable", () => {
    /**
     * Compressing each card was not enough on its own. Fifteen leads is still
     * about 1,450px, so Lead's Feed sat at y=1742 and Lead Sources at y=2208 —
     * 2.2 and 2.7 screens down. Reaching either meant scrolling past the whole
     * list every time, and the list is the thing the reader had already seen.
     *
     * Collapsed: feed at y=398, sources at y=864, page 2,457px -> 1,113px.
     * Both are on the first screen.
     */
    expect(cards).toMatch(/const \[listOpen, setListOpen\] = useState\(true\)/);
    expect(cards).toMatch(/aria-controls="leads-list"/);
    expect(cards).toMatch(/aria-expanded=\{listOpen\}/);

    /* Open by default. The leads ARE the page; the collapse is an escape
       hatch, not the resting state. */
    expect(cards).not.toMatch(/useState\(false\)[^\n]*listOpen/);
  });

  it("cannot hide the list on a desktop, whatever the state holds", () => {
    /* `sm:grid` is unconditional, so from `sm` up the layout does not consult
       `listOpen` at all — verified in the browser by forcing the state closed
       at 1280px and finding the list still `display: grid`. The control itself
       is `sm:hidden`, so a desktop reader never sees it either. */
    expect(cards).toMatch(/"grid-cols-1 gap-4 sm:grid @min-\[560px\]:grid-cols-2 @min-\[900px\]:grid-cols-3",\s*\n\s*listOpen \? "grid" : "hidden"/);
    expect(cards).toMatch(/rounded-xl sm:hidden"\n\s*>/);
  });

  it("says what it hid, and offers its own way back", () => {
    /* A collapsed list must not read as an empty one. The strip reports the
       count and is itself the control that restores them, so the reader is
       never left hunting for the button they pressed. */
    expect(cards).toMatch(/leads"\} hidden — tap to show/);
    expect(cards).toMatch(/\{!listOpen && visible\.length > 0 && \(/);
    expect(cards).toMatch(/onClick=\{\(\) => setListOpen\(true\)\}/);
  });

  it("both filter controls drive the same state", () => {
    /* Two renderings of one filter. If they ever diverged, the strip would
       report a selection the list did not honour. */
    const setFilterCalls = (cards.match(/setFilter\(st\)/g) ?? []).length;
    expect(setFilterCalls).toBeGreaterThanOrEqual(2);
  });
});
