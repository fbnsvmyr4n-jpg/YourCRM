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
    /* The newest point wears a 12px halo. A 14px lift left three pixels between
       the text and the glow, which reads as a collision even though the boxes
       never touched; the chip has to clear the halo, not merely the dot. */
    expect(src).toMatch(/p\.y - 22/);
    expect(src).not.toMatch(/p\.y - 14/);
  });
});

describe("the chart is lit, not merely plotted", () => {
  it("draws a soft copy of the line beneath the real one", () => {
    /* On a dark panel a flat 2.5px stroke reads as drawn ON the card. The blur
       underneath is what makes it read as lit — the single largest difference
       between a chart that looks plotted and one that looks designed. It is a
       second path, never a replacement: the crisp stroke still carries the
       data. */
    expect(src).toMatch(/filter=\{`url\(#\$\{uid\}-glow\)`\}/);
    expect(src).toMatch(/<feGaussianBlur stdDeviation="5" \/>/);
    expect(src).toMatch(/stroke=\{`url\(#\$\{uid\}-line\)`\}/);
  });

  it("rounds the joins so a spike does not grow a spur", () => {
    /* A week ten times the one before meets its neighbours at a sharp angle,
       and the default mitre runs off the top of the peak. */
    expect(src).toMatch(/strokeLinejoin="round"/);
  });

  it("gives every chart its own gradient ids", () => {
    /* Two charts on one page would otherwise both define `areaFill`, and the
       second would silently repaint the first. They sit on different pages
       today, which made it a landmine rather than a bug. */
    expect(src).toMatch(/const uid = useId\(\)\.replace\(\/:\/g, ""\);/);
    expect(src).not.toMatch(/id="areaFill"/);
    expect(src).not.toMatch(/id="lineStroke"/);
  });
});

describe("the marks carry a hierarchy", () => {
  it("quietens the points that carry no number", () => {
    /* Six identical rings competed with the line, so the chart read as a row of
       dots that happened to be joined up. The points with a figure attached are
       the ones worth emphasising. */
    expect(src).toMatch(/r=\{labelled\.has\(i\) \? 4\.5 : 3\}/);
    expect(src).toMatch(/opacity=\{labelled\.has\(i\) \? 1 : 0\.55\}/);
  });

  it("builds the newest point in layers", () => {
    /* Two falling opacities give the glow to the POINT rather than the line,
       and the panel-coloured core turns a dot into a mark that looks placed. */
    expect(src).toMatch(/r="12" fill="var\(--accent\)" opacity="0\.14"/);
    expect(src).toMatch(/r="7\.5" fill="var\(--accent\)" opacity="0\.26"/);
    expect(src).toMatch(/r="1\.9" fill="var\(--panel-solid\)"/);
  });

  it("stands the figures on a chip rather than on the picture", () => {
    /**
     * Bare text floated over the gridlines and the area fill, so its contrast
     * changed depending on where the line happened to be — a number dropped on
     * top of a picture rather than a label belonging to it.
     *
     * The chip is also what can collide, so it is the chip's width that goes
     * into the placement, not the text's.
     */
    expect(src).toMatch(/textWidth\(format\(pts\[i\]\.value\), VALUE_FONT\) \+ CHIP_PAD_X \* 2/);
    expect(src).toMatch(/fill="var\(--panel-solid\)"\s*\n\s*fillOpacity="0\.92"/);
    expect(src).toMatch(/fontVariantNumeric: "tabular-nums"/);
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
