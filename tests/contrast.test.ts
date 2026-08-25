import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  luminance,
  mix,
  over,
  footerScrimAlpha,
  scenePalette,
  scrimAlpha,
  toCss,
} from "../src/lib/environment/palette";
import { environmentFor } from "../src/lib/environment/model";
import { moonSnapshot, solarSnapshot } from "../src/lib/solar/suncalc";
import type { Coordinates } from "../src/lib/solar/types";

/**
 * "The text stays readable" as a measurement rather than an opinion.
 *
 * §24 asks for contrast to be maintained across the whole cycle. Nobody can
 * check that by looking: the risk is concentrated in the few minutes around
 * sunrise when the sky behind a screen designed for night is at its brightest,
 * and a person running the simulator would have to happen to be watching then.
 *
 * These assertions operate on the colours the browser is actually given — the
 * palette is computed in TypeScript and published as custom properties, so
 * there is no second copy of the arithmetic to drift.
 */

/** WCAG AA for body text. The bar the rest of this product already meets. */
const AA_NORMAL = 4.5;
/** AA for large text — the title is far above this size. */
const AA_LARGE = 3;

const place = (latitude: number, longitude: number): Coordinates => ({
  latitude,
  longitude,
  source: "gps",
});

const CAPE_TOWN = place(-33.9, 18.4);
const EQUATOR = place(0, 0);
const TROMSO = place(69.7, 19.0);

const paletteAt = (when: Date, where: Coordinates) =>
  scenePalette(environmentFor(solarSnapshot(when, where), moonSnapshot(when, where)));

describe("the colour maths itself", () => {
  it("mixes in linear light, not in sRGB", () => {
    /**
     * Halfway between black and white is NOT 128. sRGB is perceptually encoded,
     * so the midpoint of the light is around 188 once re-encoded. Averaging the
     * encoded values instead is what turns a night-to-day sky ramp into a march
     * through grey mud.
     */
    const half = mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
    expect(half.r).toBeGreaterThan(180);
    expect(half.r).toBeLessThan(195);
  });

  it("returns the endpoints exactly", () => {
    const a = { r: 10, g: 20, b: 30 };
    const b = { r: 200, g: 210, b: 220 };
    expect(mix(a, b, 0)).toEqual(a);
    expect(mix(a, b, 1)).toEqual(b);
  });

  it("composites translucency the way a browser does", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(over(black, 0, white)).toEqual(white);
    expect(over(black, 1, white)).toEqual(black);
    expect(over(black, 0.5, white).r).toBe(128);
  });

  it("computes the contrast ratios WCAG defines", () => {
    // The two anchors everybody knows: black on white is 21:1, and a colour
    // against itself is 1:1.
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 6);
    // Symmetrical, whichever way round it is asked.
    expect(contrastRatio(black, white)).toBeCloseTo(contrastRatio(white, black), 9);
  });

  it("emits colours a browser will accept", () => {
    expect(toCss({ r: 4, g: 8, b: 18 })).toBe("rgb(4 8 18)");
  });
});

describe("text stays readable through a whole day", () => {
  const sweepDay = (where: Coordinates, date: [number, number, number], label: string) => {
    const failures: string[] = [];

    for (let minute = 0; minute < 1440; minute += 2) {
      const when = new Date(Date.UTC(date[0], date[1], date[2], 0, minute));
      const palette = paletteAt(when, where);

      const body = contrastRatio(palette.cardText, palette.cardSurface);
      const muted = contrastRatio(palette.cardMuted, palette.cardSurface);

      const at = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      if (body < AA_NORMAL) {
        failures.push(`${label} ${at}: body text ${body.toFixed(2)}:1`);
      }
      if (muted < AA_NORMAL) {
        failures.push(`${label} ${at}: muted text ${muted.toFixed(2)}:1`);
      }
    }
    return failures;
  };

  it("holds at every minute of an equinox in Cape Town", () => {
    expect(sweepDay(CAPE_TOWN, [2026, 2, 20], "Cape Town")).toEqual([]);
  });

  it("holds through midsummer, when the sky is brightest longest", () => {
    expect(sweepDay(CAPE_TOWN, [2026, 11, 21], "midsummer")).toEqual([]);
  });

  it("holds at the equator, where the sun goes highest", () => {
    // The worst case for a bright sky: the sun passes almost directly overhead,
    // so `skyBrightness` sits at its ceiling for hours.
    expect(sweepDay(EQUATOR, [2026, 2, 20], "equator")).toEqual([]);
  });

  it("holds through a polar day, where the sky never darkens at all", () => {
    // Twenty-four hours of daylight is twenty-four hours of the hardest case.
    expect(sweepDay(TROMSO, [2026, 5, 21], "Tromsø midnight sun")).toEqual([]);
  });

  it("holds through a polar night, where the scrim all but disappears", () => {
    // The opposite risk: with almost no scrim, the text is sitting on raw sky.
    // It passes because the sky is nearly black — but it has to be checked,
    // because "obviously fine" is how the other end got missed.
    expect(sweepDay(TROMSO, [2026, 11, 21], "Tromsø polar night")).toEqual([]);
  });
});

