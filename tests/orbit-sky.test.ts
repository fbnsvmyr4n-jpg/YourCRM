import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The login sky, above the horizon wash.
 *
 * Measured before changing anything, by compositing the star canvas against the
 * CSS background and profiling the frame in tenths. The stars were fine — the
 * sky region carried a standard deviation of half its own mean, which is a lot
 * of large-scale structure, because the Milky Way runs across it.
 *
 * The CSS underneath them was not. It contributed 0.01178 luma at every one of
 * the top SEVEN tenths — identical to five decimal places — and only began to
 * change in the bottom three. So three-quarters of the frame had a dead flat
 * floor, and every bit of variation up there came from stars painted on it.
 *
 * That hard floor is what made the background feel flat. A real view from orbit
 * falls off continuously from the horizon to the zenith; it does not step from
 * a lit band straight into black.
 *
 * After, the same profile is a monotonic ramp:
 *
 *   before  0.01178 0.01178 0.01178 0.01178 0.01178 0.01178 0.01178 0.01290 …
 *   after   0.01680 0.01792 0.01902 0.02013 0.02122 0.02228 0.02334 0.02538 …
 */

const css = readFileSync(
  fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
  "utf8"
);

const sky = css.slice(css.indexOf(".orbit-sky {"), css.indexOf(".orbit-sky {") + 2600);

describe("the login sky", () => {
  it("ramps from horizon to zenith instead of stopping at black", () => {
    /* The wide, faint layer. Its radius is the point: it has to reach the top
       of the frame, which the 46%-tall horizon wash never did. */
    expect(sky).toMatch(/radial-gradient\(190% 165% at 50% 115%, rgba\(18, 40, 80, 0\.13\), transparent 95%\)/);
  });

  it("keeps the horizon wash it already had", () => {
    /* The rim is still meant to be the brightest thing in the frame. The new
       layer sits UNDER this one and is six times fainter; it changes the ground
       the stars sit on, not the horizon. */
    expect(sky).toMatch(/radial-gradient\(120% 46% at 50% 104%, rgba\(24, 54, 102, 0\.42\), transparent 62%\)/);
  });

  it("stays faint enough not to compete with the stars", () => {
    /**
     * The failure mode on the other side of this is a milky sky that swallows
     * the star field, and it is easy to reach — at alpha 0.20 the measured
     * sky mean rose 17% and its relative structure fell from 0.497 to 0.419.
     *
     * At 0.13: sky mean +15%, structure 0.456, and the lift at the zenith is
     * 0.005 luma — about 1.3 sRGB levels on a field whose stars peak near 0.7.
     */
    const alpha = sky.match(/rgba\(18, 40, 80, ([\d.]+)\)/);
    expect(alpha).not.toBeNull();
    expect(Number(alpha![1])).toBeLessThanOrEqual(0.15);
    /* And not so faint it does nothing — the flat floor is the bug. */
    expect(Number(alpha![1])).toBeGreaterThanOrEqual(0.08);
  });

  it("still starts from near-black", () => {
    /* The ramp lifts the sky; it does not replace the base. Losing this would
       raise the whole frame rather than shape it. */
    expect(sky).toMatch(/#020306;/);
  });
});
