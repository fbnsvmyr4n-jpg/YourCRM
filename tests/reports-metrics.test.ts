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

describe("Largest deals gives the words somewhere to go", () => {
  /**
   * Reported from a phone as "strange lines out of place", with a screenshot of
   * two rows showing stray marks where a name should be.
   *
   * They were not marks. The row was avatar | name+title | stage badge | value
   * on one line, and the only flexible column was the one with the words in it.
   * The badge runs about 78px and the value is a fixed 80, so at 393px the text
   * column was crushed to roughly 30px — and `truncate` renders whatever fits,
   * which at that width is a SLIVER OF A GLYPH. The "lines" were the left-hand
   * strokes of clipped characters.
   */
  it("moves the stage badge off the name's line on a phone", () => {
    /* Two renderings of the same badge, one per breakpoint, so the phone gets
       the whole row for words and the desktop row is untouched. */
    expect(page).toMatch(/text-\[10px\] font-semibold sm:hidden/);
    expect(page).toMatch(/hidden shrink-0 rounded-lg px-2 py-0\.5 text-\[11px\] font-semibold sm:inline-block/);
  });

  it("does not print a dash where a person should be", () => {
    /**
     * A deal with nobody linked sent `"—"` as the contact NAME, so the row's
     * primary line was a dash — and once the column collapsed, a dash was
     * exactly one of the stray marks on screen. The server now sends null and
     * the row decides: the deal's own title leads instead.
     */
    expect(view).toMatch(/contact: d\.contact_name,/);
    expect(view).not.toMatch(/contact: d\.contact_name \?\? "—"/);
    expect(view).toMatch(/contact: string \| null;/);
    expect(page).toMatch(/\{d\.contact \?\? d\.title\}/);
  });

  it("does not repeat the title when it is already the heading", () => {
    /* With no contact the title is promoted to the first line, so printing it
       again underneath would be the same words twice. */
    expect(page).toMatch(/\{d\.contact && <span className="min-w-0 truncate">\{d\.title\}<\/span>\}/);
  });

  it("lets the title actually truncate inside the flex row", () => {
    /**
     * The second half of the reported problem, and a classic.
     *
     * `truncate` sets `white-space: nowrap`. A FLEX ITEM's `min-width` defaults
     * to `auto`, which for nowrap text resolves to the width of the whole
     * string — so the span refused to shrink, the ellipsis never engaged, and a
     * long title ran on out of its column past the badge. On a phone that reads
     * as letters appearing after "Closed Won" with nothing stopping them, which
     * is exactly how it was reported the second time.
     *
     * `min-w-0` is the fix; `overflow-hidden` on the line is the guard behind
     * it, so even a future child without `min-w-0` is clipped rather than
     * spilling into the figure.
     */
    expect(page).toMatch(/<span className="min-w-0 truncate">\{d\.title\}<\/span>/);
    expect(page).toMatch(/mt-0\.5 flex items-center gap-1\.5 overflow-hidden text-xs text-faint/);
    /* The bare version is what shipped and what broke. */
    expect(page).not.toMatch(/<span className="truncate">\{d\.title\}<\/span>/);
  });

  it("builds the avatar from whatever is actually shown", () => {
    /* It took initials from `d.contact`, which for an unlinked deal was the
       dash — so the avatar read "—" too. */
    expect(page).toMatch(/\(d\.contact \?\? d\.title\)\s*\n?\s*\.split/);
  });
});