describe("the footer, which is over the planet rather than the sky", () => {
  /**
   * The case the original contrast work missed entirely.
   *
   * The form's last two rows hang below the card's readability wash and sit
   * over the PLANET, which in daylight is the brightest thing in the frame by a
   * wide margin. Every assertion in this file measured text against the SKY and
   * passed, while those lines were over sunlit cloud and barely readable — a
   * test measuring the right property of the wrong surface.
   *
   * `behindFooter` models the worst case rather than the average: lit cloud,
   * near-white. Land and ocean are darker, so anything legible over cloud is
   * legible over all of it.
   */
  const footerSweep = (where: Coordinates, date: [number, number, number], label: string) => {
    const failures: string[] = [];
    for (let minute = 0; minute < 1440; minute += 2) {
      const when = new Date(Date.UTC(date[0], date[1], date[2], 0, minute));
      const palette = paletteAt(when, where);
      const quiet = contrastRatio(palette.cardMuted, palette.footerSurface);
      if (quiet < AA_NORMAL) {
        const at = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        failures.push(`${label} ${at}: footer text ${quiet.toFixed(2)}:1 over the planet`);
      }
    }
    return failures;
  };

  it("stays readable over a sunlit planet all day", () => {
    expect(footerSweep(CAPE_TOWN, [2026, 11, 21], "midsummer")).toEqual([]);
  });

  it("stays readable at the equator, where the planet is brightest", () => {
    expect(footerSweep(EQUATOR, [2026, 2, 20], "equator")).toEqual([]);
  });

  it("stays readable through a polar day, which never lets up", () => {
    expect(footerSweep(TROMSO, [2026, 5, 21], "midnight sun")).toEqual([]);
  });

  it("is measured against something genuinely bright", () => {
    /**
     * The counter-check, and the one that matters most here — because the
     * original failure was precisely a sweep that passed against a surface
     * that was never the hard case. If `behindFooter` is not near-white at
     * noon, this whole block is measuring nothing again.
     */
    const noon = paletteAt(new Date(Date.UTC(2026, 11, 21, 10, 0)), CAPE_TOWN);
    expect(luminance(noon.behindFooter), "the modelled planet is not bright").toBeGreaterThan(0.6);
    expect(contrastRatio(noon.cardMuted, noon.behindFooter), "unwashed, this must FAIL")
      .toBeLessThan(AA_NORMAL);
  });

  it("all but disappears at night, like the other wash", () => {
    const when = new Date(Date.UTC(2026, 11, 21, 22, 0));
    const night = environmentFor(solarSnapshot(when, CAPE_TOWN), moonSnapshot(when, CAPE_TOWN));
    expect(footerScrimAlpha(night)).toBeLessThan(0.2);
  });

  it("is heavier than the card's, because the planet is brighter than the sky", () => {
    const noon = environmentFor(
      solarSnapshot(new Date(Date.UTC(2026, 11, 21, 10, 0)), CAPE_TOWN),
      moonSnapshot(new Date(Date.UTC(2026, 11, 21, 10, 0)), CAPE_TOWN)
    );
    expect(footerScrimAlpha(noon)).toBeGreaterThan(scrimAlpha(noon));
  });
});

