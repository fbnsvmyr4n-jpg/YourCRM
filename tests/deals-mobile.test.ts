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
    expect(board).toMatch(
      /card flex flex-col items-start gap-2 p-4 sm:flex-row sm:items-center sm:gap-3/
    );
    /* The icon shrinks too, or stacking just spends the saved width on height. */
    expect(board).toMatch(/h-9 w-9 shrink-0 place-items-center rounded-xl sm:h-11 sm:w-11/);
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

  it("drops the divider that has nothing left to divide", () => {
    /* The rule separates a header from a body. Folded there is no body, and it
       hung under the last line of text like a mis-drawn card — while desktop,
       which never folds, keeps it. */
    expect(board).toMatch(/isFolded \? "border-b-0 sm:border-b" : "border-b"/);
  });
});
