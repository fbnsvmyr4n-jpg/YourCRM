import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Deals board on a phone.
 *
 * Measured at 375 x 812 before any of this: the page ran to 3,428px — 4.2
 * screens for fifteen deals — every money figure on it was truncated, and the
 * only control for deleting a deal could not be reached at all.
 */

const board = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/deals/DealsBoard.tsx", import.meta.url)),
  "utf8"
);

describe("the deals board on a phone", () => {
  it("gives the money figures the width they need", () => {
    /**
     * As a row at 375px the KPI card is 155px wide. Padding takes 32, the icon
     * and its gap take 56, leaving 67px of text column for a figure needing
     * 94 — so "$286,200" rendered as "$286,..." on the card whose entire job
     * is to show it. A truncated currency figure is not a smaller version of
     * the number, it is a different number.
     *
     * Stacking hands the value the full card width. Five elements were
     * measurably clipped before; zero are now.
     */
    /* The stacking now lives in the `wide` conditional — it applies to the two
       tiles that share a row, which are the ones with a width problem. */
    expect(board).toMatch(
      /"flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3"/
    );
    /* The icon shrinks too, or stacking just spends the saved width on height. */
    expect(board).toMatch(/wide \? "h-11 w-11" : "h-9 w-9"/);
  });

  it("makes the hover-only controls reachable where there is no hover", () => {
    /**
     * `opacity-0 group-hover:opacity-100` is a control a phone can never
     * reveal: touch has no hover state. Deleting a deal, and removing a pain
     * point, were both impossible on every mobile device — not awkward,
     * impossible.
     *
     * Safe to surface: deletion confirms first and is recoverable from
     * Settings → Recently deleted, so a mis-tap costs a dialog, not a record.
     */
    const hoverOnly = board.match(/opacity-0[^"]*group-hover:opacity-100[^"]*/g) ?? [];
    expect(hoverOnly.length).toBeGreaterThan(0);
    for (const cls of hoverOnly) expect(cls).toMatch(/max-sm:opacity-100/);
  });

  it("folds a stage away, and says so to a screen reader", () => {
    /* Discovery alone was 1,388px and Closed Won 968px, so reaching Delivery
       meant scrolling past every won deal of the year. Folding every stage
       takes the page from 3,428px to 977px — 4.2 screens to 1.2 — with the
       count and the stage total still on every header, so the shape of the
       pipeline is fully readable folded. */
    expect(board).toMatch(/const \[folded, setFolded\] = useState<Set<StageId>>\(/);
    expect(board).toMatch(/aria-expanded=\{!isFolded\}/);
    expect(board).toMatch(/aria-controls=\{`stage-\$\{stage\.id\}`\}/);
  });

  it("starts every stage that has deals open — a board that opens empty is not a board", () => {
    /**
     * The set holds what is CLOSED, so a stage nobody has touched is open.
     *
     * It used to start completely empty, which was the same rule stated more
     * bluntly. Empty stages now seed it — 126px each of name, zero, currency
     * zero and "Add deal", twice over on a board already 4.5 screens tall — but
     * the guarantee this test exists for is unchanged: a stage WITH deals in it
     * is never folded on arrival, because the filter only ever adds stages that
     * no deal is in.
     */
    expect(board).toMatch(/!deals\.some\(\(d\) => d\.stage === s\.id\)/);
    /* Nothing else may be seeded closed. */
    expect(board).not.toMatch(/new Set\(STAGES\.map/);
  });

  it("cannot fold anything on a desktop, whatever the state holds", () => {
    /**
     * Verified in the browser as well as here: at 1280px every stage body
     * reported `display: flex` both before and after clicking all six toggles.
     *
     * `sm:flex` on the body is unconditional, and the header carries
     * `sm:pointer-events-none` so the desktop column header stays the inert
     * label it has always been rather than a button that appears to do nothing.
     */
    expect(board).toMatch(/"flex-1 flex-col gap-2\.5 overflow-y-auto p-3 sm:flex",\s*\n\s*isFolded \? "hidden" : "flex"/);
    /* Anchored on the className, not the bare token — the comment above it
       names the class too, so a loose match would pass against the explanation
       after the code had lost it. */
    expect(board).toMatch(/className="focus-ring -m-1 flex min-w-0 items-center gap-2 rounded-lg p-1 text-left sm:pointer-events-none"/);
    expect(board).toMatch(/h-4 w-4 shrink-0 text-faint transition-transform sm:hidden/);
  });

  it("ranks the four summary figures instead of tiling them", () => {
    /**
     * Four equal boxes claimed four equal facts. Three are money and one is a
     * count; among the money only Open Pipeline is about what can still
     * happen, Closed Won is the scoreboard, and In Delivery is a sub-state of
     * it. So Open Pipeline takes the full row, the two "won" figures pair
     * beneath it, and the count lays out as a slim strip where a number that
     * is not money stops competing with ones that are.
     *
     * The pair reads in the order the money moves: In Delivery is won but not
     * yet delivered, Closed Won is the banked total it lands in.
     *
     * Measured at 375px: hero 335x88, pair 162x132 each, strip 335x88.
     *
     * Three-across was the other candidate and it fails on measurement, not
     * taste: it leaves ~86px of text column for a figure needing 94, which is
     * exactly the truncation this page was just fixed for.
     */
    const spans = board.match(/className="col-span-2 @min-\[880px\]:col-span-1"/g) ?? [];
    expect(spans).toHaveLength(2);

    /* Order is the deliverable here, so it is asserted as a sequence rather
       than as four independent labels. */
    const labels = [...board.matchAll(/^\s*label="([^"]+)"/gm)].map((m) => m[1]);
    expect(labels).toEqual(["Open Pipeline", "In Delivery", "Closed Won", "Total Deals"]);
  });

  it("keeps the wide tiles short so they read as a different rank", () => {
    /* Stacking exists to buy width for the figure. A tile that already spans
       the row has the width, so it keeps the icon beside the number — and that
       height difference is what makes the hierarchy visible rather than just
       asserted. */
    expect(board).toMatch(/wide[\s\S]{0,12}\? "flex-row items-center gap-3"/);
    expect(board).toMatch(/wide \? "h-11 w-11" : "h-9 w-9"/);
  });

  it("puts Add Deal on the row that names what it adds to", () => {
    /**
     * It sat under the page description, floating above four summary tiles
     * that have nothing to do with adding anything — you reached it before you
     * had seen the board it acts on. It now sits on a "Pipeline" heading row
     * directly above the stages, which is the pattern the Leads page uses.
     */
    expect(board).toMatch(/<h2 className="text-lg font-semibold tracking-tight">Pipeline<\/h2>/);
    /* The header block that used to hold it now holds only the title block. */
    expect(board).not.toMatch(/card to leave it\.\s*<\/p>\s*<\/div>\s*<button/);
  });

  it("does not print a third copy of the deal count", () => {
    /* "Total Deals 15" is the tile directly above the heading, and every stage
       header below carries its own count. A count beside "Pipeline" would sit
       between the two. */
    expect(board).not.toMatch(/Pipeline[\s\S]{0,8}<span className="ml-2/);
  });

  it("drops the divider that has nothing left to divide", () => {
    /* The rule separates a header from a body. Folded there is no body, and it
       hung under the last line of text like a mis-drawn card — while desktop,
       which never folds, keeps it. */
    expect(board).toMatch(/isFolded \? "border-b-0 sm:border-b" : "border-b"/);
  });
});

describe("using the board, not just reading it", () => {
  it("lets a keyboard open a deal", () => {
    /**
     * The card is a click target with no role and no tab stop, so a deal could
     * not be opened from a keyboard at all — every other list in this app opens
     * its rows with a real button.
     *
     * It cannot BE a button: it carries its own Move and Delete buttons, and a
     * button inside a button is invalid markup the browser is free to flatten.
     * So the role and the keyboard behaviour are stated by hand. Space as well
     * as Enter, because that is what a real button answers to, and Space has to
     * be stopped from scrolling the page.
     *
     * Verified in the browser: the card takes focus and Enter opens the panel.
     */
    expect(board).toMatch(/role="button"\s*\n\s*tabIndex=\{0\}/);
    expect(board).toMatch(/aria-label=\{`Open \$\{deal\.title\}`\}/);
    expect(board).toMatch(/if \(e\.key === "Enter" \|\| e\.key === " "\)/);
    /* Only when the card itself is focused: Enter inside the Move or Delete
       button must do that button's job, not open the panel behind it. */
    expect(board).toMatch(/if \(e\.target !== e\.currentTarget\) return;/);
  });

  it("offers the move the panel tells you to make", () => {
    /**
     * Opening a Prospect deal said "move it to Discovery once there's a number
     * to put on it" and gave no way to do it: close the panel, find the card,
     * press Move. An instruction and the action it describes belong in the same
     * place.
     *
     * Only on the branch that has nothing else to offer — where there is a
     * payment to record or a value to set, moving is not the next thing.
     */
    expect(board).toMatch(/Move this deal/);
    expect(board).toMatch(/\{!isWon\(deal\) && \(/);
    /* The panel closes first: two dialogs stacked is a stack to unwind. */
    expect(board).toMatch(/setActive\(null\);\s*\n\s*setMoving\(active\);/);
  });
});

describe("stages with nothing in them", () => {
  it("starts them closed", () => {
    /**
     * An empty stage renders its name, a zero, a currency zero, its exit
     * criterion and an "Add deal" row — 126px on a phone, twice over, on a
     * board already 4.5 screens tall. Measured after: 3498px to 3380px, and
     * two panels that said "nothing here" are gone.
     *
     * Computed once from the board as it arrives, so a stage that empties while
     * the reader is working in it stays open.
     */
    expect(board).toMatch(
      /new Set\(STAGES\.filter\(\(s\) => !deals\.some\(\(d\) => d\.stage === s\.id\)\)\.map\(\(s\) => s\.id\)\)/
    );
  });

  it("opens one again when a deal lands in it", () => {
    /* Otherwise the move looks like the card simply vanished. Verified: moving
       a deal into folded Delivery opened it and the card was visible. */
    expect(board).toMatch(/setFolded\(\(prev\) => \{\s*\n\s*if \(!prev\.has\(stage\)\) return prev;/);
  });

  it("leaves the desktop columns alone", () => {
    /* Each stage body carries an unconditional `sm:flex`, so from `sm` up the
       columns are laid out whatever the fold holds. Verified at 1440px: all six
       bodies shown. */
    expect(board).toMatch(/sm:flex/);
  });
});
