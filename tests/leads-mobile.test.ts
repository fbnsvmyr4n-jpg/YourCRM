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

  it("stacks the filter cards so their labels fit", () => {
    /* Two per row at 393px leaves ~170px each, which cannot hold an icon, two
       lines of label and a 3xl number side by side: "Follow-up Required" broke
       onto three lines and the count jammed against it. */
    expect(cards).toMatch(/flex flex-col items-start gap-2 p-4 text-left/);
    expect(cards).toMatch(/sm:flex-row sm:items-center sm:justify-between/);
    expect(cards).toMatch(/text-2xl font-bold tabular-nums sm:text-3xl/);
  });
});
