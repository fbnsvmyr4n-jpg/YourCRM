import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the Reports tiles CLAIM, checked against what they are made of.
 *
 * Every defect found in this page's audit was of one shape: a figure computed
 * correctly and then described wrongly, or described correctly and computed
 * wrongly. The arithmetic has its own tests against a real database; these are
 * about the sentences printed beside the numbers, which is where a reader
 * actually forms a belief.
 */

const strip = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const page = strip(
  readFileSync(fileURLToPath(new URL("../src/app/(app)/reports/page.tsx", import.meta.url)), "utf8")
);
const view = strip(
  readFileSync(fileURLToPath(new URL("../src/server/reports-view.ts", import.meta.url)), "utf8")
);

describe("a tile names the number it was actually divided by", () => {
  it("says how many deals the win rate is out of", () => {
    /* It said "of {won + open} deals". An open deal has not been decided and is
       no part of a win rate, so on four wins and three losses the tile read
       "57% of 8 deals" — 57% being 4/7. */
    expect(page).toMatch(/of \$\{r\.decidedCount\} decided deal/);
    expect(page).not.toMatch(/r\.wonCount \+ r\.openCount/);
  });

  it("does not claim the average covers deals it excludes", () => {
    /* `avgDealSize` is won revenue over won COUNT. "across every deal" implied
       open and lost deals were dragging it down; they were never in it. */
    expect(page).toMatch(/sub: "across won deals"/);
    expect(page).not.toMatch(/sub: "across every deal"/);
  });
});

describe("the conversion card shows its own working", () => {
  it("does not look up a label that does not exist", () => {
    /**
     * The worst find on the page: the sentence under "Reach Closed Won" looked
     * for a `leadStatus` entry labelled "Closed Won". The labels are "Clients",
     * "In progress" and "No open deal" — so the lookup never matched, the
     * fallback `?? 0` applied, and the line read "0 of N leads captured" on
     * every account that has ever loaded this page. Beside a conversion figure
     * of 67%, on the same card, contradicting it.
     */
    expect(page).not.toMatch(/leadStatus\.find\(\(s\) => s\.label === "Closed Won"\)/);
    expect(page).toMatch(/\{r\.clientsCount\} of \{r\.contactsTotal\}/);
    expect(view).toMatch(/contactsTotal: totalPeople,/);
    expect(view).toMatch(/clientsCount: r\.contacts\.clients,/);
  });

  it("counts the same units on both sides of the word 'of'", () => {
    /* It had DEALS on one side and people on the other — "0 of 11" where 11 was
       the deal count and the percentage beside it was 4/6 contacts. */
    expect(page).toMatch(/contacts have"\} bought\./);
  });

  it("calls the source breakdown what it counts", () => {
    /* Sources live on deals, and one person can bring several, so this card
       counted 11 while the Leads page counted 6 people — the same word meaning
       two things on two screens. */
    expect(page).toMatch(/\{totalLeads\} deals<\/span>/);
    expect(page).not.toMatch(/\{totalLeads\} leads<\/span>/);
  });
});

describe("no loss disappears from the breakdown", () => {
  it("folds an unrecognised reason into Other rather than dropping it", () => {
    /**
     * The breakdown mapped over the fixed `LOSS_REASONS` list and looked each
     * one up, so a reason not on the list vanished — while the meeting still
     * counted in `lost`, in `lossRate` and in the funnel. The panel then
     * claimed more losses than its own rows accounted for, with nothing on
     * screen to show the gap.
     */
    const meeting = strip(
      readFileSync(
        fileURLToPath(new URL("../src/server/meeting-analytics.ts", import.meta.url)),
        "utf8"
      )
    );
    expect(meeting).toMatch(/const known = new Set<string>\(LOSS_REASONS\);/);
    expect(meeting).toMatch(/if \(!known\.has\(reason\)\) unrecognised \+= count;/);
    expect(meeting).toMatch(/\(label === "Other" \? unrecognised : 0\)/);
  });
});
