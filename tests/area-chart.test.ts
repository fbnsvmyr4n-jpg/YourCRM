import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The revenue chart's text.
 *
 * Reported from a phone: the numbers overlapped and it looked unfinished. Both
 * halves of that were true and they had different causes — the labels were
 * never compared to each other, and the estimate of how wide they are was
 * wrong in the direction that hides collisions.
 */

const src = readFileSync(
  fileURLToPath(new URL("../src/components/ui/AreaChart.tsx", import.meta.url)),
  "utf8"
);

describe("the value labels are laid out against each other", () => {
  it("goes through the placement rather than clamping to the edges alone", () => {
    /**
     * Each label used to be clamped only against the chart's edges, so nothing
     * stopped the peak's figure running into the newest one when the two points
     * are neighbours. Measured at 393px with a $364.4K peak beside a $30K
     * latest week: they overlapped by 6.6px. It is data-dependent, which is why
     * it survived — on most weeks the peak is far from the newest point.
     */
    expect(src).toMatch(/placeValueLabels\(/);
    /* Bounded by the PLOT on the left, because past it is the gutter holding
       the tick figures, and by the chart edge on the right, where the padding
       is empty space the newest label is welcome to use. */
    expect(src).toMatch(/\{ left: padL, right: W - 4 \}/);
    /* The old per-label clamp must not still be applied to these. */
    expect(src).not.toMatch(/x=\{clampX\(p\.x, format\(p\.value\), 13\)\}/);
  });

  it("still clamps the DATE labels, which have their own rule", () => {
    /* Dates are centred under their point and may use the full width; they are
       thinned by stride instead. Removing that clamp would let the first and
       last overhang the chart. */
    expect(src).toMatch(/x=\{clampX\(p\.x, p\.label, AXIS_FONT\)\}/);
  });

  it("lifts a value label clear of the marker under it", () => {
    /* The newest point wears an 11px halo. A 14px lift left three pixels
       between the text and the glow, which reads as a collision even though the
       boxes never touched. */
    expect(src).toMatch(/p\.y - 20/);
    expect(src).not.toMatch(/p\.y - 14/);
  });
});

describe("the width estimate leans wide, not narrow", () => {
  it("charges a digit what the font actually charges", () => {
    /**
     * The rates were guessed: digits 0.6 and capitals 0.62. Measured against
     * Geist at weight 700 with `canvas.measureText`, a digit is 0.69 and a "K"
     * is 0.69 — so every money label came out about 7% narrow.
     *
     * That is the dangerous direction. The placement believed it had left a
     * 10px gap between two figures and had actually left 6.3px, so the fix
     * above only half-worked until these were corrected. Under-measuring hides
     * collisions; over-measuring costs a little air.
     */
    expect(src).toMatch(/ch >= "0" && ch <= "9"\) w \+= 0\.7;/);
    expect(src).toMatch(/ch === "\$" \|\| ch === "%"\) w \+= 0\.7;/);
    expect(src).toMatch(/ch >= "A" && ch <= "Z"\) w \+= 0\.73;/);
    /* Named against the OLD lines specifically. A blanket ban on "0.62" was
       wrong: that is now the lowercase rate, which is correct — it was the
       CAPITALS that were being charged it. */
    expect(src).not.toMatch(/ch >= "0" && ch <= "9"\) w \+= 0\.6;/);
    expect(src).not.toMatch(/ch >= "A" && ch <= "Z"\) w \+= 0\.62;/);
  });

  it("knows the two characters that break the average", () => {
    /* "1" is barely half a digit wide and "M" is nearly a third wider than a
       capital — "$1.25M" contains both, and treating them as ordinary made it
       the worst-estimated label on the chart. */
    expect(src).toMatch(/ch === "1"\) w \+= 0\.46;/);
    expect(src).toMatch(/ch === "M" \|\| ch === "W"\) w \+= 0\.92;/);
  });
});
