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
    expect(board).toMatch(/const \[folded, setFolded\] = useState<Set<StageId>>\(new Set\(\)\)/);
    expect(board).toMatch(/aria-expanded=\{!isFolded\}/);
    expect(board).toMatch(/aria-controls=\{`stage-\$\{stage\.id\}`\}/);
  });

  it("starts open — a board that opens empty is not a board", () => {
    /* The set holds what is CLOSED, so an untouched stage is open. It also
       avoids seeding state for stages that may not exist on another account's
       board. */
    expect(board).toMatch(/useState<Set<StageId>>\(new Set\(\)\)/);
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
     * beneath it — larger first — and the count lays out as a slim strip where
     * a number that is not money stops competing with ones that are.
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
    expect(labels).toEqual(["Open Pipeline", "Closed Won", "In Delivery", "Total Deals"]);
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
