import { describe, expect, it } from "vitest";
import { placeValueLabels } from "@/lib/place-labels";

/**
 * Two numbers printed on top of each other.
 *
 * The revenue chart labels the highest week and the latest one. Both are bold,
 * both centred on their point, and each was clamped only against the edges of
 * the SVG — nothing compared them to each other. Measured at 393px with a
 * $364.4K peak beside a $30K latest week, they overlapped by 6.6px.
 *
 * The overlap depends on the data, which is why it survived: on most weeks the
 * peak is far from the newest point, or its figure is narrow enough to fit.
 */

/**
 * The real geometry at 393px: plot starts at 44 (the axis gutter is to its
 * left), and labels may run to 281 — the chart is 285 wide and the right-hand
 * padding is empty space, not gutter.
 */
const PLOT = { left: 44, right: 281 };
const overlap = (
  a: { x: number; w: number },
  b: { x: number; w: number }
) => Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);

describe("value labels never sit on top of one another", () => {
  it("separates a wide peak from the latest point beside it", () => {
    // The reported case, in its real numbers.
    const peak = { i: 4, x: 219.2, width: 66 }; // "$364.4K"
    const last = { i: 5, x: 263, width: 35.2 }; // "$30K"

    const out = placeValueLabels([peak, last], PLOT);
    expect(out, "a label was dropped where both could have fitted").toHaveLength(2);

    const [p, l] = out;
    expect(
      overlap({ x: p.x, w: peak.width }, { x: l.x, w: last.width }),
      "the two labels still overlap"
    ).toBeLessThanOrEqual(-10 + 0.01);
  });

  it("leaves the newest point where it belongs", () => {
    /* It is the figure the reader came for, and it anchors the right-hand end
       of the line. Moving it to make room for an older week would be the wrong
       one to sacrifice. */
    const out = placeValueLabels(
      [{ i: 4, x: 219.2, width: 66 }, { i: 5, x: 263, width: 35.2 }],
      PLOT
    );
    expect(out.find((o) => o.i === 5)!.x).toBe(263);
  });

  it("does not push a label into the axis gutter", () => {
    /* Labels used to be clamped against the SVG edge, so one near the left ran
       under the y-axis tick figures. The plot area is the boundary. */
    const out = placeValueLabels([{ i: 0, x: 10, width: 60 }], PLOT);
    expect(out[0].x - 30, "the label starts left of the plot").toBeGreaterThanOrEqual(PLOT.left);
  });

  it("does not push a label past the right edge", () => {
    const out = placeValueLabels([{ i: 5, x: 400, width: 60 }], PLOT);
    expect(out[0].x + 30).toBeLessThanOrEqual(PLOT.right);
  });

  it("lets the newest label use the right-hand padding", () => {
    /* The last point sits ON the plot's right edge, so clamping labels to the
       plot on both sides would drag its figure inward, off its own marker. The
       padding beyond the plot is empty; the gutter on the left is not. */
    const out = placeValueLabels([{ i: 5, x: 263, width: 35.2 }], PLOT);
    expect(out[0].x).toBe(263);
  });

  it("drops a label rather than squeezing it", () => {
    /**
     * Two labels so wide that no arrangement separates them. Dropping one is
     * the same bargain the x-axis already makes when dates will not fit, and
     * it is better than printing both illegibly — the peak is still visibly the
     * highest point on the line even without its figure.
     */
    const out = placeValueLabels(
      [{ i: 4, x: 200, width: 160 }, { i: 5, x: 250, width: 160 }],
      PLOT
    );
    expect(out).toHaveLength(1);
    expect(out[0].i, "the wrong label survived").toBe(5);
  });

  it("keeps a single label centred on its own point", () => {
    // Nothing to avoid: it should not drift.
    const out = placeValueLabels([{ i: 3, x: 150, width: 40 }], PLOT);
    expect(out[0].x).toBe(150);
  });

  it("returns labels in point order regardless of input order", () => {
    const out = placeValueLabels(
      [{ i: 5, x: 263, width: 35 }, { i: 1, x: 90, width: 35 }],
      PLOT
    );
    expect(out.map((o) => o.i)).toEqual([1, 5]);
  });

  it("handles no candidates", () => {
    expect(placeValueLabels([], PLOT)).toEqual([]);
  });
});