describe("the worst minute of the day", () => {
  it("is bright enough that the check could have failed", () => {
    /**
     * The counter-check. A contrast sweep that passes because the sky is always
     * dark proves nothing about the design — it proves the sun never came up.
     * So: find the day's tightest ratio and confirm it is genuinely close to the
     * bar, not comfortably above it because nothing was ever tested.
     */
    let worst = Infinity;
    let worstAt = "";

    for (let minute = 0; minute < 1440; minute += 2) {
      const when = new Date(Date.UTC(2026, 11, 21, 0, minute));
      const palette = paletteAt(when, CAPE_TOWN);
      const ratio = contrastRatio(palette.cardMuted, palette.cardSurface);
      if (ratio < worst) {
        worst = ratio;
        worstAt = `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}`;
      }
    }

    expect(worst, `tightest was ${worst.toFixed(2)}:1 at ${worstAt}`).toBeGreaterThanOrEqual(
      AA_NORMAL
    );
    // If the tightest moment of a midsummer day is above 12:1, the scrim is so
    // heavy that the sky is not showing through — which would mean readability
    // was bought by throwing the whole design away.
    expect(worst, "the scrim is so heavy the sky cannot be seen").toBeLessThan(12);
  });

  it("is at the brightest part of the day, not somewhere random", () => {
    // Sanity on the model itself: the hardest moment for white text must be
    // when the sun is highest. If it were at midnight, something is inverted.
    const noon = paletteAt(new Date(Date.UTC(2026, 11, 21, 10, 0)), CAPE_TOWN);
    const midnight = paletteAt(new Date(Date.UTC(2026, 11, 21, 22, 0)), CAPE_TOWN);

    expect(contrastRatio(noon.cardText, noon.cardSurface)).toBeLessThan(
      contrastRatio(midnight.cardText, midnight.cardSurface)
    );
  });
});

describe("the scrim behaves like a scrim", () => {
  it("deepens as the sky brightens, rather than lightening with the mood", () => {
    /**
     * The instinct a designer has to fight. A bright airy sky invites a lighter
     * treatment — and that is exactly the moment white text is in trouble.
     *
     * Asserted on the ALPHA, not on the composited luminance. The first version
     * of this test compared `luminance(sky) − luminance(surface)` and passed
     * with the entire relationship inverted: that difference is dominated by
     * how bright the sky is rather than by how strong the wash is, and near
     * black minus near black is near zero whatever the alpha. A mutation caught
     * it — the test was measuring a proxy for the thing instead of the thing.
     */
    const state = (h: number) =>
      environmentFor(
        solarSnapshot(new Date(Date.UTC(2026, 11, 21, h, 0)), CAPE_TOWN),
        moonSnapshot(new Date(Date.UTC(2026, 11, 21, h, 0)), CAPE_TOWN)
      );

    const noon = state(10);
    const midnight = state(22);

    expect(noon.skyBrightness).toBeGreaterThan(midnight.skyBrightness);
    expect(scrimAlpha(noon), "the wash got lighter as the sky got brighter").toBeGreaterThan(
      scrimAlpha(midnight)
    );
    // And it must be a real difference, not a rounding one.
    expect(scrimAlpha(noon) - scrimAlpha(midnight)).toBeGreaterThan(0.25);
  });

  it("rises monotonically with the scrim the model asks for", () => {
    // Every step of the way, not merely at the two ends: a curve that dips in
    // the middle would leave one part of the day unprotected.
    let previous = -Infinity;
    for (let scrim = 0; scrim <= 1.0001; scrim += 0.05) {
      const alpha = scrimAlpha({ textScrim: scrim } as never);
      expect(alpha).toBeGreaterThanOrEqual(previous);
      previous = alpha;
    }
  });

  it("all but disappears at night", () => {
    // At night it must not leave a visible grey cloud over the stars: the
    // surface should be within a hair of the raw sky behind it.
    const night = paletteAt(new Date(Date.UTC(2026, 11, 21, 22, 0)), CAPE_TOWN);
    expect(Math.abs(luminance(night.cardSurface) - luminance(night.behindCard))).toBeLessThan(0.01);
  });

  it("never flips the text colour", () => {
    /**
     * §16: the same physical material under changing light, not two designs
     * that swap over. Dark text on a bright sky would hold contrast trivially
     * and destroy the thing being built.
     */
    const day = paletteAt(new Date(Date.UTC(2026, 11, 21, 10, 0)), CAPE_TOWN);
    const night = paletteAt(new Date(Date.UTC(2026, 11, 21, 22, 0)), CAPE_TOWN);
    expect(day.cardText).toEqual(night.cardText);
    expect(luminance(day.cardText)).toBeGreaterThan(0.7);
  });
});

