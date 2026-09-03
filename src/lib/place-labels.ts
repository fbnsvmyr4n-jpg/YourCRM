/**
 * Lay out the value labels on a line chart so they cannot collide.
 *
 * The revenue chart labels two points: the highest week and the latest one.
 * Both are drawn bold, centred on their point, and each was clamped only
 * against the edges of the SVG — nothing checked them against each other. When
 * the peak sits next to the newest point, and the peak's figure is the wider of
 * the two, they overlap: measured at 393px with a $364.4K peak beside a $30K
 * latest week, the two ran into each other by 6.6px and the chart read as
 * unfinished. The narrower the screen, the more often it happens, because the
 * gap between points shrinks while the text does not.
 *
 * Resolved right to left, which is the order that matters. The newest point is
 * the one the reader came for, so it is placed first and never moves; earlier
 * labels take whatever room is left, sliding left to avoid the one after them.
 * A label that cannot fit without leaving the plot area is dropped rather than
 * squeezed — the same bargain the x-axis already makes, and better than two
 * numbers printed on top of each other.
 */

export type LabelCandidate = {
  /** Index of the point this labels, used only to report the result back. */
  i: number;
  /** Centre of the point, in the same units as `bounds`. */
  x: number;
  /** Rendered width of the text. */
  width: number;
};

export function placeValueLabels(
  candidates: readonly LabelCandidate[],
  /**
   * How far the labels may spread, and it is deliberately not symmetric.
   *
   * `left` is the plot's left edge, because everything to the left of it is the
   * axis gutter — a label pushed in there sits on the tick figures. `right` is
   * the chart's own edge less a hair, because the right padding is simply empty
   * space and a label is welcome to use it. Clamping both sides to the plot
   * would shove the newest point's label inward off its own marker, which is
   * the one label that should stay put.
   */
  bounds: { left: number; right: number },
  /** Clear space required between two labels before they read as separate. */
  gap = 10
): { i: number; x: number }[] {
  const byX = [...candidates].sort((a, b) => a.x - b.x);
  const placed: { i: number; x: number }[] = [];

  /* The left edge of the label placed most recently — everything further left
     has to finish before this. Starts past the right edge so the first one is
     bounded only by the plot. */
  let limit = Number.POSITIVE_INFINITY;

  for (let k = byX.length - 1; k >= 0; k--) {
    const c = byX[k];
    const half = c.width / 2;

    const lo = bounds.left + half;
    const hi = Math.min(bounds.right - half, limit - gap - half);

    // No position leaves it inside the plot and clear of its neighbour.
    if (hi < lo) continue;

    const x = Math.min(hi, Math.max(lo, c.x));
    placed.push({ i: c.i, x });
    limit = x - half;
  }

  return placed.reverse();
}
