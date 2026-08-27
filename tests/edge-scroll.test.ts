import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EDGE_MAX_SPEED,
  EDGE_RAMP,
  EDGE_ZONE,
  FRAME_MS,
  edgeScrollStep,
  edgeScrollVelocity,
} from "@/lib/edge-scroll";

/**
 * Dragging a deal to a stage that is off the side of the window.
 *
 * The board is a horizontal scroller wider than the window from `sm` up, and
 * nothing scrolled it while a card was being dragged — the card stopped at the
 * edge of the screen. Reaching a later stage meant dropping the card somewhere
 * it did not belong, scrolling, and picking it up again.
 */

/** A 1,200px-wide board sitting 300px from the left of the window. */
const board = { left: 300, right: 1500 };

describe("edge auto-scroll", () => {
  it("holds still through the middle", () => {
    /* Most of a drag happens here, and a board that creeps while you are
       aiming at a column is worse than one that does not move at all. */
    expect(edgeScrollVelocity(900, board)).toBe(0);
    expect(edgeScrollVelocity(board.left + EDGE_ZONE, board)).toBe(0);
    expect(edgeScrollVelocity(board.right - EDGE_ZONE, board)).toBe(0);
  });

  it("scrolls toward the edge the pointer is nearest", () => {
    expect(edgeScrollVelocity(board.left + 10, board)).toBeLessThan(0);
    expect(edgeScrollVelocity(board.right - 10, board)).toBeGreaterThan(0);
  });

  it("ramps with depth rather than switching on", () => {
    /**
     * A constant speed makes a precise drop near the edge impossible: the
     * moment you enter the zone the board leaves under you. Ramping means a
     * pointer resting just inside creeps, and one pinned to the edge moves at
     * full speed.
     */
    const shallow = Math.abs(edgeScrollVelocity(board.right - EDGE_ZONE + 5, board));
    const deep = Math.abs(edgeScrollVelocity(board.right - 5, board));
    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(shallow);
    expect(deep).toBeLessThanOrEqual(EDGE_MAX_SPEED);
  });

  it("is fast off the mark rather than proportional to depth", () => {
    /**
     * The complaint this exists to answer: reaching a far stage was slow and
     * felt like work. A LINEAR ramp was why — a third of the way into the zone
     * bought a third of the speed, about 8px a frame, which looks like nothing
     * happening and invites shoving the card harder against the screen edge.
     *
     * The curve gives just over half speed at that same third. Every other
     * assertion in this file is relative, so a silent regression to linear
     * would pass all of them; this one would not.
     */
    const third = Math.abs(edgeScrollVelocity(board.right - EDGE_ZONE + EDGE_ZONE / 3, board));
    expect(third).toBeGreaterThan(EDGE_MAX_SPEED * 0.5);

    /* And shallow entry still moves the board rather than stalling in a dead
       band: a tenth of the way in is worth more than a quarter speed. */
    const tenth = Math.abs(edgeScrollVelocity(board.right - EDGE_ZONE + EDGE_ZONE / 10, board));
    expect(tenth).toBeGreaterThan(EDGE_MAX_SPEED * 0.25);

    expect(EDGE_RAMP).toBeLessThan(1);
  });

  it("crosses a hidden board quickly, in real units", () => {
    /**
     * Every other assertion here is expressed as a fraction of
     * `EDGE_MAX_SPEED`, so halving that constant moves both sides of every
     * comparison and none of them notice — a mutation that put the top speed
     * back to its original value passed the entire file. The speed is the
     * thing that was asked for, so it is pinned in units a person can feel.
     *
     * Measured at 1280px: the board shows 968px of 1,888px, so 920px sits off
     * the right. Crossing that at full speed must be well under half a second,
     * or reaching the last stage is the slog it was.
     */
    const pxPerSecond = EDGE_MAX_SPEED * 60;
    expect(pxPerSecond).toBeGreaterThanOrEqual(2000);

    const HIDDEN_PX = 920;
    expect(HIDDEN_PX / pxPerSecond).toBeLessThan(0.5);

    /* The zone is the other half of "easy". A narrow band has to be aimed at
       before anything happens, which is work in itself — the same mutation
       problem as the speed, so it is pinned in px rather than relative to
       itself. */
    expect(EDGE_ZONE).toBeGreaterThanOrEqual(120);
  });

  it("still passes through zero at the boundary", () => {
    /* Being quick off the mark must not become a step. A floor speed would
       make crossing the boundary a switch rather than a gradient, which is the
       thing that reads as a glitch. */
    expect(edgeScrollVelocity(board.right - EDGE_ZONE, board)).toBe(0);
    const sliver = Math.abs(edgeScrollVelocity(board.right - EDGE_ZONE + 0.01, board));
    expect(sliver).toBeGreaterThan(0);
    expect(sliver).toBeLessThan(EDGE_MAX_SPEED * 0.1);
  });

  it("clamps rather than accelerating without limit past the edge", () => {
    /* A drag can leave the window entirely. Without the clamp the depth ratio
       keeps growing and the board flies. */
    expect(edgeScrollVelocity(board.right + 4000, board)).toBe(EDGE_MAX_SPEED);
    expect(edgeScrollVelocity(board.left - 4000, board)).toBe(-EDGE_MAX_SPEED);
  });

  it("does nothing when the zones would overlap", () => {
    /* In a container narrower than two zones a pointer in the middle is inside
       both, and there is no sensible direction to pick. */
    const narrow = { left: 0, right: EDGE_ZONE * 2 };
    expect(edgeScrollVelocity(narrow.right / 2, narrow)).toBe(0);
    expect(edgeScrollVelocity(1, narrow)).toBe(0);
  });

  it("is symmetric", () => {
    /* The same depth on either side moves the same amount, so the board does
       not feel faster one way than the other. */
    for (const depth of [1, 30, 80, EDGE_ZONE]) {
      expect(Math.abs(edgeScrollVelocity(board.left + EDGE_ZONE - depth, board))).toBeCloseTo(
        Math.abs(edgeScrollVelocity(board.right - EDGE_ZONE + depth, board)),
        10
      );
    }
  });
});

