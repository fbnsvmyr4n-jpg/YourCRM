import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Moving a deal on a device that cannot drag.
 *
 * iOS Safari does not fire the HTML5 drag events for touch — there is no
 * `dragstart` from a finger — so the board looked interactive on every iPhone
 * and was inert. The code had no touch or pointer handlers at all, and a
 * comment in it claimed "dragging still works" on the stacked layout, which was
 * the thing that made the gap easy to miss.
 *
 * Two fixes were possible: reimplement dragging on pointer events, or give the
 * phone a control that says what dragging says. The second is the better fit
 * for THIS board rather than merely the cheaper one — below `sm` the stages are
 * a vertical stack, so a drag from Discovery to Delivery means holding a finger
 * while the page auto-scrolls past nine cards, and that gesture has to be
 * disambiguated from the scroll it is fighting.
 */

const board = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/deals/DealsBoard.tsx", import.meta.url)),
  "utf8"
);

describe("moving a deal without a drag", () => {
  it("routes dragging and tapping through one move", () => {
    /**
     * The most important assertion here. `moveDeal` holds the split merge, the
     * whole-board snapshot and the rollback on a refusal — exactly the parts a
     * second copy would get subtly wrong, and the two paths would then disagree
     * only in the cases nobody tests by hand.
     */
    expect(board).toMatch(/async function moveDeal\(id: string, stage: StageId\)/);

    /* The drag handler keeps only the part that is about dragging: working out
       which card was dropped. */
    expect(board).toMatch(/const id = dragId;\s*\n\s*setDragId\(null\);\s*\n\s*if \(!id\) return;\s*\n\s*await moveDeal\(id, stage\);/);

    /* And the sheet calls the same function, not its own copy. */
    expect(board).toMatch(/await moveDeal\(id, stage\);[\s\S]{0,400}MoveSheet|MoveSheet[\s\S]{0,600}await moveDeal\(id, stage\)/);

    /* One optimistic update in the file, so there is nowhere for a second to
       hide. */
    expect(board.match(/const before = items;/g) ?? []).toHaveLength(1);
  });

  it("gives every card a Move control, and only on a phone", () => {
    expect(board).toMatch(/aria-label=\{`Move "\$\{deal\.title\}" to another stage`\}/);
    expect(board).toMatch(/text-\[11px\] font-semibold text-muted sm:hidden/);
  });

  it("does not let the Move control open the card underneath it", () => {
    /* The card itself opens the detail sheet on click, so without this the tap
       would fire both. */
    const move = board.match(/onMove\(\);[\s\S]{0,60}\}\}/);
    expect(board).toMatch(/e\.stopPropagation\(\);\s*\n\s*onMove\(\);/);
    expect(move).not.toBeNull();
  });

  it("reads the deal live rather than from the tap that opened the sheet", () => {
    /* Otherwise the sheet goes on offering a stage the deal has already left —
       the same bug the detail panel was fixed for. */
    expect(board).toMatch(/deal=\{items\.find\(\(d\) => d\.id === moving\.id\) \?\? moving\}/);
  });

  it("marks the stage the deal is already in, and makes it a no-op", () => {
    /* Picking the current stage would otherwise post a move to where it
       already is. `moveDeal` guards that too, but the sheet should not offer it
       as if it were a change. */
    expect(board).toMatch(/const here = deal\.stage === stage\.id;/);
    expect(board).toMatch(/onClick=\{\(\) => \(here \? onClose\(\) : onPick\(stage\.id\)\)\}/);
    expect(board).toMatch(/aria-current=\{here \? "true" : undefined\}/);
  });

  it("offers the exit criterion, not just the stage name", () => {
    /* The same rule the column header carries, so the choice is made against
       what has to be true rather than against a label.
     *
     * Scoped to the sheet. `{stage.exit}` also appears in the column header, so
     * a whole-file match passed even with the sheet's copy deleted — it was
     * asserting the existence of a line in a different component. */
    const sheet = board.slice(
      board.indexOf("function MoveSheet("),
      board.indexOf("function DealCard(")
    );
    expect(sheet).not.toHaveLength(0);
    expect(sheet).toMatch(/\{stage\.exit\}/);
    expect(sheet).toMatch(/\{stage\.label\}/);
  });

  it("leaves the desktop drag exactly as it was", () => {
    /* The control is `sm:hidden` and the drag handlers are untouched — the
       board still carries draggable cards and stage drop targets. */
    expect(board).toMatch(/draggable\n/);
    expect(board).toMatch(/onDragStart=\{\(e\) => \{/);
    expect(board).toMatch(/onDrop=\{\(\) => handleDrop\(stage\.id\)\}/);
    expect(board).toMatch(/onDragOver=\{\(e\) => \{/);
  });

  it("stops claiming that dragging works on a phone", () => {
    /* The comment said "Dragging still works: the drop targets are unchanged".
       A confident false statement in the code is why this survived as long as
       it did. */
    expect(board).not.toMatch(/Dragging still works/);
    expect(board).toMatch(/does not fire the HTML5\s*\n?\s*\*?\s*drag events for touch/);
  });
});
