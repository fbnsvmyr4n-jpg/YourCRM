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
    /* Matched on the word rather than the element, so restyling the header
       does not break a test about what the number MEANS. It was pinned to
       `</span>` and duly failed the moment the chip arrived. */
    expect(page).toMatch(/value=\{totalLeads\}>deals</);
    expect(page).not.toMatch(/>leads</);
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
  it("moves the stage badge off the title's line on a phone", () => {
    /* Two renderings of the same badge, one per breakpoint, so the phone gets
       the whole row for words and the desktop row is untouched. The phone one
       is hidden by its PARENT line rather than by itself — see below. */
    expect(page).toMatch(/text-xs text-faint sm:hidden">\s*\n\s*<span/);
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
    /* Nothing renders it unconditionally any more — it appears only inside the
       guard below, so a deal with nobody linked simply shows no name. */
    expect(page).not.toMatch(/\{d\.contact \?\? "—"\}/);
  });

  it("gives the long string the full-width line", () => {
    /**
     * The row is avatar | two lines | value, and on a phone the text column is
     * about 190px. It led with the CONTACT and put the deal title on the second
     * line beside the stage badge — so a first name like "Jenny" had a whole
     * line to itself while the title shared ~95px with the badge and truncated
     * to "J…". One letter and an ellipsis is not a label.
     *
     * Titles are long and names are short, so they swapped. It also matches
     * what the panel is about: these are the largest DEALS.
     */
    expect(page).toMatch(/<p className="truncate text-sm font-medium">\{d\.title\}<\/p>/);
  });

  it("puts nothing but the stage on the second line", () => {
    /**
     * The contact's name sat here beside the badge and was redundant more often
     * than not — a deal called "Jenny — enquiry" printed "Jenny" again directly
     * underneath itself — while being the thing competing for the little width
     * this line has. The avatar already carries who it is.
     *
     * With the name gone the line holds only the phone badge, so the LINE is
     * what hides from `sm` up. Hiding the badge alone would leave an empty
     * paragraph still spending its `mt-0.5` on every desktop row.
     */
    expect(page).not.toMatch(/\{d\.contact && <span/);
    expect(page).toMatch(/mt-0\.5 flex items-center gap-1\.5 overflow-hidden text-xs text-faint sm:hidden/);
    /* `d.contact` survives in exactly one place: the avatar. */
    expect(page.match(/d\.contact/g) ?? []).toHaveLength(1);
  });

  it("stops the figure reserving width the title needs", () => {
    /* A fixed 80px column for "$300", which needs about 34, came straight out
       of the title beside it. Rows end flush right either way, so only the
       numbers' left edges go ragged — and only on a phone. */
    expect(page).toMatch(/shrink-0 text-right text-sm font-semibold tabular-nums sm:w-20/);
    expect(page).not.toMatch(/className="w-20 shrink-0 text-right/);
  });

  it("keeps the wrapper that lets the title truncate", () => {
    /**
     * The title is a block `<p className="truncate">` inside `min-w-0 flex-1`.
     * The `min-w-0` is what carries it: a flex item's `min-width` defaults to
     * `auto`, which for the nowrap text `truncate` produces resolves to the
     * width of the whole string — so without it the column refuses to shrink,
     * the ellipsis never engages, and the title runs on out of the row.
     *
     * This was learned the expensive way on the line below, where a span had
     * `truncate` and no `min-w-0` and spilled letters past the badge.
     */
    /* Anchored to THIS row, not just to the file. Two lists here share that
       wrapper class, so a bare match would have passed while the deals row lost
       it — a mutation removing it hit exactly that ambiguity and could not be
       applied uniquely, which is the tell. */
    expect(page).toMatch(
      /<div className="min-w-0 flex-1 leading-tight">\s*\n\s*<p className="truncate text-sm font-medium">\{d\.title\}<\/p>/
    );
  });

  it("builds the avatar from whatever the row is about", () => {
    /* It took initials from `d.contact`, which for an unlinked deal was the
       dash — so the avatar read "—" too. The person when there is one, the
       deal's own name when there is not. */
    expect(page).toMatch(/\(d\.contact \?\? d\.title\)\s*\n?\s*\.split/);
  });
});

describe("a fact in a card header looks placed, not left over", () => {
  /**
   * Reported with the "6 deals" beside "Where leads come from" circled: it
   * looked like an afterthought sitting at the edge.
   *
   * It was a bare `<span className="text-xs text-faint">` dropped into the
   * action slot. Unbounded text with no ground under it reads as something left
   * there rather than put there — and at 393px it wrapped, breaking "6 deals"
   * across two lines beside a title that was also wrapping, because neither
   * side of the header would give way.
   */
  const card = strip(
    readFileSync(fileURLToPath(new URL("../src/components/ui/Card.tsx", import.meta.url)), "utf8")
  );

  it("gives header facts a chip of their own", () => {
    expect(card).toMatch(/export function CardMeta/);
    expect(card).toMatch(/shrink-0 whitespace-nowrap rounded-full border border-\[var\(--border-strong\)\]/);
  });

  it("gives the chip an edge rather than relying on its fill", () => {
    /**
     * The first version sat on `--raise`, which in the night theme is 2% alpha
     * — a shape with no presence, still scrolled straight past. A
     * `--border-strong` edge (13-16%) is what makes it read as a discrete
     * object instead of a slightly lighter smudge.
     */
    expect(card).toMatch(/border border-\[var\(--border-strong\)\]/);
  });

  it("puts the weight on the number, not the chip", () => {
    /* The figure is the thing worth noticing. Full text colour and semibold
       against a muted unit lands the eye on "6" rather than on "deals" —
       presence from contrast, not from shouting. */
    expect(card).toMatch(
      /<span className="mr-1 font-semibold tabular-nums text-\[var\(--text\)\]">\{value\}<\/span>/
    );
    expect(card).toMatch(/value \?\?= undefined|value !== undefined/);
  });

  it("does not use the accent, which would read as clickable", () => {
    /* `ViewAll` beside it is accent text. A chip in the same colour would look
       like a control; presence here comes from contrast and an edge, not hue. */
    const meta = card.slice(
      card.indexOf("export function CardMeta"),
      card.indexOf('export function ViewAll')
    );
    expect(meta).not.toMatch(/text-accent|--accent/);
  });

  it("never lets the fact be the thing that wraps", () => {
    /* `shrink-0` and `whitespace-nowrap` together mean the TITLE gives way
       first. A two-word count breaking in half is never the right answer. */
    expect(card).toMatch(/shrink-0 whitespace-nowrap/);
    /* And the title side has to be shrinkable, or both get squeezed at once —
       which is what produced "6" over "deals". */
    expect(card).toMatch(/<div className="flex min-w-0 items-center gap-2\.5">/);
  });

  it("uses it everywhere a header states a fact", () => {
    /* Four of these existed, all the same bare span. Leaving any behind would
       be the same afterthought on another card. */
    expect(page).not.toMatch(/action=\{<span className="text-xs text-faint">/);
    expect(page).toMatch(/action=\{<CardMeta>Last 6 weeks<\/CardMeta>\}/);
    expect(page).toMatch(/action=\{<CardMeta value=\{totalLeads\}>deals<\/CardMeta>\}/);
    expect(page).toMatch(/action=\{<CardMeta value=\{r\.meetings\.total\}>booked<\/CardMeta>\}/);

    const target = strip(
      readFileSync(
        fileURLToPath(new URL("../src/app/(app)/reports/SalesTargetCard.tsx", import.meta.url)),
        "utf8"
      )
    );
    expect(target).toMatch(/action=\{<CardMeta>This month<\/CardMeta>\}/);
  });

  it("stays a label, not a control", () => {
    /* `ViewAll` is the affordance for anything clickable. A chip that looks
       like a button and does nothing is the worse mistake, and this card file
       already says so about `ViewAll`. */
    const meta = card.slice(card.indexOf("export function CardMeta"), card.indexOf("export function ViewAll"));
    expect(meta).not.toMatch(/onClick|href|<Link|<button/);
  });
});