describe("distance per frame", () => {
  it("moves the same distance per second on any refresh rate", () => {
    /**
     * Caught by measuring rather than by reading. On a 120Hz display the
     * unscaled loop moved 399px in 150ms where a 60Hz display moved 198 — the
     * board was twice as fast on better hardware, which is a different feel per
     * machine rather than a chosen one.
     *
     * A 120Hz frame is half the elapsed time, so it must move half as far.
     */
    const sixty = edgeScrollStep(EDGE_MAX_SPEED, FRAME_MS);
    const oneTwenty = edgeScrollStep(EDGE_MAX_SPEED, FRAME_MS / 2);
    expect(sixty).toBeCloseTo(EDGE_MAX_SPEED, 10);
    expect(oneTwenty).toBeCloseTo(EDGE_MAX_SPEED / 2, 10);

    /* Two 120Hz frames cover the same ground as one 60Hz frame. */
    expect(oneTwenty * 2).toBeCloseTo(sixty, 10);
  });

  it("caps a long gap instead of leaping across the board", () => {
    /* A backgrounded tab or a long task hands back a gap of hundreds of
       milliseconds. Uncapped, the first frame after it jumps several columns. */
    expect(edgeScrollStep(EDGE_MAX_SPEED, 1000)).toBe(EDGE_MAX_SPEED * 4);
    expect(edgeScrollStep(EDGE_MAX_SPEED, FRAME_MS * 4)).toBeCloseTo(EDGE_MAX_SPEED * 4, 10);
  });

  it("does not run backwards on a non-monotonic clock", () => {
    /* `now - last` can come back negative across some timer adjustments, and a
       negative step would scroll the board the wrong way. */
    expect(edgeScrollStep(EDGE_MAX_SPEED, -50)).toBe(0);
  });

  it("holds still for the very first frame", () => {
    /* The loop has no previous timestamp to measure against, so it contributes
       nothing rather than guessing a frame length. */
    expect(edgeScrollStep(EDGE_MAX_SPEED, 0)).toBe(0);
  });
});

describe("how the board drives it", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/deals/DealsBoard.tsx", import.meta.url)),
    "utf8"
  );

  it("keeps scrolling while a held card does not move", () => {
    /**
     * The reason this runs on requestAnimationFrame rather than scrolling from
     * `dragover` directly: `dragover` only fires while the pointer MOVES, so a
     * card held still against the edge — exactly what someone does while
     * waiting for the board to come to them — would stall until they jiggled
     * it.
     */
    expect(src).toMatch(/frame\.current = requestAnimationFrame\(step\)/);
    expect(src).toMatch(/el\.scrollLeft \+= edgeScrollStep\(velocity\.current, elapsed\)/);
  });

  it("stops on every way a drag can end", () => {
    /* A loop left running scrolls the board against a card nobody is holding.
       A drag can end by dropping, by leaving the board, or by being abandoned
       anywhere on the page — which only `dragend` sees. */
    expect(src).toMatch(/onDrop=\{stopEdgeScroll\}/);
    expect(src).toMatch(/onDragLeave=\{\(e\) => \{[\s\S]*?stopEdgeScroll\(\)/);
    expect(src).toMatch(/onDragEnd=\{\(\) => \{[\s\S]*?stopEdgeScroll\(\);/);
    /* And on unmount, or it outlives the page. */
    expect(src).toMatch(/useEffect\(\(\) => stopEdgeScroll, \[stopEdgeScroll\]\)/);
  });

  it("does not stop when the pointer merely crosses between columns", () => {
    /* `dragleave` fires moving from one child to the next. Without the
       containment check the board would stall every time the card passed a
       column boundary — which is most of a drag. */
    expect(src).toMatch(/if \(!e\.currentTarget\.contains\(e\.relatedTarget as Node\)\) stopEdgeScroll\(\)/);
  });
});