describe("the sky the card sits on", () => {
  it("gets brighter from the top of the frame down to the horizon", () => {
    // The band just above the limb is always the brightest part of the sky.
    const day = paletteAt(new Date(Date.UTC(2026, 11, 21, 10, 0)), CAPE_TOWN);
    expect(luminance(day.skyHorizon)).toBeGreaterThan(luminance(day.skyMid));
    expect(luminance(day.skyMid)).toBeGreaterThan(luminance(day.skyTop));
  });

  it("measures the worst case behind the card, not an average", () => {
    /**
     * `behindCard` takes the BRIGHTER of the two stops it spans. Averaging — or
     * simply taking the top — would quietly excuse whichever half of the text
     * sits over the brighter part, which is the half that fails.
     *
     * Asserted as an identity against the brighter stop, and only after
     * confirming the two stops genuinely differ. The first version said
     * `>= luminance(skyTop)`, which a mutation setting `behindCard = skyTop`
     * satisfied exactly — a test that cannot tell the right answer from the
     * wrong one is not a test.
     */
    const day = paletteAt(new Date(Date.UTC(2026, 11, 21, 10, 0)), CAPE_TOWN);
    expect(luminance(day.skyMid), "the stops are identical here").toBeGreaterThan(
      luminance(day.skyTop) + 0.01
    );
    expect(day.behindCard).toEqual(day.skyMid);
  });

  it("warms at the horizon far more than overhead", () => {
    /**
     * Physics, not taste, which is why it is asserted. The colour of a low sun
     * is made by light crossing a great deal of atmosphere, and there is only a
     * great deal of atmosphere along the horizon — look up during a sunrise and
     * the sky is still deep blue.
     *
     * Applying warmth evenly, which the first version did, turned dawn into a
     * uniform mauve wash and erased the one thing that makes the phase
     * recognisable.
     */
    const dawn = paletteAt(new Date(Date.UTC(2026, 11, 21, 2, 40)), CAPE_TOWN);

    // Redness above blueness is the signature of a warm band.
    const warmBias = (c: { r: number; b: number }) => c.r - c.b;
    expect(warmBias(dawn.skyHorizon)).toBeGreaterThan(warmBias(dawn.skyTop) + 30);
    expect(warmBias(dawn.skyHorizon)).toBeGreaterThan(warmBias(dawn.skyMid));
  });

  it("keeps the sky overhead cool even at the reddest moment", () => {
    /**
     * The other half: the band has to be a band. If the top warms too, the whole
     * frame goes brown and there is no horizon left to look at.
     *
     * The bar is "not visibly warm", not "arithmetically cool". My first attempt
     * demanded red below blue and failed at a bias of **2 out of 255** — a
     * difference no eye can find, on a sky that is plainly still blue. A test
     * whose threshold is tighter than perception does not protect the design; it
     * just breaks whenever the design is nudged.
     */
    let reddestTop = -Infinity;
    let at = "";
    for (let minute = 0; minute < 1440; minute += 5) {
      const p = paletteAt(new Date(Date.UTC(2026, 11, 21, 0, minute)), CAPE_TOWN);
      const bias = p.skyTop.r - p.skyTop.b;
      if (bias > reddestTop) {
        reddestTop = bias;
        at = `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}`;
      }
    }
    expect(reddestTop, `sky overhead reached a warm cast at ${at}`).toBeLessThan(20);
  });

  it("never produces a colour outside the byte range", () => {
    const broken: string[] = [];
    for (let lat = -90; lat <= 90; lat += 15) {
      for (let month = 0; month < 12; month++) {
        for (let hour = 0; hour < 24; hour += 3) {
          const palette = paletteAt(new Date(Date.UTC(2026, month, 15, hour)), place(lat, 0));
          for (const [name, colour] of Object.entries(palette)) {
            for (const channel of [colour.r, colour.g, colour.b]) {
              if (!Number.isFinite(channel) || channel < 0 || channel > 255) {
                broken.push(`${name} = ${channel} at lat ${lat}, month ${month + 1}`);
              }
            }
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("the title, which is large text", () => {
  it("clears the large-text bar everywhere, with room to spare", () => {
    // Held to the body-text bar anyway rather than to AA_LARGE: it is the first
    // thing anybody reads, and passing a lower bar is not a reason to look worse.
    let worst = Infinity;
    for (let minute = 0; minute < 1440; minute += 5) {
      const palette = paletteAt(new Date(Date.UTC(2026, 11, 21, 0, minute)), CAPE_TOWN);
      worst = Math.min(worst, contrastRatio(palette.cardText, palette.cardSurface));
    }
    expect(worst).toBeGreaterThan(AA_LARGE);
    expect(worst).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
